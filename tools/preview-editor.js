#!/usr/bin/env node
/**
 * preview-editor.js —— 把编辑结果渲染成 PNG，用来「看」而不是猜
 *
 * 【为什么要有这个】
 * 本机启动不了浏览器，编辑器的实际观感本来无从检验。但地形数据是纯数值的，
 * 把高度场渲成图片就能直接看。
 *
 * 【配色不再自己编】早期版本自带一套色表，结果 0.80~0.90 这段渲染成灰色，
 * 看着像锡纸 —— 而项目真实的色表在这段是**深褐**，雪线只在最顶上。
 * 现在直接把 renderer.js 的 TERRAIN_COLORS 抠出来用（见 lib-apprender.js），
 * 色表、光照方向、起伏夸张倍数、增益区间全部与 app 一致。
 *
 * 【海平面也照 app 来】app 的地形 e 落在 0.93~1.0，陆地只有 7% 的高度空间。
 * 预览若用 0.34 的海平面，同一笔山在图上占的高度比例就完全不同，
 * 颜色分带也就对不上。
 *
 * 画三块做对比：
 *   左  旧圆盘笔刷（无侵蚀）—— 一串圆叠出来的圆柱
 *   中  新笔刷（无侵蚀）—— 有走向、有不对称横剖面、有山体基座
 *   右  新笔刷 + 侵蚀 —— 碎石坡把山脚摊开、沟谷切出纹理
 *
 * 用法：node tools/preview-editor.js [输出路径]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PNG = require('./lib-png');
const AppRender = require('./lib-apprender');

// ---------- 加载算子 ----------
globalThis.self = globalThis;
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'hypsometry.js'), 'utf8'));
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'terrain-ops.js'), 'utf8'));
const Ops = globalThis.FM.TerrainOps;

// ---------- 场景 ----------
const PW = 440;
const PH = 380;
const GAP = 8;
// 与 app 同量级：陆地只占最上面一小段，海平面 0.93
const SEA = 0.93;
const LAND_ROOM = 1 - SEA;

function makeTerrain(seed) {
  const cells = new Array(PW * PH);
  for (let y = 0; y < PH; y++) {
    for (let x = 0; x < PW; x++) {
      // 一片低缓的陆地：起伏只有百分之几，和 app 里自动生成的地形同量级
      const base = SEA + 0.004
        + Ops.fbm(x / 80, y / 80, 4, 2, 0.5, seed) * LAND_ROOM * 0.10
        + Ops.fbm(x / 22, y / 22, 3, 2, 0.5, seed + 91) * LAND_ROOM * 0.03;
      cells[y * PW + x] = { x, y, e: base, temp: 0.6, m: 0.5, isRiver: false, isLake: false };
    }
  }
  return cells;
}

/** 旧版：沿笔迹盖圆 */
function oldDiscStroke(cells, path, radius, amp) {
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(len / (radius / 3)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const cx = a.x + (b.x - a.x) * t;
      const cy = a.y + (b.y - a.y) * t;
      for (let y = Math.floor(cy - radius); y <= cy + radius; y++) {
        if (y < 0 || y >= PH) continue;
        for (let x = Math.floor(cx - radius); x <= cx + radius; x++) {
          if (x < 0 || x >= PW) continue;
          const d = Math.hypot(x - cx, y - cy);
          if (d > radius) continue;
          let f = 1 - d / radius;
          f = f * f * (3 - 2 * f);
          const c = cells[y * PW + x];
          const nv = Math.min(1, Ops.ridgedFbm(x * 0.06, y * 0.06, 3, 2, 0.5, 7) * 0.8 + 0.55);
          c.e = Math.min(1, c.e + f * amp * nv);
        }
      }
    }
  }
}

function newStroke(cells, path, radius, amp, doErode) {
  const walker = new Ops.StrokeWalker(radius * Ops.NODE_SPACING_RATIO);
  walker.begin(path[0].x, path[0].y);
  for (let i = 1; i < path.length; i++) walker.advance(path[i].x, path[i].y);
  const field = new Float32Array(PW * PH);
  const built = Ops.buildStrokeField(field, PW, PH, walker.nodes, { radius, seed: 20261020 });
  Ops.synthesize(cells, PW, PH, {
    field, box: built.box, mode: 'raise', amp, seaLevel: SEA,
    seed: 20261020, dirX: built.dirX, dirY: built.dirY, detailScale: 0.13,
  });
  if (doErode) {
    // 与编辑器完全同一份参数 —— 否则"看图调参"调的是另一套数字
    Ops.erode(cells, PW, PH, built.box, { seaLevel: SEA, ...Ops.EROSION_DEFAULTS });
  }
  return built;
}

// ---------- 组装 ----------

function main() {
  const outPath = process.argv[2] || path.join(__dirname, '..', 'dist', 'editor-preview.png');

  // 一条从左到右、带自然弯曲的笔迹
  const pathPts = [];
  for (let x = 70; x <= 380; x += 6) {
    pathPts.push({ x, y: 190 + Math.sin((x - 70) / 55) * 34 });
  }
  const radius = 52;
  const amp = Ops.amplitudeFor(0.42, radius, SEA);

  const c1 = makeTerrain(1001);
  oldDiscStroke(c1, pathPts, radius, amp * 1.15);

  const c2 = makeTerrain(1001);
  newStroke(c2, pathPts, radius, amp, false);

  const c3 = makeTerrain(1001);
  newStroke(c3, pathPts, radius, amp, true);

  const totalW = PW * 3 + GAP * 4;
  const totalH = PH + GAP * 2;
  const img = new Uint8Array(totalW * totalH * 3);
  for (let i = 0; i < totalW * totalH; i++) {
    img[i * 3] = 16; img[i * 3 + 1] = 20; img[i * 3 + 2] = 26;
  }

  // 【为什么要放大】山体只占画面一小块，1:1 看过去只有一撮褐色斑点，
  // 纹理、山麓的过渡、雪线边缘全都糊在一起。裁出山体附近一块再放大 2 倍，
  // 才看得出「是不是自然」。
  const CROP = { x0: 130, y0: 128, w: 220, h: 190 };
  const SCALE = 2;

  const panels = [c1, c2, c3];
  for (let p = 0; p < 3; p++) {
    const px = GAP + p * (PW + GAP);
    const py = GAP;
    const buf = AppRender.renderRegion(panels[p], PW, PH, { sea: SEA, depthSpan: 0.55 * (1 - SEA) * 2 });
    for (let y = 0; y < CROP.h * SCALE; y++) {
      const sy = CROP.y0 + ((y / SCALE) | 0);
      for (let x = 0; x < CROP.w * SCALE; x++) {
        const sx = CROP.x0 + ((x / SCALE) | 0);
        const s = (sy * PW + sx) * 3;
        const d = ((py + y) * totalW + px + x) * 3;
        img[d] = buf[s]; img[d + 1] = buf[s + 1]; img[d + 2] = buf[s + 2];
      }
    }
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, PNG.encode(totalW, totalH, img));

  // 量化对比
  const summarize = (cells, label) => {
    let peak = 0;
    let peakX = 0;
    let peakY = 0;
    let area = 0;
    const base = SEA + 0.004;
    for (let i = 0; i < cells.length; i++) {
      if (cells[i].e - base > LAND_ROOM * 0.05) area++;
      if (cells[i].e > peak) { peak = cells[i].e; peakX = i % PW; peakY = (i / PW) | 0; }
    }
    console.log('  ' + label.padEnd(16) +
      ' 峰值 landE ' + ((peak - SEA) / LAND_ROOM).toFixed(2) +
      ' @(' + peakX + ',' + peakY + ')   覆盖 ' + area + ' 格');
  };
  console.log('='.repeat(64));
  console.log('编辑结果预览 → ' + path.relative(path.join(__dirname, '..'), outPath));
  console.log('='.repeat(64));
  console.log('  尺寸 ' + totalW + '×' + totalH + '   笔刷半径 ' + radius +
    '   幅度 ' + amp.toFixed(4) + '（landE 增幅 ' + (amp / LAND_ROOM).toFixed(2) + '）');
  summarize(c1, '旧圆盘笔刷');
  summarize(c2, '新笔刷·未侵蚀');
  summarize(c3, '新笔刷·侵蚀后');
}

main();
