#!/usr/bin/env node
/**
 * preview-climate.js —— 气候系统的离屏可视化（不参与构建）
 *
 * 跑一遍完整生成管线，把同一张地图的四种信息并排画出来：
 *
 *   左   群系图（用 renderer.js 的 BIOME_PALETTE，和页面上看到的一致）
 *   中   温度假彩（蓝→红）
 *   右   降水假彩（土黄→深蓝绿）
 *  下排 纬度剖面：每 2° 一条，左=陆地平均温度，右=陆地平均降水
 *
 * 【为什么要单独做这个工具】气候"不自然"最常见的样子是**纬向条带** ——
 * 群系沿纬线横贯全图，同一纬度上撒哈拉和中国季风区一样干。
 * 这种东西在 1600×800 的整图上不容易一眼看出（地形细节会干扰判断），
 * 换成纯色群系图 + 温湿假彩就非常明显。
 *
 * 用法：node tools/preview-climate.js [seed]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const PNG = require('./lib-png');

// ==================== 假 DOM（生成管线只需要 canvas 接口存在）====================

function makeFakeCtx(canvas) {
  const noop = () => {};
  const ctx = { canvas, fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1, font: '10px sans-serif' };
  ctx.createImageData = (w, h) => {
    const im = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    // 记下最近一张 W×H 的全图 ImageData —— paintTerrain 的最后一次 putImageData
    // 就是用户真正看到的画面
    if (w === W && h === H) globalThis.__lastImageData = im;
    return im;
  };
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
    'js/renderer.js',
  ]) {
    vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });
  }
  return globalThis.FM;
}

/** 从 renderer.js 里抠出 BIOME_PALETTE（与页面配色同源） */
function extractBiomePalette() {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'renderer.js'), 'utf8');
  const m = src.match(/const BIOME_PALETTE = \{([\s\S]*?)\n  \};/);
  if (!m) throw new Error('未找到 BIOME_PALETTE');
  // eslint-disable-next-line no-new-func
  return new Function('return {' + m[1] + '};')();
}

// ==================== 画布 ====================

const W = 1000;
const H = 500;
const GAP = 8;

function ramp(stops) {
  // stops: [[t, [r,g,b]], ...] 升序
  return (v) => {
    const t = v < 0 ? 0 : v > 1 ? 1 : v;
    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i][0]) {
        const a = stops[i - 1];
        const b = stops[i];
        const k = (t - a[0]) / Math.max(1e-9, b[0] - a[0]);
        return [
          Math.round(a[1][0] + (b[1][0] - a[1][0]) * k),
          Math.round(a[1][1] + (b[1][1] - a[1][1]) * k),
          Math.round(a[1][2] + (b[1][2] - a[1][2]) * k),
        ];
      }
    }
    return stops[stops.length - 1][1];
  };
}

const tempRamp = ramp([
  [0.0, [26, 26, 96]], [0.2, [40, 96, 190]], [0.4, [80, 180, 200]],
  [0.55, [190, 220, 130]], [0.7, [240, 190, 70]], [0.85, [222, 96, 44]], [1.0, [140, 24, 24]],
]);
const precipRamp = ramp([
  [0.0, [204, 168, 96]], [0.2, [222, 208, 130]], [0.35, [170, 200, 120]],
  [0.5, [90, 168, 120]], [0.7, [40, 130, 130]], [0.85, [26, 90, 150]], [1.0, [16, 44, 120]],
]);

function panel(buf, px, py, w, h, getRGB) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const rgb = getRGB(x, y);
      const o = ((py + y) * w0 + px + x) * 3;
      buf[o] = rgb[0]; buf[o + 1] = rgb[1]; buf[o + 2] = rgb[2];
    }
  }
}

let w0 = 0;

// ==================== 诊断统计 ====================

function quantile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

/**
 * 纬向条带指数。
 *
 * 对每个陆地格，比较它与其「正上方/正下方 N 格」的群系是否相同，
 * 以及与「左右 N 格」是否相同。
 *   条带化 → 上下很容易相同（同一纬度带）、左右很快变 → 比值 > 1
 *   成块分布 → 两个方向差不多 → 比值 ≈ 1
 */
function bandingIndex(cells, W_, H_, N) {
  const step = N || 6;
  let vSame = 0;
  let vAll = 0;
  let hSame = 0;
  let hAll = 0;
  for (let y = step; y < H_ - step; y++) {
    for (let x = 0; x < W_; x++) {
      const c = cells[y * W_ + x];
      if (c.e < c.seaRef) continue;
      const up = cells[(y - step) * W_ + x];
      const dn = cells[(y + step) * W_ + x];
      const lf = cells[y * W_ + ((x - step + W_) % W_)];
      const rt = cells[y * W_ + ((x + step) % W_)];
      if (up.e >= c.seaRef) { vAll++; if (up.biome === c.biome) vSame++; }
      if (dn.e >= c.seaRef) { vAll++; if (dn.biome === c.biome) vSame++; }
      if (lf.e >= c.seaRef) { hAll++; if (lf.biome === c.biome) hSame++; }
      if (rt.e >= c.seaRef) { hAll++; if (rt.biome === c.biome) hSame++; }
    }
  }
  const v = vAll ? vSame / vAll : 0;
  const h = hAll ? hSame / hAll : 0;
  return { v, h, ratio: h > 1e-6 ? v / h : 99 };
}

/**
 * 高频能量指数：|v − 3×3 均值| 的均值 ÷ v 的标准差。
 * 平滑场 ≈ 0.1~0.2；充满细丝/斑点时会 > 0.4。
 */
function filamentIndex(cells, W_, H_, sea, get) {
  let sumDev = 0;
  let n = 0;
  let sum = 0;
  let sum2 = 0;
  for (let y = 1; y < H_ - 1; y++) {
    for (let x = 0; x < W_; x++) {
      const i = y * W_ + x;
      if (cells[i].e < sea) continue;
      let s = 0;
      let cnt = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const j = (y + dy) * W_ + ((x + dx + W_) % W_);
          if (cells[j].e < sea) continue;
          s += get(cells[j]);
          cnt++;
        }
      }
      if (cnt < 5) continue;
      const v = get(cells[i]);
      sumDev += Math.abs(v - s / cnt);
      sum += v;
      sum2 += v * v;
      n++;
    }
  }
  if (n < 100) return { mean: 0, sd: 0, idx: 0 };
  const mean = sum / n;
  const sd = Math.sqrt(Math.max(1e-9, sum2 / n - mean * mean));
  return { mean, sd, idx: (sumDev / n) / sd };
}

/**
 * 群系连通块统计：同群系的 4-邻接连通块的平均/中位面积（格）。
 * "迷彩斑块" 的块会很小（几十格），成气候带的块会很大（几千格）。
 */
function blobStats(cells, W_, H_, sea) {
  const seen = new Uint8Array(W_ * H_);
  const sizes = [];
  const stack = new Int32Array(W_ * H_);
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
    largest: sizes.length ? sizes[sizes.length - 1] : 0,
  };
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

function corr(xs, ys) {
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

// ==================== 主流程 ====================

async function main() {
  installGlobals();
  const FM = loadScripts();
  const PALETTE = extractBiomePalette();

  const seed = process.argv[2] || 'climate-demo';
  const gen = new FM.MapGenerator(W, H);
  const t0 = Date.now();
  const stats = await gen.generate({ plateCount: 6, seaLevel: 0.7, seed }, () => {});
  const genMs = Date.now() - t0;

  const cells = gen.cells;
  const sea = gen.seaLevel;
  for (const c of cells) c.seaRef = sea;

  // ---------- 布局 ----------
  const panelW = W;
  const panelH = H;
  const profW = 320;
  const profH = 220;
  const totalW = panelW * 3 + GAP * 4;
  const totalH = panelH + GAP * 3 + profH;
  w0 = totalW;
  const img = new Uint8Array(totalW * totalH * 3);
  for (let i = 0; i < totalW * totalH; i++) { img[i * 3] = 16; img[i * 3 + 1] = 20; img[i * 3 + 2] = 26; }

  const at = (x, y) => y * W + x;

  // 1. 群系图
  const getBiome = (x, y) => {
    const c = cells[at(x, y)];
    const col = PALETTE[c.biome];
    if (!col) return [255, 0, 255];
    if (c.e < sea) {
      // 海洋按深度压暗，方便看出海陆轮廓
      const d = (sea - c.e) / Math.max(1e-6, sea);
      const k = 0.55 + 0.45 * (1 - Math.min(1, d * 2.2));
      return [Math.round(col[0] * k), Math.round(col[1] * k), Math.round(col[2] * k)];
    }
    return col;
  };

  // 2/3. 温度、降水假彩（海洋留暗蓝，避免干扰）
  const getTemp = (x, y) => {
    const c = cells[at(x, y)];
    if (c.e < sea) return [22, 34, 56];
    return tempRamp(c.temp);
  };
  const getPrecip = (x, y) => {
    const c = cells[at(x, y)];
    if (c.e < sea) return [22, 34, 56];
    return precipRamp(c.precip);
  };

  panel(img, GAP, GAP, panelW, panelH, getBiome);
  panel(img, GAP * 2 + panelW, GAP, panelW, panelH, getTemp);
  panel(img, GAP * 3 + panelW * 2, GAP, panelW, panelH, getPrecip);

  // ---------- 下排：纬度剖面 ----------
  //
  // 左边画温度（0~1 → 蓝到红），右边画降水（0~1 → 土黄到深蓝）。
  // 每条竖线 = 一个纬度带（2°），高度 = 该纬度**陆地格**的均值。
  // 底下再叠一层灰色的陆地占比柱，说明这个纬度有没有陆地。
  const bandCount = 90; // 2° 一条
  const bandRows = Math.floor(H / bandCount);
  const tempProf = new Float64Array(bandCount);
  const precProf = new Float64Array(bandCount);
  const landFrac = new Float64Array(bandCount);
  for (let b = 0; b < bandCount; b++) {
    let st = 0;
    let sp = 0;
    let n = 0;
    for (let y = b * bandRows; y < (b + 1) * bandRows && y < H; y++) {
      for (let x = 0; x < W; x++) {
        const c = cells[at(x, y)];
        if (c.e < sea) continue;
        st += c.temp;
        sp += c.precip;
        n++;
      }
    }
    landFrac[b] = n / (bandRows * W);
    tempProf[b] = n ? st / n : 0;
    precProf[b] = n ? sp / n : 0;
  }

  const py0 = GAP * 2 + panelH;
  const drawProfile = (px, values, colFn) => {
    const baseY = py0 + profH - 18;
    const topY = py0 + 12;
    for (let b = 0; b < bandCount; b++) {
      const x0 = px + Math.round((b / bandCount) * profW);
      const x1 = px + Math.round(((b + 1) / bandCount) * profW);
      // 陆地占比底柱
      const lh = Math.round((baseY - topY) * landFrac[b] * 0.22);
      for (let y = baseY - lh; y < baseY; y++) {
        for (let x = x0; x < x1; x++) {
          const o = (y * totalW + x) * 3;
          img[o] = 52; img[o + 1] = 58; img[o + 2] = 66;
        }
      }
      const v = values[b];
      const hgt = Math.round((baseY - topY - 24) * (v < 0 ? 0 : v > 1 ? 1 : v));
      const col = colFn(v);
      for (let y = baseY - hgt; y < baseY; y++) {
        for (let x = x0; x < x1 - 1; x++) {
          const o = (y * totalW + x) * 3;
          img[o] = col[0]; img[o + 1] = col[1]; img[o + 2] = col[2];
        }
      }
    }
  };
  drawProfile(GAP, tempProf, tempRamp);
  drawProfile(GAP * 2 + profW, precProf, precipRamp);

  const outPath = path.join(ROOT, 'dist', 'climate-preview.png');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, PNG.encode(totalW, totalH, img));

  // 三联图在屏幕上会被缩到 1/3 宽，细节看不清。再各写一份原始尺寸的单独文件。
  for (const [name, get] of [['biome', getBiome], ['temp', getTemp], ['precip', getPrecip]]) {
    const one = new Uint8Array(W * H * 3);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const rgb = get(x, y);
        const o = (y * W + x) * 3;
        one[o] = rgb[0]; one[o + 1] = rgb[1]; one[o + 2] = rgb[2];
      }
    }
    fs.writeFileSync(path.join(ROOT, 'dist', 'climate-' + name + '.png'), PNG.encode(W, H, one));
  }

  // ---------- 额外输出：接近 app 实际观感的渲染图 ----------
  //
  // 【为什么还要这一张】假彩色群系图能暴露气候结构，但它**不是用户看到的画面**。
  // 真实渲染里群系色还要叠加：
  //   · 山体阴影（中心差分兰伯特光照）—— 决定地形读起来"立不立体"；
  //   · 海拔提亮 —— 同一种群系在山上会更浅，形成垂直分带；
  // 用户抱怨「不自然」时，很可能是在看这张图。所以两张都要有。
  //
  // 光照常量与 renderer.js 的 shade() 保持一致。
  const SH_S = 34;
  const SH_LX = -0.617;
  const SH_LY = -0.617;
  const SH_LZ = 0.487;
  const app = new Uint8Array(W * H * 3);
  const seaRamp = [
    [0.0, [44, 126, 172]], [0.18, [32, 108, 162]], [0.42, [24, 92, 150]],
    [0.68, [18, 74, 136]], [1.0, [14, 56, 112]],
  ];
  const seaCol = ramp(seaRamp);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const c = cells[i];
      let r;
      let g;
      let b;
      if (c.e < sea) {
        const d = (sea - c.e) / 0.35;
        [r, g, b] = seaCol(d);
      } else {
        const col = PALETTE[c.biome] || [255, 0, 255];
        const landE = (c.e - sea) / Math.max(1e-6, 1 - sea);
        // 海拔提亮：越高越浅（岩石/裸地感），最顶端轻微去饱和
        const up = 1 + landE * 0.22;
        r = Math.min(255, col[0] * up);
        g = Math.min(255, col[1] * up);
        b = Math.min(255, col[2] * up);
        // 山体阴影
        if (x > 0 && x < W - 1 && y > 0 && y < H - 1) {
          const l = cells[i - 1];
          const rr = cells[i + 1];
          const u = cells[i - W];
          const dn = cells[i + W];
          if (l.e >= sea && rr.e >= sea && u.e >= sea && dn.e >= sea) {
            const gx = (rr.e - l.e) * 0.5;
            const gy = (dn.e - u.e) * 0.5;
            const nx = -gx * SH_S;
            const ny = -gy * SH_S;
            const nl = Math.sqrt(nx * nx + ny * ny + 1) || 1;
            const dot = (nx * SH_LX + ny * SH_LY + SH_LZ) / nl;
            const k = Math.max(0.50, Math.min(1.22, 0.52 + (dot / SH_LZ) * 0.46));
            r *= k;
            g *= k;
            b *= k;
          }
        }
      }
      const o = i * 3;
      app[o] = r < 0 ? 0 : r > 255 ? 255 : r;
      app[o + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
      app[o + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
    }
  }
  fs.writeFileSync(path.join(ROOT, 'dist', 'climate-app.png'), PNG.encode(W, H, app));

  // ---------- 最有说服力的一张：用项目自己的 Renderer ----------
  //
  // 【为什么还要跑真 Renderer】上面那张是我照着 shade() 的参数手写的近似，
  // 少了 renderer 里的三样东西：群系色邻域平滑（按色差衰减）、向亮度
  // 去饱和 26%、以及海拔 → 岩色的漂移。这三样正好是决定「看起来像不像
  // 真实遥感图」的部分，手写版会高估土黄色的占比。
  // 这里直接把 FM.MapRenderer 跑起来，从假 canvas 的 createImageData 里
  // 把它实际写出的那张 W×H 像素抓下来 —— 这就是用户在页面上看到的画面。
  try {
    const rCanvas = makeFakeCanvas(W, H);
    const renderer = new FM.MapRenderer(rCanvas, W, H);
    renderer.setGenerator(gen);
    renderer.buildBiomeColorMap();
    globalThis.__lastImageData = null;
    renderer.paintTerrain();
    const im = globalThis.__lastImageData;
    if (im && im.data.length === W * H * 4) {
      const rgb = new Uint8Array(W * H * 3);
      for (let i = 0; i < W * H; i++) {
        rgb[i * 3] = im.data[i * 4];
        rgb[i * 3 + 1] = im.data[i * 4 + 1];
        rgb[i * 3 + 2] = im.data[i * 4 + 2];
      }
      fs.writeFileSync(path.join(ROOT, 'dist', 'climate-real.png'), PNG.encode(W, H, rgb));
      console.log('  真实渲染 → dist/climate-real.png');

      // 【为什么要把「群系 → 实际渲染色」列出来】
      // 只看群系分类表会得出「森林 36%、草原 33%」这种结论，
      // 但屏幕上到底呈现成绿还是沙，取决于 群系色 × 去饱和 × gamma ×
      // 海拔岩色漂移 这一整条链路。同一个「草原」在两种色值下，
      // 渲染出来可以是橄榄绿，也可以是浅沙 —— 只有把最终色打出来
      // 才知道观感到底由谁决定。
      const agg = new Map();
      let landTotal = 0;
      for (let i = 0; i < W * H; i++) {
        const c = cells[i];
        if (c.e < sea) continue;
        landTotal++;
        const k = c.biome;
        let a = agg.get(k);
        if (!a) { a = { n: 0, r: 0, g: 0, b: 0 }; agg.set(k, a); }
        a.n++;
        a.r += rgb[i * 3];
        a.g += rgb[i * 3 + 1];
        a.b += rgb[i * 3 + 2];
      }
      const rows = [...agg.entries()].sort((p, q) => q[1].n - p[1].n);
      console.log('  渲染成品色（占陆地 / 平均 RGB）:');
      for (const [k, a] of rows.slice(0, 10)) {
        const r = Math.round(a.r / a.n);
        const g = Math.round(a.g / a.n);
        const b = Math.round(a.b / a.n);
        // 绿度：G 明显大于 R 才算「看着是绿的」
        const greenish = g - r > 6;
        console.log('    ' + k.padEnd(12) + (a.n / Math.max(1, landTotal) * 100).toFixed(1).padStart(5) + '%   ' +
          String(r).padStart(3) + ',' + String(g).padStart(3) + ',' + String(b).padStart(3) +
          '  ' + (greenish ? '绿' : '土'));
      }
    } else {
      console.log('  ⚠ 未能捕获 Renderer 输出（跳过 climate-real.png）');
    }
  } catch (e) {
    console.log('  ⚠ Renderer 离屏渲染失败：' + e.message);
  }

  // ---------- 统计 ----------
  const biomeCount = new Map();
  let landN = 0;
  const temps = [];
  const precs = [];
  for (const c of cells) {
    biomeCount.set(c.biome, (biomeCount.get(c.biome) || 0) + 1);
    if (c.e < sea) continue;
    landN++;
    temps.push(c.temp);
    precs.push(c.precip);
  }
  temps.sort((a, b) => a - b);
  precs.sort((a, b) => a - b);

  const biomes = [...biomeCount.entries()].sort((a, b) => b[1] - a[1]);
  const band = bandingIndex(cells, W, H, 6);
  const band2 = bandingIndex(cells, W, H, 12);

  console.log('='.repeat(74));
  console.log('气候预览 → dist/climate-preview.png');
  console.log('  seed=' + seed + '  网格 ' + W + '×' + H + '  海平面 ' + sea.toFixed(4) +
    '  陆地 ' + (landN / cells.length * 100).toFixed(1) + '%  生成 ' + genMs + ' ms');
  console.log('='.repeat(74));
  console.log('群系分布（占全图）:');
  for (const [k, v] of biomes) {
    console.log('  ' + k.padEnd(14) + (v / cells.length * 100).toFixed(2).padStart(6) + '%');
  }
  const landBiomes = biomes.filter(([k]) => !['海洋', '浅海', '深海', '湖泊'].includes(k));
  const forest = landBiomes.filter(([k]) => /林/.test(k)).reduce((s, [, v]) => s + v, 0);
  const desert = landBiomes.filter(([k]) => /沙漠|荒漠/.test(k)).reduce((s, [, v]) => s + v, 0);
  const grass = landBiomes.filter(([k]) => /草原|苔原/.test(k)).reduce((s, [, v]) => s + v, 0);
  console.log('  — 陆地构成: 森林 ' + (forest / landN * 100).toFixed(1) + '%' +
    '  草原/苔原 ' + (grass / landN * 100).toFixed(1) + '%' +
    '  荒漠 ' + (desert / landN * 100).toFixed(1) + '%' +
    '  其他 ' + ((landN - forest - grass - desert) / landN * 100).toFixed(1) + '%');
  console.log('温度 p05/p50/p95 = ' + quantile(temps, 0.05).toFixed(3) + ' / ' +
    quantile(temps, 0.5).toFixed(3) + ' / ' + quantile(temps, 0.95).toFixed(3));
  console.log('降水 p05/p50/p95 = ' + quantile(precs, 0.05).toFixed(3) + ' / ' +
    quantile(precs, 0.5).toFixed(3) + ' / ' + quantile(precs, 0.95).toFixed(3));
  console.log('纬向条带指数（上下同群系率 ÷ 左右同群系率，越接近 1 越成块）:');
  console.log('  6 格:  上/下 ' + (band.v * 100).toFixed(1) + '%  左/右 ' + (band.h * 100).toFixed(1) +
    '%  比值 ' + band.ratio.toFixed(2));
  console.log('  12 格: 上/下 ' + (band2.v * 100).toFixed(1) + '%  左/右 ' + (band2.h * 100).toFixed(1) +
    '%  比值 ' + band2.ratio.toFixed(2));

  const fT = filamentIndex(cells, W, H, sea, (c) => c.temp);
  const fP = filamentIndex(cells, W, H, sea, (c) => c.precip);
  const blobs = blobStats(cells, W, H, sea);
  const dd = distToSea(cells, W, H, sea);
  const xs = [];
  const ys = [];
  for (let i = 0; i < cells.length; i++) {
    if (cells[i].e < sea || dd[i] < 0) continue;
    xs.push(dd[i]);
    ys.push(cells[i].precip);
  }
  console.log('高频能量（|v−3×3均值| / sd，越大越像细丝/斑点）:');
  console.log('  温度 ' + fT.idx.toFixed(3) + '   降水 ' + fP.idx.toFixed(3));
  console.log('群系斑块: ' + blobs.count + ' 块   中位 ' + blobs.median + ' 格   p90 ' +
    blobs.p90 + ' 格   最大 ' + blobs.largest + ' 格');
  console.log('降水 vs 距海距离: r = ' + corr(xs, ys).toFixed(3) + '（应为明显负相关）');

  // ---------- 按纬度带的群系构成 ----------
  //
  // 【为什么必须看这个】整图统计只能告诉你「森林 44%」，
  // 但看不出这些森林长在**哪个纬度**。气候不自然最典型的形态是
  // 「分带错位」：60° 长沙漠、赤道长苔原、南北半球冷热颠倒。
  // 按 10° 一带切开，直接看每一带的主导游群系，比看图更早发现问题。
  // （这里顺带打印 tSea —— 海平面等效温度 —— 它是判定气候带的唯一依据。）
  console.log('');
  console.log('纬度带构成（每 10°；tSea = 海平面等效温度，p = 降水）:');
  const bandDeg = 10;
  const bandN = 180 / bandDeg;
  for (let b = 0; b < bandN; b++) {
    // y 越大纬度越低：第 b 带对应 lat [90-b*10, 90-(b+1)*10]
    const y0 = Math.floor((b / bandN) * H);
    const y1 = Math.floor(((b + 1) / bandN) * H);
    const cnt = new Map();
    let n = 0;
    let st = 0;
    let sp = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < W; x++) {
        const c = cells[y * W + x];
        if (c.e < sea || c.isLake) continue;
        n++;
        const rel = (c.e - sea) / Math.max(1e-6, 1 - sea);
        st += c.tempSea != null ? c.tempSea : Math.min(1, c.temp + rel * 0.42);
        sp += c.precip;
        cnt.set(c.biome, (cnt.get(c.biome) || 0) + 1);
      }
    }
    const top = [...cnt.entries()].sort((a, z) => z[1] - a[1]).slice(0, 3)
      .map(([k, v]) => k + ' ' + (v / n * 100).toFixed(0) + '%').join(' / ');
    const latLabel = (90 - (b + 0.5) * bandDeg).toFixed(0).padStart(3) + '°';
    console.log('  ' + latLabel + '  陆 ' + (n / ((y1 - y0) * W) * 100).toFixed(0).padStart(3) +
      '%  tSea ' + (n ? (st / n).toFixed(2) : ' -- ') +
      '  p ' + (n ? (sp / n).toFixed(2) : ' -- ') + '   ' + (n ? top : '（无陆地）'));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
