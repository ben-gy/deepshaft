// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// See ADDITIONAL-TERMS.md for the section 7(b) attribution requirement.
//
// no-deadlock.test.ts — the live-P2P gate that says a peer who never taps must NOT hold the room.
//
// Deepshaft rooms are two to four players and fill by an invite link into a group chat, so somebody
// opening the link and putting the phone down is the ORDINARY case, not the edge. Quorum starts a
// visible countdown; when it expires the run starts without the straggler, who still receives the
// start and spectates. Unanimity is never made to wait. Losing quorum cancels the clock.
//
// `startsInMs` is part of the contract rather than an implementation detail: a silent wait and a
// hang are indistinguishable from the sofa, and the lobby has to be able to render the difference.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRounds, type RoundInfo, type Rounds } from '@ben-gy/game-engine/rematch';
import { Bus } from './helpers/bus';

const GRACE_MS = 8000;

interface Peer {
  id: string;
  rounds: Rounds;
  got: RoundInfo[];
}

let bus: Bus;

function seat(id: string): Peer {
  const net = bus.join(id);
  const peer: Peer = { id, rounds: null as unknown as Rounds, got: [] };
  peer.rounds = createRounds({
    net,
    playerName: id.toUpperCase(),
    minPlayers: 2,
    graceMs: GRACE_MS,
    roundOpts: () => ({ mode: 'stope' }),
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

/** Three peers, past the roster-settle window, so a start is not deferred for mesh formation. */
function room(): [Peer, Peer, Peer] {
  const a = seat('a');
  const b = seat('b');
  const c = seat('c');
  bus.flush();
  tick(5000);
  return [a, b, c];
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  bus = new Bus();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a straggler cannot hold the room', () => {
  it('quorum starts a countdown that is VISIBLE while it runs', () => {
    const [a, b] = room();
    expect(a.rounds.state().startsInMs, 'no countdown before quorum').toBeNull();

    a.rounds.vote();
    b.rounds.vote();
    bus.flush();

    const first = a.rounds.state().startsInMs;
    expect(first, 'a silent wait is indistinguishable from a hang').not.toBeNull();
    expect(first as number).toBeGreaterThan(0);
    expect(first as number).toBeLessThanOrEqual(GRACE_MS);

    tick(2000);
    const later = a.rounds.state().startsInMs;
    expect(later, 'the countdown is not counting down').toBeLessThan(first as number);
    expect(later as number).toBeGreaterThan(0);
  });

  it('the round starts WITHOUT the straggler when the countdown expires', () => {
    const [a, b, c] = room();
    a.rounds.vote();
    b.rounds.vote();
    bus.flush();
    expect(a.got).toHaveLength(0);

    tick(GRACE_MS + 2000);

    expect(a.got, 'the room deadlocked on a peer that never tapped').toHaveLength(1);
    expect(b.got).toHaveLength(1);
    expect(a.got[0].players.map((p) => p.id)).toEqual(['a', 'b']);
    expect(c.got, 'the straggler must still receive the start so it can spectate').toHaveLength(1);
    expect(c.got[0].seated).toBe(false);
    expect(a.rounds.state().startsInMs).toBeNull();
  });

  it('the spectator can queue for the NEXT round rather than being stuck for ever', () => {
    const [a, b, c] = room();
    a.rounds.vote();
    b.rounds.vote();
    bus.flush();
    tick(GRACE_MS + 2000);
    expect(c.got[0].seated).toBe(false);

    c.rounds.vote();
    bus.flush();
    expect(c.rounds.state().voted).toBe(true);

    a.rounds.finish();
    b.rounds.finish();
    tick(5000);
    a.rounds.vote();
    b.rounds.vote();
    bus.flush();
    tick(GRACE_MS + 2000);

    expect(a.got).toHaveLength(2);
    // Three in the roster is a three-crew Deepshaft descent, not a two-crew one with an onlooker.
    expect(a.got[1].players.map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(c.got[1].seated).toBe(true);
  });
});

describe('unanimity is not made to wait', () => {
  it('everyone voting starts the round immediately, with no countdown', () => {
    const [a, b, c] = room();
    a.rounds.vote();
    b.rounds.vote();
    c.rounds.vote();
    bus.flush();

    expect(a.got).toHaveLength(1);
    expect(a.rounds.state().startsInMs).toBeNull();
    expect(a.got[0].players).toHaveLength(3);
  });
});

describe('losing quorum cancels the countdown', () => {
  it('a peer backing out stops the clock, and no round starts', () => {
    const [a, b] = room();
    a.rounds.vote();
    b.rounds.vote();
    bus.flush();
    expect(a.rounds.state().startsInMs).not.toBeNull();

    tick(2000);
    b.rounds.unvote();
    bus.flush();
    tick(500);

    expect(a.rounds.state().startsInMs).toBeNull();
    tick(GRACE_MS + 2000);
    expect(a.got).toHaveLength(0);
    expect(a.rounds.state().votes.map((v) => v.id)).toEqual(['a']);
  });

  it('re-reaching quorum arms a FRESH countdown, not a resumed one', () => {
    const [a, b] = room();
    a.rounds.vote();
    b.rounds.vote();
    bus.flush();
    tick(4000);
    b.rounds.unvote();
    bus.flush();
    tick(500);
    expect(a.rounds.state().startsInMs).toBeNull();

    b.rounds.vote();
    bus.flush();

    const restarted = a.rounds.state().startsInMs;
    expect(restarted).not.toBeNull();
    expect(restarted as number).toBeGreaterThan(GRACE_MS - 1000);
  });
});
