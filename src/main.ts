// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// See ADDITIONAL-TERMS.md for the section 7(b) attribution requirement.
//
// Deepshaft — bootstrap and the screen machine. Owns which screen is up, the room's Net (created
// ONCE per session and never left for a rematch), and the fixed-step loop. The mine is in mine.ts,
// the rules in game.ts, the wire in session.ts, the raycaster in render.ts.

import '@ben-gy/game-engine/mobile.css';
import './styles/main.css';

import { hardenViewport } from '@ben-gy/game-engine/mobile';
import { createSfx } from '@ben-gy/game-engine/sound';
import { createStore } from '@ben-gy/game-engine/storage';
import { createLoop, type Loop } from '@ben-gy/game-engine/loop';
import { createNet, roomAppId, setTurnConfig, type Net } from '@ben-gy/game-engine/net';
import { getTurnConfig } from '@ben-gy/game-engine/turn';
import { createRounds, type RoundInfo, type RoundPlayer, type Rounds } from '@ben-gy/game-engine/rematch';
import { clearRoomInUrl, createLobby, createRoomEntry, normalizeRoomCode, setRoomInUrl } from '@ben-gy/game-engine/lobby';
import { resolveName } from '@ben-gy/game-engine/identity';
import { newSeed } from '@ben-gy/game-engine/rng';

import { escapeHtml } from './dom';
import { MODE_IDS, modeOf } from './modes';
import { Game, type GEvent, type Intent } from './game';
import { Bot, tierOf } from './bot';
import { Session } from './session';
import { createRenderer, type Renderer } from './render';
import { createControls, type Controls } from './controls';
import { runCountdown } from './countdown';
import { hudHtml, paintHud } from './hud';
import { ATTRIB, aboutHtml, helpHtml, menuHtml, resultsHtml, type ResultRow } from './ui';
import { PATCHES } from './cues';
import { SEAT_NAME } from './palette';
import { STEP, WEAPON_ORDER } from './tuning';
import { STEPS, freshProgress, gateIntent, tutorialGame, type Progress } from './tutorial';

const SLUG = 'deepshaft';
const MAX_SEATS = 4;

const app = document.querySelector<HTMLElement>('#app')!;
let content: HTMLElement;

const store = createStore(SLUG);
const sfx = createSfx({ muted: store.get<boolean>('muted', false) ?? false, patches: PATCHES });
const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

let unlocked = false;
function unlock(): void {
  if (unlocked) return;
  unlocked = true;
  try {
    sfx.unlock();
  } catch {
    /* audio unlock is best-effort */
  }
}
window.addEventListener('pointerdown', unlock, { once: true });
window.addEventListener('keydown', unlock, { once: true });

const playerName = resolveName(store, () => `Miner ${Math.floor(Math.random() * 900 + 100)}`);
let myModeChoice = modeOf(store.get<string>('mode', '')).id;
let hostOptsMode = myModeChoice;

const bestKey = (id: string): string => `best_${id}`;
const bestFor = (id: string): number => store.get<number>(bestKey(id), 0) ?? 0;
function noteBest(id: string, floor: number): void {
  if (floor > bestFor(id)) store.set(bestKey(id), floor);
}

let net: Net | null = null;
let rounds: Rounds | null = null;
let roster: RoundPlayer[] = [];
let roomCode = '';
let runs = 0;

const cleanups: Array<() => void> = [];
const onCleanup = (fn: () => void): void => void cleanups.push(fn);
function teardown(): void {
  for (const fn of cleanups.splice(0)) {
    try {
      fn();
    } catch {
      /* a failing teardown must never block the next screen */
    }
  }
}
const setPlaying = (on: boolean): void => void document.body.classList.toggle('playing', on);

function mountShell(): void {
  app.innerHTML = `<main class="main-content" id="content"></main><footer class="site-footer">${ATTRIB}</footer>`;
  content = document.getElementById('content')!;
}

/**
 * A sheet has FOUR ways out — the close button, a tap outside, Escape, and a backdrop that is
 * genuinely reachable. An overlay with one way out is a game you cannot play. The 350ms arming
 * delay is not a flourish: a sheet opened from a pointerup is otherwise closed instantly by that
 * same tap's trailing click.
 */
function sheet(html: string): void {
  const wrap = document.createElement('div');
  wrap.className = 'overlay';
  wrap.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(wrap);
  const armedAt = Date.now();
  const close = (): void => {
    wrap.remove();
    window.removeEventListener('keydown', onKey);
  };
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') close();
  }
  wrap.addEventListener('pointerdown', (e) => {
    if (e.target === wrap && Date.now() - armedAt > 350) close();
  });
  wrap.querySelectorAll('.sheet-close').forEach((b) => b.addEventListener('click', close));
  window.addEventListener('keydown', onKey);
}

function toast(msg: string): void {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => t.remove(), 2100);
}

function ping(cue: string, pitch?: number): void {
  try {
    sfx.play(cue, pitch === undefined ? undefined : { pitch });
  } catch {
    /* audio is best-effort and must never break a round */
  }
}

// ── the play screen ─────────────────────────────────────────────────────────────────────────────

interface Screen {
  destroy(): void;
}

let active: Session | null = null;
let activeControls: Controls | null = null;
let activeRenderer: Renderer | null = null;
let activeStep = -1;

/**
 * A synthetic hand, for the in-browser verification pass. It is folded in at exactly the point a
 * real hand is read, so the tutorial gate, the progress tracking, the juice and the loop all run
 * unchanged — which is the only way an automated playthrough proves anything about the real thing.
 * Never set by gameplay; `null` in every real session.
 */
let synth: { mx: number; my: number; turn: number; fire: boolean; use: boolean } | null = null;

interface PlayOpts {
  session: Session;
  bots: Bot[];
  onQuit: () => void;
  onOver: () => void;
  /** Present only in the tutorial. */
  tutorial?: { progress: Progress; onFinish: () => void };
}

function buildPlayScreen(o: PlayOpts): Screen {
  const s = o.session;
  const g = () => s.game;
  const seat = s.game.mySeat ?? 0;

  content.innerHTML = `
    <section class="game" id="game">
      <canvas class="view" id="view"></canvas>
      <div class="veil hurt" id="veil"></div>
      ${hudHtml()}
      <div class="control-layer" id="layer">
        <div class="stickzone" id="stick"></div>
      </div>
      <div class="actionpad" id="pad"></div>
    </section>`;

  const host = content.querySelector<HTMLElement>('#game')!;
  const canvas = content.querySelector<HTMLCanvasElement>('#view')!;
  const veil = content.querySelector<HTMLElement>('#veil')!;
  const layer = content.querySelector<HTMLElement>('#layer')!;
  const pad = content.querySelector<HTMLElement>('#pad')!;

  const renderer: Renderer = createRenderer(canvas);
  activeRenderer = renderer;
  const controls = createControls({
    surface: layer,
    pad,
    canvas,
    reducedMotion,
    onSwap: () => {
      const p = g().players[seat];
      if (!p) return;
      p.weapon = Game.nextWeapon(p);
      ping('blip', 1.2);
    },
    onUse: () => ping('blip', 0.9),
  });
  activeControls = controls;
  controls.setAng(g().players[seat]?.ang ?? 0);

  let destroyed = false;
  let paused = false;
  let live = false;
  let msg = '';
  let msgUntil = 0;
  let shakeUntil = 0;
  const tut = o.tutorial;
  if (tut) {
    activeStep = 0;
    STEPS[0].enter?.(g());
  }

  // Frame-time sampling, so the budget in the log is measured rather than asserted.
  const frames: number[] = [];
  let lastFrame = 0;

  function fit(): void {
    const r = host.getBoundingClientRect();
    renderer.resize(r.width, r.height);
  }
  fit();
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fit()) : null;
  ro?.observe(host);
  window.addEventListener('resize', fit);
  // A hidden tab reports a zero-size box; the renderer refuses it, so a delayed re-measure is what
  // actually lands the layout when the tab comes back.
  const refit = setInterval(fit, 900);

  const cd = runCountdown(host, sfx, () => {
    if (destroyed) return;
    live = true;
  }, ['3', '2', '1', 'DOWN']);

  function say(text: string, secs = 2.6): void {
    msg = text;
    msgUntil = performance.now() + secs * 1000;
  }

  function juice(events: GEvent[]): void {
    for (const e of events) {
      if (e.k === 'shot') ping(g().players[e.seat]?.weapon ?? 'cutter', 0.94 + Math.random() * 0.12);
      else if (e.k === 'dry') ping('dry');
      else if (e.k === 'hurtE') ping('thud', 1 + Math.random() * 0.2);
      else if (e.k === 'killE') ping('kill', 1.25 - Math.min(0.5, e.kind === 'hauler' ? 0.45 : 0.1));
      else if (e.k === 'tell') ping('wake', 0.8);
      else if (e.k === 'wake') ping('wake');
      else if (e.k === 'damp') {
        ping('blast', 1 - Math.min(0.3, e.chain * 0.08));
        if (!reducedMotion) shakeUntil = performance.now() + 260;
      } else if (e.k === 'hurtP' && e.seat === seat) {
        ping('hurt');
        flash();
        if (!reducedMotion) shakeUntil = performance.now() + 160;
        buzz(18);
      } else if (e.k === 'downP') {
        ping('down');
        if (e.seat === seat) say('You are down. Hold on.', 4);
        else say(`${g().players[e.seat]?.name ?? 'A mate'} is down — get to them.`, 4);
      } else if (e.k === 'reviveP') {
        ping('revive');
        say(e.seat === seat ? 'Back up.' : 'You got them up.', 2);
      } else if (e.k === 'pickup') {
        ping(e.kind === 'amber' || e.kind === 'cyan' || e.kind === 'rose' ? 'key' : 'pickup');
        if (e.seat === seat) {
          say(PICKUP_SAY[e.kind] ?? 'Picked up.', 1.8);
          buzz(30);
        }
        if (tut && e.kind === 'carbide') tut.progress.tookCarbide = true;
      } else if (e.k === 'door') {
        ping(e.opened ? 'door' : 'locked');
        if (!e.opened && e.colour) say(`That needs the ${e.colour} card.`, 2.2);
        if (e.opened && tut) tut.progress.doorsOpened++;
      } else if (e.k === 'descend') {
        ping('descend');
        say(`Floor ${e.floor}.`, 2.4);
        for (const b of o.bots) b.reset();
      } else if (e.k === 'over') {
        ping(e.win ? 'win' : 'lose');
      }
      if (tut && e.k === 'killE') {
        tut.progress.kills++;
        if (performance.now() - lastDampAt < 700) tut.progress.dampKills++;
      }
      if (tut && e.k === 'damp') lastDampAt = performance.now();
    }
  }
  let lastDampAt = -1e9;

  // The veil is driven by a DEADLINE read in the render pass, not by a setTimeout. A background tab
  // clamps timers to about a second, so the timeout version left the red damage wash painted over
  // the whole screen long after the hit — and with repeated damage it never cleared at all.
  let veilUntil = 0;
  function flash(): void {
    veilUntil = performance.now() + 150;
  }
  function buzz(ms: number): void {
    if (reducedMotion || !('vibrate' in navigator)) return;
    try {
      navigator.vibrate(ms);
    } catch {
      /* haptics are best-effort */
    }
  }

  // ── the clock ─────────────────────────────────────────────────────────────────────────────────
  // rAF drives the frame, and a setInterval BACKSTOP drives the simulation when rAF is starved.
  //
  // That is not belt-and-braces, it is a correctness requirement. A browser stops firing rAF the
  // moment a tab is backgrounded, and this game is host-authoritative: a host who switches tabs would
  // freeze the mine for the entire crew, who would sit there watching a still image of a thrall.
  // rAF is a RENDER signal; it is not a clock, and it must never be the only one.
  //
  // Solo is the exception in the other direction: nobody else is waiting, so switching away should
  // pause rather than let something eat you off-screen. That pause hangs off the visibilitychange
  // TRANSITION — the moment the player actually leaves — rather than off `document.hidden`, which is
  // also true in an automated harness where the game genuinely should keep running.
  let lastRaf = performance.now();

  function simStep(step: number): void {
    if (destroyed || paused) return;
    const game = g();
    if (!live || game.over) {
      controls.read(game, seat, step);
      return;
    }

    let mine: Intent = controls.read(game, seat, step);
    if (synth) {
      controls.setAng(controls.ang() + synth.turn * step);
      mine = {
        mx: synth.mx,
        my: synth.my,
        ang: controls.ang(),
        fire: synth.fire,
        use: synth.use,
        weapon: game.players[seat]?.weapon ?? 'cutter',
      };
      synth.use = false;
    }
    if (tut) {
      const stp = STEPS[Math.min(activeStep, STEPS.length - 1)];
      mine = gateIntent(mine, stp.gate, game.players[seat]?.ang ?? 0);
      if (!stp.gate.turn) controls.setAng(game.players[seat]?.ang ?? 0);
    }

    // Bots drive every seat that is not a present human. In solo that is nobody; in a co-op room
    // with an empty seat it is that seat, so the crew is never short-handed.
    if (s.host) {
      for (const b of o.bots) {
        const bs = (b as unknown as { seat: number }).seat;
        if (bs !== seat) s.intents[bs] = b.think(step);
      }
    }

    const before = tut ? { x: game.players[seat].x, y: game.players[seat].y, a: game.players[seat].ang } : null;
    s.step(step, mine);
    if (tut && before) {
      const p = game.players[seat];
      tut.progress.walked += Math.hypot(p.x - before.x, p.y - before.y);
      tut.progress.turned += Math.abs(((p.ang - before.a + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      if (game.tileAt(p.x, p.y) === 9) tut.progress.reachedStair = true;
    }

    juice(game.drainEvents());

    if (tut) advanceTutorial(tut);
    else if (game.over) {
      live = false;
      setTimeout(() => {
        if (!destroyed) o.onOver();
      }, 1100);
    }
  }

  const loop: Loop = createLoop({
    hz: 60,
    update: (step) => {
      lastRaf = performance.now();
      simStep(step);
    },
    render: () => {
      if (destroyed) return;
      const now = performance.now();
      if (lastFrame > 0 && frames.length < 4000) frames.push(now - lastFrame);
      lastFrame = now;

      const game = g();
      const p = game.players[seat];
      renderer.draw(game, seat, controls.ang(), 0);
      controls.paint(game, seat);
      paintHud(
        content,
        game,
        seat,
        tut ? (now < msgUntil ? msg : STEPS[Math.min(activeStep, STEPS.length - 1)].copy) : now < msgUntil ? msg : '',
        !!tut,
      );
      if (p) p.ang = controls.ang();
      veil.classList.toggle('show', now < veilUntil);
      host.style.transform = now < shakeUntil && !reducedMotion ? `translate(${(Math.random() - 0.5) * 5}px,${(Math.random() - 0.5) * 5}px)` : '';
    },
  });
  loop.start();

  const STARVED_MS = 260;
  let backAcc = 0;
  let backLast = performance.now();
  const backstop = setInterval(() => {
    const now = performance.now();
    // A backgrounded tab clamps setInterval to roughly once a second, so the catch-up budget has to
    // be a whole second of simulation or a backgrounded host runs the mine at a sixth speed — which
    // is not "paused", it is far worse: the crew's game gets slower and slower the longer you look
    // away. Measured at the old 8-step cap: 17% of real time.
    const dt = Math.min(1.2, (now - backLast) / 1000);
    backLast = now;
    if (destroyed || paused) return;
    if (now - lastRaf < STARVED_MS) return;
    backAcc += dt;
    let steps = 0;
    while (backAcc >= STEP && steps < 80) {
      simStep(STEP);
      backAcc -= STEP;
      steps++;
    }
    if (steps >= 80) backAcc = 0;
  }, 100);

  const onVis = (): void => {
    // Only a real switch-away pauses, and only in solo. In a room the mine keeps turning.
    if (document.hidden && !net && live) setPaused(true);
  };
  document.addEventListener('visibilitychange', onVis);

  function advanceTutorial(t: NonNullable<PlayOpts['tutorial']>): void {
    const stp = STEPS[activeStep];
    if (!stp) return;
    if (stp.missed?.(g(), t.progress) && stp.hint) {
      say(stp.hint, 4);
      ping('locked');
      // Re-offer the step rather than let the one idea the game is built on slide past.
      t.progress.dampKills = 0;
      restartTutorialRoom();
      return;
    }
    if (!stp.done(g(), t.progress)) return;
    if (stp.after) say(stp.after, 3.4);
    ping('pickup', 1.3);
    activeStep++;
    // Every step starts you whole. `noDeath` already stops the tutorial killing anybody, but sitting
    // on 1 HP for the rest of it teaches fear rather than the game.
    const me = g().players[0];
    if (me) me.hp = 100;
    STEPS[activeStep]?.enter?.(g());
    if (activeStep >= STEPS.length) {
      live = false;
      setTimeout(() => {
        if (!destroyed) t.onFinish();
      }, 1400);
    }
  }

  function restartTutorialRoom(): void {
    // The three thralls come back so the pocket can be used properly. The rest of the floor stands.
    const game = g();
    for (const sp of game.level.spawns.slice(2)) {
      game.enemies.push(
        Object.assign(gameSpawn(game, sp.kind, sp.x, sp.y), { state: 'chase' as const, target: 0 }),
      );
    }
    game.level.tiles[16 * 21 + 10] = 10;
    game.level.tiles[16 * 21 + 11] = 10;
  }

  // ── pause ──
  function setPaused(on: boolean): void {
    let ov = host.querySelector<HTMLElement>('.pause-ov');
    if (on) {
      if (ov) return;
      paused = true;
      ov = document.createElement('div');
      ov.className = 'pause-ov';
      ov.innerHTML = `<div class="pause-card" role="dialog" aria-modal="true" aria-label="Paused">
        <h2>Paused</h2>
        <p class="pause-note">${
          net ? 'The mine keeps moving — the others are still down there.' : 'The mine is held until you go back.'
        }</p>
        <button class="btn primary" id="resume">Back to it</button>
        <button class="btn" id="phelp">How to play</button>
        <button class="btn ghost" id="pquit">Leave the shaft</button></div>`;
      host.appendChild(ov);
      ov.querySelector('#resume')!.addEventListener('click', () => setPaused(false));
      ov.querySelector('#phelp')!.addEventListener('click', () => sheet(helpHtml(g().mode)));
      ov.querySelector('#pquit')!.addEventListener('click', o.onQuit);
      setTimeout(() => {
        ov?.addEventListener('pointerdown', (ev) => {
          if (!(ev.target as HTMLElement).closest('.pause-card')) setPaused(false);
        });
      }, 350);
    } else {
      paused = false;
      ov?.remove();
    }
  }
  const isPaused = (): boolean => !!host.querySelector('.pause-ov');
  content.querySelector('#pause')!.addEventListener('click', () => setPaused(!isPaused()));
  content.querySelector('#skip')?.addEventListener('click', () => {
    if (tut) {
      live = false;
      tut.onFinish();
    }
  });

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape' || e.key === 'p' || e.key === 'P') setPaused(!isPaused());
  }
  window.addEventListener('keydown', onKey);

  return {
    destroy() {
      destroyed = true;
      loop.stop();
      clearInterval(backstop);
      document.removeEventListener('visibilitychange', onVis);
      cd.cancel();
      clearInterval(refit);
      ro?.disconnect();
      window.removeEventListener('resize', fit);
      window.removeEventListener('keydown', onKey);
      controls.destroy();
      renderer.destroy();
      if (activeControls === controls) activeControls = null;
      if (activeRenderer === renderer) activeRenderer = null;
      host.style.transform = '';
      // Exposed for the browser verification pass; never read by gameplay.
      (window as unknown as { __frames?: number[] }).__frames = frames;
    },
  };
}

/** A spawn on an existing game, used only by the tutorial's replay of its own room. */
function gameSpawn(game: Game, kind: string, x: number, y: number): ReturnType<Game['spawnRemote']> {
  return game.spawnRemote(Math.floor(Math.random() * 60000), kind as never, x, y);
}

const PICKUP_SAY: Record<string, string> = {
  carbide: 'Carbide — patched up.',
  ammoCutter: 'Cutter cells.',
  ammoLance: 'Lance rounds.',
  ammoCharge: 'A charge.',
  amber: 'Amber card.',
  cyan: 'Cyan card.',
  rose: 'Rose card.',
};

// ── screens ─────────────────────────────────────────────────────────────────────────────────────

function showMenu(): void {
  teardown();
  setPlaying(false);
  content.innerHTML = menuHtml({ modeId: myModeChoice, best: bestFor(myModeChoice), muted: sfx.muted(), tierId: 'miner' });

  content.querySelectorAll<HTMLElement>('.chip[data-mode]').forEach((c) =>
    c.addEventListener('click', () => {
      myModeChoice = modeOf(c.dataset.mode).id;
      store.set('mode', myModeChoice);
      ping('select');
      showMenu();
    }),
  );
  content.querySelector('#playSolo')!.addEventListener('click', () => startSolo());
  content.querySelector('#playFriends')!.addEventListener('click', () => showRoomEntry());
  content.querySelector('#help')!.addEventListener('click', () => startTutorial());
  content.querySelector('#about')!.addEventListener('click', () => sheet(aboutHtml()));
  content.querySelector('#mute')!.addEventListener('click', () => {
    sfx.setMuted(!sfx.muted());
    store.set('muted', sfx.muted());
    showMenu();
  });
}

// ── the tutorial ────────────────────────────────────────────────────────────────────────────────

let screen: Screen | null = null;

function startTutorial(): void {
  teardown();
  setPlaying(true);
  const game = tutorialGame();
  const session = new Session(game, true, {
    net: null,
    mySeat: 0,
    onFloor: () => undefined,
    onEvents: () => undefined,
  });
  active = session;
  const progress = freshProgress(game);
  screen = buildPlayScreen({
    session,
    bots: [],
    onQuit: () => finishTutorial(),
    onOver: () => finishTutorial(),
    tutorial: { progress, onFinish: () => finishTutorial() },
  });
  onCleanup(() => screen?.destroy());
}

function finishTutorial(): void {
  store.set('seenTut', true);
  activeStep = -1;
  showMenu();
}

// ── solo ────────────────────────────────────────────────────────────────────────────────────────

function startSolo(): void {
  teardown();
  setPlaying(true);
  runs++;
  const game = new Game({
    seed: newSeed(),
    modeId: myModeChoice,
    players: [{ name: playerName, bot: false }],
    mySeat: 0,
  });
  const session = new Session(game, true, {
    net: null,
    mySeat: 0,
    onFloor: () => undefined,
    onEvents: () => undefined,
  });
  active = session;
  screen = buildPlayScreen({
    session,
    bots: [],
    onQuit: () => showMenu(),
    onOver: () => showResults(false),
  });
  onCleanup(() => screen?.destroy());
}

// ── multiplayer ─────────────────────────────────────────────────────────────────────────────────

let lobby: { repaint(): void; destroy(): void } | null = null;
let lobbyMounted = false;

const repaintLobby = (): void => {
  if (lobbyMounted) lobby?.repaint();
};
const seatOfPeer = (id: string): number => roster.slice(0, MAX_SEATS).findIndex((p) => p.id === id);

function showRoomEntry(): void {
  teardown();
  setPlaying(false);
  content.innerHTML = '<section class="screen"><div id="entry"></div></section>';
  const host = content.querySelector<HTMLElement>('#entry')!;

  const deep = new URL(location.href).searchParams.get('room');
  if (deep) {
    const code = normalizeRoomCode(deep);
    // Honoured ONCE and cleared on the way in, or a reload silently drags the player back into a
    // room they deliberately left, with no way to start a new one.
    clearRoomInUrl();
    if (code.length >= 3) {
      void enterRoom(code, false);
      return;
    }
  }

  const entry = createRoomEntry({
    container: host,
    onSubmit: (code: string, created: boolean) => void enterRoom(normalizeRoomCode(code), created),
    onCancel: showMenu,
    title: 'Play with friends',
    subtitle: 'Start a room and send the link, or type a code you were given. Two to four down the shaft.',
  });
  onCleanup(() => entry.destroy());
}

async function enterRoom(code: string, created: boolean): Promise<void> {
  teardown();
  setPlaying(false);
  roomCode = code;
  setRoomInUrl(code);
  content.innerHTML = '<section class="screen"><div class="lobby-searching"><span class="spinner"></span> Connecting…</div></section>';

  try {
    // ONCE at boot, before ANY mesh: Trystero pre-builds one global connection pool from the first
    // joinRoom's config, so a later call leaves the initiating half of every pair STUN-only.
    setTurnConfig(await getTurnConfig());
  } catch {
    /* fail open — TURN is an upgrade, never a dependency */
  }

  const n = createNet(
    { appId: roomAppId(SLUG), roomId: code, claimHost: created },
    {
      // Promotion. The new host already holds the mine (it derived it from the seed) and the last
      // snapshot, so it simply starts running the clock. It NEVER navigates: this fires after a run
      // ends too, and a showMenu() here would eject the whole crew from the room.
      onHostChange: (_id, isSelf) => {
        if (isSelf && active) {
          active.becomeHost();
          toast('You are running the mine now.');
        }
        repaintLobby();
      },
      onPeers: () => repaintLobby(),
      onPeerLeave: (id) => {
        const seat = seatOfPeer(id);
        const g = active?.game;
        if (g && seat >= 0 && g.players[seat]) g.players[seat].present = false;
        repaintLobby();
      },
    },
  );
  net = n;

  const r = createRounds<{ mode: string }>({
    net: n,
    playerName,
    minPlayers: 2,
    roundOpts: () => ({ mode: myModeChoice }),
    onRound: (info) => startNetRun(info),
    onChange: (s) => {
      const ho = s.hostOpts as { mode?: string } | null;
      if (ho && typeof ho.mode === 'string') hostOptsMode = modeOf(ho.mode).id;
      repaintLobby();
      refreshResults();
    },
  });
  rounds = r;
  showLobby();
}

function showLobby(): void {
  const n = net;
  const r = rounds;
  if (!n || !r) return;
  lobbyMounted = true;
  setPlaying(false);
  content.innerHTML = '<section class="screen"><div id="lobby-host"></div></section>';
  const isHost = (): boolean => n.isHost() && n.hostSettled();

  lobby = createLobby({
    container: content.querySelector<HTMLElement>('#lobby-host')!,
    net: n,
    rounds: r,
    roomCode,
    minPlayers: 2,
    maxPlayers: MAX_SEATS,
    onCancel: () => void leaveRoom(),
    share: { title: 'Come down the shaft with me', text: (c: string) => `Join my Deepshaft room: ${c}` },
    labels: { start: 'Take the cage down' },
    modeSlot: () => {
      if (isHost()) {
        return `<div class="lobby-modes" id="lm">${MODE_IDS.map(
          (id) =>
            `<button class="chip mode-btn${id === myModeChoice ? ' on' : ''}" data-mode="${id}" aria-pressed="${
              id === myModeChoice
            }">${escapeHtml(modeOf(id).name)}</button>`,
        ).join('')}<p class="mode-blurb">${escapeHtml(modeOf(myModeChoice).blurb)}</p></div>`;
      }
      // The host's pick is what the room plays and it arrives GOSSIPED. Rendering our own local
      // choice and labelling it the host's is a confident lie, and it has shipped once in this fleet.
      return `<p class="host-pick">${
        n.hostSettled() ? `The host chose <strong>${escapeHtml(modeOf(hostOptsMode).name)}</strong>` : 'Waiting for the host…'
      }</p>`;
    },
    onModeMount: () => {
      if (!isHost()) return;
      content.querySelectorAll<HTMLElement>('#lm .mode-btn').forEach((b) =>
        b.addEventListener('click', () => {
          myModeChoice = modeOf(b.dataset.mode).id;
          store.set('mode', myModeChoice);
          lobby?.repaint();
        }),
      );
    },
  });
  onCleanup(() => {
    lobby?.destroy();
    lobby = null;
  });
}

function startNetRun(info: RoundInfo<{ mode: string }>): void {
  teardown();
  lobbyMounted = false;
  roster = info.players;
  const mode = modeOf(info.opts?.mode);
  const seated = roster.slice(0, MAX_SEATS);
  const players = Math.max(1, seated.length);
  const mySeat = info.seated ? seated.findIndex((p) => p.id === (net?.selfId ?? '')) : -1;

  if (mySeat < 0) {
    // A peer that connected mid-run is not in the frozen roster. It gets the lobby's spectator view,
    // never a dead screen.
    setPlaying(false);
    showLobby();
    return;
  }

  const names: string[] = [];
  for (let p = 0; p < players; p++) names.push(seated[p]?.name || SEAT_NAME[p]);
  const seen = new Map<string, number>();
  for (const nm of names) seen.set(nm, (seen.get(nm) ?? 0) + 1);
  for (let p = 0; p < players; p++) if ((seen.get(names[p]) ?? 0) > 1) names[p] = `${names[p]} (${SEAT_NAME[p]})`;

  const game = new Game({
    seed: info.seed,
    modeId: mode.id,
    players: names.map((nm) => ({ name: nm, bot: false })),
    mySeat,
  });
  const session = new Session(
    game,
    info.isHost,
    { net, mySeat, onFloor: () => undefined, onEvents: () => undefined },
    seatOfPeer,
  );
  active = session;
  setPlaying(true);
  onCleanup(() => session.destroy());

  screen = buildPlayScreen({
    session,
    bots: [],
    onQuit: () => {
      // End this peer's round FIRST, or the engine lobby paints nothing for a peer still seated in a
      // live round and the player gets a blank screen.
      rounds?.finish();
      backToLobby();
    },
    onOver: () => showResults(true),
  });
  onCleanup(() => screen?.destroy());
}

// ── results ─────────────────────────────────────────────────────────────────────────────────────

let resultsMounted = false;
let multi = false;

function showResults(isMulti: boolean): void {
  teardown();
  setPlaying(false);
  multi = isMulti;
  resultsMounted = true;
  const s = active;
  if (!s) {
    showMenu();
    return;
  }
  const g = s.game;
  noteBest(g.mode.id, g.deepest);
  if (isMulti) rounds?.finish();

  const rows: ResultRow[] = g.players.filter((p) => p.present || p.stats.kills > 0).map((p) => ({
    seat: p.seat,
    name: p.name,
    isSelf: p.seat === g.mySeat,
    down: p.down,
    kills: p.stats.kills,
    damage: Math.round(p.stats.damage),
    doors: p.stats.doors,
    revives: p.stats.revives,
    steps: p.stats.steps,
  }));

  content.innerHTML = `
    <section class="screen results-screen" id="res"></section>
    <div class="menu-actions" id="ract"></div>`;
  content.querySelector('#res')!.innerHTML = resultsHtml({
    rows,
    mode: g.mode,
    deepest: g.deepest,
    won: g.won,
    seconds: g.runTime,
    cause: g.won ? 'You walked out of the bottom of it.' : causeOf(g),
    best: bestFor(g.mode.id),
    runs,
    multi: isMulti,
  });

  const act = content.querySelector<HTMLElement>('#ract')!;
  act.innerHTML = isMulti
    ? `<button class="btn primary" id="again">Go again</button>
       <p class="waiting-note" id="waiting" aria-live="polite"></p>
       <button class="btn" id="lobby">Back to the lobby</button>
       <button class="btn ghost" id="menu">Main menu</button>
       <button class="btn ghost results-feedback" id="feedback">Report a problem</button>`
    : `<button class="btn primary" id="again">Go again</button>
       <button class="btn" id="share">Share</button>
       <button class="btn ghost" id="menu">Main menu</button>
       <button class="btn ghost results-feedback" id="feedback">Report a problem</button>`;

  act.querySelector('#feedback')!.addEventListener('click', (e) =>
    window.feedback?.open({ returnFocusTo: e.currentTarget as HTMLElement }),
  );
  act.querySelector('#menu')!.addEventListener('click', () => (isMulti ? void leaveRoom() : showMenu()));
  if (isMulti) {
    const again = act.querySelector<HTMLButtonElement>('#again')!;
    again.addEventListener('click', () => {
      rounds?.vote();
      again.disabled = true;
      again.textContent = 'Waiting for the crew…';
      refreshResults();
    });
    act.querySelector('#lobby')!.addEventListener('click', () => backToLobby());
    refreshResults();
  } else {
    act.querySelector('#again')!.addEventListener('click', () => startSolo());
    act.querySelector('#share')!.addEventListener('click', () => void share());
  }
  onCleanup(() => {
    resultsMounted = false;
  });
}

function causeOf(g: Game): string {
  const down = g.players.filter((p) => p.present && p.down);
  if (down.length === g.players.filter((p) => p.present).length && down.length > 1) return 'The whole crew went down.';
  if (g.players.some((p) => p.stats.damp > 20)) return 'The gas got you as much as anything did.';
  return 'The mine closed over you.';
}

function refreshResults(): void {
  if (!resultsMounted || !multi) return;
  const waiting = content.querySelector<HTMLElement>('#waiting');
  if (!waiting) return;
  const r = rounds?.state();
  if (r && r.startsInMs !== null) {
    waiting.textContent = `Next run in ${Math.ceil(r.startsInMs / 1000)}s — ${r.votes.length}/${Math.max(r.present.length, 1)} ready`;
  } else if (r && r.votes.length) {
    waiting.textContent = `${r.votes.length}/${Math.max(r.present.length, 1)} ready to go again`;
  } else {
    waiting.textContent = '';
  }
}
setInterval(() => refreshResults(), 400);

async function share(): Promise<void> {
  const g = active?.game;
  if (!g) return;
  const text = `Deepshaft · ${g.mode.name} — I got to floor ${g.deepest}.\nhttps://deepshaft.benrichardson.dev`;
  try {
    if (navigator.share) {
      await navigator.share({ text });
      return;
    }
  } catch {
    /* cancelled — fall through to copy */
  }
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard');
  } catch {
    toast('Could not copy');
  }
}

function backToLobby(): void {
  teardown();
  active = null;
  if (net && rounds) showLobby();
  else showMenu();
}

async function leaveRoom(): Promise<void> {
  teardown();
  clearRoomInUrl();
  lobbyMounted = false;
  active = null;
  const n = net;
  const r = rounds;
  net = null;
  rounds = null;
  r?.destroy();
  if (n) {
    try {
      await n.leave();
    } catch {
      /* leaving is best-effort */
    }
  }
  showMenu();
}

// ── boot ────────────────────────────────────────────────────────────────────────────────────────

function boot(): void {
  hardenViewport();
  mountShell();
  const room = new URL(location.href).searchParams.get('room');
  if (room && normalizeRoomCode(room).length >= 3) showRoomEntry();
  else if (!store.get<boolean>('seenTut', false)) startTutorial();
  else showMenu();
  window.addEventListener('beforeunload', () => {
    void net?.leave();
  });
}

/** Exposed so the browser-verification pass can drive the real game. Never read by gameplay. */
(window as unknown as { __deepshaft?: unknown }).__deepshaft = {
  state(): unknown {
    const s = active;
    if (!s) return null;
    const g = s.game;
    const p = g.players[g.mySeat ?? 0];
    return {
      mode: g.mode.id,
      side: g.level.side,
      floor: g.floor,
      deepest: g.deepest,
      over: g.over,
      won: g.won,
      host: s.host,
      players: g.players.length,
      enemies: g.enemies.length,
      hp: p?.hp ?? 0,
      down: p?.down ?? false,
      ammo: p ? { ...p.ammo } : null,
      weapon: p?.weapon,
      keys: p ? [...p.keys] : [],
      x: p?.x,
      y: p?.y,
      step: activeStep,
      stepCopy: activeStep >= 0 ? STEPS[Math.min(activeStep, STEPS.length - 1)].copy : null,
    };
  },
  /**
   * Hold a synthetic hand. The real loop consumes it, so the tutorial gate and every step's
   * completion check run exactly as they do for a finger. `hold(null)` lets go.
   */
  hold(v: { mx?: number; my?: number; turn?: number; fire?: boolean; use?: boolean } | null): void {
    synth = v ? { mx: v.mx ?? 0, my: v.my ?? 0, turn: v.turn ?? 0, fire: v.fire ?? false, use: v.use ?? false } : null;
  },
  /** Step the simulation directly, bypassing the input layer. For rules probes only. */
  drive(ticks: number, mx: number, my: number, dAng: number, fire: boolean, use = false): void {
    const s = active;
    if (!s) return;
    const seat = s.game.mySeat ?? 0;
    for (let i = 0; i < ticks; i++) {
      const p = s.game.players[seat];
      const ang = (p?.ang ?? 0) + dAng;
      activeControls?.setAng(ang);
      s.step(STEP, { mx, my, ang, fire, use: use && i === 0, weapon: p?.weapon ?? 'cutter' });
    }
  },
  /** Where the raycaster actually painted a pixel, for the contrast probe. 0..1 across the view. */
  pixel(fx: number, fy: number): [number, number, number] | null {
    return activeRenderer ? activeRenderer.sampleAt(fx, fy) : null;
  },
  view: () => activeRenderer?.size() ?? null,
  frames: () => (window as unknown as { __frames?: number[] }).__frames ?? [],
  modes: MODE_IDS,
  weapons: WEAPON_ORDER,
  steps: STEPS.map((s) => s.id),
  seenTut: () => store.get<boolean>('seenTut', false),
  forgetTut: () => store.set('seenTut', false),
  bot: (seat: number) => new Bot(active!.game, seat, tierOf('miner'), {}, 1),
};

boot();
