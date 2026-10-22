/**
 * lib-apprender.js —— 用**项目自己的配色与光照参数**把高度场渲成图
 *
 * 【为什么要这个】早先 preview-editor.js 自己编了一套色表，结果
 * 「灰色一大片」看起来像锡纸，而真实的 app 里 0.80~0.90 这段是**深褐**
 * （见 renderer.js 的 TERRAIN_COLORS），雪线只在最顶上。用假色表调参，
 * 调出来的东西和用户看到的根本不是一回事。
 *
 * 这里的色表不是在代码里抄一份 —— 而是从 renderer.js 源码里正则抠出来
 * 再 eval，这样 renderer.js 改了色表，预览自动跟着变，不会漂。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const RENDERER = path.join(__dirname, '..', 'js', 'renderer.js');

function loadTerrainColors() {
  const src = fs.readFileSync(RENDERER, 'utf8');
  const m = src.match(/const TERRAIN_COLORS = (\[[\s\S]*?\]);/);
  if (!m) throw new Error('renderer.js 里找不到 TERRAIN_COLORS');
  // 只含字面量对象，eval 是安全的
  return new Function('return ' + m[1])();
}

const TERRAIN_COLORS = loadTerrainColors();

// 与 renderer.js shade() 保持一致的光照常量。
// 【S 也必须从源码抠】早先这里写死 34，而 renderer.js 改成 110 之后
// 预览图一直是「平涂色块」，跟用户看到的完全不是一回事 —— 又一个
// "拿假参数调参"的坑。现在跟色表一样，直接读源码。
const S = (() => {
  const src = fs.readFileSync(RENDERER, 'utf8');
  const m = src.match(/const S = ([0-9.]+);/);
  if (!m) throw new Error('renderer.js 里找不到山体光照常量 S');
  return parseFloat(m[1]);
})();
const LX = -0.617;         // 西北光源（已归一化）
const LY = -0.617;
const LZ = 0.487;
const SHADE_MIN = 0.50;
const SHADE_MAX = 1.22;

/** landE → [r,g,b]（与 renderer.js 的等高线色带分支逐行等价） */
function landColor(landE) {
  let lo = TERRAIN_COLORS[0];
  let hi = TERRAIN_COLORS[TERRAIN_COLORS.length - 1];
  for (let k = 0; k < TERRAIN_COLORS.length; k++) {
    if (landE <= TERRAIN_COLORS[k].limit) {
      hi = TERRAIN_COLORS[k];
      lo = k === 0 ? TERRAIN_COLORS[0] : TERRAIN_COLORS[k - 1];
      break;
    }
  }
  const loLimit = lo === TERRAIN_COLORS[0] ? 0 : lo.limit;
  const hiLimit = hi.limit;
  let t = hiLimit > loLimit ? (landE - loLimit) / (hiLimit - loLimit) : 0;
  t = Math.max(0, Math.min(1, t));
  t = t * t * (3 - 2 * t);
  return [lo.r + (hi.r - lo.r) * t, lo.g + (hi.g - lo.g) * t, lo.b + (hi.b - lo.b) * t];
}

/** 海色（简版：只按深度给渐变，忽略大陆架与纬度的气氛修饰） */
function seaColor(depthNorm) {
  const ramp = [
    { at: 0.00, r: 44, g: 126, b: 172 },
    { at: 0.18, r: 32, g: 108, b: 162 },
    { at: 0.42, r: 24, g: 92, b: 150 },
    { at: 0.68, r: 18, g: 74, b: 136 },
    { at: 1.00, r: 14, g: 56, b: 112 },
  ];
  const d = Math.max(0, Math.min(1, depthNorm));
  let lo = ramp[0], hi = ramp[ramp.length - 1];
  for (let k = 0; k < ramp.length - 1; k++) {
    if (d >= ramp[k].at && d <= ramp[k + 1].at) { lo = ramp[k]; hi = ramp[k + 1]; break; }
  }
  let t = hi.at > lo.at ? (d - lo.at) / (hi.at - lo.at) : 0;
  t = t * t * (3 - 2 * t);
  return [lo.r + (hi.r - lo.r) * t, lo.g + (hi.g - lo.g) * t, lo.b + (hi.b - lo.b) * t];
}

/**
 * 渲染一块区域。
 * @param {Array} cells 每格 {e}
 * @param {number} W
 * @param {number} H
 * @param {{sea:number, depthSpan:number, out:Uint8Array}} opt
 */
function renderRegion(cells, W, H, opt) {
  const sea = opt.sea;
  const depthSpan = opt.depthSpan != null ? opt.depthSpan : 0.35;
  const out = opt.out || new Uint8Array(W * H * 3);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const e = cells[i].e;
      let r, g, b;
      if (e < sea) {
        [r, g, b] = seaColor((sea - e) / depthSpan);
      } else {
        const landE = (e - sea) / (1 - sea);
        [r, g, b] = landColor(landE);

        // 山体阴影：中心差分 + 兰伯特，四周全陆地才算（与 renderer.js 一致）
        if (x > 0 && x < W - 1 && y > 0 && y < H - 1) {
          const l = cells[i - 1], rr = cells[i + 1];
          const u = cells[i - W], d = cells[i + W];
          if (l.e >= sea && rr.e >= sea && u.e >= sea && d.e >= sea) {
            const gx = (rr.e - l.e) * 0.5;
            const gy = (d.e - u.e) * 0.5;
            const nx = -gx * S, ny = -gy * S, nz = 1;
            const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
            const dot = (nx * LX + ny * LY + nz * LZ) / nlen;
            const shade = dot / LZ;
            const k = Math.max(SHADE_MIN, Math.min(SHADE_MAX, 0.52 + shade * 0.46));
            r *= k; g *= k; b *= k;
          }
        }
      }
      const o = i * 3;
      out[o] = r < 0 ? 0 : r > 255 ? 255 : r;
      out[o + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
      out[o + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
    }
  }
  return out;
}

/**
 * 灰阶山体阴影（只画地形结构，不带任何色带）。
 *
 * 【为什么要单独一个】配色会把结构藏起来：一片 rel 0.02~0.05 的平原在
 * 色带上只有两三个色阶的差别，但它的真实起伏（有没有多余的皱褶）恰恰
 * 是"自然 / 不自然"的分水岭。去掉颜色之后，平原是不是真平、山是不是成链，
 * 一眼就能看出来。
 *
 * 光照与 renderer.js 的 shade() 同源（同 S、同光源、同压暗范围），
 * 所以这里的判断可以直接迁移到页面上。
 */
function renderHillshade(cells, W, H, opt) {
  const sea = opt.sea;
  const out = opt.out || new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const e = cells[i].e;
      let v;
      if (e < sea) {
        // 海面：中灰 + 深度微暗，让岸线可辨
        const d = Math.max(0, Math.min(1, (sea - e) / (0.55 * (1 - sea) * 2)));
        v = 96 - d * 26;
      } else {
        let shade = 0;
        if (x > 0 && x < W - 1 && y > 0 && y < H - 1) {
          const l = cells[i - 1], rr = cells[i + 1];
          const u = cells[i - W], d = cells[i + W];
          const gx = (rr.e - l.e) * 0.5;
          const gy = (d.e - u.e) * 0.5;
          const nx = -gx * S, ny = -gy * S, nz = 1;
          const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
          shade = (nx * LX + ny * LY + nz * LZ) / nlen / LZ;
        }
        const k = Math.max(SHADE_MIN, Math.min(SHADE_MAX, 0.52 + shade * 0.46));
        // 基色按相对高度略微提亮，方便看出高原/盆地
        const rel = (e - sea) / (1 - sea);
        v = (150 + Math.min(1, rel * 3.2) * 70) * k;
      }
      v = v < 0 ? 0 : v > 255 ? 255 : v;
      const o = i * 3;
      out[o] = v;
      out[o + 1] = v;
      out[o + 2] = v;
    }
  }
  return out;
}

module.exports = { renderRegion, renderHillshade, landColor, seaColor, TERRAIN_COLORS };
