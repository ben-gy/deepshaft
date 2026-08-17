// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// See ADDITIONAL-TERMS.md for the section 7(b) attribution requirement.
//
// The headless run harness, and the AUDITOR that watches it.
//
// ── THE RULE THIS FILE EXISTS TO KEEP ───────────────────────────────────────────────────────────
// The auditor below re-derives line of sight and "nearest valid target" with its OWN geometry. It
// never imports `Game.clearLine`, `Game.rayHits` or `Game.acquire`. That is not fastidiousness: an
// audit that calls the game's own raycast and compares the answer to itself is a tautology that
// passes on a completely broken game, and this fleet has shipped that mistake before. What the game
// supplies through `onShotAudit` is DATA — where the shooter stood, where it was looking, and where
// every living body was at that exact instant. The verdict is computed here.
//
// Second rule, from the same scar: a broken mechanic just makes runs end sooner, which is
// indistinguishable from intended difficulty. So the assertions on targeting are COUNTS OF RULE
// VIOLATIONS at zero tolerance, not durations or averages with a threshold to tune.

import { Bot, tierOf, type Blind } from '../../src/bot';
import { Game, IDLE_INTENT, type GEvent, type Intent, type ShotAudit } from '../../src/game';
import { STEP } from '../../src/tuning';
import { T } from '../../src/mine';

export interface RunConfig {
  seed: number;
  modeId: string;
  players: number;
  tier?: string;
  blind?: Blind;
  /** Wall-clock seconds of simulated time before the run is abandoned. */
  limitSeconds?: number;
}

export interface RunResult {
  deepest: number;
  floorsCleared: number;
  won: boolean;
  over: boolean;
  /** True when the limit stopped it rather than the game ending. A non-zero rate is a finding. */
  timedOut: boolean;
  seconds: number;
  kills: number;
  shots: number;
  hits: number;
  downs: number;
  revives: number;
  dampKills: number;
  /** Per-floor seconds, so a curve can be read rather than guessed at. */
  floorSeconds: number[];
  /** Every rule violation the auditor saw. Any non-zero value is a bug, not a tuning problem. */
  audit: AuditTotals;
}

export interface AuditTotals {
  /** A hit was registered on a body with no clear line to it. */
  throughWall: number;
  /** A shot took a target while a strictly nearer valid one sat in the same cone. */
  skippedNearer: number;
  /** A hit was registered outside the weapon's own cone or range. */
  outOfCone: number;
  /** An enemy the flow field could never reach any player from — an unkillable statue. */
  unreachable: number;
  shotsAudited: number;
}

// ── the auditor ─────────────────────────────────────────────────────────────────────────────────

const opaque = (g: Game, idx: number): boolean => {
  const tile = g.level.tiles[idx];
  if (tile === T.SOLID || tile === T.TIMBER || tile === T.SEAM || tile === T.BRICK) return true;
  const door = tile === T.DOOR || tile === T.LOCK_A || tile === T.LOCK_C || tile === T.LOCK_R;
  return door && g.doors[idx] < 0.75;
};

/**
 * Independent, EXACT line of sight: segment versus every blocking cell's box, by the Liang–Barsky
 * slab test, over the segment's bounding box of cells.
 *
 * The first version of this sampled the segment at twenty-four points per cell and it produced one
 * to five phantom violations per few thousand shots — not because the game was wrong, but because a
 * sampled walk and the game's grid DDA disagree at exactly the corners where a ray grazes a pillar.
 * A zero-tolerance invariant cannot be judged by an approximation: either the auditor is exact or
 * the number it reports is noise, and noise with a threshold bolted on is the thing this gate exists
 * to avoid. Slab clipping is exact and it shares no code and no idea with a DDA, so it is still an
 * independent derivation of the rule rather than the game checking its own homework.
 */
function auditClear(g: Game, x0: number, y0: number, x1: number, y1: number): boolean {
  const s = g.level.side;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const endX = x1 | 0;
  const endY = y1 | 0;
  const startX = x0 | 0;
  const startY = y0 | 0;
  const lo = (v: number): number => Math.max(0, Math.floor(Math.min(v, v)));
  void lo;
  const minX = Math.max(0, Math.min(x0, x1) | 0);
  const maxX = Math.min(s - 1, Math.max(x0, x1) | 0);
  const minY = Math.max(0, Math.min(y0, y1) | 0);
  const maxY = Math.min(s - 1, Math.max(y0, y1) | 0);

  for (let cy = minY; cy <= maxY; cy++) {
    for (let cx = minX; cx <= maxX; cx++) {
      // The shooter's own cell and the target's own cell are never blockers — the target is standing
      // in one of them, and a body is not behind itself.
      if ((cx === startX && cy === startY) || (cx === endX && cy === endY)) continue;
      const idx = cy * s + cx;
      if (!opaque(g, idx)) continue;
      // Liang–Barsky: clip the parametric segment against the cell's four slabs. Any surviving
      // interval strictly inside (0,1) means the segment passes through the box.
      let t0 = 0;
      let t1 = 1;
      const p = [-dx, dx, -dy, dy];
      const q = [x0 - cx, cx + 1 - x0, y0 - cy, cy + 1 - y0];
      let blocked = true;
      for (let k = 0; k < 4; k++) {
        if (p[k] === 0) {
          if (q[k] < 0) {
            blocked = false;
            break;
          }
          continue;
        }
        const r = q[k] / p[k];
        if (p[k] < 0) {
          if (r > t1) {
            blocked = false;
            break;
          }
          if (r > t0) t0 = r;
        } else {
          if (r < t0) {
            blocked = false;
            break;
          }
          if (r < t1) t1 = r;
        }
      }
      // A grazing touch (a zero-length interval, i.e. the segment kisses a corner) is not a block.
      if (blocked && t1 - t0 > 1e-9) return false;
    }
  }
  return true;
}

const wrapAngle = (a: number): number => {
  let v = a;
  while (v > Math.PI) v -= Math.PI * 2;
  while (v < -Math.PI) v += Math.PI * 2;
  return v;
};

/** Judge one shot against the rule, from outside. Returns which invariants it broke. */
export function auditShot(g: Game, a: ShotAudit): { throughWall: number; skippedNearer: number; outOfCone: number } {
  let throughWall = 0;
  let skippedNearer = 0;
  let outOfCone = 0;
  if (a.targetId < 0) return { throughWall, skippedNearer, outOfCone };

  // The rule the game claims: the NEAREST AWAKE enemy inside the cone with a clear line. "Awake" is
  // part of the rule, not a detail — a gun that engaged sleeping things would make the whole noise
  // system meaningless. The game supplies the flag as DATA; this file supplies the rule.
  const chosen = a.live.find((e) => e.id === a.targetId);
  if (!chosen) return { throughWall, skippedNearer, outOfCone };

  const dist = Math.hypot(chosen.x - a.ox, chosen.y - a.oy);
  const bearing = Math.atan2(chosen.y - a.oy, chosen.x - a.ox);
  // Tolerances are for floating point only, and are far below any real geometry error: a body one
  // radius wide subtends more than 0.02rad at every distance this can fire.
  if (Math.abs(wrapAngle(bearing - a.ang)) > a.cone + 1e-6 || dist > a.range + 1e-6) outOfCone++;
  if (!auditClear(g, a.ox, a.oy, chosen.x, chosen.y)) throughWall++;

  for (const other of a.live) {
    if (other.id === a.targetId) continue;
    if (!other.awake) continue;
    const d = Math.hypot(other.x - a.ox, other.y - a.oy);
    // "Strictly nearer" by more than a body radius, so two bodies at the same range are not a
    // violation of anything — they are a tie the game may break either way.
    if (d >= dist - other.radius) continue;
    if (d > a.range) continue;
    const b = Math.atan2(other.y - a.oy, other.x - a.ox);
    if (Math.abs(wrapAngle(b - a.ang)) > a.cone) continue;
    if (!auditClear(g, a.ox, a.oy, other.x, other.y)) continue;
    skippedNearer++;
  }
  return { throughWall, skippedNearer, outOfCone };
}

/**
 * Every enemy on a floor must be GEOMETRICALLY reachable — connected to a player through open cells
 * with every door treated as openable, or it is a statue sealed in rock that will kill nobody and
 * can never be reached by anything that has to walk.
 *
 * Doors are open for this test on purpose. An enemy behind a locked door is not a bug — it is the
 * lock working, and the lock chain in mine.ts already guarantees the key is reachable first. Testing
 * with doors SHUT reported thirty-six "violations" in a three-minute run that were all just doors.
 */
export function unreachableEnemies(g: Game): number {
  const s = g.level.side;
  const n = s * s;
  const seen = new Uint8Array(n);
  const q: number[] = [];
  for (const p of g.players) {
    if (!p.present || p.down) continue;
    const i = (p.y | 0) * s + (p.x | 0);
    if (i >= 0 && i < n && !seen[i]) {
      seen[i] = 1;
      q.push(i);
    }
  }
  // No standing player is not a violation — there is simply nothing to be reachable from.
  if (!q.length) return 0;
  for (let h = 0; h < q.length; h++) {
    const cur = q[h];
    const cx = cur % s;
    for (let k = 0; k < 4; k++) {
      const nb = k === 0 ? cur - 1 : k === 1 ? cur + 1 : k === 2 ? cur - s : cur + s;
      if (nb < 0 || nb >= n || seen[nb]) continue;
      if (k === 0 && cx === 0) continue;
      if (k === 1 && cx === s - 1) continue;
      const tile = g.level.tiles[nb];
      if (tile === T.SOLID || tile === T.TIMBER || tile === T.SEAM || tile === T.BRICK) continue;
      seen[nb] = 1;
      q.push(nb);
    }
  }
  let bad = 0;
  for (const e of g.enemies) {
    if (e.state === 'dead') continue;
    const i = (e.y | 0) * s + (e.x | 0);
    if (i < 0 || i >= n || !seen[i]) bad++;
  }
  return bad;
}

// ── the run ─────────────────────────────────────────────────────────────────────────────────────

export function runOnce(cfg: RunConfig): RunResult {
  const limit = cfg.limitSeconds ?? 420;
  const g = new Game({
    seed: cfg.seed,
    modeId: cfg.modeId,
    players: Array.from({ length: cfg.players }, (_, i) => ({ name: `bot${i}`, bot: true })),
    mySeat: null,
  });
  const tier = tierOf(cfg.tier ?? 'miner');
  const bots = g.players.map((_, s) => new Bot(g, s, tier, cfg.blind ?? {}, cfg.seed + s));

  const audit: AuditTotals = { throughWall: 0, skippedNearer: 0, outOfCone: 0, unreachable: 0, shotsAudited: 0 };
  g.onShotAudit = (a) => {
    audit.shotsAudited++;
    const r = auditShot(g, a);
    audit.throughWall += r.throughWall;
    audit.skippedNearer += r.skippedNearer;
    audit.outOfCone += r.outOfCone;
  };

  let kills = 0;
  let shots = 0;
  let hits = 0;
  let downs = 0;
  let revives = 0;
  let dampKills = 0;
  const floorSeconds: number[] = [];
  let floorStart = 0;
  let seenFloor = g.floor;
  let lastDamp = -1;

  const ticks = Math.ceil(limit / STEP);
  const intents: Intent[] = g.players.map(() => ({ ...IDLE_INTENT }));
  let reachCheckIn = 0;

  for (let t = 0; t < ticks && !g.over; t++) {
    for (let s = 0; s < bots.length; s++) intents[s] = bots[s].think(STEP);
    g.tick(STEP, intents);

    for (const ev of g.drainEvents() as GEvent[]) {
      if (ev.k === 'shot') {
        shots++;
        if (ev.hit) hits++;
      } else if (ev.k === 'killE') {
        kills++;
        // A kill inside a second of an ignition, near it, is credited to the firedamp. Coarse on
        // purpose: it is a FEEL metric, not an invariant.
        if (g.runTime - lastDamp < 0.4) dampKills++;
      } else if (ev.k === 'damp') lastDamp = g.runTime;
      else if (ev.k === 'downP') downs++;
      else if (ev.k === 'reviveP') revives++;
      else if (ev.k === 'descend') {
        floorSeconds.push(g.runTime - floorStart);
        floorStart = g.runTime;
        seenFloor = g.floor;
        for (const b of bots) b.reset();
      }
    }

    reachCheckIn -= STEP;
    if (reachCheckIn <= 0 && !g.over) {
      reachCheckIn = 2;
      // `!g.over` is load-bearing. The check runs after tick(), so on the tick where the last player
      // goes down the flood fill has no seed at all and reports EVERY living enemy as unreachable —
      // fourteen phantom violations across forty 2-player runs, every one of them a party wipe. The
      // invariant is about the mine's geometry, and a wiped party is not a geometry fact.
      audit.unreachable += unreachableEnemies(g);
    }
  }
  void seenFloor;
  floorSeconds.push(g.runTime - floorStart);

  const stats = g.players.reduce(
    (acc, p) => {
      acc.kills += p.stats.kills;
      return acc;
    },
    { kills: 0 },
  );
  void stats;

  return {
    deepest: g.deepest,
    floorsCleared: g.deepest - 1,
    won: g.won,
    over: g.over,
    timedOut: !g.over,
    seconds: g.runTime,
    kills,
    shots,
    hits,
    downs,
    revives,
    dampKills,
    floorSeconds,
    audit,
  };
}

export const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
export const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};
export const pct = (xs: number[], p: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
