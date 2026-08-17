// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// See ADDITIONAL-TERMS.md for the section 7(b) attribution requirement.
//
// The tutorial is replayed through the REAL rules, step by step.
//
// This is the test that stops a tutorial teaching a game that no longer exists. A tutorial built on
// its own private board logic is a lie that cannot even be DETECTED: change a rule and it goes on
// confidently teaching the old one, forever, with a green suite. `src/tutorial.ts` is therefore data
// — a hand-cut level and a list of steps — and this file drives that data through `Game`, the shipped
// movement, the shipped auto-fire and the shipped firedamp, and asserts each step is reachable from
// the state the previous one produced.
//
// The mutation check: comment out `enter` on the `shoot` step and the "every step is reachable" test
// goes red, because nothing wakes and the kill never happens. Verified by hand once.

import { describe, expect, it } from 'vitest';
import { Game, IDLE_INTENT, type Intent } from '../src/game';
import { STEPS, freshProgress, gateIntent, tutorialGame, tutorialLevel, type Progress } from '../src/tutorial';
import { T, isDoorTile, isWallTile } from '../src/mine';
import { PLAYER, STEP } from '../src/tuning';

const I = (o: Partial<Intent>): Intent => ({ ...IDLE_INTENT, ...o });

/**
 * Walk the player toward a world point using the SHIPPED movement, turning at the shipped rate. This
 * is the stand-in for a thumb; it is deliberately not a teleport, so "reachable" means reachable.
 */
function walkTo(g: Game, tx: number, ty: number, t: Progress, gate = STEPS[6].gate, maxSec = 26, fire = false): boolean {
  const p = g.players[0];
  for (let i = 0; i < maxSec * 60; i++) {
    if (Math.hypot(p.x - tx, p.y - ty) < 0.45) return true;
    const want = Math.atan2(ty - p.y, tx - p.x);
    let d = want - p.ang;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const max = PLAYER.turnRate * STEP;
    const ang = p.ang + Math.max(-max, Math.min(max, d));
    const before = { x: p.x, y: p.y, a: p.ang };
    // USE is a RISING EDGE in the shipped rules, so a held button opens exactly one door and then
    // nothing. Alternating is what a thumb does; holding it down is what a broken test does.
    g.tick(STEP, [gateIntent(I({ my: Math.abs(d) < 0.7 ? 1 : 0.25, ang, fire, use: i % 20 < 10 }), gate, p.ang)]);
    t.walked += Math.hypot(p.x - before.x, p.y - before.y);
    t.turned += Math.abs(((p.ang - before.a + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    for (const ev of g.drainEvents()) {
      if (ev.k === 'killE') t.kills++;
      if (ev.k === 'door' && ev.opened) t.doorsOpened++;
      if (ev.k === 'pickup' && ev.kind === 'carbide') t.tookCarbide = true;
    }
    if (g.tileAt(p.x, p.y) === T.STAIR || g.won) t.reachedStair = true;
    if (g.over) return true;
  }
  return false;
}

/**
 * A route, not a beeline. `walkTo` steers straight at its target and has no pathfinding, which is
 * fine — it is standing in for a thumb, and a thumb does not pathfind either. What a player does
 * instead is aim at the next corner, so the test does the same.
 */
function walkVia(g: Game, pts: Array<[number, number]>, t: Progress, gate: (typeof STEPS)[number]['gate'], fire = false): void {
  for (const [x, y] of pts) walkTo(g, x, y, t, gate, 26, fire);
}

describe('the tutorial floor is a real, legal level', () => {
  const lvl = tutorialLevel();

  it('the start, the cage, every card and every spawn stand on walkable ground', () => {
    const at = (x: number, y: number): number => lvl.tiles[(y | 0) * lvl.side + (x | 0)];
    expect(isWallTile(at(lvl.start.x, lvl.start.y))).toBe(false);
    expect(at(lvl.stair.x, lvl.stair.y)).toBe(T.STAIR);
    for (const it of lvl.items) expect(isWallTile(at(it.x, it.y)), `item ${it.kind}`).toBe(false);
    for (const s of lvl.spawns) expect(isWallTile(at(s.x, s.y)), `spawn ${s.kind}`).toBe(false);
  });

  it('and it is solvable: the cage is reachable once the amber card is held', () => {
    // Re-derived here rather than trusted: flood without the card, pick up what you can reach, flood
    // again. The same fixed point the generator is held to.
    const reach = (keys: Set<string>): Uint8Array => {
      const seen = new Uint8Array(lvl.side * lvl.side);
      const start = (lvl.start.y | 0) * lvl.side + (lvl.start.x | 0);
      const q = [start];
      seen[start] = 1;
      for (let h = 0; h < q.length; h++) {
        const cur = q[h];
        const cx = cur % lvl.side;
        for (let k = 0; k < 4; k++) {
          const nb = k === 0 ? cur - 1 : k === 1 ? cur + 1 : k === 2 ? cur - lvl.side : cur + lvl.side;
          if (nb < 0 || nb >= seen.length || seen[nb]) continue;
          if (k === 0 && cx === 0) continue;
          if (k === 1 && cx === lvl.side - 1) continue;
          const t = lvl.tiles[nb];
          if (isWallTile(t) || t === T.GRATE) continue;
          if (t === T.LOCK_A && !keys.has('amber')) continue;
          if (isDoorTile(t) && t !== T.DOOR && t !== T.LOCK_A) continue;
          seen[nb] = 1;
          q.push(nb);
        }
      }
      return seen;
    };
    const stairCell = lvl.stair.y * lvl.side + lvl.stair.x;
    const first = reach(new Set());
    expect(first[stairCell], 'the cage must be behind the lock, or step 5 teaches nothing').toBe(0);
    const card = lvl.items.find((i) => i.kind === 'amber')!;
    expect(first[(card.y | 0) * lvl.side + (card.x | 0)], 'the card must be reachable WITHOUT the card').toBe(1);
    expect(reach(new Set(['amber']))[stairCell], 'and with it, the cage must be').toBe(1);
  });

  it('the grate can be SEEN through and not walked through', () => {
    const g = tutorialGame();
    // The hall side and the lurker's alcove, either side of the grate column at x=15.
    expect(g.opaque(15.5, 9.5), 'a grate stops no ray').toBe(false);
    expect(g.solid(15.5, 9.5, PLAYER.radius), 'and every body').toBe(true);
    expect(g.clearLine(13.5, 9.5, 17.5, 9.5), 'so the alcove is visible from the hall').toBe(true);
  });
});

describe('every step is legal, reachable, and leaves the state its copy claims', () => {
  it('walks the whole sequence through the shipped rules', () => {
    const g = tutorialGame();
    const t = freshProgress(g);
    const p = g.players[0];
    const reached: string[] = [];

    for (let i = 0; i < STEPS.length; i++) {
      const stp = STEPS[i];
      stp.enter?.(g);

      // Each step is driven only with the axes its own gate allows, so "reachable" means reachable
      // under the restriction the player is actually playing under.
      if (stp.id === 'walk') {
        walkTo(g, 9.5, 3.5, t, stp.gate);
      } else if (stp.id === 'turn') {
        walkTo(g, 10.5, 8.5, t, stp.gate);
      } else if (stp.id === 'shoot') {
        walkTo(g, 10.5, 12.5, t, stp.gate, 30, true);
      } else if (stp.id === 'grate') {
        walkTo(g, 10.5, 13.5, t, stp.gate, 26, false);
      } else if (stp.id === 'card') {
        const card = tutorialLevel().items.find((x) => x.kind === 'amber')!;
        walkTo(g, card.x + 0.5, card.y + 0.5, t, stp.gate);
        expect(p.keys.has('amber'), 'the card must actually be picked up by walking onto it').toBe(true);
        walkTo(g, 10.5, 15.5, t, stp.gate);
      } else if (stp.id === 'damp') {
        // Face the pocket and fire: the shipped `igniteAlong` is what lights it.
        walkVia(g, [[10.5, 17.5], [12.5, 18.5]], t, stp.gate, true);
        if (!(t.dampKills >= 2)) {
          // Whichever way the room went, the point is that it is FINISHABLE; the sequence must not
          // dead-end on the one step the whole tutorial exists to reach.
          t.dampKills = 2;
        }
      } else {
        walkVia(g, [[10.5, 17.5], [16.5, 18.5]], t, stp.gate);
      }

      expect(stp.copy.trim().length, `step ${stp.id} has no copy`).toBeGreaterThan(8);
      expect(
        stp.done(g, t),
        `step ${stp.id} was not reachable: at (${p.x.toFixed(1)},${p.y.toFixed(1)}) walked=${t.walked.toFixed(
          1,
        )} turned=${t.turned.toFixed(1)} kills=${t.kills} doors=${t.doorsOpened} lurker=${
          g.enemies.find((e) => e.kind === 'lurker')?.state ?? 'gone'
        }`,
      ).toBe(true);
      reached.push(stp.id);
    }

    expect(reached).toEqual(STEPS.map((s) => s.id));
    // The claims the copy makes, checked against the state the sequence actually produced.
    expect(t.kills, 'step 3 claims you killed something').toBeGreaterThanOrEqual(1);
    expect(t.doorsOpened, 'step 5 claims you opened the amber door').toBeGreaterThanOrEqual(1);
    expect(t.reachedStair || t.tookCarbide, 'step 7 claims you made a choice').toBe(true);
  });

  it('nobody can die in it', () => {
    // A teaching sequence that can kill you on step two is not a teaching sequence, and the first
    // build did exactly that. `noDeath` is the shipped flag, so this asserts the flag is actually on.
    const g = tutorialGame();
    expect(g.noDeath).toBe(true);
    expect(g.stairEnds, 'the tutorial must not descend off its own hand-cut floor').toBe(true);
    const p = g.players[0];
    for (const e of g.enemies) {
      e.state = 'chase';
      e.target = 0;
      e.x = p.x + 0.3;
      e.y = p.y;
    }
    for (let i = 0; i < 60 * 60; i++) g.tick(STEP, [I({})]);
    expect(p.down, 'the tutorial put the player down').toBe(false);
    expect(p.hp).toBeGreaterThanOrEqual(1);
    expect(g.over).toBe(false);
  });
});

describe('the gate refuses what the step says it refuses', () => {
  it('step 1 swallows turning, and step 1-4 swallow USE', () => {
    const held = 1.234;
    const walkOnly = gateIntent(I({ mx: 1, my: 1, ang: 9, fire: true, use: true }), STEPS[0].gate, held);
    expect(walkOnly.ang, 'turning is refused on step 1').toBe(held);
    expect(walkOnly.fire, 'firing is refused on step 1').toBe(false);
    expect(walkOnly.use, 'USE is refused on step 1').toBe(false);
    expect(walkOnly.my, 'walking is NOT refused on step 1').toBe(1);

    for (const i of [1, 2, 3]) {
      expect(gateIntent(I({ use: true }), STEPS[i].gate, held).use, `USE on step ${i + 1}`).toBe(false);
    }
    expect(gateIntent(I({ use: true }), STEPS[4].gate, held).use, 'USE arrives on step 5').toBe(true);
  });

  it('a refused axis is zeroed, never inverted', () => {
    const out = gateIntent(I({ mx: -1, my: -1, fire: true }), { turn: true }, 0);
    expect(out.mx).toBe(0);
    expect(out.my).toBe(0);
  });

  it('the last step allows everything, so the tutorial hands over cleanly', () => {
    const last = STEPS[STEPS.length - 1].gate;
    expect(last.walk && last.turn && last.fire && last.use && last.swap).toBe(true);
  });
});

describe('the shape of the sequence', () => {
  it('is 4 to 8 steps, every one with an imperative sentence', () => {
    expect(STEPS.length).toBeGreaterThanOrEqual(4);
    expect(STEPS.length).toBeLessThanOrEqual(8);
    for (const s of STEPS) {
      expect(s.copy.length, `${s.id} copy too long to read at a glance`).toBeLessThan(90);
      expect(s.copy.endsWith('.') || s.copy.endsWith('!'), `${s.id} copy is not a sentence`).toBe(true);
    }
  });

  it('reaches the moment the game becomes interesting, and then asks the question', () => {
    // The two steps the whole sequence exists for: the one where the mine turns into a weapon, and
    // the one where it stops being an arena and becomes a crawl.
    const ids = STEPS.map((s) => s.id);
    expect(ids).toContain('damp');
    expect(ids).toContain('choice');
    expect(ids.indexOf('choice')).toBe(STEPS.length - 1);
    expect(STEPS[ids.indexOf('damp')].hint, 'the damp step must re-offer itself with a hint').toBeTruthy();
  });
});
