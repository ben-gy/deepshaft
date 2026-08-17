// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// See ADDITIONAL-TERMS.md for the section 7(b) attribution requirement.
//
// rematch.test.ts — the live-P2P round protocol.
//
// A multiplayer session is a LOOP: lobby → run → results → run. "Play again" has to start a new
// round inside the SAME room, with one host, one seed, one mode and one frozen roster — because in
// Deepshaft every one of those is an input to `derive(seed, mode, players, log)`, the pure function
// that lays out the mine. Two peers that disagree about any of them are not slightly out of step:
// the host is resolving hits against one shaft while a guest walks a different one, and every
// position it broadcasts lands inside a wall.
//
// The transport half of this gate lives in net-lifecycle.test.ts and is the one that actually
// catches the leave/rejoin trap: a fake bus sits above Trystero's room cache and structurally cannot
// contain that defect, so neither file substitutes for the other.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRounds, type RoundInfo, type Rounds } from '@ben-gy/game-engine/rematch';
import { Bus } from './helpers/bus';

// ── LOCAL STAND-INS for ../src/modes and ../src/rules ────────────────────────────────────────────
// Deepshaft's game modules do not exist yet, so this file carries a minimal local copy of the only
// two things the ROUND PROTOCOL needs from them: a mode table that is safe to index with an id off
// the wire, and a pure `derive(seed, mode, players, log)` that turns a round start into an opening
// state. Realmfold's version dealt a card reveal; Deepshaft's lays out the mine — the spawn schedule
// and the seat order — so the field the equality assertion names is `spawns` where realmfold's was
// `reveal`. The claim under test is unchanged: two peers handed the same start compute byte-
// identical opening state. Delete this block and import from ../src/modes and ../src/rules the
// moment those land; the tests below should not need to change.

interface Mode {
  id: string;
  /** Levels in the descent before the lift reaches the sump. */
  depth: number;
  /** Horde-density multiplier — how hard the mine pushes back per crew member. */
  hordeMul: number;
}

const MODES: Record<string, Mode> = {
  stope: { id: 'stope', depth: 8, hordeMul: 1 },
  adit: { id: 'adit', depth: 5, hordeMul: 1.5 },
  lode: { id: 'lode', depth: 12, hordeMul: 0.75 },
};

const DEFAULT_MODE = 'stope';

/** Guarded with Object.hasOwn: a bare `MODES[id] ||` lets 'constructor' through as a Mode of
 *  undefined fields, and this id arrives off the wire inside a round start. */
function modeOf(id: string | null | undefined): Mode {
  if (typeof id === 'string' && Object.hasOwn(MODES, id)) return MODES[id];
  return MODES[DEFAULT_MODE];
}

interface State {
  seed: number;
  mode: string;
  players: number;
  /** The mine's spawn schedule, derived — never rolled live, or no two peers would agree. */
  spawns: number[];
  /** Seat order, seeded-shuffled: which crew member takes which spawn point. */
  order: number[];
}

/** The whole opening state from its inputs, and nothing else. No Math.random, no Date.now — those
 *  are exactly the two ways a "deterministic" derive stops being one. */
function derive(seed: number, modeId: string, players: number, log: readonly number[]): State {
  const mode = modeOf(modeId);
  let s = (seed ^ 0x9e3779b9) >>> 0;
  const rnd = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };

  const spawns: number[] = [];
  const waves = Math.max(1, Math.round(mode.depth * players * mode.hordeMul));
  for (let i = 0; i < waves; i++) spawns.push(Math.floor(rnd() * 64));

  const order = [...Array(players).keys()];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  // The move log folds in after the layout, so replaying it is order-independent — the property the
  // whole-log wire protocol rests on.
  for (const word of [...log].sort((x, y) => x - y)) spawns.push(word & 0xff);

  return { seed, mode: mode.id, players, spawns, order };
}

/** FNV-1a over everything a peer could disagree about. Two peers whose digests differ are playing
 *  different games from the same room code. */
function digest(st: State): number {
  let h = 0x811c9dc5;
  const mix = (n: number): void => {
    h ^= n >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  };
  mix(st.seed);
  for (let i = 0; i < st.mode.length; i++) mix(st.mode.charCodeAt(i));
  mix(st.players);
  for (const v of st.spawns) mix(v);
  for (const v of st.order) mix(v);
  return h >>> 0;
}
// ── end stand-ins ────────────────────────────────────────────────────────────────────────────────

interface Peer {
  id: string;
  rounds: Rounds<{ mode: string }>;
  got: Array<RoundInfo<{ mode: string }>>;
}

let bus: Bus;

function seat(id: string, mode = 'stope'): Peer {
  const net = bus.join(id);
  const peer: Peer = { id, rounds: null as unknown as Rounds<{ mode: string }>, got: [] };
  peer.rounds = createRounds<{ mode: string }>({
    net,
    playerName: id.toUpperCase(),
    minPlayers: 2,
    graceMs: 8000,
    roundOpts: () => ({ mode }),
    onRound: (info) => peer.got.push(info),
  });
  return peer;
}

function tick(ms: number): void {
  for (let t = 0; t < ms; t += 250) {
    vi.advanceTimersByTime(250);
    bus.flush();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  // A deterministic but VARYING stand-in. A constant would make every round's seed identical, which
  // silently defeats the "a rematch cuts a fresh mine" assertion below.
  let n = 0x2f6e2b1;
  vi.spyOn(Math, 'random').mockImplementation(() => {
    n = (Math.imul(n, 1664525) + 1013904223) >>> 0;
    return n / 4294967296;
  });
  bus = new Bus();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('play again starts exactly one round, and every peer agrees about it', () => {
  it('one seed, one roster, one round number, one host', () => {
    const a = seat('a');
    const b = seat('b');
    bus.flush();
    tick(5000);

    a.rounds.vote();
    b.rounds.vote();
    bus.flush();

    expect(a.got).toHaveLength(1);
    expect(b.got).toHaveLength(1);
    expect(a.got[0].seed, 'a different seed on each peer is a desync by construction').toBe(b.got[0].seed);
    expect(a.got[0].round).toBe(b.got[0].round);
    expect(a.got[0].players.map((p) => p.id)).toEqual(b.got[0].players.map((p) => p.id));
    expect(a.got[0].seated && b.got[0].seated).toBe(true);
    // Exactly one host, not "at least one": two peers each believing they run the session is the
    // split-room failure, and it looks identical to a healthy lobby until somebody taps Start.
    expect([a.got[0].isHost, b.got[0].isHost].filter(Boolean)).toHaveLength(1);
  });

  it('the frozen roster is what makes a seat index mean the same thing on both peers', () => {
    const a = seat('a');
    const b = seat('b');
    bus.flush();
    tick(5000);
    a.rounds.vote();
    b.rounds.vote();
    bus.flush();

    // The roster ORDER is the seat assignment — main.ts seats roster[0..3] — so index equality above
    // is only half the claim. This is the other half: the two peers' opening states are the same
    // bytes, which is the property the whole host-authoritative design rests on — a guest that
    // derived a different mine could not even render the shaft the host is shooting down.
    const sa = derive(a.got[0].seed, modeOf(a.got[0].opts?.mode).id, a.got[0].players.length, []);
    const sb = derive(b.got[0].seed, modeOf(b.got[0].opts?.mode).id, b.got[0].players.length, []);
    expect(digest(sa)).toBe(digest(sb));
    expect(sa.spawns).toEqual(sb.spawns);
    expect(sa.order).toEqual(sb.order);

    // …and the equality above is only worth anything if derive actually READS the seed. A layout
    // that ignored it would make every assertion in this test pass while agreeing about nothing.
    expect(digest(derive(a.got[0].seed ^ 0x5bf03635, modeOf(a.got[0].opts?.mode).id, a.got[0].players.length, []))).not.toBe(
      digest(sa),
    );
  });

  it('the HOST’s mode is what the room plays — a guest’s own pick is not consulted', () => {
    const a = seat('a', 'adit');
    const b = seat('b', 'lode');
    bus.flush();
    tick(5000);
    expect(bus.peers()[0]).toBe('a');

    a.rounds.vote();
    b.rounds.vote();
    bus.flush();

    expect(modeOf(a.got[0].opts?.mode).id).toBe('adit');
    expect(modeOf(b.got[0].opts?.mode).id, 'the guest must play the host’s mode, not its own').toBe('adit');
  });

  it('a second round is a NEW round in the same room, with a fresh seed', () => {
    const a = seat('a');
    const b = seat('b');
    bus.flush();
    tick(5000);
    a.rounds.vote();
    b.rounds.vote();
    bus.flush();

    a.rounds.finish();
    b.rounds.finish();
    tick(5000);
    a.rounds.vote();
    b.rounds.vote();
    bus.flush();

    expect(a.got).toHaveLength(2);
    expect(b.got).toHaveLength(2);
    expect(a.got[1].round).toBeGreaterThan(a.got[0].round);
    expect(a.got[1].seed).not.toBe(a.got[0].seed);
    expect(a.got[1].seed).toBe(b.got[1].seed);
  });

  it('voting twice does not start two rounds', () => {
    const a = seat('a');
    const b = seat('b');
    bus.flush();
    tick(5000);
    a.rounds.vote();
    a.rounds.vote();
    b.rounds.vote();
    b.rounds.vote();
    bus.flush();
    tick(5000);
    expect(a.got).toHaveLength(1);
    expect(b.got).toHaveLength(1);
  });
});

describe('a start that is not the current one is ignored', () => {
  it('a duplicate start does not re-deal the round under the players', () => {
    const a = seat('a');
    const b = seat('b');
    bus.flush();
    tick(5000);
    a.rounds.vote();
    b.rounds.vote();
    bus.flush();

    const live = b.got[0];
    // The host's ack ladder re-sends a start until every peer confirms it, so a peer receiving the
    // same start twice is the NORMAL case, not a fault. Replaying it would cut b a fresh mine
    // several levels into the descent while a played on.
    bus.inject('a', 'rs', { round: live.round, seed: live.seed ^ 0x5bf03635, roster: live.players, opts: { mode: 'adit' } });
    bus.flush();
    tick(1000);

    expect(b.got).toHaveLength(1);
    expect(b.got[0].seed).toBe(live.seed);
    expect(modeOf(b.got[0].opts?.mode).id).toBe('stope');
  });

  it('a stale start from an earlier round cannot drag a peer backwards', () => {
    const a = seat('a');
    const b = seat('b');
    bus.flush();
    tick(5000);
    a.rounds.vote();
    b.rounds.vote();
    bus.flush();
    a.rounds.finish();
    b.rounds.finish();
    tick(5000);
    a.rounds.vote();
    b.rounds.vote();
    bus.flush();
    expect(b.got).toHaveLength(2);

    const stale = a.got[0];
    bus.inject('a', 'rs', { round: stale.round, seed: stale.seed, roster: stale.players, opts: stale.opts });
    bus.flush();
    tick(1000);

    expect(b.got, 'the round number is monotonic — a late delivery is not a rematch').toHaveLength(2);
    expect(b.rounds.state().round).toBe(a.got[1].round);
  });

  it('a start from a peer that is not the host is not a start at all', () => {
    const a = seat('a');
    const b = seat('b');
    const c = seat('c');
    bus.flush();
    tick(5000);
    expect(bus.peers()[0]).toBe('a');

    // c has no authority to start anything, and 'seed 1, roster of one' is what a confused or
    // malicious peer would send. Honouring it would drop b into a one-player Deepshaft descent — and
    // Deepshaft is co-op, so a crew of one is not a game at all.
    bus.inject('c', 'rs', { round: 1, seed: 1, roster: [{ id: 'c', name: 'C' }], opts: { mode: 'stope' } });
    bus.flush();
    tick(1000);

    expect(b.got).toHaveLength(0);
    expect(a.got).toHaveLength(0);
    void c.rounds;
  });
});

describe('nobody is stranded', () => {
  it('a peer that leaves is dropped from the roster rather than deadlocking it', () => {
    const a = seat('a');
    const b = seat('b');
    const c = seat('c');
    bus.flush();
    tick(5000);

    void c.rounds;
    bus.leave('c');
    bus.flush();
    tick(1000);

    a.rounds.vote();
    b.rounds.vote();
    bus.flush();
    tick(9000);

    expect(a.got).toHaveLength(1);
    expect(a.got[0].players.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('a promoted host can still run the rematch after the old host goes', () => {
    const a = seat('a');
    const b = seat('b');
    const c = seat('c');
    bus.flush();
    tick(5000);
    expect(bus.peers()[0]).toBe('a');
    void a.rounds;

    bus.leave('a');
    bus.flush();
    tick(2000);
    expect(bus.peers()[0], 'b is now the incumbent').toBe('b');

    b.rounds.vote();
    c.rounds.vote();
    bus.flush();
    tick(9000);

    expect(b.got, 'the survivors must be able to start another round').toHaveLength(1);
    expect(c.got).toHaveLength(1);
    expect(b.got[0].seed).toBe(c.got[0].seed);
    expect(b.got[0].players.map((p) => p.id)).toEqual(['b', 'c']);
    expect(b.got[0].round).toBeGreaterThan(0);
  });
});
