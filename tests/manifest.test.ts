// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// See ADDITIONAL-TERMS.md for the section 7(b) attribution requirement.
//
// The shell: the head, the icons, the promises made about what this page talks to. All of it is
// invisible to a player and all of it is load-bearing — a missing apple-touch-icon is a black square
// on someone's home screen, and a third external script is a broken promise about tracking.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const main = readFileSync(join(ROOT, 'src', 'main.ts'), 'utf8');
const SLUG = 'deepshaft';
const NAME = 'Deepshaft';
const ORIGIN = `https://${SLUG}.benrichardson.dev`;

describe('the head', () => {
  it('names the game once and consistently', () => {
    expect(html).toContain(`<title>${NAME}</title>`);
    for (const prop of ['og:title', 'twitter:title']) {
      expect(html).toMatch(new RegExp(`${prop}"[^>]*content="${NAME}"`));
    }
  });

  it('points every absolute URL at this game’s own origin', () => {
    for (const m of html.matchAll(/content="(https:\/\/[^"]+)"/g)) {
      const url = m[1];
      if (url.startsWith(ORIGIN)) continue;
      // The only other absolute URLs are the author link inside the JSON-LD.
      expect(url).toMatch(/^https:\/\/benrichardson\.dev/);
    }
    expect(html).toContain(`${ORIGIN}/og.png`);
  });

  it('does not carry a canonical link', () => {
    // Pages already 301s the .github.io host to the custom domain; a canonical here is redundant and
    // has been a source of self-referential mistakes across the fleet.
    expect(html).not.toMatch(/rel="canonical"/);
  });

  it('is installable: manifest, apple-touch-icon, and the iOS meta iOS actually reads', () => {
    expect(html).toMatch(/rel="manifest" href="\/manifest\.webmanifest"/);
    expect(html).toMatch(/rel="apple-touch-icon" href="\/icons\/apple-touch-icon\.png"/);
    expect(html).toMatch(/name="apple-mobile-web-app-capable" content="yes"/);
    expect(html).toMatch(new RegExp(`name="apple-mobile-web-app-title" content="${NAME}"`));
    expect(html).toMatch(/name="theme-color"/);
  });

  it('blocks pinch-zoom the only way that has any hope of working', () => {
    // The meta alone does NOT work — iOS Safari has ignored user-scalable since iOS 10, which is why
    // hardenViewport() and mobile.css do the real job. On a game whose entire input surface is a
    // drag across a full-bleed canvas, an accidental pinch-zoom is not cosmetic: it scrolls the page
    // out from under the thumb mid-fight.
    expect(html).toMatch(/user-scalable=no/);
    expect(html).toMatch(/viewport-fit=cover/);
    expect(main).toContain('hardenViewport()');
    expect(main).toContain("import '@ben-gy/game-engine/mobile.css'");
  });
});

describe('nothing third-party but the two sanctioned scripts', () => {
  it('loads exactly the beacon and the feedback widget', () => {
    const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
    const external = scripts.filter((s) => /^https?:/.test(s));
    expect(external.sort()).toEqual([
      'https://feedback.benrichardson.dev/w.js',
      'https://static.cloudflareinsights.com/beacon.min.js',
    ]);
  });

  it('has no third-party fonts or stylesheets at all', () => {
    for (const m of html.matchAll(/<link[^>]*href="([^"]+)"/g)) {
      expect(m[1]).not.toMatch(/^https?:/);
    }
    const css = readFileSync(join(ROOT, 'src', 'styles', 'main.css'), 'utf8');
    expect(css).not.toMatch(/@import|fonts\.googleapis|fonts\.gstatic|url\(https?:/);
  });

  it('the results screen can reach the feedback widget', () => {
    // body.playing hides the footer, so the footer-only trigger is invisible for the whole run —
    // exactly when a player hits the bug they want to report. The results screen is the first moment
    // after a run where a reachable trigger exists at all.
    expect(main).toContain('results-feedback');
    expect(main).toContain('window.feedback?.open');
  });
});

describe('the files the crawlers and the home screen need', () => {
  const files = [
    ['public/CNAME', `${SLUG}.benrichardson.dev`],
    ['public/robots.txt', `${ORIGIN}/sitemap.xml`],
    ['public/sitemap.xml', `${ORIGIN}/`],
    ['public/133936b7b2ab337d2e2288fd7dd7c30f.txt', '133936b7b2ab337d2e2288fd7dd7c30f'],
  ] as const;

  for (const [path, needle] of files) {
    it(`${path} exists and says the right thing`, () => {
      const p = join(ROOT, path);
      expect(existsSync(p), `${path} is missing`).toBe(true);
      expect(readFileSync(p, 'utf8')).toContain(needle);
    });
  }

  for (const icon of ['icon-192.png', 'icon-512.png', 'icon-512-maskable.png', 'apple-touch-icon.png']) {
    it(`public/icons/${icon} exists and is not a stub`, () => {
      const p = join(ROOT, 'public', 'icons', icon);
      expect(existsSync(p), `${icon} is missing — run npm run gen:icons`).toBe(true);
      expect(statSync(p).size).toBeGreaterThan(500);
    });
  }

  it('public/og.png is a real card', () => {
    const p = join(ROOT, 'public', 'og.png');
    expect(existsSync(p)).toBe(true);
    expect(statSync(p).size).toBeGreaterThan(5000);
  });

  it('the manifest declares a maskable icon, because Android crops the others', () => {
    const m = JSON.parse(readFileSync(join(ROOT, 'public', 'manifest.webmanifest'), 'utf8'));
    expect(m.name).toBe(NAME);
    expect(m.display).toBe('standalone');
    expect(m.icons.map((i: { sizes: string }) => i.sizes).sort()).toEqual(['192x192', '512x512', '512x512']);
    expect(m.icons.some((i: { purpose: string }) => i.purpose === 'maskable')).toBe(true);
    expect(m.theme_color).toBeTruthy();
  });

  it('ships no service worker', () => {
    // The bundle is already self-contained and offline-capable; a stale SW cache would serve players
    // an old build after every deploy.
    expect(existsSync(join(ROOT, 'public', 'sw.js'))).toBe(false);
    expect(main).not.toMatch(/serviceWorker/);
  });
});

describe('licensing', () => {
  it('is AGPL, with the section 7(b) attribution term and the notices beside it', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.license).toBe('AGPL-3.0-or-later');
    for (const f of ['LICENSE', 'ADDITIONAL-TERMS.md', 'CONTRIBUTING.md', 'THIRD-PARTY-NOTICES.md']) {
      expect(existsSync(join(ROOT, f)), `${f} is missing`).toBe(true);
    }
    expect(readFileSync(join(ROOT, 'LICENSE'), 'utf8').split('\n').length).toBeGreaterThan(600);
    expect(existsSync(join(ROOT, 'public', 'third-party-notices.txt'))).toBe(true);
  });

  it('keeps licence copy out of the game itself', () => {
    // Licensing lives in the repo. A licence line on the title screen is noise a player never asked
    // for, and none of the bundled components requires an in-app notice.
    // Past the file's own SPDX header, which is how section 7's notice requirement is satisfied.
    const ui = readFileSync(join(ROOT, 'src', 'ui.ts'), 'utf8').split('\n').slice(3).join('\n');
    expect(ui).not.toMatch(/AGPL|GNU General Public|copyleft/i);
  });

  it('the attribution backlink is in the footer, and the repo link is not in the UI', () => {
    const ui = readFileSync(join(ROOT, 'src', 'ui.ts'), 'utf8');
    expect(ui).toContain('https://benrichardson.dev/');
    expect(ui).toContain('https://lab.benrichardson.dev');
    expect(ui).not.toMatch(/github\.com/);
  });
});
