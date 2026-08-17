// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// See ADDITIONAL-TERMS.md for the section 7(b) attribution requirement.
//
// Deepshaft — the headless miner. It fills an empty co-op seat, and it is the instrument the balance
// sim measures the difficulty curve with, so how it PERCEIVES matters more than how well it shoots.
//
// ── WHY THIS BOT IS DELIBERATELY HANDICAPPED ────────────────────────────────────────────────────
// The fleet has already shipped a level that a balance sim certified as fine and that a human got
// zero taps in, because the sim's AI had no perception cost: it knew where everything was, turned
// instantly, and never had to find anything. A curve measured by an oracle is a curve for a game
// nobody is playing. So this bot:
//   · only knows cells it has actually had line of sight on (`seen`), and navigates by walking to
//     the nearest FRONTIER — it has to explore a floor exactly like a player does, and it can be
//     lost in it;
//   · turns at the player's own `turnRate` rather than snapping, so facing is a real cost;
//   · takes `react` seconds to respond to a threat it has just noticed;
//   · aims with a jitter, so a distant thrall is not a guaranteed hit.
// Every one of those is a tier dial. The `blind` flags are the other reason this file exists: a
// control bot that cannot see one mechanic is how you prove that mechanic is load-bearing (a
// mechanic that changes nothing when a bot ignores it is decoration, not design).

import { makeRng, type Rng } from '@ben-gy/game-engine/rng';
import { Game, type Intent, type Player } from './game';
import { isDoorTile, T, TILE_LOCK } from './mine';
import { ENEMIES, PLAYER, WEAPONS, type WeaponId } from './tuning';

export interface Tier {
  id: string;
  name: string;
  /** Seconds before it reacts to a threat it has just seen. */
  react: number;
  /** Radians of aim error, scaled by distance. */
  jitter: number;
  /** HP fraction below which it backs off while firing. */
  flee: number;
  /** Sight radius in cells — how much of the floor it maps per step. */
  eyes: number;
}

export const TIERS: Tier[] = [
  { id: 'green', name: 'Green', react: 0.55, jitter: 0.3, flee: 0.22, eyes: 8 },
  { id: 'miner', name: 'Miner', react: 0.3, jitter: 0.16, flee: 0.35, eyes: 10 },
  { id: 'deputy', name: 'Deputy', react: 0.16, jitter: 0.07, flee: 0.45, eyes: 12 },
];
export const TIER_IDS = TIERS.map((t) => t.id);
export const DEFAULT_TIER = 'miner';
export const tierOf = (id: string | null | undefined): Tier => TIERS.find((t) => t.id === id) ?? TIERS[1];

/**
 * Control arms for the negative-GAP test. Each blinds the bot to exactly one mechanic; the sim then
 * asserts the blinded bot does measurably WORSE. A mechanic a blind bot matches is not a mechanic.
 */
export interface Blind {
  /** Never shoots a firedamp pocket on purpose and never uses one to clear a pack. */
  damp?: boolean;
  /** Only ever holds the cutter — no lance for armour, no charge for a crowd. */
  weapons?: boolean;
  /** Never backs off, whatever its HP. */
  retreat?: boolean;
  /** Never revives a downed mate. */
  revive?: boolean;
}

const RAD = Math.PI * 2;
const wrap = (a: number): number => {
  let v = a % RAD;
  if (v > Math.PI) v -= RAD;
  if (v < -Math.PI) v += RAD;
  return v;
};

export class Bot {
  private seen: Uint8Array;
  private path: number[] = [];
  private repathIn = 0;
  private reactIn = 0;
  private lastThreat = -1;
  private useEdge = false;
  private rng: Rng;
  private ang = 0;
  private side: number;
  private stuck = 0;
  private lastX = 0;
  private lastY = 0;

  constructor(
    private game: Game,
    private seat: number,
    private tier: Tier,
    private blind: Blind = {},
    seed = 1,
  ) {
    this.side = game.level.side;
    this.seen = new Uint8Array(this.side * this.side);
    this.rng = makeRng((seed ^ (seat * 0x9e3779b1)) >>> 0);
    this.ang = game.players[seat]?.ang ?? 0;
  }

  /** The floor changed under us: everything the bot knew about the mine is gone. */
  reset(): void {
    this.side = this.game.level.side;
    this.seen = new Uint8Array(this.side * this.side);
    this.path = [];
    this.repathIn = 0;
    this.stuck = 0;
  }

  think(step: number): Intent {
    const g = this.game;
    if (this.seen.length !== g.level.side * g.level.side) this.reset();
    const me = g.players[this.seat];
    if (!me || me.down || !me.present) return { mx: 0, my: 0, ang: this.ang, fire: false, use: false, weapon: 'cutter' };

    this.look(me);
    this.repathIn -= step;
    this.reactIn = Math.max(0, this.reactIn - step);

    // Something is nudging us into a wall — nudge back rather than grind for the rest of the run.
    if (Math.hypot(me.x - this.lastX, me.y - this.lastY) < PLAYER.speed * step * 0.2) this.stuck += step;
    else this.stuck = 0;
    this.lastX = me.x;
    this.lastY = me.y;

    const threat = this.nearestThreat(me);
    if (threat && threat.id !== this.lastThreat) {
      this.lastThreat = threat.id;
      this.reactIn = this.tier.react;
    }
    if (!threat) this.lastThreat = -1;

    // Standing and shooting is only correct when the thing is actually ON you. A bot that entered
    // combat at the edge of its vision stopped exploring the moment a lurker kited to 10 cells and
    // held there — one floor took 146 seconds, and it was not difficulty, it was a stalemate. So
    // beyond COMMIT it keeps walking its route and shoots on the way.
    if (threat && threat.dist <= COMMIT && this.reactIn <= 0) return this.fight(me, threat, step);
    return this.travel(me, step, threat && this.reactIn <= 0 ? threat : null);
  }

  // ── perception ────────────────────────────────────────────────────────────────────────────────

  /** Mark what we can currently see. Twenty-four rays, not a flood fill — this runs every tick. */
  private look(me: Player): void {
    const g = this.game;
    const s = this.side;
    const R = this.tier.eyes;
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * RAD;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      for (let t = 0; t <= R; t += 0.5) {
        const x = (me.x + dx * t) | 0;
        const y = (me.y + dy * t) | 0;
        if (x < 0 || y < 0 || x >= s || y >= s) break;
        this.seen[y * s + x] = 1;
        if (g.blocked(me.x + dx * t, me.y + dy * t)) break;
      }
    }
  }

  private nearestThreat(me: Player): { id: number; x: number; y: number; kind: string; dist: number } | null {
    const g = this.game;
    let best: { id: number; x: number; y: number; kind: string; dist: number } | null = null;
    for (const e of g.enemies) {
      if (e.state === 'dead') continue;
      const d = Math.hypot(e.x - me.x, e.y - me.y);
      if (d > this.tier.eyes + 2) continue;
      if (!g.clearLine(me.x, me.y, e.x, e.y)) continue;
      if (!best || d < best.dist) best = { id: e.id, x: e.x, y: e.y, kind: e.kind, dist: d };
    }
    return best;
  }

  // ── fighting ──────────────────────────────────────────────────────────────────────────────────

  private fight(me: Player, t: { id: number; x: number; y: number; kind: string; dist: number }, step: number): Intent {
    const want = Math.atan2(t.y - me.y, t.x - me.x) + (this.rng() - 0.5) * this.tier.jitter * Math.min(2, t.dist / 5);
    this.turn(want, step);

    const weapon = this.pickWeapon(me, t);
    const w = WEAPONS[weapon];
    const aligned = Math.abs(wrap(want - this.ang)) < w.cone * 0.9;
    const inRange = t.dist <= w.range;

    // Firedamp: if a pocket sits between us and the pack, shoot THAT instead of the pack. This is
    // the single biggest play in the game and it is one condition.
    let fire = aligned && inRange;
    if (!this.blind.damp) {
      const pocket = this.dampShot(me);
      if (pocket !== null) {
        this.turn(pocket, step);
        fire = Math.abs(wrap(pocket - this.ang)) < 0.2;
      }
    }

    const low = me.hp < PLAYER.hp * this.tier.flee;
    const tooClose = t.dist < 1.9;
    const backing = !this.blind.retreat && (low || tooClose);
    // Kiting is backwards along our own facing, which keeps the gun on the target while we go.
    const my = backing ? -1 : t.dist > w.range * 0.75 ? 0.65 : 0;
    // A little strafe so we are not a stationary target, held to one side for a while at a time.
    const mx = backing ? (this.rng() < 0.5 ? -0.5 : 0.5) : Math.sin(this.game.runTime * 1.7 + this.seat) * 0.35;

    return { mx, my, ang: this.ang, fire, use: false, weapon };
  }

  private pickWeapon(me: Player, t: { kind: string; dist: number }): WeaponId {
    if (this.blind.weapons) return 'cutter';
    const g = this.game;
    // Armour is the lance's whole job.
    if (ENEMIES[t.kind as keyof typeof ENEMIES]?.armoured && me.ammo.lance > 0 && t.dist < WEAPONS.lance.range) {
      return 'lance';
    }
    // A crowd is the charge's, as long as we are not standing in it.
    if (me.ammo.charge > 0 && t.dist > WEAPONS.charge.splash + 1.2) {
      let near = 0;
      for (const e of g.enemies) {
        if (e.state === 'dead') continue;
        if (Math.hypot(e.x - t.dist * 0 - me.x, e.y - me.y) < 7) near++;
      }
      if (near >= 4) return 'charge';
    }
    if (me.ammo.cutter > 0) return 'cutter';
    if (me.ammo.lance > 0) return 'lance';
    if (me.ammo.charge > 0) return 'charge';
    return 'cutter';
  }

  /** An angle to fire at, if a firedamp pocket with two or more things beside it is in view. */
  private dampShot(me: Player): number | null {
    const g = this.game;
    const s = g.level.side;
    let best: { a: number; n: number } | null = null;
    for (const i of g.level.damp) {
      if (g.level.tiles[i] !== T.DAMP) continue;
      const x = (i % s) + 0.5;
      const y = ((i / s) | 0) + 0.5;
      const d = Math.hypot(x - me.x, y - me.y);
      // Far enough that we are outside the blast, close enough to hit.
      if (d < 3.2 || d > 11) continue;
      if (!g.clearLine(me.x, me.y, x, y)) continue;
      let n = 0;
      for (const e of g.enemies) {
        if (e.state === 'dead') continue;
        if (Math.hypot(e.x - x, e.y - y) <= 2.1) n++;
      }
      if (n < 2) continue;
      if (!best || n > best.n) best = { a: Math.atan2(y - me.y, x - me.x), n };
    }
    return best ? best.a : null;
  }

  // ── getting about ─────────────────────────────────────────────────────────────────────────────

  private travel(me: Player, step: number, threat: { x: number; y: number; dist: number } | null): Intent {
    const g = this.game;
    const s = g.level.side;

    if (this.repathIn <= 0 || !this.path.length || this.stuck > 0.9) {
      this.path = this.route(me);
      this.repathIn = 0.4;
      this.stuck = 0;
    }
    if (!this.path.length) {
      // Nothing left to explore and nowhere to be — turn on the spot rather than freeze, so a stuck
      // bot still looks alive and still finds anything that wanders in.
      this.ang = wrap(this.ang + 1.4 * step);
      return { mx: 0, my: 0.2, ang: this.ang, fire: threat !== null, use: false, weapon: me.weapon };
    }

    let next = this.path[0];
    let nx = (next % s) + 0.5;
    let ny = ((next / s) | 0) + 0.5;
    while (this.path.length > 1 && Math.hypot(nx - me.x, ny - me.y) < 0.55) {
      this.path.shift();
      next = this.path[0];
      nx = (next % s) + 0.5;
      ny = ((next / s) | 0) + 0.5;
    }

    const want = Math.atan2(ny - me.y, nx - me.x);
    this.turn(want, step);
    const facing = Math.abs(wrap(want - this.ang)) < 0.5;

    // A door in the way: press use on the rising edge only, so it is one press and not a rattle.
    const cell = g.level.tiles[next];
    let use = false;
    if (isDoorTile(cell) && g.doors[next] === 0) {
      const colour = TILE_LOCK[cell];
      if (!colour || me.keys.has(colour)) {
        use = !this.useEdge;
        this.useEdge = !this.useEdge;
      }
    } else {
      this.useEdge = false;
    }

    // Shoot on the move, but only when the route happens to point somewhere near the thing — firing
    // at a wall while walking away from a lurker is how a run runs out of ammo on floor three.
    const bearing = threat ? Math.atan2(threat.y - me.y, threat.x - me.x) : 0;
    const onTarget = threat !== null && Math.abs(wrap(bearing - this.ang)) < 0.26;

    return {
      mx: 0,
      my: facing ? 1 : 0.28,
      ang: this.ang,
      fire: onTarget,
      use,
      weapon: this.blind.weapons ? 'cutter' : me.weapon,
    };
  }

  /**
   * Where to go next, in priority order: a mate on the floor, a key we can see and need, the stair
   * once we hold every key, otherwise the nearest FRONTIER — a cell we have seen that touches one we
   * have not. Exploring toward the unknown is the whole reason this bot can be lost.
   */
  private route(me: Player): number[] {
    const g = this.game;
    const s = g.level.side;
    const start = (me.y | 0) * s + (me.x | 0);

    if (!this.blind.revive) {
      const mate = g.players.find((p) => p.present && p.down && p.seat !== this.seat);
      if (mate) {
        const goal = (mate.y | 0) * s + (mate.x | 0);
        const r = this.bfs(start, (i) => i === goal, me);
        if (r.length) return r;
      }
    }

    const needed = g.items.filter((it) => !it.taken && TILE_LOCK_KEYS.has(it.kind) && !me.keys.has(it.kind as never));
    if (needed.length) {
      const goals = new Set(needed.map((it) => (it.y | 0) * s + (it.x | 0)));
      const r = this.bfs(start, (i) => goals.has(i), me);
      if (r.length) return r;
    }

    // Ammo and carbide are worth a detour, but only ones we have actually laid eyes on.
    if (me.hp < PLAYER.hp * 0.6 || me.ammo.cutter < 25) {
      const goals = new Set(
        g.items
          .filter((it) => !it.taken && !TILE_LOCK_KEYS.has(it.kind) && this.seen[(it.y | 0) * s + (it.x | 0)])
          .map((it) => (it.y | 0) * s + (it.x | 0)),
      );
      if (goals.size) {
        const r = this.bfs(start, (i) => goals.has(i), me);
        if (r.length) return r;
      }
    }

    // Once every card is held, the cage is findable without having seen it — the player gets a HUD
    // bearing for exactly the same reason. Before that it has to be explored to like anything else.
    const stairI = g.level.stair.y * s + g.level.stair.x;
    if (g.level.locks.every((c) => me.keys.has(c))) {
      const r = this.bfs(start, (i) => i === stairI, me);
      if (r.length) return r;
    }

    return this.bfs(start, (i) => this.isFrontier(i), me);
  }

  private isFrontier(i: number): boolean {
    if (!this.seen[i]) return false;
    const s = this.side;
    const x = i % s;
    if (x > 0 && !this.seen[i - 1]) return true;
    if (x < s - 1 && !this.seen[i + 1]) return true;
    if (i >= s && !this.seen[i - s]) return true;
    if (i < this.seen.length - s && !this.seen[i + s]) return true;
    return false;
  }

  /** Cell path from `start` to the first cell matching `want`. Locked doors block without the key. */
  private bfs(start: number, want: (i: number) => boolean, me: Player): number[] {
    const g = this.game;
    const s = g.level.side;
    const n = s * s;
    if (start < 0 || start >= n) return [];
    const prev = new Int32Array(n).fill(-2);
    const q = new Int32Array(n);
    let head = 0;
    let tail = 0;
    prev[start] = -1;
    q[tail++] = start;
    let found = -1;
    while (head < tail) {
      const cur = q[head++];
      if (cur !== start && want(cur)) {
        found = cur;
        break;
      }
      const cx = cur % s;
      for (let k = 0; k < 4; k++) {
        const nb = k === 0 ? cur - 1 : k === 1 ? cur + 1 : k === 2 ? cur - s : cur + s;
        if (nb < 0 || nb >= n || prev[nb] !== -2) continue;
        if (k === 0 && cx === 0) continue;
        if (k === 1 && cx === s - 1) continue;
        const t = g.level.tiles[nb];
        if (t === T.SOLID || t === T.TIMBER || t === T.SEAM || t === T.BRICK) continue;
        if (isDoorTile(t)) {
          const colour = TILE_LOCK[t];
          if (colour && !me.keys.has(colour) && g.doors[nb] === 0) continue;
        }
        // An UNLIT pocket is just floor — it is only dangerous once something sets it off, and
        // refusing to cross one cut whole wings of a level off from the bot (pockets collect in
        // corridors, which is the entire point of them). A cell that is actually alight is a wall.
        if (g.fires.has(nb)) continue;
        prev[nb] = cur;
        q[tail++] = nb;
      }
    }
    if (found < 0) return [];
    const out: number[] = [];
    for (let cur = found; cur !== -1 && cur !== start; cur = prev[cur]) out.push(cur);
    return out.reverse();
  }

  private turn(want: number, step: number): void {
    const d = wrap(want - this.ang);
    const max = PLAYER.turnRate * step;
    this.ang = wrap(this.ang + Math.max(-max, Math.min(max, d)));
  }
}

const TILE_LOCK_KEYS = new Set(['amber', 'cyan', 'rose']);

/**
 * Distance at which the bot stops travelling and starts fighting. Measured, not chosen: at the old
 * behaviour (fight anything you can see) a single adit floor took 146 seconds because a lurker sat
 * at the edge of vision and neither side would close. See `think`.
 */
const COMMIT = 6.5;
