/**
 * projection.js —— 地图投影
 *
 * 地图数据始终是「等距经纬网格」（1600×800 对应经度 360°、纬度 180°），
 * 投影只发生在渲染阶段：把每个目标像素反算成经纬度，再采样数据网格。
 *
 * 为什么要做投影：
 *   等距圆柱投影（Plate Carrée）把极点那一「点」铺满整整一行，
 *   极地永远是一条横贯全图的直线/条带，无论怎么调噪声都无法消除。
 *   换用伪圆柱投影（如 Robinson / Mollweide）后，极点收缩为一点，
 *   高纬被纵向压缩，极地横条问题从几何上就不存在了。
 *
 * 所有投影都保证经度方向首尾相接（圆柱类），因此 X 轴仍可无缝环绕。
 */
(function (root) {
  'use strict';

  const FM = root.FM = root.FM || {};

  /**
   * 每个投影提供：
   *   forward(lon, lat) -> {x, y}  归一化到 [0,1]×[0,1]
   *   inverse(x, y)     -> {lon, lat} 经纬度（弧度），越界返回 null
   *   label            显示名
   */
  const PROJECTIONS = {
    /** 等距圆柱：传统的 2:1 地图，极点为整行 */
    equirect: {
      label: '等距圆柱',
      forward(lon, lat) {
        return { x: lon / (Math.PI * 2) + 0.5, y: 0.5 - lat / Math.PI };
      },
      inverse(x, y) {
        return { lon: (x - 0.5) * Math.PI * 2, lat: (0.5 - y) * Math.PI };
      },
    },

    /**
     * Robinson（罗宾逊）：1963 年由 Arthur H. Robinson 用手工查表定义的
     * 伪圆柱投影，纬线为平行直线、经线为曲线，明显压缩高纬。
     * 这里用一组多项式近似（误差 < 0.3%），并做归一化。
     */
    robinson: {
      label: '罗宾逊',
      // 纬度 0~90° 每 5° 的 X 缩放系数与 Y 位置（官方表）
      X: [1.0000, 0.9986, 0.9954, 0.9900, 0.9822, 0.9730, 0.9600, 0.9427,
        0.9216, 0.8962, 0.8679, 0.8350, 0.7986, 0.7597, 0.7186, 0.6732,
        0.6213, 0.5722, 0.5322],
      Y: [0.0000, 0.0620, 0.1240, 0.1860, 0.2480, 0.3100, 0.3720, 0.4340,
        0.4958, 0.5571, 0.6176, 0.6769, 0.7346, 0.7903, 0.8435, 0.8936,
        0.9394, 0.9761, 1.0000],
      forward(lon, lat) {
        const phi = Math.abs(lat);
        const t = (phi * 180) / Math.PI / 5; // 以 5° 为一格
        const k = Math.min(17, Math.floor(t));
        const f = t - k;
        // 该纬度处的经度缩放（极点附近 → 0，经线收拢）
        const xScale = this.X[k] + (this.X[k + 1] - this.X[k]) * f;
        // 该纬度对应的纵向位置（0=赤道, 1=极点）
        const yPos = this.Y[k] + (this.Y[k + 1] - this.Y[k]) * f;
        const sign = lat >= 0 ? -1 : 1;
        // 经度按 xScale 收缩后归一化到 [0,1]
        return {
          x: (lon / (Math.PI * 2)) * xScale + 0.5,
          y: 0.5 + sign * yPos * 0.5,
        };
      },
      inverse(x, y) {
        // 由 y 反推纬度：Y 表本身就是「归一化纵坐标（0=赤道, 1=极点）」，
        // 因此直接在 Y 上做逆插值；注意 y 是画布坐标（0=北,
        // 0.5=赤道, 1=南），要先换算成距赤道的归一化距离。
        const sign = y < 0.5 ? 1 : -1; // 北半球为正
        const yPos = Math.abs(y - 0.5) * 2; // 0~1，0=赤道，1=极点
        if (yPos > 1) return null;

        // 在 Y 表中二分/线性查找
        let k = 0;
        while (k < 17 && this.Y[k + 1] < yPos) k++;
        const span = Math.max(1e-6, this.Y[k + 1] - this.Y[k]);
        const f = (yPos - this.Y[k]) / span;
        const latDeg = (k + f) * 5;
        const xScale = this.X[k] + (this.X[k + 1] - this.X[k]) * f;

        // 经度：由 x 反算，需除以该纬度的经度缩放
        const lonNorm = (x - 0.5) / Math.max(1e-6, xScale);
        if (Math.abs(lonNorm) > 0.5) return null;
        return {
          lon: lonNorm * Math.PI * 2,
          lat: (sign * latDeg * Math.PI) / 180,
        };
      },
    },

    /**
     * Mollweide（摩尔威德）：等面积的椭圆投影，极点是椭圆两端的一个点，
     * 完全没有极地横条。用牛顿迭代解纬度。
     */
    mollweide: {
      label: '摩尔威德',
      forward(lon, lat) {
        const theta = this._theta(lat);
        // 关键：经度必须乘上椭圆在该纬度的半宽 cosθ，
        // 否则极点不会收拢，投影就退化成"上下压扁的矩形"。
        return {
          x: (lon / (Math.PI * 2)) * Math.cos(theta) + 0.5,
          y: 0.5 - Math.sin(theta) * 0.5,
        };
      },
      inverse(x, y) {
        const sinTheta = (0.5 - y) * 2;
        if (Math.abs(sinTheta) > 1) return null;
        const theta = Math.asin(Math.max(-1, Math.min(1, sinTheta)));
        const cosTheta = Math.cos(theta);
        // 极点处 cosθ→0，整个宽度收缩成一点
        const lonNorm = cosTheta < 1e-6 ? 0 : (x - 0.5) / cosTheta;
        if (Math.abs(lonNorm) > 0.5) return null;
        const lat = Math.asin(Math.max(-1, Math.min(1, (2 * theta + Math.sin(2 * theta)) / Math.PI)));
        return { lon: lonNorm * Math.PI * 2, lat };
      },
      /** 解 2θ + sin2θ = π sinφ */
      _theta(lat) {
        let theta = lat;
        for (let i = 0; i < 8; i++) {
          const denom = 2 + 2 * Math.cos(2 * theta);
          if (Math.abs(denom) < 1e-9) break;
          theta -= (2 * theta + Math.sin(2 * theta) - Math.PI * Math.sin(lat)) / denom;
        }
        return theta;
      },
    },
  };

  /**
   * 投影器：负责「目标像素 <-> 数据网格」的采样。
   * 对每个目标像素反算经纬度，再双线性采样数据网格。
   */
  class Projector {
    constructor(name, width, height) {
      this.setProjection(name, width, height);
    }

    setProjection(name, width, height) {
      this.name = PROJECTIONS[name] ? name : 'equirect';
      this.proj = PROJECTIONS[this.name];
      this.width = width;
      this.height = height;
      this.buildMap();
    }

    get label() {
      return this.proj.label;
    }

    /** 预先算好每个目标像素对应的数据网格坐标（性能关键） */
    buildMap() {
      const W = this.width;
      const H = this.height;
      const N = W * H;
      // 每个目标像素：源网格坐标 sx, sy（-1 表示画布外/投影外）
      this.sx = new Float32Array(N);
      this.sy = new Float32Array(N);
      this.valid = new Uint8Array(N);

      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          const nx = (x + 0.5) / W;
          const ny = (y + 0.5) / H;
          const ll = this.proj.inverse(nx, ny);
          if (!ll) { this.valid[i] = 0; continue; }

          // 经纬度 → 数据网格坐标
          let gx = (ll.lon / (Math.PI * 2) + 0.5) * W - 0.5;
          const gy = (0.5 - ll.lat / Math.PI) * H - 0.5;
          gx = ((gx % W) + W) % W; // 经度环绕
          if (gy < -1 || gy > H) { this.valid[i] = 0; continue; }
          this.sx[i] = gx;
          this.sy[i] = Math.max(0, Math.min(H - 1, gy));
          this.valid[i] = 1;
        }
      }
    }

    /** 采样：对 gx,gy 做双线性插值，回调拿到四个邻格的插值权重 */
    sampleBilinear(gx, gy, W, H, out) {
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const fx = gx - x0;
      const fy = gy - y0;

      const xa = ((x0 % W) + W) % W;
      const xb = ((x0 + 1) % W + W) % W;
      const ya = Math.max(0, Math.min(H - 1, y0));
      const yb = Math.max(0, Math.min(H - 1, y0 + 1));

      out.i00 = ya * W + xa;
      out.i10 = ya * W + xb;
      out.i01 = yb * W + xa;
      out.i11 = yb * W + xb;
      out.w00 = (1 - fx) * (1 - fy);
      out.w10 = fx * (1 - fy);
      out.w01 = (1 - fx) * fy;
      out.w11 = fx * fy;
      return out;
    }
  }

  FM.PROJECTIONS = PROJECTIONS;
  FM.Projector = Projector;
})(window);
