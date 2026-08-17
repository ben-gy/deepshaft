// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// See ADDITIONAL-TERMS.md for the section 7(b) attribution requirement.
//
// Deepshaft — every pixel in the game, generated at boot. No image files, no sprite sheets, no
// fonts on the play surface.
//
// Textures and sprites are baked ONCE into Uint32Array bitmaps (packed ABGR, little-endian) so the
// raycaster's inner loop is an array read and a multiply rather than a canvas call. They are drawn
// with ordinary Canvas 2D paths into an offscreen canvas and read straight back — which is how a
// procedural sprite gets to look hand-drawn without anybody hand-drawing it.
//
// The enemy sprites are deliberately four different SILHOUETTES — tall and thin, squat and wide, a
// blade, a block. Colour separates them second; shape separates them first, which is the only
// version of that guarantee that survives colour blindness and a 240-pixel-wide render target.

import {
  DOOR,
  DOOR_TRIM,
  DOWN_BODY,
  ENEMY,
  LAMP,
  LOCK,
  LOCK_TRIM,
  PICKUP,
  SEAT,
  SPRITE_RIM,
  STAIR,
  STAIR_TREAD,
  WALLS,
  hexToRgb,
  type EnemyKind,
  type WallKind,
} from './palette';

export const TEX = 32;
export const SPR_W = 40;
export const SPR_H = 56;

export interface Bitmap {
  w: number;
  h: number;
  px: Uint32Array;
}

const pack = (r: number, g: number, b: number, a = 255): number => ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;

function surface(w: number, h: number): { c: HTMLCanvasElement; x: CanvasRenderingContext2D } | null {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const x = c.getContext('2d', { willReadFrequently: true });
  return x ? { c, x } : null;
}

function grab(w: number, h: number, draw: (x: CanvasRenderingContext2D) => void): Bitmap {
  const s = surface(w, h);
  if (!s) return { w, h, px: new Uint32Array(w * h) };
  draw(s.x);
  const data = s.x.getImageData(0, 0, w, h).data;
  const px = new Uint32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    px[i] = pack(data[i * 4], data[i * 4 + 1], data[i * 4 + 2], data[i * 4 + 3]);
  }
  return { w, h, px };
}

/** A tiny deterministic hash-noise, so two builds bake identical rock. */
const noise = (x: number, y: number, s: number): number => {
  let h = (x * 374761393 + y * 668265263 + s * 1442695040888963407) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

function rockTexture(base: string, seedN: number, banded: boolean): Bitmap {
  const { r, g, b } = hexToRgb(base);
  return grab(TEX, TEX, (x) => {
    for (let py = 0; py < TEX; py++) {
      for (let px = 0; px < TEX; px++) {
        // Two octaves of blocky noise, plus a horizontal banding for bedded rock. The mortar lines
        // are what make a corridor readable at speed — a flat wall gives the eye nothing to move
        // against and the whole level reads as a still image.
        const n = noise(px >> 1, py >> 1, seedN) * 0.6 + noise(px, py, seedN + 7) * 0.4;
        let k = 0.78 + n * 0.44;
        if (banded && py % 8 === 0) k *= 0.62;
        if (banded && px % 16 === 0 && py % 8 > 3) k *= 0.7;
        if (!banded && (px + (py >> 2) * 5) % 13 === 0) k *= 0.84;
        x.fillStyle = `rgb(${Math.min(255, r * k) | 0},${Math.min(255, g * k) | 0},${Math.min(255, b * k) | 0})`;
        x.fillRect(px, py, 1, 1);
      }
    }
  });
}

function panelTexture(base: string, trim: string): Bitmap {
  const { r, g, b } = hexToRgb(base);
  return grab(TEX, TEX, (x) => {
    x.fillStyle = `rgb(${r},${g},${b})`;
    x.fillRect(0, 0, TEX, TEX);
    x.strokeStyle = trim;
    x.lineWidth = 2;
    x.strokeRect(3, 2, TEX - 6, TEX - 4);
    x.beginPath();
    x.moveTo(TEX / 2, 3);
    x.lineTo(TEX / 2, TEX - 3);
    x.stroke();
    // A pair of bolts, so a door reads as made rather than grown.
    x.fillStyle = trim;
    x.fillRect(TEX / 2 - 5, TEX / 2 - 2, 3, 4);
    x.fillRect(TEX / 2 + 2, TEX / 2 - 2, 3, 4);
  });
}

export interface ArtSet {
  walls: Record<WallKind, Bitmap>;
  door: Bitmap;
  locks: Record<string, Bitmap>;
  stair: Bitmap;
  enemies: Record<EnemyKind, Bitmap>;
  pickups: Record<string, Bitmap>;
  keys: Record<string, Bitmap>;
  mate: Bitmap[];
  down: Bitmap;
}

// ── sprites ─────────────────────────────────────────────────────────────────────────────────────
// Each is drawn inside SPR_W x SPR_H with a hard dark rim, because the rim is what separates a
// self-lit body from a bright near wall. Transparent elsewhere; alpha 0 pixels are skipped.

function rimmed(draw: (x: CanvasRenderingContext2D) => void): Bitmap {
  return grab(SPR_W, SPR_H, (x) => {
    x.lineJoin = 'round';
    x.lineCap = 'round';
    draw(x);
  });
}

function enemySprite(kind: EnemyKind): Bitmap {
  const c = ENEMY[kind];
  return rimmed((x) => {
    x.strokeStyle = SPRITE_RIM;
    x.fillStyle = c;
    const body = new Path2D();
    if (kind === 'thrall') {
      // Tall, narrow, stooped — a person-shape that is not quite a person.
      body.moveTo(20, 4);
      body.bezierCurveTo(28, 6, 30, 18, 27, 30);
      body.lineTo(29, 52);
      body.lineTo(23, 52);
      body.lineTo(20, 38);
      body.lineTo(17, 52);
      body.lineTo(11, 52);
      body.lineTo(13, 30);
      body.bezierCurveTo(10, 18, 12, 6, 20, 4);
      body.closePath();
    } else if (kind === 'lurker') {
      // Squat and wide, low to the ground, with a raised spout.
      body.moveTo(6, 52);
      body.bezierCurveTo(2, 40, 8, 26, 20, 26);
      body.bezierCurveTo(32, 26, 38, 40, 34, 52);
      body.closePath();
      body.moveTo(17, 28);
      body.lineTo(20, 10);
      body.lineTo(24, 28);
      body.closePath();
    } else if (kind === 'stalker') {
      // A blade on legs. Almost no width, which is what makes it hard to hit and easy to name.
      body.moveTo(20, 2);
      body.lineTo(25, 22);
      body.lineTo(22, 34);
      body.lineTo(28, 52);
      body.lineTo(23, 52);
      body.lineTo(20, 40);
      body.lineTo(17, 52);
      body.lineTo(12, 52);
      body.lineTo(18, 34);
      body.lineTo(15, 22);
      body.closePath();
    } else {
      // A block with shoulders. It fills a corridor and it is supposed to look like it.
      body.moveTo(5, 52);
      body.lineTo(5, 20);
      body.lineTo(11, 12);
      body.lineTo(29, 12);
      body.lineTo(35, 20);
      body.lineTo(35, 52);
      body.closePath();
    }
    x.lineWidth = 5;
    x.stroke(body);
    x.fill(body);

    // The eye. One bright mark that tells you which way it is facing, and the only thing that reads
    // at twenty cells when the body is four pixels wide.
    x.fillStyle = SPRITE_RIM;
    if (kind === 'hauler') {
      x.fillRect(11, 19, 18, 5);
    } else if (kind === 'lurker') {
      x.beginPath();
      x.arc(14, 38, 3.2, 0, Math.PI * 2);
      x.arc(26, 38, 3.2, 0, Math.PI * 2);
      x.fill();
    } else {
      x.beginPath();
      x.arc(20, kind === 'stalker' ? 12 : 13, 3.4, 0, Math.PI * 2);
      x.fill();
    }
  });
}

function pickupSprite(colour: string, glyph: 'bar' | 'cross' | 'orb'): Bitmap {
  return rimmed((x) => {
    x.strokeStyle = SPRITE_RIM;
    x.lineWidth = 4;
    x.fillStyle = colour;
    const p = new Path2D();
    if (glyph === 'bar') {
      p.rect(10, 30, 20, 13);
    } else if (glyph === 'cross') {
      p.rect(16, 26, 8, 22);
      p.rect(9, 33, 22, 8);
    } else {
      p.arc(20, 38, 10, 0, Math.PI * 2);
    }
    x.stroke(p);
    x.fill(p);
  });
}

function keySprite(colour: string, notches: number): Bitmap {
  return rimmed((x) => {
    x.strokeStyle = SPRITE_RIM;
    x.lineWidth = 4;
    x.fillStyle = colour;
    const p = new Path2D();
    p.rect(9, 28, 22, 16);
    x.stroke(p);
    x.fill(p);
    // The notch count is the second channel: a colour-blind player reads the card by its teeth.
    x.fillStyle = SPRITE_RIM;
    for (let i = 0; i < notches; i++) x.fillRect(12 + i * 6, 38, 4, 6);
  });
}

function mateSprite(colour: string): Bitmap {
  return rimmed((x) => {
    x.strokeStyle = SPRITE_RIM;
    x.lineWidth = 4;
    x.fillStyle = colour;
    const p = new Path2D();
    p.moveTo(20, 8);
    p.lineTo(29, 22);
    p.lineTo(26, 50);
    p.lineTo(14, 50);
    p.lineTo(11, 22);
    p.closePath();
    x.stroke(p);
    x.fill(p);
    // A lamp on the helmet, so a mate down a dark gallery is a light rather than a shape.
    x.fillStyle = LAMP;
    x.beginPath();
    x.arc(20, 12, 4.5, 0, Math.PI * 2);
    x.fill();
  });
}

function downSprite(): Bitmap {
  return rimmed((x) => {
    x.strokeStyle = SPRITE_RIM;
    x.lineWidth = 4;
    x.fillStyle = DOWN_BODY;
    const p = new Path2D();
    p.rect(6, 40, 28, 10);
    x.stroke(p);
    x.fill(p);
    x.fillStyle = LAMP;
    x.beginPath();
    x.arc(10, 36, 4, 0, Math.PI * 2);
    x.fill();
  });
}

let cached: ArtSet | null = null;

/** Bake everything once. Safe to call repeatedly; the second call is free. */
export function art(): ArtSet {
  if (cached) return cached;
  cached = {
    walls: {
      rock: rockTexture(WALLS.rock, 11, false),
      timber: rockTexture(WALLS.timber, 29, true),
      seamface: rockTexture(WALLS.seamface, 47, true),
      brick: rockTexture(WALLS.brick, 61, true),
    },
    door: panelTexture(DOOR, DOOR_TRIM),
    locks: {
      amber: panelTexture(LOCK.amber, LOCK_TRIM.amber),
      cyan: panelTexture(LOCK.cyan, LOCK_TRIM.cyan),
      rose: panelTexture(LOCK.rose, LOCK_TRIM.rose),
    },
    stair: grab(TEX, TEX, (x) => {
      x.fillStyle = STAIR;
      x.fillRect(0, 0, TEX, TEX);
      x.fillStyle = STAIR_TREAD;
      for (let i = 0; i < 4; i++) x.fillRect(0, 4 + i * 8, TEX, 3);
    }),
    enemies: {
      thrall: enemySprite('thrall'),
      lurker: enemySprite('lurker'),
      stalker: enemySprite('stalker'),
      hauler: enemySprite('hauler'),
    },
    pickups: {
      ammoCutter: pickupSprite(PICKUP.ammo, 'bar'),
      ammoLance: pickupSprite(PICKUP.ammo, 'orb'),
      ammoCharge: pickupSprite(PICKUP.charge, 'orb'),
      carbide: pickupSprite(PICKUP.carbide, 'cross'),
    },
    keys: {
      amber: keySprite(LOCK.amber, 1),
      cyan: keySprite(LOCK.cyan, 2),
      rose: keySprite(LOCK.rose, 3),
    },
    mate: SEAT.map((c) => mateSprite(c)),
    down: downSprite(),
  };
  return cached;
}
