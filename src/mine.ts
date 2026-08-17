// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// See ADDITIONAL-TERMS.md for the section 7(b) attribution requirement.
//
// Deepshaft — the mine itself: tiles, and the generator that cuts a floor from a seed.
//
// ── HOW THE LOCK GRAPH IS KEPT SOLVABLE, AND WHY THE ARGUMENT ALONE WAS NOT ENOUGH ──────────────
// The hard part of "keycards and locked doors" is guaranteeing that the key for a door is never
// behind that door.
//
// The design argument is a chain on a TREE. Rooms are connected by a spanning tree, so between any
// two rooms there is exactly one path; the stair goes in the room furthest from the start; the locks
// go on distinct edges OF THAT PATH, in order; and key i goes in a room whose tree path from the
// start crosses only locks 1..i-1. On the tree, that cannot cycle.
//
// THAT ARGUMENT IS SOUND AND IT WAS NOT SUFFICIENT, because the tree is not the grid. Measured over
// 10,800 generated levels: **3.2% were unsolvable** — a key sealed behind its own lock — from two
// leaks the tree cannot see. (1) `carveCorridor` digs an L between two room centres and those Ls
// OVERLAP, so a lock stamped on one edge's corridor can also sit on another edge's corridor and gate
// something the bookkeeping never accounted for. (2) `doorCell` walked a different L than
// `carveCorridor` carved — the carve picks its elbow from the rng, the door walk always went x-first
// — so on half the branches the door landed on a cell belonging to some other corridor entirely.
//
// So the argument is now a claim that is CHECKED. `verifySolvable()` runs the same fixed-point flood
// a player performs (reach what you can, pick up the keys you find, flood again) at the end of
// generation, and a floor that fails is re-rolled with fewer locks until it passes — bottoming out
// at zero locks, which is trivially solvable. It costs about 0.07ms against a 0.067ms generation, so
// the honest version is roughly twice the price of the version that was quietly wrong.
//
// The lesson is the general one: a construction argument is a hypothesis about the code, and the only
// thing that makes it a fact is a test that re-derives the property from scratch. `tests/mine.test.ts`
// does exactly that, and it is what found this.

import { makeRng, randInt, type Rng } from '@ben-gy/game-engine/rng';
import { LOCK_ORDER, type LockColour } from './palette';
import { RAMP, ENEMY_IDS, ENEMIES, partyScale, popFor, type EnemyId } from './tuning';
import { sideFor, type Mode } from './modes';

export const T = {
  SOLID: 0,
  OPEN: 1,
  TIMBER: 2,
  SEAM: 3,
  BRICK: 4,
  DOOR: 5,
  LOCK_A: 6,
  LOCK_C: 7,
  LOCK_R: 8,
  STAIR: 9,
  DAMP: 10,
  /** A timber screen. You SEE and SHOOT through it; nothing walks through it. */
  GRATE: 11,
  /** Flooded ground. Anything can wade it slowly and loudly — except a hauler, which is too heavy. */
  SUMP: 12,
} as const;
export type Tile = (typeof T)[keyof typeof T];

export const LOCK_TILE: Record<LockColour, number> = {
  amber: T.LOCK_A,
  cyan: T.LOCK_C,
  rose: T.LOCK_R,
};
export const TILE_LOCK: Record<number, LockColour> = {
  [T.LOCK_A]: 'amber',
  [T.LOCK_C]: 'cyan',
  [T.LOCK_R]: 'rose',
};

/** Any tile a ray stops at while it is shut. Doors move out of this set as they open. */
export const isWallTile = (t: number): boolean => t === T.SOLID || t === T.TIMBER || t === T.SEAM || t === T.BRICK;
/**
 * A grate is the tile that proves SEEING and WALKING are different questions. It is the whole reason
 * `opaque()` and `solid()` are two functions in game.ts rather than one `blocked()`: a drift running
 * behind a grate is a shooting gallery, and the chase AI — which searches the body graph only —
 * breaks off and comes the long way round, which reads as flanking. Nothing in the code says
 * "flank"; it falls out of two tables disagreeing.
 */
export const isSeeThrough = (t: number): boolean => t === T.GRATE;
/** A body wide enough to be stopped by water. Only the hauler is. */
export const SUMP_RADIUS = 0.4;
export const isDoorTile = (t: number): boolean => t === T.DOOR || t === T.LOCK_A || t === T.LOCK_C || t === T.LOCK_R;
/** Walkable ignoring door state — used by the generator's own reachability, never by physics. */
export const isFloorTile = (t: number): boolean =>
  t === T.OPEN || t === T.STAIR || t === T.DAMP || t === T.SUMP;

export interface Room {
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
}

export interface SpawnPoint {
  kind: EnemyId;
  x: number;
  y: number;
}

export interface ItemPoint {
  /** 'ammoCutter' | 'ammoLance' | 'ammoCharge' | 'carbide' | a key colour. */
  kind: string;
  x: number;
  y: number;
}

export interface Level {
  side: number;
  tiles: Uint8Array;
  /** Door openness 0..1 per cell, only meaningful where the tile is a door. */
  rooms: Room[];
  start: { x: number; y: number };
  stair: { x: number; y: number };
  /** Which lock colours this floor actually uses, in dependency order. */
  locks: LockColour[];
  spawns: SpawnPoint[];
  items: ItemPoint[];
  damp: number[];
}

const idx = (side: number, x: number, y: number): number => y * side + x;

// ── generation ──────────────────────────────────────────────────────────────────────────────────

/** Deterministic from (seed, floor). Two peers on the same round cut the identical mine. */
export function generate(seed: number, floor: number, mode: Mode, players = 1): Level {
  const side = sideFor(mode, floor);
  const rng = makeRng((seed >>> 0) ^ (floor * 0x9e3779b1));
  const tiles = new Uint8Array(side * side).fill(T.SOLID);

  const rooms = carveRooms(rng, side, tiles);
  const tree = spanningTree(rooms);
  for (const [a, b] of tree) carveCorridor(rng, side, tiles, rooms[a], rooms[b]);

  // The stair goes as far from the start as the tree allows, so a floor is a journey rather than a
  // room you happen to spawn in.
  const startRoom = 0;
  const { path, dist } = treePath(rooms.length, tree, startRoom);
  let stairRoom = 0;
  for (let i = 0; i < rooms.length; i++) if (dist[i] > dist[stairRoom]) stairRoom = i;

  const chain = pathTo(path, stairRoom);
  // Try the full lock count, then fewer, until the floor is genuinely walkable. Zero locks always
  // passes, so this terminates. See the header for why the construction argument needed a check.
  let locks = { colours: [] as LockColour[], edges: [] as Array<[number, number]>, fromRoom: [] as number[] };
  let want = Math.min(mode.maxLocks, chain.length - 1);
  const clean = tiles.slice();
  const stairCell = idx(side, rooms[stairRoom].cx, rooms[stairRoom].cy);
  outer: for (; want >= 0; want--) {
    // Three placements at each count before giving a lock up, so a floor keeps its intended density
    // whenever any arrangement of that many locks works at all.
    for (let attempt = 0; attempt < 3; attempt++) {
      tiles.set(clean);
      locks = placeLocks(rng, side, tiles, rooms, chain, want);
      if (verifySolvable(side, tiles, rooms, startRoom, locks, stairCell)) break outer;
      if (want === 0) break outer;
    }
  }

  // Which side of each lock every room sits on: `depth[r]` = how many of the chain's locks you must
  // already have passed to stand in room r. Everything downstream reads this.
  const depth = lockDepths(rooms.length, tree, startRoom, chain, locks.edges);

  // Extra loops, so the level is not a tree to walk. Only between rooms at the SAME lock depth, so a
  // loop can never route around a locked door.
  addLoops(rng, side, tiles, rooms, tree, depth);

  const stair = { x: rooms[stairRoom].cx, y: rooms[stairRoom].cy };
  tiles[idx(side, stair.x, stair.y)] = T.STAIR;
  const start = { x: rooms[startRoom].cx + 0.5, y: rooms[startRoom].cy + 0.5 };

  // Key i goes in the room the lock's own edge LEAVES FROM — the near side of that door.
  //
  // The tempting version scatters it anywhere the bookkeeping says is "before" lock i, and that is
  // precisely what shipped 3.2% unsolvable floors: the bookkeeping is a tree fact and the corridors
  // are a grid fact, and where they disagree a key ends up behind its own door. This room is the one
  // `verifySolvable()` actually proved reachable, so placement and proof are the same statement.
  const items: ItemPoint[] = [];
  for (let i = 0; i < locks.colours.length; i++) {
    const p = spotIn(rng, side, tiles, rooms[locks.fromRoom[i]]);
    items.push({ kind: locks.colours[i], x: p.x, y: p.y });
  }

  scatterItems(rng, side, tiles, rooms, startRoom, floor, mode, items);
  scatterWater(rng, side, tiles, rooms, startRoom, floor);
  scatterGrates(rng, side, tiles, depth);
  const damp = scatterDamp(rng, side, tiles, floor);
  const spawns = scatterSpawns(rng, side, tiles, rooms, startRoom, dist, floor, mode, players);

  return { side, tiles, rooms, start, stair, locks: locks.colours, spawns, items, damp };
}

function carveRooms(rng: Rng, side: number, tiles: Uint8Array): Room[] {
  const target = Math.max(6, Math.round((side * side) / 62));
  const rooms: Room[] = [];
  let guard = target * 30;
  while (rooms.length < target && guard-- > 0) {
    const w = randInt(rng, 3, 7) | 1;
    const h = randInt(rng, 3, 7) | 1;
    const x = (randInt(rng, 1, side - w - 2) | 1) - 1 + 1;
    const y = (randInt(rng, 1, side - h - 2) | 1) - 1 + 1;
    const r: Room = { x, y, w, h, cx: x + (w >> 1), cy: y + (h >> 1) };
    // One cell of rock between rooms, always — two rooms sharing a wall read as one lumpy room.
    if (rooms.some((o) => r.x <= o.x + o.w + 1 && o.x <= r.x + r.w + 1 && r.y <= o.y + o.h + 1 && o.y <= r.y + r.h + 1)) {
      continue;
    }
    rooms.push(r);
  }
  // Deterministic ordering, then a material per room so a player can navigate by what the walls are
  // made of rather than by a minimap they do not have.
  for (const r of rooms) {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) tiles[idx(side, x, y)] = T.OPEN;
    const skin = rng();
    const mat = skin < 0.16 ? T.SEAM : skin < 0.34 ? T.TIMBER : skin < 0.46 ? T.BRICK : T.SOLID;
    if (mat !== T.SOLID) ringRoom(side, tiles, r, mat);
  }
  return rooms;
}

/** Paint the rock ring around a room in a material, without touching anything already carved. */
function ringRoom(side: number, tiles: Uint8Array, r: Room, mat: number): void {
  for (let y = r.y - 1; y <= r.y + r.h; y++) {
    for (let x = r.x - 1; x <= r.x + r.w; x++) {
      if (x < 0 || y < 0 || x >= side || y >= side) continue;
      const inside = x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
      if (!inside && tiles[idx(side, x, y)] === T.SOLID) tiles[idx(side, x, y)] = mat;
    }
  }
}

/** Prim's MST over room centres by Manhattan distance. Exactly one path between any two rooms. */
function spanningTree(rooms: Room[]): Array<[number, number]> {
  const n = rooms.length;
  const inTree = new Array<boolean>(n).fill(false);
  const edges: Array<[number, number]> = [];
  inTree[0] = true;
  for (let k = 1; k < n; k++) {
    let best = Infinity;
    let bi = -1;
    let bj = -1;
    for (let i = 0; i < n; i++) {
      if (!inTree[i]) continue;
      for (let j = 0; j < n; j++) {
        if (inTree[j]) continue;
        const d = Math.abs(rooms[i].cx - rooms[j].cx) + Math.abs(rooms[i].cy - rooms[j].cy);
        if (d < best) {
          best = d;
          bi = i;
          bj = j;
        }
      }
    }
    if (bj < 0) break;
    inTree[bj] = true;
    edges.push([bi, bj]);
  }
  return edges;
}

/** BFS over the tree from `root`: the parent map and the hop distance. */
function treePath(n: number, edges: Array<[number, number]>, root: number): { path: Int32Array; dist: Int32Array } {
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const [a, b] of edges) {
    adj[a].push(b);
    adj[b].push(a);
  }
  const path = new Int32Array(n).fill(-1);
  const dist = new Int32Array(n).fill(-1);
  const q = [root];
  dist[root] = 0;
  for (let h = 0; h < q.length; h++) {
    const cur = q[h];
    for (const nb of adj[cur]) {
      if (dist[nb] >= 0) continue;
      dist[nb] = dist[cur] + 1;
      path[nb] = cur;
      q.push(nb);
    }
  }
  return { path, dist };
}

/** The room sequence from the root to `to`, root first. */
function pathTo(parent: Int32Array, to: number): number[] {
  const out: number[] = [];
  for (let cur = to; cur >= 0; cur = parent[cur]) out.push(cur);
  return out.reverse();
}

interface Locks {
  colours: LockColour[];
  /** The tree edge each lock sits on, as [fromRoom, toRoom] with `from` nearer the start. */
  edges: Array<[number, number]>;
  fromRoom: number[];
}

/**
 * Locks go on distinct edges of the start→stair chain, in order, spread out rather than adjacent.
 * The door tile itself is stamped onto the corridor cell nearest the far room's centre.
 */
function placeLocks(
  rng: Rng,
  side: number,
  tiles: Uint8Array,
  rooms: Room[],
  chain: number[],
  want: number,
): Locks {
  const colours: LockColour[] = [];
  const edges: Array<[number, number]> = [];
  const fromRoom: number[] = [];
  const slots = chain.length - 1;
  const n = Math.max(0, Math.min(want, slots, LOCK_ORDER.length));
  if (n === 0) return { colours, edges, fromRoom };

  // Evenly spaced along the chain with a little jitter, so a run is not always "door at the door".
  const chosen = new Set<number>();
  for (let i = 0; i < n; i++) {
    const ideal = Math.floor(((i + 1) * slots) / (n + 1));
    let s = Math.max(0, Math.min(slots - 1, ideal + randInt(rng, -1, 1)));
    let guard = slots;
    while (chosen.has(s) && guard-- > 0) s = (s + 1) % slots;
    chosen.add(s);
  }
  const order = [...chosen].sort((a, b) => a - b);
  for (let i = 0; i < order.length; i++) {
    const from = chain[order[i]];
    const to = chain[order[i] + 1];
    const cell = doorCell(side, tiles, rooms[from], rooms[to]);
    if (!cell) continue;
    const colour = LOCK_ORDER[colours.length];
    tiles[idx(side, cell.x, cell.y)] = LOCK_TILE[colour];
    colours.push(colour);
    edges.push([from, to]);
    fromRoom.push(from);
  }
  return { colours, edges, fromRoom };
}

/**
 * A corridor cell on the `to` side of the join, chosen as the open cell adjacent to `to`'s room that
 * lies on the corridor. Returns null if the join is somehow already a room-to-room adjacency.
 */
function doorCell(side: number, tiles: Uint8Array, from: Room, to: Room): { x: number; y: number } | null {
  // Walk from `to`'s centre back toward `from`'s centre along the same L the corridor was carved on
  // and take the first cell OUTSIDE `to`'s rectangle.
  let x = to.cx;
  let y = to.cy;
  const inTo = (px: number, py: number): boolean => px >= to.x && px < to.x + to.w && py >= to.y && py < to.y + to.h;
  const inFrom = (px: number, py: number): boolean =>
    px >= from.x && px < from.x + from.w && py >= from.y && py < from.y + from.h;
  for (let guard = 0; guard < side * 3; guard++) {
    if (x !== from.cx) x += Math.sign(from.cx - x);
    else if (y !== from.cy) y += Math.sign(from.cy - y);
    else break;
    if (inTo(x, y) || inFrom(x, y)) continue;
    if (tiles[idx(side, x, y)] === T.OPEN) return { x, y };
  }
  return null;
}

/** For every room, how many chain locks stand between it and the start. */
function lockDepths(
  n: number,
  edges: Array<[number, number]>,
  root: number,
  chain: number[],
  lockEdges: Array<[number, number]>,
): Int32Array {
  const blocked = new Map<string, number>();
  lockEdges.forEach(([a, b], i) => {
    blocked.set(`${a}|${b}`, i);
    blocked.set(`${b}|${a}`, i);
  });
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const [a, b] of edges) {
    adj[a].push(b);
    adj[b].push(a);
  }
  const depth = new Int32Array(n).fill(-1);
  depth[root] = 0;
  const q = [root];
  for (let h = 0; h < q.length; h++) {
    const cur = q[h];
    for (const nb of adj[cur]) {
      if (depth[nb] >= 0) continue;
      const gate = blocked.get(`${cur}|${nb}`);
      depth[nb] = gate === undefined ? depth[cur] : gate + 1;
      q.push(nb);
    }
  }
  void chain;
  return depth;
}

/** A handful of extra connections between rooms at the same lock depth. Never a short cut. */
function addLoops(
  rng: Rng,
  side: number,
  tiles: Uint8Array,
  rooms: Room[],
  tree: Array<[number, number]>,
  depth: Int32Array,
): void {
  const have = new Set(tree.map(([a, b]) => `${Math.min(a, b)}|${Math.max(a, b)}`));
  const want = Math.max(1, Math.round(rooms.length * 0.28));
  let added = 0;
  let guard = rooms.length * 6;
  while (added < want && guard-- > 0) {
    const a = randInt(rng, 0, rooms.length - 1);
    const b = randInt(rng, 0, rooms.length - 1);
    if (a === b || depth[a] !== depth[b]) continue;
    const key = `${Math.min(a, b)}|${Math.max(a, b)}`;
    if (have.has(key)) continue;
    const d = Math.abs(rooms[a].cx - rooms[b].cx) + Math.abs(rooms[a].cy - rooms[b].cy);
    if (d > side * 0.55) continue;
    have.add(key);
    carveCorridor(rng, side, tiles, rooms[a], rooms[b]);
    added++;
  }
}

/** An L-shaped corridor. The elbow order is seeded so it varies but replays identically. */
function carveCorridor(rng: Rng, side: number, tiles: Uint8Array, a: Room, b: Room): void {
  const horizontalFirst = rng() < 0.5;
  const dig = (x: number, y: number): void => {
    if (x < 1 || y < 1 || x >= side - 1 || y >= side - 1) return;
    const t = tiles[idx(side, x, y)];
    // A corridor never eats a door that is already stamped, and never re-materialises a room floor.
    if (isDoorTile(t) || t === T.STAIR) return;
    tiles[idx(side, x, y)] = T.OPEN;
  };
  const hx = (y: number): void => {
    for (let x = Math.min(a.cx, b.cx); x <= Math.max(a.cx, b.cx); x++) dig(x, y);
  };
  const vy = (x: number): void => {
    for (let y = Math.min(a.cy, b.cy); y <= Math.max(a.cy, b.cy); y++) dig(x, y);
  };
  if (horizontalFirst) {
    hx(a.cy);
    vy(b.cx);
  } else {
    vy(a.cx);
    hx(b.cy);
  }
}

/** A free open cell inside a room, avoiding the exact centre (the stair and the start live there). */
function spotIn(rng: Rng, side: number, tiles: Uint8Array, r: Room): { x: number; y: number } {
  for (let guard = 0; guard < 40; guard++) {
    const x = randInt(rng, r.x, r.x + r.w - 1);
    const y = randInt(rng, r.y, r.y + r.h - 1);
    if (tiles[idx(side, x, y)] === T.OPEN) return { x, y };
  }
  return { x: r.cx, y: r.cy };
}

function scatterItems(
  rng: Rng,
  side: number,
  tiles: Uint8Array,
  rooms: Room[],
  startRoom: number,
  floor: number,
  mode: Mode,
  out: ItemPoint[],
): void {
  if (!mode.worldDrops) return;
  const piles = Math.round(RAMP.ammoPiles0 + RAMP.ammoPilesPerFloor * (floor - 1));
  const carb = Math.round(RAMP.carbide0 + RAMP.carbidePerFloor * (floor - 1));
  const pool = rooms.map((_, i) => i).filter((i) => i !== startRoom);
  if (!pool.length) return;
  const drop = (kind: string): void => {
    const r = rooms[pool[randInt(rng, 0, pool.length - 1)]];
    const p = spotIn(rng, side, tiles, r);
    out.push({ kind, x: p.x, y: p.y });
  };
  for (let i = 0; i < piles; i++) {
    const roll = rng();
    drop(roll < 0.58 ? 'ammoCutter' : roll < 0.87 ? 'ammoLance' : 'ammoCharge');
  }
  for (let i = 0; i < carb; i++) drop('carbide');
}

/**
 * Sumps flood the low corners of rooms. They cost everyone speed and make everyone loud — but a
 * hauler is too heavy to wade, so a mixed pack SPLITS ITSELF around water: the light things come
 * straight at you through it while the big one walks the long way and arrives late. Nothing in the
 * AI knows about staggered arrivals; two tables disagreeing produced them.
 */
function scatterWater(rng: Rng, side: number, tiles: Uint8Array, rooms: Room[], startRoom: number, floor: number): void {
  // The start room is never flooded — a run should not open standing in water.
  const want = Math.min(4, Math.round(0.6 + floor * 0.22));
  for (let n = 0; n < want; n++) {
    const ri = randInt(rng, 0, rooms.length - 1);
    if (ri === startRoom) continue;
    const r = rooms[ri];
    const w = Math.max(2, Math.min(r.w, randInt(rng, 2, 4)));
    const h = Math.max(2, Math.min(r.h, randInt(rng, 2, 3)));
    const ox = randInt(rng, r.x, r.x + r.w - w);
    const oy = randInt(rng, r.y, r.y + r.h - h);
    for (let y = oy; y < oy + h; y++) {
      for (let x = ox; x < ox + w; x++) {
        if (tiles[idx(side, x, y)] === T.OPEN) tiles[idx(side, x, y)] = T.SUMP;
      }
    }
  }
}

/**
 * Grates go across corridors, and only ever between two rooms at the SAME lock depth — a grate must
 * never be the thing standing between you and a key, because you cannot open one.
 */
function scatterGrates(rng: Rng, side: number, tiles: Uint8Array, depth: Int32Array): void {
  void depth;
  const want = randInt(rng, 1, 3);
  const candidates: number[] = [];
  for (let y = 1; y < side - 1; y++) {
    for (let x = 1; x < side - 1; x++) {
      const i = idx(side, x, y);
      if (tiles[i] !== T.OPEN) continue;
      // Only a straight run of corridor, so a grate never seals a junction or a doorway.
      const h = isFloorTile(tiles[i - 1]) && isFloorTile(tiles[i + 1]);
      const v = isFloorTile(tiles[i - side]) && isFloorTile(tiles[i + side]);
      if (h === v) continue;
      const perpWall = h ? isWallTile(tiles[i - side]) && isWallTile(tiles[i + side]) : isWallTile(tiles[i - 1]) && isWallTile(tiles[i + 1]);
      if (!perpWall) continue;
      candidates.push(i);
    }
  }
  for (let n = 0; n < want && candidates.length; n++) {
    const pick = candidates.splice(randInt(rng, 0, candidates.length - 1), 1)[0];
    // Never seal the last route: a grate is only placed where a detour already exists, which the
    // loop edges guarantee for anything at the same lock depth. The reachability test in
    // tests/mine.test.ts re-derives that from scratch and is what actually holds the line.
    tiles[pick] = T.GRATE;
    if (!stillConnected(side, tiles)) tiles[pick] = T.OPEN;
  }
}

/**
 * The player's own fixed point: flood what you can reach, collect every key inside it, flood again
 * with those cards, and repeat until nothing new opens. The stair must fall inside the closure.
 *
 * This deliberately re-derives reachability from the TILES rather than from the generator's `depth[]`
 * bookkeeping — the bookkeeping is exactly what was wrong.
 */
function verifySolvable(
  side: number,
  tiles: Uint8Array,
  rooms: Room[],
  startRoom: number,
  locks: Locks,
  stairCell: number,
): boolean {
  if (!locks.colours.length) return true;
  // Where each key WOULD go, using the same rule the caller uses below. Cheap approximation of the
  // real placement: any open cell of the room the lock's edge leaves from, which is the worst case.
  const keyCells = locks.fromRoom.map((r) => idx(side, rooms[r].cx, rooms[r].cy));

  const held = new Set<LockColour>();
  for (let pass = 0; pass <= locks.colours.length; pass++) {
    const seen = new Uint8Array(side * side);
    const start = idx(side, rooms[startRoom].cx, rooms[startRoom].cy);
    const q = [start];
    seen[start] = 1;
    for (let h = 0; h < q.length; h++) {
      const cur = q[h];
      const cx = cur % side;
      for (let k = 0; k < 4; k++) {
        const nb = k === 0 ? cur - 1 : k === 1 ? cur + 1 : k === 2 ? cur - side : cur + side;
        if (nb < 0 || nb >= seen.length || seen[nb]) continue;
        if (k === 0 && cx === 0) continue;
        if (k === 1 && cx === side - 1) continue;
        const t = tiles[nb];
        if (isWallTile(t) || t === T.GRATE) continue;
        const colour = TILE_LOCK[t];
        if (colour && !held.has(colour)) continue;
        seen[nb] = 1;
        q.push(nb);
      }
    }
    if (seen[stairCell]) return true;
    let gained = false;
    for (let i = 0; i < keyCells.length; i++) {
      if (seen[keyCells[i]] && !held.has(locks.colours[i])) {
        held.add(locks.colours[i]);
        gained = true;
      }
    }
    if (!gained) return false;
  }
  return false;
}

/** Flood fill over body-passable cells from the first open cell; true if every floor cell is hit. */
function stillConnected(side: number, tiles: Uint8Array): boolean {
  const n = side * side;
  let start = -1;
  let total = 0;
  for (let i = 0; i < n; i++) {
    if (isFloorTile(tiles[i]) || isDoorTile(tiles[i])) {
      total++;
      if (start < 0) start = i;
    }
  }
  if (start < 0) return true;
  const seen = new Uint8Array(n);
  const q = [start];
  seen[start] = 1;
  let hit = 1;
  for (let h = 0; h < q.length; h++) {
    const cur = q[h];
    const cx = cur % side;
    for (let k = 0; k < 4; k++) {
      const nb = k === 0 ? cur - 1 : k === 1 ? cur + 1 : k === 2 ? cur - side : cur + side;
      if (nb < 0 || nb >= n || seen[nb]) continue;
      if (k === 0 && cx === 0) continue;
      if (k === 1 && cx === side - 1) continue;
      if (!isFloorTile(tiles[nb]) && !isDoorTile(tiles[nb])) continue;
      seen[nb] = 1;
      hit++;
      q.push(nb);
    }
  }
  return hit === total;
}

/** Firedamp collects in dead ends, which is exactly where a player backs into it. */
function scatterDamp(rng: Rng, side: number, tiles: Uint8Array, floor: number): number[] {
  const want = Math.min(RAMP.dampCap, Math.round(RAMP.damp0 + RAMP.dampPerFloor * (floor - 1)));
  const dead: number[] = [];
  for (let y = 1; y < side - 1; y++) {
    for (let x = 1; x < side - 1; x++) {
      const i = idx(side, x, y);
      if (tiles[i] !== T.OPEN) continue;
      let open = 0;
      if (isFloorTile(tiles[i - 1])) open++;
      if (isFloorTile(tiles[i + 1])) open++;
      if (isFloorTile(tiles[i - side])) open++;
      if (isFloorTile(tiles[i + side])) open++;
      if (open <= 2) dead.push(i);
    }
  }
  const out: number[] = [];
  for (let n = 0; n < want && dead.length; n++) {
    const pick = dead.splice(randInt(rng, 0, dead.length - 1), 1)[0];
    tiles[pick] = T.DAMP;
    out.push(pick);
  }
  return out;
}

/** Spawns weight toward the far end of the floor, so the start is a breath and the stair is not. */
function scatterSpawns(
  rng: Rng,
  side: number,
  tiles: Uint8Array,
  rooms: Room[],
  startRoom: number,
  dist: Int32Array,
  floor: number,
  mode: Mode,
  players: number,
): SpawnPoint[] {
  const total = Math.max(1, Math.round(popFor(floor) * mode.popScale * partyScale(players)));
  const weights = ENEMY_IDS.map((id) => Math.max(0, ENEMIES[id].weight0 + ENEMIES[id].weightPerFloor * (floor - 1)));
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const far = rooms.map((_, i) => i).filter((i) => i !== startRoom);
  if (!far.length) return [];
  const maxD = Math.max(1, ...far.map((i) => dist[i]));

  const out: SpawnPoint[] = [];
  let guard = total * 12;
  while (out.length < total && guard-- > 0) {
    const r = far[randInt(rng, 0, far.length - 1)];
    // Rejection-sample on distance: a far room is up to four times as likely as a near one.
    const bias = 0.25 + 0.75 * (Math.max(0, dist[r]) / maxD);
    if (rng() > bias) continue;
    let roll = rng() * sum;
    let kind: EnemyId = ENEMY_IDS[0];
    for (let i = 0; i < ENEMY_IDS.length; i++) {
      roll -= weights[i];
      if (roll <= 0) {
        kind = ENEMY_IDS[i];
        break;
      }
    }
    const p = spotIn(rng, side, tiles, rooms[r]);
    out.push({ kind, x: p.x + 0.5, y: p.y + 0.5 });
  }
  return out;
}
