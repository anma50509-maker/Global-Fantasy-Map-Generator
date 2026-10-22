#!/usr/bin/env node
/**
 * preview-shape.js —— 选区塑形在**真实世界**上的预览与量化（不参与构建）
 *
 * 与 preview-region.js 的区别：
 *   preview-region 用的是自造的合成地形（满屏深海 / 一片低缓大陆），
 *   海平面写死 0.55。它只能证明"函数跑得通"，证明不了"在用户那张图上
 *   好不好看" —— 真实的图有海沟、有大陆架、海平面在 0.51 上下，
 *   而且新大陆紧挨着已存在的大陆。
 *
 * 这个工具跑完整生成管线（与页面同一个 MapGenerator），在**真实的海洋**
 * 里圈一块地，抬成大陆，然后：
 *   上排   改造前 / 改造后 / 群系
 *   下排   4 倍放大（看岸线和地表纹理）
 * 并打印一组可判据的量化指标（岸线破碎度、地表起伏分布、山体连通性）。
 *
 * 用法：node tools/preview-shape.js [seed] [mode]
 *        mode: land（默认）| sea
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const PNG = require('./lib-png');
const AppRender = require('./lib-apprender');

// ==================== 假 DOM ====================

function makeFakeCtx(canvas) {
  const noop = () => {};
  const ctx = { canvas, fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1, font: '10px sans-serif' };
  ctx.createImageData = (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
  ctx.getImageData = (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
  ctx.createLinearGradient = () => ({ addColorStop: noop });
  ctx.createRadialGradient = () => ({ addColorStop: noop });
  ctx.measureText = () => ({ width: 10 });
  for (const m of ['putImageData', 'drawImage', 'save', 'restore', 'beginPath', 'closePath',
    'moveTo', 'lineTo', 'bezierCurveTo', 'quadraticCurveTo', 'arc', 'rect', 'fill', 'stroke',
    'clip', 'fillRect', 'strokeRect', 'clearRect', 'setLineDash', 'translate', 'scale', 'fillText']) {
    ctx[m] = noop;
  }
  return ctx;
}

function makeFakeCanvas(w, h) {
  const canvas = { width: w || 300, height: h || 150, style: {} };
  canvas.getContext = () => makeFakeCtx(canvas);
  canvas.addEventListener = () => {};
  canvas.setPointerCapture = () => {};
  canvas.releasePointerCapture = () => {};
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: canvas.width, height: canvas.height });
  canvas.toDataURL = () => '';
  return canvas;
}

function installGlobals() {
  globalThis.window = globalThis;
  globalThis.self = globalThis;
  globalThis.document = {
    createElement: (tag) => (tag === 'canvas' ? makeFakeCanvas() : { style: {}, appendChild() {} }),
    getElementById: () => null,
  };
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 16);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
}

function loadScripts() {
  for (const f of [
    'js/vendor/simplex-noise.js',
    'js/projection.js',
    'js/hypsometry.js',
    'js/hydrology.js',
    'js/climate.js',
    'js/terrain.js',
    'js/terrain-ops.js',
    'js/map-generator.js',
    'js/renderer.js',
  ]) {
    vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });
  }
  return globalThis.FM;
}

// ==================== 量化 ====================

/** 4-连通标号：返回 [{area, minX,maxX,minY,maxY}] */
function components(maskFn, W, H, wrapX) {
  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  const out = [];
  for (let i = 0; i < W * H; i++) {
    if (seen[i] || !maskFn(i)) continue;
    let sp = 0;
    stack[sp++] = i;
    seen[i] = 1;
    let area = 0;
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
    while (sp > 0) {
      const j = stack[--sp];
      area++;
      const x = j % W;
      const y = (j / W) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const nb = [x > 0 ? j - 1 : -1, x < W - 1 ? j + 1 : -1, y > 0 ? j - W : -1, y < H - 1 ? j + W : -1];
      if (wrapX) { if (x === 0) nb[0] = j + W - 1; if (x === W - 1) nb[1] = j - W + 1; }
      for (const k of nb) {
        if (k < 0 || seen[k]) continue;
        if (!maskFn(k)) continue;
        seen[k] = 1;
        stack[sp++] = k;
      }
    }
    out.push({ area, minX, maxX, minY, maxY });
  }
  out.sort((a, b) => b.area - a.area);
  return out;
}

/**
 * 岸线破碎度 = 海岸格数 / √(陆地格数)。
 * 正圆 ≈ 2·√π ≈ 3.54；地球亚欧大陆（真实分辨率）≈ 8~14。
 * > 20 说明岸线是"毛刺"而不是"海岸"。
 */
function coastComplexity(cells, W, H, sea) {
  let land = 0;
  let coast = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (cells[i].e < sea) continue;
      land++;
      const l = cells[y * W + ((x - 1 + W) % W)];
      const r = cells[y * W + ((x + 1) % W)];
      const u = cells[Math.max(0, y - 1) * W + x];
      const d = cells[Math.min(H - 1, y + 1) * W + x];
      if (l.e < sea || r.e < sea || u.e < sea || d.e < sea) coast++;
    }
  }
  return { land, coast, score: land > 0 ? coast / Math.sqrt(land) : 0 };
}

/** 岸线曲率的符号翻转率：> 0.55 基本是噪点驱动的锯齿 */
function coastWiggle(cells, W, H, sea) {
  let flips = 0;
  let n = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (cells[i].e < sea) continue;
      const h = (a) => (cells[a].e >= sea ? 1 : 0);
      const e = h(i + 1) - h(i - 1);
      const v = h(i + W) - h(i - W);
      if (e === 0 && v === 0) continue;
      // 岸线法向的转向量（取相邻差分）
      const hl = h(i + 1 + W) - h(i - 1 + W);
      const vu = h(i - W - 1) - h(i - W + 1);
      const dot = e * hl + v * vu;
      n++;
      if (dot < 0) flips++;
    }
  }
  return n > 0 ? flips / n : 0;
}

/** 高程分位（相对高度 rel，只统计陆地） */
function relQuantiles(cells, W, H, sea) {
  const v = [];
  for (let i = 0; i < W * H; i++) {
    if (cells[i].e >= sea) v.push((cells[i].e - sea) / (1 - sea));
  }
  v.sort((a, b) => a - b);
  const q = (p) => v.length ? v[Math.min(v.length - 1, Math.floor(v.length * p))] : 0;
  return { n: v.length, p10: q(0.1), p33: q(0.33), p50: q(0.5), p66: q(0.66), p82: q(0.82), p90: q(0.9), p97: q(0.97), p99: q(0.99) };
}

/**
 * 山体连通性：rel > thr 的格子里，最大连通块的面积占比。
 * 真实大陆的山是**成链**的 —— 最大块占比高（>0.25）；
 * 碎成一地小丘时这个值很低（<0.08），看起来就是"揉皱的纸"。
 */
function mountainCohesion(cells, W, H, sea, thr) {
  const comps = components((i) => cells[i].e >= sea && (cells[i].e - sea) / (1 - sea) > thr, W, H, true);
  const total = comps.reduce((s, c) => s + c.area, 0);
  return {
    n: comps.length,
    total,
    top: comps.length ? comps[0].area : 0,
    topShare: total ? (comps.length ? comps[0].area / total : 0) : 0,
    mid: comps.length > 4 ? comps[4].area : 0,
  };
}

/** 局部起伏能量：|e − 3×3 均值| 的均值（以 rel 为单位） */
function roughness(cells, W, H, sea) {
  let s = 0;
  let n = 0;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (cells[i].e < sea) continue;
      let sum = 0;
      let cnt = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          sum += cells[i + dy * W + dx].e;
          cnt++;
        }
      }
      s += Math.abs(cells[i].e - sum / cnt);
      n++;
    }
  }
  return n ? s / n / (1 - sea) : 0;
}

/**
 * 分频段起伏：先做半径 r 的箱式模糊，再看残差 |e − blur| 的均值。
 *
 * 【为什么不用单个 3×3 指标】"揉皱的纸"和"山脉林立"在 3×3 上是同一种信号，
 * 但在尺度上是两回事：前者能量集中在 10~25 格，后者在 40~120 格。
 * 分开量才能知道该改哪一层。
 */
function bandRough(cells, W, H, sea, members, r) {
  const acc = new Float64Array(W * H);
  const cnt = new Float64Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!members[i]) continue;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -r; dx <= r; dx++) {
          const j = yy * W + ((x + dx + W) % W);
          acc[j] += cells[i].e;
          cnt[j]++;
        }
      }
    }
  }
  let s = 0;
  let n = 0;
  for (let i = 0; i < W * H; i++) {
    if (!members[i] || cnt[i] < 4) continue;
    s += Math.abs(cells[i].e - acc[i] / cnt[i]);
    n++;
  }
  return n ? s / n / (1 - sea) : 0;
}

/** 坡度分位（rel / 格） */
function slopeQuantiles(cells, W, H, sea, members) {
  const v = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!members[i]) continue;
      const l = cells[y * W + ((x - 1 + W) % W)];
      const rt = cells[y * W + ((x + 1) % W)];
      const up = cells[Math.max(0, y - 1) * W + x];
      const dn = cells[Math.min(H - 1, y + 1) * W + x];
      v.push(Math.hypot(rt.e - l.e, dn.e - up.e) * 0.5 / (1 - sea));
    }
  }
  v.sort((a, b) => a - b);
  const q = (p) => (v.length ? v[Math.min(v.length - 1, Math.floor(v.length * p))] : 0);
  return { n: v.length, p50: q(0.5), p90: q(0.9), p99: q(0.99), max: v.length ? v[v.length - 1] : 0 };
}

/** 山体连通性（限定样本集） */
function mountainCohesion2(cells, W, H, sea, members, thr) {
  const f = (i) => members[i] && cells[i].e >= sea && (cells[i].e - sea) / (1 - sea) > thr;
  const comps = components(f, W, H, true);
  const total = comps.reduce((s, c) => s + c.area, 0);
  return {
    n: comps.length,
    total,
    top: comps.length ? comps[0].area : 0,
    topShare: total ? (comps.length ? comps[0].area / total : 0) : 0,
    mid: comps.length > 4 ? comps[4].area : 0,
  };
}

// ==================== 主流程 ====================

const W = 1000;
const H = 500;
const GAP = 8;

function makePolygon(cx, cy, rx, ry, seed) {
  // 用固定相位的人手画法：不是完美椭圆，也不是分形噪声
  const pts = [];
  const N = 64;
  const FM = globalThis.FM;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const wob = 1 + FM.TerrainOps.fbm(Math.cos(a) * 1.6 + 10, Math.sin(a) * 1.6 + 10, 2, 2, 0.5, seed) * 0.18;
    pts.push({ x: cx + Math.cos(a) * rx * wob, y: cy + Math.sin(a) * ry * wob });
  }
  return pts;
}

async function main() {
  installGlobals();
  const FM = loadScripts();
  const Ops = FM.TerrainOps;

  const seed = process.argv[2] || 'shape-demo';
  const mode = process.argv[3] === 'sea' ? 'sea' : 'land';

  const gen = new FM.MapGenerator(W, H);
  const t0 = Date.now();
  await gen.generate({ plateCount: 6, seaLevel: 0.7, seed }, () => {});
  const genMs = Date.now() - t0;
  const sea = gen.seaLevel;
  const cells = gen.cells;

  // 找一个"够大的海洋中心"：以 40 格为半径的方窗内陆地占比最低处
  let best = null;
  const R = 90;
  for (let y = R; y < H - R; y += 20) {
    for (let x = 0; x < W; x += 20) {
      let land = 0;
      for (let dy = -R; dy <= R; dy += 6) {
        for (let dx = -R; dx <= R; dx += 6) {
          if (cells[(y + dy) * W + ((x + dx + W) % W)].e >= sea) land++;
        }
      }
      if (!best || land < best.land) best = { x, y, land };
    }
  }
  const cx = best.x;
  const cy = Math.max(R, Math.min(H - R, best.y));
  const poly = makePolygon(cx, cy, 150, 100, 4242);

  const mask = new Float32Array(W * H);
  const shelf = new Float32Array(W * H);
  const sel = Ops.buildSelectionMask(mask, W, H, poly, { seed: 4242, shelfBuffer: shelf });

  const before = cells.map((c) => ({ e: c.e }));
  const tShape0 = Date.now();
  Ops.shapeRegion(cells, W, H, sel.mask, sel.box, {
    seaLevel: sea, mode, strength: 0.82, seed: 4242, scale: sel.scale, shelf: sel.shelf,
  });
  const tShape = Date.now() - tShape0;
  const tEro0 = Date.now();
  if (process.env.NO_ERODE) { console.log('（跳过侵蚀）'); }
  if (!process.env.NO_ERODE) Ops.erode(cells, W, H, sel.box, {
    seaLevel: sea, ...Ops.EROSION_DEFAULTS, field: sel.mask, maskGain: 4.0,
  });
  const tErode = Date.now() - tEro0;

  // ---------- 统计 ----------
  // 【只统计「新造出来的陆地」】全图统计会被原有地形稀释 —— 塑形区只占
  // 图面的百分之几，混在一起量出来的岸线破碎度、起伏能量全是别人的。
  const newLand = new Uint8Array(W * H);
  const refLand = new Uint8Array(W * H);
  let nNew = 0;
  for (let i = 0; i < W * H; i++) {
    const wasLand = before[i].e >= sea;
    const isLand = cells[i].e >= sea;
    if (!wasLand && isLand) { newLand[i] = 1; nNew++; }
    // 参照组：同一张图上、远离选区的原有陆地
    if (wasLand && isLand) {
      const y = (i / W) | 0;
      const x = i % W;
      if (Math.hypot(x - cx, y - cy) > 420) refLand[i] = 1;
    }
  }

  const q = relQuantiles(cells, W, H, sea);
  const mt = mountainCohesion(cells, W, H, sea, 0.226);
  const co = coastComplexity(cells, W, H, sea);
  const wig = coastWiggle(cells, W, H, sea);
  const rough = roughness(cells, W, H, sea);
  const lakes = components((i) => cells[i].e < sea && cells[i].e >= sea - 0.05, W, H, true).filter((c) => c.area > 20);

  const areaOf = (m) => { let n = 0; for (let i = 0; i < W * H; i++) if (m[i]) n++; return n; };
  const slNew = slopeQuantiles(cells, W, H, sea, newLand);
  const slRef = slopeQuantiles(cells, W, H, sea, refLand);
  const bands = [2, 6, 20].map((r) => ({
    r,
    neu: bandRough(cells, W, H, sea, newLand, r),
    ref: bandRough(cells, W, H, sea, refLand, r),
  }));
  const mtNew = mountainCohesion2(cells, W, H, sea, newLand, 0.226);

  // ---------- 渲染 ----------
  const ZC = { x0: Math.max(0, cx - 130), y0: Math.max(0, cy - 90), w: 260, h: 180 };
  const scale = 3;
  const zw = ZC.w * scale;
  const zh = ZC.h * scale;
  const totalW = Math.max(W + GAP * 2, zw * 2 + GAP * 3);
  const totalH = GAP + (H + GAP) * 2 + (zh + GAP) * 2 + GAP;
  const img = new Uint8Array(totalW * totalH * 3);
  for (let i = 0; i < totalW * totalH; i++) { img[i * 3] = 16; img[i * 3 + 1] = 20; img[i * 3 + 2] = 26; }

  const bufA = AppRender.renderRegion(before, W, H, { sea, depthSpan: 0.55 * (1 - sea) * 2 });
  const bufB = AppRender.renderRegion(cells, W, H, { sea, depthSpan: 0.55 * (1 - sea) * 2 });
  const hsA = AppRender.renderHillshade(before, W, H, { sea });
  const hsB = AppRender.renderHillshade(cells, W, H, { sea });
  const put = (buf, px, py) => {
    for (let y = 0; y < H; y++) {
      const src = buf.subarray(y * W * 3, y * W * 3 + W * 3);
      img.set(src, ((py + y) * totalW + px) * 3);
    }
  };
  put(bufA, GAP, GAP);
  put(bufB, GAP, GAP + H + GAP);

  // 下面两行：3×放大，左右并排 before | after
  const zoomRow = (srcA, srcB, zy) => {
    for (let y = 0; y < zh; y++) {
      for (let x = 0; x < zw; x++) {
        const sx = ZC.x0 + ((x / scale) | 0);
        const sy = ZC.y0 + ((y / scale) | 0);
        const so = (sy * W + sx) * 3;
        img.set(srcA.subarray(so, so + 3), ((zy + y) * totalW + GAP + x) * 3);
        img.set(srcB.subarray(so, so + 3), ((zy + y) * totalW + GAP + zw + GAP + x) * 3);
      }
    }
  };
  const zy1 = GAP + (H + GAP) * 2;
  zoomRow(bufA, bufB, zy1);
  zoomRow(hsA, hsB, zy1 + zh + GAP);

  const outPath = path.join(ROOT, 'dist', 'shape-preview.png');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, PNG.encode(totalW, totalH, img));

  // ---------- 打印 ----------
  const f = (v, d = 3) => (v == null ? '-' : v.toFixed(d));
  const areaNew = areaOf(newLand);
  const areaRef = areaOf(refLand);
  // 新陆地的岸线破碎度：只数「构成这块新大陆」的格子
  let nCoastNew = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!newLand[i]) continue;
      const l = newLand[y * W + ((x - 1 + W) % W)];
      const r = newLand[y * W + ((x + 1) % W)];
      const u = newLand[Math.max(0, y - 1) * W + x];
      const d = newLand[Math.min(H - 1, y + 1) * W + x];
      if (!l || !r || !u || !d) nCoastNew++;
    }
  }
  console.log('='.repeat(78));
  console.log('选区塑形（真实世界）  seed=' + seed + '  mode=' + mode);
  console.log('='.repeat(78));
  console.log('  地图 ' + W + '×' + H + '  海平面 ' + sea.toFixed(4) + '  生成 ' + genMs + ' ms');
  console.log('  选区中心 (' + cx + ',' + cy + ')  内切半径 ' + sel.scale.toFixed(1) +
    '  合成 ' + tShape + ' ms  侵蚀 ' + tErode + ' ms');
  console.log('  新增陆地 ' + areaNew + ' 格   参照陆地 ' + areaRef + ' 格（远离选区）');
  console.log('');
  console.log('  —— 岸线 ——');
  console.log('  新增陆地岸线破碎度 = ' + f(areaNew ? nCoastNew / Math.sqrt(areaNew) : 0, 2) +
    '   （正圆 3.54 / 地球 8~14 / >20 是毛刺）');
  console.log('  全图 ' + f(co.score, 2) + '   曲率翻转率 ' + f(wig, 3) + '（>0.55 是噪点锯齿）');
  console.log('');
  console.log('  —— 坡度（rel/格，样本=新陆地 vs 参照陆地）——');
  console.log('  p50  ' + f(slNew.p50, 4) + ' / ' + f(slRef.p50, 4));
  console.log('  p90  ' + f(slNew.p90, 4) + ' / ' + f(slRef.p90, 4));
  console.log('  p99  ' + f(slNew.p99, 4) + ' / ' + f(slRef.p99, 4));
  console.log('  max  ' + f(slNew.max, 4) + ' / ' + f(slRef.max, 4));
  console.log('');
  console.log('  —— 分频段起伏（|e−blur_r| 均值，新 / 参照）——');
  for (const b of bands) {
    console.log('  r=' + String(b.r).padStart(2) + '  ' + f(b.neu, 5) + ' / ' + f(b.ref, 5) +
      '   比值 ' + f(b.ref > 1e-9 ? b.neu / b.ref : 0, 2));
  }
  console.log('');
  console.log('  —— 山体（rel>0.226，仅新陆地）——');
  console.log('  块数 ' + mtNew.n + '  总面积 ' + mtNew.total + '（占新陆地 ' +
    f(mtNew.total / Math.max(1, areaNew) * 100, 1) + '%）  最大块占比 ' + f(mtNew.topShare, 3));
  console.log('  （成链：最大块占比 >0.25；碎丘：<0.08）');
  console.log('  全图山体 ' + mt.n + ' 块，最大块占比 ' + f(mt.topShare, 3));
  console.log('');
  console.log('  >20 格的湖泊/内海 ' + lakes.length + ' 个');
  console.log('  → ' + path.relative(ROOT, outPath) + '（上=原始 下=塑形后 底=3×放大 before|after）');
}

main().catch((e) => { console.error(e); process.exit(1); });
