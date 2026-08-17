// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// See ADDITIONAL-TERMS.md for the section 7(b) attribution requirement.
//
// Deepshaft — the raycaster.
//
// ── THE THREE DECISIONS THAT MAKE IT RUN ON A PHONE ─────────────────────────────────────────────
// 1. INTERNAL RESOLUTION IS FIXED AND SMALL, AND THE BROWSER DOES THE UPSCALE. A 375px phone at
//    devicePixelRatio 3 is 1125 physical columns; casting and shading a million pixels per frame in
//    JavaScript is not a thing that happens at 60fps. So the world is drawn into a ~260-column
//    buffer and stretched by the compositor with `image-rendering: pixelated`. That is a fortieth of
//    the fill, it is free (the GPU does it), and it looks deliberate rather than cheap.
// 2. ONE putImageData PER FRAME. Walls, floor, ceiling, sprites and bolts all write into the same
//    Uint32Array. There is no per-sprite canvas call and no clipping path — sprite occlusion is a
//    per-column compare against the wall depth buffer, which is one float read per column.
// 3. FOG IS A LOOKUP, NOT A MULTIPLY. Shade levels are quantised to 32 steps and each step is a
//    256-entry byte table baked once, so shading a pixel is three array reads.
//
// ── AND THE ONE THAT MAKES IT VISIBLE ───────────────────────────────────────────────────────────
// Walls fog with distance. SPRITES DO NOT — see the long note in palette.ts. Fogging a body on the
// same curve as the wall behind it drives their contrast ratio toward 1:1, so the far end of a
// corridor becomes a place where monsters are drawn correctly and cannot be seen. Distance is
// carried by size instead. `tests/contrast.test.ts` pins `spriteFog()` at 1 so this cannot be
// "polished" back in.

import { art, TEX, type Bitmap } from './art';
import { Game, type Enemy } from './game';
import { isDoorTile, T, TILE_LOCK } from './mine';
import {
  BOLT_ENEMY,
  BOLT_MINE,
  CEIL_FAR,
  CEIL_NEAR,
  FLOOR_FAR,
  FLOOR_NEAR,
  SIDE_SHADE,
  hexToRgb,
  spriteFog,
  wallFog,
} from './palette';
import { PLAYER } from './tuning';

/** Horizontal field of view scale. 0.85 is roughly 66 degrees at 4:3. */
const FOV = 0.85;
/**
 * How tall a wall is drawn, relative to the naive `H / distance`.
 *
 * The textbook formula assumes the screen is about as tall as a wall is at one cell. A phone held
 * upright is more than twice as tall as it is wide, so the textbook version draws a thin band of
 * gallery floating in a black letterbox — which is exactly what the first build looked like. Scaling
 * the wall height by the aspect ratio narrows the VERTICAL field of view instead, which fills the
 * screen and reads as being in a tunnel rather than looking at a postcard of one.
 *
 * The CEILING on it is the second lesson, and it cost a round of screenshots to learn. At 0.78 the
 * factor reached 1.7 on a phone, and a wall three cells away already filled the frame edge to edge:
 * every screenshot of a normal corridor looked like a player pressed into a dead end, because there
 * was no floor and no ceiling left to give the eye any depth. 0.6, capped at 1.45, fills the screen
 * without eating the horizon.
 */
const wallScale = (w: number, h: number): number => Math.max(1, Math.min(1.45, (h / w) * 0.6));
const SHADES = 32;

const packRgb = (r: number, g: number, b: number): number => ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;

/** 32 shade levels x 256 byte values, so fogging a channel is one lookup. */
function shadeTables(): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let s = 0; s < SHADES; s++) {
    const k = s / (SHADES - 1);
    const t = new Uint8Array(256);
    for (let v = 0; v < 256; v++) t[v] = Math.min(255, Math.round(v * k));
    out.push(t);
  }
  return out;
}

export interface ViewSize {
  w: number;
  h: number;
}

export interface Renderer {
  resize(cssW: number, cssH: number): void;
  draw(game: Game, seat: number, ang: number, alpha: number): void;
  size(): ViewSize;
  /** Sample the rendered buffer, for the in-browser contrast probe. */
  sampleAt(fx: number, fy: number): [number, number, number];
  destroy(): void;
}

export function createRenderer(canvas: HTMLCanvasElement): Renderer {
  const ctx = canvas.getContext('2d', { alpha: false });
  const tables = shadeTables();
  let W = 260;
  let H = 180;
  let img: ImageData | null = null;
  let buf = new Uint32Array(0);
  let depth = new Float32Array(0);
  let scratch: HTMLCanvasElement | null = null;
  let sctx: CanvasRenderingContext2D | null = null;

  const shadeIdx = (k: number): number => Math.max(0, Math.min(SHADES - 1, Math.round(k * (SHADES - 1))));

  function alloc(w: number, h: number): void {
    W = w;
    H = h;
    depth = new Float32Array(W);
    if (!scratch) {
      scratch = document.createElement('canvas');
      sctx = scratch.getContext('2d');
    }
    scratch.width = W;
    scratch.height = H;
    img = sctx ? sctx.createImageData(W, H) : null;
    buf = img ? new Uint32Array(img.data.buffer) : new Uint32Array(W * H);
  }

  function resize(cssW: number, cssH: number): void {
    // A zero measurement is a transient — a hidden tab, a layout mid-flight. Computing a scale from
    // it yields NaN world coordinates and silently eats every tap, so it is ignored outright.
    if (cssW < 2 || cssH < 2) return;
    canvas.width = Math.max(1, Math.round(cssW));
    canvas.height = Math.max(1, Math.round(cssH));
    const aspect = cssW / cssH;
    // Internal width tracks the display so a desktop gets more detail than a phone, capped so the
    // pixel budget per frame never exceeds ~110k whatever the screen.
    let w = Math.max(170, Math.min(400, Math.round(cssW / 2.6)));
    let h = Math.max(120, Math.round(w / aspect));
    while (w * h > 110000) {
      w = Math.round(w * 0.94);
      h = Math.max(120, Math.round(w / aspect));
    }
    alloc(w, h);
  }

  // ── floor and ceiling: a vertical gradient, written once per frame ──
  function skyAndGround(): void {
    const cn = hexToRgb(CEIL_NEAR);
    const cf = hexToRgb(CEIL_FAR);
    const fn = hexToRgb(FLOOR_NEAR);
    const ff = hexToRgb(FLOOR_FAR);
    const mid = H >> 1;
    for (let y = 0; y < H; y++) {
      let c: number;
      if (y < mid) {
        // Toward the horizon is far, so the ceiling darkens as it approaches the middle.
        const t = y / Math.max(1, mid);
        c = packRgb(
          Math.round(cf.r + (cn.r - cf.r) * (1 - t)),
          Math.round(cf.g + (cn.g - cf.g) * (1 - t)),
          Math.round(cf.b + (cn.b - cf.b) * (1 - t)),
        );
      } else {
        const t = (y - mid) / Math.max(1, H - mid);
        c = packRgb(
          Math.round(ff.r + (fn.r - ff.r) * t),
          Math.round(ff.g + (fn.g - ff.g) * t),
          Math.round(ff.b + (fn.b - ff.b) * t),
        );
      }
      buf.fill(c, y * W, y * W + W);
    }
  }

  function texFor(g: Game, cx: number, cy: number): Bitmap {
    const a = art();
    const t = g.level.tiles[cy * g.level.side + cx];
    if (t === T.TIMBER) return a.walls.timber;
    if (t === T.SEAM) return a.walls.seamface;
    if (t === T.BRICK) return a.walls.brick;
    if (t === T.DOOR) return a.door;
    if (isDoorTile(t)) return a.locks[TILE_LOCK[t]] ?? a.door;
    return a.walls.rock;
  }

  // ── walls ──
  function castWalls(g: Game, px: number, py: number, ang: number): void {
    const side = g.level.side;
    const dirX = Math.cos(ang);
    const dirY = Math.sin(ang);
    // Camera plane perpendicular to the direction; its length sets the field of view.
    const planeX = -dirY * FOV * (W / H) * 0.62;
    const planeY = dirX * FOV * (W / H) * 0.62;
    const half = H >> 1;
    const vScale = wallScale(W, H);

    for (let x = 0; x < W; x++) {
      const camX = (2 * x) / W - 1;
      const rx = dirX + planeX * camX;
      const ry = dirY + planeY * camX;

      let mapX = px | 0;
      let mapY = py | 0;
      const dX = rx === 0 ? Infinity : Math.abs(1 / rx);
      const dY = ry === 0 ? Infinity : Math.abs(1 / ry);
      let stepX: number;
      let stepY: number;
      let sideDX: number;
      let sideDY: number;
      if (rx < 0) {
        stepX = -1;
        sideDX = (px - mapX) * dX;
      } else {
        stepX = 1;
        sideDX = (mapX + 1 - px) * dX;
      }
      if (ry < 0) {
        stepY = -1;
        sideDY = (py - mapY) * dY;
      } else {
        stepY = 1;
        sideDY = (mapY + 1 - py) * dY;
      }

      let hitSide = 0;
      let dist = 40;
      for (let steps = 0; steps < 96; steps++) {
        if (sideDX < sideDY) {
          sideDX += dX;
          mapX += stepX;
          hitSide = 0;
        } else {
          sideDY += dY;
          mapY += stepY;
          hitSide = 1;
        }
        if (mapX < 0 || mapY < 0 || mapX >= side || mapY >= side) break;
        if (!g.blocked(mapX + 0.5, mapY + 0.5)) continue;
        dist = hitSide === 0 ? sideDX - dX : sideDY - dY;
        break;
      }
      if (dist < 0.0001) dist = 0.0001;
      depth[x] = dist;
      if (dist >= 40) continue;

      const lineH = Math.round((H * vScale) / dist);
      let y0 = half - (lineH >> 1);
      let y1 = y0 + lineH;
      const tex = mapX >= 0 && mapY >= 0 && mapX < side && mapY < side ? texFor(g, mapX, mapY) : art().walls.rock;

      let wallX = hitSide === 0 ? py + dist * ry : px + dist * rx;
      wallX -= Math.floor(wallX);
      let tx = (wallX * TEX) | 0;
      if ((hitSide === 0 && rx > 0) || (hitSide === 1 && ry < 0)) tx = TEX - tx - 1;
      if (tx < 0) tx = 0;
      if (tx >= TEX) tx = TEX - 1;

      const shade = wallFog(dist) * (hitSide === 1 ? SIDE_SHADE : 1);
      const tbl = tables[shadeIdx(shade)];
      const stepTex = TEX / lineH;
      let texPos = (y0 < 0 ? -y0 : 0) * stepTex;
      if (y0 < 0) y0 = 0;
      if (y1 > H) y1 = H;

      for (let y = y0; y < y1; y++) {
        const ty = texPos | 0;
        texPos += stepTex;
        const src = tex.px[(ty < TEX ? ty : TEX - 1) * TEX + tx];
        buf[y * W + x] = packRgb(tbl[src & 255], tbl[(src >>> 8) & 255], tbl[(src >>> 16) & 255]);
      }
    }
  }

  // ── sprites ──
  interface Billboard {
    x: number;
    y: number;
    bmp: Bitmap;
    /** 1 = a full wall's height. */
    tall: number;
    wide: number;
    /** Vertical offset in wall-heights: 0 stands on the floor, positive sinks. */
    drop: number;
  }

  function drawSprites(px: number, py: number, ang: number, boards: Billboard[]): void {
    const dirX = Math.cos(ang);
    const dirY = Math.sin(ang);
    const planeX = -dirY * FOV * (W / H) * 0.62;
    const planeY = dirX * FOV * (W / H) * 0.62;
    const half = H >> 1;
    const vScale = wallScale(W, H);
    const inv = 1 / (planeX * dirY - dirX * planeY);

    // Painter's order: furthest first, so nearer bodies overwrite. The depth buffer handles walls.
    boards.sort((a, b) => (b.x - px) ** 2 + (b.y - py) ** 2 - ((a.x - px) ** 2 + (a.y - py) ** 2));

    for (const s of boards) {
      const relX = s.x - px;
      const relY = s.y - py;
      const tX = inv * (dirY * relX - dirX * relY);
      const tY = inv * (-planeY * relX + planeX * relY);
      if (tY <= 0.12) continue;
      const screenX = Math.round((W / 2) * (1 + tX / tY));
      const hgt = Math.abs(Math.round(((H * vScale) / tY) * s.tall));
      const wid = Math.abs(Math.round(((H * vScale) / tY) * s.wide * (H / W) * 0.46));
      if (hgt < 1 || wid < 1) continue;

      const floorY = half + Math.round((H * vScale) / tY / 2);
      const y1 = floorY - Math.round(((H * vScale) / tY) * s.drop);
      const y0 = y1 - hgt;
      const x0 = screenX - (wid >> 1);
      const tbl = tables[shadeIdx(spriteFog(tY))];

      for (let x = x0; x < x0 + wid; x++) {
        if (x < 0 || x >= W) continue;
        if (tY >= depth[x]) continue;
        const sx = Math.min(s.bmp.w - 1, (((x - x0) * s.bmp.w) / wid) | 0);
        for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
          const sy = Math.min(s.bmp.h - 1, (((y - y0) * s.bmp.h) / hgt) | 0);
          const src = s.bmp.px[sy * s.bmp.w + sx];
          if ((src >>> 24) < 128) continue;
          buf[y * W + x] = packRgb(tbl[src & 255], tbl[(src >>> 8) & 255], tbl[(src >>> 16) & 255]);
        }
      }
    }
  }

  const boltBmp = (colour: string): Bitmap => {
    const { r, g, b } = hexToRgb(colour);
    const px = new Uint32Array(9 * 9);
    for (let y = 0; y < 9; y++) {
      for (let x = 0; x < 9; x++) {
        const d = Math.hypot(x - 4, y - 4);
        px[y * 9 + x] = d <= 4 ? packRgb(r, g, b) : 0;
      }
    }
    return { w: 9, h: 9, px };
  };
  const boltMine = boltBmp(BOLT_MINE);
  const boltFoe = boltBmp(BOLT_ENEMY);

  function draw(g: Game, seat: number, ang: number, alpha: number): void {
    if (!ctx || !img) return;
    void alpha;
    const me = g.players[seat] ?? g.players[0];
    if (!me) return;
    const px = me.x;
    const py = me.y;

    skyAndGround();
    castWalls(g, px, py, ang);

    const a = art();
    const boards: Billboard[] = [];
    for (const e of g.enemies as Enemy[]) {
      if (e.state === 'dead') continue;
      const bmp = a.enemies[e.kind];
      const def = ENEMY_SIZE[e.kind];
      boards.push({ x: e.x, y: e.y, bmp, tall: def.tall, wide: def.wide, drop: 0 });
    }
    for (const it of g.items) {
      if (it.taken) continue;
      const bmp = a.keys[it.kind] ?? a.pickups[it.kind];
      if (!bmp) continue;
      boards.push({ x: it.x, y: it.y, bmp, tall: 0.42, wide: 0.34, drop: 0 });
    }
    for (const p of g.players) {
      if (!p.present || p.seat === seat) continue;
      boards.push({
        x: p.x,
        y: p.y,
        bmp: p.down ? a.down : a.mate[p.seat % a.mate.length],
        tall: p.down ? 0.34 : 0.85,
        wide: p.down ? 0.6 : 0.42,
        drop: 0,
      });
    }
    for (const b of g.bolts) {
      boards.push({ x: b.x, y: b.y, bmp: b.seat >= 0 ? boltMine : boltFoe, tall: 0.16, wide: 0.16, drop: 0.32 });
    }
    // A GRATE is not opaque, so the wall pass draws nothing for it — which would make it an INVISIBLE
    // wall you walk into. It is drawn as a billboard instead, which is also the honest picture: a
    // timber screen you can see and shoot straight through.
    {
      const s = g.level.side;
      const r = 13;
      const cx = px | 0;
      const cy = py | 0;
      for (let y = Math.max(0, cy - r); y <= Math.min(s - 1, cy + r); y++) {
        for (let x = Math.max(0, cx - r); x <= Math.min(s - 1, cx + r); x++) {
          const t = g.level.tiles[y * s + x];
          if (t === T.GRATE) boards.push({ x: x + 0.5, y: y + 0.5, bmp: GRATE_BMP, tall: 1, wide: 1, drop: 0 });
          else if (t === T.SUMP) boards.push({ x: x + 0.5, y: y + 0.5, bmp: WATER_BMP, tall: 0.1, wide: 1, drop: 0 });
        }
      }
    }
    // Firedamp on fire is a bright, wide, low billboard — you must be able to see the corridor is
    // alight from the other end of it.
    for (const [i, left] of g.fires) {
      const s = g.level.side;
      boards.push({
        x: (i % s) + 0.5,
        y: ((i / s) | 0) + 0.5,
        bmp: FIRE,
        tall: 0.5 + Math.min(0.35, left * 0.25),
        wide: 0.9,
        drop: 0,
      });
    }
    drawSprites(px, py, ang, boards);

    if (sctx) {
      sctx.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(scratch as HTMLCanvasElement, 0, 0, canvas.width, canvas.height);
    }
  }

  function sampleAt(fx: number, fy: number): [number, number, number] {
    const x = Math.max(0, Math.min(W - 1, Math.round(fx * W)));
    const y = Math.max(0, Math.min(H - 1, Math.round(fy * H)));
    const v = buf[y * W + x];
    return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255];
  }

  return {
    resize,
    draw,
    size: () => ({ w: W, h: H }),
    sampleAt,
    destroy() {
      img = null;
      scratch = null;
      sctx = null;
    },
  };
}

/** Drawn size per enemy, kept beside the renderer because it is a rendering fact, not a rule. */
const ENEMY_SIZE: Record<string, { tall: number; wide: number }> = {
  thrall: { tall: 0.82, wide: 0.5 },
  lurker: { tall: 0.62, wide: 0.72 },
  stalker: { tall: 0.95, wide: 0.34 },
  hauler: { tall: 1, wide: 0.95 },
};

/** A slatted timber screen: horizontal bars with gaps you can see the gallery through. */
const GRATE_BMP: Bitmap = (() => {
  const w = 16;
  const h = 24;
  const px = new Uint32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const bar = y % 4 < 2;
      const post = x === 1 || x === w - 2;
      if (bar || post) px[y * w + x] = packRgb(0x8a, 0x6b, 0x3f);
    }
  }
  return { w, h, px };
})();

/** Standing water: a flat, dark, cool sheet drawn low on the floor. */
const WATER_BMP: Bitmap = (() => {
  const w = 16;
  const h = 6;
  const px = new Uint32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      px[y * w + x] = packRgb(0x2c, 0x53, 0x66 + ((x + y) % 3) * 6);
    }
  }
  return { w, h, px };
})();

/** A flame billboard, built without a canvas so it also exists under a headless harness. */
const FIRE: Bitmap = (() => {
  const w = 24;
  const h = 32;
  const px = new Uint32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = 1 - y / h;
      const width = 0.5 + 0.5 * t;
      const dx = Math.abs(x - w / 2) / (w / 2);
      if (dx > width * (0.35 + 0.65 * (1 - t))) continue;
      const hot = t > 0.55;
      px[y * w + x] = hot ? packRgb(255, 232, 150) : packRgb(255, 150, 60);
    }
  }
  return { w, h, px };
})();

void PLAYER;
