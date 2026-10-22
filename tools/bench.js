/**
 * tools/bench.js —— 离屏性能基准（无需浏览器）
 *
 * 在 Node 主上下文里加载全部业务脚本（不用 vm 沙箱，避免全局访问惩罚），
 * 用假的 canvas 上下文替代 DOM，分别测量「生成管线」「纹理预计算」
 * 「逐像素上色」的耗时，并输出地形指纹用于优化前后的数值回归对比。
 *
 * 用法：
 *   node tools/bench.js [--repeat=3] [--json]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const repeatArg = args.find((a) => a.startsWith('--repeat='));
const REPEAT = repeatArg ? Math.max(1, parseInt(repeatArg.split('=')[1], 10)) : 3;
const AS_JSON = args.includes('--json');

// ---------- 假画布：只实现业务代码真正用到的接口 ----------
function makeFakeCtx(canvas) {
  const ctx = {
    canvas,
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    globalAlpha: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    font: '10px sans-serif',
    textAlign: 'left',
    shadowColor: '',
    shadowBlur: 0,
  };
  const noop = () => {};
  ctx.createImageData = (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
  ctx.getImageData = (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
  ctx.createLinearGradient = () => ({ addColorStop: noop });
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
  const doc = {
    createElement: (tag) => (tag === 'canvas' ? makeFakeCanvas() : { style: {}, appendChild() {} }),
    getElementById: () => null,
  };
  globalThis.window = globalThis;
  globalThis.document = doc;
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 16);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
}

function loadScripts() {
  const files = [
    'js/vendor/simplex-noise.js',
    'js/projection.js',
    'js/hypsometry.js',
    'js/hydrology.js',
    'js/climate.js',
    'js/terrain.js',
    'js/map-generator.js',
    'js/renderer.js',
  ];
  for (const f of files) {
    const code = fs.readFileSync(path.join(ROOT, f), 'utf8');
    vm.runInThisContext(code, { filename: f });
  }
  return globalThis.FM;
}

/** 地形指纹：优化必须保持这些统计量基本一致 */
function fingerprint(cells) {
  let sum = 0;
  let min = 1;
  let max = 0;
  let land = 0;
  const biome = new Map();
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    sum += c.e;
    if (c.e < min) min = c.e;
    if (c.e > max) max = c.e;
    if (c.e >= 0.5) land++;
    biome.set(c.biome, (biome.get(c.biome) || 0) + 1);
  }
  const top = [...biome.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  return {
    sum: +sum.toFixed(3),
    min: +min.toFixed(5),
    max: +max.toFixed(5),
    landRatio: +(land / cells.length).toFixed(4),
    topBiomes: top.map(([k, v]) => k + ':' + ((v / cells.length) * 100).toFixed(1) + '%'),
  };
}

async function main() {
  installGlobals();
  const FM = loadScripts();
  const runs = [];

  for (let r = 0; r < REPEAT; r++) {
    const gen = new FM.MapGenerator(1600, 800);

    // 统计噪声采样次数（每调用一次 noiseSeamless 记 1，用器质性计数不干扰热点）
    let noiseCalls = 0;
    const rawNoise = gen.noiseSeamless.bind(gen);
    gen.noiseSeamless = function (...a) { noiseCalls++; return rawNoise(...a); };

    const t0 = performance.now();
    // 单独计时地形阶段（多线程版本在 Node 里走单线程兜底，便于对比）
    let terrainMs = 0;
    const rawElevation = FM.Terrain.computeElevation;
    FM.Terrain.computeElevation = async (...a) => {
      const tt = performance.now();
      const out = await rawElevation.apply(FM.Terrain, a);
      terrainMs = performance.now() - tt;
      return out;
    };
    const stats = await gen.generate({ plateCount: 6, seaLevel: 0.7, seed: 'bench-fixed' }, () => {});
    FM.Terrain.computeElevation = rawElevation;
    const tGen = performance.now() - t0;
    const genNoiseCalls = noiseCalls;

    const renderer = new FM.MapRenderer(makeFakeCanvas(1600, 800), 1600, 800);

    const tOcean0 = performance.now();
    renderer.setGenerator(gen);
    const tOcean = performance.now() - tOcean0;

    // 稳态重建（编辑地形走的就是这条路）：噪声层已缓存，只剩算术
    const tRebuild0 = performance.now();
    renderer.updateOceanDepth();
    const tRebuild = performance.now() - tRebuild0;

    renderer.setProjection('equirect');
    const tPaint0 = performance.now();
    renderer.paintTerrain();
    const tPaintEq = performance.now() - tPaint0;

    // 完整重绘（地形层 + 矢量层 + 合成）
    const tFull0 = performance.now();
    renderer.terrainDirty = true;
    renderer.render();
    const tRenderFull = performance.now() - tFull0;

    // 仅切换叠加层（经纬网 / 季风 / 洋流）时的重绘
    const tOverlay0 = performance.now();
    renderer.setOptions({ showGrid: false, showMonsoon: true });
    renderer.render();
    const tRenderOverlay = performance.now() - tOverlay0;
    renderer.setOptions({ showGrid: true, showMonsoon: false });
    renderer.render();

    // 非等距投影：地形层重绘（albedo 重采样）
    renderer.setProjection('robinson');
    const tPaint0b = performance.now();
    renderer.paintTerrain();
    const tPaintRob = performance.now() - tPaint0b;

    noiseCalls = 0;
    renderer.terrainDirty = true;
    renderer.paintTerrain();
    const renderNoiseCalls = noiseCalls;

    runs.push({
      totalMs: +tGen.toFixed(0),
      terrainMs: +terrainMs.toFixed(0),
      climateMs: +stats.climateMs.toFixed(0),
      hydrologyMs: +stats.totalMs.toFixed(0),
      genNoiseCalls: genNoiseCalls,
      oceanDepthAndTexMs: +tOcean.toFixed(0),
      rebuildMs: +tRebuild.toFixed(0),
      paintEquirectMs: +tPaintEq.toFixed(0),
      paintRobinsonMs: +tPaintRob.toFixed(0),
      renderFullMs: +tRenderFull.toFixed(0),
      renderOverlayMs: +tRenderOverlay.toFixed(0),
      renderNoiseCalls: renderNoiseCalls,
      fp: fingerprint(gen.cells),
    });
  }

  const keys = ['totalMs', 'terrainMs', 'climateMs', 'hydrologyMs', 'genNoiseCalls', 'oceanDepthAndTexMs', 'rebuildMs',
    'paintEquirectMs', 'paintRobinsonMs', 'renderFullMs', 'renderOverlayMs', 'renderNoiseCalls'];
  const avg = {};
  for (const k of keys) avg[k] = +(runs.reduce((s, x) => s + x[k], 0) / runs.length).toFixed(0);

  // 多次运行的指纹必须完全一致（固定 seed 后应当逐位可复现）
  const fp0 = JSON.stringify(runs[0].fp);
  const deterministic = runs.every((r) => JSON.stringify(r.fp) === fp0);

  if (AS_JSON) {
    console.log(JSON.stringify({ avg, deterministic, runs }, null, 2));
  } else {
    console.log('== 单次明细 ==');
    for (const r of runs) console.log(JSON.stringify(r));
    console.log('\n== 平均（' + runs.length + ' 次）==');
    for (const k of keys) console.log(k.padEnd(22), avg[k] + (k.endsWith('Calls') ? ' 次' : ' ms'));
    console.log('\n固定种子可复现:', deterministic ? '是' : '否（指纹不一致）');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
