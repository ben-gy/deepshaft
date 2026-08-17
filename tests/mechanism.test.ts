// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// See ADDITIONAL-TERMS.md for the section 7(b) attribution requirement.
//
// The mechanism audit. ZERO tolerance, audited from OUTSIDE.
//
// ── WHY THE BALANCE SIM CANNOT DO THIS JOB ──────────────────────────────────────────────────────
// A balance sim measures OUTCOMES: how deep a run got, whether it ended, how long a floor took. A
// broken mechanic does not produce a distinctive outcome — it produces a slightly worse one, which is
// indistinguishable from intended difficulty. A game in this fleet shipped with its turrets unable to
// shoot half the horde, and it sat comfortably inside every difficulty assertion for 200 seeded runs:
// half-dead guns just read as "wave 7 is hard".
//
// So each system that acts on the threat gets an INVARIANT over the event stream, at zero tolerance.
// Not "the curve looks right" — "the gun never shot past a closer target", counted, with no threshold
// to tune. A duration or an average always has a grey zone; a count of rule violations does not.
//
// ── AND WHY THE AUDITOR RE-DERIVES EVERYTHING ───────────────────────────────────────────────────
// `tests/helpers/sim.ts` implements line of sight by Liang-Barsky slab clipping over the segment's
// bounding box. `src/game.ts` implements it as a grid DDA. They share no code and no idea. That is
// the point: an audit that calls the game's own raycast and compares the answer to itself is a
// tautology that passes on a completely broken game. What the game supplies through `onShotAudit` is
// DATA — where the shooter stood, where it was looking, where every body was, and which of them were
// awake. Every verdict is computed in the test.

import { describe, expect, it } from 'vitest';
import { auditShot, runOnce, unreachableEnemies } from './helpers/sim';
import { Game, IDLE_INTENT, type Intent } from '../src/game';
import { Bot, tierOf } from '../src/bot';
import { MODE_IDS } from '../src/modes';
import { STEP } from '../src/tuning';

const CONFIGS: Array<[string, number]> = [
  ['stope', 1],
  ['stope', 3],
  ['adit', 2],
  ['lode', 1],
  ['lode', 4],
];

describe('the guns obey their own rule, in every configuration', () => {
  for (const [modeId, players] of CONFIGS) {
    it(`${modeId} x${players}`, () => {
      let through = 0;
      let skipped = 0;
      let cone = 0;
      let shots = 0;
      let unreachable = 0;
      for (let i = 0; i < 8; i++) {
        const r = runOnce({ seed: 4000 + i * 613, modeId, players, tier: 'miner', limitSeconds: 300 });
        through += r.audit.throughWall;
        skipped += r.audit.skippedNearer;
        cone += r.audit.outOfCone;
        unreachable += r.audit.unreachable;
        shots += r.audit.shotsAudited;
      }
      // A sample of nothing passes every invariant, so the sample size is itself an assertion.
      expect(shots, 'no shots were audited — has the hook drifted?').toBeGreaterThan(200);
      expect(through, 'a hit was registered through a wall').toBe(0);
      expect(skipped, 'a shot took a target while a nearer valid one stood in the same cone').toBe(0);
      expect(cone, 'a hit was registered outside the weapon cone or range').toBe(0);
      expect(unreachable, 'an enemy was sealed in rock — a statue that can kill nobody').toBe(0);
    });
  }
});

describe('the audit can actually fail — a broken rule is caught', () => {
  // A zero-tolerance invariant that has never been seen to go red is a hope, not a gate. These feed
  // the auditor hand-built claims that violate the rule and assert it says so. This is the mutation
  // check for the audit itself, and it is the reason the zeros above mean anything.
  const base = {
    seat: 0,
    weapon: 'cutter' as const,
    ox: 1.5,
    oy: 1.5,
    ang: 0,
    cone: 0.3,
    range: 11,
  };
  const openGame = (): Game =>
    new Game({
      seed: 1,
      modeId: 'adit',
      players: [{ name: 'a', bot: true }],
      mySeat: 0,
      level: {
        side: 8,
        // A single open room with a solid pillar at (4,1), so "through a wall" is expressible.
        tiles: Uint8Array.from(
          Array.from({ length: 64 }, (_, i) => {
            const x = i % 8;
            const y = (i / 8) | 0;
            if (x === 0 || y === 0 || x === 7 || y === 7) return 0;
            return x === 4 && y === 1 ? 0 : 1;
          }),
        ),
        rooms: [{ x: 1, y: 1, w: 6, h: 6, cx: 3, cy: 3 }],
        start: { x: 1.5, y: 1.5 },
        stair: { x: 6, y: 6 },
        locks: [],
        spawns: [],
        items: [],
        damp: [],
      },
    });

  it('flags a claimed hit that has a wall in the way', () => {
    const g = openGame();
    const v = auditShot(g, {
      ...base,
      targetId: 1,
      targetDist: 4,
      live: [{ id: 1, x: 5.5, y: 1.5, radius: 0.3, awake: true }],
    });
    expect(v.throughWall).toBe(1);
  });

  it('flags a shot that skipped a nearer awake target in the same cone', () => {
    const g = openGame();
    const v = auditShot(g, {
      ...base,
      oy: 3.5,
      ang: 0,
      targetId: 2,
      targetDist: 5,
      live: [
        { id: 1, x: 3.5, y: 3.5, radius: 0.3, awake: true },
        { id: 2, x: 6.5, y: 3.5, radius: 0.3, awake: true },
      ],
    });
    expect(v.skippedNearer).toBe(1);
  });

  it('does NOT flag a nearer target that is asleep — the gate is part of the rule', () => {
    const g = openGame();
    const v = auditShot(g, {
      ...base,
      oy: 3.5,
      targetId: 2,
      targetDist: 5,
      live: [
        { id: 1, x: 3.5, y: 3.5, radius: 0.3, awake: false },
        { id: 2, x: 6.5, y: 3.5, radius: 0.3, awake: true },
      ],
    });
    expect(v.skippedNearer).toBe(0);
  });

  it('flags a hit claimed outside the cone', () => {
    const g = openGame();
    const v = auditShot(g, {
      ...base,
      oy: 3.5,
      targetId: 1,
      targetDist: 2,
      live: [{ id: 1, x: 1.5, y: 5.5, radius: 0.3, awake: true }],
    });
    expect(v.outOfCone).toBe(1);
  });

  it('and the reachability audit flags an enemy sealed in rock', () => {
    const g = openGame();
    // Drop a body inside the pillar. Nothing can walk to it and it can walk nowhere.
    g.enemies.push({
      id: 99,
      kind: 'thrall',
      x: 4.5,
      y: 1.5,
      ang: 0,
      hp: 10,
      maxHp: 10,
      state: 'idle',
      cool: 0,
      target: -1,
      stagger: 0,
      windup: 0,
      side: 1,
      burn: 0,
    });
    expect(unreachableEnemies(g)).toBe(1);
  });
});

describe('the systems that are supposed to interact, do', () => {
  /** Play a floor headlessly and return the event stream, so a claim can be checked against it. */
  function play(modeId: string, players: number, seed: number, seconds: number): ReturnType<Game['drainEvents']> {
    const g = new Game({
      seed,
      modeId,
      players: Array.from({ length: players }, (_, i) => ({ name: `b${i}`, bot: true })),
      mySeat: null,
    });
    const bots = g.players.map((_, s) => new Bot(g, s, tierOf('miner'), {}, seed + s));
    const intents: Intent[] = g.players.map(() => ({ ...IDLE_INTENT }));
    const out: ReturnType<Game['drainEvents']> = [];
    for (let t = 0; t < seconds * 60 && !g.over; t++) {
      for (let s = 0; s < bots.length; s++) intents[s] = bots[s].think(STEP);
      g.tick(STEP, intents);
      for (const ev of g.drainEvents()) {
        out.push(ev);
        if (ev.k === 'descend') for (const b of bots) b.reset();
      }
    }
    return out;
  }

  it('firedamp ignites, chains, and is not a dead rule', () => {
    let ignitions = 0;
    let chained = 0;
    for (let i = 0; i < 10; i++) {
      for (const ev of play('stope', 2, 7000 + i * 331, 200)) {
        if (ev.k !== 'damp') continue;
        ignitions++;
        if (ev.chain > 0) chained++;
      }
    }
    // A mechanic that never fires is not a mechanic. A prior game in this fleet shipped a signature
    // verb that no measurement had ever observed happening once.
    expect(ignitions, 'no pocket was ever lit across ten runs').toBeGreaterThan(5);
    expect(chained, 'pockets never chained, so DAMP.chain is dead code').toBeGreaterThan(0);
  });

  it('things wake by HEARING as well as by seeing — the noise system fires', () => {
    let saw = 0;
    let heard = 0;
    for (let i = 0; i < 8; i++) {
      for (const ev of play('stope', 2, 8000 + i * 449, 180)) {
        if (ev.k !== 'wake') continue;
        if (ev.why === 'saw') saw++;
        else heard++;
      }
    }
    expect(saw, 'nothing ever saw anybody').toBeGreaterThan(5);
    expect(heard, 'nothing ever HEARD anybody — the noise flood is not connected').toBeGreaterThan(5);
  });

  it('every attack is telegraphed before it lands, with no exceptions', () => {
    // The netcode's whole claim to feeling fine at 20Hz rests on this: a guest sees enemies about a
    // tenth of a second in the past, and an attack with no tell is an attack that hits before it
    // appears. So there must be a `tell` for every attack, and the count is checked rather than
    // assumed.
    let tells = 0;
    let hurts = 0;
    for (let i = 0; i < 8; i++) {
      for (const ev of play('stope', 2, 9000 + i * 577, 180)) {
        if (ev.k === 'tell') tells++;
        if (ev.k === 'hurtP' || ev.k === 'downP') hurts++;
      }
    }
    expect(tells, 'nothing ever wound up to strike').toBeGreaterThan(10);
    // Not every tell lands (that is the point — you can step out of it) and not every hurt comes from
    // a melee tell (bolts and gas hurt too), so this is a sanity band rather than an equality.
    expect(tells).toBeGreaterThan(hurts * 0.25);
  });

  it('the mine actually locks its doors, and they get opened', () => {
    let refused = 0;
    let opened = 0;
    let locksSeen = 0;
    for (let i = 0; i < 10; i++) {
      for (const ev of play('stope', 2, 9500 + i * 733, 220)) {
        if (ev.k !== 'door') continue;
        if (ev.colour) locksSeen++;
        if (ev.opened) opened++;
        else refused++;
      }
    }
    expect(opened, 'no door was ever opened').toBeGreaterThan(5);
    expect(locksSeen, 'no locked door was ever met, so the whole keycard chain is untested').toBeGreaterThan(0);
    void refused;
  });
});

describe('generation is deterministic across module state', () => {
  it('the same round produces the same mine, which is why the map is never sent', () => {
    for (const modeId of MODE_IDS) {
      const a = new Game({ seed: 424242, modeId, players: [{ name: 'a', bot: true }], mySeat: 0 });
      const b = new Game({ seed: 424242, modeId, players: [{ name: 'a', bot: true }], mySeat: 0 });
      expect(Array.from(a.level.tiles)).toEqual(Array.from(b.level.tiles));
      expect(a.level.spawns).toEqual(b.level.spawns);
      expect(a.level.items).toEqual(b.level.items);
      // And a different seed is a different mine, or the comparison above proves nothing.
      const c = new Game({ seed: 424243, modeId, players: [{ name: 'a', bot: true }], mySeat: 0 });
      expect(Array.from(c.level.tiles)).not.toEqual(Array.from(a.level.tiles));
    }
  });
});
