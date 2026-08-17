// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// See ADDITIONAL-TERMS.md for the section 7(b) attribution requirement.
//
// The difficulty curve is the opponent, so it gets simulated rather than argued about.
//
// Deepshaft is a co-op game against a system, so the competitive framing (leader-wins probability,
// seat fairness) does not apply: there are no seats to be unfair to. What replaces it is the SHAPE OF
// A RUN — how deep a competent crew gets, whether a run ENDS, and whether the mechanics that are
// supposed to matter actually do.
//
// Three of the numbers in this file were produced by the sim overruling the design, and each is
// commented at the assertion:
//   · party scaling exists because three players on a flat horde were IMMORTAL — 73% of three-player
//     runs were still going at the seven-minute limit;
//   · the pressure wave GROWS as well as accelerating, because a shrinking gap alone still left 6.7%
//     of runs unfinished at fifteen minutes;
//   · the pressure spawn now fires even when every candidate room is in somebody's sight, because
//     giving up quietly was how three players spread across a small floor farmed it forever.
//
// The negative-GAP arms are the other half. A mechanic is only load-bearing if a bot BLIND to it does
// measurably worse; one that scores the same is decoration, and this fleet has shipped a mechanic
// that never fired at all behind a green suite.

import { describe, expect, it } from 'vitest';
import { mean, median, pct, runOnce, type RunResult } from './helpers/sim';
import { MODE_IDS, modeOf } from '../src/modes';

/** Seeds are fixed, so a change in a number here is a change in the GAME, never in the weather. */
const seeds = (n: number, family = 0): number[] =>
  Array.from({ length: n }, (_, i) => 1000 + family * 7919 + i * 977);

const N = 18;
const LIMIT = 420;

// Memoised on the full argument set. The GAP arms each compare against the same reference sweep, and
// re-running it per arm was thirty wasted seconds of identical work in the default test run.
const cache = new Map<string, RunResult[]>();
function sweep(modeId: string, players: number, opts: Partial<Parameters<typeof runOnce>[0]> = {}, n = N, family = 0): RunResult[] {
  const key = JSON.stringify([modeId, players, opts, n, family]);
  const hit = cache.get(key);
  if (hit) return hit;
  const out = seeds(n, family).map((seed) => runOnce({ seed, modeId, players, tier: 'miner', limitSeconds: LIMIT, ...opts }));
  cache.set(key, out);
  return out;
}

const depths = (rs: RunResult[]): number[] => rs.map((r) => r.deepest);
const rate = (rs: RunResult[], f: (r: RunResult) => boolean): number => rs.filter(f).length / rs.length;

describe('a run ends', () => {
  for (const modeId of MODE_IDS) {
    for (const players of [1, 3]) {
      it(`${modeId} with ${players}: no run is still going at ${LIMIT}s`, () => {
        const rs = sweep(modeId, players);
        const stuck = rate(rs, (r) => r.timedOut);
        // A timeout is not "hard", it is a run with no way to end — the crew has lost the stair and
        // is farming the mine. Principle: if a sim has an escape hatch absorbing something, go and
        // look at the individual run rather than at the average.
        expect(stuck, `${(stuck * 100).toFixed(0)}% of runs never ended`).toBeLessThanOrEqual(0.08);
      });
    }
  }

  it('and it ends because the mine closed, not because nothing happened', () => {
    const rs = sweep('stope', 2);
    expect(mean(rs.map((r) => r.kills))).toBeGreaterThan(8);
    expect(mean(rs.map((r) => r.seconds))).toBeGreaterThan(30);
  });
});

describe('the curve', () => {
  it('Adit is the mode you can actually finish, and Stope is not', () => {
    const adit = sweep('adit', 1);
    const stope = sweep('stope', 1);
    // Adit exists to be beatable — a learning mode nobody ever completes has failed at its one job.
    expect(rate(adit, (r) => r.won), 'Adit is meant to be winnable').toBeGreaterThan(0.05);
    // Stope is endless by construction, so a win is impossible and the score IS the depth.
    expect(modeOf('stope').floors).toBe(0);
    expect(rate(stope, (r) => r.won)).toBe(0);
  });

  it('the opening floor is a breath and the run is over long before floor twenty', () => {
    const rs = sweep('stope', 2, {}, 24);
    const d = depths(rs);
    // Nobody dies on floor one: an opening that kills a competent player is not a difficulty curve.
    expect(pct(d, 0.1), 'the 10th percentile still clears the first floor').toBeGreaterThanOrEqual(1);
    // And the ramp genuinely bites: the geometric HP term past the knee is what guarantees this.
    expect(pct(d, 0.95), 'nobody descends forever').toBeLessThan(20);
    expect(median(d)).toBeGreaterThanOrEqual(2);
  });

  it('a bigger crew goes deeper, but not proportionally — the mine scales with the party', () => {
    const solo = mean(depths(sweep('stope', 1, {}, 24)));
    const three = mean(depths(sweep('stope', 3, {}, 24)));
    // Three players must be worth SOMETHING, or co-op is a tax...
    expect(three).toBeGreaterThan(solo * 0.9);
    // ...and must not be worth everything, or the horde is not scaling and the party is immortal.
    // Measured before `partyScale` existed: 73% of three-player runs never ended at all.
    expect(three).toBeLessThan(solo * 2.4);
  });

  it('holds across three independent seed families', () => {
    // One family agreeing with itself is not a finding. Different families, same shape.
    const ms = [0, 1, 2].map((f) => median(depths(sweep('stope', 2, {}, 20, f))));
    for (const m of ms) expect(m).toBeGreaterThanOrEqual(2);
    expect(Math.max(...ms) - Math.min(...ms), `families disagreed: ${ms.join(', ')}`).toBeLessThanOrEqual(3);
  });
});

describe('the mechanics are load-bearing — a bot blind to one does WORSE', () => {
  // The negative GAP. Each arm removes exactly one behaviour from the bot and nothing else, so a
  // difference is attributable. An arm that measures FLAT is a mechanic that is not doing anything,
  // and the right response to that is to cut the mechanic, not to widen the tolerance.
  const base = () => mean(depths(sweep('stope', 2, {}, 24)));

  it('a bot that never backs off dies shallower', () => {
    const full = base();
    const blind = mean(depths(sweep('stope', 2, { blind: { retreat: true } }, 24)));
    expect(blind, `retreat GAP: full ${full.toFixed(2)} vs blind ${blind.toFixed(2)}`).toBeLessThan(full);
  });

  it('a bot that only ever holds the Cutter dies shallower', () => {
    // This is the assertion that says three weapons are three answers rather than three skins. If it
    // ever goes flat, the Lance and the Charge are not earning their place in the HUD.
    const full = base();
    const blind = mean(depths(sweep('stope', 2, { blind: { weapons: true } }, 24)));
    expect(blind, `weapon GAP: full ${full.toFixed(2)} vs blind ${blind.toFixed(2)}`).toBeLessThan(full);
  });

  it('a crew that never picks each other up dies shallower', () => {
    const full = mean(depths(sweep('stope', 3, {}, 24)));
    const blind = mean(depths(sweep('stope', 3, { blind: { revive: true } }, 24)));
    expect(blind, `revive GAP: full ${full.toFixed(2)} vs blind ${blind.toFixed(2)}`).toBeLessThan(full);
  });
});

describe('the feel, alongside the curve', () => {
  // A fix that satisfies the numbers while flattening the joy out of the core verb is a failed run,
  // so the thing the game is ABOUT gets measured next to the thing the game is scored on.
  it('firedamp actually goes off, and kills things when it does', () => {
    const rs = sweep('stope', 2, {}, 24);
    const dampShare = rs.reduce((s, r) => s + r.dampKills, 0) / Math.max(1, rs.reduce((s, r) => s + r.kills, 0));
    expect(dampShare, 'the gas is decoration if nothing ever dies in it').toBeGreaterThan(0.005);
    // And it must not become the ONLY way anything dies, which would mean the guns are pointless.
    expect(dampShare).toBeLessThan(0.5);
  });

  it('a floor is a few minutes at most, not a wander', () => {
    const rs = sweep('stope', 2, {}, 24);
    const perFloor = rs.flatMap((r) => r.floorSeconds);
    expect(mean(perFloor), 'a floor that takes forever is a floor nobody can find the cage on').toBeLessThan(110);
    expect(median(perFloor)).toBeGreaterThan(5);
  });

  it('players go down and come back, rather than never being in danger', () => {
    const rs = sweep('stope', 3, {}, 24);
    expect(mean(rs.map((r) => r.downs)), 'nobody is ever in trouble').toBeGreaterThan(0.5);
    expect(mean(rs.map((r) => r.revives)), 'and nobody is ever saved').toBeGreaterThan(0.05);
  });
});
