// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// See ADDITIONAL-TERMS.md for the section 7(b) attribution requirement.
//
// Deepshaft — every colour that carries meaning on the play surface, in one place, so a test can
// hold all of them to a contrast floor. Nothing in render.ts is allowed an inline colour literal.
//
// ── THE FOG TRAP, AND THE RULE THAT ESCAPES IT ──────────────────────────────────────────────────
// A raycaster darkens a wall with distance. The obvious thing is to darken the SPRITES with the same
// curve, and it is wrong in a way a screenshot cannot show you: WCAG contrast is
// (L1+0.05)/(L2+0.05), so multiplying both sides by the same k drives the ratio toward 1:1 as k
// falls. A monster fogged like the wall behind it becomes literally the same colour as the wall at
// the far end of a corridor — drawn, correctly placed, invisible. That is the shipped bug this file
// exists to make unreachable.
//
// So: **walls fog, sprites do not.** Everything alive or worth picking up in this mine carries its
// own light — that is why you can see them at all down there — and is drawn at full value at every
// depth, with a dark rim to separate it from a bright near wall. Distance is carried by SIZE, which
// is a channel fog cannot eat.
//
// tests/contrast.test.ts holds every sprite colour to >=3:1 (WCAG 2.1 §1.4.11, the floor for a
// non-text graphic) against every wall material at its BRIGHTEST — fog only ever darkens a wall, so
// the near end is the worst case — and pins `spriteFog()` at a constant 1 so the trap cannot be
// reintroduced by a one-line "polish" change.

/** Fog floor: how dark the far end of a corridor gets. Never 0 — a black wall has no shape. */
export const FOG_FLOOR = 0.42;
/** Distance in cells at which a wall reaches FOG_FLOOR. */
export const FOG_FULL = 13;

/** Wall shading by distance: 1 at the player's face, FOG_FLOOR at FOG_FULL cells and beyond. */
export function wallFog(dist: number): number {
  if (dist <= 0) return 1;
  const t = dist / FOG_FULL;
  return t >= 1 ? FOG_FLOOR : 1 - (1 - FOG_FLOOR) * t;
}

/**
 * Sprite shading by distance. It is a CONSTANT 1, on purpose — see the header. The function exists
 * rather than the literal so the contrast test can assert the constancy directly, and so a future
 * reader sees the decision instead of an absence.
 */
export function spriteFog(_dist: number): number {
  return 1;
}

/** Faces of a cube are tinted so corners read without an outline. N/S full, E/W dimmed. */
export const SIDE_SHADE = 0.74;

// ── the mine ────────────────────────────────────────────────────────────────────────────────────
// Deliberately dark and low-chroma. They are the BACKGROUND; every one of them must sit far enough
// below the sprite colours for those to clear 3:1 at full brightness.

export const WALLS = {
  /** Cut rock — the default gallery wall. */
  rock: '#4a3f36',
  /** Pit props and shoring: warmer, and it marks a junction you can navigate by. */
  timber: '#5a4632',
  /** A worked seam. The bluish cast is the only cool wall, so a seam is findable at a glance. */
  seamface: '#3d4f5a',
  /** Old brick lining near the shaft head. */
  brick: '#553a35',
} as const;

export type WallKind = keyof typeof WALLS;

export const FLOOR_NEAR = '#37302a';
export const FLOOR_FAR = '#191411';
export const CEIL_NEAR = '#2a2833';
export const CEIL_FAR = '#101018';

// ── doors and the way down ──────────────────────────────────────────────────────────────────────
// A door is a wall you can open, so it must not read as a wall. These are the brightest things in
// the level geometry and they are held to the same 3:1 floor against every wall, because a door you
// cannot find is a level you cannot finish.

export const DOOR = '#8fa4b8';
/** Locked doors take the colour of the card that opens them. */
export const LOCK = {
  amber: '#ffb340',
  cyan: '#56d8ff',
  rose: '#ff7ad1',
} as const;
export type LockColour = keyof typeof LOCK;
export const LOCK_ORDER: LockColour[] = ['amber', 'cyan', 'rose'];

/** The cage down to the next level. The single brightest surface in the mine, and it should be. */
export const STAIR = '#eaf3ff';

// ── the things that live here ───────────────────────────────────────────────────────────────────
// Colour is the SECOND channel. Silhouette is the first: each of these draws a different shape, so
// the roster survives any colour vision. Colour then separates them by luminance as well as hue, so
// a deuteranope reading the orange thrall against the yellow hauler still has a 1.7x luminance step.

export const ENEMY = {
  /** Thrall — the shambler. Slow, many, and the one you learn the game on. */
  thrall: '#ff9a3c',
  /** Lurker — spits from range, retreats when you close. */
  lurker: '#56d8ff',
  /** Stalker — fast, flanks, will not fight you from the front. */
  stalker: '#ff7ad1',
  /** Hauler — armoured, slow, and it does not stop. */
  hauler: '#ffe066',
} as const;
export type EnemyKind = keyof typeof ENEMY;

export const PICKUP = {
  /** Cutter/lance ammo. */
  ammo: '#c9d6e2',
  /** Carbide — the health pickup. */
  carbide: '#7dffa8',
  /** A charge for the launcher. Violet, so it is never mistaken for an incoming bolt. */
  charge: '#c79cff',
} as const;
export type PickupKind = keyof typeof PICKUP;

/** Player marks in co-op: a mate's beacon through the dark, and their name pill in the HUD. */
export const SEAT = ['#ffb340', '#56d8ff', '#7dffa8', '#ff7ad1'] as const;
export const SEAT_NAME = ['Amber', 'Cyan', 'Green', 'Rose'] as const;

/** A projectile in flight — the enemy's and yours, kept distinct so you can tell what is incoming. */
// Raised from a natural-looking #ff5d4a, which measured 2.81:1 against the seam face — a hostile
// projectile you cannot see against one wall in four is the whole point of the contrast gate.
export const BOLT_ENEMY = '#ff8f7a';
export const BOLT_MINE = '#ffe9a8';

/** The rim drawn around every sprite, separating it from a bright near wall. */
export const SPRITE_RIM = '#0a0c0f';

/** The carbide lamp on a miner's helmet — the mark that makes a mate down a dark gallery a LIGHT. */
export const LAMP = '#fff6dd';

/**
 * A mate on the floor. Deliberately the same value as BOLT_ENEMY: both mean "this is costing you
 * right now", and the pair was raised together off #ff5d4a when that measured 2.81:1 on the seam.
 */
export const DOWN_BODY = '#ff8f7a';

// ── panel trim ──────────────────────────────────────────────────────────────────────────────────
// The frame line and bolts drawn ON a door or lock plate. These are a structural DARKENING of the
// plate they sit on, not a signal of their own — the plate colour is the thing that has to clear
// contrast against the walls, and it is the one enumerated in MEANINGFUL. They live here anyway so
// that art.ts holds no colour literal at all and the hygiene test needs no allow-list.

export const DOOR_TRIM = '#20272e';
export const LOCK_TRIM: Record<LockColour, string> = {
  amber: '#3a2708',
  cyan: '#08303a',
  rose: '#3a0f2a',
};
/** The tread lines cut across the cage floor. */
export const STAIR_TREAD = '#20303f';

/** Everything that must be seen against the mine. The contrast test enumerates exactly this. */
export const MEANINGFUL: Record<string, string> = {
  ...ENEMY,
  ...PICKUP,
  door: DOOR,
  lockAmber: LOCK.amber,
  lockCyan: LOCK.cyan,
  lockRose: LOCK.rose,
  stair: STAIR,
  boltEnemy: BOLT_ENEMY,
  boltMine: BOLT_MINE,
  seat0: SEAT[0],
  seat1: SEAT[1],
  seat2: SEAT[2],
  seat3: SEAT[3],
};

/** Every surface a meaningful colour can be drawn against. */
export const SURFACES: Record<string, string> = {
  ...WALLS,
  floorNear: FLOOR_NEAR,
  ceilNear: CEIL_NEAR,
};

// ── colour maths, shared by the renderer and the contrast test ──────────────────────────────────

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function hexToRgb(hex: string): Rgb {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

const channel = (v: number): number => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two hex colours, order-independent. */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** Scale a colour's channels by k, the way the renderer fogs a wall. */
export function shade(hex: string, k: number): string {
  const { r, g, b } = hexToRgb(hex);
  const c = (v: number): string =>
    Math.max(0, Math.min(255, Math.round(v * k)))
      .toString(16)
      .padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}
