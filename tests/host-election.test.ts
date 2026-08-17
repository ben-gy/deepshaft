// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// See ADDITIONAL-TERMS.md for the section 7(b) attribution requirement.
//
// host-election.test.ts — the live-P2P election gate.
//
// Deepshaft is host-authoritative co-op, so the host owns the SESSION — which run starts next, with
// which seed, roster and mode — AND the mine itself: enemy spawns, damage and the lift are all
// resolved on one peer and broadcast. That is a bigger job than a hostless lockstep game gives it,
// which only sharpens the requirement: it has to be exactly ONE peer, and it has to be the
// INCUMBENT, because the engine's model is incumbency with terms, not re-election every time
// somebody joins. Two peers each believing they host the room means two mines, two spawn streams and
// two different runs under one room code.
//
// Peer ids are FIXED ('a', 'm', 'z') so id ORDER is deliberate. A test using real random ids passes
// about half the time and proves nothing, which is exactly how a stolen-host bug survives a clean
// two-tab run. Each simulated peer also gets its OWN module instance (resetModules + doMock +
// dynamic import), because trystero's selfId and net.ts's join registry are one-per-page globals —
// sharing them would make every "peer" the same peer.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Net } from '@ben-gy/game-engine/net';

interface Msg {
  from: string;
  to?: string | string[];
  name: string;
  data: unknown;
}

class Node {
  peers = new Set<string>();
  actions = new Map<string, (data: unknown, from: string) => void>();
  onJoin: Array<(id: string) => void> = [];
  onLeave: Array<(id: string) => void> = [];
  constructor(readonly id: string) {}
}

/** A mesh with explicitly wired edges, so "a and z cannot see each other" is a state a test can ask
 *  for rather than a timing accident. */
class Mesh {
  nodes = new Map<string, Node>();
  queue: Msg[] = [];

  node(id: string): Node {
    let n = this.nodes.get(id);
    if (!n) {
      n = new Node(id);
      this.nodes.set(id, n);
    }
    return n;
  }

  room(id: string): unknown {
    const node = this.node(id);
    return {
      makeAction: (name: string) => [
        (data: unknown, to?: string | string[]) => {
          this.queue.push({ from: id, to, name, data });
        },
        (cb: (data: unknown, from: string) => void) => node.actions.set(name, cb),
      ],
      onPeerJoin: (cb: (p: string) => void) => node.onJoin.push(cb),
      onPeerLeave: (cb: (p: string) => void) => node.onLeave.push(cb),
      getPeers: () => Object.fromEntries([...node.peers].map((p) => [p, {}])),
      leave: () => Promise.resolve(),
    };
  }

  connect(a: string, b: string): void {
    this.node(a).peers.add(b);
    this.node(b).peers.add(a);
    for (const cb of this.node(a).onJoin) cb(b);
    for (const cb of this.node(b).onJoin) cb(a);
  }

  disconnect(a: string, b: string): void {
    this.node(a).peers.delete(b);
    this.node(b).peers.delete(a);
    for (const cb of this.node(a).onLeave) cb(b);
    for (const cb of this.node(b).onLeave) cb(a);
  }

  drop(id: string): void {
    for (const other of [...this.node(id).peers]) this.disconnect(id, other);
  }

  flush(): void {
    for (let guard = 0; this.queue.length && guard < 500; guard++) {
      const m = this.queue.shift() as Msg;
      const targets = m.to === undefined ? [...this.node(m.from).peers] : Array.isArray(m.to) ? m.to : [m.to];
      for (const t of targets) {
        const node = this.nodes.get(t);
        // A message only arrives if the edge still exists in BOTH directions — a dropped peer's
        // in-flight announce must not resurrect it.
        if (!node || !node.peers.has(m.from)) continue;
        node.actions.get(m.name)?.(JSON.parse(JSON.stringify(m.data)), m.from);
      }
    }
    expect(this.queue.length, 'message storm — the protocol did not converge').toBe(0);
  }
}

let mesh: Mesh;

async function spawn(id: string, claimHost = false): Promise<Net> {
  vi.resetModules();
  vi.doMock('trystero', () => ({ joinRoom: () => mesh.room(id), selfId: id }));
  vi.doMock('trystero/nostr', () => ({ getRelaySockets: () => ({}) }));
  const { createNet, roomAppId } = await import('@ben-gy/game-engine/net');
  return createNet({ appId: roomAppId('deepshaft'), roomId: 'ROOM', claimHost });
}

function tick(ms: number): void {
  for (let t = 0; t < ms; t += 250) {
    vi.advanceTimersByTime(250);
    mesh.flush();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  mesh = new Mesh();
});

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock('trystero');
  vi.doUnmock('trystero/nostr');
});

describe('(a) an incumbent keeps its room', () => {
  it('a joiner with a LOWER id does not take a live room', async () => {
    const z = await spawn('z', true);
    const a = await spawn('a');
    mesh.connect('z', 'a');
    mesh.flush();

    expect(z.isHost(), 'the incumbent must keep hosting').toBe(true);
    expect(a.isHost(), 'a lower id is not a claim to a room somebody is already hosting').toBe(false);
    expect(a.host()).toBe('z');
    expect(a.hostSettled()).toBe(true);

    tick(15000);
    expect(z.isHost()).toBe(true);
    expect(a.isHost()).toBe(false);
  });
});

describe('(b) silence is not a mandate', () => {
  it('a peer that has heard nothing is not host, and knows it has not settled', async () => {
    const a = await spawn('a');
    tick(20000);
    // hostSettled() is what the lobby gates its mode picker on. A peer that assumed the room the
    // moment it was alone would paint itself the host of a room it has not found yet.
    expect(a.hostSettled()).toBe(false);
    expect(a.isHost()).toBe(false);
    expect(a.host()).toBeNull();
  });

  it('two peers who cannot see each other are BOTH non-host', async () => {
    const a = await spawn('a');
    const z = await spawn('z');
    tick(20000);
    expect(a.isHost()).toBe(false);
    expect(z.isHost()).toBe(false);
  });

  it('but a room with peers present and nobody claiming elects at the LOWEST term', async () => {
    const a = await spawn('a');
    const z = await spawn('z');
    mesh.connect('a', 'z');
    mesh.flush();
    tick(20000);
    expect(a.isHost()).toBe(true);
    expect(z.isHost()).toBe(false);
    expect(z.host()).toBe('a');
    expect(a.hostEpoch()).toBe(1);
  });
});

describe('(c) a host leaving promotes exactly one survivor', () => {
  it('every survivor agrees who took over, at a higher term', async () => {
    const a = await spawn('a', true);
    const m = await spawn('m');
    const z = await spawn('z');
    mesh.connect('a', 'm');
    mesh.connect('a', 'z');
    mesh.connect('m', 'z');
    mesh.flush();
    tick(1000);

    expect([a.isHost(), m.isHost(), z.isHost()]).toEqual([true, false, false]);
    const before = a.hostEpoch();

    mesh.drop('a');
    mesh.flush();
    tick(1000);

    const hosts = [m.host(), z.host()];
    expect(new Set(hosts).size, `survivors disagree: ${hosts.join(' vs ')}`).toBe(1);
    expect(hosts[0], 'min-id among the survivors').toBe('m');
    expect([m.isHost(), z.isHost()]).toEqual([true, false]);
    expect(m.hostEpoch(), 'a transfer must mint a strictly higher term').toBe(before + 1);
    expect(z.hostEpoch()).toBe(before + 1);
  });
});

describe('(d) a non-host leaving changes nothing', () => {
  it('the incumbent keeps the room at the same term', async () => {
    const a = await spawn('a', true);
    const m = await spawn('m');
    const z = await spawn('z');
    mesh.connect('a', 'm');
    mesh.connect('a', 'z');
    mesh.connect('m', 'z');
    mesh.flush();
    tick(1000);

    const epoch = a.hostEpoch();
    mesh.drop('z');
    mesh.flush();
    tick(3000);

    expect(a.isHost()).toBe(true);
    expect(m.host()).toBe('a');
    // A bumped term here would restart the ack ladder and re-gossip a start for no reason at all.
    expect(a.hostEpoch()).toBe(epoch);
  });
});

describe('(e) two genuine claims converge', () => {
  it('both peers created the room in the same instant; min-id breaks the tie', async () => {
    const a = await spawn('a', true);
    const z = await spawn('z', true);
    expect(a.isHost()).toBe(true);
    expect(z.isHost()).toBe(true);

    mesh.connect('a', 'z');
    mesh.flush();
    tick(6000);

    expect(a.host()).toBe(z.host());
    expect(a.host()).toBe('a');
    expect([a.isHost(), z.isHost()]).toEqual([true, false]);
  });

  it('a stale claimant capitulates instead of splitting the room', async () => {
    const a = await spawn('a', true);
    const z = await spawn('z', true);
    mesh.connect('a', 'z');
    mesh.flush();
    tick(3000);

    a.takeover();
    mesh.flush();
    tick(3000);

    expect(a.isHost()).toBe(true);
    expect(z.isHost()).toBe(false);
    expect(z.host()).toBe('a');
  });
});
