#!/usr/bin/env node
/**
 * verify-editor.js —— 笔刷算子层的量化验证
 *
 * 【注意：这些算子在当前编辑器里**没有接线**】
 * 编辑器已经改成「选区塑形」（圈一块地 → 隆起成大陆 / 沉陷成海洋），
 * 见 verify-region.js。本脚本守的是 terrain-ops.js 里那批笔刷算子
 * （StrokeWalker / stampSegment / synthesize / smoothRegion）——
 * 它们仍被导出、仍可复用，所以仍然不能坏。
 *
 * 【为什么需要这个脚本】
 * 「地形看起来自然」很容易变成自我安慰：换个噪声、调个参数，看着好像好一点，
 * 但没有任何可复现的证据。这里把「自然」拆成 5 个可以算出来的量，
 * 并且同时跑一份「旧圆盘笔刷」作为对照基线 —— 数字不说话，改动就是瞎改。
 *
 * 指标定义：
 *   1. 各向异性比   = 垂直走向的平均坡度 / 沿走向的平均坡度
 *                    圆盘笔刷是各向同性 → ≈1；有走向的山脊应显著 > 1。
 *   2. 横截面不对称 = |左坡坡度 − 右坡坡度| / 两者均值
 *                    真实山体两侧坡度不同（断层崖 vs 缓坡），圆盘 = 0。
 *   3. 平顶率       = 抬升量 > 70% 峰值 的格子占受影响格子的比例
 *                    圆盘笔刷是一个平台（顶面等高）→ 高；山脊应低。
 *   4. 坡度上限     = 侵蚀后 99 分位坡度 / 最大坡度
 *                    热力侵蚀应把 99 分位压到休止角附近，消除垂直墙。
 *   5. 沟谷树状度   = 最大连通水系格数 / 高流量格总数
 *                    水力侵蚀生成树枝状谷网 → 连通度高；没侵蚀则趋近 0。
 *
 * 用法：node tools/verify-editor.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ==================== 加载被测模块 ====================

function loadOps() {
  const file = path.join(__dirname, '..', 'js', 'terrain-ops.js');
  const code = fs.readFileSync(file, 'utf8');
  if (typeof global.self === 'undefined') global.self = global;
  vm.runInThisContext(code, { filename: 'terrain-ops.js' });
  if (!global.FM || !global.FM.TerrainOps) throw new Error('FM.TerrainOps 未挂载');
  return global.FM.TerrainOps;
}

const Ops = loadOps();

// ==================== 测试场景 ====================

const W = 480;
const H = 360;
const SEA = 0.32;

/** 造一块平地（e = base） */
function flatCells(base) {
  const cells = new Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      cells[y * W + x] = { x, y, e: base, temp: 0.6, m: 0.5, isRiver: false, isLake: false };
    }
  }
  return cells;
}

function snapshot(cells) {
  const arr = new Float32Array(cells.length);
  for (let i = 0; i < cells.length; i++) arr[i] = cells[i].e;
  return arr;
}

// ==================== 指标计算 ====================

/** 统计工具：返回分位数 */
function percentiles(values, qs) {
  const arr = Array.from(values).sort((a, b) => a - b);
  const out = {};
  for (const q of qs) {
    const idx = Math.min(arr.length - 1, Math.max(0, Math.round((arr.length - 1) * q)));
    out['p' + Math.round(q * 100)] = arr[idx];
  }
  return out;
}

/**
 * 1+2. 各向异性与横截面不对称
 *
 * 笔迹沿 +X 方向铺在中线上。于是：
 *   · 沿走向的坡度 = |∂e/∂x|（山脊上应该很小，脊线是连续的）
 *   · 垂直走向的坡度 = |∂e/∂y|（横穿山脊，应该很大）
 * 只统计「受影响格子」（Δe 显著大于 0 的那些），否则整片平地会稀释信号。
 *
 * axisAngle 用于套索场景：山链可能被 PCA 转到任意方向，
 * 若仍按固定的 x/y 取梯度，30° 的脊会被两个轴各分掉一部分，
 * 各向异性比会被系统性低估（实测 1.58 → 1.11）。所以这里把梯度
 * 旋到「沿轴 / 垂直轴」的方向再比较。
 */
function anisotropyMetrics(cells, base, box, amp, axisAngle) {
  const ca = Math.cos(axisAngle || 0);
  const sa = Math.sin(axisAngle || 0);
  let sumAlong = 0;
  let sumAcross = 0;
  let n = 0;
  const cy = (box.y0 + box.y1) / 2;
  let leftSlope = 0;
  let leftN = 0;
  let rightSlope = 0;
  let rightN = 0;

  for (let y = box.y0 + 1; y < box.y1; y++) {
    for (let x = box.x0 + 1; x < box.x1; x++) {
      const i = y * W + x;
      const d = cells[i].e - base;
      if (d < amp * 0.12) continue;   // 只看山体主体，排除边缘毛刺
      const gx = (cells[i + 1].e - cells[i - 1].e) * 0.5;
      const gy = (cells[i + W].e - cells[i - W].e) * 0.5;
      // 旋转到主轴坐标系
      const along = Math.abs(gx * ca + gy * sa);
      const across = Math.abs(-gx * sa + gy * ca);
      sumAlong += along;
      sumAcross += across;
      n++;
      if (y < cy - 3) { leftSlope += across; leftN++; }
      else if (y > cy + 3) { rightSlope += across; rightN++; }
    }
  }
  if (n === 0) return { anisotropy: 0, asymmetry: 0, samples: 0 };
  const L = leftN ? leftSlope / leftN : 0;
  const R = rightN ? rightSlope / rightN : 0;
  return {
    anisotropy: sumAlong > 1e-9 ? sumAcross / sumAlong : 0,
    asymmetry: (L + R) > 1e-9 ? Math.abs(L - R) / ((L + R) / 2) : 0,
    samples: n,
  };
}

/** 3. 平顶率：抬升量接近峰值的格子占比 */
function plateauRatio(cells, base, box, amp) {
  let peak = 0;
  for (let y = box.y0; y <= box.y1; y++) {
    for (let x = box.x0; x <= box.x1; x++) {
      const d = cells[y * W + x].e - base;
      if (d > peak) peak = d;
    }
  }
  if (peak < 1e-6) return { plateau: 0, peak: 0 };
  let affected = 0;
  let flat = 0;
  for (let y = box.y0; y <= box.y1; y++) {
    for (let x = box.x0; x <= box.x1; x++) {
      const d = cells[y * W + x].e - base;
      if (d < peak * 0.05) continue;
      affected++;
      if (d > peak * 0.7) flat++;
    }
  }
  return { plateau: affected ? flat / affected : 0, peak };
}

/** 4. 坡度分位（每格到 4 邻域的最大高差） */
function slopeStats(cells, box) {
  const arr = [];
  for (let y = Math.max(1, box.y0); y <= Math.min(H - 2, box.y1); y++) {
    for (let x = Math.max(1, box.x0); x <= Math.min(W - 2, box.x1); x++) {
      const i = y * W + x;
      const e = cells[i].e;
      const s = Math.max(
        Math.abs(e - cells[i - 1].e),
        Math.abs(e - cells[i + 1].e),
        Math.abs(e - cells[i - W].e),
        Math.abs(e - cells[i + W].e)
      );
      arr.push(s);
    }
  }
  const q = percentiles(arr, [0.5, 0.9, 0.99, 1]);
  return { p50: q.p50, p90: q.p90, p99: q.p99, max: q.p100 };
}

/**
 * 5. 沟谷指标
 *
 * 原来想用「水系连通度」衡量树状谷网，但在**山脊**场景下这个指标是错的：
 * 山脊本来就向两侧散水，不会汇成一条主干，连通度天然接近 0。
 *
 * 改用「河道下切度」：高流量格子的平均拉普拉斯量（邻域均值 − 自身高度）。
 *   · 河道是**凹**形 → 邻域比自身高 → 正值；
 *   · 平滑山体上的高流量格只是"顺坡往下"的位置，不凹 → 接近 0。
 * 比较侵蚀前后这一个数，就能直接判断水力侵蚀有没有真的切出沟谷。
 */
function drainageMetrics(cells, box) {
  const x0 = Math.max(1, box.x0);
  const x1 = Math.min(W - 2, box.x1);
  const y0 = Math.max(1, box.y0);
  const y1 = Math.min(H - 2, box.y1);
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  const n = bw * bh;
  if (n < 64) return { incision: 0, channels: 0, tree: 0 };

  const DX = [1, 1, 0, -1, -1, -1, 0, 1];
  const DY = [0, 1, 1, 1, 0, -1, -1, -1];
  const down = new Int32Array(n).fill(-1);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const i = y * bw + x;
      const e = cells[(y0 + y) * W + x0 + x].e;
      let best = -1;
      let bestH = e;
      for (let k = 0; k < 8; k++) {
        const nx = x + DX[k];
        const ny = y + DY[k];
        if (nx < 0 || nx >= bw || ny < 0 || ny >= bh) continue;
        const j = ny * bw + nx;
        const eh = cells[(y0 + ny) * W + x0 + nx].e;
        if (eh < bestH) { bestH = eh; best = j; }
      }
      down[i] = best;
    }
  }
  const order = Array.from({ length: n }, (_, i) => i);
  order.sort((a, b) => {
    const ea = cells[(y0 + ((a / bw) | 0)) * W + x0 + (a % bw)].e;
    const eb = cells[(y0 + ((b / bw) | 0)) * W + x0 + (b % bw)].e;
    return eb - ea;
  });
  const flow = new Float32Array(n).fill(1);
  for (const i of order) {
    const d = down[i];
    if (d >= 0) flow[d] += flow[i];
  }
  let sum = 0;
  for (let i = 0; i < n; i++) sum += flow[i];
  const th = (sum / n) * 6;

  // 【为什么还要一个「前 1% 流量」门槛】th = 6×平均流量 选出来的是一大片
  // 坡面格子（几百到几千个），它们只是"顺坡往下"的位置，本身并不凹；
  // 拿它们的平均拉普拉斯当「河床下切度」，会把真正的沟底信号稀释掉。
  // 前 1% 的格子才是主河道 / 沟底，那里才有"比四周低"的凹形。
  const sortedFlow = Float32Array.from(flow);
  sortedFlow.sort();
  const thTop = sortedFlow[Math.floor(n * 0.99)];

  const measure = (threshold) => {
    let lapSum2 = 0;
    let cnt = 0;
    for (let y = 1; y < bh - 1; y++) {
      for (let x = 1; x < bw - 1; x++) {
        const i = y * bw + x;
        if (flow[i] <= threshold) continue;
        const c = cells[(y0 + y) * W + x0 + x].e;
        const lap = (
          cells[(y0 + y) * W + x0 + x - 1].e +
          cells[(y0 + y) * W + x0 + x + 1].e +
          cells[(y0 + y - 1) * W + x0 + x].e +
          cells[(y0 + y + 1) * W + x0 + x].e
        ) / 4 - c;
        lapSum2 += lap;
        cnt++;
      }
    }
    return { v: cnt ? lapSum2 / cnt : 0, n: cnt };
  };

  const wide = measure(th);
  const top = measure(thTop);

  // 树状度保留作为参考（山脊场景下本就偏低，不参与判定）
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (a) => {
    while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
    return a;
  };
  const isCh = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (flow[i] > th) isCh[i] = 1;
  for (let i = 0; i < n; i++) {
    if (!isCh[i]) continue;
    const d = down[i];
    if (d >= 0 && isCh[d]) {
      const ra = find(i);
      const rb = find(d);
      if (ra !== rb) parent[rb] = ra;
    }
  }
  const sizes = new Map();
  for (let i = 0; i < n; i++) {
    if (!isCh[i]) continue;
    const r = find(i);
    sizes.set(r, (sizes.get(r) || 0) + 1);
  }
  let big = 0;
  for (const v of sizes.values()) if (v > big) big = v;

  return {
    // 宽口径（6×平均流量）：参考值
    incision: wide.v,
    channels: wide.n,
    // 窄口径（前 1% 流量）：真正的沟底，判定用它
    incisionTop: top.v,
    channelsTop: top.n,
    tree: wide.n ? big / wide.n : 0,
  };
}

// ==================== 对照：旧圆盘笔刷 ====================

/**
 * 旧实现的核心：圆心距离 → smoothstep 衰减 → 乘 ridged 系数。
 * 这里用纯锥形（smoothstep）近似，因为旧版的噪声项只让边缘"抖动"，
 * 不改变「横截面是对称圆弧、顶面是平台」这个本质。
 */
function oldDiscBrush(cells, cx, cy, radius, amp) {
  const box = {
    x0: Math.max(0, Math.floor(cx - radius)),
    y0: Math.max(0, Math.floor(cy - radius)),
    x1: Math.min(W - 1, Math.ceil(cx + radius)),
    y1: Math.min(H - 1, Math.ceil(cy + radius)),
  };
  for (let y = box.y0; y <= box.y1; y++) {
    for (let x = box.x0; x <= box.x1; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > radius) continue;
      let t = 1 - d / radius;
      t = t * t * (3 - 2 * t);
      cells[y * W + x].e += t * amp;
    }
  }
  return box;
}

// ==================== 场景 1：直线笔画 ====================

function runStroke({ radius, strength, erodeIters, hydraulicIters }) {
  const base = 0.5;
  const cells = flatCells(base);
  const amp = Ops.amplitudeFor(strength, radius, SEA);

  // 一条水平笔画，从左到右
  const x0 = 120;
  const x1 = 360;
  const cy = 180;
  const walker = new Ops.StrokeWalker(radius * Ops.NODE_SPACING_RATIO);
  walker.begin(x0, cy);
  for (let x = x0; x <= x1; x += 1) walker.advance(x, cy);
  const nodes = walker.nodes;

  const field = new Float32Array(W * H);
  const built = Ops.buildStrokeField(field, W, H, nodes, { radius, seed: 12345, spurs: true });
  const box = built.box;
  const synth = Ops.synthesize(cells, W, H, {
    field, box, mode: 'raise', amp, seaLevel: SEA, seed: 12345,
    detailScale: 0.26, dirX: built.dirX, dirY: built.dirY,
  });

  // 侵蚀前的高度快照，用来量化「质量从高处搬到低处」
  const hBefore = cells.map((c) => c.e);

  const beforeErode = {
    aniso: anisotropyMetrics(cells, base, synth.box, amp),
    plateau: plateauRatio(cells, base, synth.box, amp),
    slope: slopeStats(cells, synth.box),
    drainage: drainageMetrics(cells, synth.box),
    changed: synth.changed,
    maxDelta: synth.maxDelta,
  };

  let erodeMs = 0;
  if (erodeIters !== 0) {
    // 用**实际生效的**那套参数（EROSION_DEFAULTS），否则测的是另一套数字
    const eOpt = { seaLevel: SEA, ...Ops.EROSION_DEFAULTS };
    if (hydraulicIters != null) eOpt.hydraulicIters = hydraulicIters;
    const r = Ops.erode(cells, W, H, synth.box, eOpt);
    erodeMs = r.ms || 0;
  }

  // ---- 质量再分配：Δe 与 (e − 均值) 的相关系数 ----
  // 侵蚀的本质是「高处削、低处堆」：陡的地方掉得快、洼的地方堆起来。
  // 因此 Δe 必然与 「自身高度 − 区域均值」负相关 —— 这一条是能量守恒的
  // 直接推论，不依赖任何噪声实现，比某个统计量的数值涨跌稳健得多。
  let transport = 0;
  {
    const xs = []; const ys = [];
    for (let y = Math.max(0, synth.box.y0); y <= Math.min(H - 1, synth.box.y1); y++) {
      for (let x = Math.max(0, synth.box.x0); x <= Math.min(W - 1, synth.box.x1); x++) {
        const i = y * W + x;
        if (hBefore[i] < SEA) continue;
        xs.push(hBefore[i]);
        ys.push(cells[i].e - hBefore[i]);
      }
    }
    const n2 = xs.length;
    if (n2 > 16) {
      let mx = 0; let my = 0;
      for (let k = 0; k < n2; k++) { mx += xs[k]; my += ys[k]; }
      mx /= n2; my /= n2;
      let sxy = 0; let sxx = 0; let syy = 0;
      for (let k = 0; k < n2; k++) {
        const dx = xs[k] - mx; const dy = ys[k] - my;
        sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
      }
      transport = sxx > 1e-12 && syy > 1e-12 ? sxy / Math.sqrt(sxx * syy) : 0;
    }
  }

  const afterErode = {
    aniso: anisotropyMetrics(cells, base, synth.box, amp),
    plateau: plateauRatio(cells, base, synth.box, amp),
    slope: slopeStats(cells, synth.box),
    drainage: drainageMetrics(cells, synth.box),
    transport,
  };

  return { nodes, amp, beforeErode, afterErode, erodeMs, box: synth.box, field };
}

// ==================== 场景 2：旧笔刷对照 ====================

function runOldDisc({ radius, strength }) {
  const base = 0.5;
  const cells = flatCells(base);
  const amp = strength * 1.35;
  const box = oldDiscBrush(cells, 240, 180, radius, amp * 3);
  // 旧笔刷是一团，没有"沿走向"可言，用它的等效长短轴比来算各向异性
  return {
    amp,
    aniso: anisotropyMetrics(cells, base, box, amp),
    plateau: plateauRatio(cells, base, box, amp),
    slope: slopeStats(cells, box),
    drainage: drainageMetrics(cells, box),
    box,
  };
}

// ==================== 场景 3：事件频率无关性 ====================

/**
 * 【这个测试要验证什么】
 * 旧实现里「快速拖动」和「慢速拖动」会得到不同地形，因为抬升量按
 * pointermove 次数累加。改成「等弧长节点」之后，节点位置只由笔迹几何
 * 决定，与上报频率无关。
 *
 * 测试分三段，刻意区分「实现问题」和「输入几何问题」：
 *
 *   A. 直线：密集点与稀疏点描述的是**同一条**线段，节点必须逐位一致。
 *   B. 同一条折线、不同的上报密度：把折线按 <1 格插值成密集点列，
 *      每个插值点都落在原线段上 —— 几何完全相同，只有「一次 advance
 *      走了多远」不同。这是对 walker 的严格检验，必须逐位一致。
 *   C. （参考项）沿曲线采样的稀疏点：弦切掉了弧，几何本身就变了，
 *      差异是输入造成的，不是实现造成的。不参与判定。
 */
function runFrequencyTest(radius) {
  const spacing = radius * Ops.NODE_SPACING_RATIO;
  const walk = (pts) => {
    const w = new Ops.StrokeWalker(spacing);
    w.begin(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) w.advance(pts[i].x, pts[i].y);
    return w.nodes;
  };
  const fieldOf = (nodes) => {
    const f = new Float32Array(W * H);
    Ops.buildStrokeField(f, W, H, nodes, { radius, seed: 777, spurs: true });
    return f;
  };
  const diffOf = (a, b) => {
    let maxDiff = 0;
    for (let i = 0; i < a.length; i++) {
      const d = Math.abs(a[i] - b[i]);
      if (d > maxDiff) maxDiff = d;
    }
    return maxDiff;
  };

  // A. 直线
  const lineDense = [];
  for (let x = 100; x <= 380; x += 0.5) lineDense.push({ x, y: 200 });
  lineDense.push({ x: 380, y: 200 });
  const lineSparse = [{ x: 100, y: 200 }, { x: 380, y: 200 }];
  const nA = walk(lineDense);
  const nB = walk(lineSparse);
  const straightDiff = diffOf(fieldOf(nA), fieldOf(nB));

  // B. 同一条折线，插值成密集点（点都在弦上，几何不变）
  const verts = [];
  for (let x = 100; x <= 380; x += 9) verts.push({ x, y: 180 + Math.sin((x - 100) / 48) * 8 });
  verts.push({ x: 380, y: 180 + Math.sin((280) / 48) * 8 });
  const interpolated = [verts[0]];
  for (let i = 1; i < verts.length; i++) {
    const a = verts[i - 1];
    const b = verts[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(len / 0.5));
    for (let k = 1; k <= n; k++) {
      interpolated.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
    }
  }
  const nC = walk(verts);
  const nD = walk(interpolated);
  const batchingDiff = diffOf(fieldOf(nC), fieldOf(nD));

  // C. 参考：沿曲线采样（几何本身不同）
  const curvePts = (step) => {
    const pts = [];
    for (let x = 100; x <= 380; x += step) pts.push({ x, y: 180 + Math.sin((x - 100) / 48) * 8 });
    return pts;
  };
  const curveDiff = diffOf(fieldOf(walk(curvePts(0.5))), fieldOf(walk(curvePts(9))));

  return {
    spacing: +spacing.toFixed(2),
    straightNodes: nA.length + ' / ' + nB.length,
    straightDiff: +straightDiff.toFixed(7),
    batchNodes: nC.length + ' / ' + nD.length,
    batchingDiff: +batchingDiff.toFixed(7),
    curveNodes: walk(curvePts(0.5)).length + ' / ' + walk(curvePts(9)).length,
    curveDiff: +curveDiff.toFixed(5),
  };
}

// ==================== 场景 4：套索 ====================

function runLasso() {
  const base = 0.5;
  const cells = flatCells(base);
  const radius = 56;
  const amp = Ops.amplitudeFor(0.26, radius, SEA);

  // 一个长椭圆选区（长轴倾斜 30°，用来检验 PCA 主轴）
  const poly = [];
  const cxp = 240;
  const cyp = 180;
  const rx = 110;
  const ry = 46;
  const theta = (30 * Math.PI) / 180;
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2;
    const x = Math.cos(a) * rx;
    const y = Math.sin(a) * ry;
    poly.push({
      x: cxp + x * Math.cos(theta) - y * Math.sin(theta),
      y: cyp + x * Math.sin(theta) + y * Math.cos(theta),
    });
  }

  const field = new Float32Array(W * H);
  const maskBuf = new Float32Array(W * H);
  const built = Ops.buildLassoField(field, W, H, poly, {
    radius, seed: 4242, mode: 'mountain', maskBuffer: maskBuf,
  });
  if (!built.box) return null;

  Ops.synthesize(cells, W, H, {
    field, box: built.box, mode: 'raise', amp, seaLevel: SEA, seed: 4242,
    detailScale: 0.22, dirX: built.dirX, dirY: built.dirY,
  });
  Ops.erode(cells, W, H, built.box, { seaLevel: SEA, ...Ops.EROSION_DEFAULTS });

  // 主轴：PCA 结果（buildLassoField 直接返回），以及山链实际弦向
  const pcaAngle = (Math.atan2(built.dirY, built.dirX) * 180) / Math.PI;
  const nodeDx = built.nodes[built.nodes.length - 1].x - built.nodes[0].x;
  const nodeDy = built.nodes[built.nodes.length - 1].y - built.nodes[0].y;
  const chainAngle = (Math.atan2(nodeDy, nodeDx) * 180) / Math.PI;
  const fold = (a) => {
    let v = ((a % 180) + 180) % 180;
    if (v > 90) v -= 180;
    return v;
  };
  const pcaError = Math.abs(fold(pcaAngle) - 30);
  // 山链带弯曲（弦比轴短），偏差应在 8° 以内
  const chainError = Math.abs(fold(chainAngle) - 30);

  const aniso = anisotropyMetrics(cells, base, built.box, amp, (pcaAngle * Math.PI) / 180);
  const slope = slopeStats(cells, built.box);
  const plateau = plateauRatio(cells, base, built.box, amp);
  const drainage = drainageMetrics(cells, built.box);

  // 掩膜是否在边界处软化（硬掩膜会在贴边处留一圈 0 与 1 的跳变）
  let hardEdges = 0;
  for (let y = built.box.y0 + 1; y < built.box.y1; y++) {
    for (let x = built.box.x0 + 1; x < built.box.x1; x++) {
      const i = y * W + x;
      const m = maskBuf[i];
      if (m > 0.02 && m < 0.98) hardEdges++;
    }
  }
  let insideCount = 0;
  for (let y = built.box.y0; y <= built.box.y1; y++) {
    for (let x = built.box.x0; x <= built.box.x1; x++) {
      if (maskBuf[y * W + x] > 0.02) insideCount++;
    }
  }

  return {
    nodes: built.nodes.length,
    pcaAngle: +fold(pcaAngle).toFixed(1),
    pcaError: +pcaError.toFixed(1),
    chainAngle: +fold(chainAngle).toFixed(1),
    chainError: +chainError.toFixed(1),
    aniso: aniso.anisotropy,
    asymmetry: aniso.asymmetry,
    slope,
    plateau: plateau.plateau,
    drainage,
    maskTransitionRatio: insideCount ? +(hardEdges / insideCount).toFixed(3) : 0,
  };
}

// ==================== 输出 ====================

const fmt = (v, d = 3) => (typeof v === 'number' ? v.toFixed(d) : String(v));
const pad = (s, n) => String(s).padEnd(n);

const main = { radius: 56, strength: 0.26 };

console.log('='.repeat(78));
console.log('编辑器自然度验证  网格 ' + W + '×' + H + '  海平面 ' + SEA);
console.log('='.repeat(78));

const oldR = runOldDisc(main);
const newR = runStroke({ radius: main.radius, strength: main.strength, erodeIters: 6 });
const rawR = runStroke({ radius: main.radius, strength: main.strength, erodeIters: 0 });
// 【对照：只做热力侵蚀】比较「全侵蚀」与「只有热力」才能隔离出水力侵蚀的贡献 ——
// 直接拿「无侵蚀」当基线是不成立的：合成场本身就带着噪声凹坑，
// 热力侵蚀把它们抹平（负贡献）与水力切出沟谷（正贡献）混在一起，正负抵消。
const thermalR = runStroke({ radius: main.radius, strength: main.strength, erodeIters: 6, hydraulicIters: 0 });

console.log('\n【1】各向异性比（垂直走向坡度 / 沿走向坡度，越大越像"山脊"）');
console.log('  旧圆盘笔刷      ' + fmt(oldR.aniso.anisotropy, 2));
console.log('  新笔刷·未侵蚀   ' + fmt(rawR.beforeErode.aniso.anisotropy, 2));
console.log('  新笔刷·侵蚀后   ' + fmt(newR.afterErode.aniso.anisotropy, 2));

console.log('\n【2】横截面不对称度（左右坡坡度差 / 均值，越大越像真实山体）');
console.log('  旧圆盘笔刷      ' + fmt(oldR.aniso.asymmetry, 3));
console.log('  新笔刷·侵蚀后   ' + fmt(newR.afterErode.aniso.asymmetry, 3));

console.log('\n【3】平顶率（抬升量 > 70% 峰值 的格子占比，越低越不像"平台"）');
console.log('  旧圆盘笔刷      ' + fmt(oldR.plateau.plateau, 3) + '   峰值 ' + fmt(oldR.plateau.peak));
console.log('  新笔刷·未侵蚀   ' + fmt(rawR.beforeErode.plateau.plateau, 3) + '   峰值 ' + fmt(rawR.beforeErode.plateau.peak));
console.log('  新笔刷·侵蚀后   ' + fmt(newR.afterErode.plateau.plateau, 3) + '   峰值 ' + fmt(newR.afterErode.plateau.peak));

console.log('\n【4】坡度分位（热力侵蚀应把 p99 压到休止角附近，消除垂直墙）');
console.log(pad('', 16) + pad('p50', 10) + pad('p90', 10) + pad('p99', 10) + 'max');
const rowSlope = (label, s) =>
  console.log(pad(label, 16) + pad(fmt(s.p50, 4), 10) + pad(fmt(s.p90, 4), 10) +
    pad(fmt(s.p99, 4), 10) + fmt(s.max, 4));
rowSlope('旧圆盘', oldR.slope);
rowSlope('新·未侵蚀', rawR.beforeErode.slope);
rowSlope('新·侵蚀后', newR.afterErode.slope);

console.log('\n【5】沟谷下切度（高流量格的平均拉普拉斯，正值 = 河床凹形）');
console.log('  旧圆盘笔刷      ' + fmt(oldR.drainage.incision, 5) + '   河道格 ' + oldR.drainage.channels);
console.log('  新笔刷·未侵蚀   ' + fmt(rawR.beforeErode.drainage.incision, 5) + '   河道格 ' + rawR.beforeErode.drainage.channels);
console.log('  新笔刷·侵蚀后   ' + fmt(newR.afterErode.drainage.incision, 5) + '   河道格 ' + newR.afterErode.drainage.channels);
console.log('  —— 只看流量前 1% 的沟底（判定依据）——');
console.log('  未侵蚀        ' + fmt(rawR.beforeErode.drainage.incisionTop, 5) + '   沟底格 ' + rawR.beforeErode.drainage.channelsTop);
console.log('  只热力侵蚀    ' + fmt(thermalR.afterErode.drainage.incisionTop, 5) + '   沟底格 ' + thermalR.afterErode.drainage.channelsTop + '   ← 基线（判定用）');
console.log('  热力+水力     ' + fmt(newR.afterErode.drainage.incisionTop, 5) + '   沟底格 ' + newR.afterErode.drainage.channelsTop);
console.log('  （说明：基线要用「只热力侵蚀」而不是「未侵蚀」—— 合成场本身带着');
console.log('    噪声凹坑，热力侵蚀把它们抹平是负贡献、水力切沟是正贡献，');
console.log('    拿未侵蚀当基线会把两者混在一起。）');
console.log('\n【5b】质量再分配（Δe 与「自身高度」的相关系数，负值 = 高处削、低处填）');
console.log('  只热力侵蚀    ' + thermalR.afterErode.transport.toFixed(3));
console.log('  热力+水力     ' + newR.afterErode.transport.toFixed(3));
console.log('  （参考：树状连通度 旧 ' + fmt(oldR.drainage.tree, 2) +
  ' / 新 ' + fmt(newR.afterErode.drainage.tree, 2) + '，山脊场景下本就偏低）');

const freq = runFrequencyTest(main.radius);
console.log('\n【6】事件频率无关性（等弧长节点 → 快拖慢拖应等价）');
console.log('  节点间距          ' + freq.spacing + ' 格');
console.log('  A 直线 节点数     ' + freq.straightNodes + '   强度场差 ' + freq.straightDiff);
console.log('  B 同一折线不同上报密度  节点数 ' + freq.batchNodes + '   强度场差 ' + freq.batchingDiff);
console.log('  C 参考：沿曲线稀疏采样  节点数 ' + freq.curveNodes + '   强度场差 ' + freq.curveDiff);
console.log('     （C 的差异来自弦切弧 —— 输入几何变了，不是实现问题）');

const lasso = runLasso();
console.log('\n【7】套索：主轴识别与掩膜软化');
if (!lasso) {
  console.log('  ❌ 套索场构建失败');
} else {
  console.log('  PCA 主轴 30°    实测 ' + lasso.pcaAngle + '°（误差 ' + lasso.pcaError + '°）');
  console.log('  山链弦向        ' + lasso.chainAngle + '°（弯曲导致 ' + lasso.chainError + '° 偏差，正常）');
  console.log('  各向异性比      ' + fmt(lasso.aniso, 2));
  console.log('  横截面不对称度  ' + fmt(lasso.asymmetry, 3));
  console.log('  平顶率          ' + fmt(lasso.plateau, 3));
  console.log('  沟谷下切度      ' + fmt(lasso.drainage.incision, 5));
  console.log('  掩膜过渡带占比  ' + lasso.maskTransitionRatio + '（0 = 硬边，>0.05 = 有软化）');
}

console.log('\n【8】耗时');
console.log('  侵蚀 6+3 轮     ' + fmt(newR.erodeMs, 0) + ' ms（区域 ' +
  (newR.box.x1 - newR.box.x0 + 1) + '×' + (newR.box.y1 - newR.box.y0 + 1) + '）');

// ==================== 判定 ====================

const checks = [
  ['各向异性比 > 1.4（有走向）', newR.afterErode.aniso.anisotropy > 1.4, fmt(newR.afterErode.aniso.anisotropy, 2)],
  ['横截面不对称 > 0.05', newR.afterErode.aniso.asymmetry > 0.05, fmt(newR.afterErode.aniso.asymmetry, 3)],
  ['平顶率 < 0.35（不是平台）', newR.afterErode.plateau.plateau < 0.35, fmt(newR.afterErode.plateau.plateau, 3)],
  ['侵蚀后 p99 坡度 < 未侵蚀 p99', newR.afterErode.slope.p99 < rawR.beforeErode.slope.p99, fmt(newR.afterErode.slope.p99, 4)],
  ['水力侵蚀切出沟底（对比只热力 +3%）', newR.afterErode.drainage.incisionTop > thermalR.afterErode.drainage.incisionTop * 1.03,
    fmt(newR.afterErode.drainage.incisionTop, 5) + ' vs ' + fmt(thermalR.afterErode.drainage.incisionTop, 5)],
  ['侵蚀把质量从高处搬到低处（相关 < -0.10）', newR.afterErode.transport < -0.10,
    newR.afterErode.transport.toFixed(3)],
  ['直线采样差异 < 1e-4', freq.straightDiff < 1e-4, String(freq.straightDiff)],
  ['上报密度差异 < 1e-4', freq.batchingDiff < 1e-4, String(freq.batchingDiff)],
  ['套索 PCA 主轴误差 < 3°', lasso && lasso.pcaError < 3, lasso ? lasso.pcaError + '°' : 'n/a'],
  ['套索山链弦向误差 < 8°', lasso && lasso.chainError < 8, lasso ? lasso.chainError + '°' : 'n/a'],
  ['套索各向异性 > 1.4', lasso && lasso.aniso > 1.4, lasso ? fmt(lasso.aniso, 2) : 'n/a'],
  ['侵蚀耗时 < 400 ms', newR.erodeMs < 400, fmt(newR.erodeMs, 0) + ' ms'],
];

console.log('\n' + '='.repeat(78));
let pass = 0;
for (const [name, ok, value] of checks) {
  console.log((ok ? '  ✅ ' : '  ❌ ') + pad(name, 34) + value);
  if (ok) pass++;
}
console.log('='.repeat(78));
console.log((pass === checks.length ? 'PASS' : 'FAIL') + '  ' + pass + '/' + checks.length + ' 项通过');
process.exit(pass === checks.length ? 0 : 1);
