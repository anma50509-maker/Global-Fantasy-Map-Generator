#!/usr/bin/env node
/**
 * verify-build.js —— 验证单文件产物（dist/index.html）真的能用
 *
 * 【为什么单独验】
 * 构建最容易出的错不是内容错，而是**装配错**：
 *   · 某个 </script> 提前闭合，后半截代码变成纯文本；
 *   · 内联顺序被打乱，terrain.js 在 simplex-noise 之前跑（SimplexNoise 未定义）；
 *   · 内联 Worker 的源码拼接漏了一行，运行时静默退回单线程（性能腰斩但不报错）。
 * 前两条可以在一个 DOM 桩里按顺序跑一遍脚本抓出来；第三条必须真的
 * 把内联源码丢进 worker_threads 跑，再与源码版本逐位比对。
 *
 * 用法：node tools/verify-build.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Worker } = require('worker_threads');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'index.html');

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✅ ' + name + (detail ? '   ' + detail : '')); }
  else { failed++; console.log('  ❌ ' + name + (detail ? '   ' + detail : '')); }
}

async function main() {
  console.log('='.repeat(74));
  console.log('单文件产物验证  dist/index.html');
  console.log('='.repeat(74));

  if (!fs.existsSync(DIST)) {
    console.error('✗ 找不到 dist/index.html，请先执行 node build.js');
    process.exit(1);
  }
  const html = fs.readFileSync(DIST, 'utf8');

  // ---------- 1. 结构 ----------
  console.log('\n【1】产物结构');
  const externals = [];
  const re = /(?:src|href)="((?!data:|#)[^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) externals.push(m[1]);
  check('没有外部引用（可离线 / file:// 打开）', externals.length === 0, externals.join(', '));
  check('样式已内联', html.includes('<style>') && !html.includes('href="css/style.css"'));

  const workerMatch = html.match(/<script>\s*window\.__FM_WORKER_SRC__ = ([\s\S]*?);\s*<\/script>/);
  check('注入了内联 Worker 源码', !!workerMatch);
  if (!workerMatch) {
    console.log('\n无法继续：产物缺少 Worker 源码');
    process.exit(1);
  }
  let workerSource = null;
  try {
    workerSource = JSON.parse(workerMatch[1]);
  } catch (err) {
    check('Worker 源码可被 JSON 解析', false, err.message);
    process.exit(1);
  }
  check('Worker 源码可被 JSON 解析', typeof workerSource === 'string' && workerSource.length > 1000,
    (workerSource.length / 1024).toFixed(0) + ' KB');

  // ---------- 2. 按顺序执行内联脚本（DOM 桩） ----------
  console.log('\n【2】按顺序执行内联脚本');
  const scriptBlocks = [];
  const sre = /<script>\n?([\s\S]*?)<\/script>/g;
  let s;
  while ((s = sre.exec(html)) !== null) scriptBlocks.push(s[1]);
  check('脚本块数量合理', scriptBlocks.length >= 12, scriptBlocks.length + ' 块');

  const noop = () => {};
  const stubCtx = {
    clearRect: noop, save: noop, restore: noop, beginPath: noop, closePath: noop,
    moveTo: noop, lineTo: noop, arc: noop, fill: noop, stroke: noop, fillRect: noop,
    setLineDash: noop, putImageData: noop, drawImage: noop,
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createLinearGradient: () => ({ addColorStop: noop }),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
  };
  const makeEl = () => ({
    style: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    appendChild: noop, addEventListener: noop, removeEventListener: noop,
    getContext: () => stubCtx, width: 1600, height: 800,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1600, height: 800 }),
    setPointerCapture: noop, releasePointerCapture: noop,
    querySelector: () => null, querySelectorAll: () => [],
  });
  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    performance,
    JSON, Math, Date, Object, Array, String, Number, Boolean, Error, RegExp, Map, Set,
    Promise, Symbol, Uint8Array, Uint8ClampedArray, Int32Array, Float32Array, Float64Array,
    Blob: function () {}, URL: { createObjectURL: () => 'blob:stub', revokeObjectURL: noop },
    Worker: function () { throw new Error('stub: no worker'); },
    navigator: { hardwareConcurrency: 8, userAgent: 'node' },
    location: { protocol: 'file:', href: 'file:///dist/index.html' },
    innerWidth: 1600, innerHeight: 800,
    devicePixelRatio: 1,
    alert: noop,
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => makeEl(),
      createElementNS: () => makeEl(),
      addEventListener: noop,
      body: makeEl(),
      documentElement: makeEl(),
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.addEventListener = noop;
  sandbox.removeEventListener = noop;
  const ctx = vm.createContext(sandbox);

  // 只跑到 editor.js 为止：renderer/globe/main 需要真实 DOM 与 WebGL
  const STOP_MARK = 'FM.MapEditor = MapEditor';
  let ran = 0;
  let error = null;
  for (const block of scriptBlocks) {
    if (block.includes('window.__FM_WORKER_SRC__')) { ran++; continue; }
    try {
      vm.runInContext(block, ctx, { timeout: 20000 });
      ran++;
    } catch (err) {
      error = err;
      break;
    }
    if (block.includes(STOP_MARK)) break;
  }
  check('脚本按序执行无异常', !error, error ? error.message : ran + ' 块');
  if (error) console.log('    ' + (error.stack || '').split('\n').slice(0, 4).join('\n    '));

  const FM = sandbox.FM || {};
  const need = ['Terrain', 'ClimateSystem', 'Hydrology', 'MapGenerator', 'MapRenderer', 'TerrainOps', 'MapEditor', 'Projector', 'classifyBiome'];
  const missing = need.filter((k) => !FM[k]);
  check('关键模块全部挂载', missing.length === 0, missing.length ? '缺 ' + missing.join(',') : need.length + ' 个');
  check('THREE 已内联可用', typeof sandbox.THREE !== 'undefined', typeof sandbox.THREE !== 'undefined' ? 'ok' : '未定义');

  // ---------- 3. 内联 Worker 行为一致性 ----------
  console.log('\n【3】内联 Worker 与源码版逐位一致');

  // 参考值：源码版本的 terrain.js
  globalThis.window = globalThis;
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'js/vendor/simplex-noise.js'), 'utf8'));
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'js/terrain.js'), 'utf8'));
  const Terrain = globalThis.FM.Terrain;

  const W = 480;
  const H = 240;
  const seed = 'build-check-7';
  const plates = [];
  for (let i = 0; i < 6; i++) {
    const px = 0.18 + i * 0.12;
    const py = (i % 2 === 0 ? 1 : -1) * 0.2;
    const pLon = px * Math.PI * 2;
    const pLat = py * Math.PI;
    plates.push({
      x: px, y: py,
      x3: Math.cos(pLat) * Math.cos(pLon),
      y3: Math.sin(pLat),
      z3: Math.cos(pLat) * Math.sin(pLon),
      type: i < 3 ? 'continental' : 'oceanic',
      heightOffset: (i < 3 ? 0.055 : -0.055) + (i - 2.5) * 0.004,
    });
  }
  const simplex = new globalThis.SimplexNoise(seed);
  const reference = Terrain.computeBand({ W, H, plates, simplex, rowStart: 0, rowEnd: H });

  const LOADER = `
'use strict';
const { parentPort } = require('worker_threads');
global.self = global;
self.postMessage = (msg, transfer) => parentPort.postMessage(msg, transfer);
global.importScripts = function () {};
/* ---- 以下为产物里的内联 worker 源码 ---- */
${workerSource}
/* ---- 结束 ---- */
parentPort.on('message', (m) => self.onmessage({ data: m }));
`;
  const part = await new Promise((resolve, reject) => {
    const w = new Worker(LOADER, { eval: true });
    w.once('message', (msg) => {
      w.terminate();
      if (msg.error) reject(new Error(msg.error));
      else resolve(new Float32Array(msg.buffer));
    });
    w.once('error', reject);
    w.postMessage({ W, H, plates, seed, rowStart: 0, rowEnd: H });
  });

  let diff = 0;
  let maxAbs = 0;
  for (let i = 0; i < reference.length; i++) {
    if (reference[i] !== part[i]) {
      diff++;
      const d = Math.abs(reference[i] - part[i]);
      if (d > maxAbs) maxAbs = d;
    }
  }
  check('内联 Worker 能跑出结果', part.length === W * H, part.length + ' 个值');
  check('与源码版逐位一致', diff === 0, diff === 0 ? 'diff 0' : diff + ' 处不一致，max ' + maxAbs);

  console.log('\n' + '='.repeat(74));
  console.log((failed === 0 ? 'PASS' : 'FAIL') + '  ' + passed + '/' + (passed + failed) + ' 项通过');
  console.log('='.repeat(74));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n💥 验证异常：');
  console.error(err && err.stack || err);
  process.exit(1);
});
