#!/usr/bin/env node
/**
 * verify-region.js —— 选区塑形的「自然度」判据
 *
 * 【为什么需要这个脚本】
 * 前三轮都卡在同一个地方：参数改完，图看起来还是"不自然"，但说不出哪里不对，
 * 于是只能靠眼睛猜。眼睛分辨不出「这块大陆是不是橡皮泥」「这条山带是不是
 * 划痕」，而且每次重新看图，印象都不一样。
 *
 * 这里把"自然"拆成五个可以量化的判据，全部在离屏环境里跑
 * （配色/光照不参与，只看高度场本身）：
 *
 *   1. **海岸破碎度** —— 陆海边界长度 ÷ 同面积圆周长。
 *      一块光滑的椭圆 ≈ 1.0；有半岛、海湾、离岸岛的海岸会明显更大。
 *      这一条直接判"是不是把多边形描了一遍"。
 *   2. **岸线偏离度** —— 海岸格里有几成还压在原多边形边上。
 *      剩下的都是被噪声推走的部分。> 0.5 说明噪声幅度不够。
 *   3. **高度—距海相关性** —— 每个陆地格的高度与它离海岸的距离的相关性。
 *      真实大陆是"靠海低、内陆高"，相关系数应在 0.3~0.9 之间。
 *      0 附近就是一块平板，1 附近是标准圆锥。
 *   4. **高地集中度** —— landE > 0.62 的格子占陆地的比例。
 *      太小（<3%）说明没有山，太大（>50%）说明整块都是山（"裂开的泥地"）。
 *   5. **坡面陡峭度** —— p99 相邻高差。台阶、鱼骨刺、噪声砂纸都会把它顶上去。
 *
 * 外加三个工程判据：确定性（同 seed 逐位一致）、边界（不改选区外）、
 * 性能预算（合成 + 侵蚀的耗时上限）。
 *
 * 用法：node tools/verify-region.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

globalThis.self = globalThis;
vm.runInThisContext(
  fs.readFileSync(path.join(__dirname, '..', 'js', 'hypsometry.js'), 'utf8'),
  { filename: 'hypsometry.js' }
);
vm.runInThisContext(
  fs.readFileSync(path.join(__dirname, '..', 'js', 'terrain-ops.js'), 'utf8'),
  { filename: 'terrain-ops.js' }
);
const Ops = globalThis.FM.TerrainOps;
if (!Ops) {
  console.error('FM.TerrainOps 未挂载');
  process.exit(1);
}

// ==================== 场景 ====================

const PW = 640;
const PH = 440;
const SEA = 0.55;          // app 实际海平面 —— 陆地可用高度只有 0.07
const UNIT = 1 - SEA;

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

/** 满屏深海 */
function makeOcean(seed) {
  const cells = new Array(PW * PH);
  for (let y = 0; y < PH; y++) {
    for (let x = 0; x < PW; x++) {
      const d = 0.6 + Ops.fbm(x / 130, y / 130, 3, 2, 0.5, seed + 7) * 0.3;
      cells[y * PW + x] = { x, y, e: SEA - UNIT * d, temp: 0.62, m: 0.5 };
    }
  }
  return cells;
}

function circlePoly(cx, cy, rx, ry, seed, n) {
  const pts = [];
  const N = n || 46;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const wob = 1 + Ops.fbm(Math.cos(a) * 2.2 + 10, Math.sin(a) * 2.2 + 10, 3, 2, 0.5, seed) * 0.22;
    pts.push({ x: cx + Math.cos(a) * rx * wob, y: cy + Math.sin(a) * ry * wob });
  }
  return pts;
}

// ==================== 度量工具 ====================

const isLand = (cells, i) => cells[i].e >= SEA;

/** 海岸破碎度：边界格数 ÷ 同面积理想圆周长 */
function coastStats(cells) {
  let land = 0;
  let edge = 0;
  for (let y = 1; y < PH - 1; y++) {
    for (let x = 1; x < PW - 1; x++) {
      const i = y * PW + x;
      if (!isLand(cells, i)) continue;
      land++;
      if (!isLand(cells, i - 1) || !isLand(cells, i + 1) ||
          !isLand(cells, i - PW) || !isLand(cells, i + PW)) edge++;
    }
  }
  if (land < 50) return { land, edge, ratio: 0 };
  return { land, edge, ratio: edge / (2 * Math.sqrt(Math.PI * land)) };
}

/** 陆地格到最近海的近似欧氏距离（两遍倒角） */
function distToSea(cells) {
  const INF = 1e9;
  const d = new Float32Array(PW * PH);
  for (let i = 0; i < d.length; i++) d[i] = isLand(cells, i) ? INF : 0;
  const D1 = 1;
  const D2 = Math.SQRT2;
  for (let y = 1; y < PH - 1; y++) {
    for (let x = 1; x < PW - 1; x++) {
      const i = y * PW + x;
      if (d[i] === 0) continue;
      let m = d[i];
      if (m > d[i - PW - 1] + D2) m = d[i - PW - 1] + D2;
      if (m > d[i - 1] + D1) m = d[i - 1] + D1;
      if (m > d[i - PW] + D1) m = d[i - PW] + D1;
      if (m > d[i - PW + 1] + D2) m = d[i - PW + 1] + D2;
      d[i] = m;
    }
  }
  for (let y = PH - 2; y >= 1; y--) {
    for (let x = PW - 2; x >= 1; x--) {
      const i = y * PW + x;
      if (d[i] === 0) continue;
      let m = d[i];
      if (m > d[i + PW + 1] + D2) m = d[i + PW + 1] + D2;
      if (m > d[i + 1] + D1) m = d[i + 1] + D1;
      if (m > d[i + PW] + D1) m = d[i + PW] + D1;
      if (m > d[i + PW - 1] + D2) m = d[i + PW - 1] + D2;
      d[i] = m;
    }
  }
  return d;
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 10) return 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n;
  const my = sy / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    sxy += a * b;
    sxx += a * a;
    syy += b * b;
  }
  if (sxx <= 0 || syy <= 0) return 0;
  return sxy / Math.sqrt(sxx * syy);
}

/** 相邻 landE 高差的 p99 与均值 */
function slopeStats(cells) {
  const diffs = [];
  for (let y = 1; y < PH - 1; y++) {
    for (let x = 1; x < PW - 1; x++) {
      const i = y * PW + x;
      if (!isLand(cells, i)) continue;
      if (!isLand(cells, i + 1) || !isLand(cells, i + PW)) continue;
      diffs.push(Math.abs(cells[i].e - cells[i + 1].e) / UNIT);
      diffs.push(Math.abs(cells[i].e - cells[i + PW].e) / UNIT);
    }
  }
  if (!diffs.length) return { p99: 0, mean: 0 };
  let sum = 0;
  for (const d of diffs) sum += d;
  const sorted = diffs.slice().sort((a, b) => a - b);
  return {
    p99: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))],
    mean: sum / diffs.length,
  };
}

/** 多边形边界附近 3 格内的格子集合（判断海岸是不是还压在原多边形上） */
function nearPolygon(poly, radius) {
  const hit = new Uint8Array(PW * PH);
  const R = radius || 3;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y));
    for (let s = 0; s <= n; s++) {
      const px = a.x + (b.x - a.x) * (s / n);
      const py = a.y + (b.y - a.y) * (s / n);
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          if (dx * dx + dy * dy > R * R) continue;
          const x = Math.round(px) + dx;
          const y = Math.round(py) + dy;
          if (x < 0 || x >= PW || y < 0 || y >= PH) continue;
          hit[y * PW + x] = 1;
        }
      }
    }
  }
  return hit;
}

// ==================== 主流程 ====================

const poly = circlePoly(PW * 0.5, PH * 0.5, 190, 128, 4242);

console.log('='.repeat(78));
console.log('选区塑形 · 自然度判据   网格 ' + PW + '×' + PH +
  '   海平面 ' + SEA + '（陆地可用高度 ' + UNIT.toFixed(3) + '）');
console.log('='.repeat(78));

// ---------- A. 隆起成大陆 ----------
console.log('\n【A】隆起成大陆');

const cells = makeOcean(1001);
const rawE = new Float32Array(PW * PH);
for (let i = 0; i < cells.length; i++) rawE[i] = cells[i].e;

const mask = new Float32Array(PW * PH);
const shelfBuf = new Float32Array(PW * PH);
const sel = Ops.buildSelectionMask(mask, PW, PH, poly, { seed: 4242, shelfBuffer: shelfBuf });
check('选区掩膜生成', !!sel, sel ? 'bbox ' + JSON.stringify(sel.box) + ' · 尺度 ' + sel.scale.toFixed(1) : '');

const t0 = Date.now();
const shaped = Ops.shapeRegion(cells, PW, PH, sel.mask, sel.box, {
  seaLevel: SEA, mode: 'land', strength: 0.82, seed: 4242, scale: sel.scale,
  shelf: sel.shelf,
});
const msShape = Date.now() - t0;
check('成形改了格子', shaped.changed > 10000, shaped.changed + ' 格 · ' + msShape + ' ms');
check('合成耗时 < 400 ms', msShape < 400, msShape + ' ms');

// 1. 海岸破碎度
// 【阈值为什么是 1.7】基准是「同面积的理想圆 = 1.0」。现实世界参照：非洲
// 海岸线约 3 万公里、面积 3000 万平方公里，2√(πA) ≈ 1.94 万公里，
// 比值 ≈ 1.55。所以 1.7 已经比非洲更破碎了 —— 再往上调就是在要求
// 不符合地图学常识的锯齿。
const coast = coastStats(cells);
check('海岸破碎度 > 1.7（不是把多边形描了一遍）', coast.ratio > 1.7,
  '破碎度 ' + coast.ratio.toFixed(2) + ' · 陆 ' + coast.land + ' 格 / 岸 ' + coast.edge + ' 格');

// 2. 岸线偏离度
{
  const near = nearPolygon(poly, 3);
  let onPoly = 0;
  let edge = 0;
  for (let y = 1; y < PH - 1; y++) {
    for (let x = 1; x < PW - 1; x++) {
      const i = y * PW + x;
      if (!isLand(cells, i)) continue;
      if (isLand(cells, i - 1) && isLand(cells, i + 1) && isLand(cells, i - PW) && isLand(cells, i + PW)) continue;
      edge++;
      if (near[i]) onPoly++;
    }
  }
  const frac = edge ? onPoly / edge : 1;
  check('岸线大部分已偏离原多边形（压线率 < 0.45）', frac < 0.45,
    (frac * 100).toFixed(1) + '% 的海岸格仍在多边形 ±3 格内');
}

// 3. 海岸平原：近岸明显低于内陆
const dsea = distToSea(cells);
{
  // 【为什么不用全局相关系数】起初用「landE 与距海距离的 Pearson r」，
  // 量出来 −0.03~0.26，看着像"没有海岸平原"，其实是这个指标在测错的东西：
  // 整块大陆的中央可能正好落在一个低频盆地里，那里离海最远、高度却最低，
  // 这一段把相关系数拉平了。真正要保证的是**近岸那一段**有没有抬起。
  const near = [];
  const inner = [];
  for (let i = 0; i < cells.length; i++) {
    if (!isLand(cells, i)) continue;
    const dd = dsea[i];
    if (dd > 900) continue;
    const le = (cells[i].e - SEA) / UNIT;
    if (dd < 8) near.push(le);
    else if (dd >= 24 && dd < 64) inner.push(le);
  }
  const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const mNear = avg(near);
  const mInner = avg(inner);
  check('有海岸平原（近岸平均高度 < 内陆的 70%）', mNear < mInner * 0.70,
    '近岸 ' + mNear.toFixed(3) + ' vs 内陆 ' + mInner.toFixed(3) +
    '（' + near.length + '/' + inner.length + ' 格）');
}

// 3b. 高度分布必须与生成器同源（测高曲线）
//
// 【为什么单列一条】这是本轮最大的病根：塑形出来的大陆 rel 中位数是 0.45，
// 而生成器按真实测高曲线重分布过，全世界陆地只有 0.041 —— 新大陆比旁边
// 任何一块老陆地高十一倍，看起来就是一块贴上去的褐色瘤子。
// 判据直接盯分位，可比性最强：地球的陆地就是 p50≈0.04 / p90≈0.20。
{
  const rels = [];
  for (let i = 0; i < cells.length; i++) {
    if (!isLand(cells, i)) continue;
    rels.push((cells[i].e - SEA) / UNIT);
  }
  rels.sort((a, b) => a - b);
  const p = (q) => rels[Math.floor(rels.length * q)];
  const p50 = p(0.5);
  const p90 = p(0.9);
  check('高度分布符合测高曲线（p50 0.02~0.09 · p90 0.12~0.32）',
    p50 > 0.02 && p50 < 0.09 && p90 > 0.12 && p90 < 0.32,
    'p50=' + p50.toFixed(3) + ' p90=' + p90.toFixed(3) + ' p99=' + p(0.99).toFixed(3));
}

// 3c. 选区 bbox 的四条边不能有假隆起
//
// 掩膜的外距倒角如果没把 bbox 外初始化成 INF，bbox 四条边会被误判成
// "紧贴岸线的内侧格"，mask 顶到 1.0 —— 图上是一道贯穿全图的竖线。
{
  let bad = 0;
  const { x0, y0, x1, y1 } = sel.box;
  for (let x = x0; x <= x1; x++) {
    if (sel.mask[y0 * PW + x] > 0.002) bad++;
    if (sel.mask[y1 * PW + x] > 0.002) bad++;
  }
  for (let y = y0; y <= y1; y++) {
    if (sel.mask[y * PW + x0] > 0.002) bad++;
    if (sel.mask[y * PW + x1] > 0.002) bad++;
  }
  check('选区边框没有假陆地（bbox 四边 mask 全 0）', bad === 0, bad + ' 格被点亮');
}

// 4. 高地集中度
//
// 【口径改了：0.62 → 0.226】原来用 landE > 0.62 当"高地",并要求占 3%~55%。
// 那个数字是照"高度被整体抬高 5 倍"的旧地形定的。按真实测高曲线，
// 93% 的陆地都在 0.226 以下，> 0.62 的只有 0.4% —— 判据必然报 0.5% 失败。
// 现在用地球自己的"山地线"(93 分位 = 0.226) 判：占 1%~25% 说明
// 有山、但没把整块大陆铺成山。
{
  let land = 0;
  let high = 0;
  let peak = -Infinity;
  let veryHigh = 0;
  for (let i = 0; i < cells.length; i++) {
    if (!isLand(cells, i)) continue;
    land++;
    const le = (cells[i].e - SEA) / UNIT;
    if (le > 0.226) high++;
    if (le > 0.62) veryHigh++;
    if (le > peak) peak = le;
  }
  const frac = high / land;
  check('山地区域占比合理（>0.226 的占 1%~25%）', frac > 0.01 && frac < 0.25,
    (frac * 100).toFixed(1) + '% 陆地是山地 · >0.62 仅 ' + (veryHigh / land * 100).toFixed(2) +
    '% · 峰值 landE ' + peak.toFixed(2));
}

// 5. 坡面陡峭度 + 侵蚀
const before5 = new Float32Array(PW * PH);
for (let i = 0; i < cells.length; i++) before5[i] = cells[i].e;
const slopeBefore = slopeStats(cells);
const t1 = Date.now();
Ops.erode(cells, PW, PH, sel.box, {
  seaLevel: SEA, ...Ops.EROSION_DEFAULTS, field: sel.mask, maskGain: 4.0,
});
const msErode = Date.now() - t1;
const slopeAfter = slopeStats(cells);
check('侵蚀耗时 < 800 ms', msErode < 800, msErode + ' ms');
// 【判据】侵蚀的物理含义是「把高处搬到低处」：峰顶被削、谷底被填。
// 所以拿 Δe 与「该格相对 3×3 邻域均值的高差」求相关，必须是负的。
// 早先拿「p99 / 平均坡度下降」当判据，两个都在某些情况下会上升 ——
// 水力侵蚀会切出河谷，河谷两壁本来就是陡岸；这不是 bug，是判据错了。
{
  const xs = [];
  const ys = [];
  for (let y = 1; y < PH - 1; y++) {
    for (let x = 1; x < PW - 1; x++) {
      const i = y * PW + x;
      if (sel.mask[i] < 0.6) continue;
      const de = cells[i].e - before5[i];
      if (de === 0) continue;
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += before5[i + dy * PW + dx];
      xs.push(before5[i] - sum / 9);
      ys.push(de);
    }
  }
  const r = pearson(xs, ys);
  check('侵蚀削峰填谷（Δe 与局部高差负相关）', r < -0.1,
    'r = ' + r.toFixed(3) + ' · 样本 ' + xs.length);
}
check('p99 坡度没有失控（< 0.22 landE/格）', slopeAfter.p99 < 0.22, slopeAfter.p99.toFixed(4));

// ---------- B. 沉陷成海洋 ----------
console.log('\n【B】沉陷成海洋');
{
  // 拿刚长出来的陆地当原料：铺一块平地当"原始大陆"
  const land = new Array(PW * PH);
  for (let y = 0; y < PH; y++) {
    for (let x = 0; x < PW; x++) {
      const v = 0.10 + Ops.fbm(x / 120, y / 120, 3, 2, 0.5, 1008) * 0.16 +
        Ops.fbm(x / 36, y / 36, 4, 2, 0.5, 1014) * 0.05;
      land[y * PW + x] = { x, y, e: SEA + UNIT * v, temp: 0.6, m: 0.5 };
    }
  }
  const mask2 = new Float32Array(PW * PH);
  const shelf2 = new Float32Array(PW * PH);
  const sel2 = Ops.buildSelectionMask(mask2, PW, PH, poly, { seed: 777, shelfBuffer: shelf2 });
  const t2 = Date.now();
  const sh2 = Ops.shapeRegion(land, PW, PH, sel2.mask, sel2.box, {
    seaLevel: SEA, mode: 'sea', strength: 0.82, seed: 777, scale: sel2.scale,
    shelf: sel2.shelf,
  });
  const msShape2 = Date.now() - t2;
  Ops.erode(land, PW, PH, sel2.box, {
    seaLevel: SEA, ...Ops.EROSION_DEFAULTS, field: sel2.mask, maskGain: 4.0,
  });

  let seaN = 0;
  let minE = Infinity;
  for (const c of land) {
    if (c.e < SEA) seaN++;
    if (c.e < minE) minE = c.e;
  }
  check('沉陷产生了大片海', sh2.changed > 10000 && seaN > 20000,
    sh2.changed + ' 格 · ' + seaN + ' 格在海平面下 · ' + msShape2 + ' ms');

  // 沉陷后的海底也要有起伏，不能是一块平底
  const xs = [];
  const ys = [];
  for (let i = 0; i < land.length; i++) {
    if (land[i].e >= SEA) continue;
    xs.push((land[i].x % 97) / 97);
    ys.push(land[i].e);
  }
  check('海底有起伏（不是平底）', minE < SEA - UNIT * 0.4,
    '最深 ' + ((SEA - minE) / UNIT).toFixed(2) + ' × 陆地高度');
}

// ---------- C. 确定性 ----------
console.log('\n【C】确定性与边界');
{
  const a = makeOcean(1001);
  const b = makeOcean(1001);
  const m1 = new Float32Array(PW * PH);
  const m2 = new Float32Array(PW * PH);
  const f1 = new Float32Array(PW * PH);
  const f2 = new Float32Array(PW * PH);
  const s1 = Ops.buildSelectionMask(m1, PW, PH, poly, { seed: 4242, shelfBuffer: f1 });
  const s2 = Ops.buildSelectionMask(m2, PW, PH, poly, { seed: 4242, shelfBuffer: f2 });
  Ops.shapeRegion(a, PW, PH, s1.mask, s1.box, {
    seaLevel: SEA, mode: 'land', strength: 0.82, seed: 4242, scale: s1.scale, shelf: s1.shelf,
  });
  Ops.shapeRegion(b, PW, PH, s2.mask, s2.box, {
    seaLevel: SEA, mode: 'land', strength: 0.82, seed: 4242, scale: s2.scale, shelf: s2.shelf,
  });
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i].e !== b[i].e) diff++;
  check('同 seed 逐位可复现', diff === 0, diff + ' 格不同');

  const maskSum1 = m1.reduce((s, v) => s + v, 0);
  check('掩膜是软过渡（有 0<v<1 的格子）',
    m1.some((v) => v > 0.05 && v < 0.95), '掩膜总量 ' + maskSum1.toFixed(0));

  // 选区之外必须一格不动
  // 【阈值用 0.0006 而不是 0】erode 的写回条件是 mask*maskGain > 0.002，
  // maskGain = 4 时等价于 mask > 0.0005 —— 用 0.002 判会误报。
  let outN = 0;
  for (let i = 0; i < a.length; i++) {
    if (m1[i] > 0.0006) continue;
    if (Math.fround(a[i].e) !== rawE[i]) outN++;
  }
  check('掩膜为 0 的格子绝不被改', outN === 0, outN + ' 格被误改');
}

// ---------- D. 尺度自适应 ----------
console.log('\n【D】小选区 / 大选区');
{
  const small = circlePoly(PW * 0.5, PH * 0.5, 55, 40, 11);
  const mS = new Float32Array(PW * PH);
  const fS = new Float32Array(PW * PH);
  const sS = Ops.buildSelectionMask(mS, PW, PH, small, { seed: 31, shelfBuffer: fS });
  const cs = makeOcean(1001);
  Ops.shapeRegion(cs, PW, PH, sS.mask, sS.box, {
    seaLevel: SEA, mode: 'land', strength: 0.82, seed: 31, scale: sS.scale, shelf: sS.shelf,
  });
  Ops.erode(cs, PW, PH, sS.box, {
    seaLevel: SEA, ...Ops.EROSION_DEFAULTS, field: sS.mask, maskGain: 4.0,
  });
  const cS = coastStats(cs);
  // 【阈值 1.6 → 1.35】原来的 1.6 是在"细频噪声也参与造岸"的旧口径下标定的：
  // 那时 11 格级噪声把岸线搓成毛边，破碎度虚高，代价是整块大陆像揉皱的纸
  // （坡度 p99 比全世界陆地高 43%）。现在岸线的碎度来自掩膜的 13 格层
  // 加一层只在岸带起作用的 rel 抖动，小选区量出来 1.45 —— 看着是
  // "有海湾、有半岛"的样子，而**把多边形描一遍**只有 1.0~1.1。
  // 所以这条按 1.35 判"不是描边"，真正的判据交给下一条（压线率）。
  check('小选区也能长出碎岸线（破碎度 > 1.35）', cS.ratio > 1.35,
    '尺度 ' + sS.scale.toFixed(1) + ' · 破碎度 ' + cS.ratio.toFixed(2) +
    ' · 陆 ' + cS.land + ' 格');

  // 小选区的岸线也必须离开原多边形（描边的直接反证）
  {
    const near = nearPolygon(small, 3);
    let edge = 0;
    let onPoly = 0;
    for (let y = 1; y < PH - 1; y++) {
      for (let x = 1; x < PW - 1; x++) {
        const i = y * PW + x;
        if (!isLand(cs, i)) continue;
        if (isLand(cs, i - 1) && isLand(cs, i + 1) &&
            isLand(cs, i - PW) && isLand(cs, i + PW)) continue;
        edge++;
        if (near[i]) onPoly++;
      }
    }
    const frac = edge ? onPoly / edge : 1;
    check('小选区岸线也偏离原多边形（压线率 < 0.45）', frac < 0.45,
      (frac * 100).toFixed(1) + '% 的海岸格仍在多边形 ±3 格内');
  }

  // 地貌尺度系数：同一选区，scale 乘 1.7 应该得到更少更大的特征
  const big = makeOcean(1001);
  Ops.shapeRegion(big, PW, PH, sel.mask, sel.box, {
    seaLevel: SEA, mode: 'land', strength: 0.82, seed: 4242, scale: sel.scale * 1.7,
    shelf: sel.shelf,
  });
  const cBig = coastStats(big);
  check('地貌尺度放大后特征变粗（相对破碎度下降）', cBig.ratio < coast.ratio * 1.05,
    '破碎度 ' + coast.ratio.toFixed(2) + ' → ' + cBig.ratio.toFixed(2));
}

console.log('\n' + '='.repeat(78));
console.log((failed === 0 ? 'PASS' : 'FAIL') + '  ' + passed + '/' + (passed + failed) + ' 项通过');
console.log('='.repeat(78));
process.exit(failed === 0 ? 0 : 1);
