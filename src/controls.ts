// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// See ADDITIONAL-TERMS.md for the section 7(b) attribution requirement.
//
// Deepshaft — turning a hand into an `Intent`.
//
// ── THE ONE DECISION THAT MAKES A FIRST-PERSON GAME WORK ON A PHONE ─────────────────────────────
// A shooter needs to move AND to look, and a phone has one comfortable thumb. Every scheme that
// splits those across two fixed sticks either forces a second hand or puts a control under the thing
// you are trying to see. So here the FLOATING STICK CARRIES BOTH: push it forward to walk, push it
// sideways to TURN. There is no strafe on touch, which is a design choice and not a shortcut —
// `PLAYER.strafeScale` exists for desktop and the comment beside it is the reason: circling has a
// cost and facing is a real commitment.
//
// The sideways axis is curved (`|x|^1.6`), which is the whole trick: half a thumb-width is 25°/s for
// lining a shot up, full deflection is 166°/s for spinning round when something is behind you. A
// linear axis cannot do both, and a stalker orbiting at 1.5 cells needs 116°/s to track — under the
// ceiling, which is how "one thumb" survives contact with the fastest thing in the roster.
//
// Everything else follows from it:
//  · The stick spawns wherever the thumb lands in the bottom band, so the game is handedness-blind.
//  · There is NO fire button — the gun engages what is awake in front of it, so aiming IS the whole
//    of firing, and a trigger would be a second thing to hold.
//  · USE only exists when something is usable, so the corner is empty the rest of the time.
//  · A SECOND, concurrent finger is an optional look-drag for anyone who wants it. Nothing needs it.
//  · Nothing sits in the middle 56% of the screen, so reaching across the view is structurally
//    impossible rather than merely discouraged.

import { createJoystick, type Joystick } from '@ben-gy/game-engine/joystick';
import { Game, type Intent } from './game';
import { isDoorTile, T, TILE_LOCK } from './mine';
import { PLAYER, WEAPON_ORDER, type WeaponId } from './tuning';

/** Degrees per second at full sideways deflection, and the curve that gets there. */
const TURN_MAX = PLAYER.turnRate;
const TURN_CURVE = 1.6;
/** Radians per CSS pixel of look-drag. */
const LOOK_RATE = 0.006;
/** Pixels of slop before a second finger counts as a look-drag rather than a stray touch. */
const LOOK_SLOP = 4;
/** Mouse yaw, radians per pixel of movementX. */
const MOUSE_RATE = 0.0024;

export interface ControlsConfig {
  /** The layer the stick and the look-drag live on. Buttons are its siblings, never its children. */
  surface: HTMLElement;
  /** Where the action buttons are mounted. */
  pad: HTMLElement;
  canvas: HTMLCanvasElement;
  reducedMotion: boolean;
  onSwap: () => void;
  /** Fired on a genuine tap of USE, so the game can play a sound even if nothing happens. */
  onUse: () => void;
}

export interface Controls {
  /** Sample the current hand and fold it into an intent for this fixed step. */
  read(game: Game, seat: number, step: number): Intent;
  /** Show or hide the USE affordance and label the weapon button. Called once per frame. */
  paint(game: Game, seat: number): void;
  ang(): number;
  setAng(a: number): void;
  touchLikely(): boolean;
  destroy(): void;
}

export function createControls(cfg: ControlsConfig): Controls {
  let ang = 0;
  let weapon: WeaponId = 'cutter';
  let use = false;
  let usedThisFrame = false;
  let lookDelta = 0;
  let touched = false;

  const keys = new Set<string>();
  let mouseYaw = 0;
  let locked = false;

  // ── the floating stick ──
  const stick: Joystick = createJoystick({
    surface: cfg.surface,
    reducedMotion: cfg.reducedMotion,
    deadZone: 0.12,
    onStart: () => {
      touched = true;
    },
  });

  // ── the optional second finger: relative look-drag ──
  // It attaches to the same surface but tracks a DIFFERENT pointerId from the stick's, so the two
  // never fight. `pointercancel` is handled exactly like `pointerup`: an incoming call fires cancel,
  // and a look that keeps spinning after the phone rings is a bug people remember.
  let lookId: number | null = null;
  let lookX = 0;
  let lookMoved = 0;

  const onDown = (e: PointerEvent): void => {
    touched = true;
    if (lookId !== null || !stick.active()) return;
    lookId = e.pointerId;
    lookX = e.clientX;
    lookMoved = 0;
  };
  const onMove = (e: PointerEvent): void => {
    if (e.pointerId !== lookId) return;
    const dx = e.clientX - lookX;
    lookX = e.clientX;
    lookMoved += Math.abs(dx);
    if (lookMoved > LOOK_SLOP) lookDelta += dx * LOOK_RATE;
  };
  const onUp = (e: PointerEvent): void => {
    if (e.pointerId === lookId) lookId = null;
  };
  cfg.surface.addEventListener('pointerdown', onDown);
  cfg.surface.addEventListener('pointermove', onMove);
  cfg.surface.addEventListener('pointerup', onUp);
  cfg.surface.addEventListener('pointercancel', onUp);

  // ── the two buttons ──
  cfg.pad.innerHTML = `
    <button class="actbtn wide" id="btnSwap" type="button" aria-label="Change weapon">
      <span class="wname">CUTTER</span><span class="wammo">0</span>
    </button>
    <button class="actbtn" id="btnUse" type="button" aria-label="Use" hidden>USE</button>`;
  const btnUse = cfg.pad.querySelector<HTMLButtonElement>('#btnUse')!;
  const btnSwap = cfg.pad.querySelector<HTMLButtonElement>('#btnSwap')!;
  const wname = btnSwap.querySelector<HTMLElement>('.wname')!;
  const wammo = btnSwap.querySelector<HTMLElement>('.wammo')!;

  // pointerdown, not click: a tap must register on contact, and attaching BOTH would fire twice.
  const pressUse = (e: PointerEvent): void => {
    e.preventDefault();
    touched = true;
    use = true;
    usedThisFrame = true;
    cfg.onUse();
  };
  const pressSwap = (e: PointerEvent): void => {
    e.preventDefault();
    touched = true;
    cfg.onSwap();
  };
  btnUse.addEventListener('pointerdown', pressUse);
  btnSwap.addEventListener('pointerdown', pressSwap);

  // ── desktop ──
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    keys.add(e.key.toLowerCase());
    if (e.key === 'e' || e.key === 'E') {
      use = true;
      usedThisFrame = true;
      cfg.onUse();
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      cfg.onSwap();
    }
    if (/^[123]$/.test(e.key)) weapon = WEAPON_ORDER[Number(e.key) - 1];
  };
  const onKeyUp = (e: KeyboardEvent): void => void keys.delete(e.key.toLowerCase());
  const onWheel = (e: WheelEvent): void => {
    if (Math.abs(e.deltaY) < 4) return;
    cfg.onSwap();
  };
  const onMouseMove = (e: MouseEvent): void => {
    if (!locked) return;
    mouseYaw += e.movementX * MOUSE_RATE;
  };
  const onLockChange = (): void => void (locked = document.pointerLockElement === cfg.canvas);
  const onCanvasDown = (): void => {
    // Requested on a real click, never on load, and a refusal is not an error — the fallback below
    // steers from the cursor's horizontal offset, so the mouse still works either way.
    if (locked) return;
    try {
      const r = cfg.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      if (r && typeof r.catch === 'function') r.catch(() => undefined);
    } catch {
      /* pointer lock is an upgrade, not a dependency */
    }
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('wheel', onWheel, { passive: true });
  window.addEventListener('mousemove', onMouseMove);
  document.addEventListener('pointerlockchange', onLockChange);
  cfg.canvas.addEventListener('mousedown', onCanvasDown);

  /** Mouse fallback when pointer lock is denied: yaw from how far off centre the cursor sits. */
  let cursorX = 0;
  const onPlainMove = (e: MouseEvent): void => void (cursorX = e.clientX);
  window.addEventListener('mousemove', onPlainMove);

  function read(game: Game, seat: number, step: number): Intent {
    const v = stick.vector();

    // ── yaw: one integrator, applied in the fixed step, never in an event handler ──
    let turn = 0;
    if (v.mag > 0) {
      const sx = v.x * v.mag;
      turn += Math.sign(sx) * Math.pow(Math.abs(sx), TURN_CURVE) * TURN_MAX;
    }
    // Q and the arrows turn; E is USE, so it never appears here. A keyboard turn is a little slower
    // than a full stick deflection on purpose — a mouse is the fast way round on a desktop.
    if (keys.has('q') || keys.has('arrowleft')) turn -= TURN_MAX * 0.72;
    if (keys.has('arrowright')) turn += TURN_MAX * 0.72;
    ang += turn * step + lookDelta + mouseYaw;
    if (!locked && !touched && cursorX > 0) {
      const u = Math.max(-1, Math.min(1, (cursorX - window.innerWidth / 2) / (window.innerWidth / 2)));
      if (Math.abs(u) > 0.12) ang += Math.sign(u) * Math.pow(Math.abs(u), TURN_CURVE) * TURN_MAX * step;
    }
    lookDelta = 0;
    mouseYaw = 0;

    // ── move ──
    let my = 0;
    let mx = 0;
    if (v.mag > 0) my = v.y * v.mag * -1;
    if (keys.has('w') || keys.has('arrowup')) my += 1;
    if (keys.has('s') || keys.has('arrowdown')) my -= 1;
    // Strafe is a desktop-only verb, and the balance sim's reference arm is the touch scheme without
    // it, so a keyboard is a comfort rather than an advantage worth measuring.
    if (keys.has('a')) mx -= 1;
    if (keys.has('d')) mx += 1;

    const p = game.players[seat];
    if (p) weapon = p.ammo[weapon] >= 0 ? weapon : weapon;

    const intent: Intent = {
      mx: Math.max(-1, Math.min(1, mx)),
      my: Math.max(-1, Math.min(1, my)),
      ang,
      // No trigger. The gun engages whatever is awake in the cone; see the note in game.ts.
      fire: true,
      use: usedThisFrame || use,
      weapon,
    };
    usedThisFrame = false;
    use = false;
    return intent;
  }

  /** What can this player use right now? Also the answer to whether USE should exist. */
  function usable(game: Game, seat: number): boolean {
    const p = game.players[seat];
    if (!p || p.down) return false;
    if (game.players.some((o) => o !== p && o.present && o.down && Math.hypot(o.x - p.x, o.y - p.y) <= PLAYER.reviveRange + 0.4)) {
      return true;
    }
    const x = (p.x + Math.cos(p.ang) * 0.85) | 0;
    const y = (p.y + Math.sin(p.ang) * 0.85) | 0;
    const s = game.level.side;
    if (x < 0 || y < 0 || x >= s || y >= s) return false;
    const t = game.level.tiles[y * s + x];
    if (t === T.STAIR) return true;
    if (!isDoorTile(t) || game.doors[y * s + x] > 0) return false;
    const colour = TILE_LOCK[t];
    return !colour || p.keys.has(colour);
  }

  function paint(game: Game, seat: number): void {
    const p = game.players[seat];
    if (!p) return;
    weapon = p.weapon;
    wname.textContent = p.weapon.toUpperCase();
    wammo.textContent = String(p.ammo[p.weapon]);
    btnSwap.classList.toggle('on', p.ammo[p.weapon] > 0);
    // The button exists only when it would do something. Nobody has to be told what it is for.
    btnUse.hidden = !usable(game, seat);
  }

  return {
    read,
    paint,
    ang: () => ang,
    setAng: (a) => void (ang = a),
    touchLikely: () => touched,
    destroy() {
      stick.destroy();
      cfg.surface.removeEventListener('pointerdown', onDown);
      cfg.surface.removeEventListener('pointermove', onMove);
      cfg.surface.removeEventListener('pointerup', onUp);
      cfg.surface.removeEventListener('pointercancel', onUp);
      btnUse.removeEventListener('pointerdown', pressUse);
      btnSwap.removeEventListener('pointerdown', pressSwap);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mousemove', onPlainMove);
      document.removeEventListener('pointerlockchange', onLockChange);
      cfg.canvas.removeEventListener('mousedown', onCanvasDown);
      if (locked && document.exitPointerLock) document.exitPointerLock();
    },
  };
}
