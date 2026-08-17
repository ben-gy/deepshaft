// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// See ADDITIONAL-TERMS.md for the section 7(b) attribution requirement.
//
// The generator's invariants, RE-DERIVED. Nothing in this file asks mine.ts whether it did its job:
// the flood fills below are written from the tile table outwards, and every number the generator
// records about itself (`level.locks`, `level.damp`, `level.spawns.length`) is treated as a CLAIM to
// be checked rather than as evidence. That distinction is the whole point — mine.ts's header argues
// that an unsolvable lock graph is "unreachable by construction", and an audit that trusted the
// construction would agree with it for free.
//
// The corpus is built once at module load: 3 modes x 6 floors x 12 seeds = 216 levels, plus the
// party-scaling and timing corpora. Generation is ~0.13ms a level, so the whole file is well inside
// its budget and every assertion below runs over all 216.

import { describe, expect, it } from 'vitest';
import {
  generate,
  isDoorTile,
  isFloorTile,
  isWallTile,
  T,
  type ItemPoint,
  type Level,
} from '../src/mine';
import { MODES, sideFor, type Mode } from '../src/modes';
import { LOCK_ORDER, type LockColour } from '../src/palette';
import { partyScale, popFor } from '../src/tuning';

const MODE_LIST: Mode[] = [MODES.stope, MODES.adit, MODES.lode];
const FLOORS = [1, 2, 3, 5, 8, 12];
const SEEDS = Array.from({ length: 12 }, (_, i) => 1000 + i * 7919);

interface Case {
  label: string;
  mode: Mode;
  floor: number;
  seed: number;
  players: number;
  level: Level;
}

/** 216 levels, generated once. Every test below sweeps all of them. */
const CASES: Case[] = [];
for (const mode of MODE_LIST) {
  for (const floor of FLOORS) {
    for (let s = 0; s < SEEDS.length; s++) {
      const seed = SEEDS[s];
      const players = 1 + (s % 4);
      CASES.push({
        label: `${mode.id} f${floor} seed ${seed} x${players}`,
        mode,
        floor,
        seed,
        players,
        level: generate(seed, floor, mode, players),
      });
    }
  }
}

// ── the re-derived reachability, written from the tile table and nothing else ───────────────────

const isKeyKind = (kind: string): kind is LockColour => (LOCK_ORDER as string[]).includes(kind);

/**
 * Can a PLAYER-SIZED BODY stand here, holding `keys`? Derived from the tile constants directly:
 *  · a GRATE is never passable by a body (that is the entire reason it is a separate tile);
 *  · a SUMP is passable — the player's radius is under SUMP_RADIUS, only a hauler is not;
 *  · a plain DOOR is a curtain, it opens for whoever walks up;
 *  · a LOCK_* is passable only once the matching card is held.
 */
function passable(lv: Level, i: number, keys: ReadonlySet<LockColour>): boolean {
  const t = lv.tiles[i];
  if (t === T.OPEN || t === T.STAIR || t === T.DAMP || t === T.SUMP) return true;
  if (t === T.DOOR) return true;
  if (t === T.LOCK_A) return keys.has('amber');
  if (t === T.LOCK_C) return keys.has('cyan');
  if (t === T.LOCK_R) return keys.has('rose');
  // SOLID / TIMBER / SEAM / BRICK / GRATE.
  return false;
}

/** Four-way flood from the start cell over `passable`, returning the reached mask. */
function flood(lv: Level, keys: ReadonlySet<LockColour>): Uint8Array {
  const s = lv.side;
  const seen = new Uint8Array(s * s);
  const start = (lv.start.y | 0) * s + (lv.start.x | 0);
  if (start < 0 || start >= seen.length || !passable(lv, start, keys)) return seen;
  const q = [start];
  seen[start] = 1;
  for (let h = 0; h < q.length; h++) {
    const cur = q[h];
    const cx = cur % s;
    for (let k = 0; k < 4; k++) {
      const nb = k === 0 ? cur - 1 : k === 1 ? cur + 1 : k === 2 ? cur - s : cur + s;
      if (nb < 0 || nb >= seen.length || seen[nb]) continue;
      // The row wrap is not adjacency: cell 0 of a row does not touch the last cell of the one above.
      if (k === 0 && cx === 0) continue;
      if (k === 1 && cx === s - 1) continue;
      if (!passable(lv, nb, keys)) continue;
      seen[nb] = 1;
      q.push(nb);
    }
  }
  return seen;
}

/**
 * The fixed point a player actually plays: flood, pocket every key you can now stand on, flood again
 * with the bigger key ring, until nothing new is reachable. This is the ONLY definition of "solvable"
 * that matters, and it never consults `level.locks` for permission.
 */
function fixpoint(lv: Level): { seen: Uint8Array; keys: Set<LockColour> } {
  const keys = new Set<LockColour>();
  let seen = flood(lv, keys);
  for (let round = 0; round <= LOCK_ORDER.length; round++) {
    let grew = false;
    for (const it of lv.items) {
      if (!isKeyKind(it.kind) || keys.has(it.kind)) continue;
      if (seen[(it.y | 0) * lv.side + (it.x | 0)]) {
        keys.add(it.kind);
        grew = true;
      }
    }
    if (!grew) break;
    seen = flood(lv, keys);
  }
  return { seen, keys };
}

const keyItems = (lv: Level): ItemPoint[] => lv.items.filter((it) => isKeyKind(it.kind));
const cellOf = (lv: Level, p: { x: number; y: number }): number => (p.y | 0) * lv.side + (p.x | 0);

// ── 1. determinism ──────────────────────────────────────────────────────────────────────────────

describe('generate — determinism', () => {
  it('the same (seed, floor, mode, players) cuts a byte-identical mine', () => {
    for (const c of CASES) {
      const again = generate(c.seed, c.floor, c.mode, c.players);
      expect(again.side, c.label).toBe(c.level.side);
      // Byte-identical, compared as bytes rather than as a deep-equal on a typed array.
      expect(Array.from(again.tiles), c.label).toEqual(Array.from(c.level.tiles));
      expect(again.start, c.label).toEqual(c.level.start);
      expect(again.stair, c.label).toEqual(c.level.stair);
      expect(again.locks, c.label).toEqual(c.level.locks);
      expect(again.damp, c.label).toEqual(c.level.damp);
      expect(again.items, c.label).toEqual(c.level.items);
      expect(again.spawns, c.label).toEqual(c.level.spawns);
    }
  });

  it('a different seed cuts a different mine', () => {
    let identical = 0;
    for (const mode of MODE_LIST) {
      for (const floor of FLOORS) {
        const a = generate(4242, floor, mode, 2);
        const b = generate(4243, floor, mode, 2);
        if (Array.from(a.tiles).join() === Array.from(b.tiles).join()) identical++;
      }
    }
    expect(identical).toBe(0);
  });

  it('the party size changes only the spawn list, never the rock', () => {
    // Party size feeds `scatterSpawns`, which is the LAST rng consumer — so the tiles, the items and
    // the firedamp of a floor are the same mine whether you walk it alone or four-handed. A peer that
    // joins late must be looking at the same rock.
    for (const c of CASES) {
      const four = generate(c.seed, c.floor, c.mode, 4);
      expect(Array.from(four.tiles), c.label).toEqual(Array.from(c.level.tiles));
      expect(four.items, c.label).toEqual(c.level.items);
      expect(four.damp, c.label).toEqual(c.level.damp);
    }
  });
});

// ── 2. the stair is reachable given the keys ────────────────────────────────────────────────────

describe('generate — solvability', () => {
  it('the stair is reachable from the start once the reachable keys are collected', () => {
    const bad: string[] = [];
    for (const c of CASES) {
      const { seen, keys } = fixpoint(c.level);
      if (!seen[cellOf(c.level, c.level.stair)]) {
        bad.push(`${c.label} (locks ${c.level.locks.join(',') || 'none'}; collected ${[...keys].join(',') || 'none'})`);
      }
    }
    // Zero tolerance. An unreachable stair is a run that cannot be finished, not a hard floor.
    expect(bad, `unsolvable floors:\n${bad.join('\n')}`).toEqual([]);
  });

  it('every key is reachable without ever crossing its own lock', () => {
    const bad: string[] = [];
    for (const c of CASES) {
      const lv = c.level;
      for (let i = 0; i < lv.locks.length; i++) {
        // Hold exactly the cards for locks 0..i-1 — the ring the chain says you have when you arrive
        // at lock i. Key i must already be standing in that reachable set.
        const before = flood(lv, new Set(lv.locks.slice(0, i)));
        const key = lv.items.find((it) => it.kind === lv.locks[i]);
        if (!key) {
          bad.push(`${c.label}: no ${lv.locks[i]} key placed at all`);
          continue;
        }
        if (!before[cellOf(lv, key)]) {
          bad.push(`${c.label}: ${lv.locks[i]} key (lock ${i} of ${lv.locks.join(',')}) sits behind its own lock`);
        }
      }
    }
    expect(bad, `key/lock cycles:\n${bad.join('\n')}`).toEqual([]);
  });

  it('every key colour the level claims is actually placed, exactly once', () => {
    for (const c of CASES) {
      const keys = keyItems(c.level).map((it) => it.kind);
      expect(keys.slice().sort(), c.label).toEqual(c.level.locks.slice().sort());
      expect(new Set(keys).size, c.label).toBe(keys.length);
    }
  });

  it('every lock colour the level claims is stamped on exactly one tile', () => {
    for (const c of CASES) {
      const stamped: LockColour[] = [];
      for (const t of c.level.tiles) {
        if (t === T.LOCK_A) stamped.push('amber');
        else if (t === T.LOCK_C) stamped.push('cyan');
        else if (t === T.LOCK_R) stamped.push('rose');
      }
      expect(stamped.slice().sort(), c.label).toEqual(c.level.locks.slice().sort());
      expect(c.level.locks.length, c.label).toBeLessThanOrEqual(c.mode.maxLocks);
      // Colours are handed out in LOCK_ORDER, so the list is always a prefix of it.
      expect(c.level.locks, c.label).toEqual(LOCK_ORDER.slice(0, c.level.locks.length));
    }
  });
});

// ── 3./4. nothing is buried in the rock ─────────────────────────────────────────────────────────

describe('generate — placement', () => {
  it('no spawn, item, start or stair is inside a wall', () => {
    const walkable = (t: number): boolean => isFloorTile(t) || isDoorTile(t);
    for (const c of CASES) {
      const lv = c.level;
      const at = (x: number, y: number): number => lv.tiles[(y | 0) * lv.side + (x | 0)];
      const startT = at(lv.start.x, lv.start.y);
      expect(walkable(startT), `${c.label}: start on tile ${startT}`).toBe(true);
      expect(at(lv.stair.x, lv.stair.y), `${c.label}: stair`).toBe(T.STAIR);
      for (const s of lv.spawns) {
        const t = at(s.x, s.y);
        expect(walkable(t), `${c.label}: ${s.kind} spawn at ${s.x},${s.y} on tile ${t}`).toBe(true);
        expect(isWallTile(t) || t === T.GRATE, `${c.label}: ${s.kind} spawn embedded`).toBe(false);
      }
      for (const it of lv.items) {
        const t = at(it.x, it.y);
        expect(walkable(t), `${c.label}: ${it.kind} item at ${it.x},${it.y} on tile ${t}`).toBe(true);
      }
    }
  });

  it('every position is inside the grid', () => {
    for (const c of CASES) {
      const lv = c.level;
      const ok = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < lv.side && y < lv.side;
      expect(ok(lv.start.x, lv.start.y), c.label).toBe(true);
      expect(ok(lv.stair.x, lv.stair.y), c.label).toBe(true);
      for (const s of lv.spawns) expect(ok(s.x, s.y), `${c.label} spawn`).toBe(true);
      for (const it of lv.items) expect(ok(it.x, it.y), `${c.label} item`).toBe(true);
      for (const d of lv.damp) expect(d >= 0 && d < lv.tiles.length, `${c.label} damp index`).toBe(true);
    }
  });

  it('every index in level.damp really is a firedamp pocket', () => {
    // game.ts scans `level.damp` to chain ignitions and never re-checks the geometry, so a stale
    // index there would silently light a cell that is not a pocket.
    for (const c of CASES) {
      for (const d of c.level.damp) expect(c.level.tiles[d], `${c.label} damp @${d}`).toBe(T.DAMP);
      expect(new Set(c.level.damp).size, `${c.label} duplicate damp`).toBe(c.level.damp.length);
    }
  });

  it('the start and the stair are never the same cell', () => {
    for (const c of CASES) {
      expect(cellOf(c.level, c.level.start) === cellOf(c.level, c.level.stair), c.label).toBe(false);
    }
  });
});

// ── 5. connectivity ─────────────────────────────────────────────────────────────────────────────

describe('generate — connectivity', () => {
  it('every open floor cell is reachable from the start with all doors open', () => {
    // This is the test that guards the GRATE placement. A grate is the one tile a player can neither
    // open nor break, so a grate that seals a wing hides whatever is in it forever — which is why
    // scatterGrates re-opens a cell that would disconnect the level. Doors are open here on purpose:
    // a locked wing is the lock working, and the test above already holds the lock chain.
    const bad: string[] = [];
    for (const c of CASES) {
      const lv = c.level;
      const s = lv.side;
      const open = (i: number): boolean => isFloorTile(lv.tiles[i]) || isDoorTile(lv.tiles[i]);
      const seen = new Uint8Array(s * s);
      const start = cellOf(lv, lv.start);
      if (!open(start)) {
        bad.push(`${c.label}: start is not an open cell`);
        continue;
      }
      const q = [start];
      seen[start] = 1;
      let hit = 1;
      for (let h = 0; h < q.length; h++) {
        const cur = q[h];
        const cx = cur % s;
        for (let k = 0; k < 4; k++) {
          const nb = k === 0 ? cur - 1 : k === 1 ? cur + 1 : k === 2 ? cur - s : cur + s;
          if (nb < 0 || nb >= seen.length || seen[nb]) continue;
          if (k === 0 && cx === 0) continue;
          if (k === 1 && cx === s - 1) continue;
          if (!open(nb)) continue;
          seen[nb] = 1;
          hit++;
          q.push(nb);
        }
      }
      let total = 0;
      for (let i = 0; i < seen.length; i++) if (open(i)) total++;
      if (hit !== total) bad.push(`${c.label}: ${total - hit} of ${total} floor cells sealed off`);
    }
    expect(bad, `disconnected wings:\n${bad.join('\n')}`).toEqual([]);
  });

  it('a grate always spans a way through rather than capping a dead end', () => {
    // A grate is a SCREEN across a gap: you see and shoot through it, nothing walks through it. One
    // with rock on both sides is a decorative brick, and one capping a dead end is a wall with extra
    // steps. Grates can stack — the candidate list is gathered before any are placed, so two adjacent
    // corridor cells can both become one — so the walk below steps through a run of grates and only
    // then insists on floor at each end.
    for (const c of CASES) {
      const lv = c.level;
      const s = lv.side;
      const reachesFloor = (from: number, step: number): boolean => {
        for (let k = 1, i = from + step; k < s; k++, i += step) {
          if (i < 0 || i >= lv.tiles.length) return false;
          if (lv.tiles[i] === T.GRATE) continue;
          return isFloorTile(lv.tiles[i]);
        }
        return false;
      };
      for (let i = 0; i < lv.tiles.length; i++) {
        if (lv.tiles[i] !== T.GRATE) continue;
        const x = i % s;
        const y = (i / s) | 0;
        expect(x > 0 && y > 0 && x < s - 1 && y < s - 1, `${c.label}: grate on the border`).toBe(true);
        const spans =
          (reachesFloor(i, -1) && reachesFloor(i, 1)) || (reachesFloor(i, -s) && reachesFloor(i, s));
        expect(spans, `${c.label}: grate at ${x},${y} does not span a way through`).toBe(true);
      }
    }
  });
});

// ── 6. sizes ────────────────────────────────────────────────────────────────────────────────────

describe('sideFor', () => {
  it('is always odd and inside [15, mode.sideMax]', () => {
    for (const mode of MODE_LIST) {
      for (let floor = 1; floor <= 40; floor++) {
        const side = sideFor(mode, floor);
        expect(side % 2, `${mode.id} f${floor}`).toBe(1);
        expect(side, `${mode.id} f${floor}`).toBeGreaterThanOrEqual(15);
        expect(side, `${mode.id} f${floor}`).toBeLessThanOrEqual(mode.sideMax);
      }
    }
  });

  it('never shrinks with depth, and does grow', () => {
    // Non-decreasing rather than strictly increasing: the growth is a fraction of a cell per floor
    // and the result is snapped to an odd number, so consecutive floors legitimately tie. What must
    // never happen is a floor being SMALLER than the one above it.
    for (const mode of MODE_LIST) {
      for (let floor = 2; floor <= 40; floor++) {
        expect(sideFor(mode, floor), `${mode.id} f${floor}`).toBeGreaterThanOrEqual(sideFor(mode, floor - 1));
      }
      expect(sideFor(mode, 40), mode.id).toBeGreaterThan(sideFor(mode, 1));
    }
  });

  it('is the side the generator actually cuts', () => {
    for (const c of CASES) {
      expect(c.level.side, c.label).toBe(sideFor(c.mode, c.floor));
      expect(c.level.tiles.length, c.label).toBe(c.level.side * c.level.side);
    }
  });
});

// ── 7. party scaling ────────────────────────────────────────────────────────────────────────────

describe('generate — party scaling', () => {
  it('four players get strictly more of the mine than one', () => {
    for (const mode of MODE_LIST) {
      for (const floor of [1, 3, 8]) {
        for (const seed of SEEDS.slice(0, 6)) {
          const solo = generate(seed, floor, mode, 1).spawns.length;
          const four = generate(seed, floor, mode, 4).spawns.length;
          expect(four, `${mode.id} f${floor} seed ${seed}`).toBeGreaterThan(solo);
        }
      }
    }
  });

  it('the spawn count matches popFor x popScale x partyScale, inside the rejection band', () => {
    // The generator rejection-samples on distance from the start (a far room is up to four times as
    // likely as a near one) under a guard of 12 attempts per wanted spawn. Expected acceptances are
    // ~7x the target, so it lands on the nominal number essentially always — but the guard CAN bite,
    // so the assertion is a band: never more than nominal, and never less than three quarters of it.
    for (const c of CASES) {
      const want = Math.max(1, Math.round(popFor(c.floor) * c.mode.popScale * partyScale(c.players)));
      expect(c.level.spawns.length, `${c.label} want ${want}`).toBeLessThanOrEqual(want);
      expect(c.level.spawns.length, `${c.label} want ${want}`).toBeGreaterThanOrEqual(Math.ceil(want * 0.75));
    }
  });

  it('never spawns anything in the start room', () => {
    for (const c of CASES) {
      const room = c.level.rooms[0];
      for (const s of c.level.spawns) {
        const inside = s.x >= room.x && s.x < room.x + room.w && s.y >= room.y && s.y < room.y + room.h;
        expect(inside, `${c.label}: ${s.kind} spawned in the start room`).toBe(false);
      }
    }
  });
});

// ── 8. generation cost ──────────────────────────────────────────────────────────────────────────

describe('generate — cost', () => {
  it('cuts a floor in a couple of milliseconds', () => {
    // This number is the budget the balance sim spends four hundred times a second and the budget a
    // phone spends between one floor and the next, so it is printed rather than only asserted.
    const mode = MODES.stope;
    const t0 = performance.now();
    const N = 100;
    for (let i = 0; i < N; i++) generate(90000 + i, 10, mode, 4);
    const per = (performance.now() - t0) / N;
    // eslint-disable-next-line no-console
    console.log(`generate: ${per.toFixed(3)} ms/level (stope floor 10, side ${sideFor(mode, 10)}, 4 players, n=${N})`);
    expect(per).toBeLessThan(4);
  });
});
