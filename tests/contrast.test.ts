// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// See ADDITIONAL-TERMS.md for the section 7(b) attribution requirement.
//
// Can you actually SEE it?
//
// "Screenshot it and look" cannot answer that question, and a dark mine is the worst place to try.
// A shape drawn in the right cell, at the right size, in the same colour as the wall behind it, is
// invisible — and on a deliberately moody palette that reads as ATMOSPHERE rather than as a bug. A
// game in this fleet shipped its walls at 1.14:1 and the screenshots looked great.
//
// So every colour that carries meaning is held to >=3:1 against every surface it can be drawn on
// (WCAG 2.1 §1.4.11, the floor for a non-text graphic). Pure arithmetic, no canvas, instant.
//
// The raycaster adds a trap the ratio alone does not catch, and this file is where it is nailed shut:
// FOG. Contrast is (L1+0.05)/(L2+0.05), so multiplying BOTH a sprite and the wall behind it by the
// same distance factor drives their ratio toward 1:1. Fog a monster on the same curve as the wall and
// the far end of a corridor becomes a place where monsters are drawn correctly and cannot be seen.
// `spriteFog()` is therefore pinned at a constant 1 by a test, not by a comment.

import { describe, expect, it } from 'vitest';
import {
  BOLT_ENEMY,
  BOLT_MINE,
  CEIL_NEAR,
  DOOR,
  ENEMY,
  FLOOR_NEAR,
  FOG_FLOOR,
  LOCK,
  MEANINGFUL,
  PICKUP,
  SEAT,
  SPRITE_RIM,
  STAIR,
  SURFACES,
  WALLS,
  contrast,
  luminance,
  shade,
  spriteFog,
  wallFog,
} from '../src/palette';

/** WCAG 2.1 §1.4.11: the floor for a graphic that carries meaning. */
const FLOOR = 3;

describe('every meaningful colour clears 3:1 against every surface it can sit on', () => {
  for (const [markName, mark] of Object.entries(MEANINGFUL)) {
    for (const [surfName, surf] of Object.entries(SURFACES)) {
      it(`${markName} on ${surfName}`, () => {
        const r = contrast(mark, surf);
        expect(r, `${markName} (${mark}) on ${surfName} (${surf}) is ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(FLOOR);
      });
    }
  }

  it('enumerates every colour the renderer can draw, so the sweep is not a subset', () => {
    // A contrast test that quietly checks four of eleven colours is worse than none: it is a green
    // light nobody earned. These counts go red if a colour is added to the palette and not to the
    // sweep, which is the only way this file stays honest.
    for (const k of Object.keys(ENEMY)) expect(MEANINGFUL).toHaveProperty(k);
    for (const k of Object.keys(PICKUP)) expect(MEANINGFUL).toHaveProperty(k);
    for (const k of Object.keys(LOCK)) expect(Object.values(MEANINGFUL)).toContain(LOCK[k as keyof typeof LOCK]);
    expect(Object.values(MEANINGFUL)).toContain(DOOR);
    expect(Object.values(MEANINGFUL)).toContain(STAIR);
    expect(Object.values(MEANINGFUL)).toContain(BOLT_ENEMY);
    expect(Object.values(MEANINGFUL)).toContain(BOLT_MINE);
    for (const s of SEAT) expect(Object.values(MEANINGFUL)).toContain(s);
    for (const k of Object.keys(WALLS)) expect(SURFACES).toHaveProperty(k);
    expect(SURFACES.floorNear).toBe(FLOOR_NEAR);
    expect(SURFACES.ceilNear).toBe(CEIL_NEAR);
    expect(Object.keys(MEANINGFUL).length).toBeGreaterThanOrEqual(14);
  });
});

describe('the fog trap', () => {
  it('SPRITES ARE NEVER FOGGED — spriteFog is a constant 1 at every distance', () => {
    // This is the assertion the whole file exists for. If someone "polishes" distance shading onto
    // sprites, every monster at the far end of a gallery quietly becomes the wall, and no screenshot
    // and no unit test anywhere else in this repo would notice.
    for (const d of [0, 0.5, 1, 3, 7, 13, 25, 100, 1e6]) {
      expect(spriteFog(d), `spriteFog(${d}) must be 1`).toBe(1);
    }
  });

  it('and here is why: fogging both sides destroys the ratio', () => {
    // A demonstration rather than a requirement — it shows the number the rule above prevents.
    const monster = ENEMY.thrall;
    const wall = WALLS.seamface;
    expect(contrast(monster, wall)).toBeGreaterThanOrEqual(FLOOR);
    const k = wallFog(13);
    const bothFogged = contrast(shade(monster, k), shade(wall, k));
    expect(bothFogged, 'fogging both sides collapses a legible pair').toBeLessThan(FLOOR);
  });

  it('walls only ever get DARKER with distance, so the near end is the worst case', () => {
    let prev = wallFog(0);
    for (let d = 0; d <= 30; d += 0.5) {
      const cur = wallFog(d);
      expect(cur).toBeLessThanOrEqual(prev + 1e-9);
      prev = cur;
    }
    expect(wallFog(0)).toBe(1);
    expect(wallFog(1000)).toBe(FOG_FLOOR);
    // Never zero: a black wall has no shape, and a corridor of black is not atmosphere, it is a
    // missing frame.
    expect(FOG_FLOOR).toBeGreaterThan(0.2);
  });

  it('a fogged wall never OVERTAKES a mark, at any distance', () => {
    // The sweep above tests the near end. This walks the whole curve, which is the belt to its braces.
    for (const [markName, mark] of Object.entries(MEANINGFUL)) {
      for (const [surfName, surf] of Object.entries(WALLS)) {
        for (let d = 0; d <= 30; d += 1) {
          const r = contrast(mark, shade(surf, wallFog(d)));
          expect(r, `${markName} on ${surfName} at ${d} cells is ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(FLOOR);
        }
      }
    }
  });
});

describe('the rim, and the shape channel', () => {
  it('the sprite rim is dark enough to separate a mark from a bright near wall', () => {
    for (const mark of Object.values(MEANINGFUL)) {
      expect(contrast(mark, SPRITE_RIM)).toBeGreaterThanOrEqual(FLOOR);
    }
  });

  it('the four enemies are separated by SHAPE, and the palette does not pretend otherwise', () => {
    // Deliberately NOT a pairwise-luminance assertion. Four marks that must each clear 3:1 against a
    // dark ground cannot also be well separated from each other — they are all, necessarily, bright.
    // Trying to have both is how a previous game in this fleet ended up with an assertion that could
    // only be satisfied by weakening it. The colour-vision guarantee here is the SILHOUETTE (art.ts
    // draws four genuinely different outlines) and this test pins the honest half: every enemy is
    // bright, and none of them is the background.
    for (const c of Object.values(ENEMY)) {
      expect(luminance(c)).toBeGreaterThan(0.3);
      for (const surf of Object.values(SURFACES)) expect(contrast(c, surf)).toBeGreaterThanOrEqual(FLOOR);
    }
  });

  it('the cage is the brightest thing in the level geometry, because it is the way out', () => {
    for (const w of Object.values(WALLS)) expect(luminance(STAIR)).toBeGreaterThan(luminance(w));
    expect(luminance(STAIR)).toBeGreaterThan(luminance(DOOR));
  });
});
