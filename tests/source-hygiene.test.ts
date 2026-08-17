// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// See ADDITIONAL-TERMS.md for the section 7(b) attribution requirement.
//
// source-hygiene.test.ts — the things that are invisible until they are catastrophic.
//
// The control-byte check has bitten this factory twice. A raw control byte in a source file compiles
// and runs perfectly, then `file` reports the source as "data", git treats it as binary, `diff`
// refuses it — and PLAIN GREP SILENTLY MATCHES NOTHING IN IT, so any audit that greps the file gets
// an all-clear it did not earn. The second occurrence survived review for exactly that reason. Every
// grep-based assertion below inherits its credibility from this one.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(SRC);
const tsFiles = files.filter((f) => f.endsWith('.ts'));
const rel = (p: string): string => p.slice(SRC.length + 1);

/**
 * Source with comments removed. Every prohibition in this file explains ITSELF in a comment, and a
 * file that explains why it must not call `Math.random` would otherwise be a file that breaks the
 * rule. `stripsComments` below proves this actually works before anything relies on it.
 */
const codeOf = (path: string): string =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('the source is text a grep can actually read', () => {
  for (const f of files) {
    it(`${rel(f)} has no literal control bytes`, () => {
      const bytes = readFileSync(f);
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        const ok = b >= 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;
        expect(ok, `byte 0x${b.toString(16)} at offset ${i} — write it as an escape`).toBe(true);
      }
    });
  }
});

describe('every first-party source file carries its SPDX header', () => {
  for (const f of tsFiles) {
    // The ambient type declarations are a few lines each and are not copyrightable prose.
    if (f.endsWith('.d.ts')) continue;
    it(rel(f), () => {
      const head = readFileSync(f, 'utf8').split('\n').slice(0, 3).join('\n');
      expect(head).toContain('SPDX-License-Identifier: AGPL-3.0-or-later');
      expect(head).toContain('Ben Richardson');
      expect(head).toContain('ADDITIONAL-TERMS.md');
    });
  }

  it('the stylesheet has one too', () => {
    const css = readFileSync(join(SRC, 'styles', 'main.css'), 'utf8');
    expect(css).toContain('SPDX-License-Identifier: AGPL-3.0-or-later');
  });
});

describe('nothing shipped talks to the console', () => {
  for (const f of tsFiles) {
    it(rel(f), () => {
      const text = readFileSync(f, 'utf8');
      expect(text, 'a shipped console call is noise in a player’s devtools').not.toMatch(
        /\bconsole\.(log|error|warn|info|debug)\s*\(/,
      );
    });
  }
});

describe('the engine is a dependency, never a copy', () => {
  it('there is no src/engine directory', () => {
    expect(files.some((f) => rel(f).startsWith('engine/'))).toBe(false);
  });

  it('every engine import is a package subpath, not a relative path', () => {
    for (const f of tsFiles) {
      const text = readFileSync(f, 'utf8');
      const bad = [...text.matchAll(/from '(\.\.?\/[^']*engine[^']*)'/g)];
      expect(bad.map((m) => `${rel(f)}: ${m[1]}`)).toEqual([]);
    }
  });

  it('the hosted feedback widget is never vendored or called via an import', () => {
    // It self-mounts from the script tag in the head; a local copy is a leftover, not a template.
    expect(files.some((f) => rel(f) === 'feedback.ts')).toBe(false);
    for (const f of tsFiles) {
      expect(readFileSync(f, 'utf8')).not.toMatch(/mountFeedback/);
    }
  });

  it('trystero is never a direct dependency', () => {
    // It arrives through the engine, pinned exactly. A `^0.21.0` here re-opens the door to the game
    // and the engine resolving different builds of the transport.
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(['@ben-gy/game-engine']);
    expect(Object.keys(pkg.devDependencies ?? {})).not.toContain('trystero');
  });
});

// ── every sound the game plays is a sound that exists ───────────────────────────────────────────
//
// `sfx.play()` on a name with no patch returns SILENTLY rather than throwing. A typo'd cue is
// therefore an INAUDIBLE bug: the suite stays green, the shot fires, and nothing is heard. In a
// first-person game where the only warning that something has woken up behind you is the `wake` cue,
// a silent cue is not a polish defect — it is the loss of the information the game runs on.

/**
 * The cue names a call site can actually pass, for every `ping(...)` / `sfx.play(...)` in the file.
 *
 * Deepshaft does not always pass a bare literal. It writes `ping(e.opened ? 'door' : 'locked')`,
 * `sfx.play(i === last ? 'go' : 'beat')` and `ping(player.weapon ?? 'cutter')`, so matching only the
 * first argument would quietly miss half the roster. This walks the call's balanced parentheses and
 * takes every literal in VALUE position — after `(`, `,`, `?`, `:` or `??` — which picks up both
 * arms of a ternary and the right-hand side of a fallback while ignoring `e.kind === 'amber'`.
 *
 * The slice deliberately KEEPS the opening `(`. A first draft started one character later, so a
 * plain `ping('select')` had no delimiter in front of it and was skipped — and the roster still came
 * back nine names long off the ternaries alone, which is a green test that checks nothing. The
 * mutation that catches it is `ping('selct')`.
 */
function cuesPlayedIn(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/\b(?:ping|sfx\.play)\(/g)) {
    const open = (m.index as number) + m[0].length - 1;
    let depth = 1;
    let i = open + 1;
    for (; i < code.length && depth > 0; i++) {
      if (code[i] === '(') depth++;
      else if (code[i] === ')') depth--;
    }
    const args = code.slice(open, i - 1);
    for (const q of args.matchAll(/[(?:,]\s*'([a-zA-Z0-9_-]+)'/g)) out.push(q[1]);
  }
  return out;
}

describe('every sound the game plays is a sound that exists', () => {
  const played = new Set<string>();
  for (const f of tsFiles) for (const c of cuesPlayedIn(codeOf(f))) played.add(c);

  it('the grep found a plausible roster, so it cannot pass by finding nothing', () => {
    // An extractor that has drifted from the call style matches zero names and then vacuously
    // "proves" every one of them is declared. This is the assertion that keeps the next one honest.
    expect([...played].sort().join(' ')).not.toBe('');
    expect(played.size, `only found ${played.size} cue names — has the call style changed?`).toBeGreaterThan(6);
  });

  it('each ping()/sfx.play() literal in src/ is declared in CUES', async () => {
    const { CUES } = await import('../src/cues');
    for (const cue of played) {
      expect(CUES, `'${cue}' is played but not declared — it would be SILENT, not an error`).toContain(cue);
    }
  });

  it('every declared cue resolves to a patch a real mixer knows', async () => {
    const { CUES, PATCHES } = await import('../src/cues');
    const { DEFAULT_PATCHES } = await import('@ben-gy/game-engine/sound');
    for (const cue of CUES) {
      expect(
        Object.hasOwn(PATCHES, cue) || Object.hasOwn(DEFAULT_PATCHES, cue),
        `'${cue}' is declared but no patch defines it — play() would return silently`,
      ).toBe(true);
    }
  });

  it('and every weapon id is a cue, because the shot sound IS the weapon id', async () => {
    // `ping(player.weapon ?? 'cutter')` means the weapon roster and the cue roster are the same list
    // by construction. Adding a fourth gun without a patch would fire it in total silence.
    const { CUES } = await import('../src/cues');
    const { WEAPON_ORDER } = await import('../src/tuning');
    expect(WEAPON_ORDER.length).toBeGreaterThan(1);
    for (const w of WEAPON_ORDER) expect(CUES, `weapon '${w}' has no cue`).toContain(w);
  });
});

// ── no colour literal in the renderer ───────────────────────────────────────────────────────────
//
// Every colour that carries meaning in this game — a body, a card, a door, a bolt, a mate's beacon —
// has to be legible against four wall materials under a fog curve. That is a measurable property and
// tests/contrast.test.ts measures it, but it can only measure what it can enumerate, and it
// enumerates src/palette.ts. A `#rrggbb` typed straight into a draw call is a colour that no test
// can ever hold to a ratio; it is exactly how the fleet shipped a hostile projectile at 2.81:1.

describe('no colour literal escapes the palette', () => {
  const HEX = /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b/g;

  for (const name of ['render.ts', 'hud.ts', 'art.ts']) {
    it(`${name} names every colour rather than spelling one`, () => {
      const found = codeOf(join(SRC, name)).match(HEX) ?? [];
      expect(
        found,
        `${name} spells a colour inline; move it to src/palette.ts where contrast.test.ts can see it`,
      ).toEqual([]);
    });
  }

  it('and the palette is where they all actually live', () => {
    // The mirror image of the rule above: if the literals moved somewhere the contrast test cannot
    // enumerate, the three assertions above would pass on a game with no colours at all.
    const palette = codeOf(join(SRC, 'palette.ts')).match(HEX) ?? [];
    expect(palette.length).toBeGreaterThan(20);
  });

  it('and the comment-stripper this rests on actually strips comments', () => {
    // Without this the assertions above are vacuous the moment a comment mentions a hex value —
    // which palette.ts's own header does, in the note about #ff5d4a measuring 2.81:1.
    const raw = readFileSync(join(SRC, 'palette.ts'), 'utf8');
    expect(raw).toContain('#ff5d4a');
    expect(codeOf(join(SRC, 'palette.ts'))).not.toContain('#ff5d4a');
    expect(codeOf(join(SRC, 'palette.ts'))).toContain('export const SPRITE_RIM');
  });
});

// ── the parts that must run identically on every peer ───────────────────────────────────────────

describe('the shared randomness that peers must agree on', () => {
  const DETERMINISTIC = ['mine.ts', 'modes.ts', 'tuning.ts'];

  it('no Math.random in the level generator, the modes or the tuning', () => {
    // The mine is cut from a SEED the room agrees on. One `Math.random` in mine.ts and two peers
    // stand in two different levels holding the same floor number — walls where the other sees
    // corridor, a keycard that exists on one screen only. Jitter belongs to presentation.
    for (const name of DETERMINISTIC) {
      expect(codeOf(join(SRC, name)), `${name} must cut the same mine on every device`).not.toMatch(/Math\.random/);
    }
  });

  it('nothing deterministic reads a clock either', () => {
    // A millisecond budget in generation returns a different level on a slow phone than a fast one,
    // which is not a performance choice — it is a live desync at floor one.
    for (const name of DETERMINISTIC) {
      expect(codeOf(join(SRC, name)), `${name} must not depend on wall-clock time`).not.toMatch(
        /Date\.now|performance\.now/,
      );
    }
  });

  it('and the comment-stripper this rests on actually strips comments', () => {
    const raw = readFileSync(join(SRC, 'mine.ts'), 'utf8');
    expect(raw, 'mine.ts no longer explains itself — pick another sentinel').toContain('bookkeeping');
    expect(codeOf(join(SRC, 'mine.ts'))).not.toContain(
      'precisely what shipped 3.2% unsolvable floors',
    );
    expect(codeOf(join(SRC, 'mine.ts'))).toContain('export');
  });
});
