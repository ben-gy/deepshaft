// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// See ADDITIONAL-TERMS.md for the section 7(b) attribution requirement.
//
// Deepshaft — every number the simulation runs on. One file so the balance sim can sweep them and
// so nothing is buried as a literal in game.ts.
//
// Units: distances in CELLS, time in SECONDS, angles in RADIANS. The sim runs at a fixed 60Hz step
// (see loop.ts); anything expressed per-second is multiplied by the step, never by a frame delta.

export const STEP = 1 / 60;

// ── the player ──────────────────────────────────────────────────────────────────────────────────
export const PLAYER = {
  hp: 100,
  radius: 0.26,
  /** Cells per second at full stick. Fast enough to kite a thrall, slower than a stalker. */
  speed: 3.15,
  /** Strafing is slightly slower, so circling has a cost and facing is a real commitment. */
  strafeScale: 0.82,
  backScale: 0.72,
  /** Radians per second at full look input (desktop mouse scales separately). */
  turnRate: 2.9,
  /** Seconds of invulnerability after taking a hit, so a pack cannot delete you in one tick. */
  iframes: 0.4,
  /** Seconds bleeding out once downed. A mate must reach you inside this. */
  bleedOut: 22,
  /** Seconds a mate must stand within reviveRange to bring you back. */
  reviveTime: 2.2,
  reviveRange: 1.1,
  /** HP a revived player comes back on. */
  reviveHp: 40,
  /** Carbide restores this much, capped at hp. */
  carbide: 28,
} as const;

// ── weapons ─────────────────────────────────────────────────────────────────────────────────────
// Each answers a situation the others do not, which is the only reason for a third gun to exist:
//  · cutter — many weak things, close, and it never runs dry enough to strand you
//  · lance  — one armoured thing, or several lined up down a gallery (it pierces)
//  · charge — a pack you cannot out-shoot, and the only thing that sets off firedamp on purpose

export type WeaponId = 'cutter' | 'lance' | 'charge';

export interface Weapon {
  id: WeaponId;
  name: string;
  /** 'hit' resolves instantly along a ray; 'lob' spawns a travelling projectile. */
  kind: 'hit' | 'lob';
  damage: number;
  /** Seconds between shots. */
  interval: number;
  /** Max useful distance in cells. Beyond this the shot simply does not fire. */
  range: number;
  /** Half-angle of the auto-aim cone, radians. Facing IS aiming; this only forgives the last few degrees. */
  cone: number;
  /** Hitscan only: how many bodies one shot passes through. */
  pierce: number;
  /** How loud the shot is, in cells of flood-fill. This is what wakes the level. */
  noise: number;
  /** Ammo the weapon starts a run with, and the most it can hold. */
  start: number;
  cap: number;
  /** Splash radius in cells; 0 for a clean hit. */
  splash: number;
  /** Lob only: cells per second. */
  speed: number;
  /** Fraction of damage an armoured target ignores. The hauler is why the lance exists. */
  armourBite: number;
}

export const WEAPONS: Record<WeaponId, Weapon> = {
  cutter: {
    id: 'cutter',
    name: 'Cutter',
    kind: 'hit',
    damage: 7,
    interval: 0.11,
    range: 11,
    cone: 0.3,
    pierce: 1,
    noise: 7,
    start: 150,
    cap: 260,
    splash: 0,
    speed: 0,
    // A cutter is a rock drill, not a rifle. Armour eats most of it, which is the whole reason a
    // hauler is frightening while you are holding one.
    armourBite: 0.25,
  },
  lance: {
    id: 'lance',
    name: 'Lance',
    kind: 'hit',
    damage: 36,
    interval: 0.62,
    range: 18,
    cone: 0.16,
    pierce: 3,
    noise: 12,
    start: 22,
    cap: 60,
    splash: 0,
    speed: 0,
    armourBite: 1,
  },
  charge: {
    id: 'charge',
    name: 'Charge',
    kind: 'lob',
    damage: 58,
    interval: 0.95,
    range: 13,
    cone: 0.34,
    pierce: 0,
    noise: 15,
    start: 6,
    cap: 18,
    splash: 1.75,
    speed: 8.5,
    armourBite: 1,
  },
};

export const WEAPON_ORDER: WeaponId[] = ['cutter', 'lance', 'charge'];

// ── enemies ─────────────────────────────────────────────────────────────────────────────────────
// Four archetypes, four silhouettes, four different problems. `flank` and `kite` are what make them
// something other than four speeds of the same thing.

export type EnemyId = 'thrall' | 'lurker' | 'stalker' | 'hauler';

export interface EnemyKindDef {
  id: EnemyId;
  name: string;
  hp: number;
  /** Cells per second when chasing. */
  speed: number;
  radius: number;
  /** Contact damage, or bolt damage for a shooter. */
  damage: number;
  /** Seconds between attacks. */
  cooldown: number;
  /**
   * Seconds of visible, audible wind-up before an attack lands. This is the single most important
   * number for how multiplayer FEELS: a guest sees enemies about 110ms in the past, so an attack
   * with no tell is an attack that hits before it appears. A tell three to five times longer than
   * the interpolation delay makes the delay unnoticeable — and it is better SOLO too, because a
   * telegraph is what turns "I got hit" into "I should have moved".
   */
  windup: number;
  /** Melee reach, or 0 for a shooter. */
  reach: number;
  /** Ranged: bolt speed in cells/s, and the distance it will open fire from. 0 = melee only. */
  boltSpeed: number;
  boltRange: number;
  /** Ranged: backs away when the player is closer than this. The lurker's whole personality. */
  keepAway: number;
  /** Refuses to close while inside the player's facing cone; sidesteps to break it instead. */
  flank: boolean;
  /** Ignores `armourBite` fraction of incoming damage. */
  armoured: boolean;
  /** How far it can hear a noise event, as a multiplier on the noise radius. */
  ears: number;
  /** Sight range in cells, with line of sight. */
  eyes: number;
  /** Relative spawn weight at floor 1, and how that weight moves per floor. */
  weight0: number;
  weightPerFloor: number;
  /** Drawn height as a fraction of a wall, and how wide relative to that. */
  tall: number;
  wide: number;
}

export const ENEMIES: Record<EnemyId, EnemyKindDef> = {
  thrall: {
    id: 'thrall',
    name: 'Thrall',
    hp: 22,
    speed: 1.55,
    radius: 0.3,
    damage: 9,
    cooldown: 0.85,
    windup: 0.44,
    reach: 0.95,
    boltSpeed: 0,
    boltRange: 0,
    keepAway: 0,
    flank: false,
    armoured: false,
    ears: 1,
    eyes: 11,
    weight0: 10,
    weightPerFloor: -0.35,
    tall: 0.82,
    wide: 0.5,
  },
  lurker: {
    id: 'lurker',
    name: 'Lurker',
    hp: 17,
    speed: 1.35,
    radius: 0.28,
    damage: 12,
    cooldown: 1.55,
    windup: 0.52,
    reach: 0,
    boltSpeed: 6.4,
    boltRange: 10.5,
    keepAway: 3.6,
    flank: false,
    armoured: false,
    ears: 1.25,
    eyes: 13,
    weight0: 3.2,
    weightPerFloor: 0.28,
    tall: 0.62,
    wide: 0.72,
  },
  stalker: {
    id: 'stalker',
    name: 'Stalker',
    hp: 30,
    speed: 3.05,
    radius: 0.26,
    damage: 15,
    cooldown: 1.05,
    windup: 0.42,
    reach: 1,
    boltSpeed: 0,
    boltRange: 0,
    keepAway: 0,
    flank: true,
    armoured: false,
    ears: 1.5,
    eyes: 14,
    weight0: 1.1,
    weightPerFloor: 0.4,
    tall: 0.95,
    wide: 0.34,
  },
  hauler: {
    id: 'hauler',
    name: 'Hauler',
    hp: 135,
    speed: 0.92,
    radius: 0.44,
    damage: 27,
    cooldown: 1.25,
    windup: 0.66,
    reach: 1.25,
    boltSpeed: 0,
    boltRange: 0,
    keepAway: 0,
    flank: false,
    armoured: true,
    ears: 0.75,
    eyes: 9,
    weight0: 0.35,
    weightPerFloor: 0.3,
    tall: 1,
    wide: 0.95,
  },
};

export const ENEMY_IDS: EnemyId[] = ['thrall', 'lurker', 'stalker', 'hauler'];

// ── the ramp: how the mine gets worse ───────────────────────────────────────────────────────────
// Principle #18's lesson, applied to a descent: make the early game small and the late game big. The
// early floors are deliberately survivable by walking backwards, and the mix — not just the count —
// is what turns. A floor-12 room is not a floor-2 room with more thralls in it.

export const RAMP = {
  /** Enemies on floor 1, before the mode's popScale. */
  pop0: 9,
  /** Added per floor, and a mild geometric term so a run does terminate. */
  popPerFloor: 2.35,
  popGeom: 1.045,
  popCap: 46,
  /** Enemy HP and damage multipliers by floor. */
  hpPerFloor: 0.115,
  dmgPerFloor: 0.072,
  /** Past this floor the ramp turns geometric, which is what makes a run terminate. */
  hpKnee: 5,
  hpGeom: 1.11,
  dmgGeom: 1.055,
  /** Ammo and carbide the generator scatters, per floor (worldDrops modes only). */
  ammoPiles0: 4,
  ammoPilesPerFloor: 0.32,
  carbide0: 2.2,
  carbidePerFloor: 0.13,
  /** Firedamp pockets. They grow with depth, which is what makes the late game explosive. */
  damp0: 1.4,
  dampPerFloor: 0.55,
  dampCap: 14,
  /**
   * Seconds after which an unfound stair starts pulling extra spawns in. This is not flavour: it is
   * what makes a run TERMINATE. Before it escalated, 45% of three-player runs were still going at
   * the sim's 420-second limit — a party that had lost the stair and was quietly farming forever,
   * which the depth metric reads as "hard" and a player reads as "broken".
   */
  pressureAfter: 65,
  pressureEvery: 10,
  /** Each pressure wave arrives sooner than the last, to this floor. A geometric squeeze. */
  pressureDecay: 0.82,
  pressureFloor: 2.2,
} as const;

/** Enemy population for a floor, before the mode scale. */
export function popFor(floor: number): number {
  const linear = RAMP.pop0 + RAMP.popPerFloor * (floor - 1);
  return Math.min(RAMP.popCap, linear * Math.pow(RAMP.popGeom, Math.max(0, floor - 1)));
}

/**
 * How much mine there is per party size. THIS IS THE CO-OP SCALING RULE and it is not a nicety: with
 * a flat horde, three players are three guns on one player's worth of enemies and can revive each
 * other faster than the ramp can kill them. Measured before this existed: 73% of three-player runs
 * hit the 420-second limit without ending — an immortal party, exactly the failure the co-op sim is
 * supposed to catch. It also does the other half of the job, because a solo run gets LESS than the
 * nominal floor rather than the same as a party's.
 */
export const partyScale = (players: number): number => 0.72 + 0.64 * (Math.max(1, players) - 1);

/**
 * HP scales linearly for the first few floors and then GEOMETRICALLY, which is what guarantees a run
 * terminates. A purely linear ramp against a party whose damage output is roughly constant is a race
 * the party eventually wins forever; the geometric tail past `hpKnee` is the term that closes it.
 */
export function hpScale(floor: number): number {
  const linear = 1 + RAMP.hpPerFloor * (floor - 1);
  const over = Math.max(0, floor - RAMP.hpKnee);
  return linear * Math.pow(RAMP.hpGeom, over);
}
export const dmgScale = (floor: number): number =>
  (1 + RAMP.dmgPerFloor * (floor - 1)) * Math.pow(RAMP.dmgGeom, Math.max(0, floor - RAMP.hpKnee));

// ── firedamp ────────────────────────────────────────────────────────────────────────────────────
// The mine's one hazard, and deliberately the only thing in the game that hurts everybody equally.
// It is what turns a corridor from a place you retreat down into a place you set.
export const DAMP = {
  /** Damage at the centre of the ignition, falling linearly to 0 at `radius`. */
  damage: 74,
  radius: 2.3,
  /** A pocket lit by another pocket within this distance chains — that is the big play. */
  chain: 2.9,
  /** Seconds the flame lingers, damaging anything that walks in. */
  burn: 1.4,
  burnDps: 30,
  noise: 18,
} as const;
