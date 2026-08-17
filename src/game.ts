// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// See ADDITIONAL-TERMS.md for the section 7(b) attribution requirement.
//
// Deepshaft — the simulation. No DOM, no canvas, no timers: `tick(step)` and an event stream out.
// That is what lets the balance sim run four hundred headless runs in a second, and what lets the
// tutorial drive the SHIPPED rules instead of a mock.
//
// ── THE THREE THINGS WORTH KNOWING BEFORE READING ───────────────────────────────────────────────
// 1. PATHING IS A FLOW FIELD, NOT A* PER ENEMY. One BFS per living player every FIELD_EVERY ticks
//    fills a distance field over the whole floor; every enemy then just steps downhill on its
//    target's field. Cost is O(cells) per 100ms no matter how many enemies there are, which is the
//    only version of this that holds 60fps on a phone with forty things chasing you.
// 2. AUTO-FIRE AIMS, FACING CHOOSES. The gun picks the NEAREST living enemy inside the weapon's cone
//    with clear line of sight. It never picks one outside the cone, so which enemy you shoot is
//    decided entirely by where you are looking — the skill the auto-aim removes is the last five
//    degrees, not target selection. `onShotAudit` exists so a test can re-derive that rule from
//    outside and hold it at zero tolerance (see tests/mechanism.test.ts).
// 3. FIREDAMP IS THE ONE SYSTEM THAT DOES NOT CARE WHOSE SIDE YOU ARE ON. A pocket lit by a charge,
//    by a kill on top of it, or by another pocket, hurts enemies and players alike and chains. Every
//    interesting situation in this game comes out of that rule meeting the flow field.

import { makeRng, randInt, type Rng } from '@ben-gy/game-engine/rng';
import { generate, isDoorTile, isWallTile, SUMP_RADIUS, T, TILE_LOCK, type Level } from './mine';
import { isLastFloor, modeOf, type Mode } from './modes';
import {
  DAMP,
  ENEMIES,
  PLAYER,
  RAMP,
  WEAPONS,
  WEAPON_ORDER,
  dmgScale,
  hpScale,
  type EnemyId,
  type WeaponId,
} from './tuning';
import type { LockColour } from './palette';

/** Ticks between flow-field rebuilds. Six at 60Hz is 100ms — under a stalker's reaction time. */
export const FIELD_EVERY = 6;
/** A cell the field could not reach. Enemies on one of these stand and wait rather than jitter. */
const UNREACHED = 0xffff;

export type EnemyState = 'idle' | 'alert' | 'chase' | 'flank' | 'retreat' | 'attack' | 'dead';

export interface Enemy {
  id: number;
  kind: EnemyId;
  x: number;
  y: number;
  ang: number;
  hp: number;
  maxHp: number;
  state: EnemyState;
  /** Seconds until it can attack again. */
  cool: number;
  /** Seat it is hunting, or -1 while idle. */
  target: number;
  /** Seconds of knockback/flinch left. */
  stagger: number;
  /**
   * Seconds left in a telegraphed attack. While this is above zero the thing is committed: it has
   * struck a pose, it has made a noise, and it is going to land. Moving out of reach beats it.
   */
  windup: number;
  /** Sidestep direction while flanking: +1 or -1, held so a stalker circles rather than shimmies. */
  side: number;
  /** Seconds burning in firedamp. */
  burn: number;
}

export interface Bolt {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  dmg: number;
  splash: number;
  life: number;
  /** -1 for an enemy bolt; otherwise the seat that fired it. */
  seat: number;
}

export interface Item {
  id: number;
  kind: string;
  x: number;
  y: number;
  taken: boolean;
}

export interface PlayerStats {
  kills: number;
  shots: number;
  hits: number;
  damage: number;
  taken: number;
  revives: number;
  downs: number;
  doors: number;
  damp: number;
  steps: number;
}

export interface Player {
  seat: number;
  name: string;
  bot: boolean;
  present: boolean;
  x: number;
  y: number;
  ang: number;
  hp: number;
  down: boolean;
  /** Seconds of bleed-out left while down. */
  bleed: number;
  /** Seconds of revive progress a mate has banked on this player. */
  reviving: number;
  keys: Set<LockColour>;
  ammo: Record<WeaponId, number>;
  weapon: WeaponId;
  cool: number;
  iframe: number;
  stats: PlayerStats;
}

/** One tick of intent from a peer (or a bot). Everything the sim needs from a human. */
export interface Intent {
  /** Strafe, -1..1 (right positive). */
  mx: number;
  /** Forward, -1..1. */
  my: number;
  /** Absolute facing in radians. The client owns its own look; the host never fights it. */
  ang: number;
  fire: boolean;
  /** Rising edge: use the thing in front of me (a door, a downed mate). */
  use: boolean;
  weapon: WeaponId;
}

export const IDLE_INTENT: Intent = { mx: 0, my: 0, ang: 0, fire: false, use: false, weapon: 'cutter' };

export type GEvent =
  | { k: 'shot'; seat: number; weapon: WeaponId; hit: boolean; targetId: number; dist: number }
  | { k: 'dry'; seat: number }
  | { k: 'hurtE'; id: number; kind: EnemyId; dmg: number; by: number }
  | { k: 'killE'; id: number; kind: EnemyId; by: number; x: number; y: number }
  | { k: 'hurtP'; seat: number; dmg: number }
  | { k: 'downP'; seat: number }
  | { k: 'reviveP'; seat: number; by: number }
  | { k: 'pickup'; seat: number; kind: string }
  | { k: 'door'; x: number; y: number; opened: boolean; colour: LockColour | null }
  | { k: 'damp'; x: number; y: number; chain: number }
  | { k: 'wake'; id: number; why: 'saw' | 'heard' }
  | { k: 'tell'; id: number; kind: EnemyId; x: number; y: number }
  | { k: 'descend'; floor: number }
  | { k: 'over'; win: boolean };

/** Everything a test needs to re-derive the auto-aim rule WITHOUT importing the game's raycast. */
export interface ShotAudit {
  seat: number;
  weapon: WeaponId;
  ox: number;
  oy: number;
  ang: number;
  cone: number;
  range: number;
  /** The enemy the game chose, or -1 for a miss. */
  targetId: number;
  targetDist: number;
  /** Every living enemy at the exact instant of the shot. Positions, not verdicts. */
  live: Array<{ id: number; x: number; y: number; radius: number; awake: boolean }>;
}

export interface GameConfig {
  seed: number;
  modeId: string;
  players: Array<{ name: string; bot: boolean }>;
  /** Which seat this device drives, or null for a pure spectator / headless sim. */
  mySeat?: number | null;
  /** Start at a floor other than 1 — used by the tutorial and by the balance sim's probes. */
  floor?: number;
  /** A hand-built level instead of the generator. The tutorial's only privilege. */
  level?: Level;
}

let nextId = 1;
const freshId = (): number => nextId++;

export class Game {
  readonly mode: Mode;
  readonly seed: number;
  readonly mySeat: number | null;

  floor: number;
  level: Level;
  /** Door openness 0..1 per cell. A door at 1 no longer blocks a ray or a body. */
  doors: Float32Array;
  players: Player[] = [];
  enemies: Enemy[] = [];
  bolts: Bolt[] = [];
  items: Item[] = [];
  /** Cells currently on fire, with seconds left. */
  fires = new Map<number, number>();

  over = false;
  won = false;
  /** Seconds elapsed on this floor — drives the pressure spawns. */
  floorTime = 0;
  /** Seconds elapsed across the whole run. */
  runTime = 0;
  deepest = 1;

  /**
   * The tutorial's one mercy. With this set a player is floored at 1 HP and never goes down: a
   * teaching sequence that can kill you on step two is not a teaching sequence, and the first build
   * did exactly that. It is a flag on the SHIPPED rules rather than a separate tutorial simulation,
   * because a separate simulation is how a tutorial ends up teaching a game that no longer exists.
   */
  noDeath = false;

  /**
   * Standing on the cage ENDS the run instead of descending. The tutorial sets it, because its floor
   * is hand-cut and the floor below it is not: without this, walking onto the cage on the last step
   * dropped the player into a freshly generated Adit floor 2 — a different level, mid-sentence.
   */
  stairEnds = false;

  events: GEvent[] = [];
  /** Installed by tests only. Called synchronously inside a shot, before anything moves. */
  onShotAudit: ((a: ShotAudit) => void) | null = null;

  private rng: Rng;
  private fields: Uint16Array[] = [];
  private tickNo = 0;
  private lastUse: boolean[] = [];
  private pressure = 0;
  private pressureGap: number = RAMP.pressureEvery;

  constructor(cfg: GameConfig) {
    this.mode = modeOf(cfg.modeId);
    this.seed = cfg.seed >>> 0;
    this.mySeat = cfg.mySeat ?? null;
    this.floor = cfg.floor ?? 1;
    this.deepest = this.floor;
    this.rng = makeRng(this.seed ^ 0x5bf03635);
    this.level = cfg.level ?? generate(this.seed, this.floor, this.mode, cfg.players.length);
    this.doors = new Float32Array(this.level.tiles.length);

    for (let s = 0; s < cfg.players.length; s++) {
      const p = cfg.players[s];
      this.players.push({
        seat: s,
        name: p.name,
        bot: p.bot,
        present: true,
        x: this.level.start.x,
        y: this.level.start.y,
        ang: 0,
        hp: PLAYER.hp,
        down: false,
        bleed: 0,
        reviving: 0,
        keys: new Set(),
        ammo: { cutter: WEAPONS.cutter.start, lance: WEAPONS.lance.start, charge: WEAPONS.charge.start },
        weapon: 'cutter',
        cool: 0,
        iframe: 0,
        stats: {
          kills: 0,
          shots: 0,
          hits: 0,
          damage: 0,
          taken: 0,
          revives: 0,
          downs: 0,
          doors: 0,
          damp: 0,
          steps: 0,
        },
      });
      this.lastUse.push(false);
    }
    this.populate();
    this.seatOut();
  }

  // ── level lifecycle ───────────────────────────────────────────────────────────────────────────

  private populate(): void {
    this.enemies = this.level.spawns.map((s) => this.makeEnemy(s.kind, s.x, s.y));
    this.items = this.level.items.map((i) => ({ id: freshId(), kind: i.kind, x: i.x + 0.5, y: i.y + 0.5, taken: false }));
    this.bolts = [];
    this.fires.clear();
    this.doors = new Float32Array(this.level.tiles.length);
    this.fields = this.players.map(() => new Uint16Array(this.level.tiles.length).fill(UNREACHED));
    this.floorTime = 0;
    this.pressure = 0;
    this.pressureGap = RAMP.pressureEvery;
    this.rebuildFields();
  }

  /**
   * Fan the seats out around the start so four bodies are not stacked in one cell.
   *
   * The obvious version — nudge each seat 0.45 cells along its own bearing — put players INSIDE THE
   * ROCK whenever the start room's centre was against a wall. Nothing looked wrong (you spawn facing
   * a wall and walk out of it), but the flow field starts at the player's cell, so a player embedded
   * in rock produced a field that reached nothing: every enemy on the floor was unreachable, and the
   * sim's reachability audit reported exactly that, in the 2-player configs only. So the nudge is
   * tried against the actual grid, and a seat that cannot be placed simply shares the centre.
   */
  private seatOut(): void {
    const cx = this.level.start.x;
    const cy = this.level.start.y;
    for (let s = 0; s < this.players.length; s++) {
      const p = this.players[s];
      p.x = cx;
      p.y = cy;
      if (s === 0) continue;
      for (let k = 0; k < 8; k++) {
        const a = ((s + k * 0.37) / this.players.length) * Math.PI * 2;
        const nx = cx + Math.cos(a) * 0.5;
        const ny = cy + Math.sin(a) * 0.5;
        if (this.hits(nx, ny, PLAYER.radius)) continue;
        p.x = nx;
        p.y = ny;
        break;
      }
    }
    this.rebuildFields();
  }

  private makeEnemy(kind: EnemyId, x: number, y: number): Enemy {
    const def = ENEMIES[kind];
    const hp = Math.round(def.hp * hpScale(this.floor) * this.mode.toughScale);
    return {
      id: freshId(),
      kind,
      x,
      y,
      ang: this.rng() * Math.PI * 2,
      hp,
      maxHp: hp,
      state: 'idle',
      cool: 0,
      target: -1,
      stagger: 0,
      windup: 0,
      side: this.rng() < 0.5 ? 1 : -1,
      burn: 0,
    };
  }

  /** Cut the next floor and move everyone onto it. Keys do not travel; ammo and HP do. */
  descend(): void {
    this.floor++;
    this.deepest = Math.max(this.deepest, this.floor);
    this.level = generate(this.seed, this.floor, this.mode, this.players.length);
    for (const p of this.players) {
      p.keys.clear();
      p.x = this.level.start.x;
      p.y = this.level.start.y;
      // Going down is the only free heal in the game, and it is deliberately partial.
      if (p.down) {
        p.down = false;
        p.hp = Math.max(PLAYER.reviveHp, Math.min(PLAYER.hp, this.mode.healOnDescend));
        p.bleed = 0;
        p.reviving = 0;
      } else {
        p.hp = Math.min(PLAYER.hp, p.hp + this.mode.healOnDescend);
      }
    }
    this.populate();
    this.seatOut();
    this.events.push({ k: 'descend', floor: this.floor });
  }

  // ── grid queries ──────────────────────────────────────────────────────────────────────────────

  tileAt(x: number, y: number): number {
    const s = this.level.side;
    const cx = x | 0;
    const cy = y | 0;
    if (cx < 0 || cy < 0 || cx >= s || cy >= s) return T.SOLID;
    return this.level.tiles[cy * s + cx];
  }

  /**
   * Does a RAY stop here? Sight, hitscan and the renderer all ask this. A grate does not stop a ray
   * — that is the entire point of it, and it is why this is a different question from `solid()`.
   */
  opaque(x: number, y: number): boolean {
    const s = this.level.side;
    const cx = x | 0;
    const cy = y | 0;
    if (cx < 0 || cy < 0 || cx >= s || cy >= s) return true;
    const t = this.level.tiles[cy * s + cx];
    if (isWallTile(t)) return true;
    if (isDoorTile(t)) return this.doors[cy * s + cx] < 0.75;
    return false;
  }

  /**
   * Does a BODY of this radius stop here? Movement asks this. A grate stops everything; a sump stops
   * only something wider than SUMP_RADIUS, which in this roster is the hauler and nothing else.
   */
  solid(x: number, y: number, radius: number): boolean {
    const s = this.level.side;
    const cx = x | 0;
    const cy = y | 0;
    if (cx < 0 || cy < 0 || cx >= s || cy >= s) return true;
    const t = this.level.tiles[cy * s + cx];
    if (isWallTile(t) || t === T.GRATE) return true;
    if (t === T.SUMP) return radius >= SUMP_RADIUS;
    if (isDoorTile(t)) return this.doors[cy * s + cx] < 0.75;
    return false;
  }

  /** How much a cell slows a body crossing it. Water is slow, and it is loud. */
  drag(x: number, y: number): number {
    return this.tileAt(x, y) === T.SUMP ? 0.45 : 1;
  }

  /** Kept for the renderer's DDA and every sight test — a ray's question, not a body's. */
  blocked(x: number, y: number): boolean {
    return this.opaque(x, y);
  }

  /** Pathing passability: an unlocked door is a way through even while shut, a locked one is not. */
  /**
   * Pathing passability for the flow field. A locked door is impassable until opened, and ONLY
   * PLAYERS CAN OPEN ONE — so the moment you card a door, the field rebuilt on the next tick hands
   * the far half of the mine a route into the hall you cleared ten minutes ago. No line of code says
   * "opening the door releases the horde"; it is the field noticing.
   */
  private passable(i: number): boolean {
    const t = this.level.tiles[i];
    if (isWallTile(t) || t === T.GRATE) return false;
    if (t === T.DOOR) return true;
    if (isDoorTile(t)) return this.doors[i] >= 0.75;
    return true;
  }

  /**
   * Line of sight, as a grid DDA rather than a sampled walk.
   *
   * Sampling the segment at a fixed rate is the obvious implementation and it is subtly wrong: a
   * ray that crosses a one-cell pillar diagonally can step over it, so shots go through corners.
   * With eight samples per cell that happened twice in a single three-minute run, and it was the
   * mechanism audit — which samples far finer — that noticed. A DDA visits every cell the segment
   * actually enters, so there is no sampling rate to get wrong, and it is CHEAPER: about two cells
   * per unit distance instead of eight.
   */
  clearLine(x0: number, y0: number, x1: number, y1: number): boolean {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-9) return !this.blocked(x0, y0);
    const rx = dx / dist;
    const ry = dy / dist;
    let cx = x0 | 0;
    let cy = y0 | 0;
    const stepX = rx > 0 ? 1 : -1;
    const stepY = ry > 0 ? 1 : -1;
    const dtX = rx === 0 ? Infinity : Math.abs(1 / rx);
    const dtY = ry === 0 ? Infinity : Math.abs(1 / ry);
    let tX = rx === 0 ? Infinity : ((rx > 0 ? cx + 1 - x0 : x0 - cx) || 1e-9) * dtX;
    let tY = ry === 0 ? Infinity : ((ry > 0 ? cy + 1 - y0 : y0 - cy) || 1e-9) * dtY;
    // The endpoint cell itself is the target's own cell and is never a blocker.
    const endX = x1 | 0;
    const endY = y1 | 0;
    for (let guard = 0; guard < 512; guard++) {
      const t = Math.min(tX, tY);
      if (t >= dist) return true;
      if (tX < tY) {
        cx += stepX;
        tX += dtX;
      } else {
        cy += stepY;
        tY += dtY;
      }
      if (cx === endX && cy === endY) return true;
      if (this.blocked(cx + 0.5, cy + 0.5)) return false;
    }
    return true;
  }

  // ── the flow field ────────────────────────────────────────────────────────────────────────────

  private rebuildFields(): void {
    const s = this.level.side;
    for (let seat = 0; seat < this.players.length; seat++) {
      const f = this.fields[seat] ?? (this.fields[seat] = new Uint16Array(s * s));
      f.fill(UNREACHED);
      const p = this.players[seat];
      if (!p.present || p.down) continue;
      const start = (p.y | 0) * s + (p.x | 0);
      if (start < 0 || start >= f.length || !this.passable(start)) continue;
      f[start] = 0;
      const q = new Int32Array(s * s);
      let head = 0;
      let tail = 0;
      q[tail++] = start;
      while (head < tail) {
        const cur = q[head++];
        const d = f[cur] + 1;
        const cx = cur % s;
        const nb = [cur - 1, cur + 1, cur - s, cur + s];
        for (let k = 0; k < 4; k++) {
          const n = nb[k];
          if (n < 0 || n >= f.length) continue;
          // Guard the row wrap: cell 0 of a row is not adjacent to the last cell of the one above.
          if (k === 0 && cx === 0) continue;
          if (k === 1 && cx === s - 1) continue;
          if (f[n] !== UNREACHED || !this.passable(n)) continue;
          f[n] = d;
          q[tail++] = n;
        }
      }
    }
  }

  /** Field distance at a world position for a given seat, or UNREACHED. */
  fieldAt(seat: number, x: number, y: number): number {
    const s = this.level.side;
    const cx = x | 0;
    const cy = y | 0;
    if (cx < 0 || cy < 0 || cx >= s || cy >= s) return UNREACHED;
    return this.fields[seat]?.[cy * s + cx] ?? UNREACHED;
  }

  // ── the tick ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Advance the world by exactly `step` seconds. `intents[seat]` is that seat's input this tick.
   * Deterministic given the same seed, the same floor and the same intents — which is what makes a
   * promoted host able to carry on from a snapshot, and what makes the sim reproducible.
   */
  tick(step: number, intents: Intent[]): void {
    if (this.over) return;
    this.tickNo++;
    this.runTime += step;
    this.floorTime += step;

    if (this.tickNo % FIELD_EVERY === 0) this.rebuildFields();

    for (let s = 0; s < this.players.length; s++) this.stepPlayer(this.players[s], intents[s] ?? IDLE_INTENT, step);
    for (const e of this.enemies) if (e.state !== 'dead') this.stepEnemy(e, step);
    this.stepBolts(step);
    this.stepFires(step);
    this.stepDoors(step);
    this.stepPressure(step);

    this.enemies = this.enemies.filter((e) => e.state !== 'dead');

    // The run ends when everybody who is still in the room is down. A peer who left is not a body
    // lying on the floor — it must not be able to hold the party hostage or to end the run.
    const active = this.players.filter((p) => p.present);
    if (active.length && active.every((p) => p.down)) this.finish(false);
  }

  private finish(win: boolean): void {
    if (this.over) return;
    this.over = true;
    this.won = win;
    this.events.push({ k: 'over', win });
  }

  // ── players ───────────────────────────────────────────────────────────────────────────────────

  private stepPlayer(p: Player, intent: Intent, step: number): void {
    if (!p.present) return;
    p.iframe = Math.max(0, p.iframe - step);
    p.cool = Math.max(0, p.cool - step);

    if (p.down) {
      p.bleed -= step;
      // A downed player is not dead, and being downed alone is not instantly fatal — the bleed-out
      // is the timer a mate is racing. Solo, it is simply the run ending.
      if (p.bleed <= 0) {
        const others = this.players.filter((o) => o.present && !o.down);
        if (!others.length) this.finish(false);
      }
      return;
    }

    p.ang = intent.ang;
    if (Object.hasOwn(WEAPONS, intent.weapon)) p.weapon = intent.weapon;

    // ── movement, resolved axis by axis so a corner slides instead of sticking ──
    const cos = Math.cos(p.ang);
    const sin = Math.sin(p.ang);
    const fwd = intent.my >= 0 ? intent.my : intent.my * PLAYER.backScale;
    const str = intent.mx * PLAYER.strafeScale;
    let dx = (cos * fwd - sin * str) * PLAYER.speed * step;
    let dy = (sin * fwd + cos * str) * PLAYER.speed * step;
    const mag = Math.hypot(dx, dy);
    const cap = PLAYER.speed * step;
    if (mag > cap) {
      dx = (dx / mag) * cap;
      dy = (dy / mag) * cap;
    }
    const moved = this.slide(p, dx, dy, PLAYER.radius);
    p.stats.steps += moved;

    this.pickUp(p);
    this.burnCheck(p, step);

    // ── use: a door, or a mate on the floor ──
    const rising = intent.use && !this.lastUse[p.seat];
    this.lastUse[p.seat] = intent.use;
    if (rising) this.tryUse(p);
    this.tryRevive(p, step);

    if (intent.fire) this.tryFire(p);

    // ── the cage ──
    if (this.tileAt(p.x, p.y) === T.STAIR) {
      if (this.stairEnds || isLastFloor(this.mode, this.floor)) this.finish(true);
      else this.descend();
    }
  }

  /** Move a circle through the grid, one axis at a time. Returns the distance actually travelled. */
  private slide(body: { x: number; y: number }, dx: number, dy: number, r: number): number {
    const x0 = body.x;
    const y0 = body.y;
    const k = this.drag(body.x, body.y);
    const mx = dx * k;
    const my = dy * k;
    if (!this.hits(body.x + mx, body.y, r)) body.x += mx;
    if (!this.hits(body.x, body.y + my, r)) body.y += my;
    return Math.hypot(body.x - x0, body.y - y0);
  }

  private hits(x: number, y: number, r: number): boolean {
    // Four probes on the circle's axes is enough at these radii and it is four grid reads, not nine.
    return this.solid(x + r, y, r) || this.solid(x - r, y, r) || this.solid(x, y + r, r) || this.solid(x, y - r, r);
  }

  private pickUp(p: Player): void {
    for (const it of this.items) {
      if (it.taken) continue;
      if (Math.hypot(it.x - p.x, it.y - p.y) > 0.62) continue;
      if (it.kind === 'carbide') {
        if (p.hp >= PLAYER.hp) continue;
        p.hp = Math.min(PLAYER.hp, p.hp + PLAYER.carbide);
      } else if (it.kind === 'ammoCutter') p.ammo.cutter = Math.min(WEAPONS.cutter.cap, p.ammo.cutter + 55);
      else if (it.kind === 'ammoLance') p.ammo.lance = Math.min(WEAPONS.lance.cap, p.ammo.lance + 9);
      else if (it.kind === 'ammoCharge') p.ammo.charge = Math.min(WEAPONS.charge.cap, p.ammo.charge + 3);
      else p.keys.add(it.kind as LockColour);
      it.taken = true;
      this.events.push({ k: 'pickup', seat: p.seat, kind: it.kind });
    }
  }

  /** The cell a player is facing, one step out. */
  private facingCell(p: Player): { x: number; y: number; i: number } {
    const x = p.x + Math.cos(p.ang) * 0.85;
    const y = p.y + Math.sin(p.ang) * 0.85;
    const s = this.level.side;
    return { x: x | 0, y: y | 0, i: (y | 0) * s + (x | 0) };
  }

  private tryUse(p: Player): void {
    const c = this.facingCell(p);
    if (c.i < 0 || c.i >= this.level.tiles.length) return;
    const t = this.level.tiles[c.i];
    if (!isDoorTile(t)) return;
    if (this.doors[c.i] > 0) return;
    const colour = TILE_LOCK[t] ?? null;
    if (colour && !p.keys.has(colour)) {
      this.events.push({ k: 'door', x: c.x, y: c.y, opened: false, colour });
      return;
    }
    this.doors[c.i] = 0.01;
    p.stats.doors++;
    this.events.push({ k: 'door', x: c.x, y: c.y, opened: true, colour });
  }

  private tryRevive(p: Player, step: number): void {
    for (const o of this.players) {
      if (o === p || !o.present || !o.down) continue;
      if (Math.hypot(o.x - p.x, o.y - p.y) > PLAYER.reviveRange) continue;
      o.reviving += step;
      if (o.reviving >= PLAYER.reviveTime) {
        o.down = false;
        o.reviving = 0;
        o.bleed = 0;
        o.hp = PLAYER.reviveHp;
        p.stats.revives++;
        this.events.push({ k: 'reviveP', seat: o.seat, by: p.seat });
      }
      return;
    }
  }

  // ── shooting ──────────────────────────────────────────────────────────────────────────────────

  private tryFire(p: Player): void {
    if (p.cool > 0) return;
    const w = WEAPONS[p.weapon];
    if (p.ammo[p.weapon] <= 0) {
      // A dry trigger still costs a beat, or the "click" becomes a machine gun.
      p.cool = 0.28;
      this.events.push({ k: 'dry', seat: p.seat });
      return;
    }
    p.cool = w.interval;
    p.ammo[p.weapon]--;
    p.stats.shots++;

    const target = this.acquire(p, w.cone, w.range);
    if (this.onShotAudit) {
      this.onShotAudit({
        seat: p.seat,
        weapon: p.weapon,
        ox: p.x,
        oy: p.y,
        ang: p.ang,
        cone: w.cone,
        range: w.range,
        targetId: target ? target.e.id : -1,
        targetDist: target ? target.dist : -1,
        live: this.enemies
          .filter((e) => e.state !== 'dead' && e.hp > 0)
          .map((e) => ({ id: e.id, x: e.x, y: e.y, radius: ENEMIES[e.kind].radius, awake: e.state !== 'idle' })),
      });
    }

    // The shot flies where you are LOOKING. Auto-aim only nudges the last few degrees onto a target
    // that is already inside the cone — so a shot with nothing in the cone is a genuine miss.
    const aim = target ? Math.atan2(target.e.y - p.y, target.e.x - p.x) : p.ang;
    this.noise(p.x, p.y, w.noise, p.seat);

    if (w.kind === 'lob') {
      this.bolts.push({
        id: freshId(),
        x: p.x,
        y: p.y,
        vx: Math.cos(aim) * w.speed,
        vy: Math.sin(aim) * w.speed,
        dmg: w.damage,
        splash: w.splash,
        life: w.range / w.speed,
        seat: p.seat,
      });
      this.events.push({ k: 'shot', seat: p.seat, weapon: p.weapon, hit: false, targetId: -1, dist: 0 });
      return;
    }

    // Hitscan: walk the ray and hit up to `pierce` bodies in order of distance.
    const hits = this.rayHits(p.x, p.y, aim, w.range, w.pierce);
    for (const h of hits) this.damageEnemy(h.e, w.damage, p.seat, w.armourBite);
    if (hits.length) p.stats.hits++;
    this.events.push({
      k: 'shot',
      seat: p.seat,
      weapon: p.weapon,
      hit: hits.length > 0,
      targetId: hits.length ? hits[0].e.id : -1,
      dist: hits.length ? hits[0].dist : w.range,
    });
    // A shot into a firedamp pocket sets it off, which is how you use one on purpose.
    this.igniteAlong(p.x, p.y, aim, hits.length ? hits[0].dist : w.range);
  }

  /**
   * Nearest AWAKE enemy inside the cone with clear line of sight. Nearest, never "most damaged", and
   * never something still asleep.
   *
   * The `idle` gate is the consent gate, and it is why there is no fire button: a gun that fires
   * itself at everything would make sneaking past a sleeping room impossible and would rob the noise
   * system of its teeth. Because the gun only engages what has already noticed you, walking quietly
   * is a real option and every trigger pull is a decision to be heard.
   *
   * It stops the gun SWINGING onto a sleeper. It does not make one bulletproof: `rayHits` does not
   * filter on state, so a round fired straight down your own facing lands, wakes it, and is a
   * perfectly good opening shot. That asymmetry is deliberate — "facing is aiming" would be a slogan
   * rather than a rule if looking right at something and firing did nothing.
   */
  private acquire(p: Player, cone: number, range: number): { e: Enemy; dist: number } | null {
    let best: { e: Enemy; dist: number } | null = null;
    for (const e of this.enemies) {
      if (e.state === 'dead' || e.hp <= 0 || e.state === 'idle') continue;
      const dx = e.x - p.x;
      const dy = e.y - p.y;
      const dist = Math.hypot(dx, dy);
      if (dist > range) continue;
      let da = Math.atan2(dy, dx) - p.ang;
      while (da > Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      if (Math.abs(da) > cone) continue;
      if (!this.clearLine(p.x, p.y, e.x, e.y)) continue;
      if (!best || dist < best.dist) best = { e, dist };
    }
    return best;
  }

  /** Bodies along a ray, nearest first, stopping at the first wall. */
  private rayHits(ox: number, oy: number, ang: number, range: number, pierce: number): Array<{ e: Enemy; dist: number }> {
    const cos = Math.cos(ang);
    const sin = Math.sin(ang);
    const wall = this.wallDist(ox, oy, ang, range);
    const out: Array<{ e: Enemy; dist: number }> = [];
    for (const e of this.enemies) {
      if (e.state === 'dead' || e.hp <= 0) continue;
      const dx = e.x - ox;
      const dy = e.y - oy;
      // Distance along the ray, and perpendicular offset from it.
      const along = dx * cos + dy * sin;
      if (along <= 0 || along > Math.min(range, wall)) continue;
      const perp = Math.abs(-dx * sin + dy * cos);
      if (perp > ENEMIES[e.kind].radius) continue;
      // The corridor test alone lets a shot clip a corner: a body whose CENTRE sits behind a pillar
      // can still be within one radius of the ray, and `wall` is measured along the ray rather than
      // toward the body. Two shots in a three-minute run registered exactly that, and the mechanism
      // audit — which asks for a clear line to the body itself — caught them. Ask for the same line.
      if (!this.clearLine(ox, oy, e.x, e.y)) continue;
      out.push({ e, dist: along });
    }
    out.sort((a, b) => a.dist - b.dist);
    return out.slice(0, Math.max(1, pierce));
  }

  /** Distance to the first blocking cell along a ray, capped at `range`. */
  wallDist(ox: number, oy: number, ang: number, range: number): number {
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    const steps = Math.ceil(range * 12);
    for (let i = 1; i <= steps; i++) {
      const t = (i / steps) * range;
      if (this.blocked(ox + dx * t, oy + dy * t)) return t;
    }
    return range;
  }

  private igniteAlong(ox: number, oy: number, ang: number, dist: number): void {
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    const steps = Math.ceil(dist * 4);
    for (let i = 1; i <= steps; i++) {
      const t = (i / steps) * dist;
      const x = ox + dx * t;
      const y = oy + dy * t;
      if (this.tileAt(x, y) === T.DAMP) {
        this.ignite(x | 0, y | 0, 0);
        return;
      }
    }
  }

  // ── damage ────────────────────────────────────────────────────────────────────────────────────

  private damageEnemy(e: Enemy, dmg: number, by: number, armourBite: number): void {
    if (e.state === 'dead') return;
    const def = ENEMIES[e.kind];
    const real = def.armoured ? dmg * armourBite : dmg;
    e.hp -= real;
    e.stagger = Math.max(e.stagger, 0.09);
    if (by >= 0) {
      const p = this.players[by];
      if (p) p.stats.damage += Math.min(real, real + Math.min(0, e.hp));
    }
    // Being shot wakes a thing whether or not it saw you.
    if (e.state === 'idle') {
      e.state = 'alert';
      e.target = by >= 0 ? by : this.nearestSeat(e);
      this.events.push({ k: 'wake', id: e.id, why: 'heard' });
    }
    if (e.hp <= 0) {
      e.state = 'dead';
      this.events.push({ k: 'killE', id: e.id, kind: e.kind, by, x: e.x, y: e.y });
      if (by >= 0 && this.players[by]) {
        this.players[by].stats.kills++;
        this.dropFromKill(this.players[by], e);
      }
      // A body falling into firedamp lights it. This is where a lot of the chaos comes from, and it
      // is not special-cased: the rule is simply "a death on a damp cell ignites it".
      if (this.tileAt(e.x, e.y) === T.DAMP) this.ignite(e.x | 0, e.y | 0, 0);
    } else {
      this.events.push({ k: 'hurtE', id: e.id, kind: e.kind, dmg: real, by });
    }
  }

  private dropFromKill(p: Player, e: Enemy): void {
    const share = this.mode.killDrop * (ENEMIES[e.kind].hp / ENEMIES.thrall.hp);
    p.ammo.cutter = Math.min(WEAPONS.cutter.cap, p.ammo.cutter + Math.round(WEAPONS.cutter.cap * share * 0.16));
    // Lance and charge rounds come off bodies rarely, so scarcity survives a long floor.
    if (this.rng() < share * 0.5) p.ammo.lance = Math.min(WEAPONS.lance.cap, p.ammo.lance + 1);
    if (this.rng() < share * 0.12) p.ammo.charge = Math.min(WEAPONS.charge.cap, p.ammo.charge + 1);
  }

  private damagePlayer(p: Player, dmg: number): void {
    if (p.down || !p.present || p.iframe > 0) return;
    p.hp -= dmg;
    p.iframe = PLAYER.iframes;
    p.stats.taken += dmg;
    if (this.noDeath && p.hp < 1) {
      p.hp = 1;
      this.events.push({ k: 'hurtP', seat: p.seat, dmg });
      return;
    }
    if (p.hp <= 0) {
      p.hp = 0;
      p.down = true;
      p.bleed = PLAYER.bleedOut;
      p.reviving = 0;
      p.stats.downs++;
      this.events.push({ k: 'downP', seat: p.seat });
    } else {
      this.events.push({ k: 'hurtP', seat: p.seat, dmg });
    }
  }

  // ── firedamp ──────────────────────────────────────────────────────────────────────────────────

  private ignite(cx: number, cy: number, chain: number): void {
    const s = this.level.side;
    const i = cy * s + cx;
    if (this.level.tiles[i] !== T.DAMP) return;
    this.level.tiles[i] = T.OPEN;
    this.fires.set(i, DAMP.burn);
    this.events.push({ k: 'damp', x: cx, y: cy, chain });
    this.noise(cx + 0.5, cy + 0.5, DAMP.noise);

    const blast = (bx: number, by: number, hurt: (d: number) => void): void => {
      const d = Math.hypot(bx - (cx + 0.5), by - (cy + 0.5));
      if (d > DAMP.radius) return;
      if (!this.clearLine(cx + 0.5, cy + 0.5, bx, by)) return;
      hurt(DAMP.damage * (1 - d / DAMP.radius));
    };
    for (const e of this.enemies) {
      if (e.state === 'dead') continue;
      blast(e.x, e.y, (d) => this.damageEnemy(e, d, -1, 1));
    }
    for (const p of this.players) {
      if (!p.present || p.down) continue;
      blast(p.x, p.y, (d) => {
        // Your own charge going off in your face is supposed to hurt. It is what stops the launcher
        // being the answer to everything.
        p.iframe = 0;
        this.damagePlayer(p, d);
      });
    }
    // Chain, breadth-first, with a depth guard so a chamber full of damp cannot recurse forever.
    if (chain >= 6) return;
    for (const other of this.level.damp) {
      if (this.level.tiles[other] !== T.DAMP) continue;
      const ox = other % s;
      const oy = (other / s) | 0;
      if (Math.hypot(ox - cx, oy - cy) <= DAMP.chain) this.ignite(ox, oy, chain + 1);
    }
  }

  private stepFires(step: number): void {
    if (!this.fires.size) return;
    const s = this.level.side;
    for (const [i, left] of [...this.fires]) {
      const rest = left - step;
      if (rest <= 0) this.fires.delete(i);
      else this.fires.set(i, rest);
      const cx = i % s;
      const cy = (i / s) | 0;
      for (const e of this.enemies) {
        if (e.state === 'dead') continue;
        if ((e.x | 0) === cx && (e.y | 0) === cy) this.damageEnemy(e, DAMP.burnDps * step, -1, 1);
      }
    }
  }

  private burnCheck(p: Player, step: number): void {
    const s = this.level.side;
    const i = (p.y | 0) * s + (p.x | 0);
    if (!this.fires.has(i)) return;
    p.iframe = 0;
    this.damagePlayer(p, DAMP.burnDps * step);
    p.stats.damp += DAMP.burnDps * step;
  }

  // ── enemies ───────────────────────────────────────────────────────────────────────────────────

  private nearestSeat(e: Enemy): number {
    let best = -1;
    let bd = Infinity;
    for (const p of this.players) {
      if (!p.present || p.down) continue;
      const d = Math.hypot(p.x - e.x, p.y - e.y);
      if (d < bd) {
        bd = d;
        best = p.seat;
      }
    }
    return best;
  }

  /** A noise event: everything within `radius` cells OF FLOOD-FILL (not line of sight) wakes. */
  private noise(x: number, y: number, radius: number, seat = -1): void {
    for (const e of this.enemies) {
      if (e.state !== 'idle') continue;
      const reach = radius * ENEMIES[e.kind].ears;
      // Sound goes AROUND corners and never through rock, and it costs nothing to say so: the flow
      // field is already a BFS distance from the shooter over walkable cells, so field distance IS
      // the length of the path the sound would take. A straight-line radius would wake things
      // through a metre of stone, which makes hiding meaningless and the whole noise budget a lie.
      const path = seat >= 0 ? this.fieldAt(seat, e.x, e.y) : UNREACHED;
      const heard = path !== UNREACHED ? path <= reach : Math.hypot(e.x - x, e.y - y) <= reach * 0.6;
      if (!heard) continue;
      e.state = 'alert';
      e.target = this.nearestSeat(e);
      this.events.push({ k: 'wake', id: e.id, why: 'heard' });
    }
  }

  private stepEnemy(e: Enemy, step: number): void {
    const def = ENEMIES[e.kind];
    e.cool = Math.max(0, e.cool - step);
    e.stagger = Math.max(0, e.stagger - step);

    // A committed attack resolves whether or not you are still there. That is the deal: the tell is
    // long enough to react to, so stepping out of reach beats it and standing still does not.
    if (e.windup > 0) {
      e.windup -= step;
      e.state = 'attack';
      if (e.windup <= 0) this.land(e, def);
      return;
    }

    if (e.state === 'idle') {
      // Sight: in range, with line of sight. No facing requirement — these things do not have fronts.
      const seat = this.nearestSeat(e);
      if (seat >= 0) {
        const p = this.players[seat];
        if (Math.hypot(p.x - e.x, p.y - e.y) <= def.eyes && this.clearLine(e.x, e.y, p.x, p.y)) {
          e.state = 'alert';
          e.target = seat;
          this.events.push({ k: 'wake', id: e.id, why: 'saw' });
        }
      }
      return;
    }

    // Re-target if the current one went down or left; give up entirely if nobody is standing.
    let p = this.players[e.target];
    if (!p || !p.present || p.down) {
      const seat = this.nearestSeat(e);
      if (seat < 0) {
        e.state = 'idle';
        e.target = -1;
        return;
      }
      e.target = seat;
      p = this.players[seat];
    }

    const dx = p.x - e.x;
    const dy = p.y - e.y;
    const dist = Math.hypot(dx, dy);
    const toPlayer = Math.atan2(dy, dx);
    e.ang = toPlayer;
    const los = this.clearLine(e.x, e.y, p.x, p.y);

    if (e.stagger > 0) {
      e.state = 'chase';
      return;
    }

    // ── the shooter: opens up at range and BACKS OFF when you close. ──
    if (def.boltSpeed > 0) {
      if (dist < def.keepAway && los) {
        e.state = 'retreat';
        this.stepAwayFromField(e, def.speed * step);
        return;
      }
      if (dist <= def.boltRange && los) {
        e.state = 'attack';
        if (e.cool <= 0) {
          e.cool = def.cooldown + def.windup;
          e.windup = def.windup;
          this.events.push({ k: 'tell', id: e.id, kind: e.kind, x: e.x, y: e.y });
        }
        return;
      }
      e.state = 'chase';
      this.stepDownField(e, def.speed * step);
      return;
    }

    // ── melee ──
    if (dist <= def.reach) {
      e.state = 'attack';
      if (e.cool <= 0) {
        e.cool = def.cooldown + def.windup;
        e.windup = def.windup;
        this.events.push({ k: 'tell', id: e.id, kind: e.kind, x: e.x, y: e.y });
      }
      return;
    }

    // ── the flanker: it will not walk up your barrel. ──
    // Inside your facing cone and close enough to matter, it sidesteps to break the angle instead of
    // closing. That is what makes a stalker feel like it is thinking, and it is four lines: no
    // planner, no A*, just a tangential step while it is in front of you.
    if (def.flank && los && dist < 7) {
      let da = toPlayer - p.ang + Math.PI;
      while (da > Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      if (Math.abs(da) < 0.62) {
        e.state = 'flank';
        const tang = toPlayer + (Math.PI / 2) * e.side;
        const before = { x: e.x, y: e.y };
        this.slide(e, Math.cos(tang) * def.speed * step, Math.sin(tang) * def.speed * step, def.radius);
        // If the sidestep got nowhere it is against a wall — turn around rather than grind.
        if (Math.hypot(e.x - before.x, e.y - before.y) < def.speed * step * 0.3) e.side *= -1;
        return;
      }
    }

    e.state = 'chase';
    this.stepDownField(e, def.speed * step);
  }

  /** The committed end of a telegraphed attack: a bolt leaves, or a claw lands if you are still there. */
  private land(e: Enemy, def: (typeof ENEMIES)[EnemyId]): void {
    const p = this.players[e.target];
    if (!p || !p.present || p.down) return;
    const dmg = def.damage * dmgScale(this.floor) * this.mode.toughScale;
    const toPlayer = Math.atan2(p.y - e.y, p.x - e.x);
    if (def.boltSpeed > 0) {
      this.bolts.push({
        id: freshId(),
        x: e.x + Math.cos(toPlayer) * 0.4,
        y: e.y + Math.sin(toPlayer) * 0.4,
        vx: Math.cos(toPlayer) * def.boltSpeed,
        vy: Math.sin(toPlayer) * def.boltSpeed,
        dmg,
        splash: 0,
        life: def.boltRange / def.boltSpeed,
        seat: -1,
      });
      return;
    }
    // Melee only connects if you are STILL in reach when it lands — the whole point of the tell.
    if (Math.hypot(p.x - e.x, p.y - e.y) <= def.reach + 0.2) this.damagePlayer(p, dmg);
  }

  /** One step downhill on the target's flow field, falling back to a straight line if unreached. */
  private stepDownField(e: Enemy, dist: number): void {
    const s = this.level.side;
    const f = this.fields[e.target];
    const def = ENEMIES[e.kind];
    const here = f ? this.fieldAt(e.target, e.x, e.y) : UNREACHED;
    if (!f || here === UNREACHED) {
      const p = this.players[e.target];
      if (!p) return;
      const a = Math.atan2(p.y - e.y, p.x - e.x);
      this.slide(e, Math.cos(a) * dist, Math.sin(a) * dist, def.radius);
      return;
    }
    const cx = e.x | 0;
    const cy = e.y | 0;
    let bestD = here;
    let bx = cx;
    let by = cy;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        if (ox === 0 && oy === 0) continue;
        const nx = cx + ox;
        const ny = cy + oy;
        if (nx < 0 || ny < 0 || nx >= s || ny >= s) continue;
        // A diagonal is only taken when both orthogonals are open, or bodies clip wall corners.
        if (ox !== 0 && oy !== 0 && (!this.passable(cy * s + nx) || !this.passable(ny * s + cx))) continue;
        const d = f[ny * s + nx];
        if (d < bestD) {
          bestD = d;
          bx = nx;
          by = ny;
        }
      }
    }
    const tx = bx + 0.5;
    const ty = by + 0.5;
    const a = Math.atan2(ty - e.y, tx - e.x);
    this.slide(e, Math.cos(a) * dist, Math.sin(a) * dist, def.radius);
  }

  /** One step UPHILL — away from the target. The lurker's kite. */
  private stepAwayFromField(e: Enemy, dist: number): void {
    const p = this.players[e.target];
    if (!p) return;
    const a = Math.atan2(e.y - p.y, e.x - p.x);
    const def = ENEMIES[e.kind];
    const before = { x: e.x, y: e.y };
    this.slide(e, Math.cos(a) * dist, Math.sin(a) * dist, def.radius);
    // Cornered: a lurker with nowhere to go stops kiting and shoots, rather than vibrating on a wall.
    if (Math.hypot(e.x - before.x, e.y - before.y) < dist * 0.25) e.state = 'attack';
  }

  // ── bolts, doors, pressure ────────────────────────────────────────────────────────────────────

  private stepBolts(step: number): void {
    const live: Bolt[] = [];
    for (const b of this.bolts) {
      b.life -= step;
      if (b.life <= 0) {
        if (b.splash > 0) this.splash(b);
        continue;
      }
      const nx = b.x + b.vx * step;
      const ny = b.y + b.vy * step;
      if (this.blocked(nx, ny)) {
        if (b.splash > 0) this.splash(b);
        else if (this.tileAt(b.x, b.y) === T.DAMP) this.ignite(b.x | 0, b.y | 0, 0);
        continue;
      }
      b.x = nx;
      b.y = ny;

      let done = false;
      if (b.seat >= 0) {
        for (const e of this.enemies) {
          if (e.state === 'dead') continue;
          if (Math.hypot(e.x - b.x, e.y - b.y) > ENEMIES[e.kind].radius + 0.12) continue;
          if (b.splash > 0) this.splash(b);
          else this.damageEnemy(e, b.dmg, b.seat, 1);
          done = true;
          break;
        }
      } else {
        // An enemy bolt hits the FIRST body in its way, and a hauler standing between a lurker and
        // you eats it. Nothing special-cases friendly fire; the bolt simply does not know.
        for (const e of this.enemies) {
          if (e.state === 'dead' || ENEMIES[e.kind].boltSpeed > 0) continue;
          if (Math.hypot(e.x - b.x, e.y - b.y) > ENEMIES[e.kind].radius) continue;
          this.damageEnemy(e, b.dmg, -1, 1);
          done = true;
          break;
        }
        if (!done) {
          for (const p of this.players) {
            if (!p.present || p.down) continue;
            if (Math.hypot(p.x - b.x, p.y - b.y) > PLAYER.radius + 0.14) continue;
            this.damagePlayer(p, b.dmg);
            done = true;
            break;
          }
        }
      }
      if (!done) {
        if (this.tileAt(b.x, b.y) === T.DAMP) {
          this.ignite(b.x | 0, b.y | 0, 0);
          continue;
        }
        live.push(b);
      }
    }
    this.bolts = live;
  }

  private splash(b: Bolt): void {
    for (const e of this.enemies) {
      if (e.state === 'dead') continue;
      const d = Math.hypot(e.x - b.x, e.y - b.y);
      if (d > b.splash) continue;
      this.damageEnemy(e, b.dmg * (1 - d / b.splash), b.seat, 1);
    }
    for (const p of this.players) {
      if (!p.present || p.down) continue;
      const d = Math.hypot(p.x - b.x, p.y - b.y);
      if (d > b.splash) continue;
      this.damagePlayer(p, b.dmg * (1 - d / b.splash) * 0.55);
    }
    if (this.tileAt(b.x, b.y) === T.DAMP) this.ignite(b.x | 0, b.y | 0, 0);
    // A charge landing NEXT to a pocket sets it off too — the splash is what reaches it.
    const s = this.level.side;
    for (const other of this.level.damp) {
      if (this.level.tiles[other] !== T.DAMP) continue;
      const ox = (other % s) + 0.5;
      const oy = ((other / s) | 0) + 0.5;
      if (Math.hypot(ox - b.x, oy - b.y) <= b.splash + 0.6) this.ignite(ox | 0, oy | 0, 0);
    }
  }

  private stepDoors(step: number): void {
    for (let i = 0; i < this.doors.length; i++) {
      if (this.doors[i] > 0 && this.doors[i] < 1) this.doors[i] = Math.min(1, this.doors[i] + step * 1.8);
    }
    // Plain doors are curtains, not puzzles: they open for anything that walks up to them, which is
    // also why an enemy behind one is never permanently stuck.
    for (const body of [...this.players.filter((p) => p.present && !p.down), ...this.enemies]) {
      const s = this.level.side;
      const cx = body.x | 0;
      const cy = body.y | 0;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const nx = cx + ox;
          const ny = cy + oy;
          if (nx < 0 || ny < 0 || nx >= s || ny >= s) continue;
          const i = ny * s + nx;
          if (this.level.tiles[i] === T.DOOR && this.doors[i] === 0) this.doors[i] = 0.01;
        }
      }
    }
  }

  /**
   * Camping is not a strategy. After a while on one floor the mine starts sending things after you,
   * on a fixed cadence, spawned out of sight of every living player.
   */
  private stepPressure(step: number): void {
    if (this.floorTime < RAMP.pressureAfter) return;
    this.pressure += step;
    if (this.pressure < this.pressureGap) return;
    this.pressure = 0;
    // Each wave comes sooner than the last, down to a floor. A party that has lost the stair does
    // not get to farm the mine forever; the mine wins on a clock it controls.
    this.pressureGap = Math.max(RAMP.pressureFloor, this.pressureGap * RAMP.pressureDecay);
    const rooms = this.level.rooms;
    // Waves get nastier the longer a floor drags, not just more numerous — twenty minutes of thralls
    // is a grind, and a grind is what a party that has lost the stair was doing anyway.
    const late = (this.floorTime - RAMP.pressureAfter) / 60;
    const kind: EnemyId = this.rng() < Math.min(0.5, 0.12 + late * 0.22) ? 'stalker' : this.rng() < late * 0.2 ? 'hauler' : 'thrall';

    // The wave itself grows. A shrinking gap alone is not enough to close a run — three players
    // reviving each other out-killed a one-at-a-time trickle indefinitely; 6.7% of runs were still
    // going at fifteen minutes with only the gap decaying.
    const burst = 1 + Math.min(3, Math.floor(late));
    for (let n = 1; n < burst; n++) {
      const r = rooms[randInt(this.rng, 0, rooms.length - 1)];
      this.pushPressure(kind, r.cx + 0.5, r.cy + 0.5);
    }

    let bestRoom = rooms[0];
    let bestFar = -1;
    for (let tries = 0; tries < 12; tries++) {
      const r = rooms[randInt(this.rng, 0, rooms.length - 1)];
      const x = r.cx + 0.5;
      const y = r.cy + 0.5;
      const near = Math.min(
        ...this.players.filter((p) => p.present && !p.down).map((p) => Math.hypot(p.x - x, p.y - y)),
        Infinity,
      );
      const seen = this.players.some(
        (p) => p.present && !p.down && Math.hypot(p.x - x, p.y - y) < 9 && this.clearLine(p.x, p.y, x, y),
      );
      if (near > bestFar) {
        bestFar = near;
        bestRoom = r;
      }
      if (seen) continue;
      this.pushPressure(kind, x, y);
      return;
    }
    // EVERY candidate was in somebody's sight. The first version of this simply gave up, and that is
    // exactly how a party of three could farm one floor forever: on a small level with three players
    // spread across it, twelve tries in a row are all visible, so the wave that was meant to end the
    // stalemate never arrived. Twenty percent of three-player runs were still going at fifteen
    // minutes. Now it spawns at the furthest room regardless — being seen arriving is a worse
    // outcome than the mine having no way to close a run.
    this.pushPressure(kind, bestRoom.cx + 0.5, bestRoom.cy + 0.5);
  }

  private pushPressure(kind: EnemyId, x: number, y: number): void {
    const e = this.makeEnemy(kind, x, y);
    e.state = 'alert';
    e.target = this.nearestSeat(e);
    this.enemies.push(e);
  }

  // ── outward-facing helpers ────────────────────────────────────────────────────────────────────

  /**
   * A CLIENT's own body, integrated from its own input. This is the only thing a client predicts —
   * movement and facing, using the identical code the host runs, so agreeing is the default and the
   * reconciliation in session.ts is a rounding correction rather than a fight.
   */
  predictSelf(seat: number, intent: Intent, step: number): void {
    const p = this.players[seat];
    if (!p || !p.present || p.down) return;
    p.ang = intent.ang;
    const cos = Math.cos(p.ang);
    const sin = Math.sin(p.ang);
    const fwd = intent.my >= 0 ? intent.my : intent.my * PLAYER.backScale;
    const str = intent.mx * PLAYER.strafeScale;
    let dx = (cos * fwd - sin * str) * PLAYER.speed * step;
    let dy = (sin * fwd + cos * str) * PLAYER.speed * step;
    const mag = Math.hypot(dx, dy);
    const cap = PLAYER.speed * step;
    if (mag > cap) {
      dx = (dx / mag) * cap;
      dy = (dy / mag) * cap;
    }
    this.slide(p, dx, dy, PLAYER.radius);
  }

  /** A client learning it is on a floor it has not cut yet. The mine is a pure function of a byte. */
  adoptFloor(floor: number): void {
    if (floor === this.floor) return;
    this.floor = floor;
    this.deepest = Math.max(this.deepest, floor);
    this.level = generate(this.seed, floor, this.mode, this.players.length);
    this.populate();
    this.seatOut();
    this.events.push({ k: 'descend', floor });
  }

  /** A body the host has told us about that we do not have. Never a decision, always an instruction. */
  spawnRemote(id: number, kind: EnemyId, x: number, y: number): Enemy {
    const e = this.makeEnemy(kind, x, y);
    e.id = id;
    e.state = 'chase';
    this.enemies.push(e);
    return e;
  }

  drainEvents(): GEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  /** Cycle to the next weapon that has ammo, or just the next one if none do. */
  static nextWeapon(p: Player): WeaponId {
    const i = WEAPON_ORDER.indexOf(p.weapon);
    for (let k = 1; k <= WEAPON_ORDER.length; k++) {
      const w = WEAPON_ORDER[(i + k) % WEAPON_ORDER.length];
      if (p.ammo[w] > 0) return w;
    }
    return WEAPON_ORDER[(i + 1) % WEAPON_ORDER.length];
  }
}
