// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// See ADDITIONAL-TERMS.md for the section 7(b) attribution requirement.
//
// room-code.test.ts — the first live-P2P gate, and the cheapest. People paste codes into chat, read
// them aloud over a table and type them with a stray space or dash. If a hand-typed code does not
// canonicalise to EXACTLY the string the invite link carries, the two players land in different
// Trystero rooms, each alone, in a lobby that looks completely normal and never fills.

import { describe, expect, it } from 'vitest';
import { normalizeRoomCode } from '@ben-gy/game-engine/lobby';

describe('a typed code and a linked code resolve to the same room', () => {
  const CANON = 'K7QP';

  for (const typed of ['K7QP', 'k7qp', ' K7QP ', 'k7-qp', 'K7 QP', 'k7qp\n', 'K7.QP', '“K7QP”', 'k7\tqp']) {
    it(`${JSON.stringify(typed)} → ${CANON}`, () => {
      expect(normalizeRoomCode(typed)).toBe(CANON);
    });
  }

  it('is idempotent, so normalising twice cannot drift', () => {
    for (const code of ['k7qp', 'ABC123', ' zz9 ']) {
      const once = normalizeRoomCode(code);
      expect(normalizeRoomCode(once)).toBe(once);
    }
  });

  it('junk collapses to something the entry screen will reject', () => {
    // main.ts gates on `length >= 3` in two places — the typed code and the ?room= deep link — so
    // anything that survives normalisation must be short enough to fail that check.
    for (const junk of ['', '   ', '---', '!!!']) {
      expect(normalizeRoomCode(junk).length).toBeLessThan(3);
    }
  });
});
