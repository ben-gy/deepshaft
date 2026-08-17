// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// See ADDITIONAL-TERMS.md for the section 7(b) attribution requirement.
//
// The simulation's rules, driven through the REAL `Game` with hand-built intents.
//
// Everything here runs on a hand-cut `cfg.level` — the same door the tutorial uses — because the
// interesting rules in this game are all GEOMETRY rules, and a generated floor cannot put a hauler,
// a sump and a grate exactly where an assertion needs them. A generated floor is used only where the
// rule under test is about the run rather than the room (descent, determinism).
//
// Two conventions worth knowing before reading:
//  · `tick()` steps every PLAYER before it steps any enemy, so a shot fired on tick 1 sees enemies at
//    exactly their spawn coordinates. Every targeting test below exploits that instead of trying to
//    hit a moving body.
//  · enemy `state` and player `x`/`y`/`hp`/`ammo` are public fields, and several tests set them
//    directly. That is deliberate: placing a body at a known distance is the experiment, and letting
//    it walk there first would measure the pathing rather than the rule under test.

import { describe, expect, it } from 'vitest';
import { Game, IDLE_INTENT, type GEvent, type Intent, type ShotAudit } from '../src/game';
import { SUMP_RADIUS, T, type Level, type Room } from '../src/mine';
import { MODES } from '../src/modes';
import { DAMP, ENEMIES, PLAYER, STEP, WEAPONS, WEAPON_ORDER } from '../src/tuning';
import type { LockColour } from '../src/palette';

// ── the bench ───────────────────────────────────────────────────────────────────────────────────

const CH: Record<string, number> = {
  '#': T.SOLID,
  '.': T.OPEN,
  D: T.DOOR,
  A: T.LOCK_A,
  C: T.LOCK_C,
  R: T.LOCK_R,
  S: T.STAIR,
  '~': T.SUMP,
  '=': T.GRATE,
  '*': T.DAMP,
};

interface ArenaOpts {
  start?: { x: number; y: number };
  stair?: { x: number; y: number };
  spawns?: Level['spawns'];
  items?: Level['items'];
  locks?: LockColour[];
}

/** An ASCII floor. The grid is square and padded with rock, exactly like a generated one. */
function arena(rows: string[], o: ArenaOpts = {}): Level {
  const side = Math.max(rows.length, ...rows.map((r) => r.length));
  const tiles = new Uint8Array(side * side).fill(T.SOLID);
  const damp: number[] = [];
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < rows[y].length; x++) {
      const t = CH[rows[y][x]];
      if (t === undefined) throw new Error(`unknown map glyph ${rows[y][x]}`);
      tiles[y * side + x] = t;
      if (t === T.DAMP) damp.push(y * side + x);
    }
  }
  // One nominal room covering the map: only the pressure spawner reads `rooms`, and nothing here
  // runs long enough to reach RAMP.pressureAfter.
  const room: Room = { x: 1, y: 1, w: side - 2, h: side - 2, cx: side >> 1, cy: side >> 1 };
  return {
    side,
    tiles,
    rooms: [room],
    start: o.start ?? { x: 1.5, y: 1.5 },
    stair: o.stair ?? { x: 1, y: 1 },
    locks: o.locks ?? [],
    spawns: o.spawns ?? [],
    items: o.items ?? [],
    damp,
  };
}

const I = (o: Partial<Intent> = {}): Intent => ({ ...IDLE_INTENT, ...o });

interface GameOpts {
  seed?: number;
  modeId?: string;
  players?: number;
  floor?: number;
}

function game(level: Level | null, o: GameOpts = {}): Game {
  return new Game({
    seed: o.seed ?? 7,
    modeId: o.modeId ?? 'stope',
    players: Array.from({ length: o.players ?? 1 }, (_, i) => ({ name: `p${i}`, bot: false })),
    mySeat: 0,
    floor: o.floor,
    ...(level ? { level } : {}),
  });
}

/** Run n ticks with one intent per seat, collecting every event. */
function run(g: Game, n: number, intent: (t: number, seat: number) => Intent = () => I()): GEvent[] {
  const out: GEvent[] = [];
  for (let t = 0; t < n; t++) {
    g.tick(
      STEP,
      g.players.map((_, s) => intent(t, s)),
    );
    out.push(...g.drainEvents());
  }
  return out;
}

/** The one shot audit a single-tick experiment produces. */
function fireOnce(g: Game, ang: number, weapon: Intent['weapon'] = 'cutter'): ShotAudit | null {
  let audit: ShotAudit | null = null;
  g.onShotAudit = (a) => {
    audit = a;
  };
  g.tick(STEP, [I({ fire: true, ang, weapon })]);
  g.onShotAudit = null;
  return audit;
}

/** A cell the flow field could not reach. game.ts keeps this private; it is 0xffff on the wire. */
const UNREACHED = 0xffff;

const HALL = [
  '############',
  '#..........#',
  '#..........#',
  '#..........#',
  '#..........#',
  '############',
];

// ── movement ────────────────────────────────────────────────────────────────────────────────────

describe('movement', () => {
  it('a player walks forward at the tuned speed', () => {
    const g = game(arena(HALL, { start: { x: 1.5, y: 2.5 } }));
    run(g, 30, () => I({ my: 1, ang: 0 }));
    const p = g.players[0];
    expect(p.x - 1.5).toBeCloseTo(PLAYER.speed * 30 * STEP, 5);
    expect(p.y).toBeCloseTo(2.5, 9);
    expect(p.stats.steps).toBeCloseTo(PLAYER.speed * 30 * STEP, 5);
  });

  it('strafing and walking backwards are slower than walking forward', () => {
    const dist = (o: Partial<Intent>): number => {
      const g = game(arena(HALL, { start: { x: 5.5, y: 2.5 } }));
      const before = { x: g.players[0].x, y: g.players[0].y };
      run(g, 20, () => I({ ang: 0, ...o }));
      return Math.hypot(g.players[0].x - before.x, g.players[0].y - before.y);
    };
    const fwd = dist({ my: 1 });
    expect(dist({ mx: 1 })).toBeCloseTo(fwd * PLAYER.strafeScale, 5);
    expect(dist({ my: -1 })).toBeCloseTo(fwd * PLAYER.backScale, 5);
  });

  it('a wall stops a player without letting them into the rock', () => {
    const g = game(arena(HALL, { start: { x: 1.5, y: 2.5 } }));
    run(g, 400, () => I({ my: 1, ang: 0 }));
    const p = g.players[0];
    // The hall's rock starts at column 11; a body of PLAYER.radius must stop short of it.
    expect(p.x).toBeLessThanOrEqual(11 - PLAYER.radius);
    expect(p.x).toBeGreaterThan(11 - PLAYER.radius - PLAYER.speed * STEP);
    // It stopped exactly where it did because one more step would have put its rim in the rock.
    expect(g.solid(p.x + PLAYER.radius + PLAYER.speed * STEP, p.y, PLAYER.radius)).toBe(true);
  });

  it('a player slides along a wall instead of sticking to it', () => {
    // Walking up and to the right into the ceiling: the vertical component is refused, the horizontal
    // one is not, because `slide` resolves one axis at a time.
    const g = game(arena(HALL, { start: { x: 1.5, y: 1.5 } }));
    run(g, 100, () => I({ my: 1, ang: -0.6 }));
    const p = g.players[0];
    expect(p.y).toBeGreaterThan(1 + PLAYER.radius - 0.02);
    expect(p.y).toBeLessThan(1 + PLAYER.radius + 0.02);
    expect(p.x).toBeGreaterThan(4.5);
  });

  it('a sump slows a player to the tuned drag', () => {
    const dry = game(arena(['##########', '#........#', '##########'], { start: { x: 1.5, y: 1.5 } }));
    const wet = game(arena(['##########', '#~~~~~~~~#', '##########'], { start: { x: 1.5, y: 1.5 } }));
    run(dry, 30, () => I({ my: 1, ang: 0 }));
    run(wet, 30, () => I({ my: 1, ang: 0 }));
    const dryD = dry.players[0].x - 1.5;
    const wetD = wet.players[0].x - 1.5;
    expect(wetD).toBeLessThan(dryD);
    expect(wetD / dryD).toBeCloseTo(0.45, 3);
  });
});

// ── the sump / grate asymmetry ──────────────────────────────────────────────────────────────────

describe('sump and grate: two tables disagreeing', () => {
  const WATER = ['##########', '#..~~~...#', '##########'];

  it('a sump stops a hauler-sized body and passes a thrall-sized one', () => {
    const g = game(arena(WATER, { start: { x: 8.5, y: 1.5 } }));
    expect(ENEMIES.hauler.radius).toBeGreaterThanOrEqual(SUMP_RADIUS);
    expect(ENEMIES.thrall.radius).toBeLessThan(SUMP_RADIUS);
    expect(g.solid(3.5, 1.5, ENEMIES.hauler.radius)).toBe(true);
    expect(g.solid(3.5, 1.5, ENEMIES.thrall.radius)).toBe(false);
    expect(g.solid(3.5, 1.5, PLAYER.radius)).toBe(false);
    // And it is water, not rock: a ray goes straight over it.
    expect(g.opaque(3.5, 1.5)).toBe(false);
  });

  it('a mixed pack splits itself around water', () => {
    const g = game(
      arena(WATER, {
        start: { x: 8.5, y: 1.5 },
        spawns: [
          { kind: 'hauler', x: 1.5, y: 1.5 },
          { kind: 'thrall', x: 2.5, y: 1.5 },
        ],
      }),
    );
    const [hauler, thrall] = g.enemies;
    run(g, 600);
    // The hauler is still on the dry side of the flood; the light thing came straight through it.
    expect(hauler.x).toBeLessThan(3 - ENEMIES.hauler.radius + 1e-9);
    expect(thrall.x).toBeGreaterThan(6);
  });

  const SCREEN = [
    '#########',
    '#...=...#',
    '#.#####.#',
    '#.......#',
    '#########',
  ];

  it('a grate blocks every body and no ray', () => {
    const g = game(arena(SCREEN, { start: { x: 1.5, y: 1.5 } }));
    expect(g.solid(4.5, 1.5, PLAYER.radius)).toBe(true);
    expect(g.solid(4.5, 1.5, ENEMIES.thrall.radius)).toBe(true);
    expect(g.solid(4.5, 1.5, ENEMIES.hauler.radius)).toBe(true);
    expect(g.opaque(4.5, 1.5)).toBe(false);
    expect(g.clearLine(1.5, 1.5, 7.5, 1.5)).toBe(true);
  });

  it('a hitscan shot through a grate registers a hit', () => {
    const g = game(arena(SCREEN, { start: { x: 1.5, y: 1.5 }, spawns: [{ kind: 'thrall', x: 7.5, y: 1.5 }] }));
    const e = g.enemies[0];
    e.state = 'alert';
    e.target = 0;
    const hp0 = e.hp;
    const audit = fireOnce(g, 0);
    expect(audit?.targetId).toBe(e.id);
    expect(e.hp).toBe(hp0 - WEAPONS.cutter.damage);
    const shot = g.drainEvents().find((ev) => ev.k === 'shot');
    expect(shot && shot.k === 'shot' && shot.hit).toBe(true);
  });

  it('the flow field routes around a grate the shot went through', () => {
    const g = game(arena(SCREEN, { start: { x: 1.5, y: 1.5 } }));
    // The grate cell itself is off the field entirely...
    expect(g.fieldAt(0, 4.5, 1.5)).toBe(UNREACHED);
    // ...and the cell three steps down the corridor is ten steps away round the loop, not six.
    expect(g.fieldAt(0, 7.5, 1.5)).toBe(10);
    expect(g.fieldAt(0, 3.5, 1.5)).toBe(2);
  });

  it('an enemy behind a grate comes the long way round', () => {
    const g = game(arena(SCREEN, { start: { x: 1.5, y: 1.5 }, spawns: [{ kind: 'thrall', x: 7.5, y: 1.5 }] }));
    const e = g.enemies[0];
    const path: Array<{ x: number; y: number }> = [];
    for (let t = 0; t < 400; t++) {
      g.tick(STEP, [I()]);
      path.push({ x: e.x, y: e.y });
    }
    // It never stood in the grate, and it did go down into the lower gallery to get around.
    expect(path.some((p) => (p.x | 0) === 4 && (p.y | 0) === 1)).toBe(false);
    expect(path.some((p) => (p.y | 0) === 3)).toBe(true);
    expect(Math.hypot(e.x - g.players[0].x, e.y - g.players[0].y)).toBeLessThan(ENEMIES.thrall.reach + 0.2);
  });
});

// ── auto-fire ───────────────────────────────────────────────────────────────────────────────────

describe('auto-fire', () => {
  it('picks the nearest awake enemy in the cone', () => {
    const g = game(
      arena(HALL, {
        start: { x: 1.5, y: 2.5 },
        spawns: [
          { kind: 'thrall', x: 5.5, y: 2.5 },
          { kind: 'thrall', x: 8.5, y: 2.5 },
        ],
      }),
    );
    const [near, far] = g.enemies;
    for (const e of g.enemies) {
      e.state = 'alert';
      e.target = 0;
    }
    const audit = fireOnce(g, 0);
    expect(audit?.targetId).toBe(near.id);
    expect(audit?.targetId).not.toBe(far.id);
    expect(audit?.targetDist).toBeCloseTo(4, 6);
  });

  it('refuses a target outside the cone', () => {
    const g = game(arena(HALL, { start: { x: 1.5, y: 1.5 }, spawns: [{ kind: 'thrall', x: 3.5, y: 4.5 }] }));
    const e = g.enemies[0];
    e.state = 'alert';
    e.target = 0;
    // Bearing is ~0.98 rad off the barrel; the cutter's cone is 0.30.
    const bearing = Math.atan2(4.5 - 1.5, 3.5 - 1.5);
    expect(bearing).toBeGreaterThan(WEAPONS.cutter.cone);
    const hp0 = e.hp;
    const audit = fireOnce(g, 0);
    expect(audit?.targetId).toBe(-1);
    expect(e.hp).toBe(hp0);
  });

  it('refuses a target with no line of sight', () => {
    const g = game(
      arena(['##########', '#..#.....#', '##########'], {
        start: { x: 1.5, y: 1.5 },
        spawns: [{ kind: 'thrall', x: 6.5, y: 1.5 }],
      }),
    );
    const e = g.enemies[0];
    e.state = 'alert';
    e.target = 0;
    const hp0 = e.hp;
    expect(g.clearLine(1.5, 1.5, 6.5, 1.5)).toBe(false);
    const audit = fireOnce(g, 0);
    expect(audit?.targetId).toBe(-1);
    expect(e.hp).toBe(hp0);
  });

  it('refuses a target beyond the weapon range', () => {
    // The lance reaches 18 cells; the cutter's 11 does not span this hall's diagonal run.
    const g = game(
      arena(
        Array.from({ length: 20 }, (_, y) => (y === 0 || y === 19 ? '#'.repeat(20) : `#${'.'.repeat(18)}#`)),
        { start: { x: 1.5, y: 1.5 }, spawns: [{ kind: 'thrall', x: 15.5, y: 1.5 }] },
      ),
    );
    const e = g.enemies[0];
    e.state = 'alert';
    e.target = 0;
    expect(fireOnce(g, 0, 'cutter')?.targetId).toBe(-1);
    g.players[0].cool = 0;
    expect(fireOnce(g, 0, 'lance')?.targetId).toBe(e.id);
  });

  it('never AIMS at a sleeping enemy — the consent gate', () => {
    const g = game(arena(HALL, { start: { x: 1.5, y: 2.5 }, spawns: [{ kind: 'thrall', x: 4.5, y: 2.5 }] }));
    expect(g.enemies[0].state).toBe('idle');
    const audit = fireOnce(g, 0);
    expect(audit?.live[0].awake).toBe(false);
    expect(audit?.targetId).toBe(-1);
  });

  it('auto-aim never SWINGS onto a sleeper, but a shot you aimed yourself still lands', () => {
    // The adjudicated rule, and the reason both halves are asserted together. The gun refuses to
    // ACQUIRE anything still idle — that is the consent gate, and it is what makes walking quietly
    // past a sleeping room possible at all. It does not make a sleeper bulletproof: a round fired
    // straight down your own facing goes where you pointed it, wakes what it hits, and that is the
    // deliberate opening shot. "Facing IS aiming" would be a lie if looking straight at something and
    // pulling the trigger did nothing.
    const g = game(arena(HALL, { start: { x: 1.5, y: 2.5 }, spawns: [{ kind: 'thrall', x: 4.5, y: 2.5 }] }));
    const e = g.enemies[0];
    const hp0 = e.hp;

    // Off to one side: nothing acquired and nothing HIT — but the bang still wakes it, which is the
    // noise system doing its job rather than the gate failing. Firing is always a decision to be
    // heard, and asserting "still idle" here would have pinned the wrong rule.
    const aside = game(arena(HALL, { start: { x: 1.5, y: 2.5 }, spawns: [{ kind: 'thrall', x: 4.5, y: 2.5 }] }));
    fireOnce(aside, Math.PI);
    expect(aside.enemies[0].hp, 'a shot pointing the other way cannot hurt it').toBe(aside.enemies[0].maxHp);
    const woke = aside.drainEvents().find((ev) => ev.k === 'wake');
    expect(woke && woke.k === 'wake' && woke.why, 'but it heard the shot').toBe('heard');

    // Straight at it: the auto-aim reports no target, and the round lands anyway. (fireOnce installs
    // and then clears the audit hook itself, so the verdict comes back as its return value.)
    const audit = fireOnce(g, 0);
    expect(audit?.targetId, 'the gun must not acquire a sleeper').toBe(-1);
    expect(e.hp, 'but a round aimed by hand still lands').toBeLessThan(hp0);
    expect(e.state, 'and being shot is a fine way to be woken').not.toBe('idle');
  });

  it('a shot with nothing in the cone is a genuine miss', () => {
    const g = game(arena(HALL, { start: { x: 1.5, y: 2.5 } }));
    fireOnce(g, 0);
    const shot = g.drainEvents().find((ev) => ev.k === 'shot');
    expect(shot && shot.k === 'shot' && shot.hit).toBe(false);
    expect(shot && shot.k === 'shot' && shot.targetId).toBe(-1);
  });

  it('the lance pierces and the cutter does not', () => {
    const line = (weapon: Intent['weapon']): number => {
      const g = game(
        arena(HALL, {
          start: { x: 1.5, y: 2.5 },
          spawns: [
            { kind: 'thrall', x: 5.5, y: 2.5 },
            { kind: 'thrall', x: 7.5, y: 2.5 },
            { kind: 'thrall', x: 9.5, y: 2.5 },
          ],
        }),
      );
      for (const e of g.enemies) {
        e.state = 'alert';
        e.target = 0;
      }
      // Hold the references: a lance one-shots a thrall, and a dead enemy is filtered off
      // `g.enemies` at the end of the tick it died on.
      const es = [...g.enemies];
      const before = es.map((e) => e.hp);
      fireOnce(g, 0, weapon);
      return es.filter((e, i) => e.hp < before[i]).length;
    };
    expect(line('cutter')).toBe(WEAPONS.cutter.pierce);
    expect(line('lance')).toBe(WEAPONS.lance.pierce);
  });
});

// ── telegraphed attacks ─────────────────────────────────────────────────────────────────────────

describe('telegraphed attacks', () => {
  const reachArena = (): Level =>
    arena(HALL, { start: { x: 5.5, y: 2.5 }, spawns: [{ kind: 'thrall', x: 6.2, y: 2.5 }] });

  it('an enemy in reach winds up and tells before it swings', () => {
    const g = game(reachArena());
    const e = g.enemies[0];
    e.state = 'alert';
    e.target = 0;
    const evs = run(g, 1);
    expect(e.state).toBe('attack');
    expect(e.windup).toBeCloseTo(ENEMIES.thrall.windup, 6);
    const tell = evs.find((ev) => ev.k === 'tell');
    expect(tell && tell.k === 'tell' && tell.kind).toBe('thrall');
    expect(g.players[0].hp).toBe(PLAYER.hp);
  });

  it('the damage lands windup seconds later, not on the tell', () => {
    const g = game(reachArena());
    const e = g.enemies[0];
    e.state = 'alert';
    e.target = 0;
    let landedAt = -1;
    for (let t = 0; t < 120 && landedAt < 0; t++) {
      g.tick(STEP, [I()]);
      if (g.drainEvents().some((ev) => ev.k === 'hurtP')) landedAt = (t + 1) * STEP;
    }
    expect(landedAt).toBeGreaterThan(0);
    // The tell is set on tick 1 and burns down from there, so the landing sits within one tick of it.
    expect(landedAt).toBeGreaterThanOrEqual(ENEMIES.thrall.windup);
    expect(landedAt).toBeLessThanOrEqual(ENEMIES.thrall.windup + 2 * STEP);
    expect(g.players[0].hp).toBe(PLAYER.hp - ENEMIES.thrall.damage);
  });

  it('stepping out of reach beats a committed swing', () => {
    const g = game(reachArena());
    const e = g.enemies[0];
    e.state = 'alert';
    e.target = 0;
    // Walk backwards down the hall while the tell burns down. The enemy is frozen mid-windup, so this
    // is a race the player wins by moving — which is the whole reason the tell is long.
    const evs = run(g, Math.ceil(ENEMIES.thrall.windup / STEP) + 2, () => I({ my: 1, ang: Math.PI }));
    expect(evs.some((ev) => ev.k === 'tell')).toBe(true);
    expect(evs.some((ev) => ev.k === 'hurtP')).toBe(false);
    expect(g.players[0].hp).toBe(PLAYER.hp);
    expect(Math.hypot(e.x - g.players[0].x, e.y - g.players[0].y)).toBeGreaterThan(ENEMIES.thrall.reach + 0.2);
  });

  it('standing still does not beat it', () => {
    const g = game(reachArena());
    const e = g.enemies[0];
    e.state = 'alert';
    e.target = 0;
    const evs = run(g, Math.ceil(ENEMIES.thrall.windup / STEP) + 2);
    expect(evs.some((ev) => ev.k === 'hurtP')).toBe(true);
  });

  it('a shooter tells before its bolt leaves', () => {
    const g = game(HALL_LURKER());
    const e = g.enemies[0];
    e.state = 'alert';
    e.target = 0;
    const evs = run(g, 1);
    expect(evs.some((ev) => ev.k === 'tell')).toBe(true);
    expect(g.bolts.length).toBe(0);
    run(g, Math.ceil(ENEMIES.lurker.windup / STEP) + 1);
    expect(g.bolts.length).toBeGreaterThan(0);
  });
});

const HALL_LURKER = (): Level =>
  arena(HALL, { start: { x: 1.5, y: 2.5 }, spawns: [{ kind: 'lurker', x: 8.5, y: 2.5 }] });

// ── firedamp ────────────────────────────────────────────────────────────────────────────────────

describe('firedamp', () => {
  it('a shot into a pocket sets it off', () => {
    const g = game(arena(['##########', '#...*....#', '##########'], { start: { x: 1.5, y: 1.5 } }));
    fireOnce(g, 0);
    const evs = g.drainEvents();
    const damp = evs.find((ev) => ev.k === 'damp');
    expect(damp && damp.k === 'damp' && damp.x).toBe(4);
    expect(damp && damp.k === 'damp' && damp.chain).toBe(0);
    expect(g.level.tiles[1 * g.level.side + 4]).toBe(T.OPEN);
    // `stepFires` runs later in the same tick as the shot, so one step is already off the clock.
    expect(g.fires.get(1 * g.level.side + 4)).toBeCloseTo(DAMP.burn - STEP, 6);
  });

  it('a kill on a pocket sets THAT pocket off', () => {
    // Two pockets, four cells apart. `igniteAlong` stops at the FIRST pocket on the ray, so an
    // ignition at the far one can only have come from the body falling into it — and four cells is
    // outside DAMP.chain, so it is not a chain either.
    const g = game(
      arena(['############', '#..*...*...#', '############'], {
        start: { x: 1.5, y: 1.5 },
        spawns: [{ kind: 'thrall', x: 7.5, y: 1.5 }],
      }),
    );
    const e = g.enemies[0];
    e.state = 'alert';
    e.target = 0;
    e.hp = 1;
    expect(DAMP.chain).toBeLessThan(4);
    fireOnce(g, 0);
    const evs = g.drainEvents();
    expect(evs.some((ev) => ev.k === 'killE')).toBe(true);
    const lit = evs.filter((ev) => ev.k === 'damp').map((ev) => (ev.k === 'damp' ? ev.x : -1));
    expect(lit).toContain(7);
    expect(lit).toContain(3);
  });

  it('an ignition damages enemies with distance falloff', () => {
    const g = game(
      arena(HALL, {
        start: { x: 1.5, y: 1.5 },
        spawns: [
          { kind: 'hauler', x: 5.5, y: 2.2 },
          { kind: 'hauler', x: 5.5, y: 3.9 },
        ],
      }),
    );
    // A pocket at (5,1); the near hauler is ~0.7 cells from its centre, the far one ~2.4.
    g.level.tiles[1 * g.level.side + 5] = T.DAMP;
    g.level.damp.push(1 * g.level.side + 5);
    const [near, far] = g.enemies;
    const hp0 = [near.hp, far.hp];
    fireOnce(g, 0);
    expect(hp0[0] - near.hp).toBeGreaterThan(0);
    expect(hp0[0] - near.hp).toBeGreaterThan(hp0[1] - far.hp);
    // Re-derived from the tuning rather than read back off the game.
    const expected = (e: { x: number; y: number }): number =>
      DAMP.damage * (1 - Math.hypot(e.x - 5.5, e.y - 1.5) / DAMP.radius);
    expect(hp0[0] - near.hp).toBeCloseTo(expected(near), 4);
  });

  it('an ignition hurts the player too, iframes and all', () => {
    const g = game(arena(HALL, { start: { x: 5.5, y: 2.7 } }));
    const cell = 1 * g.level.side + 5;
    g.level.tiles[cell] = T.DAMP;
    g.level.damp.push(cell);
    const p = g.players[0];
    p.iframe = PLAYER.iframes;
    fireOnce(g, -Math.PI / 2);
    const d = Math.hypot(p.x - 5.5, p.y - 1.5);
    expect(d).toBeLessThan(DAMP.radius);
    expect(PLAYER.hp - p.hp).toBeCloseTo(DAMP.damage * (1 - d / DAMP.radius), 4);
  });

  it('a pocket lit inside DAMP.chain of another takes it with it', () => {
    const g = game(arena(['##############', '#..*.*......*#', '##############'], { start: { x: 1.5, y: 1.5 } }));
    expect(DAMP.chain).toBeGreaterThanOrEqual(2);
    expect(DAMP.chain).toBeLessThan(7);
    fireOnce(g, 0);
    const lit = g
      .drainEvents()
      .filter((ev) => ev.k === 'damp')
      .map((ev) => (ev.k === 'damp' ? { x: ev.x, chain: ev.chain } : null));
    expect(lit.map((l) => l?.x)).toEqual([3, 5]);
    expect(lit[0]?.chain).toBe(0);
    expect(lit[1]?.chain).toBe(1);
    // The pocket at 12 is nine cells away and stays cold.
    expect(g.level.tiles[1 * g.level.side + 12]).toBe(T.DAMP);
  });

  it('a lit cell burns for DAMP.burn seconds and cooks whatever stands in it', () => {
    const g = game(arena(['##########', '#...*....#', '##########'], { start: { x: 1.5, y: 1.5 } }));
    fireOnce(g, 0);
    const cell = 1 * g.level.side + 4;
    expect(g.fires.has(cell)).toBe(true);
    const p = g.players[0];
    p.x = 4.5;
    p.y = 1.5;
    const hpIn = p.hp;
    run(g, 30);
    const burned = hpIn - p.hp;
    expect(burned).toBeCloseTo(DAMP.burnDps * 30 * STEP, 4);
    expect(p.stats.damp).toBeCloseTo(burned, 4);
    // The flame is out on schedule, and nothing burns after it.
    run(g, Math.ceil(DAMP.burn / STEP));
    expect(g.fires.size).toBe(0);
    const hpCold = p.hp;
    run(g, 30);
    expect(p.hp).toBe(hpCold);
  });
});

// ── doors and keys ──────────────────────────────────────────────────────────────────────────────

describe('doors and keys', () => {
  it('a plain door opens for anyone who walks up to it', () => {
    const g = game(arena(['##########', '#.D......#', '##########'], { start: { x: 1.5, y: 1.5 } }));
    const cell = 1 * g.level.side + 2;
    expect(g.solid(2.5, 1.5, PLAYER.radius)).toBe(true);
    run(g, 1);
    expect(g.doors[cell]).toBeGreaterThan(0);
    run(g, 60);
    expect(g.doors[cell]).toBe(1);
    expect(g.solid(2.5, 1.5, PLAYER.radius)).toBe(false);
    expect(g.opaque(2.5, 1.5)).toBe(false);
  });

  it('a locked door refuses a player with no card', () => {
    const g = game(arena(['##########', '#.A......#', '##########'], { start: { x: 1.5, y: 1.5 } }));
    const cell = 1 * g.level.side + 2;
    const evs = run(g, 4, (t) => I({ ang: 0, use: t >= 1 }));
    const door = evs.find((ev) => ev.k === 'door');
    expect(door && door.k === 'door' && door.opened).toBe(false);
    expect(door && door.k === 'door' && door.colour).toBe('amber');
    expect(g.doors[cell]).toBe(0);
    expect(g.solid(2.5, 1.5, PLAYER.radius)).toBe(true);
    expect(g.players[0].stats.doors).toBe(0);
  });

  it('the card opens it, and the card comes off the floor', () => {
    const g = game(
      arena(['##########', '#.A......#', '##########'], {
        start: { x: 1.5, y: 1.5 },
        locks: ['amber'],
        items: [{ kind: 'amber', x: 1, y: 1 }],
      }),
    );
    const cell = 1 * g.level.side + 2;
    const evs = run(g, 4, (t) => I({ ang: 0, use: t >= 1 }));
    expect(evs.some((ev) => ev.k === 'pickup' && ev.kind === 'amber')).toBe(true);
    expect(g.players[0].keys.has('amber')).toBe(true);
    const door = evs.find((ev) => ev.k === 'door');
    expect(door && door.k === 'door' && door.opened).toBe(true);
    expect(g.doors[cell]).toBeGreaterThan(0);
    expect(g.players[0].stats.doors).toBe(1);
  });

  it('an enemy can never open a locked door, and the field will not route through one', () => {
    const g = game(
      arena(['##########', '#...A....#', '##########'], {
        start: { x: 1.5, y: 1.5 },
        spawns: [{ kind: 'thrall', x: 7.5, y: 1.5 }],
      }),
    );
    const cell = 1 * g.level.side + 4;
    const e = g.enemies[0];
    e.state = 'alert';
    e.target = 0;
    expect(g.fieldAt(0, 7.5, 1.5)).toBe(UNREACHED);
    run(g, 600);
    expect(g.doors[cell]).toBe(0);
    // It ground against the far face of the door and never got through it.
    expect(e.x).toBeGreaterThan(4 + ENEMIES.thrall.radius - 1e-9);
    expect(g.players[0].hp).toBe(PLAYER.hp);
  });

  it('an unlocked door does not stop the field, but a shut one stops a ray', () => {
    const g = game(arena(['##########', '#...D....#', '##########'], { start: { x: 1.5, y: 1.5 } }));
    expect(g.opaque(4.5, 1.5)).toBe(true);
    expect(g.fieldAt(0, 7.5, 1.5)).toBe(6);
  });
});

// ── down, revive, and the end of a run ──────────────────────────────────────────────────────────

describe('down, revive and the end of a run', () => {
  /** Put a seat on the floor through the real damage path, not by assignment. */
  function downSeat(g: Game, seat: number): void {
    const p = g.players[seat];
    p.x = 5.5;
    p.y = 2.5;
    const cell = (p.y | 0) * g.level.side + (p.x | 0);
    g.level.tiles[cell] = T.DAMP;
    g.level.damp.push(cell);
    p.hp = 1;
    g.tick(
      STEP,
      g.players.map((_, s) => I(s === seat ? { fire: true, ang: 0 } : {})),
    );
  }

  it('a player at 0 HP goes DOWN, not dead', () => {
    const g = game(arena(HALL, { start: { x: 5.5, y: 2.5 } }), { players: 2 });
    const p = g.players[0];
    downSeat(g, 0);
    expect(p.down).toBe(true);
    expect(p.hp).toBe(0);
    expect(p.bleed).toBeCloseTo(PLAYER.bleedOut, 6);
    expect(p.stats.downs).toBe(1);
    expect(g.players).toHaveLength(2);
    expect(g.drainEvents().some((ev) => ev.k === 'downP')).toBe(true);
    expect(g.over).toBe(false);
  });

  it('a downed player bleeds out on the tuned clock', () => {
    const g = game(arena(HALL, { start: { x: 5.5, y: 2.5 } }), { players: 2 });
    downSeat(g, 0);
    // Seat 1 must not stand close enough to revive by accident.
    g.players[1].x = 9.5;
    g.players[1].y = 4.5;
    const start = g.players[0].bleed;
    run(g, 300);
    expect(start - g.players[0].bleed).toBeCloseTo(300 * STEP, 4);
    expect(g.players[0].down).toBe(true);
  });

  it('a mate standing over you for reviveTime brings you back at reviveHp', () => {
    const g = game(arena(HALL, { start: { x: 5.5, y: 2.5 } }), { players: 2 });
    downSeat(g, 0);
    g.players[1].x = g.players[0].x + PLAYER.reviveRange * 0.8;
    g.players[1].y = g.players[0].y;
    let at = -1;
    for (let t = 0; t < 400 && at < 0; t++) {
      g.tick(STEP, [I(), I()]);
      if (g.drainEvents().some((ev) => ev.k === 'reviveP')) at = (t + 1) * STEP;
    }
    expect(at).toBeGreaterThanOrEqual(PLAYER.reviveTime);
    expect(at).toBeLessThanOrEqual(PLAYER.reviveTime + 2 * STEP);
    expect(g.players[0].down).toBe(false);
    expect(g.players[0].hp).toBe(PLAYER.reviveHp);
    expect(g.players[1].stats.revives).toBe(1);
  });

  it('a mate standing just out of range never revives you', () => {
    const g = game(arena(HALL, { start: { x: 5.5, y: 2.5 } }), { players: 2 });
    downSeat(g, 0);
    g.players[1].x = g.players[0].x + PLAYER.reviveRange + 0.05;
    g.players[1].y = g.players[0].y;
    // Seat 1 spawned on top of seat 0 and banked one step of progress on the tick that downed them.
    g.players[0].reviving = 0;
    run(g, 400);
    expect(g.players[0].down).toBe(true);
    expect(g.players[0].reviving).toBe(0);
  });

  it('the run ends only when every present player is down', () => {
    const g = game(arena(HALL, { start: { x: 5.5, y: 2.5 } }), { players: 2 });
    downSeat(g, 0);
    g.players[1].x = 9.5;
    g.players[1].y = 4.5;
    expect(g.over).toBe(false);
    run(g, 5);
    expect(g.over).toBe(false);
    downSeat(g, 1);
    expect(g.over).toBe(true);
    expect(g.won).toBe(false);
  });

  it('a player who left neither holds the run open nor ends it', () => {
    const g = game(arena(HALL, { start: { x: 5.5, y: 2.5 } }), { players: 2 });
    // Seat 1 walks out of the room. Seat 0 is still standing, so the run is not over...
    g.players[1].present = false;
    run(g, 30);
    expect(g.over).toBe(false);
    // ...and when seat 0 goes down, the absent seat does not keep the run alive.
    downSeat(g, 0);
    expect(g.over).toBe(true);
  });

  it('an absent player is not a body on the floor', () => {
    const g = game(arena(HALL, { start: { x: 5.5, y: 2.5 }, spawns: [{ kind: 'thrall', x: 6.2, y: 2.5 }] }), {
      players: 2,
    });
    g.players[1].present = false;
    g.players[1].x = 6.2;
    g.players[1].y = 2.5;
    const e = g.enemies[0];
    e.state = 'alert';
    run(g, 120);
    expect(g.players[1].hp).toBe(PLAYER.hp);
    expect(e.target).toBe(0);
  });
});

// ── descent ─────────────────────────────────────────────────────────────────────────────────────

describe('descent', () => {
  it('the cage takes you down, keeps your ammo and drops your keys', () => {
    const g = game(arena(['##########', '#.S......#', '##########'], { start: { x: 1.5, y: 1.5 }, stair: { x: 2, y: 1 } }));
    const p = g.players[0];
    p.hp = 50;
    p.ammo.cutter = 7;
    p.ammo.lance = 3;
    p.keys.add('amber');
    p.x = 2.5;
    const evs = run(g, 1);
    expect(evs.some((ev) => ev.k === 'descend' && ev.floor === 2)).toBe(true);
    expect(g.floor).toBe(2);
    expect(g.deepest).toBe(2);
    expect(p.keys.size).toBe(0);
    expect(p.ammo.cutter).toBe(7);
    expect(p.ammo.lance).toBe(3);
    expect(p.hp).toBe(Math.min(PLAYER.hp, 50 + MODES.stope.healOnDescend));
    expect(g.over).toBe(false);
  });

  it('the heal on descent never overshoots full health', () => {
    const g = game(arena(['##########', '#.S......#', '##########'], { start: { x: 1.5, y: 1.5 } }));
    const p = g.players[0];
    p.hp = PLAYER.hp - 1;
    p.x = 2.5;
    run(g, 1);
    expect(p.hp).toBe(PLAYER.hp);
  });

  it('a downed player is picked up by the cage, at no less than reviveHp', () => {
    const g = game(arena(['##########', '#.S......#', '##########'], { start: { x: 1.5, y: 1.5 } }), { players: 2 });
    const down = g.players[1];
    down.down = true;
    down.hp = 0;
    down.bleed = 3;
    g.players[0].x = 2.5;
    g.players[0].y = 1.5;
    run(g, 1);
    expect(g.floor).toBe(2);
    expect(down.down).toBe(false);
    expect(down.hp).toBeGreaterThanOrEqual(PLAYER.reviveHp);
  });

  it('the stair on the last floor of a finite mode is a WIN, not a descent', () => {
    const g = game(arena(['##########', '#.S......#', '##########'], { start: { x: 1.5, y: 1.5 } }), {
      modeId: 'adit',
      floor: MODES.adit.floors,
    });
    g.players[0].x = 2.5;
    const evs = run(g, 1);
    expect(evs.some((ev) => ev.k === 'over' && ev.win === true)).toBe(true);
    expect(evs.some((ev) => ev.k === 'descend')).toBe(false);
    expect(g.over).toBe(true);
    expect(g.won).toBe(true);
    expect(g.floor).toBe(MODES.adit.floors);
  });

  it('an endless mode has no last floor', () => {
    const g = game(arena(['##########', '#.S......#', '##########'], { start: { x: 1.5, y: 1.5 } }), {
      modeId: 'stope',
      floor: 40,
    });
    g.players[0].x = 2.5;
    run(g, 1);
    expect(g.over).toBe(false);
    expect(g.floor).toBe(41);
  });
});

// ── ammo ────────────────────────────────────────────────────────────────────────────────────────

describe('ammo', () => {
  it('firing decrements the pool the shot came out of', () => {
    const g = game(arena(HALL, { start: { x: 1.5, y: 2.5 } }));
    const p = g.players[0];
    fireOnce(g, 0, 'lance');
    expect(p.ammo.lance).toBe(WEAPONS.lance.start - 1);
    expect(p.ammo.cutter).toBe(WEAPONS.cutter.start);
    expect(p.ammo.charge).toBe(WEAPONS.charge.start);
    expect(p.stats.shots).toBe(1);
    expect(p.cool).toBeCloseTo(WEAPONS.lance.interval, 6);
  });

  it('the interval is a real rate limit', () => {
    const g = game(arena(HALL, { start: { x: 1.5, y: 2.5 } }));
    const p = g.players[0];
    const evs = run(g, 60, () => I({ fire: true, ang: 0 }));
    const shots = evs.filter((ev) => ev.k === 'shot').length;
    // One second of held trigger. The cooldown burns down a whole step at a time, so the real gap is
    // ceil(interval / STEP) ticks — seven, not 6.6 — and that is what the rate must be measured
    // against rather than against the raw interval.
    const gapTicks = Math.ceil(WEAPONS.cutter.interval / STEP);
    expect(shots).toBe(Math.ceil(60 / gapTicks));
    expect(p.ammo.cutter).toBe(WEAPONS.cutter.start - shots);
  });

  it('an empty pool clicks, costs a beat, and fires nothing', () => {
    const g = game(arena(HALL, { start: { x: 1.5, y: 2.5 } }));
    const p = g.players[0];
    p.ammo.charge = 0;
    const evs = run(g, 1, () => I({ fire: true, ang: 0, weapon: 'charge' }));
    expect(evs.some((ev) => ev.k === 'dry')).toBe(true);
    expect(evs.some((ev) => ev.k === 'shot')).toBe(false);
    expect(g.bolts).toHaveLength(0);
    expect(p.cool).toBeCloseTo(0.28, 6);
    expect(p.stats.shots).toBe(0);
    // The click is not a machine gun: the next tick is still on cooldown.
    const again = run(g, 1, () => I({ fire: true, ang: 0, weapon: 'charge' }));
    expect(again.some((ev) => ev.k === 'dry')).toBe(false);
  });

  it('a charge leaves a travelling bolt rather than a hitscan', () => {
    const g = game(arena(HALL, { start: { x: 1.5, y: 2.5 } }));
    fireOnce(g, 0, 'charge');
    expect(g.bolts).toHaveLength(1);
    expect(g.bolts[0].seat).toBe(0);
    expect(g.bolts[0].splash).toBe(WEAPONS.charge.splash);
    expect(g.players[0].ammo.charge).toBe(WEAPONS.charge.start - 1);
  });

  it('nextWeapon skips an empty pool', () => {
    const g = game(arena(HALL, { start: { x: 1.5, y: 2.5 } }));
    const p = g.players[0];
    p.weapon = 'cutter';
    p.ammo.lance = 0;
    expect(Game.nextWeapon(p)).toBe('charge');
    p.ammo.charge = 0;
    expect(Game.nextWeapon(p)).toBe('cutter');
  });

  it('nextWeapon still advances when every pool is empty', () => {
    const g = game(arena(HALL, { start: { x: 1.5, y: 2.5 } }));
    const p = g.players[0];
    p.weapon = 'cutter';
    p.ammo.cutter = 0;
    p.ammo.lance = 0;
    p.ammo.charge = 0;
    expect(Game.nextWeapon(p)).toBe(WEAPON_ORDER[1]);
  });

  it('an ammo pile off the floor tops the pool up and is taken once', () => {
    const g = game(
      arena(HALL, { start: { x: 1.5, y: 2.5 }, items: [{ kind: 'ammoLance', x: 1, y: 2 }] }),
    );
    const p = g.players[0];
    p.ammo.lance = 0;
    const evs = run(g, 3);
    expect(evs.filter((ev) => ev.k === 'pickup')).toHaveLength(1);
    expect(p.ammo.lance).toBe(9);
    expect(g.items[0].taken).toBe(true);
  });
});

// ── determinism of the sim ──────────────────────────────────────────────────────────────────────

describe('determinism', () => {
  it('two games on the same seed fed the same intents end in the same state', () => {
    // The intent stream is scripted from an LCG rather than from the bot, so the test is about the
    // SIM being deterministic and not about the bot being deterministic.
    const script = (t: number, seat: number): Intent => {
      let s = (t * 2654435761 + seat * 40503 + 12345) >>> 0;
      const nx = (): number => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
      };
      return I({
        mx: nx() * 2 - 1,
        my: nx() * 2 - 1,
        ang: nx() * Math.PI * 2,
        fire: nx() < 0.4,
        use: nx() < 0.08,
        weapon: WEAPON_ORDER[(nx() * 3) | 0],
      });
    };
    const digest = (g: Game): string => {
      const parts: string[] = [`f${g.floor}/${g.deepest}/${g.over ? 1 : 0}/${g.won ? 1 : 0}/${g.runTime.toFixed(6)}`];
      for (const p of g.players) {
        parts.push(
          `p${p.seat}:${p.x.toFixed(9)},${p.y.toFixed(9)},${p.hp.toFixed(9)},${p.down ? 1 : 0},` +
            `${p.ammo.cutter}/${p.ammo.lance}/${p.ammo.charge},${[...p.keys].sort().join('+')},${p.stats.kills}`,
        );
      }
      // Enemy ids come from a module-global counter and legitimately differ between two Games; the
      // BODIES must not.
      for (const e of g.enemies) parts.push(`e${e.kind}:${e.x.toFixed(9)},${e.y.toFixed(9)},${e.hp.toFixed(6)},${e.state}`);
      for (const b of g.bolts) parts.push(`b:${b.x.toFixed(9)},${b.y.toFixed(9)}`);
      return parts.join('|');
    };

    const a = game(null, { seed: 20260817, modeId: 'stope', players: 3 });
    const b = game(null, { seed: 20260817, modeId: 'stope', players: 3 });
    for (let t = 0; t < 600; t++) {
      const intents = [0, 1, 2].map((s) => script(t, s));
      a.tick(STEP, intents);
      b.tick(STEP, intents);
      a.drainEvents();
      b.drainEvents();
    }
    expect(a.enemies.length).toBeGreaterThan(0);
    expect(digest(a)).toBe(digest(b));
  });

  it('a different seed diverges', () => {
    const a = game(null, { seed: 1, modeId: 'stope', players: 2 });
    const b = game(null, { seed: 2, modeId: 'stope', players: 2 });
    expect(Array.from(a.level.tiles).join()).not.toBe(Array.from(b.level.tiles).join());
  });
});

// ── FINDINGS ────────────────────────────────────────────────────────────────────────────────────
// ADJUDICATED, and the test above now pins the answer. `Game.acquire` refuses an `idle` enemy;
// `Game.rayHits` does not. That is not an inconsistency, it is the rule: the gate stops the gun
// swinging onto a sleeper, and a round you pointed at one yourself still lands. Keeping the second
// half is what makes "facing IS aiming" true rather than a slogan, and it gives the player a
// deliberate opening shot rather than an invulnerable statue. The tutorial's copy was corrected to
// match ("it only shoots what is awake" was true; "you cannot hit it" would not have been).
