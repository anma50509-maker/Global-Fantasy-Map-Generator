#!/usr/bin/env node
/**
 * preview-region.js —— 选区塑形的离屏预览（不参与构建）
 *
 * 三块对比：
 *   左  原始地形 + 选区轮廓
 *   中  隆起成大陆
 *   右  沉陷成海洋
 *
 * 配色与光照直接复用 renderer.js（见 lib-apprender.js），海平面按 app 的
 * 实际取值（0.93），所以图上看到的颜色就是用户会看到的颜色。
 *
 * 用法：node tools/preview-region.js [输出路径]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PNG = require('./lib-png');
const AppRender = require('./lib-apprender');

globalThis.self = globalThis;
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'hypsometry.js'), 'utf8'));
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'terrain-ops.js'), 'utf8'));
const Ops = globalThis.FM.TerrainOps;

const PW = 640;
const PH = 440;
const GAP = 8;
const SEA = 0.55;
const UNIT = 1 - SEA;

/**
 * 背景地形。
 *   kind='ocean'  满屏深海（用来测「把海抬成大陆」）
 *   kind='land'   一片低缓大陆（用来测「把陆压成海洋」）
 */
function makeTerrain(seed, kind) {
  const cells = new Array(PW * PH);
  for (let y = 0; y < PH; y++) {
    for (let x = 0; x < PW; x++) {
      let e;
      if (kind === 'ocean') {
        const d = 0.6 + Ops.fbm(x / 130, y / 130, 3, 2, 0.5, seed + 7) * 0.3;
        e = SEA - UNIT * d;
      } else {
        e = SEA + UNIT * (0.10 + Ops.fbm(x / 120, y / 120, 3, 2, 0.5, seed + 7) * 0.16 +
          Ops.fbm(x / 36, y / 36, 4, 2, 0.5, seed + 13) * 0.05);
      }
      cells[y * PW + x] = { x, y, e, temp: 0.6, m: 0.5, isRiver: false, isLake: false };
    }
  }
  return cells;
}

/** 一圈不规则的椭圆，模拟人手画的选区 */
function makePolygon(cx, cy, rx, ry, seed, n) {
  const pts = [];
  const N = n || 46;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const wob = 1 + Ops.fbm(Math.cos(a) * 2.2 + 10, Math.sin(a) * 2.2 + 10, 3, 2, 0.5, seed) * 0.22;
    pts.push({ x: cx + Math.cos(a) * rx * wob, y: cy + Math.sin(a) * ry * wob });
  }
  return pts;
}

function drawOutline(buf, polygon, color) {
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y));
    for (let s = 0; s <= n; s++) {
      const x = Math.round(a.x + (b.x - a.x) * (s / n));
      const y = Math.round(a.y + (b.y - a.y) * (s / n));
      for (let d = -1; d <= 1; d++) {
        const xx = x + d;
        const yy = y + (d === 0 ? 1 : 0);
        if (xx < 0 || xx >= PW || yy < 0 || yy >= PH) continue;
        const o = (yy * PW + xx) * 3;
        buf[o] = color[0]; buf[o + 1] = color[1]; buf[o + 2] = color[2];
      }
    }
  }
}

/**
 * 画一个矩形边框。
 *
 * 【为什么要在 1:1 图上标出放大区】第二行是裁剪区放大，裁剪边界本身
 * 就是一条"画面里的直线" —— 看图时非常容易被误认成地形里的竖直硬边
 * （这一轮就为此查了半天数据）。把裁剪框画出来，这个歧义就永久消失了。
 */
function drawRect(buf, r, color) {
  const put = (x, y) => {
    if (x < 0 || x >= PW || y < 0 || y >= PH) return;
    const o = (y * PW + x) * 3;
    buf[o] = color[0]; buf[o + 1] = color[1]; buf[o + 2] = color[2];
  };
  for (let x = r.x0; x < r.x0 + r.w; x++) { put(x, r.y0); put(x, r.y0 + r.h - 1); }
  for (let y = r.y0; y < r.y0 + r.h; y++) { put(r.x0, y); put(r.x0 + r.w - 1, y); }
}

function run(mode, poly, seed, kind) {
  const cells = makeTerrain(1001, kind);
  const mask = new Float32Array(PW * PH);
  const shelf = new Float32Array(PW * PH);
  const sel = Ops.buildSelectionMask(mask, PW, PH, poly, { seed, shelfBuffer: shelf });
  if (!sel) throw new Error('选区为空');
  const t0 = Date.now();
  const shaped = Ops.shapeRegion(cells, PW, PH, sel.mask, sel.box, {
    seaLevel: SEA, mode, strength: 0.82, seed, scale: sel.scale, shelf: sel.shelf,
  });
  const tShape = Date.now() - t0;
  const t1 = Date.now();
  // 与编辑器一致：field + maskGain 把侵蚀限制在选区内
  Ops.erode(cells, PW, PH, sel.box, {
    seaLevel: SEA, ...Ops.EROSION_DEFAULTS, field: sel.mask, maskGain: 4.0,
  });
  const tErode = Date.now() - t1;
  return { cells, sel, shaped, tShape, tErode };
}

function main() {
  const outPath = process.argv[2] || path.join(__dirname, '..', 'dist', 'region-preview.png');
  const poly = makePolygon(PW * 0.5, PH * 0.5, 190, 128, 4242);

  const base = makeTerrain(1001, 'ocean');
  const land = run('land', poly, 4242, 'ocean');
  const sea = run('sea', poly, 4242, 'land');

  // 第二行：绕山体的 2 倍放大，用来判断纹理质感（1:1 看不出坡面的细节）
  const ZC = { x0: 150, y0: 60, w: 340, h: 330 };
  const totalW = Math.max(PW * 3 + GAP * 4, ZC.w * 2 * 3 + GAP * 4);
  const totalH = PH + ZC.h * 2 + GAP * 3;
  const img = new Uint8Array(totalW * totalH * 3);
  for (let i = 0; i < totalW * totalH; i++) { img[i * 3] = 16; img[i * 3 + 1] = 20; img[i * 3 + 2] = 26; }

  const panels = [base, land.cells, sea.cells];
  for (let p = 0; p < 3; p++) {
    const px = GAP + p * (PW + GAP);
    const py = GAP;
    const buf = AppRender.renderRegion(panels[p], PW, PH, { sea: SEA, depthSpan: 0.55 * (1 - SEA) * 2 });
    if (p === 0) drawOutline(buf, poly, [255, 70, 60]);
    drawRect(buf, { x0: ZC.x0, y0: ZC.y0, w: ZC.w, h: ZC.h }, [120, 190, 255]);
    for (let y = 0; y < PH; y++) {
      img.set(buf.subarray(y * PW * 3, y * PW * 3 + PW * 3), ((py + y) * totalW + px) * 3);
    }
    // 放大行
    const zx = GAP + p * (ZC.w * 2 + GAP);
    const zy = GAP * 2 + PH;
    for (let y = 0; y < ZC.h * 2; y++) {
      const sy = ZC.y0 + ((y / 2) | 0);
      for (let x = 0; x < ZC.w * 2; x++) {
        const sx = ZC.x0 + ((x / 2) | 0);
        const so = (sy * PW + sx) * 3;
        const dof = ((zy + y) * totalW + zx + x) * 3;
        img[dof] = buf[so]; img[dof + 1] = buf[so + 1]; img[dof + 2] = buf[so + 2];
      }
    }
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, PNG.encode(totalW, totalH, img));

  const stat = (cells, label) => {
    let min = Infinity; let max = -Infinity; let landN = 0;
    for (const c of cells) {
      if (c.e < min) min = c.e;
      if (c.e > max) max = c.e;
      if (c.e >= SEA) landN++;
    }
    console.log('  ' + label.padEnd(10) +
      ' e∈[' + min.toFixed(4) + ', ' + max.toFixed(4) + ']' +
      '  陆地 ' + landN + ' 格');
  };
  console.log('='.repeat(66));
  console.log('选区塑形预览 → ' + path.relative(path.join(__dirname, '..'), outPath));
  console.log('='.repeat(66));
  console.log('  选区尺度 ' + land.sel.scale.toFixed(1) + ' 格   合成 ' +
    land.tShape + ' ms   侵蚀 ' + land.tErode + ' ms');
  stat(base, '原始(海)');
  stat(land.cells, '大陆');
  stat(sea.cells, '海洋(原陆)');
}

main();
