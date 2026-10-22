#!/usr/bin/env node
/**
 * preview-edit.js —— 地形编辑的**端到端**预览（不参与构建）
 *
 * 与 preview-shape.js 的区别：那个只画高度场（自己编的色带），
 * 这个走完整链路 —— 生成 → 选区塑形 → 侵蚀 → 重算气候 → 重建水系 →
 * 用 renderer.js 的 paintTerrain 出图。**看到的颜色就是用户在页面上
 * 看到的颜色**（含群系底色、山体阴影、河流、海深）。
 *
 * 判断"自然不自然"必须看这张图：群系底色会把高度场里看不见的
 * 高度差放大成深绿/浅绿/土黄，高度场本身好看不代表出图好看。
 *
 * 用法：node tools/preview-edit.js [seed] [mode] [--no-erode]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const PNG = require('./lib-png');

const W = 1000;
const H = 500;
const GAP = 8;

let lastImageData = null;

function makeFakeCtx(canvas) {
  const noop = () => {};
  const ctx = { canvas, fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1, font: '10px sans-serif' };
  ctx.createImageData = (w, h) => {
    const im = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    if (w === W && h === H) lastImageData = im;
    return im;
  };
  ctx.getImageData = (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
  ctx.createLinearGradient = () => ({ addColorStop: noop });
  ctx.createRadialGradient = () => ({ addColorStop: noop });
  ctx.measureText = () => ({ width: 10 });
  for (const m of ['putImageData', 'drawImage', 'save', 'restore', 'beginPath', 'closePath', 'moveTo',
    'lineTo', 'bezierCurveTo', 'quadraticCurveTo', 'arc', 'rect', 'fill', 'stroke', 'clip', 'fillRect',
    'strokeRect', 'clearRect', 'setLineDash', 'translate', 'scale', 'fillText']) ctx[m] = noop;
  return ctx;
}

function makeFakeCanvas(w, h) {
  const c = { width: w || 300, height: h || 150, style: {} };
  c.getContext = () => makeFakeCtx(c);
  c.addEventListener = () => {};
  c.setPointerCapture = () => {};
  c.releasePointerCapture = () => {};
  c.getBoundingClientRect = () => ({ left: 0, top: 0, width: c.width, height: c.height });
  c.toDataURL = () => '';
  return c;
}

function installGlobals() {
  globalThis.window = globalThis;
  globalThis.self = globalThis;
  globalThis.document = {
    createElement: (t) => (t === 'canvas' ? makeFakeCanvas(W, H) : { style: {}, appendChild() {} }),
    getElementById: () => null,
  };
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 16);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
}

function loadScripts() {
  for (const f of ['js/vendor/simplex-noise.js', 'js/projection.js', 'js/hypsometry.js',
    'js/hydrology.js', 'js/climate.js', 'js/terrain.js', 'js/terrain-ops.js',
    'js/map-generator.js', 'js/renderer.js']) {
    vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });
  }
  return globalThis.FM;
}

/** 与 editor.js 完全一致的一步：圈 → 掩膜 → 塑形 → 侵蚀 */
function applyShape(FM, gen, poly, seed, mode, doErode) {
  const Ops = FM.TerrainOps;
  const mask = new Float32Array(W * H);
  const shelf = new Float32Array(W * H);
  const sel = Ops.buildSelectionMask(mask, W, H, poly, { seed, shelfBuffer: shelf });
  if (!sel) throw new Error('选区为空');
  const t0 = Date.now();
  Ops.shapeRegion(gen.cells, W, H, sel.mask, sel.box, {
    seaLevel: gen.seaLevel, mode, strength: 0.82, seed, scale: sel.scale, shelf: sel.shelf,
  });
  const tShape = Date.now() - t0;
  let tErode = 0;
  if (doErode) {
    const t1 = Date.now();
    Ops.erode(gen.cells, W, H, sel.box, {
      seaLevel: gen.seaLevel, ...Ops.EROSION_DEFAULTS, field: sel.mask, maskGain: 4.0,
    });
    tErode = Date.now() - t1;
  }
  return { sel, tShape, tErode };
}

function makePolygon(FM, cx, cy, rx, ry, seed) {
  const pts = [];
  const N = 64;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const wob = 1 + FM.TerrainOps.fbm(Math.cos(a) * 1.6 + 10, Math.sin(a) * 1.6 + 10, 2, 2, 0.5, seed) * 0.18;
    pts.push({ x: cx + Math.cos(a) * rx * wob, y: cy + Math.sin(a) * ry * wob });
  }
  return pts;
}

function snapshot(cells) {
  const e = new Float32Array(cells.length);
  for (let i = 0; i < cells.length; i++) e[i] = cells[i].e;
  return e;
}

async function render(FM, gen, canvas) {
  if (!gen._renderer) gen._renderer = new FM.MapRenderer(canvas, W, H);
  const r = gen._renderer;
  r.setGenerator(gen);
  r.setViewMode('satellite');
  r.terrainDirty = true;
  r.albedoValid = false;
  lastImageData = null;
  r.render();
  return lastImageData;
}

function toRGB(im) {
  const out = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    out[i * 3] = im.data[i * 4];
    out[i * 3 + 1] = im.data[i * 4 + 1];
    out[i * 3 + 2] = im.data[i * 4 + 2];
  }
  return out;
}

async function main() {
  installGlobals();
  const FM = loadScripts();
  const seed = process.argv[2] || 'shape-demo';
  const mode = process.argv[3] === 'sea' ? 'sea' : 'land';
  const doErode = !process.argv.includes('--no-erode') && !process.env.NO_ERODE;

  const canvas = makeFakeCanvas(W, H);
  const gen = new FM.MapGenerator(W, H);
  let t0 = Date.now();
  await gen.generate({ plateCount: 6, seaLevel: 0.7, seed }, () => {});
  const genMs = Date.now() - t0;

  // 先在"原始图"上找一块大海洋
  const sea = gen.seaLevel;
  let best = null;
  const R = 90;
  for (let y = R; y < H - R; y += 20) {
    for (let x = 0; x < W; x += 20) {
      let land = 0;
      for (let dy = -R; dy <= R; dy += 6) {
        for (let dx = -R; dx <= R; dx += 6) {
          if (gen.cells[(y + dy) * W + ((x + dx + W) % W)].e >= sea) land++;
        }
      }
      if (!best || land < best.land) best = { x, y, land };
    }
  }
  const cx = best.x;
  const cy = Math.max(R, Math.min(H - R, best.y));
  const rx = +(process.argv[4] || 150);
  const ry = +(process.argv[5] || 100);
  const poly = makePolygon(FM, cx, cy, rx, ry, 4242);

  const before = await render(FM, gen, canvas);
  const imgBefore = toRGB(before);
  const eBefore = snapshot(gen.cells);

  // 塑形
  const sh = applyShape(FM, gen, poly, 4242, mode, doErode);

  // 重算气候 + 水系（与 editor.js 的延后刷新一致）
  t0 = Date.now();
  await gen.recomputeClimate(() => {});
  const climateMs = Date.now() - t0;
  t0 = Date.now();
  const hyd = gen.rebuildHydrology();
  const hydMs = Date.now() - t0;

  const after = await render(FM, gen, canvas);
  const imgAfter = toRGB(after);

  // ---- 拼图：上=改造前 下=改造后；再给一块 3× 放大 ----
  const ZC = { x0: Math.max(0, cx - 125), y0: Math.max(0, cy - 85), w: 250, h: 175 };
  const scale = 3;
  const zw = ZC.w * scale;
  const zh = ZC.h * scale;
  const totalW = Math.max(W + GAP * 2, zw * 2 + GAP * 3);
  const totalH = GAP + (H + GAP) * 2 + zh + GAP;
  const img = new Uint8Array(totalW * totalH * 3).fill(0);
  for (let i = 0; i < totalW * totalH; i++) { img[i * 3] = 16; img[i * 3 + 1] = 20; img[i * 3 + 2] = 26; }
  const blit = (buf, px, py) => {
    for (let y = 0; y < H; y++) {
      img.set(buf.subarray(y * W * 3, y * W * 3 + W * 3), ((py + y) * totalW + px) * 3);
    }
  };
  blit(imgBefore, GAP, GAP);
  blit(imgAfter, GAP, GAP + H + GAP);
  const zy = GAP + (H + GAP) * 2;
  for (let y = 0; y < zh; y++) {
    for (let x = 0; x < zw; x++) {
      const sx = ZC.x0 + ((x / scale) | 0);
      const sy = ZC.y0 + ((y / scale) | 0);
      const so = (sy * W + sx) * 3;
      img.set(imgBefore.subarray(so, so + 3), ((zy + y) * totalW + GAP + x) * 3);
      img.set(imgAfter.subarray(so, so + 3), ((zy + y) * totalW + GAP + zw + GAP + x) * 3);
    }
  }

  const outPath = path.join(ROOT, 'dist', process.env.OUT || 'edit-e2e.png');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, PNG.encode(totalW, totalH, img));

  console.log('='.repeat(74));
  console.log('地形编辑 端到端  seed=' + seed + '  mode=' + mode + (doErode ? '' : '  (无侵蚀)'));
  console.log('='.repeat(74));
  console.log('  生成 ' + genMs + ' ms   塑形 ' + sh.tShape + ' ms   侵蚀 ' + sh.tErode +
    ' ms   气候 ' + climateMs + ' ms   水系 ' + hydMs + ' ms');
  console.log('  海平面 ' + sea.toFixed(4) + '  选区 (' + cx + ',' + cy + ')  内切半径 ' + sh.sel.scale.toFixed(1));
  console.log('  河流 ' + (hyd && hyd.riverCount != null ? hyd.riverCount : gen.rivers.length) + ' 段');

  // 群系构成（新增陆地）
  const tally = new Map();
  let nNew = 0;
  for (let i = 0; i < W * H; i++) {
    if (gen.cells[i].e < sea) continue;
    if (eBefore[i] >= sea) continue;   // 改造前已经是陆地，跳过
    nNew++;
    const b = gen.cells[i].biome || '?';
    tally.set(b, (tally.get(b) || 0) + 1);
  }
  const nLake = tally.get('湖泊') || 0;
  console.log('  新陆地上水面占比 ' + (nLake / Math.max(1, nNew) * 100).toFixed(1) + '%（' + nLake + ' 格）');
  const top = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  console.log('  新增陆地群系（前 8）:');
  for (const [b, n] of top) {
    console.log('    ' + b.padEnd(8) + String(n).padStart(7) + '  ' + (n / Math.max(1, nNew) * 100).toFixed(1) + '%');
  }
  console.log('  → ' + path.relative(ROOT, outPath) + '（上=改造前 下=改造后 底=3×放大）');
}

module.exports = {};

main().catch((e) => { console.error(e); process.exit(1); });
