#!/usr/bin/env node
/**
 * verify-integration.js —— 编辑器整链路集成测试（无需浏览器）
 *
 * 【为什么要这个】
 * 本机环境无法启动真实浏览器（Edge headless / puppeteer 都被拦），
 * 所以「页面上跑一遍」这件事没法自动化。但编辑器最容易出错的地方
 * 恰恰是**接线**：私有字段名写错、回调没接、投影函数签名不对、
 * 历史记录还原不干净 —— 这些都跟渲染无关，可以用 DOM 桩验证。
 *
 * 这里搭一套最小 DOM（canvas / overlay / renderer / generator），
 * 用真实的 pointerdown → pointermove → pointerup 事件序列圈出选区，
 * 再驱动「隆起成大陆 / 沉陷成海洋」，检查：
 *   1. 圈选过程中是否**没有**动数据（本版的核心约定）；
 *   2. 成形是否真的把海变成陆 / 陆变成海，且范围局限在选区；
 *   3. 海岸线是不是被噪声打碎了（而不是把多边形描一遍）；
 *   4. 重复成形会不会越堆越高（应该几何收敛到目标高度）；
 *   5. 历史记录是否只记变化格、撤销能否逐位还原、重做能否复现；
 *   6. 延后的「重建水系」是否被执行；
 *   7. 非等距投影下是否仍能成形；
 *   8. 单步历史的体量是否可控。
 *
 * 用法：node tools/verify-integration.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ==================== 最小 DOM 桩 ====================

function makeImageData(w, h) {
  return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
}

function makeCtx() {
  const noop = () => {};
  return {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    clearRect: noop,
    save: noop,
    restore: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    fill: noop,
    stroke: noop,
    fillRect: noop,
    setLineDash: noop,
    createImageData: makeImageData,
    putImageData: noop,
    createRadialGradient: () => ({ addColorStop: noop }),
    drawImage: noop,
  };
}

/** 极简事件目标：只实现 addEventListener 与手动 emit */
function makeTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    emit(type, ev) {
      const list = listeners.get(type) || [];
      for (const fn of list) fn(ev);
    },
    listenerCount: (type) => (listeners.get(type) || []).length,
  };
}

function makeCanvas(W, H) {
  const t = makeTarget();
  const ctx = makeCtx();
  return {
    width: W,
    height: H,
    addEventListener: t.addEventListener,
    emit: t.emit,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H, right: W, bottom: H }),
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    classList: { toggle: () => {} },
  };
}

/** 指针事件：editor 只用到 clientX / clientY / pointerId / preventDefault */
function pointerEvt(x, y, pointerId) {
  return {
    clientX: x,
    clientY: y,
    pointerId: pointerId || 1,
    preventDefault: () => {},
  };
}

// ==================== 环境安装 ====================

function installEnv(W, H) {
  global.window = global;
  global.self = global;
  // window 级事件（pointerup 挂在 window 上）
  const win = makeTarget();
  global.addEventListener = win.addEventListener;
  global.removeEventListener = () => {};
  global.emit = win.emit;
  global.requestAnimationFrame = (cb) => {
    // 立刻执行：测试里不需要真的等一帧
    cb();
    return 1;
  };
  global.cancelAnimationFrame = () => {};
  return { canvas: makeCanvas(W, H), overlay: makeCanvas(W, H) };
}

function loadModules() {
  for (const f of ['hypsometry.js', 'terrain-ops.js', 'editor.js']) {
    const code = fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8');
    vm.runInThisContext(code, { filename: f });
  }
  if (!global.FM.TerrainOps) throw new Error('FM.TerrainOps 未挂载');
  if (!global.FM.MapEditor) throw new Error('FM.MapEditor 未挂载');
}

// ==================== 假生成器 / 渲染器 ====================

const W = 640;
const H = 400;
const SEA = 0.55;
const UNIT = 1 - SEA;

function makeGenerator() {
  const cells = new Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // 满屏浅海：这样「隆起成大陆」才会长出真正的新海岸线，
      // 而「沉陷成海洋」可以拿刚长出来的陆地做样本。
      const e = SEA - UNIT * (0.42 + 0.06 * Math.sin(x / 37) * Math.cos(y / 29));
      cells[y * W + x] = {
        x, y, e, temp: 0.62, m: 0.52,
        windU: 0, windV: 0, monsoon: 0,
        isRiver: false, isLake: false, flow: 0,
        biome: '温带草原',
      };
    }
  }
  const stats = { hydroCalls: 0, climateCalls: 0 };
  return {
    cells,
    seaLevel: SEA,
    rivers: [],
    lakes: [],
    stats,
    // 编辑器在延后收尾里会先重算气候（群系要跟着地形改），
    // 桩里记一次调用即可 —— 这里验的是"接线"，不是气候本身。
    async recomputeClimate() {
      stats.climateCalls++;
      return null;
    },
    rebuildHydrology() {
      stats.hydroCalls++;
      return { totalMs: 1, riverCount: 0, lakeCount: 0 };
    },
  };
}

function makeRenderer() {
  const r = {
    projector: { name: 'equirect', valid: null, sx: null, sy: null },
    terrainDirty: false,
    albedoValid: true,
    renderCount: 0,
    oceanDepthCalls: 0,
    unprojectPixel(x, y) { return { x, y }; },
    projectPixel(x, y) { return { x, y }; },
    clipToProjection() { return false; },
    render() { r.renderCount++; },
    updateOceanDepth() { r.oceanDepthCalls++; },
  };
  return r;
}

// ==================== 断言工具 ====================

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log('  ✅ ' + name + (detail ? '   ' + detail : ''));
  } else {
    failed++;
    console.log('  ❌ ' + name + (detail ? '   ' + detail : ''));
  }
}

function snapshotE(cells) {
  const a = new Float32Array(cells.length);
  for (let i = 0; i < cells.length; i++) a[i] = cells[i].e;
  return a;
}

function diffCount(a, b) {
  let n = 0;
  let max = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > 1e-7) { n++; if (d > max) max = d; }
  }
  return { n, max };
}

/** 圆的参数化顶点 */
function circlePoly(cx, cy, rx, ry, n) {
  const pts = [];
  const N = n || 36;
  for (let k = 0; k <= N; k++) {
    const a = (k / N) * Math.PI * 2;
    pts.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry });
  }
  return pts;
}

/** 用 pointer 事件真的画一圈 */
function drawCircle(canvas, cx, cy, rx, ry, n) {
  const pts = circlePoly(cx, cy, rx, ry, n);
  canvas.emit('pointerdown', pointerEvt(pts[0].x, pts[0].y));
  for (let k = 1; k < pts.length; k++) {
    canvas.emit('pointermove', pointerEvt(pts[k].x, pts[k].y));
  }
  window.emit('pointerup', pointerEvt(pts[0].x, pts[0].y, 1));
}

/**
 * 海岸线破碎度：陆海边界格数 ÷ 同面积的圆周长。
 * 光滑的一坨 ≈ 1.0~1.3；有半岛、海湾、离岸岛的岸线会明显更大。
 */
function coastRatio(cells, W, H, sea) {
  let land = 0;
  let edge = 0;
  const isLand = (x, y) => {
    const c = cells[y * W + x];
    return c && c.e >= sea;
  };
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      if (!isLand(x, y)) continue;
      land++;
      if (!isLand(x - 1, y) || !isLand(x + 1, y) || !isLand(x, y - 1) || !isLand(x, y + 1)) edge++;
    }
  }
  if (land < 10) return { land, edge, ratio: 0 };
  const ideal = 2 * Math.sqrt(Math.PI * land);
  return { land, edge, ratio: edge / ideal };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ==================== 主流程 ====================

async function run() {
  const { canvas, overlay } = installEnv(W, H);
  loadModules();
  const Ops = global.FM.TerrainOps;

  const statusLog = [];
  const gen = makeGenerator();
  const renderer = makeRenderer();
  const editor = new FM.MapEditor({
    canvas,
    overlay,
    renderer,
    callbacks: {
      onStatus: (s) => statusLog.push(s),
      onHistoryChange: (u, r) => statusLog.push('history ' + u + '/' + r),
      onLassoChange: () => {},
      onEdited: () => {},
    },
  });

  editor.setEnabled(true);
  editor.setGenerator(gen);
  editor.setStrength(0.85);
  editor.setDetailScale(1.0);

  console.log('='.repeat(78));
  console.log('编辑器集成测试（选区塑形 · DOM 桩，无需浏览器）  网格 ' + W + '×' + H);
  console.log('='.repeat(78));

  // ---------- 1. 圈选区 ----------
  console.log('\n【1】圈选区');
  const before = snapshotE(gen.cells);
  drawCircle(canvas, 320, 200, 150, 105, 40);
  const afterDraw = snapshotE(gen.cells);
  const dDraw = diffCount(before, afterDraw);

  check('圈出选区', editor.hasLasso(), editor.lassoPoints.length + ' 个顶点');
  check('圈选过程中数据未被改动', dDraw.n === 0, '差异 ' + dDraw.n + ' 格');
  check('圈选不触发整图重绘', renderer.renderCount === 0, renderer.renderCount + ' 次 render');

  // ---------- 2. 隆起成大陆 ----------
  console.log('\n【2】隆起成大陆');
  const b2 = snapshotE(gen.cells);
  const ok2 = editor.applyRegionAction('land');
  const a2 = snapshotE(gen.cells);
  const d2 = diffCount(b2, a2);

  let net = 0;
  let up = 0;
  let down = 0;
  let peak = -Infinity;
  for (let i = 0; i < b2.length; i++) {
    const dv = a2[i] - b2[i];
    net += dv;
    if (dv > 1e-6) up++;
    else if (dv < -1e-6) down++;
    if (a2[i] > peak) peak = a2[i];
  }
  check('成形返回成功且改动大量格子', ok2 && d2.n > 5000, d2.n + ' 格');
  check('以抬升为主（净体积为正）', net > 0 && up > down * 3,
    'up ' + up + ' / down ' + down + ' · 净 ' + net.toFixed(2));
  check('最高点落在合理高度（海平面之上、不超过 1）',
    peak > SEA + UNIT * 0.4 && peak <= 1.0, 'peak = ' + peak.toFixed(4));

  // 改动范围必须局限在「选区 + 外扩」里：不然就是在悄悄改全图
  const limit = 150 * 0.65 + 10 + 6;
  let outsideN = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (a2[i] === b2[i]) continue;
      const dx = Math.max(0, 170 - x, x - 470);
      const dy = Math.max(0, 95 - y, y - 305);
      if (Math.hypot(dx, dy) > limit) outsideN++;
    }
  }
  check('改动局限在选区附近（不污染全图）', outsideN === 0, outsideN + ' 格越界');

  {
    const coast = coastRatio(gen.cells, W, H, SEA);
    check('海岸线被分形打碎（破碎度 > 1.6）', coast.ratio > 1.6,
      '破碎度 ' + coast.ratio.toFixed(2) + ' · 陆 ' + coast.land + ' 格 / 岸 ' + coast.edge + ' 格');
  }

  // ---------- 3. 重复成形不会越堆越高 ----------
  console.log('\n【3】重复成形的收敛性');
  {
    // 独立跑一套：连点 4 次，体积增量应该逐次衰减，而不是每次叠加同样的量
    const sw = 200;
    const sh = 160;
    const grid = new Array(sw * sh);
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        grid[y * sw + x] = { x, y, e: 0.26, temp: 0.7, m: 0.5 };
      }
    }
    const poly = circlePoly(100, 80, 62, 48, 40);
    const mask = new Float32Array(sw * sh);
    const sel = Ops.buildSelectionMask(mask, sw, sh, poly, { seed: 909 });
    const volume = [];
    let peak = -Infinity;
    for (let r = 0; r < 4; r++) {
      Ops.shapeRegion(grid, sw, sh, sel.mask, sel.box, {
        seaLevel: SEA, mode: 'land', strength: 0.85, seed: 909, scale: sel.scale,
      });
      let sum = 0;
      for (const c of grid) { sum += c.e; if (c.e > peak) peak = c.e; }
      volume.push(sum);
    }
    const inc1 = volume[1] - volume[0];
    const inc3 = volume[3] - volume[2];
    const bound = SEA + UNIT * 1.12;
    check('峰值不会突破目标高度上限', peak <= bound + 1e-6,
      'peak ' + peak.toFixed(4) + ' ≤ ' + bound.toFixed(4));
    check('体积增量逐次衰减（几何收敛，不是线性叠加）', inc3 < inc1 * 0.5,
      'Δ1 ' + inc1.toFixed(3) + ' → Δ3 ' + inc3.toFixed(3));
  }

  // ---------- 4. 历史 / 撤销 / 重做 ----------
  console.log('\n【4】历史记录');
  check('产生 1 条历史', editor.history.length === 1,
    JSON.stringify(editor.history.map((h) => h.label)));
  const entry = editor.history[0];
  // 【判据的语义】要保证的是：记进去的每一格都必须真的变了。
  let noop = 0;
  for (let k = 0; k < entry.idx.length; k++) {
    if (entry.beforeE[k] === entry.afterE[k]) noop++;
  }
  check('历史只记变化格（无空记录）', noop === 0, noop + ' 条空记录 / 共 ' + entry.idx.length);

  editor.undo();
  const afterUndo = snapshotE(gen.cells);
  const undoDiff = diffCount(before, afterUndo);
  check('撤销逐位还原', undoDiff.n === 0, '残差 ' + undoDiff.n + ' 格');

  editor.redo();
  const afterRedo = snapshotE(gen.cells);
  const redoDiff = diffCount(a2, afterRedo);
  check('重做逐位复现', redoDiff.n === 0, '残差 ' + redoDiff.n + ' 格');

  // ---------- 5. 沉陷成海洋 ----------
  console.log('\n【5】沉陷成海洋');
  // 在刚长出来的大陆上圈一块，把它压回海里
  drawCircle(canvas, 320, 200, 95, 70, 36);
  const hasSel5 = editor.hasLasso();
  const b5 = snapshotE(gen.cells);
  const ok5 = editor.applyRegionAction('sea');
  const a5 = snapshotE(gen.cells);
  const d5 = diffCount(b5, a5);
  let net5 = 0;
  for (let i = 0; i < b5.length; i++) net5 += a5[i] - b5[i];
  // 中心那一格：成形前是陆地，成形后必须是海
  const midIdx = 200 * W + 320;
  check('沉陷返回成功', hasSel5 && ok5 && d5.n > 3000, d5.n + ' 格');
  check('以沉降为主（净体积为负）', net5 < 0 && net5 < -0.5, '净 ' + net5.toFixed(2));
  check('选区中心由陆变海', b5[midIdx] >= SEA && a5[midIdx] < SEA,
    b5[midIdx].toFixed(4) + ' → ' + a5[midIdx].toFixed(4));
  check('两种模式各留一条历史', editor.history.length === 2,
    JSON.stringify(editor.history.map((h) => h.label)));

  // ---------- 6. 守卫：没有选区 / 选区太小 ----------
  console.log('\n【6】非法输入守卫');
  editor.clearLasso();
  const beforeGuard = snapshotE(gen.cells);
  check('没有选区时不做任何事', editor.applyRegionAction('land') === false,
    '返回 false');
  drawCircle(canvas, 500, 350, 5, 5, 12);
  check('选区太小时拒绝成形', editor.applyRegionAction('land') === false,
    '内切半径过小');
  const guardDiff = diffCount(beforeGuard, snapshotE(gen.cells));
  check('被拒绝的请求没有改数据', guardDiff.n === 0, guardDiff.n + ' 格');

  // ---------- 7. 延后的「重算气候 + 重建水系」 ----------
  console.log('\n【7】延后收尾');
  const hydroBefore = gen.stats.hydroCalls;
  const climateBefore = gen.stats.climateCalls;
  await sleep(400);
  check('重算气候被触发', gen.stats.climateCalls > climateBefore,
    climateBefore + ' → ' + gen.stats.climateCalls);
  check('重建水系被触发', gen.stats.hydroCalls > hydroBefore,
    hydroBefore + ' → ' + gen.stats.hydroCalls);
  check('海深被重算', renderer.oceanDepthCalls > 0, renderer.oceanDepthCalls + ' 次');
  check('状态栏有进度反馈', statusLog.some((s) => s.includes('水系')), '"' +
    (statusLog.find((s) => s.includes('水系')) || '') + '"');

  // ---------- 8. 非等距投影 ----------
  console.log('\n【8】非等距投影（罗宾逊）');
  renderer.projector = {
    name: 'robinson',
    valid: new Uint8Array(W * H).fill(1),
    sx: new Float32Array(W * H),
    sy: new Float32Array(W * H),
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      renderer.projector.sx[i] = x * 0.9 + 30;
      renderer.projector.sy[i] = y * 0.9 + 20;
    }
  }
  const b8 = snapshotE(gen.cells);
  // 屏幕坐标 → 数据坐标要反着来：data = (screen - offset) / 0.9
  const pts8 = circlePoly(300, 180, 110, 80, 36);
  canvas.emit('pointerdown', pointerEvt(pts8[0].x, pts8[0].y));
  for (let k = 1; k < pts8.length; k++) canvas.emit('pointermove', pointerEvt(pts8[k].x, pts8[k].y));
  window.emit('pointerup', pointerEvt(pts8[0].x, pts8[0].y, 1));
  const ok8 = editor.applyRegionAction('land');
  const d8 = diffCount(b8, snapshotE(gen.cells));
  check('罗宾逊投影下仍能成形', ok8 && d8.n > 2000, d8.n + ' 格');

  // ---------- 9. 内存体量 ----------
  {
    let bytes = 0;
    for (const h of editor.history) {
      bytes += h.idx.byteLength + h.beforeE.byteLength + h.afterE.byteLength +
        h.beforeT.byteLength + h.afterT.byteLength;
    }
    const perStep = editor.history.length ? bytes / editor.history.length : 0;
    check('单步历史 < 2 MB', perStep < 2 * 1024 * 1024,
      (perStep / 1024).toFixed(0) + ' KB/步 × ' + editor.history.length + ' 步');
  }

  console.log('\n' + '='.repeat(78));
  console.log((failed === 0 ? 'PASS' : 'FAIL') + '  ' + passed + '/' + (passed + failed) + ' 项通过');
  console.log('='.repeat(78));
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error('\n💥 集成测试异常：');
  console.error(err);
  process.exit(1);
});
