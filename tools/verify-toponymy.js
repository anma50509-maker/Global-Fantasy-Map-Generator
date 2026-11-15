#!/usr/bin/env node
/**
 * verify-toponymy.js —— 地名引擎的可执行判据
 *
 * 【为什么要有这个脚本】
 * "地名"是很主观的东西，但这一层可以被拆成**可验证的硬约束**：
 *   1. 契约：renderer 和 globe 都按字段名/范围消费，字段错一个就白画；
 *   2. 数量与覆盖：太少等于没写地名，太多会糊满图；大陆/大洋/山脉/河流
 *      这四类必须都在，否则说明特征提取漏了；
 *   3. 坐标合法：x 必须环绕、y 必须夹在 [size, H-size]，否则字会跑到图外；
 *   4. 不重叠：避让布局的全部意义就在这里，重叠率必须接近 0；
 *   5. 确定性：同一张图两次构建必须逐字段一致（刷新不许换名字）；
 *   6. 性能：1.28M 格的网格上一次构建必须 < 300ms，否则切视图会卡；
 *   7. 健壮性：空数据 / 缺群系 / cells 长度不符时只退化，不许抛错。
 *
 * 用合成地形而不是真跑 map-generator：真生成一次要十几秒，
 * 而这里要反复构建、还要构造各种坏输入。合成数据是**手工画出来的**
 * 两块大陆 + 两条山脊 + 岛 + 河 + 湖 + 沙漠/森林斑块，
 * 每一块特征都是确定的，断言失败时能一眼看出是哪类要素没被识别。
 *
 * 用法：node tools/verify-toponymy.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

// ==================== 加载被测模块（不依赖 DOM） ====================
globalThis.window = globalThis;
globalThis.self = globalThis;
vm.runInThisContext(
  fs.readFileSync(path.join(ROOT, 'js', 'toponymy.js'), 'utf8'),
  { filename: 'js/toponymy.js' }
);
const FM = globalThis.FM;
const Topo = FM && FM.Toponymy;

// ==================== 判据工具 ====================

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
function section(title) {
  console.log('\n' + title);
}

// ==================== 合成世界 ====================

/**
 * 手工构造一张 2:1 的等距圆柱世界。
 *
 * 所有特征坐标都写成**比例**，这样同一份数据可以生成 640x320
 * （功能验证）和 1600x800（性能验证）两种尺度。
 *
 *   两块大陆 + 两座山脊（一斜一纵）+ 两座小岛 + 两条河 + 一个湖
 *   + 一块沙漠 + 一块森林。
 */
function makeSynthetic(W, H, seed) {
  const N = W * H;
  const cells = new Array(N);
  const seaLevel = 0.5;
  const sx = W / 640;          // 相对基准尺度的像素缩放
  const sy = H / 320;

  const fx = (f) => f * W;
  const fy = (f) => f * H;
  const gauss = (x, y, cx, cy, rx, ry) => {
    const dx = (x - cx) / rx;
    const dy = (y - cy) / ry;
    return Math.exp(-(dx * dx + dy * dy) / 2);
  };

  // 大陆 / 岛 / 湖 / 群系斑块的几何参数（比例坐标）
  const A = { cx: fx(0.234), cy: fy(0.516), rx: fx(0.122), ry: fy(0.287), amp: 0.46 };
  const B = { cx: fx(0.734), cy: fy(0.469), rx: fx(0.109), ry: fy(0.256), amp: 0.50 };
  const islands = [
    { cx: fx(0.469), cy: fy(0.806), rx: fx(0.020), ry: fy(0.041), amp: 0.30 },
    { cx: fx(0.539), cy: fy(0.750), rx: fx(0.016), ry: fy(0.031), amp: 0.28 },
  ];
  const lake = { cx: fx(0.720), cy: fy(0.600), rx: 8 * sx, ry: 8 * sy };
  const desertRect = { x0: fx(0.164), x1: fx(0.289), y0: fy(0.641), y1: fy(0.766) };
  const forestRect = { x0: fx(0.656), x1: fx(0.805), y0: fy(0.234), y1: fy(0.344) };

  // ---- 高度场 ----
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let e = 0.30;
      e += A.amp * gauss(x, y, A.cx, A.cy, A.rx, A.ry);
      e += B.amp * gauss(x, y, B.cx, B.cy, B.rx, B.ry);
      for (const il of islands) e += il.amp * gauss(x, y, il.cx, il.cy, il.rx, il.ry);

      // 山脊 1：大陆 A 上一条斜脊（验证 rotate 沿走向）
      const ridgeAy = fy(0.369) + (x - fx(0.234)) * 0.18;
      if (x > fx(0.133) && x < fx(0.336)) {
        const d = (y - ridgeAy) / (6 * sy);
        e += 0.42 * Math.exp(-(d * d) / 2);
      }
      // 山脊 2：大陆 B 上一条近纵向的脊
      if (y > fy(0.250) && y < fy(0.670)) {
        const bx = fx(0.734) + (y - fy(0.469)) * 0.10;
        const d = (x - bx) / (6 * sx);
        e += 0.40 * Math.exp(-(d * d) / 2);
      }
      e = Math.min(0.98, Math.max(0.06, e));

      const isLakeCell =
        ((x - lake.cx) / lake.rx) ** 2 + ((y - lake.cy) / lake.ry) ** 2 <= 1
        && e > seaLevel;

      if (isLakeCell) e = 0.62;      // 湖面平坦（靠 isLake 标记，不参与陆地高度统计）

      cells[y * W + x] = {
        x, y, e,
        m: 0.5, temp: 0.5, tempSea: 0.5, precip: 0.5,
        isRiver: false, isLake: isLakeCell,
        flow: isLakeCell ? 100 : 0,
        monsoon: 0, windU: 0, windV: 0,
        current: { u: 0, v: 0 },
        biome: '海洋',
      };
    }
  }

  // ---- 群系（第二遍：湖泊/水域/沙漠/森林）----
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = cells[y * W + x];
      if (c.isLake) {
        c.biome = '湖泊';
        continue;
      }
      if (c.e < seaLevel) {
        const depth = seaLevel - c.e;
        c.biome = depth > 0.22 ? '深海' : depth > 0.05 ? '海洋' : '浅海';
        continue;
      }
      if (x >= desertRect.x0 && x <= desertRect.x1 && y >= desertRect.y0 && y <= desertRect.y1) {
        c.biome = '温带沙漠';
      } else if (x >= forestRect.x0 && x <= forestRect.x1 && y >= forestRect.y0 && y <= forestRect.y1) {
        c.biome = '落叶阔叶林';
      } else if (c.e > 0.74) {
        c.biome = '裸岩';
      } else {
        c.biome = '温带草原';
      }
    }
  }

  // ---- 河流（数据坐标，和 hydrology.js 的输出同格式）----
  function makeRiver(pts, flows) {
    const flat = [];
    for (const p of pts) flat.push(p[0], p[1]);
    return {
      points: flat,
      flows,
      count: pts.length,
      maxFlow: flows[flows.length - 1] || 1,
      hitLake: false,
    };
  }
  const riverA = makeRiver(
    [
      [fx(0.200), fy(0.400)],
      [fx(0.215), fy(0.440)],
      [fx(0.235), fy(0.490)],
      [fx(0.255), fy(0.540)],
      [fx(0.278), fy(0.590)],
      [fx(0.300), fy(0.640)],
    ],
    [40, 90, 160, 240, 340, 460]
  );
  const riverB = makeRiver(
    [
      [fx(0.680), fy(0.300)],
      [fx(0.700), fy(0.350)],
      [fx(0.720), fy(0.410)],
      [fx(0.745), fy(0.470)],
      [fx(0.760), fy(0.520)],
    ],
    [20, 45, 80, 120, 170]
  );

  // ---- 湖泊 ----
  let lakeArea = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (cells[y * W + x].isLake) lakeArea++;
    }
  }
  const lakes = [{
    area: lakeArea,
    level: 0.62,
    x: lake.cx,
    y: lake.cy,
    minX: Math.round(lake.cx - lake.rx),
    maxX: Math.round(lake.cx + lake.rx),
    minY: Math.round(lake.cy - lake.ry),
    maxY: Math.round(lake.cy + lake.ry),
    maxFlow: 120,
  }];

  return {
    width: W,
    height: H,
    seaLevel,
    seed,
    cells,
    rivers: [riverA, riverB],
    lakes,
  };
}

// ==================== 布局 bbox（与 js/toponymy.js 的公式一致） ====================

function bezierPoint(curve, t) {
  const u = 1 - t;
  return {
    x: u * u * curve.x0 + 2 * u * t * curve.x1 + t * t * curve.x2,
    y: u * u * curve.y0 + 2 * u * t * curve.y1 + t * t * curve.y2,
  };
}

function labelExtent(label) {
  if (label.curve) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let k = 0; k <= 8; k++) {
      const p = bezierPoint(label.curve, k / 8);
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    return {
      cx: (minX + maxX) / 2,
      cy: (minY + maxY) / 2,
      w: (maxX - minX) + label.size * 1.02,
      h: (maxY - minY) + label.size * 1.35,
    };
  }
  const w0 = label.text.length * label.size * 1.02;
  const h0 = label.size * 1.35;
  const c = Math.abs(Math.cos(label.rotate));
  const s = Math.abs(Math.sin(label.rotate));
  return { cx: label.x, cy: label.y, w: w0 * c + h0 * s, h: w0 * s + h0 * c };
}

/** 统计互相冲突的标签对数（x 方向按环绕距离） */
function countOverlaps(labels, W, pad) {
  const exts = labels.map(labelExtent);
  let pairs = 0;
  for (let i = 0; i < exts.length; i++) {
    for (let j = i + 1; j < exts.length; j++) {
      const a = exts[i];
      const b = exts[j];
      let dx = a.cx - b.cx;
      dx = ((dx % W) + W) % W;
      if (dx > W / 2) dx -= W;
      const dy = a.cy - b.cy;
      if (Math.abs(dx) < (a.w + b.w) / 2 + pad &&
          Math.abs(dy) < (a.h + b.h) / 2 + pad) {
        pairs++;
      }
    }
  }
  return pairs;
}

const KINDS = [
  'continent', 'ocean', 'sea', 'mountain', 'peak',
  'desert', 'forest', 'river', 'lake', 'island',
];

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 逐字段检查一个标签的契约与数值合法性，返回错误描述数组 */
function validateLabels(labels, W, H) {
  const errors = [];
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    const tag = '#' + i + '(' + (l && l.kind) + ')';
    if (!l || typeof l !== 'object') { errors.push(tag + ' 不是对象'); continue; }
    if (typeof l.text !== 'string' || !l.text) errors.push(tag + ' text 非法');
    if (typeof l.name !== 'string' || !l.name) errors.push(tag + ' name 非法');
    if (typeof l.text === 'string' && typeof l.name === 'string' &&
        l.text.indexOf(l.name) !== 0) {
      errors.push(tag + ' text 未以 name 开头');
    }
    if (KINDS.indexOf(l.kind) < 0) errors.push(tag + ' kind 非法：' + l.kind);
    if (!isFiniteNumber(l.x) || !isFiniteNumber(l.y)) errors.push(tag + ' 坐标非有限数');
    if (!isFiniteNumber(l.size) || l.size <= 0) errors.push(tag + ' size 非法');
    if (!isFiniteNumber(l.rotate)) errors.push(tag + ' rotate 非有限数');
    if (!isFiniteNumber(l.importance) || l.importance < 1 || l.importance > 5 ||
        Math.floor(l.importance) !== l.importance) {
      errors.push(tag + ' importance 必须是 1~5 的整数');
    }
    if (isFiniteNumber(l.x) && (l.x < 0 || l.x >= W)) errors.push(tag + ' x 越界：' + l.x);
    if (isFiniteNumber(l.y) && isFiniteNumber(l.size)) {
      if (l.y < l.size - 1e-6 || l.y > H - l.size + 1e-6) {
        errors.push(tag + ' y 未夹在 [size, H-size]：' + l.y);
      }
    }
    if (isFiniteNumber(l.rotate) && Math.abs(l.rotate) > Math.PI / 2 + 1e-6) {
      errors.push(tag + ' rotate 超过 ±90°');
    }
    if (l.curve != null) {
      const c = l.curve;
      for (const key of ['x0', 'y0', 'x1', 'y1', 'x2', 'y2']) {
        if (!isFiniteNumber(c[key])) errors.push(tag + ' curve.' + key + ' 非有限数');
      }
      if (['continent', 'ocean', 'sea'].indexOf(l.kind) < 0) {
        errors.push(tag + ' 只有大陆/大洋/海允许有 curve');
      }
    }
    if (l.path != null) {
      if (!Array.isArray(l.path)) errors.push(tag + ' path 必须是数组');
      else {
        for (const v of l.path) {
          if (!isFiniteNumber(v)) { errors.push(tag + ' path 含非有限数'); break; }
        }
        if (l.kind !== 'river') errors.push(tag + ' 只有 river 允许有 path');
      }
    }
    if (l.kind === 'river' && !Array.isArray(l.path)) {
      errors.push(tag + ' river 必须带 path');
    }
    if (l.kind === 'mountain' && isFiniteNumber(l.rotate) && Math.abs(l.rotate) > 0.6 + 1e-6) {
      errors.push(tag + ' 山脉 rotate 超过 ±0.6');
    }
  }
  return errors;
}

// ==================== 开始验证 ====================

console.log('='.repeat(64));
console.log('地名引擎验证：js/toponymy.js');
console.log('='.repeat(64));

section('1. 模块导出与契约');
check('FM.Toponymy 已注册', !!Topo);
check('FM.Toponymy.build 是函数', !!(Topo && typeof Topo.build === 'function'));
check('FM.Toponymy.version 是字符串', !!(Topo && typeof Topo.version === 'string'),
  Topo ? 'v' + Topo.version : '');

if (!Topo || typeof Topo.build !== 'function') {
  console.error('\n✗ 模块未正确导出，后续验证无法进行');
  process.exit(1);
}

// ---- 640x320 功能验证 ----
const W = 640;
const H = 320;
const world = makeSynthetic(W, H, 'verify-toponymy-A');

section('2. 构建结果：结构、数量、覆盖');
let result;
let buildMs = 0;
try {
  const t0 = performance.now();
  result = Topo.build(world);
  buildMs = performance.now() - t0;
  check('build 未抛错', true);
} catch (err) {
  check('build 未抛错', false, String((err && err.message) || err));
  console.error(err);
  process.exit(1);
}

check('返回 { worldName, labels }',
  !!result && typeof result.worldName === 'string' && Array.isArray(result.labels));
check('worldName 非空', !!(result && result.worldName &&
  result.worldName.length >= 3 && result.worldName.length <= 8), result.worldName);

const labels = result.labels;
const kindCount = {};
for (const l of labels) kindCount[l.kind] = (kindCount[l.kind] || 0) + 1;
const kindSummary = Object.keys(kindCount).sort()
  .map((k) => k + ':' + kindCount[k]).join('  ');
console.log('     标签总数 ' + labels.length + '   ' + kindSummary);
check('标签数量在 12~60', labels.length >= 12 && labels.length <= 60,
  '实测 ' + labels.length);
check('kind 覆盖 continent', (kindCount.continent || 0) >= 1);
check('kind 覆盖 ocean', (kindCount.ocean || 0) >= 1);
check('kind 覆盖 mountain', (kindCount.mountain || 0) >= 1);
check('kind 覆盖 river', (kindCount.river || 0) >= 1);
check('kind 覆盖 lake', (kindCount.lake || 0) >= 1);
check('kind 覆盖 island', (kindCount.island || 0) >= 1);
check('kind 覆盖 desert', (kindCount.desert || 0) >= 1);
check('kind 覆盖 forest', (kindCount.forest || 0) >= 1);
check('importance 按从大到小排列',
  labels.every((l, i) => i === 0 || labels[i - 1].importance >= l.importance));

section('3. 字段契约与坐标合法性');
const fieldErrors = validateLabels(labels, W, H);
check('全部标签字段合法（无 NaN / 越界 / 类型错误）',
  fieldErrors.length === 0,
  fieldErrors.length ? fieldErrors.slice(0, 6).join('；') : '');

// 海洋标签必须落在水里，大陆/岛屿必须落在陆地上
let waterBad = 0;
let landBad = 0;
for (const l of labels) {
  const ix = Math.floor(l.x);
  const iy = Math.min(H - 1, Math.max(0, Math.floor(l.y)));
  const c = world.cells[iy * W + ix];
  const isWater = c.e < world.seaLevel && !c.isLake;
  if ((l.kind === 'ocean' || l.kind === 'sea') && !isWater) waterBad++;
  if ((l.kind === 'continent' || l.kind === 'island') && (c.e < world.seaLevel && !c.isLake)) landBad++;
}
check('海洋/海标签中心落在水域', waterBad === 0, '越界 ' + waterBad + ' 条');
check('大陆/岛屿标签中心落在陆地', landBad === 0, '越界 ' + landBad + ' 条');

section('4. 布局避让（矩形不重叠）');
const overlapPairs = countOverlaps(labels, W, 0);
const overlapRatio = labels.length ? overlapPairs / labels.length : 0;
check('标签矩形重叠率 < 5%', overlapRatio < 0.05,
  '重叠 ' + overlapPairs + ' 对 / ' + labels.length + ' 条 = ' +
  (overlapRatio * 100).toFixed(1) + '%');

section('5. 确定性（同一张图两次构建逐字段一致）');
function stableStringify(obj) {
  return JSON.stringify(obj);
}
let r1;
let r2;
try {
  r1 = Topo.build(world);
  r2 = Topo.build(world);
} catch (err) {
  check('重复构建未抛错', false, String((err && err.message) || err));
}
check('同一个 generator 连续构建两次结果一致',
  !!r1 && !!r2 && stableStringify(r1) === stableStringify(r2));
const world2 = makeSynthetic(W, H, 'verify-toponymy-A');
let r3;
try {
  r3 = Topo.build(world2);
} catch (err) {
  check('独立重建同 seed 数据未抛错', false, String((err && err.message) || err));
}
check('独立重建同 seed 数据结果一致',
  !!r3 && stableStringify(result) === stableStringify(r3));
const world3 = makeSynthetic(W, H, 'verify-toponymy-B');
const r4 = Topo.build(world3);
check('不同 seed 的世界名不同', r4.worldName !== result.worldName,
  result.worldName + ' vs ' + r4.worldName);

section('6. 性能（契约：1.28M 格 < 300ms）');
console.log('     640x320 构建耗时 ' + buildMs.toFixed(1) + ' ms');
check('640x320 单次构建 < 300ms', buildMs < 300);

const bigW = 1600;
const bigH = 800;
const bigWorld = makeSynthetic(bigW, bigH, 'verify-toponymy-big');
let bigResult;
let bigMs = 0;
try {
  // 【为什么要跑两遍取较小值】刚构造出来的 1.28M 个 cell 对象还在新生代里，
  // 第一遍构建途中会触发 GC 与 JIT 预热，耗时能差出 2 倍以上。
  // 判据关心的是"引擎在这张网格上的成本"，不是测试数据分配带来的抖动，
  // 所以第一遍当热身，取两遍里更快的那个（两遍结果本身由确定性检查兜底）。
  const t0 = performance.now();
  const warm = Topo.build(bigWorld);
  const msA = performance.now() - t0;
  const t1 = performance.now();
  bigResult = Topo.build(bigWorld);
  const msB = performance.now() - t1;
  bigMs = Math.min(msA, msB);
  console.log('     1600x800 两遍热身耗时 ' + msA.toFixed(1) + ' / ' + msB.toFixed(1) + ' ms');
  if (warm && JSON.stringify(warm) !== JSON.stringify(bigResult)) {
    console.log('     ⚠ 两遍结果不一致（确定性判据会单独报错）');
  }
} catch (err) {
  check('1600x800 构建未抛错', false, String((err && err.message) || err));
}
check('1600x800 构建未抛错', !!bigResult);
if (bigResult) {
  const bigKinds = {};
  for (const l of bigResult.labels) bigKinds[l.kind] = (bigKinds[l.kind] || 0) + 1;
  console.log('     1600x800 构建耗时 ' + bigMs.toFixed(1) + ' ms，标签 ' +
    bigResult.labels.length + ' 条  ' +
    Object.keys(bigKinds).sort().map((k) => k + ':' + bigKinds[k]).join('  '));
  check('1600x800 单次构建 < 300ms', bigMs < 300, bigMs.toFixed(1) + ' ms');
  const bigErrors = validateLabels(bigResult.labels, bigW, bigH);
  check('1600x800 标签字段合法', bigErrors.length === 0,
    bigErrors.length ? bigErrors.slice(0, 6).join('；') : '');
  check('1600x800 标签数量在 12~60',
    bigResult.labels.length >= 12 && bigResult.labels.length <= 60,
    '实测 ' + bigResult.labels.length);
}

section('7. 健壮性（坏输入只退化，不抛错）');
function tryBuild(name, input, predicate) {
  try {
    const out = Topo.build(input);
    const okShape = !!out && typeof out.worldName === 'string' && Array.isArray(out.labels);
    check(name, okShape && (!predicate || predicate(out)));
    return out;
  } catch (err) {
    check(name, false, String((err && err.message) || err));
    return null;
  }
}

tryBuild('generator 为空对象', {}, (out) => out.labels.length === 0);
tryBuild('generator 为 null', null, (out) => out.labels.length === 0);
tryBuild('cells 为空数组', { width: W, height: H, cells: [] },
  (out) => out.labels.length === 0);
tryBuild('cells 长度不足（截断到 1000 格）',
  { width: W, height: H, seaLevel: 0.5, seed: 'x', cells: world.cells.slice(0, 1000) },
  (out) => out.labels.length === 0);
tryBuild('width/height 缺失', { cells: world.cells, seed: 'x' },
  (out) => out.labels.length === 0);

// 去掉河流与湖泊：仍然要出大陆/海洋/山脉
const noRivers = {
  width: W, height: H, seaLevel: world.seaLevel, seed: world.seed,
  cells: world.cells, rivers: [], lakes: [],
};
const outNoRivers = tryBuild('rivers/lakes 为空', noRivers, (out) => {
  return out.labels.length >= 6 && out.labels.some((l) => l.kind === 'continent') &&
    out.labels.some((l) => l.kind === 'ocean') && out.labels.some((l) => l.kind === 'mountain');
});
if (outNoRivers) {
  check('无河湖时不再产生 river/lake 标签',
    !outNoRivers.labels.some((l) => l.kind === 'river' || l.kind === 'lake'));
}

// 群系字段缺失：只退化掉沙漠/森林，其余照常
const noBiome = {
  width: W, height: H, seaLevel: world.seaLevel, seed: world.seed,
  cells: world.cells.map((c) => {
    const copy = Object.assign({}, c);
    delete copy.biome;
    return copy;
  }),
  rivers: world.rivers, lakes: world.lakes,
};
const outNoBiome = tryBuild('cell.biome 缺失', noBiome, (out) => out.labels.length >= 6);
if (outNoBiome) {
  check('缺 biome 时无 desert/forest 标签，其余仍在',
    !outNoBiome.labels.some((l) => l.kind === 'desert' || l.kind === 'forest') &&
    outNoBiome.labels.some((l) => l.kind === 'continent') &&
    outNoBiome.labels.some((l) => l.kind === 'ocean'));
}

// 输入不可被修改：cells 与 rivers 的数量/内容保持不变
const cellSampleBefore = JSON.stringify(world.cells[0]);
const riverCountBefore = world.rivers.length;
Topo.build(world);
check('构建不修改输入 generator',
  JSON.stringify(world.cells[0]) === cellSampleBefore &&
  world.rivers.length === riverCountBefore && world.lakes.length === 1);

section('8. 标签示例');
const examples = labels.slice(0, 5);
for (const l of examples) {
  console.log('     ' + l.text.padEnd(8) + '  ' +
    l.kind.padEnd(9) + '  (' + l.x.toFixed(1) + ', ' + l.y.toFixed(1) + ')' +
    '  size=' + l.size + '  rotate=' + l.rotate.toFixed(2) +
    (l.curve ? '  curve' : ''));
}

// ==================== 汇总 ====================
console.log('\n' + '='.repeat(64));
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
console.log('='.repeat(64));
if (failed === 0) {
  console.log('PASS');
  process.exit(0);
} else {
  console.log('FAIL');
  process.exit(1);
}
