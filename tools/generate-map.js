#!/usr/bin/env node
/**
 * generate-map.js —— 生成一张完整世界地图并存成 PNG
 *
 * 用法：node tools/generate-map.js [seed] [outPath]
 *
 * 复用项目自己的生成管线与渲染器（不重写逻辑），
 * 只做一件事：跑一遍 MapGenerator，然后把地形 + 山体阴影合成一张图。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const PNG = require('./lib-png');
const AppRender = require('./lib-apprender');

const W = 1600;
const H = 800;

// ==================== 假 DOM ====================

function makeFakeCanvas() {
  const canvas = { width: W, height: H, style: {} };
  canvas.getContext = () => makeFakeCtx(canvas);
  return canvas;
}

function makeFakeCtx(canvas) {
  const noop = () => {};
  const ctx = {
    canvas,
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    globalAlpha: 1,
    font: '10px sans-serif',
  };
  ctx.createImageData = (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
  ctx.getImageData = (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
  ctx.putImageData = noop;
  ctx.beginPath = noop;
  ctx.closePath = noop;
  ctx.moveTo = noop;
  ctx.lineTo = noop;
  ctx.arc = noop;
  ctx.rect = noop;
  ctx.fill = noop;
  ctx.stroke = noop;
  ctx.fillRect = noop;
  ctx.clearRect = noop;
  ctx.save = noop;
  ctx.restore = noop;
  ctx.translate = noop;
  ctx.scale = noop;
  ctx.drawImage = noop;
  ctx.createLinearGradient = () => ({ addColorStop: noop });
  ctx.createRadialGradient = () => ({ addColorStop: noop });
  ctx.measureText = () => ({ width: 10 });
  ctx.fillText = noop;
  ctx.setLineDash = noop;
  return ctx;
}

function installFakeDom() {
  globalThis.window = globalThis;
  globalThis.document = {
    createElement: (tag) => (tag === 'canvas' ? makeFakeCanvas() : { style: {}, appendChild() {} }),
    getElementById: () => null,
  };
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 16);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  globalThis.OffscreenCanvas = function () { return makeFakeCanvas(); };
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

// ==================== 主流程 ====================

async function main() {
  const seed = process.argv[2] || 'fantasy-' + Date.now();
  const outPath = process.argv[3] || path.join(ROOT, 'dist', 'generated-map.png');

  installFakeDom();
  const FM = loadScripts();

  console.log(`种子: ${seed}`);
  console.log('生成中（板块 → 海平面 → 气候 → 水文 → 群系）…');

  const gen = new FM.MapGenerator(W, H);
  await gen.generate({ plateCount: 7, seaLevel: 0.62, seed }, (p) => {
    if (p && typeof p === 'object' && p.phase) process.stdout.write(`  ${p.phase}\n`);
  });

  const cells = gen.cells || gen.terrain?.cells || gen.state?.cells;
  if (!cells) {
    console.error('拿不到 cells，检查 MapGenerator 的输出字段');
    process.exit(1);
  }

  const sea = gen.seaLevel ?? 0.62;
  console.log('渲染地形…');
  // renderRegion 返回的是 RGB 三通道（Uint8Array(W*H*3)），且已经内置了山体阴影，
  // 不需要再叠一层——早先按 RGBA 处理导致数据错位，出来全是竖线。
  const rgb = AppRender.renderRegion(cells, W, H, { sea, depthSpan: 0.55 * (1 - sea) * 2 });

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, PNG.encode(W, H, rgb));
  const kb = (fs.statSync(outPath).size / 1024).toFixed(1);
  console.log(`完成: ${outPath} (${kb} KB, ${W}x${H})`);
}

main().catch((e) => {
  console.error('失败:', e && e.stack || e);
  process.exit(1);
});
