// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// See ADDITIONAL-TERMS.md for the section 7(b) attribution requirement.
//
// Deepshaft — the four things you need to know, and nothing else.
//
// A first-person HUD at 375px has room for about four fields before it starts covering the mine, so
// it carries HP, the current pool, which cards you hold, and how deep you are. Everything else — what
// you are looking at, what is coming, whether the gun is firing — is in the view itself, which is the
// point of a first-person game.
//
// The one extra: once you hold every card the floor needs, a bearing to the cage appears. That is
// the same information the bot gets at the same moment (see bot.ts), so the AI is not quietly
// cheating and the player is not quietly lost.

import { escapeHtml } from './dom';
import type { Game } from './game';
import { LOCK, LOCK_ORDER, SEAT } from './palette';
import { PLAYER } from './tuning';

export function hudHtml(): string {
  return `
  <div class="hud" id="hud">
    <div class="hud-top">
      <span class="hud-pill hud-hp" id="hHp">HP <b>100</b></span>
      <span class="hud-pill hud-ammo" id="hAmmo">CUTTER <b>150</b></span>
      <span class="hud-spacer"></span>
      <span class="hud-keys" id="hKeys"></span>
      <span class="hud-pill hud-depth" id="hDepth">FLOOR <b>1</b></span>
      <button class="iconbtn" id="pause" title="Pause" aria-label="Pause">❚❚</button>
      <button class="iconbtn wide" id="skip" title="Skip the tutorial" aria-label="Skip the tutorial" hidden>Skip</button>
    </div>
    <p class="hud-msg" id="hMsg" aria-live="polite"></p>
    <div class="hud-bot">
      <span class="hud-pill" id="hCage" hidden>CAGE <b>—</b></span>
      <span class="hud-spacer"></span>
      <span class="hud-mates" id="hMates"></span>
    </div>
  </div>`;
}

const ARROWS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];

export function paintHud(root: HTMLElement, g: Game, seat: number, message: string, tutorial = false): void {
  const p = g.players[seat];
  if (!p) return;
  const hp = root.querySelector<HTMLElement>('#hHp');
  const ammo = root.querySelector<HTMLElement>('#hAmmo');
  const keys = root.querySelector<HTMLElement>('#hKeys');
  const depth = root.querySelector<HTMLElement>('#hDepth');
  const msg = root.querySelector<HTMLElement>('#hMsg');
  const cage = root.querySelector<HTMLElement>('#hCage');
  const mates = root.querySelector<HTMLElement>('#hMates');
  const skip = root.querySelector<HTMLElement>('#skip');

  if (hp) {
    hp.innerHTML = p.down ? `<b>DOWN</b> ${Math.ceil(p.bleed)}s` : `HP <b>${Math.max(0, Math.round(p.hp))}</b>`;
    hp.classList.toggle('low', p.down || p.hp < PLAYER.hp * 0.34);
  }
  if (ammo) ammo.innerHTML = `${escapeHtml(p.weapon.toUpperCase())} <b>${p.ammo[p.weapon]}</b>`;
  if (depth) depth.innerHTML = `FLOOR <b>${g.floor}</b>`;
  if (msg) msg.textContent = message;
  // In the tutorial Skip REPLACES pause rather than sitting beside it. Seven controls do not fit
  // across 375px — the first build pushed Skip half off the right edge, where it was unreachable,
  // on the one screen a player most needs an escape from.
  if (skip) skip.hidden = !tutorial;
  const pause = root.querySelector<HTMLElement>('#pause');
  if (pause) pause.hidden = tutorial;

  if (keys) {
    // Only the cards THIS floor actually uses are shown, so an empty slot means something.
    keys.innerHTML = LOCK_ORDER.filter((c) => g.level.locks.includes(c))
      .map(
        (c) =>
          `<span class="keytag${p.keys.has(c) ? ' have' : ''}" style="background:${LOCK[c]}" title="${c} card"></span>`,
      )
      .join('');
  }

  if (cage) {
    const armed = g.level.locks.every((c) => p.keys.has(c));
    cage.hidden = !armed;
    if (armed) {
      const dx = g.level.stair.x + 0.5 - p.x;
      const dy = g.level.stair.y + 0.5 - p.y;
      // The bearing is relative to where you are LOOKING, which is the only frame a first-person
      // player has. North-up would be a compass for a map nobody can see.
      let rel = Math.atan2(dy, dx) - p.ang + Math.PI / 2;
      rel = ((rel % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      const arrow = ARROWS[Math.round(rel / (Math.PI / 4)) % 8];
      cage.innerHTML = `CAGE <b>${arrow} ${Math.round(Math.hypot(dx, dy))}</b>`;
    }
  }

  if (mates) {
    const others = g.players.filter((o) => o.seat !== seat && o.present);
    mates.innerHTML = others
      .map(
        (o) =>
          `<span class="matepill${o.down ? ' down' : ''}" style="--seat:${SEAT[o.seat % SEAT.length]}">${escapeHtml(
            o.name.slice(0, 10),
          )} ${o.down ? `DOWN ${Math.ceil(o.bleed)}s` : Math.round(o.hp)}</span>`,
      )
      .join('');
  }
}
