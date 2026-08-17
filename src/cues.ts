// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// See ADDITIONAL-TERMS.md for the section 7(b) attribution requirement.
//
// Deepshaft — every sound the game makes, as Web Audio oscillator patches. There are no samples and
// no files.
//
// CUES is not decoration. `sfx.play()` on a name that has no patch returns SILENTLY rather than
// throwing, so a typo'd cue is an inaudible bug that a green test suite cannot see. tests/
// source-hygiene.test.ts greps every `ping('x')` literal in src/ and asserts it is in this list, and
// that every listed cue resolves to a real patch here or in the engine's defaults.

import type { Patch } from '@ben-gy/game-engine/sound';

/** Every cue name this game is allowed to play. Asserted against the source by the hygiene test. */
export const CUES = [
  // weapons
  'cutter',
  'lance',
  'charge',
  'dry',
  // combat feedback
  'thud',
  'kill',
  'hurt',
  'down',
  'revive',
  // the mine
  'pickup',
  'key',
  'door',
  'locked',
  'descend',
  'wake',
  'blast',
  // shell
  'select',
  'blip',
  'win',
  'lose',
  'beat',
  'go',
] as const;

export type Cue = (typeof CUES)[number];

/**
 * The patches. Merged OVER the engine's defaults, so `beat`, `go`, `win` and `lose` come free unless
 * named here — `win`/`lose` are overridden because the engine's are cheerful and this game ends in a
 * mine.
 */
export const PATCHES: Record<string, Patch> = {
  // The cutter is the starting gun: a dry, fast tick with almost no tail, so ten a second do not
  // turn into mud.
  cutter: { type: 'square', freq: [420, 190], dur: 0.05, gain: 0.14, noise: true },
  // The lance is the hitscan rifle — higher, cleaner, and it rings a little.
  lance: { type: 'sawtooth', freq: [1180, 340], dur: 0.11, gain: 0.17 },
  // The charge is the thrown/lobbed shot leaving the hand: a soft low whoop.
  charge: { type: 'sine', freq: [260, 620], dur: 0.14, gain: 0.16 },
  // The click of a trigger with nothing behind it. Deliberately unpleasant.
  dry: { type: 'square', freq: [150, 90], dur: 0.045, gain: 0.11 },

  // A round landing in something soft.
  thud: { type: 'triangle', freq: [230, 120], dur: 0.07, gain: 0.16, noise: true },
  // A kill. Pitched by the victim's size at the call site, so a big one sounds big.
  kill: { type: 'sawtooth', freq: [340, 70], dur: 0.26, gain: 0.24, noise: true },
  // Taking damage: a short punch under the veil flash.
  hurt: { type: 'sawtooth', freq: [190, 60], dur: 0.2, gain: 0.3, noise: true },
  // Going down. Long, falling, unmistakable.
  down: { type: 'sawtooth', freq: [300, 45], dur: 0.75, gain: 0.32 },
  revive: { type: 'triangle', freq: [330, 880], dur: 0.4, gain: 0.24 },

  pickup: { type: 'square', freq: [720, 1080], dur: 0.09, gain: 0.17 },
  key: { type: 'triangle', freq: [660, 1320], dur: 0.3, gain: 0.22 },
  door: { type: 'sawtooth', freq: [90, 150], dur: 0.42, gain: 0.16, noise: true },
  // A door you cannot open yet. Two notes down, so it reads as a refusal.
  locked: { type: 'square', freq: [220, 150], dur: 0.13, gain: 0.15 },
  // The cage dropping to the next level.
  descend: { type: 'sine', freq: [180, 55], dur: 0.9, gain: 0.26 },
  // Something in the dark has heard you. This is the most important sound in the game.
  wake: { type: 'sawtooth', freq: [130, 300], dur: 0.22, gain: 0.2 },
  // A charge going off, or a firedamp pocket taking a wall with it.
  blast: { type: 'sawtooth', freq: [220, 32], dur: 0.55, gain: 0.36, noise: true },

  select: { type: 'triangle', freq: [520, 780], dur: 0.07, gain: 0.18 },
  blip: { type: 'square', freq: [400, 560], dur: 0.05, gain: 0.13 },
  // Reaching the bottom of a run alive.
  win: { type: 'triangle', freq: [440, 1320], dur: 0.6, gain: 0.26 },
  // The party is down. A long fall, not a buzzer.
  lose: { type: 'sine', freq: [320, 60], dur: 0.9, gain: 0.28 },
};
