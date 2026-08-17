// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// See ADDITIONAL-TERMS.md for the section 7(b) attribution requirement.
//
// Deepshaft — the interactive tutorial, as DATA.
//
// It is a hand-cut floor and a list of steps, and it drives the SHIPPED `Game`, the shipped movement,
// the shipped auto-fire and the shipped firedamp. There is no second implementation of anything here
// — which is the whole point. A tutorial with private logic is a lie that cannot even be detected:
// it goes on confidently teaching a game that no longer exists, and no test can tell. Because this
// one is data over the real rules, `tests/tutorial.test.ts` can replay every step through them and
// go RED the day a rule changes.
//
// Restriction is a `legalMask` applied to the intent before it reaches `Game.tick()`. A refused
// input is swallowed, not punished: the control pulses and nothing happens.

import { Game } from './game';
import { T, type Level } from './mine';
import type { LockColour } from './palette';

export interface StepGate {
  /** Sideways stick / turn keys. */
  turn?: boolean;
  /** Forward-back stick / walk keys. */
  walk?: boolean;
  /** Auto-fire is allowed to engage at all. */
  fire?: boolean;
  /** The USE button exists. */
  use?: boolean;
  /** The weapon button exists. */
  swap?: boolean;
}

export interface TutorialStep {
  id: string;
  /** One imperative sentence, naming the thing to touch. */
  copy: string;
  /** Shown after the step completes, explaining what just happened. Optional. */
  after?: string;
  gate: StepGate;
  /** True once the step is satisfied. Reads the REAL game state and nothing else. */
  done: (g: Game, t: Progress) => boolean;
  /** Shown instead of `copy` if the player found a worse way through. */
  hint?: string;
  /** Run once when the step begins. This is how the tutorial wakes exactly what it needs, when. */
  enter?: (g: Game) => void;
  /** True when the player got there the long way and the step should be re-offered with the hint. */
  missed?: (g: Game, t: Progress) => boolean;
}

/** Everything the steps need that the Game does not itself remember. */
export interface Progress {
  walked: number;
  turned: number;
  kills: number;
  doorsOpened: number;
  dampKills: number;
  tookCarbide: boolean;
  reachedStair: boolean;
  startX: number;
  startY: number;
}

export const freshProgress = (g: Game): Progress => ({
  walked: 0,
  turned: 0,
  kills: 0,
  doorsOpened: 0,
  dampKills: 0,
  tookCarbide: false,
  reachedStair: false,
  startX: g.players[0].x,
  startY: g.players[0].y,
});

const ALL: StepGate = { turn: true, walk: true, fire: true, use: true, swap: true };

export const STEPS: TutorialStep[] = [
  {
    id: 'walk',
    copy: 'Slide your thumb up to walk down the drift.',
    gate: { walk: true },
    done: (_g, t) => t.walked >= 3.2,
  },
  {
    id: 'turn',
    copy: 'Now slide left and right to look — the gallery turns south.',
    gate: { walk: true, turn: true },
    done: (g, t) => t.turned > 1.0 && g.players[0].y > 5.5,
  },
  {
    id: 'shoot',
    copy: 'Face the thrall. The gun fires on its own.',
    // Nothing in the mine is awake until the step that needs it. The first build started the hall's
    // thrall chasing from tick zero, so it walked up the drift and put the player DOWN during step
    // two, on a screen that was still saying "slide your thumb to walk".
    enter: (g) => {
      const e = g.enemies[0];
      if (e) {
        e.state = 'chase';
        e.target = 0;
      }
    },
    after: 'You never aim. Where you look is what you shoot — and it only picks things that are awake.',
    gate: { walk: true, turn: true, fire: true },
    done: (_g, t) => t.kills >= 1,
  },
  {
    id: 'grate',
    copy: 'The lurker is spitting through the grate. Walk on — it cannot follow.',
    after: 'A grate stops bodies, not bullets, and not eyes. Half this mine is rules disagreeing.',
    gate: { walk: true, turn: true, fire: true },
    // ORIGINALLY this step said "it only shoots what is awake, walk past the sleeping one", and it
    // was unpassable — not because of a bug, but because the rules are right and the lesson was
    // wrong. A grate is transparent, so the lurker SEES you the moment you enter the hall and wakes
    // on its own; and a round aimed at the thrall carries straight through the grate and wakes it
    // anyway. Rather than bend two rules to protect a sentence, the step now teaches what the
    // geometry actually does — which is the more interesting fact about this game in any case. The
    // awake-only gate is taught by step 3's copy, where it costs nothing.
    //
    // Reaching the far end of the hall, at the mouth of the locked door. NOT through it: that is
    // step 5's job, and requiring an action the tutorial has not taught yet is how a sequence
    // dead-ends.
    done: (g) => g.players[0].y > 13.0,
  },
  {
    id: 'card',
    copy: 'Take the amber card, then press USE at the amber door.',
    gate: { walk: true, turn: true, fire: true, use: true },
    done: (_g, t) => t.doorsOpened >= 1,
  },
  {
    id: 'damp',
    copy: 'Some things are worth more where they are standing.',
    enter: (g) => {
      for (const e of g.enemies) {
        if (e.kind !== 'thrall' || e.y < 15) continue;
        e.state = 'chase';
        e.target = 0;
      }
    },
    after: 'Firedamp does not care whose side you are on. Neither does anything else down here.',
    hint: 'The pocket was the weapon — shoot the green gas, not the thralls.',
    gate: ALL,
    done: (_g, t) => t.dampKills >= 2,
    // Killing them one at a time is a pass on the room and a fail on the point, so the step replays
    // with the hint rather than letting the player past the one idea the game is built on.
    missed: (g, t) => t.dampKills < 2 && g.enemies.filter((e) => e.state !== 'dead').length === 0,
  },
  {
    id: 'choice',
    copy: 'The cage is right there. The carbide is two rooms back. Your call.',
    after: 'That was the game. Every floor asks it again, and the mine is counting.',
    gate: ALL,
    // BOTH answers finish the tutorial, and both are congratulated. There is no correct one — that
    // is the whole reason this step exists rather than a caption saying "manage your resources".
    done: (_g, t) => t.reachedStair || t.tookCarbide,
  },
];

// ── the floor ───────────────────────────────────────────────────────────────────────────────────
// Hand-cut, so every step has exactly the geometry it needs. This is the tutorial's ONLY privilege
// over a normal run: a fixed level instead of a generated one. Every rule that acts on it is shipped.

const SIDE = 21;
const idx = (x: number, y: number): number => y * SIDE + x;

function rect(tiles: Uint8Array, x0: number, y0: number, x1: number, y1: number, t: number): void {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) tiles[idx(x, y)] = t;
}

export function tutorialLevel(): Level {
  const tiles = new Uint8Array(SIDE * SIDE).fill(T.SOLID);

  // The opening drift: a straight run east, so step 1 is "push forward and something happens".
  rect(tiles, 2, 2, 4, 4, T.OPEN);
  rect(tiles, 5, 3, 10, 3, T.OPEN);
  // The turn south, which is step 2.
  rect(tiles, 10, 4, 10, 8, T.OPEN);
  // The hall: one awake thrall, one sleeping lurker, and the amber card.
  rect(tiles, 7, 9, 14, 13, T.OPEN);
  // A grate along the hall's NORTH-east corner — you can see the sleeping lurker's alcove through it,
  // and nothing can walk through, which is the cheapest possible demonstration of the rule.
  //
  // The row matters. It was originally level with the hall's thrall, and a grate does not stop a
  // ROUND either: the auto-aim swung onto the thrall, the shot carried straight through the grate,
  // and woke the lurker every single time — making step 4 ("leave the sleeping one") impossible to
  // pass by playing well. The alcove and the fight are now on different lines.
  rect(tiles, 15, 9, 15, 10, T.GRATE);
  rect(tiles, 16, 9, 18, 10, T.OPEN);
  // The locked way down.
  rect(tiles, 10, 14, 10, 14, T.LOCK_A);
  rect(tiles, 10, 15, 10, 15, T.OPEN);
  // The last room: a firedamp pocket in the mouth of it, the cage at the far end, and the vault.
  rect(tiles, 4, 16, 17, 19, T.OPEN);
  tiles[idx(10, 16)] = T.DAMP;
  tiles[idx(11, 16)] = T.DAMP;
  // A little standing water, so a hauler-shaped problem is legible before it ever appears.
  rect(tiles, 6, 18, 7, 19, T.SUMP);
  tiles[idx(16, 18)] = T.STAIR;

  return {
    side: SIDE,
    tiles,
    rooms: [
      { x: 2, y: 2, w: 3, h: 3, cx: 3, cy: 3 },
      { x: 7, y: 9, w: 8, h: 5, cx: 10, cy: 11 },
      { x: 4, y: 16, w: 14, h: 4, cx: 10, cy: 17 },
    ],
    start: { x: 3.5, y: 3.5 },
    stair: { x: 16, y: 18 },
    locks: ['amber' as LockColour],
    spawns: [
      // Woken by step 3's `enter`, and standing in the SOUTH of the hall so the fight faces away
      // from the grate.
      { kind: 'thrall', x: 12.5, y: 12.5 },
      // Asleep in the alcove: visible through the grate, unreachable by either of you, and the point
      // of step 4.
      { kind: 'lurker', x: 17.5, y: 9.5 },
      // The three for step 6, standing where the gas is.
      { kind: 'thrall', x: 10.5, y: 17.5 },
      { kind: 'thrall', x: 11.5, y: 17.5 },
      { kind: 'thrall', x: 11.5, y: 16.5 },
    ],
    items: [
      { kind: 'amber', x: 8, y: 12 },
      { kind: 'ammoCharge', x: 8, y: 10 },
      // The vault: the only carbide, deliberately in the wrong direction.
      { kind: 'carbide', x: 5, y: 19 },
    ],
    damp: [idx(10, 16), idx(11, 16)],
  };
}

/** A fresh tutorial game on the shipped rules. Solo, one seat, no wire. */
export function tutorialGame(): Game {
  const g = new Game({
    seed: 0xd3e9,
    modeId: 'adit',
    players: [{ name: 'You', bot: false }],
    mySeat: 0,
    level: tutorialLevel(),
  });
  // Step 6 needs a charge in the pool and step 3 needs the cutter; nothing else is given.
  g.players[0].ammo.charge = 2;
  g.players[0].ammo.lance = 0;
  // Nobody is awake. Each step wakes exactly what it needs through its `enter` hook.
  g.noDeath = true;
  g.stairEnds = true;
  return g;
}

/** Fold an intent through a step's gate. A refused axis is zeroed, never inverted. */
export function gateIntent<T extends { mx: number; my: number; ang: number; fire: boolean; use: boolean }>(
  i: T,
  gate: StepGate,
  heldAng: number,
): T {
  const out = { ...i };
  if (!gate.walk) {
    out.mx = 0;
    out.my = 0;
  }
  if (!gate.turn) out.ang = heldAng;
  if (!gate.fire) out.fire = false;
  if (!gate.use) out.use = false;
  return out;
}
