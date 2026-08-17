// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// See ADDITIONAL-TERMS.md for the section 7(b) attribution requirement.
//
// net-lifecycle.test.ts — the live-P2P transport gate: ONE ROOM PER SESSION, and the most valuable
// trivial test in this suite.
//
// A rematch versions rounds INSIDE the living room. Leaving and rejoining to "reset" hands back a
// DYING room object — Trystero memoizes joinRoom on appId+roomId and defers its teardown behind a
// timer — and every peer then elects itself host: both players sitting in the right room code,
// alone, permanently, with a lobby that looks completely normal. Two shipped games in this fleet had
// exactly that.
//
// The engine makes the trap throw. This file pins that, plus the one-join invariant. No transport,
// no timing model, no browser: its triviality IS the point. Do not delete it for looking obvious —
// tests/rematch.test.ts runs on a fake bus that sits ABOVE Trystero's room cache and so structurally
// cannot contain this defect, which is precisely how it shipped twice.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const joinRoom = vi.fn();

vi.mock('trystero', () => {
  interface FakeRoom {
    makeAction: (name: string) => [ReturnType<typeof vi.fn>, (cb: unknown) => void];
    onPeerJoin: (cb: unknown) => void;
    onPeerLeave: (cb: unknown) => void;
    getPeers: () => Record<string, unknown>;
    leave: () => Promise<void>;
  }
  const make = (): FakeRoom => ({
    makeAction: () => [vi.fn(), () => {}],
    onPeerJoin: () => {},
    onPeerLeave: () => {},
    getPeers: () => ({}),
    // Trystero's real leave() is async and defers its teardown behind a timer — that deferral is the
    // whole reason the rejoin trap exists, so the fake keeps it. See trystero-rejoin.test.ts, which
    // pins the real library's version of this.
    leave: () => new Promise<void>((res) => setTimeout(res, 0)),
  });
  return {
    joinRoom: (...args: unknown[]) => {
      joinRoom(...args);
      return make();
    },
    selfId: 'self-peer',
  };
});

vi.mock('trystero/nostr', () => ({ getRelaySockets: () => ({}) }));

import { createNet, netStats, resetNetStats, roomAppId } from '@ben-gy/game-engine/net';

const CFG = { appId: roomAppId('deepshaft'), roomId: 'K7QM' };

describe('one join per session', () => {
  beforeEach(() => {
    resetNetStats();
    joinRoom.mockClear();
  });

  it('a whole multi-round session joins exactly once', async () => {
    const net = createNet(CFG);
    net.channel('mv', () => {});
    net.onPeersChange(() => {});
    net.channel('mv', () => {});
    net.onPeersChange(() => {});

    expect(netStats().joins, 'a rematch must version rounds INSIDE the room').toBe(1);
    expect(joinRoom).toHaveBeenCalledTimes(1);

    await net.leave();
    expect(netStats().active).toEqual([]);
  });

  it('leaving and coming back later is one join each, not a leak', async () => {
    const a = createNet(CFG);
    await a.leave();
    const b = createNet(CFG);
    expect(netStats().joins).toBe(2);
    await b.leave();
  });

  it('the appId carries the wire revision, never a bare slug', () => {
    // Two builds with incompatible move words must not share a mesh: they would form a room, agree
    // on nothing, and read as a desync rather than as "one of you is on a stale tab".
    expect(CFG.appId).not.toBe('deepshaft');
    expect(CFG.appId).toMatch(/^deepshaft@\d+$/);
  });

  it('the game channel name fits Trystero’s 12-byte budget', () => {
    expect('mv'.length).toBeLessThanOrEqual(12);
  });
});

describe('the leave/rejoin trap fails loudly', () => {
  beforeEach(() => {
    resetNetStats();
    joinRoom.mockClear();
  });

  it('throws when the same room is rejoined while still tearing down', async () => {
    const net = createNet(CFG);
    const pending = net.leave();
    expect(() => createNet(CFG)).toThrow(/tearing down/i);
    await pending;
    const again = createNet(CFG);
    expect(netStats().joins).toBe(2);
    await again.leave();
  });

  it('throws when the same room is joined twice concurrently', async () => {
    const net = createNet(CFG);
    expect(() => createNet(CFG)).toThrow(/already joined/i);
    expect(netStats().joins).toBe(1);
    await net.leave();
  });

  it('a DIFFERENT room on the same page is not blocked', async () => {
    const a = createNet(CFG);
    const b = createNet({ ...CFG, roomId: 'ZZ99' });
    expect(netStats().joins).toBe(2);
    await Promise.all([a.leave(), b.leave()]);
    expect(netStats().active).toEqual([]);
  });
});

describe('a net that was never left still holds its slot', () => {
  afterEach(() => resetNetStats());
  it('reports itself as active so a stray second createNet is caught', () => {
    resetNetStats();
    createNet(CFG);
    expect(netStats().active).toEqual([`${CFG.appId}/K7QM`]);
  });
});
