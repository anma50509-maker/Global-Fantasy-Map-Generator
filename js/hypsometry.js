/**
 * hypsometry.js —— 测高曲线（陆地高度分布）与海底深度曲线
 *
 * 【为什么单独一个文件】
 * 这两条曲线是**地形高度的标尺**，被两处代码同时依赖：
 *   · map-generator.js  生成时把陆地按分位重分布到测高曲线；
 *   · terrain-ops.js    选区塑形时把新造的大陆映射到同一条曲线。
 * 只要两边不是同一份数据，新造的大陆就会比周围的陆地高出一个数量级
 * （实测：塑形 rel 中位数 0.45，全世界陆地 0.041，差 11 倍）。
 *
 * 本项目已经因为"同一个物理量在两个模块各写一份"踩过两次坑
 * （气候的 LAPSE、渲染的 S），所以这里直接立成一个零依赖的小模块，
 * 谁用谁读 FM.HYPSO —— 不复制、不内联、不留"缺了就退回线性"的
 * 静默兜底（那只会让不同步的问题藏得更深）。
 *
 * 数据来自地球的真实分布：
 *   陆地：33% < 200 m、66% < 500 m、82% < 1000 m、93% < 2000 m；
 *         最高峰 8848 m 记作 1.0。
 *   海洋：p25 ≈ 0.17、p50 ≈ 0.38、p75 ≈ 0.66、p95 ≈ 0.94
 *         （单位同为"占 1 − seaLevel 的比例"，按 1000×500 实测标定）。
 */
(function (root) {
  'use strict';

  const FM = root.FM = root.FM || {};

  /** 陆地测高曲线：分位 → 相对高度（0 = 海平面，1 = 最高峰） */
  const LAND_CURVE = [
    [0.00, 0.000], [0.33, 0.023], [0.66, 0.057], [0.82, 0.113],
    [0.93, 0.226], [0.97, 0.339], [0.995, 0.600], [1.00, 1.000],
  ];

  /** 海底深度曲线：分位 → 深度（单位同 rel，即占 1 − seaLevel 的比例） */
  const SEA_CURVE = [
    [0.00, 0.000], [0.10, 0.030], [0.25, 0.170], [0.50, 0.380],
    [0.75, 0.660], [0.95, 0.940], [1.00, 1.600],
  ];

  /** 分段线性插值。比逐格二分查找快，也便于在别处建 LUT。 */
  function interp(curve, r, last) {
    if (!(r > 0)) return curve[0][1];
    if (r >= 1) return last;
    for (let k = 1; k < curve.length; k++) {
      if (r <= curve[k][0]) {
        const [r0, v0] = curve[k - 1];
        const [r1, v1] = curve[k];
        const t = (r - r0) / Math.max(1e-9, r1 - r0);
        return v0 + (v1 - v0) * t;
      }
    }
    return last;
  }

  FM.HYPSO = {
    landCurve: LAND_CURVE,
    seaCurve: SEA_CURVE,
    /** 分位 → 陆地相对高度 */
    rel: (r) => Math.pow(interp(LAND_CURVE, r, 1), 0.85),
    /** 分位 → 海底深度（正数） */
    sea: (r) => interp(SEA_CURVE, r, 1.6),
  };
})(typeof window !== 'undefined' ? window : self);
