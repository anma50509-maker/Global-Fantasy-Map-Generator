/**
 * tools/verify-parallel.js —— 验证地形并行计算的正确性（无需浏览器）
 *
 * 用 worker_threads + 一个 importScripts 垫片，把**真实的** terrain-worker.js
 * 跑起来，与单线程整段计算的结果逐位比对：
 *   1. 4 个线程各算一条行带，拼回整张图；
 *   2. 与一次性整段计算得到的 Float32Array 逐元素比较；
 *   3. 额外检查相邻行带交界处的行间差是否与内部一致（不能出现台阶）。
 *
 * 如果这一步通过，就可以确信浏览器里的并行与单线程结果完全一致。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Worker } = require('worker_threads');

const JS_DIR = path.resolve(__dirname, '..', 'js');

// ---- 主线程侧的 window 垫片（terrain.js 是浏览器脚本） ----
globalThis.window = globalThis;
vm.runInThisContext(fs.readFileSync(path.join(JS_DIR, 'vendor/simplex-noise.js'), 'utf8'));
vm.runInThisContext(fs.readFileSync(path.join(JS_DIR, 'terrain.js'), 'utf8'));
const Terrain = globalThis.FM.Terrain;

const LOADER = `
'use strict';
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

global.self = global;
global.window = global;
global.importScripts = function (...files) {
  for (const f of files) {
    const code = fs.readFileSync(path.join(workerData.base, f), 'utf8');
    vm.runInThisContext(code, { filename: f });
  }
};
self.postMessage = (msg, transfer) => parentPort.postMessage(msg, transfer);
parentPort.on('message', (m) => { self.onmessage({ data: m }); });
importScripts('terrain-worker.js');
`;

function runWorker(base, msg) {
  return new Promise((resolve, reject) => {
    const w = new Worker(LOADER, { eval: true, workerData: { base } });
    w.once('message', (m) => {
      w.terminate();
      if (m.error) reject(new Error(m.error));
      else resolve(new Float32Array(m.buffer));
    });
    w.once('error', reject);
    w.postMessage(msg);
  });
}

async function main() {
  const W = 1600;
  const H = 800;
  const seed = 'verify-seed-42';

  // 与 MapGenerator#createPlates 同构的板块数据（这里手写固定值，只为可复现）
  const plates = [];
  for (let i = 0; i < 6; i++) {
    const px = 0.15 + i * 0.13;
    const py = (i % 2 === 0 ? 1 : -1) * 0.22 + i * 0.02;
    const pLon = px * Math.PI * 2;
    const pLat = py * Math.PI;
    plates.push({
      x: px,
      y: py,
      x3: Math.cos(pLat) * Math.cos(pLon),
      y3: Math.sin(pLat),
      z3: Math.cos(pLat) * Math.sin(pLon),
      type: i < 3 ? 'continental' : 'oceanic',
      heightOffset: (i < 3 ? 0.055 : -0.055) + (i - 2.5) * 0.004,
    });
  }

  // ---- 参考：单线程整段计算 ----
  const t0 = performance.now();
  const simplex = new globalThis.SimplexNoise(seed);
  const reference = Terrain.computeBand({ W, H, plates, simplex, rowStart: 0, rowEnd: H });
  const singleMs = performance.now() - t0;

  // ---- 4 线程分段计算 ----
  const threads = 4;
  const bandRows = Math.ceil(H / threads);
  const t1 = performance.now();
  const jobs = [];
  for (let i = 0; i < threads; i++) {
    const rowStart = i * bandRows;
    const rowEnd = Math.min(H, rowStart + bandRows);
    jobs.push(runWorker(JS_DIR, { W, H, plates, seed, rowStart, rowEnd }));
  }
  const parts = await Promise.all(jobs);
  const parallel = new Float32Array(W * H);
  let offset = 0;
  for (const p of parts) {
    parallel.set(p, offset);
    offset += p.length;
  }
  const parallelMs = performance.now() - t1;

  // ---- 逐位比对 ----
  if (offset !== W * H) throw new Error('拼接长度不符：' + offset);
  let diff = 0;
  let maxAbs = 0;
  for (let i = 0; i < reference.length; i++) {
    const a = reference[i];
    const b = parallel[i];
    if (a !== b) {
      diff++;
      const d = Math.abs(a - b);
      if (d > maxAbs) maxAbs = d;
    }
  }

  // ---- 交界行间差：行带交界不应出现台阶 ----
  const rowMeanAbs = (arr, y) => {
    let s = 0;
    for (let x = 0; x < W; x++) s += Math.abs(arr[y * W + x] - arr[(y - 1) * W + x]);
    return s / W;
  };
  const seams = [];
  for (let i = 1; i < threads; i++) {
    const y = i * bandRows;
    seams.push({ row: y, step: +rowMeanAbs(parallel, y).toFixed(5) });
  }
  const interior = [];
  for (let y = 40; y < H; y += 97) interior.push(+rowMeanAbs(reference, y).toFixed(5));
  const interiorAvg = interior.reduce((a, b) => a + b, 0) / interior.length;

  console.log(JSON.stringify({
    size: W + 'x' + H,
    threads,
    singleThreadMs: +singleMs.toFixed(0),
    parallelMs: +parallelMs.toFixed(0),
    speedup: +(singleMs / parallelMs).toFixed(2),
    identical: diff === 0,
    diffCount: diff,
    maxAbsDiff: maxAbs,
    seamSteps: seams,
    interiorRowStepAvg: +interiorAvg.toFixed(5),
    verdict: diff === 0 ? 'PASS 并行与单线程逐位一致' : 'FAIL 结果不一致',
  }, null, 2));

  if (diff !== 0) process.exit(1);
}

main().catch((e) => {
  console.error('VERIFY FAILED:', e && e.stack || e);
  process.exit(1);
});
