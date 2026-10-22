#!/usr/bin/env node
/**
 * verify-climate.js —— 气候系统的「自然度」判据
 *
 * 【为什么需要这个脚本】
 * 用户的原话是「气候很不自然啊」。这句话无法直接执行 —— 必须拆成
 * 一组可以量的东西。这一轮把「不自然」拆成十项判据，每一项都对应
 * 一种**具体的、在图上能看出来的病**：
 *
 *   1. 发丝指数        降水/温度场的高频能量（|v−3×3均值| ÷ sd）。
 *                      过大 = 气候图上爬满 1 格宽的细丝。
 *   2. 斑块尺度        同群系 4-连通块的中位面积。
 *                      过小 = 群系碎成「迷彩服」。
 *   3. 孤立碎点率      四邻全不同群系的陆地格占比。直接量「噪点」。
 *   4. 纬向条带指数    ±N 格处「上下同群系率 ÷ 左右同群系率」。
 *                      ≫1 = 群系被拉成横贯全图的条带；≪1 = 拉成经向条带。
 *   5. 南北对称性      同纬度带南北半球陆地平均海平面等效温度的差。
 *                      过大 = 半球被陆地面积差异带偏（旧 bug 只有单向降温项）。
 *   6. 分带顺序        赤道/副热带/亚寒带/极地四带的主导群系是否正确。
 *                      这一项抓「60° 长沙漠、赤道长苔原」这类错位。
 *   7. 垂直分带不越界  中低纬（|lat|<40°）的冰雪占比必须很小。
 *                      旧 bug：气温直减率把中纬高山压到极地温度，
 *                      于是 50° 出现大片冰盖。
 *   8. 降水—距海关系   相关系数必须明显为负（内陆干）。
 *   9. 分位分布受控    降水 p05/p50/p95 落在目标区间内。
 *                      「整图一片绿 / 整图一片沙」都是这一项越界。
 *  10. 场平滑度        相邻行均值的最大跳变。抓「横向截段」。
 *
 * 用法：node tools/verify-climate.js [seed]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const W = 800;
const H = 400;

// ==================== 假 DOM ====================

function makeFakeCtx(canvas) {
  const noop = () => {};
  const ctx = { canvas, fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1 };
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
    'js/map-generator.js',
  ]) {
    vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });
  }
  return globalThis.FM;
}

// ==================== 判据工具 ====================

let passed = 0;
let failed = 0;
let skipped = 0;
function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log('  ✅ ' + name + (detail ? '   ' + detail : ''));
  } else {
    failed++;
    console.log('  ❌ ' + name + (detail ? '   ' + detail : ''));
  }
}
/**
 * 样本不足时跳过，而不是判失败。
 *
 * 【为什么需要这个】有些种子在某个纬度带几乎没有陆地 —— 实测 theta
 * 在 60~70° 两个半球合计 0 格、35~55° 只有 66 格。此时「这一带的群系
 * 对不对」根本无法判断，报失败只会误导读代码的人（输出会是
 * 「温带不是阔叶林 0%」，看起来像气候坏了，其实是没有陆地）。
 * 跳过时会打印格数，谁都能看出这是抽样问题而不是性质问题。
 */
function skip(name, detail) {
  skipped++;
  console.log('  ⏭ ' + name + '   ' + detail + ' —— 样本不足，本 seed 跳过');
}
function section(t) { console.log('\n' + t); }

/** 高频能量：|v − 3×3 陆地均值| ÷ sd。平滑场 ≈ 0.01~0.06；细丝/斑点 > 0.15 */
function filamentIdx(cells, W_, H_, sea, get) {
  let sumDev = 0;
  let n = 0;
  let s1 = 0;
  let s2 = 0;
  for (let y = 1; y < H_ - 1; y++) {
    for (let x = 0; x < W_; x++) {
      const i = y * W_ + x;
      if (cells[i].e < sea) continue;
      let s = 0;
      let c = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const j = (y + dy) * W_ + ((x + dx + W_) % W_);
          if (cells[j].e < sea) continue;
          s += get(cells[j]);
          c++;
        }
      }
      if (c < 5) continue;
      const v = get(cells[i]);
      sumDev += Math.abs(v - s / c);
      s1 += v;
      s2 += v * v;
      n++;
    }
  }
  if (n < 100) return 0;
  const mean = s1 / n;
  const sd = Math.sqrt(Math.max(1e-9, s2 / n - mean * mean));
  return (sumDev / n) / sd;
}

/** 群系斑块（4-连通）面积分布 */
function blobStats(cells, W_, H_, sea) {
  const seen = new Uint8Array(W_ * H_);
  const stack = new Int32Array(W_ * H_);
  const sizes = [];
  for (let y0 = 1; y0 < H_ - 1; y0++) {
    for (let x0 = 0; x0 < W_; x0++) {
      const i0 = y0 * W_ + x0;
      if (seen[i0] || cells[i0].e < sea) continue;
      const key = cells[i0].biome;
      let sp = 0;
      stack[sp++] = i0;
      seen[i0] = 1;
      let size = 0;
      while (sp > 0) {
        const i = stack[--sp];
        size++;
        const x = i % W_;
        const y = (i / W_) | 0;
        const nb = [
          y * W_ + ((x - 1 + W_) % W_), y * W_ + ((x + 1) % W_),
          (y - 1) * W_ + x, (y + 1) * W_ + x,
        ];
        for (const j of nb) {
          if (j < 0 || j >= W_ * H_) continue;
          if (seen[j] || cells[j].e < sea) continue;
          if (cells[j].biome !== key) continue;
          seen[j] = 1;
          stack[sp++] = j;
        }
      }
      if (size >= 8) sizes.push(size);
    }
  }
  sizes.sort((a, b) => a - b);
  return {
    count: sizes.length,
    median: sizes.length ? sizes[sizes.length >> 1] : 0,
    p90: sizes.length ? sizes[Math.floor(sizes.length * 0.9)] : 0,
  };
}

/** 孤立碎点：四邻全部是别的群系的陆地格占比 */
function isolatedRate(cells, W_, H_, sea) {
  let iso = 0;
  let n = 0;
  for (let y = 1; y < H_ - 1; y++) {
    for (let x = 0; x < W_; x++) {
      const c = cells[y * W_ + x];
      if (c.e < sea) continue;
      n++;
      const nb = [
        cells[y * W_ + ((x - 1 + W_) % W_)], cells[y * W_ + ((x + 1) % W_)],
        cells[(y - 1) * W_ + x], cells[(y + 1) * W_ + x],
      ];
      let same = 0;
      for (const o of nb) if (o.e >= sea && o.biome === c.biome) same++;
      if (same === 0) iso++;
    }
  }
  return n ? iso / n : 0;
}

/** ±N 格处：上/下同群系率 ÷ 左/右同群系率。只统计 |lat| < latLimit 的格子 ——
 *  极冠本身就是纬向的（整条纬度都是一个颜色），把它算进来只会掩盖中低纬的真实结构。 */
function bandingIdx(cells, W_, H_, step, latLimit) {
  const yLo = Math.floor((0.5 - latLimit / 180) * H_);
  const yHi = Math.ceil((0.5 + latLimit / 180) * H_);
  let vS = 0;
  let vA = 0;
  let hS = 0;
  let hA = 0;
  for (let y = Math.max(step, yLo); y < Math.min(H_ - step, yHi); y++) {
    for (let x = 0; x < W_; x++) {
      const c = cells[y * W_ + x];
      if (c.e < c.seaRef) continue;
      const up = cells[(y - step) * W_ + x];
      const dn = cells[(y + step) * W_ + x];
      const lf = cells[y * W_ + ((x - step + W_) % W_)];
      const rt = cells[y * W_ + ((x + step) % W_)];
      if (up.e >= c.seaRef) { vA++; if (up.biome === c.biome) vS++; }
      if (dn.e >= c.seaRef) { vA++; if (dn.biome === c.biome) vS++; }
      if (lf.e >= c.seaRef) { hA++; if (lf.biome === c.biome) hS++; }
      if (rt.e >= c.seaRef) { hA++; if (rt.biome === c.biome) hS++; }
    }
  }
  const v = vA ? vS / vA : 0;
  const h = hA ? hS / hA : 0;
  return h > 1e-6 ? v / h : 99;
}

/** 陆地格到最近海洋的 BFS 距离 */
function distToSea(cells, W_, H_, sea) {
  const d = new Int32Array(W_ * H_).fill(-1);
  const q = new Int32Array(W_ * H_);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < cells.length; i++) if (cells[i].e < sea) { d[i] = 0; q[tail++] = i; }
  while (head < tail) {
    const i = q[head++];
    const x = i % W_;
    const y = (i / W_) | 0;
    const nb = [
      y * W_ + ((x - 1 + W_) % W_), y * W_ + ((x + 1) % W_),
      y > 0 ? (y - 1) * W_ + x : -1, y < H_ - 1 ? (y + 1) * W_ + x : -1,
    ];
    for (const j of nb) {
      if (j < 0 || d[j] >= 0) continue;
      d[j] = d[i] + 1;
      q[tail++] = j;
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
  let a = 0;
  let b = 0;
  let c = 0;
  for (let i = 0; i < n; i++) {
    const u = xs[i] - mx;
    const v = ys[i] - my;
    a += u * v;
    b += u * u;
    c += v * v;
  }
  return b > 0 && c > 0 ? a / Math.sqrt(b * c) : 0;
}

function quantile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * q)))];
}

// ==================== 主流程 ====================

async function main() {
  installGlobals();
  const FM = loadScripts();
  const seed = process.argv[2] || 'climate-verify';

  const gen = new FM.MapGenerator(W, H);
  const t0 = Date.now();
  await gen.generate({ plateCount: 6, seaLevel: 0.7, seed }, () => {});
  const genMs = Date.now() - t0;

  const cells = gen.cells;
  const sea = gen.seaLevel;
  for (const c of cells) c.seaRef = sea;
  const N = W * H;

  let landN = 0;
  const temps = [];
  const precs = [];
  for (const c of cells) {
    if (c.e < sea) continue;
    landN++;
    temps.push(c.temp);
    precs.push(c.precip);
  }
  temps.sort((a, b) => a - b);
  precs.sort((a, b) => a - b);

  console.log('='.repeat(78));
  console.log('气候自然度判据     seed=' + seed + '   网格 ' + W + '×' + H +
    '   海平面 ' + sea.toFixed(4) + '   陆地 ' + (landN / N * 100).toFixed(1) +
    '%   生成 ' + genMs + ' ms');
  console.log('='.repeat(78));

  // ---------- 1. 场的高频结构 ----------
  section('1. 场平滑度（发丝 / 斑点）—— |v−3×3均值| ÷ sd，越小越平滑');
  const fT = filamentIdx(cells, W, H, sea, (c) => c.temp);
  const fP = filamentIdx(cells, W, H, sea, (c) => c.precip);
  check('温度场无高频噪声', fT < 0.06, '指数 ' + fT.toFixed(3) + '（阈值 < 0.06）');
  check('降水场无发丝状脉络', fP < 0.10, '指数 ' + fP.toFixed(3) + '（阈值 < 0.10）');

  // ---------- 2. 群系的空间尺度 ----------
  section('2. 群系空间尺度（斑块 / 碎点）');
  const blobs = blobStats(cells, W, H, sea);
  const iso = isolatedRate(cells, W, H, sea);
  check('群系连片（中位斑块 ≥ 80 格）', blobs.median >= 80,
    '中位 ' + blobs.median + ' 格   p90 ' + blobs.p90 + ' 格   共 ' + blobs.count + ' 块');
  check('无「迷彩」孤立碎点（< 0.5%）', iso < 0.005, (iso * 100).toFixed(2) + '% 陆地格四邻全异');

  // ---------- 3. 纬向 / 经向条带 ----------
  section('3. 条带指数（上下同群系率 ÷ 左右同群系率；1 = 各向同性，只看 |lat|<60°）');
  const b12 = bandingIdx(cells, W, H, 12, 60);
  const b6 = bandingIdx(cells, W, H, 6, 60);
  check('12 格处不成横贯全图的纬向带', b12 > 0.62 && b12 < 1.40,
    '6 格 ' + b6.toFixed(2) + '   12 格 ' + b12.toFixed(2) + '（允许 0.62~1.40）');

  // ---------- 4. 南北半球对称 ----------
  section('4. 南北半球对称性（同纬度带陆地平均海平面等效温度之差）');
  const bandDeg = 10;
  const bandN = 180 / bandDeg;
  let worstLat = '';
  let worstD = 0;
  let sumD = 0;
  let nD = 0;
  for (let b = 0; b < bandN / 2; b++) {
    // 北半球第 b 带与南半球对称带
    const yN0 = Math.floor((b / bandN) * H);
    const yN1 = Math.floor(((b + 1) / bandN) * H);
    const yS0 = H - yN1;
    const yS1 = H - yN0;
    const meanT = (y0, y1) => {
      let s = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = 0; x < W; x++) {
          const c = cells[y * W + x];
          if (c.e < sea || c.isLake) continue;
          s += c.tempSea != null ? c.tempSea : c.temp;
          n++;
        }
      }
      // 【为什么要卡样本量】极圈附近的纬度带可能只有几十个陆地格，
      // 这种样本量下均值本身的标准误就有 0.1 量级，比较两个半球
      // 等于在比噪声。少于 150 格直接跳过。
      return n >= 150 ? s / n : null;
    };
    const tn = meanT(yN0, yN1);
    const ts = meanT(yS0, yS1);
    if (tn == null || ts == null) continue;
    const d = Math.abs(tn - ts);
    sumD += d;
    nD++;
    if (d > worstD) { worstD = d; worstLat = (90 - (b + 0.5) * bandDeg).toFixed(0); }
  }
  const meanD = nD ? sumD / nD : 0;
  // 【为什么看「平均偏差」而不是「最大偏差」】剩下的差异里有一部分是
  // **真实的**：大陆度项会让「陆地更多的一块半球」在这些纬度更冷
  // （西伯利亚 vs 同纬度的海洋）。那是气候机制，不是 bug。
  // 而原来那个 bug 的特征是**每一个纬度带**南半球都更冷 ——
  // 那是系统性偏置，用平均偏差才抓得住。
  check('南北半球平均温差 < 0.05（无系统性偏置）', meanD < 0.05,
    '平均 ' + meanD.toFixed(3) + '   最大 ' + worstD.toFixed(3) +
    '（在 ' + (worstLat || '—') + '°，仅统计 ≥150 格陆地带的）');
  check('南北半球单带温差 < 0.14', worstD < 0.14, '最大 ' + worstD.toFixed(3));

  // ---------- 5. 纬度分带顺序 ----------
  section('5. 纬度分带顺序（每一带的主导群系是否符合地球经验）');
  const bandTop = (lat0, lat1) => {
    // lat0 > lat1（北→南）
    const y0 = Math.floor(((90 - lat0) / 180) * H);
    const y1 = Math.floor(((90 - lat1) / 180) * H);
    const cnt = new Map();
    let n = 0;
    for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
      for (let x = 0; x < W; x++) {
        const c = cells[y * W + x];
        if (c.e < sea || c.isLake) continue;
        n++;
        cnt.set(c.biome, (cnt.get(c.biome) || 0) + 1);
      }
    }
    const share = (re) => {
      let s = 0;
      for (const [k, v] of cnt) if (re.test(k)) s += v;
      return n ? s / n : 0;
    };
    const top = [...cnt.entries()].sort((a, z) => z[1] - a[1])[0];
    return { n, share, top: top ? top[0] : '—' };
  };

  // 【为什么需要「半球回退」】原来的分带判据写死北半球（bandTop(70,60) 等）。
  // 有些种子在北纬 35~70° 几乎没有陆地 —— 实测 theta 种子 35~55°N 只有
  // **112 格**陆地、60~70°N 一格都没有。这时判据会因为「样本为空」
  // 直接失败，报出来的却是「温带不是阔叶林」，完全误导。
  // 判据要表达的是「这个纬度**带**该是什么群系」，与南北半球无关，
  // 所以哪个半球的样本够就用哪个。
  const MIN_BAND = 400;
  const bandTopNH = (a, b) => {
    const north = bandTop(a, b);
    if (north.n >= MIN_BAND) return { ...north, hemi: 'N' };
    const south = bandTop(-a, -b);
    if (south.n >= MIN_BAND) return { ...south, hemi: 'S' };
    return { ...(north.n >= south.n ? north : south), hemi: north.n >= south.n ? 'N' : 'S' };
  };

  const eq = bandTop(10, -10);
  check('赤道带以雨林/季雨林为主', eq.n > 0 && eq.share(/雨林/) > 0.35,
    '|lat|<10° 雨林 ' + (eq.share(/雨林/) * 100).toFixed(0) + '%  主 ' + eq.top);

  // 副热带干旱带：**只用靠海的陆地格**来比。
  //
  // 【为什么必须限定沿海】「副热带是不是局地最干」这个信号，只在大气环流
  // 直接控制的地方才干净 —— 也就是海面刚吹上来的那几十格。往内陆走，
  // 干湿由「大陆度」主导（深内陆到处都干），中纬的大陆腹地完全可能比
  // 副热带沿海更干（真实的戈壁、大盆地就在 40~45°N）。用整带平均
  // 去比，等于拿「海陆分布」去评「环流」，换一个 seed 结论就翻。
  const dd0 = distToSea(cells, W, H, sea);
  const coastalMeanP = (lat0, lat1) => {
    const y0 = Math.floor(((90 - lat0) / 180) * H);
    const y1 = Math.floor(((90 - lat1) / 180) * H);
    let s = 0;
    let n = 0;
    for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const c = cells[i];
        if (c.e < sea || c.isLake) continue;
        if (dd0[i] > 6) continue;              // 只取海岸带
        s += c.precip;
        n++;
      }
    }
    return n >= 120 ? s / n : NaN;
  };
  const pEqC = coastalMeanP(12, -12);
  const pSubNC = coastalMeanP(36, 20);
  const pSubSC = coastalMeanP(-20, -36);
  console.log('  沿海带平均降水: 赤道 ' + pEqC.toFixed(2) +
    '   20~36°N ' + pSubNC.toFixed(2) + '   20~36°S ' + pSubSC.toFixed(2));
  // 至少有一个半球的副热带沿海明显比赤道沿海干 —— 只要那个半球在
  // 副热带真的有陆地。两个半球同时不达标才说明环流出问题。
  const subOkN = !Number.isNaN(pSubNC) && pSubNC < pEqC * 0.88;
  const subOkS = !Number.isNaN(pSubSC) && pSubSC < pEqC * 0.88;
  check('副热带沿海明显比赤道沿海干（至少一个半球）', subOkN || subOkS,
    (subOkN ? '北半球达标 ' : '') + (subOkS ? '南半球达标' : '') +
    (subOkN || subOkS ? '' : '两侧都不达标'));

  const sub = bandTop(40, 25);
  check('副热带北半球以旱生群系为主', sub.n > 0 && sub.share(/沙漠|荒漠|草原/) > 0.30,
    '25~40°N 荒漠+草原 ' + (sub.share(/沙漠|荒漠|草原/) * 100).toFixed(0) + '%  主 ' + sub.top);

  const bor = bandTopNH(70, 60);
  if (bor.n < MIN_BAND) skip('亚寒带以针叶林/苔原为主', '60~70° 两个半球合计 ' + bor.n + ' 格陆地');
  else check('亚寒带以针叶林/苔原为主', bor.share(/泰加林|苔原/) > 0.40,
    '60~70°' + bor.hemi + ' 针叶林+苔原 ' + (bor.share(/泰加林|苔原/) * 100).toFixed(0) +
    '%  主 ' + bor.top + '  (' + bor.n + ' 格)');

  // 温带森林包含「温带雨林」—— 海洋性气候下的雨林同样是阔叶林带，
  // 不能因为它名字里有「雨林」就排除在外（alpha 种子的中纬就是这种）。
  const tem = bandTopNH(55, 40);
  if (tem.n < MIN_BAND) skip('温带以阔叶林/草原为主', '40~55° 两个半球合计 ' + tem.n + ' 格陆地');
  else check('温带以阔叶林/草原为主', tem.share(/阔叶林|温带雨林|草原/) > 0.40,
    '40~55°' + tem.hemi + ' 阔叶林+雨林+草原 ' + (tem.share(/阔叶林|温带雨林|草原/) * 100).toFixed(0) +
    '%  主 ' + tem.top + '  (' + tem.n + ' 格)');

  // ---------- 6. 垂直分带不越界 ----------
  section('6. 垂直分带不越界（冰雪只能出现在真正的高山 / 极地）');
  let midIce = 0;
  let midLand = 0;
  let capLatSum = 0;
  let capN = 0;
  for (let y = 0; y < H; y++) {
    const lat = Math.abs((0.5 - y / H) * 180);
    for (let x = 0; x < W; x++) {
      const c = cells[y * W + x];
      if (c.e < sea) continue;
      if (lat < 40) {
        midLand++;
        if (/雪地|冰盖/.test(c.biome)) midIce++;
      }
      if (c.biome === '极地冰盖') {
        capLatSum += lat;
        capN++;
      }
    }
  }
  check('中低纬（<40°）冰雪占比 < 4%', midLand > 0 && midIce / midLand < 0.04,
    (midIce / Math.max(1, midLand) * 100).toFixed(2) + '%（热带高峰积雪是允许的，成片冰盖不允许）');
  check('冰盖只出现在极地（平均纬度 > 68°）', capN === 0 || capLatSum / capN > 68,
    capN === 0 ? '无冰盖' : '平均 |lat| ' + (capLatSum / capN).toFixed(1) + '°，共 ' +
    (capN / landN * 100).toFixed(1) + '% 陆地');

  // ---------- 7. 降水—距海关系 ----------
  section('7. 大陆度 / 海洋性');
  const dd = distToSea(cells, W, H, sea);
  const xs = [];
  const ys = [];
  for (let i = 0; i < N; i++) {
    if (cells[i].e < sea || dd[i] < 0) continue;
    xs.push(dd[i]);
    ys.push(cells[i].precip);
  }
  const r = pearson(xs, ys);
  //
  // 【为什么这条判据从「Pearson r」改成「分桶比」】
  // r 把**海拔**也算了进去。深内陆（>50 格）那 1~3% 的陆地往往是大陆
  // 腹地的高山，地形雨让它们比海岸还湿 —— 真实地球的落基山、天山就是
  // 如此。于是 r 被这一小撮样本拉向 0：实测 gamma 种子 r = +0.029，
  // 但**同一张图**上离海 0~5 格的平均降水是 0.656、20~45 格是 0.446 ——
  // 大陆度其实非常清楚。用 r 判会把「腹地有山」误判成「没有大陆度」。
  //
  // 改成只比较两段采样充足、且不受深山尾部污染的区间：
  //   近岸 0~5 格  vs  内陆 20~45 格。
  // 它抓的正是那个原始病灶：如果水汽输运失效、干湿只由纬度决定，
  // 这两段的均值会几乎相等（比值 ≈1）。旧实现（水汽只能跑 32 格）
  // 就是典型的一片平涂。
  const bucketMean = (lo, hi) => {
    let s = 0;
    let n = 0;
    for (let i = 0; i < N; i++) {
      if (cells[i].e < sea || dd[i] < lo || dd[i] > hi) continue;
      s += cells[i].precip;
      n++;
    }
    return n >= 200 ? s / n : NaN;
  };
  const pCoast = bucketMean(0, 5);
  const pMid = bucketMean(20, 45);
  const ratio = Number.isNaN(pCoast) || Number.isNaN(pMid) || pMid <= 1e-6
    ? NaN : pCoast / pMid;
  check('近岸明显比内陆湿（0~5 格 ÷ 20~45 格 ≥ 1.15）',
    !Number.isNaN(ratio) && ratio >= 1.15,
    '近岸 ' + (Number.isNaN(pCoast) ? 'n/a' : pCoast.toFixed(3)) +
    ' / 内陆 ' + (Number.isNaN(pMid) ? 'n/a' : pMid.toFixed(3)) +
    ' = ' + (Number.isNaN(ratio) ? 'n/a' : ratio.toFixed(2)) +
    '（全样本 r = ' + r.toFixed(3) + '，仅作参考）');


  const coastal = [];
  const inland = [];
  for (let i = 0; i < N; i++) {
    if (cells[i].e < sea || dd[i] < 0) continue;
    if (dd[i] <= 8) coastal.push(cells[i].temp);
    else if (dd[i] > 40) inland.push(cells[i].temp);
  }
  check('近岸/内陆都有样本', coastal.length > 100 && inland.length > 100,
    '近岸 ' + coastal.length + ' 格   内陆 ' + inland.length + ' 格');

  // ---------- 8. 降水分位分布 ----------
  section('8. 降水分布（「整图一片绿」和「整图一片沙」都是这里越界）');
  const p05 = quantile(precs, 0.05);
  const p50 = quantile(precs, 0.5);
  const p95 = quantile(precs, 0.95);
  check('p05 落在 0.05~0.24（有真正的旱区）', p05 >= 0.05 && p05 <= 0.24, 'p05 = ' + p05.toFixed(3));
  check('p50 落在 0.36~0.58（中位不至于过湿/过干）', p50 >= 0.36 && p50 <= 0.58, 'p50 = ' + p50.toFixed(3));
  check('p95 落在 0.78~0.96（有真正的雨林）', p95 >= 0.78 && p95 <= 0.96, 'p95 = ' + p95.toFixed(3));

  const t05 = quantile(temps, 0.05);
  const t50 = quantile(temps, 0.5);
  const t95 = quantile(temps, 0.95);
  check('温度分布铺开（p95 − p05 > 0.50）', t95 - t05 > 0.50,
    'p05/p50/p95 = ' + t05.toFixed(2) + ' / ' + t50.toFixed(2) + ' / ' + t95.toFixed(2));

  // ---------- 9. 群系构成 ----------
  section('9. 陆地构成（对照真实地球：森林 ~30% / 草原 ~25% / 荒漠 ~25% / 苔原 ~12%）');
  const cnt = new Map();
  for (const c of cells) {
    if (c.e < sea || c.isLake) continue;
    cnt.set(c.biome, (cnt.get(c.biome) || 0) + 1);
  }
  const share = (re) => {
    let s = 0;
    for (const [k, v] of cnt) if (re.test(k)) s += v;
    return s / Math.max(1, landN);
  };
  const forest = share(/林/);
  const grass = share(/草原|稀树草原/);
  const desert = share(/沙漠|荒漠/);
  const cold = share(/苔原|冰盖|雪地|裸岩/);
  console.log('  森林 ' + (forest * 100).toFixed(1) + '%   草原 ' + (grass * 100).toFixed(1) +
    '%   荒漠 ' + (desert * 100).toFixed(1) + '%   高寒 ' + (cold * 100).toFixed(1) + '%');
  check('森林 25%~62%', forest >= 0.25 && forest <= 0.62, (forest * 100).toFixed(1) + '%');
  check('荒漠 1%~35%', desert >= 0.01 && desert <= 0.35, (desert * 100).toFixed(1) + '%');
  // 高寒总量随「有多少陆地落在极圈内」剧烈变化（这一版 seed 有一整块北极大陆），
  // 所以总量只做极宽的兜底；真正的判据是中纬不许有高寒 —— 见下一条。
  check('高寒 1%~48%', cold >= 0.01 && cold <= 0.48, (cold * 100).toFixed(1) + '%');

  const tz = bandTopNH(55, 35);
  if (tz.n < MIN_BAND) skip('温带（35~55°）高寒群系 < 25%', '35~55° 两个半球合计 ' + tz.n + ' 格陆地');
  else check('温带（35~55°）高寒群系 < 25%',
    tz.share(/苔原|冰盖|雪地|裸岩|高山冻原/) < 0.25,
    (tz.share(/苔原|冰盖|雪地|裸岩|高山冻原/) * 100).toFixed(1) +
    '%（' + tz.hemi + ' 半球，' + tz.n + ' 格）');

  // ---------- 10. 横向截段 ----------
  section('10. 场连续性（抓「整行跳变」的横向截段）');
  const rowJump = (get) => {
    let worst = 0;
    const mean = new Float64Array(H);
    for (let y = 0; y < H; y++) {
      let s = 0;
      let n = 0;
      for (let x = 0; x < W; x++) {
        const c = cells[y * W + x];
        if (c.e < sea) continue;
        s += get(c);
        n++;
      }
      mean[y] = n ? s / n : NaN;
    }
    for (let y = 1; y < H; y++) {
      if (Number.isNaN(mean[y]) || Number.isNaN(mean[y - 1])) continue;
      worst = Math.max(worst, Math.abs(mean[y] - mean[y - 1]));
    }
    return worst;
  };
  const jT = rowJump((c) => c.temp);
  const jP = rowJump((c) => c.precip);
  check('温度场无整行跳变（< 0.06）', jT < 0.06, '最大 ' + jT.toFixed(4));
  check('降水场无整行跳变（< 0.10）', jP < 0.10, '最大 ' + jP.toFixed(4));

  // ---------- 11. 确定性 ----------
  section('11. 确定性（同 seed 必须逐位一致）');
  const snap = new Float32Array(N);
  for (let i = 0; i < N; i++) snap[i] = cells[i].temp;
  const gen2 = new FM.MapGenerator(W, H);
  await gen2.generate({ plateCount: 6, seaLevel: 0.7, seed }, () => {});
  let diff = 0;
  for (let i = 0; i < N; i++) {
    if (Math.fround(cells[i].temp) !== Math.fround(gen2.cells[i].temp)) diff++;
  }
  check('两次生成逐位一致', diff === 0 && gen2.seaLevel === sea, diff + ' 格不一致');

  // ---------- 12. 退化守卫 ----------
  section('12. 退化输入守卫');
  const Cls = FM.classifyBiome;
  check('classifyBiome 对 NaN 输入不抛错',
    typeof Cls(NaN, NaN, 0.8, 0.5, false) === 'string');
  check('classifyBiome 全湿 = 雨林', /雨林|林/.test(Cls(1.0, 1.0, 0.55, 0.5, false)),
    '→ ' + Cls(1.0, 1.0, 0.55, 0.5, false));
  check('classifyBiome 全干 = 沙漠/荒漠', /沙漠|荒漠/.test(Cls(0.85, 0.0, 0.55, 0.5, false)),
    '→ ' + Cls(0.85, 0.0, 0.55, 0.5, false));
  check('海洋判定优先', Cls(1.0, 1.0, 0.2, 0.5, false) === '深海',
    '→ ' + Cls(1.0, 1.0, 0.2, 0.5, false));
  check('湖泊判定优先', Cls(1.0, 1.0, 0.8, 0.5, true) === '湖泊');

  console.log('\n' + '='.repeat(78));
  console.log(failed === 0
    ? '全部通过：' + passed + ' 项' + (skipped ? '（另有 ' + skipped + ' 项因样本不足跳过）' : '')
    : passed + ' 通过 / ' + failed + ' 失败' + (skipped ? ' / ' + skipped + ' 跳过' : ''));
  console.log('='.repeat(78));
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
