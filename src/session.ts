// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// See ADDITIONAL-TERMS.md for the section 7(b) attribution requirement.
//
// Deepshaft — one co-op run across the wire. Host-authoritative snapshot star at 20Hz.
//
// ── WHY THE MAP IS NEVER SENT ───────────────────────────────────────────────────────────────────
// A 29x29 floor is 841 bytes of tiles plus its spawn and item tables, and it changes every descent.
// None of it crosses the wire. `generate(seed, floor, mode, players)` is a pure function of four
// numbers, so every peer cuts a byte-identical mine from the round's seed the moment it learns the
// floor number — which rides in the snapshot header as ONE byte. That is the single largest saving
// in the netcode, and it is also what makes host transfer survivable: a promoted peer already holds
// the geometry, and only needs the last snapshot to know where everything was standing.
//
// ── WHAT IS PREDICTED, AND WHAT IS NEVER PREDICTED ──────────────────────────────────────────────
// The client predicts EXACTLY ONE thing: its own position and facing, by running the same movement
// code the host runs. It never predicts its own health and never predicts an enemy. A corrected
// camera is the most unpleasant failure a networked first-person game has, and a death that gets
// undone is worse than any amount of latency — so yaw is client-owned outright and HP arrives from
// the host or not at all.
//
// The reason 20Hz feels fine here is a GAME decision rather than a transport one: no enemy is a
// hitscanner and every attack has a telegraph of 0.42-0.66s (`windup` in tuning.ts). A guest sees
// enemies about a tenth of a second in the past, and a tell four times longer than that is a tell
// you still have time to answer.

import type { Net } from '@ben-gy/game-engine/net';
import { Game, IDLE_INTENT, type Intent } from './game';
import { ENEMY_IDS, WEAPON_ORDER, type EnemyId, type WeaponId } from './tuning';
import { LOCK_ORDER } from './palette';

const SNAP_HZ = 20;
const IN_HZ = 30;
const MAX_E = 64;
const MAX_B = 24;
const MAX_F = 24;
/** Quantisation: 1/64 of a cell, which is a seventeenth of a player's radius. */
const Q = 64;

const clampU16 = (v: number): number => Math.max(0, Math.min(65535, Math.round(v)));
const angToByte = (a: number): number => Math.round((((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2) * 255) & 255;
const byteToAng = (b: number): number => (b / 255) * Math.PI * 2;

export interface SessionDeps {
  net: Net | null;
  /** Seat this device drives, or null while spectating. */
  mySeat: number | null;
  onFloor: (floor: number) => void;
  onEvents: () => void;
}

/**
 * A live run. In solo it is simply a Game with `host = true` and no wire at all, which is why there
 * is exactly ONE combat implementation and the balance sim exercises the shipped one.
 */
export class Session {
  game: Game;
  host: boolean;
  /** Local intents by seat; the host has everyone's, a client only has its own. */
  intents: Intent[];

  private send: ((d: Uint8Array) => void) | null = null;
  private sendIn: ((d: Uint8Array) => void) | null = null;
  private offs: Array<() => void> = [];
  private sinceSnap = 0;
  private sinceIn = 0;
  private seatOf: (peer: string) => number;
  private lastFloor: number;
  /** Smoothing targets for bodies the host owns — enemies are interpolated, never predicted. */
  private lerp = new Map<number, { x: number; y: number }>();

  constructor(
    game: Game,
    host: boolean,
    private deps: SessionDeps,
    seatOf: (peer: string) => number = () => -1,
  ) {
    this.game = game;
    this.host = host;
    this.seatOf = seatOf;
    this.lastFloor = game.floor;
    this.intents = game.players.map(() => ({ ...IDLE_INTENT }));

    const net = deps.net;
    if (!net) return;
    const snap = net.channel<Uint8Array>('snap', (d) => this.onSnap(d));
    const inp = net.channel<Uint8Array>('in', (d, peer) => this.onIn(d, this.seatOf(peer)));
    this.send = (d) => snap(d);
    this.sendIn = (d) => inp(d);
    this.offs.push(() => snap.off(), () => inp.off());
  }

  destroy(): void {
    for (const off of this.offs.splice(0)) {
      try {
        off();
      } catch {
        /* the channel may already be gone */
      }
    }
    this.send = null;
    this.sendIn = null;
  }

  /**
   * Promotion. The new host already holds the geometry (it derived it) and the last snapshot it
   * received, so taking over is: believe what you are holding, and start running the clock. There is
   * no state to transfer because there was never any state only the old host had.
   */
  becomeHost(): void {
    if (this.host) return;
    this.host = true;
    this.sinceSnap = 999;
    // Anything the last snapshot did not mention is re-derived from the deterministic spawn table
    // rather than vanishing — a peer that missed a spawn must not end up with a smaller mine.
    this.broadcast();
  }

  /** Called every fixed step by the loop. `mine` is this device's own input for this step. */
  step(stepSec: number, mine: Intent): void {
    const seat = this.deps.mySeat;
    if (seat !== null && seat >= 0 && seat < this.intents.length) this.intents[seat] = mine;

    if (this.host) {
      this.game.tick(stepSec, this.intents);
      this.sinceSnap += stepSec;
      if (this.sinceSnap >= 1 / SNAP_HZ) {
        this.sinceSnap = 0;
        this.broadcast();
      }
    } else {
      // A client owns its own body and nothing else. Enemies ease toward the last snapshot; they are
      // never stepped locally, because a client running its own AI is a client that disagrees.
      if (seat !== null) this.game.predictSelf(seat, mine, stepSec);
      this.ease(stepSec);
      this.sinceIn += stepSec;
      if (this.sinceIn >= 1 / IN_HZ) {
        this.sinceIn = 0;
        this.pushIntent(mine);
      }
    }

    if (this.game.floor !== this.lastFloor) {
      this.lastFloor = this.game.floor;
      this.deps.onFloor(this.game.floor);
    }
  }

  private ease(step: number): void {
    const k = Math.min(1, step * 14);
    for (const e of this.game.enemies) {
      const t = this.lerp.get(e.id);
      if (!t) continue;
      e.x += (t.x - e.x) * k;
      e.y += (t.y - e.y) * k;
    }
  }

  // ── client -> host ────────────────────────────────────────────────────────────────────────────

  private pushIntent(i: Intent): void {
    if (!this.sendIn) return;
    const b = new DataView(new ArrayBuffer(6));
    b.setInt8(0, Math.round(i.mx * 100));
    b.setInt8(1, Math.round(i.my * 100));
    b.setUint8(2, angToByte(i.ang));
    b.setUint8(3, (i.fire ? 1 : 0) | (i.use ? 2 : 0));
    b.setUint8(4, Math.max(0, WEAPON_ORDER.indexOf(i.weapon)));
    b.setUint8(5, 1);
    this.sendIn(new Uint8Array(b.buffer));
  }

  private onIn(d: Uint8Array, seat: number): void {
    if (!this.host || seat < 0 || seat >= this.intents.length) return;
    const b = new DataView(d.buffer, d.byteOffset, d.byteLength);
    if (b.byteLength < 6) return;
    const bits = b.getUint8(3);
    this.intents[seat] = {
      mx: b.getInt8(0) / 100,
      my: b.getInt8(1) / 100,
      ang: byteToAng(b.getUint8(2)),
      fire: (bits & 1) !== 0,
      use: (bits & 2) !== 0,
      weapon: WEAPON_ORDER[b.getUint8(4)] ?? 'cutter',
    };
  }

  // ── host -> everyone ──────────────────────────────────────────────────────────────────────────

  broadcast(): void {
    if (!this.send || !this.host) return;
    const g = this.game;
    const ps = g.players;
    const es = g.enemies.slice(0, MAX_E);
    const bs = g.bolts.slice(0, MAX_B);
    const fires = [...g.fires.keys()].slice(0, MAX_F);
    const doorsOpen: number[] = [];
    for (let i = 0; i < g.doors.length && doorsOpen.length < 24; i++) if (g.doors[i] > 0) doorsOpen.push(i);
    const takenBytes = Math.ceil(g.items.length / 8);

    const size = 8 + 1 + ps.length * 15 + 1 + es.length * 10 + 1 + bs.length * 7 + 1 + fires.length * 2 + 1 + doorsOpen.length * 2 + 1 + takenBytes;
    const buf = new ArrayBuffer(size);
    const b = new DataView(buf);
    let o = 0;
    b.setUint8(o++, 1); // wire version
    b.setUint8(o++, g.floor);
    b.setUint8(o++, (g.over ? 1 : 0) | (g.won ? 2 : 0));
    b.setUint16(o, Math.round(g.runTime * 20) & 0xffff);
    o += 2;
    b.setUint16(o, Math.round(g.floorTime * 20) & 0xffff);
    o += 2;
    b.setUint8(o++, 0);

    b.setUint8(o++, ps.length);
    for (const p of ps) {
      b.setUint8(o++, p.seat);
      b.setUint16(o, clampU16(p.x * Q));
      o += 2;
      b.setUint16(o, clampU16(p.y * Q));
      o += 2;
      b.setUint8(o++, angToByte(p.ang));
      b.setUint8(o++, Math.max(0, Math.min(255, Math.round(p.hp))));
      b.setUint8(o++, (p.down ? 1 : 0) | (p.present ? 2 : 0));
      let keys = 0;
      LOCK_ORDER.forEach((c, i) => {
        if (p.keys.has(c)) keys |= 1 << i;
      });
      b.setUint8(o++, keys);
      b.setUint8(o++, Math.max(0, WEAPON_ORDER.indexOf(p.weapon)));
      for (const w of WEAPON_ORDER) {
        b.setUint16(o, clampU16(p.ammo[w]));
        o += 2;
      }
    }

    b.setUint8(o++, es.length);
    for (const e of es) {
      b.setUint16(o, e.id & 0xffff);
      o += 2;
      b.setUint8(o++, Math.max(0, ENEMY_IDS.indexOf(e.kind)));
      b.setUint16(o, clampU16(e.x * Q));
      o += 2;
      b.setUint16(o, clampU16(e.y * Q));
      o += 2;
      b.setUint8(o++, angToByte(e.ang));
      b.setUint8(o++, Math.max(0, Math.min(255, Math.round((e.hp / Math.max(1, e.maxHp)) * 255))));
      b.setUint8(o++, e.windup > 0 ? 1 : 0);
    }

    b.setUint8(o++, bs.length);
    for (const bo of bs) {
      b.setUint16(o, clampU16(bo.x * Q));
      o += 2;
      b.setUint16(o, clampU16(bo.y * Q));
      o += 2;
      b.setInt8(o++, Math.max(-127, Math.min(127, Math.round(bo.vx * 8))));
      b.setInt8(o++, Math.max(-127, Math.min(127, Math.round(bo.vy * 8))));
      b.setInt8(o++, bo.seat);
    }

    b.setUint8(o++, fires.length);
    for (const f of fires) {
      b.setUint16(o, f & 0xffff);
      o += 2;
    }
    b.setUint8(o++, doorsOpen.length);
    for (const d of doorsOpen) {
      b.setUint16(o, d & 0xffff);
      o += 2;
    }
    b.setUint8(o++, takenBytes);
    for (let i = 0; i < takenBytes; i++) {
      let byte = 0;
      for (let k = 0; k < 8; k++) if (g.items[i * 8 + k]?.taken) byte |= 1 << k;
      b.setUint8(o++, byte);
    }
    this.send(new Uint8Array(buf));
  }

  private onSnap(d: Uint8Array): void {
    if (this.host) return;
    const g = this.game;
    const b = new DataView(d.buffer, d.byteOffset, d.byteLength);
    let o = 0;
    if (b.byteLength < 9 || b.getUint8(o++) !== 1) return;
    const floor = b.getUint8(o++);
    const flags = b.getUint8(o++);
    o += 2;
    const floorTicks = b.getUint16(o);
    o += 2;
    o += 1;

    // A floor we have not cut yet: derive it locally rather than waiting for anyone to send it.
    if (floor !== g.floor) g.adoptFloor(floor);
    g.floorTime = floorTicks / 20;

    const np = b.getUint8(o++);
    for (let i = 0; i < np; i++) {
      const seat = b.getUint8(o++);
      const x = b.getUint16(o) / Q;
      o += 2;
      const y = b.getUint16(o) / Q;
      o += 2;
      const ang = byteToAng(b.getUint8(o++));
      const hp = b.getUint8(o++);
      const pf = b.getUint8(o++);
      const keys = b.getUint8(o++);
      const weap = b.getUint8(o++);
      const ammo: number[] = [];
      for (let w = 0; w < WEAPON_ORDER.length; w++) {
        ammo.push(b.getUint16(o));
        o += 2;
      }
      const p = g.players[seat];
      if (!p) continue;
      p.hp = hp;
      p.down = (pf & 1) !== 0;
      p.present = (pf & 2) !== 0;
      p.keys = new Set(LOCK_ORDER.filter((_, k) => (keys & (1 << k)) !== 0));
      p.weapon = (WEAPON_ORDER[weap] ?? 'cutter') as WeaponId;
      WEAPON_ORDER.forEach((w, k) => void (p.ammo[w] = ammo[k]));
      if (seat === this.deps.mySeat) {
        // Reconciliation. Inside a tenth of a cell the host and we agree and nothing happens; a
        // moderate disagreement is eased out over a few frames so the camera never jumps; only a
        // real divergence snaps, and that is rare enough to feel like being shoved.
        const err = Math.hypot(p.x - x, p.y - y);
        if (err > 0.9) {
          p.x = x;
          p.y = y;
        } else if (err > 0.1) {
          p.x += (x - p.x) * 0.34;
          p.y += (y - p.y) * 0.34;
        }
        // Yaw is never corrected: the client owns where it is looking, full stop.
      } else {
        p.x = x;
        p.y = y;
        p.ang = ang;
      }
    }

    const ne = b.getUint8(o++);
    const seen = new Set<number>();
    const byId = new Map(g.enemies.map((e) => [e.id & 0xffff, e]));
    for (let i = 0; i < ne; i++) {
      const id = b.getUint16(o);
      o += 2;
      const kind = ENEMY_IDS[b.getUint8(o++)] ?? ('thrall' as EnemyId);
      const x = b.getUint16(o) / Q;
      o += 2;
      const y = b.getUint16(o) / Q;
      o += 2;
      const ang = byteToAng(b.getUint8(o++));
      const hpFrac = b.getUint8(o++) / 255;
      const winding = b.getUint8(o++) !== 0;
      seen.add(id);
      let e = byId.get(id);
      if (!e) {
        e = g.spawnRemote(id, kind, x, y);
        byId.set(id, e);
      }
      e.ang = ang;
      e.hp = Math.max(1, hpFrac * e.maxHp);
      e.windup = winding ? 0.3 : 0;
      e.state = winding ? 'attack' : 'chase';
      this.lerp.set(e.id, { x, y });
    }
    // Anything the host no longer lists is gone. A client never decides an enemy died.
    g.enemies = g.enemies.filter((e) => seen.has(e.id & 0xffff));

    const nb = b.getUint8(o++);
    g.bolts = [];
    for (let i = 0; i < nb; i++) {
      const x = b.getUint16(o) / Q;
      o += 2;
      const y = b.getUint16(o) / Q;
      o += 2;
      const vx = b.getInt8(o++) / 8;
      const vy = b.getInt8(o++) / 8;
      const seat = b.getInt8(o++);
      g.bolts.push({ id: i, x, y, vx, vy, dmg: 0, splash: 0, life: 1, seat });
    }

    const nf = b.getUint8(o++);
    g.fires.clear();
    for (let i = 0; i < nf; i++) {
      g.fires.set(b.getUint16(o), 0.6);
      o += 2;
    }
    const nd = b.getUint8(o++);
    for (let i = 0; i < nd; i++) {
      const idx = b.getUint16(o);
      o += 2;
      if (idx < g.doors.length) g.doors[idx] = 1;
    }
    const nt = b.getUint8(o++);
    for (let i = 0; i < nt; i++) {
      const byte = b.getUint8(o++);
      for (let k = 0; k < 8; k++) {
        const it = g.items[i * 8 + k];
        if (it && (byte & (1 << k)) !== 0) it.taken = true;
      }
    }

    if ((flags & 1) !== 0 && !g.over) {
      g.over = true;
      g.won = (flags & 2) !== 0;
      g.events.push({ k: 'over', win: g.won });
    }
    this.deps.onEvents();
  }
}
