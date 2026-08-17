// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// See ADDITIONAL-TERMS.md for the section 7(b) attribution requirement.
//
// The simulation's cost, at the worst case the game can actually reach.
//
// ── WHAT THIS IS, AND WHAT IT IS NOT ────────────────────────────────────────────────────────────
// This is a REGRESSION GUARD, not a device measurement. Node on a laptop is not a phone, and no
// number produced here can honestly be called "60fps on mobile" — the device number comes from the
// browser pass, where `requestAnimationFrame` deltas are sampled on the real render path, and it is
// reported in the build log beside this one.
//
// What it CAN do is catch the thing that actually goes wrong: somebody adds a per-enemy A* or a
// per-frame allocation, the per-step cost quietly goes up by an order of magnitude, and nobody
// notices until a phone drops to fifteen frames a second. So the budget below is deliberately loose
// in absolute terms and tight in RELATIVE terms — a 10x regression fails it, a 20% one does not.
//
// The design decision this protects is in game.ts: pathing is ONE flow field per living player every
// six ticks, and every enemy then steps downhill on it. That is O(cells) per 100ms regardless of how
// many things are chasing you, which is the only version of this that survives forty bodies.

import { describe, expect, it } from 'vitest';
import { Game, FIELD_EVERY, IDLE_INTENT, type Intent } from '../src/game';
import { generate } from '../src/mine';
import { modeOf } from '../src/modes';
import { RAMP, STEP } from '../src/tuning';

/** The most crowded floor the ramp can produce: the population cap, at the largest level. */
function worstCase(): Game {
  const mode = modeOf('stope');
  const g = new Game({
    seed: 90210,
    modeId: 'stope',
    players: Array.from({ length: 4 }, (_, i) => ({ name: `p${i}`, bot: true })),
    mySeat: 0,
    floor: 14,
  });
  // Wake everything. An idle enemy is a cheap enemy; the budget has to be measured against the tick
  // where every single body is chasing, shooting and pathing at once.
  for (const e of g.enemies) {
    e.state = 'chase';
    e.target = 0;
  }
  void generate;
  void mode;
  return g;
}

describe('the simulation holds its budget at the worst case the ramp can reach', () => {
  it('reports the per-step cost with every body awake', () => {
    const g = worstCase();
    const intents: Intent[] = g.players.map(() => ({ ...IDLE_INTENT, my: 1, fire: true }));
    expect(g.enemies.length, 'the worst case has to actually be crowded').toBeGreaterThan(20);

    // Warm up, so the first tick's JIT cost is not the measurement.
    for (let i = 0; i < 120; i++) g.tick(STEP, intents);

    const N = 1800;
    const samples: number[] = [];
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      g.tick(STEP, intents);
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const med = samples[N >> 1];
    const p95 = samples[Math.floor(N * 0.95)];
    // eslint-disable-next-line no-console
    console.log(
      `sim: ${g.enemies.length} awake on a ${g.level.side}x${g.level.side} floor — median ${med.toFixed(
        3,
      )}ms/step, p95 ${p95.toFixed(3)}ms (budget 16.7ms/frame at 60Hz)`,
    );

    // One tenth of a frame on a laptop leaves room for a phone being several times slower AND for the
    // raycaster, which is the other half of the frame and is measured in the browser.
    expect(med, 'the median step must be a small fraction of a frame').toBeLessThan(1.6);
    expect(p95, 'and the tail must not spike').toBeLessThan(6);
  });

  it('the flow field is rebuilt on a fixed cadence, not per enemy', () => {
    // The structural claim behind the number above. If this ever becomes 1, pathing cost goes up
    // sixfold and the assertion above will notice — but the intent deserves its own line.
    expect(FIELD_EVERY).toBeGreaterThanOrEqual(4);
    expect(FIELD_EVERY).toBeLessThanOrEqual(10);
  });

  it('cost scales with the FLOOR, not with the number of enemies squared', () => {
    // The check that would catch a per-enemy A* or an O(n^2) collision pass. Twice the bodies must
    // cost meaningfully less than four times the time.
    const time = (count: number): number => {
      const g = worstCase();
      g.enemies = g.enemies.slice(0, count);
      for (const e of g.enemies) e.state = 'chase';
      const intents: Intent[] = g.players.map(() => ({ ...IDLE_INTENT, my: 1, fire: true }));
      for (let i = 0; i < 60; i++) g.tick(STEP, intents);
      const t0 = performance.now();
      for (let i = 0; i < 900; i++) g.tick(STEP, intents);
      return performance.now() - t0;
    };
    const few = time(10);
    const many = time(20);
    // eslint-disable-next-line no-console
    console.log(`sim scaling: 10 bodies ${few.toFixed(1)}ms, 20 bodies ${many.toFixed(1)}ms over 900 steps`);
    expect(many, 'doubling the horde must not quadruple the cost').toBeLessThan(few * 3.2 + 12);
  });

  it('the population is capped, so the worst case is bounded at all', () => {
    // A budget for an unbounded quantity is not a budget.
    expect(RAMP.popCap).toBeLessThanOrEqual(64);
  });
});
