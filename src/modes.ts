// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// See ADDITIONAL-TERMS.md for the section 7(b) attribution requirement.
//
// Deepshaft — the three shapes a run can take. A mode must change how the game PLAYS, not a number:
// these change the STRUCTURE of a run (finite vs endless), the SIZE of a level, and the RESOURCE
// MODEL (whether the world gives you ammo at all). If two of them ever start to feel the same, one
// of them should be cut rather than retuned.
//
// The host's pick is what the room plays and it travels FROZEN inside the round start
// (`roundOpts()` in main.ts). A mode that changes level size means two peers on different modes are
// not playing the same mine, so `modeOf()` validates every id that arrives off the wire and falls
// back rather than handing `undefined` to the generator. `Object.hasOwn` and not `MODES[id] ||`,
// because a wire value of "constructor" is a real key on a plain object.

export interface Mode {
  id: string;
  name: string;
  blurb: string;
  /** One line of rules text for the help card, phrased as what it does TO YOU. */
  rule: string;
  /** Floors in a run. 0 means endless — the run ends when the party does. */
  floors: number;
  /** Level side in cells at floor 1, and how much it grows per floor (rounded, capped). */
  side0: number;
  sideGrow: number;
  sideMax: number;
  /** How many locked doors (and therefore keycards) a level may carry. */
  maxLocks: number;
  /** Enemies on floor 1, and the per-floor multiplier applied on top of the shared ramp. */
  popScale: number;
  /** Enemy HP and damage multiplier — Lode has fewer, harder things. */
  toughScale: number;
  /**
   * Whether the generator scatters ammo and carbide through the level. When false the ONLY ammo is
   * what a kill drops, which turns the game from crowd control into shot economy.
   */
  worldDrops: boolean;
  /** Ammo a kill drops, as a fraction of the weapon's clip. */
  killDrop: number;
  /** HP restored to everyone by taking the cage down. The mode's real difficulty dial. */
  healOnDescend: number;
}

const LIST: Mode[] = [
  {
    id: 'stope',
    name: 'Stope',
    blurb: 'The open workings. Big levels, three locks, and no bottom — go until it takes you.',
    rule: 'Endless. Levels grow and the mine keeps getting worse; your score is the deepest floor you stood on.',
    floors: 0,
    side0: 21,
    sideGrow: 0.85,
    sideMax: 29,
    maxLocks: 3,
    popScale: 1,
    toughScale: 1,
    worldDrops: true,
    killDrop: 0.14,
    healOnDescend: 16,
  },
  {
    id: 'adit',
    name: 'Adit',
    blurb: 'A driven side gallery: five tight floors with a bottom you can actually reach.',
    rule: 'Five floors, small and fast, one lock at most, and the cage patches you up on the way down. Reach the bottom and you have WON — this is the run to learn on.',
    floors: 5,
    side0: 17,
    sideGrow: 0.7,
    sideMax: 21,
    maxLocks: 1,
    popScale: 0.7,
    toughScale: 0.82,
    worldDrops: true,
    killDrop: 0.18,
    healOnDescend: 46,
  },
  {
    id: 'lode',
    name: 'Lode',
    blurb: 'A rich seam and nothing to spare. Nothing is lying about down here — every round comes off a body.',
    rule: 'Ten floors, and the mine gives you NOTHING: no ammo, no carbide on the ground. Kills are your only supply, and there are fewer, harder things to kill.',
    floors: 10,
    side0: 19,
    sideGrow: 0.8,
    sideMax: 25,
    maxLocks: 2,
    popScale: 0.62,
    toughScale: 1.7,
    worldDrops: false,
    killDrop: 0.42,
    healOnDescend: 26,
  },
];

export const MODES: Record<string, Mode> = Object.fromEntries(LIST.map((m) => [m.id, m]));
export const MODE_IDS: string[] = LIST.map((m) => m.id);
export const DEFAULT_MODE = 'stope';

/** Validate an id that may have come off the wire, out of localStorage, or out of a URL. */
export function modeOf(id: string | null | undefined): Mode {
  return id && Object.hasOwn(MODES, id) ? MODES[id] : MODES[DEFAULT_MODE];
}

/** Level side in cells for a given floor, clamped to the mode's ceiling and always odd. */
export function sideFor(mode: Mode, floor: number): number {
  const raw = Math.round(mode.side0 + mode.sideGrow * (floor - 1));
  const capped = Math.max(15, Math.min(mode.sideMax, raw));
  return capped % 2 === 0 ? capped + 1 : capped;
}

/** True when standing on the stair of `floor` ends the run as a WIN rather than descending. */
export function isLastFloor(mode: Mode, floor: number): boolean {
  return mode.floors > 0 && floor >= mode.floors;
}
