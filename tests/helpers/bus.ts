// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// See ADDITIONAL-TERMS.md for the section 7(b) attribution requirement.
//
// bus.ts — an in-memory stand-in for the P2P mesh, for PROTOCOL tests only. It models the three
// things rematch.ts and the lobby actually depend on: a roster, an elected host, and named channels
// that deliver to peers still in the room. It does NOT model transport, and that is deliberate — the
// decisions under test (who starts a round, with which roster, at which number) have to be right
// before transport is interesting, and net-lifecycle.test.ts is what guards the transport itself.
//
// A fake bus sits ABOVE Trystero's room cache, so it structurally cannot contain the leave/rejoin
// defect. Treating a green bus test as coverage for that is exactly how the bug shipped twice in
// this fleet. Delivery is QUEUED and drained by flush(), so a test can interleave sends the way a
// real mesh does rather than seeing every message land inside the send call.

import type { Net, PeerId, Unsubscribe } from '@ben-gy/game-engine/net';

interface Envelope {
  from: PeerId;
  to?: PeerId | PeerId[];
  name: string;
  data: unknown;
}

class Member {
  channels = new Map<string, Set<(data: unknown, from: PeerId) => void>>();
  peerSubs = new Set<(peers: PeerId[]) => void>();
  constructor(readonly id: PeerId) {}
}

export class Bus {
  private members = new Map<PeerId, Member>();
  private queue: Envelope[] = [];
  private hostId: PeerId | null = null;

  join(id: PeerId): Net {
    this.members.set(id, new Member(id));
    if (this.hostId === null) this.hostId = id;
    this.notifyRoster();
    return this.netFor(id);
  }

  leave(id: PeerId): void {
    this.members.delete(id);
    if (this.hostId === id) this.hostId = this.peers()[0] ?? null;
    this.notifyRoster();
  }

  setHost(id: PeerId | null): void {
    this.hostId = id;
  }

  peers(): PeerId[] {
    return [...this.members.keys()].sort();
  }

  /** Post a message as if `from` had sent it — how a test forges a stale or replayed start. */
  inject(from: PeerId, name: string, data: unknown, to?: PeerId): void {
    this.queue.push({ from, to, name, data });
  }

  private notifyRoster(): void {
    const list = this.peers();
    for (const m of [...this.members.values()]) for (const cb of [...m.peerSubs]) cb(list);
  }

  flush(): void {
    let guard = 0;
    while (this.queue.length) {
      if (++guard > 2000) throw new Error('bus: message storm — the protocol did not converge');
      const e = this.queue.shift() as Envelope;
      const targets = e.to === undefined ? this.peers().filter((p) => p !== e.from) : Array.isArray(e.to) ? e.to : [e.to];
      for (const t of targets) {
        if (t === e.from) continue;
        const m = this.members.get(t);
        if (!m) continue;
        for (const h of [...(m.channels.get(e.name) ?? [])]) h(structuredClone(e.data), e.from);
      }
    }
  }

  private netFor(id: PeerId): Net {
    const bus = this;
    const me = (): Member => {
      const m = bus.members.get(id);
      if (!m) throw new Error(`bus: ${id} has left the room`);
      return m;
    };

    const net: Partial<Net> = {
      selfId: id,
      peers: () => bus.peers(),
      host: () => bus.hostId,
      isHost: () => bus.hostId === id,
      hostSettled: () => bus.hostId !== null,
      hostEpoch: () => 1,
      count: () => bus.peers().length,

      onPeersChange(cb: (peers: PeerId[]) => void): Unsubscribe {
        me().peerSubs.add(cb);
        return () => me().peerSubs.delete(cb);
      },

      channel<T>(name: string, onReceive: (data: T, from: PeerId) => void) {
        const set = me().channels.get(name) ?? new Set<(data: unknown, from: PeerId) => void>();
        me().channels.set(name, set);
        const h = onReceive as (data: unknown, from: PeerId) => void;
        set.add(h);
        const send = ((data: T, to?: PeerId | PeerId[]) => {
          // A peer that has left stops speaking. Without this a torn-down Rounds keeps answering
          // resync polls and the room never notices it is gone.
          if (!bus.members.has(id)) return;
          bus.queue.push({ from: id, to, name, data });
        }) as ((data: T, to?: PeerId | PeerId[]) => void) & { off: Unsubscribe };
        send.off = () => set.delete(h);
        return send;
      },

      ping: () => Promise.resolve(0),
      takeover: () => bus.setHost(id),
      leave: () => {
        bus.leave(id);
        return Promise.resolve();
      },
    };

    return net as Net;
  }
}
