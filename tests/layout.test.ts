// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// See ADDITIONAL-TERMS.md for the section 7(b) attribution requirement.
//
// SOURCE-LEVEL INVARIANTS FOR THE THINGS THAT ONLY A REAL BROWSER CAN SEE.
//
// jsdom has no layout engine, so nothing in this file can prove the mine fits on a phone. What it
// CAN do is ratchet the specific mistakes that were found in a real browser during this build, so
// they cannot come back silently:
//
//  • The HUD row overflowed at 375px and pushed the Skip button half off the right edge — on the one
//    screen (the tutorial) a player most needs an escape from. `min-width: 0` on the rows AND on
//    their children is the fix, and it is asserted here.
//  • `[hidden]` without `!important` loses to any class that also sets `display`, which is how a
//    sibling game shipped an invisible blurred layer sitting on its own play surface, eating every
//    tap. On a full-bleed canvas game there is nothing else to tap.
//  • An 812x375 landscape phone matches a `min-width` tablet query as well as the short-viewport
//    one. Whichever block is LAST in source order wins, so the order is the rule.
//
// The rest of the matrix — every mode at every viewport — is walked in a real browser at ship time
// and recorded in the build log. This file is the ratchet, not the substitute.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(__dirname, '..', 'src', 'styles', 'main.css'), 'utf8');
/** The stylesheet with comments removed — otherwise every prohibition here is satisfied by prose. */
const code = css.replace(/\/\*[\s\S]*?\*\//g, ' ');

/** The declaration body of every rule whose selector list matches, in source order. */
function blocks(selector: RegExp): string[] {
  const re = new RegExp(`${selector.source}\\s*\\{([^}]*)\\}`, 'g');
  return [...code.matchAll(re)].map((m) => m[1]);
}

describe('the comment-stripper this file rests on', () => {
  it('actually strips comments', () => {
    // The stylesheet header describes the `[hidden]` and media-query rules in prose. Without this,
    // half the assertions below would be satisfied by the explanation rather than the rule.
    expect(css).toContain("`[hidden] { display: none !important; }`");
    expect(code).not.toContain("`[hidden] { display: none !important; }`");
    expect(code).toContain('.view {');
  });
});

describe('the hidden attribute really hides', () => {
  it('is enforced with !important, because Safari’s UA rule is not', () => {
    // Safari's user-agent sheet sets `[hidden] { display: none }` WITHOUT !important, so any class
    // on the same element that also sets `display` (a `.overlay { display: flex }`, say) beats the
    // attribute. The result is a transparent full-screen layer over the canvas that swallows every
    // tap. It looks fine in a screenshot and the game is unplayable.
    expect(code).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  });

  it('and the footer is hidden mid-run rather than merely styled away', () => {
    // The footer is in the normal flow above the canvas. Left in place during a run it steals the
    // bottom band — which on this game is where the movement thumb and the action pad live.
    expect(code).toMatch(/body\.playing \.site-footer\s*\{\s*display:\s*none\s*!important/);
  });
});

describe('the play surface is a canvas that owns the whole box', () => {
  it('.view is absolutely positioned to inset 0 and swallows browser gestures', () => {
    const [view] = blocks(/\.view/);
    expect(view, '.view rule not found').toBeDefined();
    expect(view, '.view must fill its container, not depend on an intrinsic ratio').toMatch(
      /position:\s*absolute/,
    );
    expect(view).toMatch(/inset:\s*0/);
    // Without this the browser claims the drag: a downward swipe scrolls or pull-to-refreshes
    // instead of walking, and a two-finger move pinch-zooms the page out from under the player.
    expect(view, '.view must set touch-action: none').toMatch(/touch-action:\s*none/);
  });

  it('and the layer that actually receives the thumb does too', () => {
    for (const b of blocks(/\.control-layer/)) expect(b).toMatch(/touch-action:\s*none/);
    const zones = blocks(/\.stickzone,\s*\.lookzone/);
    expect(zones.length, '.stickzone/.lookzone rule not found').toBeGreaterThan(0);
    for (const b of zones) expect(b).toMatch(/touch-action:\s*none/);
  });
});

describe('the viewport breakpoints are deliberate', () => {
  const queries = [...code.matchAll(/@media\s+([^{]+)\{/g)].map((m) => m[1].replace(/\s+/g, ' ').trim());

  it('is the exact list this test knows about', () => {
    // Listing them by hand is the point: a new breakpoint is a new cell in the modes x viewports
    // matrix that has to be walked in a real browser, and this is what makes it impossible to add
    // one silently.
    expect(queries).toEqual([
      '(min-width: 760px)',
      '(min-width: 1100px)',
      '(orientation: landscape) and (max-height: 560px)',
      '(prefers-reduced-motion: reduce)',
    ]);
  });

  it('puts the short-viewport query AFTER every min-width one', () => {
    // An 812x375 landscape phone matches `(min-width: 760px)` as well as the landscape query. Same
    // specificity, so the LAST one in source order wins. Put the landscape block first and a phone
    // held sideways is styled as a tablet — 62px action buttons on a 375px-tall screen.
    const landscape = code.indexOf('@media (orientation: landscape) and (max-height: 560px)');
    expect(landscape, 'the landscape query is missing').toBeGreaterThan(-1);
    for (const q of ['@media (min-width: 760px)', '@media (min-width: 1100px)']) {
      const at = code.indexOf(q);
      expect(at, `${q} is missing`).toBeGreaterThan(-1);
      expect(landscape, `${q} must come BEFORE the landscape query`).toBeGreaterThan(at);
    }
  });

  it('reduced motion is honoured, and it is the last word', () => {
    expect(code).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(code).toMatch(/animation-duration:\s*0\.0\d+ms\s*!important/);
  });
});

describe('every control keeps a thumb-sized target, at every viewport', () => {
  // 44px is the smallest reliably hittable target on a touch screen. These are checked in EVERY
  // block that declares them, not just the first — the landscape query shrinks .actbtn, and a
  // shrink that goes under the floor is exactly the change this catches.
  for (const sel of ['.actbtn', '.iconbtn']) {
    it(`${sel} is at least 44x44 in all ${sel} rules`, () => {
      const found = blocks(new RegExp(sel.replace('.', '\\.')));
      expect(found.length, `${sel} rule not found`).toBeGreaterThan(0);
      for (const b of found) {
        const w = /min-width:\s*(\d+)px/.exec(b);
        const h = /min-height:\s*(\d+)px/.exec(b);
        expect(w, `${sel} block has no min-width: ${b.trim()}`).not.toBeNull();
        expect(h, `${sel} block has no min-height: ${b.trim()}`).not.toBeNull();
        expect(Number((w as RegExpExecArray)[1])).toBeGreaterThanOrEqual(44);
        expect(Number((h as RegExpExecArray)[1])).toBeGreaterThanOrEqual(44);
      }
    });
  }
});

describe('the HUD can never push a control off the screen', () => {
  // THE BUG THIS RATCHETS: the top row carries HP, ammo, the card strip, the floor, pause and (in
  // the tutorial) Skip. A flex child defaults to `min-width: auto`, so a pill with a long weapon
  // name refuses to shrink and the row overflows instead. At 375px that put Skip half off the right
  // edge — unreachable, on the one screen a player most wants to leave.
  it('the rows let themselves shrink', () => {
    const rows = blocks(/\.hud-top,\s*\.hud-bot/);
    expect(rows.length, '.hud-top/.hud-bot rule not found').toBeGreaterThan(0);
    for (const b of rows) expect(b).toMatch(/min-width:\s*0/);
  });

  it('and so does every PILL inside them — but only the pills', () => {
    // Originally `.hud-top > *, .hud-bot > *`, which was more specific than `.iconbtn` and therefore
    // beat its 44px floor: the pause button rendered 28px wide with the floor still written down in
    // the stylesheet. Naming the pills is what keeps text compressible and controls thumb-sized.
    const kids = blocks(/\.hud-pill,\s*\.hud-keys,\s*\.hud-mates,\s*\.hud-msg/);
    expect(kids.length, 'the pill shrink rule is missing — the row alone is not enough').toBe(1);
    expect(kids[0]).toMatch(/min-width:\s*0/);
    expect(kids[0]).toMatch(/flex-shrink:\s*1/);
  });
});

describe('nothing that sizes the play surface is a percentage', () => {
  const decls = [...code.matchAll(/(--[a-z0-9-]+):\s*([^;}]+)[;}]/g)].map((m) => [m[1], m[2].trim()] as const);

  it('found the custom properties at all', () => {
    // The assertion below is vacuous if the parse finds nothing, which is how a prohibition becomes
    // a permanent lie.
    expect(decls.length, 'no custom-property declarations parsed').toBeGreaterThanOrEqual(10);
    expect(decls.map(([n]) => n)).toContain('--gap');
  });

  it('no custom property carries a %', () => {
    // A `%` resolves against a parent that has not been laid out yet and collapses the surface to
    // nothing on desktop — a failure this fleet has already shipped once. This game sizes its canvas
    // with `position: absolute; inset: 0` precisely so no length variable is needed; the moment one
    // appears with a percentage in it, that guarantee is gone.
    for (const [name, value] of decls) {
      expect(`${name}: ${value}`, `${name} must not be sized as a percentage`).not.toMatch(/%/);
    }
  });
});

describe('a thumb target never shrinks, however tight the row gets', () => {
  it('.iconbtn declares flex-shrink: 0', () => {
    // The HUD row lets its children compress so it can never overflow a 375px screen. Applied to the
    // whole row that also squeezed the PAUSE button to 28px — a hit target well under the 44px floor,
    // produced by the very fix that stopped the overflow. Text may compress; a control may not.
    const block = /\.iconbtn\s*\{([^}]*)\}/.exec(css);
    expect(block, 'no .iconbtn rule at all').not.toBeNull();
    expect(block![1]).toMatch(/flex-shrink:\s*0/);
    // And nothing more specific is allowed to zero its floor. `.hud-top > *` is (0,1,1) against
    // `.iconbtn`'s (0,1,0), so a `min-width: 0` there wins and the 44px floor silently stops
    // applying — which is exactly how the button ended up 28px wide with the floor still written down.
    // Against the comment-stripped source: the explanation above mentions the old selector by name,
    // and an assertion that a COMMENT satisfies is not an assertion.
    expect(code, 'the shrink rule must name the pills, not every child of the row').not.toMatch(
      /\.hud-(top|bot)\s*>\s*\*/,
    );
  });
});
