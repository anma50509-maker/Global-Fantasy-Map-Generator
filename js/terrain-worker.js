/**
 * terrain-worker.js —— 地形行带的并行计算线程
 *
 * 主线程把「整张图」按行切成若干条带，每个 worker 算一条，算完把
 * Float32Array 的 buffer 转移回来（transferable，零拷贝）。
 *
 * 关键约定：所有 worker 必须收到**同一个 seed**，从而构造出完全相同的
 * SimplexNoise 置换表；否则相邻行带会来自不同的噪声宇宙，
 * 交界处会出现一条肉眼可见的错位缝。
 */
'use strict';

// simplex-noise 2.4.0 的 UMD 尾巴只有在 `window` 存在时才挂到全局对象上；
// worker 里没有 window，这里做个别名，避免它静默地什么都不导出。
self.window = self;

importScripts('vendor/simplex-noise.js', 'terrain.js');

// UMD 兜底：浏览器 worker 里 exports 不存在，库会挂到 window(=self) 上；
// 但少数运行环境（Node worker_threads、某些打包器垫片）会存在 exports，
// 库就改挂到 exports.SimplexNoise，此时手动取回到全局。
if (typeof SimplexNoise === 'undefined' && typeof exports !== 'undefined' && exports.SimplexNoise) {
  self.SimplexNoise = exports.SimplexNoise;
}

self.onmessage = function (e) {
  const msg = e.data || {};
  try {
    const simplex = new SimplexNoise(msg.seed);
    const band = FM.Terrain.computeBand({
      W: msg.W,
      H: msg.H,
      plates: msg.plates,
      simplex,
      rowStart: msg.rowStart,
      rowEnd: msg.rowEnd,
    });
    // 转移所有权，避免复制 1.28M/线程 个浮点数
    self.postMessage({ buffer: band.buffer }, [band.buffer]);
  } catch (err) {
    self.postMessage({ error: (err && err.message) || String(err) });
  }
};
