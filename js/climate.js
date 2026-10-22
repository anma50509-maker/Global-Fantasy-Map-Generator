/**
 * climate.js —— 大气环流 / 季风 / 洋流 / 气候与生态循环
 *
 * 旧实现在 map-generator 里用一段内联循环完成，「风」只是按纬度取 ±1 的
 * 水平方向，洋流只用于给海面温度加减 0.15，季风完全不存在，也不参与
 * 蒸发/降水/植被的完整循环。
 *
 * 本模块按真实气候系统重建，分五个阶段：
 *
 *   1. 行星风带（三圈环流）
 *      副热带高压、西风带、信风带、极地东风，含季节偏移。
 *
 *   2. 季风系统（海陆热力差异）
 *      季风本质是「海陆比热差」：夏季陆地升温快 → 低压 → 风从海洋吹向陆地；
 *      冬季相反。这里用「陆地热惯性」计算海陆温差，再叠加到风场，
 *      产生随季节反转的季风环流，并让降水随季节迁移（雨季/旱季）。
 *
 *   3. 洋流（热盐环流 + 风生环流）
 *      风应力驱动表层流（Ekman 输运近似）+ 边界流加强（西边界流）
 *      + 热盐环流（暖流/寒流沿经向输运热量）。
 *
 *   4. 水汽输运与降水
 *      水汽从海洋蒸发 → 随风输运 → 遇山抬升（地形雨）→ 背风坡雨影
 *      → 内陆干燥。季风把大量水汽输送到大陆内部，形成季风气候区。
 *
 *   5. 生态反馈
 *      温度 × 湿度 → 潜在蒸散 → 实际植被类型；植被反过来影响反照率
 *      与蒸腾，形成干燥正反馈（沙漠自我维持）与湿润正反馈（雨林）。
 *
 * 输出（写回 cell）：
 *   temp 温度、m 湿度、precip 年降水量、windU/windV 年平均风矢量、
 *   current 洋流矢量、monsoon 季风强度、biome 生态群系。
 */
(function (root) {
  'use strict';

  const FM = root.FM = root.FM || {};

  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

  // 气温直减率：「相对高度 → 归一化温度」的系数。
  //
  // 【为什么必须是模块级常量】它要被两处**严格共享**：
  //   温度计算   t    -= rel * LAPSE
  //   群系分类   tSea  = t + rel * LAPSE   （还原「海平面等效温度」）
  // 两处系数只要不一致，tSea 就不再是纯粹的纬度代理 ——
  // 海拔会重新漏回纬度带判定，中纬高山又会被误判成极地冰盖。
  const LAPSE = 0.42;

  // 海温异常对水汽供给的影响强度（见 coastalSst / 水汽输运段）。
  // floor 乘以 exp(SST_MOIST · warm)：暖流岸 ×e^0.85≈2.3、寒流岸 ×e^-0.85≈0.43。
  const SST_MOIST = 0.85;

  // 近岸陆地空气向「海面平衡水汽值」靠拢的混合比例（见水汽输运段）。
  // 不能取 1：海岸不是海面，边界层只会被海洋逐渐同化。
  // 取 0.7 后，近岸空气约 3 遍就基本追上海面值，而海面值本身随离岸距离衰减。
  const SST_COAST_MIX = 0.45;

  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (e0, e1, x) => {
    const t = clamp01((x - e0) / (e1 - e0));
    return t * t * (3 - 2 * t);
  };

  // ==================== 场算子（平滑 / 去偏 / 去噪） ====================
  //
  // 【为什么气候模块必须自带这几个算子】
  // 气候场的每一步都用到了邻域：地形雨看相邻格高差、水汽沿风向上游取样、
  // 洋流做拉普拉斯平滑。只要有一步是「逐格」的，场上就会留下 1 格宽的
  // 高频结构 —— 气候图上表现为**发丝状脉络**（狭窄的湿线沿风向蔓延、
  // 线间大片平涂）和**迷彩斑块**（群系碎成几十格的小块）。
  //
  // 实测旧实现：降水在 50 格窗口内的局部标准差 0.197，温度只有 0.108；
  // 群系斑块中位数 39 格（等效半径仅 3.5 格），而真实气候区的尺度是
  // 几百公里。也就是说场上大部分「细节」并不是气候信号，而是数值噪声。
  //
  // 真实大气是连续介质，动量/热量/水汽的有效混合尺度远大于一格。
  // DOMAIN 因此显式提供三个算子，在算子层面把尺度拉回来：
  //   boxBlur    —— 可分离盒式模糊（O(N)，r 可到 8 以上）
  //   mixBlur    —— 按比例掺入模糊结果（扩散一步，保留部分原场）
  //   rowDemean  —— 逐行减均值（去掉「纬向系统性偏差」）

  /**
   * 可分离盒式模糊。横向上按经度环绕，纵向上两极 clamp。
   * 用滑动和实现，单次 O(N)，与半径无关。
   */
  function boxBlur(src, W, H, r) {
    if (r <= 0) return Float32Array.from(src);
    const tmp = new Float32Array(src.length);
    const out = new Float32Array(src.length);
    const inv = 1 / (2 * r + 1);
    for (let y = 0; y < H; y++) {
      const row = y * W;
      let sum = 0;
      for (let d = -r; d <= r; d++) sum += src[row + (((d % W) + W) % W)];
      for (let x = 0; x < W; x++) {
        tmp[row + x] = sum * inv;
        sum -= src[row + ((((x - r) % W) + W) % W)];
        sum += src[row + (((x + r + 1) % W + W) % W)];
      }
    }
    for (let x = 0; x < W; x++) {
      let sum = 0;
      for (let d = -r; d <= r; d++) sum += tmp[Math.max(0, Math.min(H - 1, d)) * W + x];
      for (let y = 0; y < H; y++) {
        out[y * W + x] = sum * inv;
        sum -= tmp[Math.max(0, Math.min(H - 1, y - r)) * W + x];
        sum += tmp[Math.max(0, Math.min(H - 1, y + r + 1)) * W + x];
      }
    }
    return out;
  }

  /** 扩散一步：src 与它的 r 半径模糊按 k 混合（k=0 原样，k=1 全模糊） */
  function mixBlur(src, W, H, r, k) {
    const b = boxBlur(src, W, H, r);
    const out = new Float32Array(src.length);
    const a = 1 - k;
    for (let i = 0; i < src.length; i++) out[i] = src[i] * a + b[i] * k;
    return out;
  }

  /**
   * 逐行（逐纬度）减去该行的均值，原地修改。
   *
   * 【为什么必须做】噪声场是 (nx, ny) 的固定函数，而陆地只占一部分经度。
   * 若某个纬度上的陆地恰好落在噪声高值区，该纬度**所有**陆地就会整体
   * 偏暖 X；反之偏冷 X。这与气候机制无关，纯粹是采样偏差。
   * 而南北半球的陆地经度分布不同（南半球陆地少、更偏），于是两个半球
   * 会得到方向不同的偏差 —— 表现出来就是「南半球无缘无故比北半球冷」。
   */
  function rowDemean(field, W, H) {
    for (let y = 0; y < H; y++) {
      const row = y * W;
      let s = 0;
      for (let x = 0; x < W; x++) s += field[row + x];
      const m = s / W;
      for (let x = 0; x < W; x++) field[row + x] -= m;
    }
    return field;
  }

  // ==================== 行星风带 ====================
  //
  // 真实的三圈环流（以赤道对称）：
  //   0°~30°  : 信风带（东北信风 / 东南信风）
  //   30°~60° : 西风带
  //   60°~90° : 极地东风带
  // 各带之间有气压带：赤道低压、副热带高压、副极地低压、极地高压。
  //
  // 返回 { u, v, pressure }，u 为纬向风（+ 向东），v 为经向风（+ 向北）。
  function planetaryWind(absLatDeg) {
    const lat = absLatDeg;
    let u;
    let v;
    let pressure;

    // 【关键】三个风带必须「相互重叠」而不是首尾相接。
    // 早期版本用 smoothstep(a,b) * (1 - smoothstep(c,d)) 分段拼接，
    // 结果在 0°、30°、60° 处两组 smoothstep 同时为 0/1，
    // 风速精确等于 0 —— 水汽无法通过，气候按纬度死板地分成条带。
    //
    // 现在用「高斯型风带」叠加：每个风带都是中心值 + 平滑钟形，
    // 在任何纬度都不会同时为零，风场连续且有重叠过渡区。
    //
    //   信风带  : 中心 15°，向西（负 u）、向赤道
    //   西风带  : 中心 45°，向东（正 u）、微弱向极
    //   极地东风: 中心 78°，向西、向赤道
    const gauss = (x, mu, sigma) => Math.exp(-(((x - mu) / sigma) ** 2));

    // 三条风带的强度（钟形包络）
    const tradeW = gauss(lat, 15, 13);   // 信风
    const westW = gauss(lat, 45, 14);    // 西风
    const polarW = gauss(lat, 78, 12);   // 极地东风

    // 纬向风：信风与极地东风向西，西风向东
    u = -0.85 * tradeW + 0.95 * westW - 0.55 * polarW;

    // 经向风：信风与极地东风都向赤道（北半球向南，即负 v）
    // 西风带微弱向极
    v = -0.50 * tradeW + 0.14 * westW - 0.12 * polarW;

    // 气压带：赤道低压(0.30，上升) / 副热带高压(0.95，下沉)
    //        / 副极地低压(0.35) / 极地高压(0.90)
    // 同样用钟形叠加，避免分段跳变
    pressure =
      0.30 +
      0.65 * gauss(lat, 32, 11) +  // 副热带高压
      0.05 * gauss(lat, 90, 16) -  // 极地高压（略升）
      0.0 * gauss(lat, 0, 8);      // 赤道低压（基准）

    // 极区保护：原实现写成 if (lat > 88) u = -0.5，是一处**硬赋值**，
    // 会让最靠近极点的两行风速突然跳到 -0.5，水汽输运整行改变，
    // 在气候图上下边缘留下一条横向截段。
    // 改为平滑地向 -0.5 收敛，极点处仍保持极地东风，但没有跳变。
    const tt = Math.max(0, Math.min(1, (lat - 84) / 6));
    const polarPull = tt * tt * (3 - 2 * tt);   // smoothstep(84, 90)
    u = u * (1 - polarPull) + (-0.5) * polarPull;

    return { u, v, pressure };
  }

  // ==================== 季风 ====================
  //
  // 海陆热力差异是季风的根本原因：陆地比热小、升温快。
  // summerTilt（0~1）表示"北半球夏季"的程度，用来切换风向。
  //
  // 计算思路：
  //   对每个格点，取它所在纬度带内「陆地占比」，
  //   陆地占比高 → 夏季升温更强 → 低压更明显 → 风从海洋吹向陆地。
  //   这个"海陆压力差"叠加到行星风场上，就得到季风环流。
  //
  // 同时给出 monsoonStrength（季风强度），供降水阶段使用：
  // 季风强的区域，雨季降水显著增加；冬季转为旱季。
  function monsoonField(cells, W, H, seaLevel, summerTilt) {
    const N = W * H;
    const landFrac = new Float32Array(H); // 每条纬度的陆地占比
    for (let y = 0; y < H; y++) {
      let land = 0;
      for (let x = 0; x < W; x++) {
        if (cells[y * W + x].e >= seaLevel) land++;
      }
      landFrac[y] = land / W;
    }
    // 经向平滑，避免纬度带之间突变
    const smoothFrac = new Float32Array(H);
    for (let y = 0; y < H; y++) {
      let sum = 0;
      let cnt = 0;
      for (let d = -3; d <= 3; d++) {
        const yy = y + d;
        if (yy < 0 || yy >= H) continue;
        sum += landFrac[yy];
        cnt++;
      }
      smoothFrac[y] = sum / cnt;
    }

    const du = new Float32Array(N); // 季风纬向分量
    const dv = new Float32Array(N); // 季风经向分量
    const strength = new Float32Array(N);

    for (let y = 0; y < H; y++) {
      const latDeg = (0.5 - y / H) * 180; // +90 ~ -90
      const absLat = Math.abs(latDeg);
      // 季风主要发生在低中纬（约 5°~35°），高纬几乎没有季风
      const latBand = smoothstep(2, 12, absLat) * (1 - smoothstep(32, 45, absLat));
      if (latBand <= 0.001) continue;

      const frac = smoothFrac[y];
      // 海陆热力差：陆地多 → 夏季更热（低压）、冬季更冷（高压）。
      // 系数要足够大，否则季风信号会被行星风带淹没。
      // 取 3.2：陆地占比 0 → -1.1，占比 1 → +2.1。
      const thermal = (frac - 0.35) * 3.2;
      // 夏季风从海洋吹向陆地（向"内陆"方向），这里用梯度近似。
      //
      // 【性能优化】旧实现对每个格点都向左右扫描数组找最近陆地，
      // 最坏情况单行 O(W^2)，整图 O(W^2·H) = 20 亿次操作，
      // 是气候阶段 7.6 秒耗时的主要来源。
      // 改为「每行只扫描两遍」预处理出左右最近的陆地位置，
      // 复杂度降到 O(W·H)，提速约两个数量级。
      const nearestLandL = new Int32Array(W);
      const nearestLandR = new Int32Array(W);
      for (let x = 0; x < W; x++) { nearestLandL[x] = -1; nearestLandR[x] = -1; }
      // 从左往右：记录最近陆地
      let lastLand = -1;
      for (let x = 0; x < W; x++) {
        if (cells[y * W + x].e >= seaLevel) lastLand = x;
        nearestLandL[x] = lastLand;
      }
      // 处理环绕：左侧没找到时从右边绕过来（用负值表示）
      if (lastLand >= 0) {
        for (let x = 0; x < W && nearestLandL[x] < 0; x++) nearestLandL[x] = lastLand - W;
      }
      // 从右往左
      lastLand = -1;
      for (let x = W - 1; x >= 0; x--) {
        if (cells[y * W + x].e >= seaLevel) lastLand = x;
        nearestLandR[x] = lastLand;
      }
      if (lastLand >= 0) {
        for (let x = W - 1; x >= 0 && nearestLandR[x] < 0; x--) nearestLandR[x] = lastLand + W;
      }
      for (let x = 0; x < W; x++) {
        const idx = y * W + x;
        const isLand = cells[idx].e >= seaLevel;
        // 用预处理结果直接算向陆方向
        let toLand = 0;
        const lx = nearestLandL[x];
        const rx = nearestLandR[x];
        if (lx >= 0) { const d = x - lx; if (d > 0) toLand -= 1 / d; }
        if (rx >= 0) { const d = rx - x; if (d > 0) toLand += 1 / d; }
        const towardLand = Math.max(-1, Math.min(1, toLand));

        // 夏季：风从海吹向陆；冬季：从陆吹向海 —— 用 summerTilt 插值
        const seasonSign = summerTilt * 2 - 1; // -1(冬) ~ +1(夏)

        // 季风强度：纬度带 × 热力差 × 海陆对比。
        // 用 min(1, ...) 而不是直接 clamp，保证海陆交错处也能达到强季风。
        const mStr = Math.min(1, latBand * Math.abs(thermal) * 0.95 * (isLand ? 0.85 : 1.0));

        du[idx] = towardLand * thermal * seasonSign * 1.4;
        // 经向分量：季风把水汽从低纬推向高纬（夏季），或反向
        const latSign = latDeg >= 0 ? 1 : -1;
        dv[idx] = latSign * thermal * seasonSign * 0.7;
        strength[idx] = mStr;
      }
    }

    return { du, dv, strength, landFrac: smoothFrac };
  }

  // ==================== 洋流 ====================
  //
  // 风生环流（Ekman 近似）+ 西边界流加强 + 热盐环流。
  //
  // 风应力 → 表层流：真实海洋表层流大约沿风向偏转 45°（北半球右偏）。
  // 这里取简化版：表面流 ≈ 风向旋转 45°，再叠加海岸约束。
  function oceanCurrents(cells, W, H, seaLevel, windU, windV) {
    const N = W * H;
    let curU = new Float32Array(N);
    let curV = new Float32Array(N);

    // 1. 风应力：吹向海面，产生表层流（北半球右偏 45°，南半球左偏）
    for (let y = 0; y < H; y++) {
      const latDeg = (0.5 - y / H) * 180;
      const hemi = latDeg >= 0 ? 1 : -1;
      const cos45 = 0.7071;
      const sin45 = 0.7071 * hemi;
      for (let x = 0; x < W; x++) {
        const idx = y * W + x;
        if (cells[idx].e >= seaLevel) continue;
        const u = windU[idx] || 0;
        const v = windV[idx] || 0;
        curU[idx] = u * cos45 - v * sin45;
        curV[idx] = u * sin45 + v * cos45;
      }
    }

    // 2. 海岸约束：流不能穿透陆地 —— 把流向陆地的分量投影掉
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const idx = y * W + x;
        if (cells[idx].e >= seaLevel) continue;
        const l = cells[y * W + ((x - 1 + W) % W)].e >= seaLevel;
        const r = cells[y * W + ((x + 1) % W)].e >= seaLevel;
        const up = y > 0 && cells[(y - 1) * W + x].e >= seaLevel;
        const dn = y < H - 1 && cells[(y + 1) * W + x].e >= seaLevel;
        const blockedX = l || r;
        const blockedY = up || dn;
        if (blockedX) curU[idx] *= 0.15;
        if (blockedY) curV[idx] *= 0.15;
      }
    }

    // 3. 西边界流加强：大洋西侧（洋流"撞"到大陆西岸）形成强而窄的边界流
    //    对每条纬度带，找海洋的西边界，在其东侧加强经向流
    for (let y = 0; y < H; y++) {
      const latDeg = (0.5 - y / H) * 180;
      const hemi = latDeg >= 0 ? 1 : -1;
      let firstSea = -1;
      for (let x = 0; x < W; x++) {
        if (cells[y * W + x].e < seaLevel) { firstSea = x; break; }
      }
      if (firstSea < 0) continue;
      // 西边界流：暖流（低纬向高纬）或寒流（高纬向低纬），强度随纬度
      const strength = 1.0;
      for (let d = 0; d < 8; d++) {
        const x = (firstSea + d) % W;
        const idx = y * W + x;
        if (cells[idx].e >= seaLevel) break;
        const decay = 1 - d / 8;
        // 低纬西边界流是暖流（向高纬流），亚寒带西边界流是寒流（向低纬流）
        //
        // 【符号必须按屏幕坐标算】curV 是 y 方向（+y 朝南）。
        // 北半球向高纬 = 向北 = curV 取负。所以暖流的方向系数是 −hemi，
        // 寒流才是 +hemi。旧代码写反了（注释说暖流、算出来是寒流），
        // 于是渲染层按"暖流/寒流"上色时全部标反。
        const dir = Math.abs(latDeg) < 45 ? -hemi : hemi;
        curV[idx] += dir * strength * decay * 0.6;
        curU[idx] += hemi * decay * 0.15;
      }
    }

    // 4. 拉普拉斯平滑，让流线连续
    for (let iter = 0; iter < 3; iter++) {
      const nU = new Float32Array(N);
      const nV = new Float32Array(N);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const idx = y * W + x;
          if (cells[idx].e >= seaLevel) continue;
          let su = 0;
          let sv = 0;
          let cnt = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= H) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const ni = yy * W + ((x + dx + W) % W);
              if (cells[ni].e >= seaLevel) continue;
              su += curU[ni];
              sv += curV[ni];
              cnt++;
            }
          }
          if (cnt > 0) { nU[idx] = su / cnt; nV[idx] = sv / cnt; }
        }
      }
      curU = nU;
      curV = nV;
    }

    // 5. 归一化并写入 cell（同时算一个"洋流温度效应"：
    //    向高纬流动=暖流，向低纬流动=寒流）
    const tempEffect = new Float32Array(N);
    for (let y = 0; y < H; y++) {
      const latDeg = (0.5 - y / H) * 180;
      const hemi = latDeg >= 0 ? 1 : -1;
      for (let x = 0; x < W; x++) {
        const idx = y * W + x;
        if (cells[idx].e >= seaLevel) continue;
        const u = curU[idx];
        const v = curV[idx];
        const speed = Math.hypot(u, v);
        if (speed > 1e-6) {
          curU[idx] = (u / speed) * Math.min(1, speed);
          curV[idx] = (v / speed) * Math.min(1, speed);
        }
        // 经向流动越大，温度搬运越强（正：暖流，负：寒流）
        tempEffect[idx] = (curV[idx] / Math.max(0.15, Math.abs(speed))) * hemi;
        cells[idx].current.u = curU[idx];
        cells[idx].current.v = curV[idx];
      }
    }
    return { curU, curV, tempEffect };
  }

  // ==================== 海温异常：洋流的东西岸不对称 ====================
  //
  // 【这个场为什么必须存在】
  // 上一版气候图里，「副热带整圈一样干」是最说不通的一处。实测数据：
  //   +25~35° 东岸沿海降水 0.570、西岸沿海 0.565 —— 差 0.005，等于没有差别。
  // 于是 25°~35° 整条纬度带被涂成一圈沙色，没有一个湿润的海岸，
  // 亚热带常绿林只占陆地 0.06%（等于不存在）。
  //
  // 根因是洋流。旧实现只在「每行最左一段海洋」上加经向流，
  // 符号还写反了（注释说暖流、算出来是寒流），再被 3 次拉普拉斯平滑抹平。
  // 实测东西岸海格的平均流速**完全一致**（(u,v)=(-0.25,0.00) 对 (-0.25,0.00)），
  // 沿海陆地的海平面等效温度差只有 0.001~0.009。
  //
  // 真实地球在这一带的分界不是纬度，而是「这块陆地贴的是暖流还是寒流」：
  //   · 大陆西岸（撒哈拉/纳米布/阿塔卡马/加利福尼亚）紧邻**东边界寒流**：
  //     离岸风 + 冷水上涌 → 逆温层结稳定 → 成雾不成雨 → 沿海沙漠；
  //   · 大陆东岸（美国东南/中国东南/巴西东南/澳洲东岸）紧邻**西边界暖流**：
  //     暖水层深厚 → 向岸流把水汽送上大陆 → 年降水 1000~1500 mm。
  //
  // 判据只用海盆几何，不依赖那套不可靠的风生环流：
  //   一个海格，若**左侧**的陆地更近 → 它在海盆西缘（贴大陆东岸）→ 暖；
  //   若**右侧**的陆地更近 → 它在海盆东缘（贴大陆西岸）→ 寒。
  // 返回值 warm ∈ [-1, 1]：+1 暖流、-1 寒流、0 洋心。
  function coastalSst(cells, W, H, seaLevel) {
    const N = W * H;
    const sst = new Float32Array(N);

    // 边界流宽度：真实西边界流约 100~300 km，东边界流更宽更慢。
    // 本图一格 ≈ 40 km（宽 1000 格 ≈ 赤道一周），取 14 格 ≈ 560 km。
    const WIDTH = 14;
    // 每行复用的距离缓冲（避免 H 次分配）
    const dL = new Int32Array(W);
    const dR = new Int32Array(W);

    for (let y = 0; y < H; y++) {
      const latDeg = (0.5 - y / H) * 180;
      const absLat = Math.abs(latDeg);
      // 边界流只在中低纬显著。赤道是暖池、两极是冷水源，
      // 东西岸的温度差在那里本来就不大（真实地球：北冰洋四周都是冷水）。
      const bandW = smoothstep(5, 15, absLat) * (1 - smoothstep(42, 58, absLat));
      if (bandW <= 0.001) continue;

      // 每行的左右最近陆地距离（含经度环绕）
      const row = y * W;
      dL.fill(-1);
      dR.fill(-1);
      let lastLand = -1;
      for (let x = 0; x < W; x++) {
        if (cells[row + x].e >= seaLevel) lastLand = x;
        if (lastLand >= 0) dL[x] = x - lastLand;
      }
      let firstLand = -1;
      for (let x = W - 1; x >= 0; x--) {
        if (cells[row + x].e >= seaLevel) firstLand = x;
        if (firstLand >= 0) dR[x] = firstLand - x;
      }
      // 环绕补全：左边没找到陆地的，从行尾绕过来
      if (lastLand >= 0) {
        for (let x = 0; x < W && dL[x] < 0; x++) dL[x] = x + (W - lastLand);
      }
      if (firstLand >= 0) {
        for (let x = W - 1; x >= 0 && dR[x] < 0; x--) dR[x] = (W - x) + firstLand;
      }
      if (lastLand < 0) continue; // 整行无陆地：没有边界流

      for (let x = 0; x < W; x++) {
        const idx = row + x;
        if (cells[idx].e >= seaLevel) continue;
        const dl = dL[x] < 0 ? W : dL[x];
        const dr = dR[x] < 0 ? W : dR[x];
        const dMin = Math.min(dl, dr);
        // 离岸衰减：边界流是贴着海岸的一条窄带，不是整个洋面
        const prox = Math.exp(-dMin / WIDTH);
        if (prox < 0.02) continue;
        // 侧别：左近 → 海盆西缘（暖），右近 → 海盆东缘（寒）
        const side = (dr - dl) / Math.max(1, dr + dl);
        sst[idx] = side * prox * bandW;
      }
    }
    return sst;
  }

  // ==================== 生态群系 ====================
  //
  // 用「温度 × 降水」的 Whittaker 图，但降水是气候系统算出来的年降水量，
  // 不是简单的湿度值。这样季风区会自然出现季雨林、雨影区出现荒漠。
  /**
   * Whittaker 群系分类（温度 × 降水），并叠加海拔形成的垂直分带。
   *
   * 【为什么阈值必须按纬度反解，而不是拍脑袋】
   * 这里的 t 是「归一化温度」，而它是距赤道的函数：
   *     t = 1 - 0.92 · (|lat| / 90)^1.15
   * 代入可得 t(26°)=0.79、t(34°)=0.70、t(55°)=0.47、t(66°)=0.36、t(80°)=0.20。
   * 旧阈值把 t<0.72 当作「热带」上限 —— 而 0.70 对应的纬度是 34°，
   * 于是热带一路推到中纬、温带被挤掉（实测落叶阔叶林仅 1.2%、
   * 温带草原 2.2%，热带类合计 41.7%）。温带下限 t<0.52 对应 51°，
   * 也把本属温带的 34~51° 判成了亚热带。
   *
   * 现在把分界钉在真实纬度上：
   *   热带   t ≥ 0.78  → |lat| ≲ 26°
   *   亚热带 0.70~0.78 → 26~34°
   *   温带   0.47~0.70 → 34~55°
   *   亚寒带 0.36~0.47 → 55~66°（泰加林 / 寒冷草原）
   *   苔原带 0.20~0.36 → 66~80°
   *   冰盖   t < 0.20  → 80°+
   *
   * 【冰盖的严格条件】旧实现「p > 0.30 即冰盖」，而降水中位数就有 0.37，
   * 等于把整个极区的苔原都判成冰盖（实测冰盖占陆地 18.6%，真实约 8%）。
   * 冰盖只应出现在「极冷」或「极冷且降雪充沛」处。
   *
   * 【垂直分带】海拔很高时热量条件被压过纬度，出现雪地/高山冻原/裸岩 ——
   * 这三个群系此前因阈值缺失从未被用到。
   */
  // 群系的规范顺序：前 4 个是水体（去碎斑时不参与投票）
  const BIOME_NAMES = [
    '深海', '海洋', '浅海', '湖泊',
    '极地冰盖', '雪地', '高山冻原', '裸岩', '极地荒漠', '苔原',
    '泰加林(针叶林)', '温带雨林', '落叶阔叶林', '寒冷草原', '温带草原', '温带沙漠',
    '亚热带常绿林', '季雨林', '稀树草原', '亚热带荒漠',
    '热带雨林', '热带沙漠',
  ];
  const BIOME_CODE = Object.create(null);
  BIOME_NAMES.forEach((n, i) => { BIOME_CODE[n] = i; });
  const WATER_BIOME_COUNT = 4;

  /**
   * 群系去碎斑：3×3 邻域多数表决，把孤立的小块并入周围群系。
   *
   * 【为什么必须有这一步】Whittaker 分类是对一个**连续场**做阈值切分，
   * 而阈值附近的场必然带有小幅抖动 —— 于是同一条等值线上会切出无数
   * 几十格的小块，整片大陆看起来像「迷彩服 / 牛皮癣」。
   * 真实植被带是连片的：气候场的小抖动不会让森林里长出一块沙漠。
   *
   * 规则刻意保守：
   *   · 只处理陆地格，且只统计**陆地邻居** —— 否则海岸陆地会被
   *     周围 5 个海洋邻居投票投成海，海岸线会被啃掉一圈；
   *   · 需要 ≥5/8 的邻居一致才改判，单个碎点（八邻全同）必被吸收，
   *     但两种群系犬牙交错的过渡带不会被强行拉直。
   */
  function despeckleBiomes(cells, W, H, passes) {
    const N = W * H;
    let code = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const v = BIOME_CODE[cells[i].biome];
      code[i] = v === undefined ? 255 : v;
    }
    const count = new Int32Array(BIOME_NAMES.length);
    const touched = [];
    const nb = new Int32Array(8);
    for (let pass = 0; pass < passes; pass++) {
      const next = Uint8Array.from(code);
      for (let y = 0; y < H; y++) {
        const row = y * W;
        const yUp = y > 0 ? row - W : row;
        const yDn = y < H - 1 ? row + W : row;
        for (let x = 0; x < W; x++) {
          const i = row + x;
          const own = code[i];
          if (own >= WATER_BIOME_COUNT && own !== 255) {
            const xl = (x - 1 + W) % W;
            const xr = (x + 1) % W;
            nb[0] = yUp + xl; nb[1] = yUp + x; nb[2] = yUp + xr;
            nb[3] = row + xl;                   nb[4] = row + xr;
            nb[5] = yDn + xl; nb[6] = yDn + x; nb[7] = yDn + xr;
            touched.length = 0;
            for (let k = 0; k < 8; k++) {
              const cc = code[nb[k]];
              if (cc >= WATER_BIOME_COUNT && cc !== 255) {
                if (count[cc] === 0) touched.push(cc);
                count[cc]++;
              }
            }
            let best = -1;
            let bestN = 0;
            for (let k = 0; k < touched.length; k++) {
              const cc = touched[k];
              if (count[cc] > bestN) { bestN = count[cc]; best = cc; }
              count[cc] = 0;
            }
            if (best >= 0 && best !== own && bestN >= 5) next[i] = best;
          }
        }
      }
      code = next;
    }
    for (let i = 0; i < N; i++) {
      if (code[i] !== 255) cells[i].biome = BIOME_NAMES[code[i]];
    }
  }

  /**
   * 小碎块归并：把面积小于 minArea 的 4-连通同群系区块，
   * 整块并给「邻接最多的外部陆地块」的群系。
   *
   * 【为什么不只用 3×3 多数表决】
   * 表决只能吃掉 1~2 格的孤立点。阈值切分产生的碎块常常是 20~80 格的长条，
   * 它的八邻里有大半仍属于自己 —— 表决不但吃不掉，反而会「保护」它们。
   * 实测去碎斑之后群系斑块中位数仍只有 61 格（判据要求 ≥80），卡点就在这里。
   *
   * 【为什么整块处理是安全的】
   * 只决定「这一块整体改成什么」，不改块内部任何格子，所以不会把大区域揉碎；
   * 找不到外部陆地邻居的块（被水围住的孤岛、半岛尖）原样保留 ——
   * 一颗小岛本来就该只有一种群系。
   */
  function mergeSmallBiomeBlocks(cells, W, H, minArea, passes) {
    const N = W * H;
    const code = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const v = BIOME_CODE[cells[i].biome];
      code[i] = v === undefined ? 255 : v;
    }
    const label = new Int32Array(N).fill(-1);
    const stack = new Int32Array(N);
    const members = new Int32Array(N);
    const count = new Int32Array(BIOME_NAMES.length);
    const touched = [];
    let stamp = 1;

    for (let pass = 0; pass < (passes || 2); pass++) {
      label.fill(-1);
      let changed = 0;
      for (let i0 = 0; i0 < N; i0++) {
        if (label[i0] !== -1) continue;
        const c0 = code[i0];
        if (c0 < WATER_BIOME_COUNT || c0 === 255) { label[i0] = -2; continue; }
        const myLabel = stamp++;
        let sp = 0;
        let mp = 0;
        stack[sp++] = i0;
        label[i0] = myLabel;
        while (sp > 0) {
          const j = stack[--sp];
          members[mp++] = j;
          const x = j % W;
          const y = (j / W) | 0;
          for (let k = 0; k < 4; k++) {
            const nx = k === 0 ? (x - 1 + W) % W : k === 1 ? (x + 1) % W : x;
            const ny = k === 2 ? y - 1 : k === 3 ? y + 1 : y;
            if (ny < 0 || ny >= H) continue;
            const m = ny * W + nx;
            if (label[m] !== -1) continue;
            if (code[m] !== c0) continue;
            label[m] = myLabel;
            stack[sp++] = m;
          }
        }
        if (mp >= minArea) continue;

        // 统计这一块的外部陆地邻居
        touched.length = 0;
        for (let t = 0; t < mp; t++) {
          const j = members[t];
          const x = j % W;
          const y = (j / W) | 0;
          for (let k = 0; k < 4; k++) {
            const nx = k === 0 ? (x - 1 + W) % W : k === 1 ? (x + 1) % W : x;
            const ny = k === 2 ? y - 1 : k === 3 ? y + 1 : y;
            if (ny < 0 || ny >= H) continue;
            const m = ny * W + nx;
            if (label[m] === myLabel) continue;
            const cc = code[m];
            if (cc < WATER_BIOME_COUNT || cc === 255) continue;
            if (count[cc] === 0) touched.push(cc);
            count[cc]++;
          }
        }
        let best = -1;
        let bestN = 0;
        for (let k = 0; k < touched.length; k++) {
          const cc = touched[k];
          if (count[cc] > bestN) { bestN = count[cc]; best = cc; }
          count[cc] = 0;
        }
        if (best >= 0 && best !== c0) {
          for (let t = 0; t < mp; t++) code[members[t]] = best;
          changed++;
        }
      }
      if (!changed) break;
    }
    for (let i = 0; i < N; i++) {
      if (code[i] !== 255) cells[i].biome = BIOME_NAMES[code[i]];
    }
  }

  function classifyBiome(temp, precip, elev, seaLevel, isLake, tempSea) {
    if (isLake) return '湖泊';
    if (elev < seaLevel) {
      if (elev < seaLevel - 0.22) return '深海';
      if (elev < seaLevel - 0.05) return '海洋';
      return '浅海';
    }
    const t = clamp01(temp);
    const p = clamp01(precip);
    // 相对高度（0=海平面，1=最高峰），用于海拔垂直分带
    const rel = clamp01((elev - seaLevel) / Math.max(1e-6, 1 - seaLevel));

    // ================= 关键：先算「海平面等效温度」 =================
    //
    // 【为什么必须这么做】旧实现直接拿 t（含海拔降温后的真实气温）
    // 去判「极地冰盖 / 苔原」，于是中纬度的**高山**因为气温直减率
    // 落到 t<0.18，被当成极地冰盖 —— 实测 50°S 的山上出现大片
    // 白色冰盖，而那里本该是温带。同一块大陆上「高原变盐碱地、
    // 山地变极地」两个毛病是同一个根：**纬度与海拔被混在一个变量里**。
    //
    // 拆开成两个量：
    //   tSea = t + rel·LAPSE  —— 把海拔降温加回去，得到「假如这里是
    //                            海平面会有多热」。它只反映纬度 + 大陆度，
    //                            是纯粹的**纬度代理**，南北对称。
    //   rel                    —— 单独的**海拔**，只用于雪线判定。
    // 纬度气候带用 tSea 判，垂直分带用 rel 判，两者不再互相污染。
    //
    // 【为什么优先用调用方传进来的 tempSea】
    // t 在写回 cell 时被 clamp01 了。极区的真实温度是负的，
    // 一旦被截到 0，+rel·LAPSE 就再也反推不回原值 ——
    // 实测北极大陆（rel 高达 0.8）会算出 tSea = 0.35，
    // 于是「极地」被判成「亚寒带」、整块北极大陆长满泰加林。
    // 因此气候阶段会把**未截断**的温度算出的 tSea 存进 cell.tempSea，
    // 这里直接用。没有该值时才退化成现场推算（导入旧存档的情形）。
    const tSea = tempSea != null
      ? clamp01(tempSea)
      : clamp01(t + rel * LAPSE);

    // ---- 1) 垂直分带：雪线随纬度下降 ----
    //
    // 用一张按真实雪线标定的表，而不是一条幂函数。
    //
    // 【为什么幂函数不行】上一版写的是 snowline = 0.55 · tSea^1.3，
    // 它在赤道对（0.55 ≈ 4870 m）、在高纬也对（65° 得 0.167 ≈ 1480 m），
    // 但**中低纬错得厉害**：20° 算出 0.445（3940 m），而真实雪线在
    // 墨西哥/玻利维亚一带约 4800~5000 m —— 低了 1000 m。
    // 原因很直白：真实雪线在 0~30° 几乎是平的（太阳高度角变化小），
    // 到 30° 之后才陡降；幂函数做不出这种「先平后陡」的形状。
    // 实测后果：delta 种子中低纬（<40°）冰雪占到 4.44%，全是
    // 热带高原因雪线偏低而刷出来的白色台地。
    //
    // 下表由「纬度 → 真实雪线高度(米) ÷ 8848」逐点标定，
    // 自变量是 tSea（纬度代理温度）。中间线性插值。
    //   tSea  T(纬)   雪线(m)   rel
    //   1.00   0°     4800     0.542
    //   0.85   20°    4900     0.554
    //   0.76   30°    4600     0.520
    //   0.66   40°    3000     0.339
    //   0.55   50°    2400     0.271
    //   0.44   60°    1700     0.192
    //   0.31   70°     800     0.090
    //   0.17   80°     100     0.011
    const SNOWLINE = [
      [0.00, 0.000], [0.17, 0.011], [0.31, 0.090], [0.44, 0.192],
      [0.55, 0.271], [0.66, 0.339], [0.76, 0.520], [1.00, 0.554],
    ];
    let snowline;
    {
      let k = 1;
      while (k < SNOWLINE.length - 1 && tSea > SNOWLINE[k][0]) k++;
      const [t0, v0] = SNOWLINE[k - 1];
      const [t1, v1] = SNOWLINE[k];
      const f = Math.max(0, Math.min(1, (tSea - t0) / Math.max(1e-9, t1 - t0)));
      snowline = v0 + (v1 - v0) * f;
    }
    if (rel > snowline) return '雪地';
    // 雪线以下是裸岩/高山冻原。0.82 对应真实林线：
    // 赤道高山 4000 m 以上无林（0.82 × 4800 ≈ 3940 m），45° 约 1900 m。
    if (rel > snowline * 0.82) return p > 0.30 ? '高山冻原' : '裸岩';

    // ---- 2) 纬度气候带（一律用 tSea，与海拔无关）----
    //
    // 阈值仍钉在真实纬度上（见下方注释），只不过自变量从 t 换成了 tSea。
    //
    // 【冰盖条件必须极严】旧条件会让冰盖占到陆地 30% ——
    // 整幅图一半是白色。真实冰盖只有南极洲 + 格陵兰（约陆地 10%），
    // 且只在「终年冰冻」处出现，其余极区是苔原/泰加林。
    if (tSea < 0.16) return '极地冰盖';
    if (tSea < 0.30) return p > 0.08 ? '苔原' : '极地荒漠';
    // 亚寒带针叶林在地球上可以延伸到约 70°N
    //
    // 【冷带的降水门槛必须比温带低得多】
    // 高纬寒冷、空气持水量低，年降水只有 200~400 mm —— 按「降水量」
    // 看是荒漠级，但因为潜在蒸散更低，实际上是湿润的泰加林。
    // 原先沿用温带的 0.46/0.50 门槛，结果高纬降水永远够不到，
    // 整条亚寒带被涂成「极地荒漠」（米灰色），看上去像是极圈里
    // 长了一片撒哈拉。Whittaker 图的冷端本来就该向左压缩。
    if (tSea < 0.40) {
      if (p > 0.36) return '泰加林(针叶林)';
      if (p > 0.10) return '苔原';
      return '极地荒漠';
    }
    // ---- 亚寒带 55~66°：泰加林 / 寒冷草原 ----
    if (tSea < 0.48) {
      if (p > 0.42) return '泰加林(针叶林)';
      if (p > 0.16) return '寒冷草原';
      return '极地荒漠';
    }
    // ---- 温带 34~55° ----
    //
    // 【森林/草原的分界从 0.56 降到 0.42】这是 Whittaker 图上最容易
    // 判错的一条线。原先 0.56 的门槛让中纬「不够湿」的地方全落到草原，
    // 实测 50° 一带 55% 是温带草原 —— 而真实地球上这个纬度（西欧、
    // 中国东北、北美五大湖）是阔叶林带。降门槛后草原退回半干旱区。
    if (tSea < 0.70) {
      if (p > 0.74) return '温带雨林';
      if (p > 0.42) return '落叶阔叶林';
      if (p > 0.28) return '温带草原';
      return '温带沙漠';
    }
    // ---- 亚热带 26~34° ----
    if (tSea < 0.78) {
      if (p > 0.66) return '亚热带常绿林';
      if (p > 0.48) return '季雨林';
      if (p > 0.27) return '稀树草原';
      return '亚热带荒漠';
    }
    // ---- 热带 |lat| ≲ 26° ----
    if (p > 0.62) return '热带雨林';
    if (p > 0.46) return '季雨林';
    if (p > 0.27) return '稀树草原';
    return '热带沙漠';
  }

  class ClimateSystem {
    constructor(options) {
      this.W = options.width;
      this.H = options.height;
      this.cells = options.cells;
      this.seaLevel = options.seaLevel;
      this.noise = options.noise;
    }

    /**
     * 运行完整气候模拟。
     * @param {(p:number,label:string)=>void} onProgress
     * @param {()=>Promise<void>} yieldToUi
     */
    async solve(onProgress, yieldToUi) {
      const W = this.W;
      const H = this.H;
      const N = W * H;
      const cells = this.cells;
      const sea = this.seaLevel;

      const t0 = performance.now();

      // ---------- 1. 行星风带 + 季风（年平均 + 季节振幅）----------
      onProgress(0.70, '模拟大气环流…');
      await yieldToUi();

      const windU = new Float32Array(N);
      const windV = new Float32Array(N);
      const pressure = new Float32Array(N);

      for (let y = 0; y < H; y++) {
        const latDeg = (0.5 - y / H) * 180;
        const absLat = Math.abs(latDeg);
        const w = planetaryWind(absLat);
        const latSign = latDeg >= 0 ? 1 : -1;
        for (let x = 0; x < W; x++) {
          const idx = y * W + x;
          windU[idx] = w.u;
          //
          // 【为什么经向风要再乘一个赤道收敛因子】
          // w.v 是「南半球为正、北半球为负」的经向风（信风向赤道），
          // 用 latSign 翻符号后，赤道两侧会变成 -0.132 → +0.132 的**硬跳变**。
          // 而赤道恰好是信风辐合带（ITCZ），真实经向风在这里应该趋近于零。
          // 不处理的话，赤道整行的水汽上游会突然反向，气候图上出现一条
          // 贯穿全图的横向截段。
          // 乘上平滑的赤道收敛因子后，经向风在赤道自然归零、两侧连续过渡。
          const eqDamp = Math.min(1, absLat / 12);       // ±12° 内线性收敛到 0
          windV[idx] = w.v * latSign * eqDamp * eqDamp;
          pressure[idx] = w.pressure;
        }
      }

      // 季风：夏季 / 冬季两种相位
      const summer = monsoonField(cells, W, H, sea, 0.85);
      const winter = monsoonField(cells, W, H, sea, 0.15);

      // 年平均风场 = 行星风 + 季风年平均
      for (let i = 0; i < N; i++) {
        windU[i] += (summer.du[i] + winter.du[i]) * 0.5;
        windV[i] += (summer.dv[i] + winter.dv[i]) * 0.5;
      }

      // ---------- 2. 洋流 ----------
      onProgress(0.75, '计算洋流环流…');
      await yieldToUi();
      const ocean = oceanCurrents(cells, W, H, sea, windU, windV);
      // 海面「贴的是暖流还是寒流」——东/西岸不对称的唯一来源（见 coastalSst）
      const sstOcean = coastalSst(cells, W, H, sea);

      // ---------- 大陆度场：每个陆地格到最近海洋的格数距离 ----------
      //
      // 【为什么必须算这个】
      // 温度只依赖纬度、湿度只依赖风带时，两者的等值线都是一组**水平直线**，
      // 群系就必然画成横贯大陆的「横向色带」——这正是用户看到的问题。
      // 真实地球在同一纬度上有撒哈拉、中国季风区、北美温带林，
      // 差别来自**大陆度**：越深入内陆越干、年较差越大。
      // 用多源 BFS 一次求出距离场（O(N)），再同时作用于温度与湿度，
      // 等值线才会随大陆轮廓弯曲，群系才会成「块」而不是「带」。
      const distToSea = new Int32Array(N).fill(-1);
      // 顺带记下「这个陆地格最近的**海岸海格**是哪一个」。
      // 后面要用它的海温去影响陆地（暖流沿岸温和多雨、寒流沿岸阴冷少雨），
      // 所以必须记住来源格，而不只是距离。
      const seaSrc = new Int32Array(N).fill(-1);
      {
        const queue = new Int32Array(N);
        let head = 0;
        let tail = 0;
        for (let i = 0; i < N; i++) {
          if (cells[i].e < sea) {
            distToSea[i] = 0;
            seaSrc[i] = i;
            queue[tail++] = i;
          }
        }
        while (head < tail) {
          const i = queue[head++];
          const d = distToSea[i] + 1;
          const x = i % W;
          const y = (i / W) | 0;
          for (let k = 0; k < 4; k++) {
            const nx2 = k === 0 ? (x - 1 + W) % W : k === 1 ? (x + 1) % W : x;
            const ny2 = k === 2 ? y - 1 : k === 3 ? y + 1 : y;
            if (ny2 < 0 || ny2 >= H) continue;
            const j = ny2 * W + nx2;
            if (distToSea[j] >= 0) continue;
            distToSea[j] = d;
            seaSrc[j] = seaSrc[i];
            queue[tail++] = j;
          }
        }
      }

      // ---------- 3. 温度（纬度 + 海拔 + 洋流 + 大陆度）----------
      onProgress(0.78, '计算温度…');
      await yieldToUi();

      // ---- 海温异常的整图版本 ----
      // 海上用自己的值；陆上用「最近海岸海格」的值按距离衰减。
      // 衰减尺度 26 格 ≈ 1000 km：暖流的热量能改变沿海一带的气候，
      // 但进不了大陆腹地（真实地球：西欧温和、同纬度的西伯利亚极寒）。
      const sstField = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        if (cells[i].e < sea) { sstField[i] = sstOcean[i]; continue; }
        const src = seaSrc[i];
        if (src < 0) continue;
        sstField[i] = sstOcean[src] * Math.exp(-(distToSea[i] || 0) / 14);
      }

      // ---- 温度异常场：先合成、去偏、模糊 ----
      //
      // 【为什么噪声必须逐行去均值】噪声是 (nx, ny) 的固定函数，而陆地
      // 只占一部分经度。若某个纬度上的陆地恰好落在噪声高值区，该纬度
      // **所有**陆地会整体偏暖；反之整体偏冷。这与气候机制无关，纯粹是
      // 采样偏差。实测南北半球同纬度陆地均温差 0.07~0.17 ——
      // 南半球陆地更少、经度分布不同，采样偏差更大，于是「南半球无缘无故
      // 更冷」。去均值后每一行的噪声均值为 0，半球才真正对称。
      //
      // 另两处调整：两档噪声合成为**一张**场（原来分两次加到 t 上，
      // 各自带偏置）；整体幅度 0.12 → 0.105 并模糊 r=2，避免「云絮状」
      // 的脏斑（原图上整片大陆像抹了层油）。
      const tAnom = new Float32Array(N);
      for (let y = 0; y < H; y++) {
        const ny = y / H - 0.5;
        for (let x = 0; x < W; x++) {
          const nx = x / W;
          tAnom[y * W + x] =
            this.noise(nx, ny + 30, 2.5, 3) * 0.045 +
            this.noise(nx, ny + 70, 3.0, 4) * 0.060;
        }
      }
      rowDemean(tAnom, W, H);
      const tAnomS = boxBlur(tAnom, W, H, 2);

      for (let y = 0; y < H; y++) {
        const ny = y / H - 0.5;
        const absLat = Math.abs(ny * 2);
        for (let x = 0; x < W; x++) {
          const idx = y * W + x;
          const c = cells[idx];

          // 基础纬度温度：赤道最热，两极最冷。
          //
          // 指数从 1.45 调到 1.15：原指数让中纬降温过快，
          // 结果温带大面积落入「苔原/极地荒漠」（实测占 27%），
          // 热带与温带森林几乎不存在。1.15 更接近真实的
          // 纬向太阳辐射分布（cos 曲线）。
          let t = 1.0 - Math.pow(absLat, 1.15) * 0.92;
          let rel = 0;

          if (c.e >= sea) {
            // 陆地：气温直减率。
            //
            // 【注意】rel 是「相对高度」，而本图陆地相对高度被拉到 0~0.96，
            // 若系数取 0.85，则最高峰温度会被削掉 0.82 ——
            // 相当于把山顶直接拉到极地温度，导致苔原泛滥（实测 31%）。
            // 真实情况里，海拔造成的是"局部降温"，不应该覆盖纬度气候带。
            // 取 0.42（见 LAPSE）：最高峰降温约 0.40，仍能形成山地垂直气候带，
            // 但不会把整片大陆压成苔原。系数由 classifyBiome 共享。
            const relH = (c.e - sea) / (1 - sea);
            rel = relH;
            t -= relH * LAPSE;
          }

          // ---- 洋流（暖流/寒流）----
          //
          // 【旧实现为什么等于没有】原来写的是 t += ocean.tempEffect[idx] * 0.13，
          // 而 tempEffect 只对海格赋值、陆地一律为 0；更糟的是场本身经向均匀，
          // 且符号与注释相反。实测东西岸沿海陆地的海平面等效温度差 0.001~0.009，
          // 等于没有任何东西岸差异。
          // 现在改为 sstField（见 coastalSst）：海上按海盆侧别给出 ±1，
          // 陆上按离岸距离衰减。系数 0.13 ≈ 纬度上 12° 的温差 ≈ 8~10 °C，
          // 与黑潮/湾流相对加利福尼亚/加那利寒流的实际温差相当。
          t += sstField[idx] * 0.13;

          // ---- 大陆度对温度的影响 ----
          //
          // 【旧实现错在哪】写成 t -= conti * (0.02 + absLat * 0.10)，
          // 是一个**单向降温**项。于是「陆地多 → 内陆多 → 更冷」，
          // 南北半球的温差几乎完全由陆地面积决定（南半球陆地只有
          // 22~35%，北半球 38~41%，实测同纬度差 0.07~0.17），
          // 而不是由气候机制决定。
          //
          // 真实的大陆度效应是「年较差放大」，以海温为基准：
          //   低纬内陆更热（撒哈拉比同纬度海洋热得多），
          //   高纬内陆更冷（西伯利亚比同纬度海洋冷得多），
          //   零交叉点约在 30°。
          // 写成 lat 的线性函数 t += conti·(0.10 − absLat·0.30)，
          // 南北半球完全对称，同时保住「沙漠更热、寒极更冷」。
          const dts = distToSea[idx] > 0 ? distToSea[idx] : 0;
          const conti = Math.min(1, Math.pow(dts / 110, 0.75));
          t += conti * (0.10 - absLat * 0.30);

          t += tAnomS[idx];

          // 海平面等效温度：把海拔造成的降温**加回去**，得到「假如这里
          // 就在海平面会有多热」。它只随纬度与大陆度变化，与海拔无关，
          // 是纬度气候带的唯一判据。必须在 clamp 之前算 ——
          // 极区真实温度是负的，一旦被截到 0 就再也反推不回来。
          c.tempSea = clamp01(t + rel * LAPSE);
          c.temp = clamp01(t);
        }
        if ((y & 31) === 0) {
          onProgress(0.78 + 0.04 * (y / H), '计算温度…');
          await yieldToUi();
        }
      }

      // ---------- 4. 水汽输运 + 降水（含季风雨季/旱季）----------
      onProgress(0.82, '输运水汽…');
      await yieldToUi();

      // ---------- 水汽输运与降水 ----------
      //
      // 用「沿风向逐格推进」的方式模拟水汽输送：
      //   海洋蒸发 → 随风进入陆地 → 遇山抬升成雨 → 背风坡雨影 → 内陆干燥。
      //
      // 【这一版最大的改动：把「逐格」换成「场」】
      // 旧实现有三处逐格化的做法，正是气候图上「发丝状脉络 + 大片平涂」的
      // 直接来源：
      //   1) rise 用相邻两格的原始高差 → 每一道小沟、每一颗噪声鼓包都下雨，
      //      降水被压成沿风向延伸的 1 格宽细丝；
      //   2) precip[idx] += rain 直接累加到本格 → 细丝被反复强化；
      //   3) 水汽平流只有 0.90/0.10 的上下游混合，完全没有横向扩散，
      //      于是水汽只沿风轴搬运，行与行之间几乎不交换。
      // 实测旧版降水在 50 格窗口内局部标准差 0.197（温度只有 0.108），
      // 而群系斑块中位数只有 39 格 —— 场上大部分「细节」是数值噪声。
      //
      // 现在：海拔先模糊到山体尺度；每遍平流之后做一次扩散；
      // 降水沉积场每遍也模糊一次；最后再做两级场模糊。
      // 雨影、内陆干燥、迎风坡湿润这些**气候信号**全部保留，
      // 去掉的只是它们的 1 格宽轮廓。

      // 平滑海拔：rise 要代表「气块翻越山体」，而气块的尺度远大于一格。
      const eField = new Float32Array(N);
      for (let i = 0; i < N; i++) eField[i] = cells[i].e;
      const eSmooth = boxBlur(boxBlur(eField, W, H, 2), W, H, 2);

      // 初始水汽：按纬度带分布，体现「赤道低压带湿润、副热带高压带干燥」。
      //
      // 真实大气环流：
      //   · 赤道低压带（ITCZ）：上升气流，全球最湿 → 热带雨林；
      //   · 副热带高压带（±30°）：下沉气流，全球最干 → 撒哈拉级沙漠；
      //   · 中纬西风带：中等湿度；
      //   · 极地：低温，绝对含水量低。
      //
      // 旧版把赤道初始水汽给得不足（0.85×基础值），导致赤道降水
      // 反而低于 ±20°，热带雨林几乎不出现 —— 这是必须修正的物理错误。
      const moisture = new Float32Array(N);
      // 每一纬度带的「海面水汽上限」。海洋蒸发不是均匀的：
      // 副热带高压带下沉气流抑制蒸发，海面能供应的水汽本来就少。
      const rowBase = new Float32Array(H);
      for (let y = 0; y < H; y++) {
        const absLat = Math.abs((0.5 - y / H) * 2); // 0(赤道) ~ 1(极地)
        // 赤道湿润峰 + 副热带干谷（约 absLat=0.35 即 ±31°）+ 中纬回升
        const itczPeak = Math.exp(-((absLat / 0.14) ** 2));          // 赤道峰
        const subtropicalDry = Math.exp(-(((absLat - 0.36) / 0.15) ** 2)); // 副热带干
        const midLatWet = 0.42 * Math.exp(-(((absLat - 0.62) / 0.20) ** 2)); // 西风带
        const polarDry = Math.max(0, absLat - 0.78) * 0.55;          // 极地递减
        // 【副热带干谷必须够深】它是「沙漠带」的唯一来源。
        // 旧系数 0.34 只能把基准从 0.50 压到 0.16，再经平流与归一化，
        // 30° 的实际降水还有 0.31 —— 于是整个副热带被判成稀树草原
        // （实测稀树草原 5.4%，是占比最大的单一群系，而真实地球这一带
        //   是撒哈拉/阿拉伯/澳洲三大沙漠）。系数提到 0.50，谷底落到 0。
        const baseHumid = clamp01(
          0.50 + itczPeak * 0.48 - subtropicalDry * 0.58 + midLatWet - polarDry
        );
        rowBase[y] = baseHumid;
        for (let x = 0; x < W; x++) {
          const idx = y * W + x;
          moisture[idx] = cells[idx].e < sea ? 1.0 : baseHumid;
        }
      }

      // 沿风向推进。步长 5.0 格/遍 × 16 遍 ≈ 80 格的有效输送距离。
      //
      // 【为什么 6 遍 × 2.2 格不够】旧版水汽最多只能跑 13 格，而大陆
      // 宽达 300 格以上 —— 深层内陆永远拿不到海洋水汽，只能靠
      // 「初始纬度水汽」撑着，于是内陆与海岸的差别被抹平成大片平涂，
      // 干湿完全由纬度决定。
      //
      // 【为什么是 80 格这个尺度】输送距离直接决定「海岸湿润带」的厚度：
      // 水汽只跑 32 格时，任何离海 32 格以内的陆地都同样湿 ——
      // 不管它在迎风岸还是背风岸，于是整条海岸线被描出一圈**等宽绿边**，
      // 这是气候图上最典型的「假」特征。真实大陆的水汽能深入几百公里，
      // 而且是**沿风走、遇山停**：迎风侧深入内陆仍然湿润，
      // 背风侧刚过山脊就干。把距离拉到 80 格后，风向与山脉才开始
      // 主导干湿分布，绿边才会断成一段一段。
      const ADV_STEP = 8.0;
      const PASSES = 22;
      let mCur = moisture;
      let precipAcc = new Float32Array(N);
      for (let pass = 0; pass < PASSES; pass++) {
        const next = Float32Array.from(mCur);
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const idx = y * W + x;
            const c = cells[idx];
            const u = windU[idx];
            const v = windV[idx];

            // 上游位置（风从哪里来）
            //
            // 【为什么必须双线性，不能用 Math.round】
            // planetaryWind() 只是**纬度**的函数，所以同一行内 u/v 完全相同。
            // 若把上游偏移取整（stepX = Math.round(u*2.2)），整行就会取到
            // 同一个整数步长；风场随纬度缓慢变化，一旦某个 v 跨过取整阈值，
            // **整行**的上游来源会同时平移一格 —— 湿度随之整行跳变，
            // 在气候图上表现为一条条突兀的「横向截段」。
            // （实测湿度场相邻行均值最大跳变 0.63、二阶差分尖峰 363 处，
            //   而温度场只有 0.066，可见条带完全来自这里。）
            const sx = x - u * ADV_STEP;
            const sy = y - v * ADV_STEP;
            const x0f = Math.floor(sx);
            const y0f = Math.floor(sy);
            const fx = sx - x0f;
            const fy = sy - y0f;
            const xa = ((x0f % W) + W) % W;           // 经度环绕
            const xb = (xa + 1) % W;
            const ya = Math.max(0, Math.min(H - 1, y0f));
            const yb = Math.max(0, Math.min(H - 1, y0f + 1));

            // 双线性取上游水汽与（平滑）海拔
            const w00 = (1 - fx) * (1 - fy);
            const w10 = fx * (1 - fy);
            const w01 = (1 - fx) * fy;
            const w11 = fx * fy;
            const i00 = ya * W + xa;
            const i10 = ya * W + xb;
            const i01 = yb * W + xa;
            const i11 = yb * W + xb;
            const upM = mCur[i00] * w00 + mCur[i10] * w10 + mCur[i01] * w01 + mCur[i11] * w11;
            const upE = eSmooth[i00] * w00 + eSmooth[i10] * w10 +
                        eSmooth[i01] * w01 + eSmooth[i11] * w11;

            // 无风处不做输运（避免自我引用）
            if (Math.abs(u * ADV_STEP) < 1e-3 && Math.abs(v * ADV_STEP) < 1e-3) continue;

            if (c.e < sea) {
              // 海洋：持续蒸发，维持水汽。
              const baseFloor = 0.28 + 0.72 * rowBase[y];
              //
              // 【海面能供应多少水汽，取决于海水有多暖】
              // 这是「东岸湿润亚热带 / 西岸沿海沙漠」唯一可能的来源。
              // 只按纬度给水汽（旧写法）时，副热带东西两岸的供给完全相同，
              // 实测 +25~35° 东岸 0.570 / 西岸 0.565，差 0.005 ——
              // 整条副热带被涂成一圈沙色，亚热带常绿林占陆地 0.06%。
              //
              // 用指数形式而不是线性：蒸发通量对海温是超线性的
              // （Clausius-Clapeyron，每升 1 °C 饱和水汽压约增 7%）。
              // 系数 0.85 让暖流岸 1 倍、寒流岸约 0.43 倍，落差 ~2.3 倍；
              // 再叠加陆地上的平流与地形，就能拉开足够的水湿差距。
              const warm = sstOcean[idx];
              let floor = baseFloor * Math.exp(SST_MOIST * warm);
              floor = Math.max(0.04, Math.min(1, floor));
              //
              // 【为什么上限必须随纬度变】旧写法是 max(m, 0.92) ——
              // 所有海面一律提供 0.92 的水汽，副热带高压带也不例外。
              // 结果是**每一个海岸**都同样湿润，大陆被描上一圈等宽的鲜绿，
              // 包括本该是沙漠的副热带西岸（真实世界里撒哈拉直抵大西洋，
              // 纳米布沙漠紧贴海岸）。
              // 现在海面水汽**直接等于**该纬度的饱和值：赤道 0.99、
              // 副热带 0.40、中纬 0.80。
              //
              // 【为什么不能写成 max(旧值×衰减, floor)】旧写法里海面初值是
              // 1.0，每遍乘 0.985，16 遍后还有 0.78 —— 而 floor 是 0.28，
              // 于是 max() 从来没有生效过，海面永远是 0.78 以上。
              // 改了 floor 的公式却看不到任何变化，就是这个原因
              //（实测把副热带海面水汽从 0.58 压到 0.28，输出降水一个数没动）。
              // 海面水汽由海温决定，是个**平衡值**，不是累积量 —— 直接赋值才对。
              next[idx] = floor;
              continue;
            }

            // 陆地：从上游获得水汽。
            //
            // 【关键修正】不能写成 max(自身, 上游)，那会让水汽只增不减、
            // 所有格点趋同（实测降水经向变幅只有 0.06，群系呈纬度带状）。
            // 必须让「上游」成为主导项，配以轻微的本地保留：
            //   m = 上游 * 0.90 + 本地 * 0.10
            // 这样水汽沿风向真实地「离开内陆、堆在迎风坡」，
            // 经度方向才会出现干湿差异（雨影、内陆荒漠、沿海湿润）。
            let m = upM * 0.90 + mCur[idx] * 0.10;

            // ---- 海岸带的海上空气侵入（marine air）----
            //
            // 【为什么光靠平流不够 —— 这是副热带整圈沙漠的最后一环】
            // 副热带高压带恰好落在 30° 附近，而那里行星风的信风分量
            // （−0.85·e^−(15/13)² = −0.22）与西风分量（+0.95·e^−(15/14)² = +0.30）
            // **几乎抵消**，实测 u = 0.077 —— 风几乎不动。
            // 没有风就没有平流：水汽一步也送不上岸，海岸线两侧的湿度
            // 只差一个扩散半径（22 遍 × 30% 的 3×3 → 约 2.5 格）。
            // 于是海面水汽再怎么按海温调，也只在海岸描出一条 2~3 格宽的绿边，
            // 大陆整体仍然是 rowBase 决定的纬度色带 —— 一圈沙。
            //
            // 真实情况是：副热带并非无风。夏季海陆热力差 + 海风环流
            // 会把海洋边界层空气整层推上岸；西岸寒流上涌形成逆温盖，
            // 反而压制对流（成雾不成雨）。所以这里不直接改风速，
            // 而是让**近岸陆地空气向「该处海面的平衡水汽值」靠拢**：
            //   暖流岸 → 平衡值高 → 海岸湿润；
            //   寒流岸 → 平衡值低 → 海岸干燥（撒哈拉/纳米布直抵海边）。
            // 衰减由 sstField 自身承担（离岸 exp(−d/26)），
            // 所以湿润带只有 40~60 格宽，进不到大陆腹地。
            const seaWarm = sstField[idx];
            if (seaWarm !== 0) {
              const supply = clamp01((0.28 + 0.72 * rowBase[y]) * Math.exp(SST_MOIST * seaWarm));
              m = m * (1 - SST_COAST_MIX) + supply * SST_COAST_MIX;
            }

            // 季风输送：季风强的地区获得额外水汽（雨季）
            const monsStr = Math.max(summer.strength[idx], winter.strength[idx]);
            m = Math.min(1, m + monsStr * 0.030);

            // 地形雨：迎风坡抬升。
            //
            // 【必须写成连续函数，不能写 if (rise > 阈值)】
            // 旧实现是二分支：
            //   rise > 0.010 → 降雨 m·min(0.55, rise·9)，并从 m 里扣掉；
            //   否则         → 降雨 m·0.012，m 不扣。
            // 在 rise = 0.010 这一点上，**降雨量从 m·0.012 跳到 m·0.09**（7 倍），
            // 同时 m 的扣减从 0 跳到 0.09。于是一条等值线两侧的降水
            // 直接断层，气候图上就是一块块硬边的深蓝斑（山地雨岛）。
            // 实测降水图上一眼就能看到这些「边缘锐利的高值洞」。
            //
            // 真实物理里没有这个阈值：抬升多少就下多少雨，坡度为零时
            // 仍有对流雨/平流雨。所以写成
            //   orographic = 0.012 + max(0, rise)·9
            // 坡度为零时正好退化成原来的对流雨，往上连续增长，
            // 到 rise≈0.06 时触顶 0.55。
            //
            // 【rise 的量级随地形测高曲线变化】rise 是「本格与上风 8 格处
            // 平滑海拔之差」。地形按真实测高曲线重分布后，同样的山体
            // 高差缩小约 5 倍（平原区缩小更多），所以 0.012 这个基线
            // 相对变大了 —— 温和丘陵现在也能拿到正确的抬升雨，
            // 而真正的山脉仍然触顶。
            const rise = eSmooth[idx] - upE;
            {
              const orographic = Math.min(0.55, 0.012 + Math.max(0, rise) * 9.0);
              const rain = m * orographic;
              precipAcc[idx] += rain;
              m -= rain;
            }

            // 背风坡下沉增温 + 干燥：越过山脉后水汽被「榨干」，
            // 同时下沉气流抑制成云，这是雨影区比普通内陆更干的原因。
            // 同样改写为连续形式（原来 if (rise < -0.010) m *= 0.975
            // 会在 -0.010 处造成 2.5% 的水汽断层，叠 22 遍后同样是硬边）。
            if (rise < 0) m *= 1 - Math.min(0.03, -rise * 3.0);

            // 逐步消耗：每遍走 8 格，净衰减 0.990/遍 →
            // 约 0.9987/格，e-folding ≈ 800 格（比大陆还宽）。
            // 水汽几乎能横穿整块大陆 —— 真正的干燥由「沿途被山拦下」
            // 与「大陆度衰减」负责，而不是靠一个武断的指数衰减。
            //
            // 【为什么衰减要这么慢】旧值每格 0.997 看着不狠，但大陆宽
            // 300 格，累积就是 0.40 倍；再乘大陆度衰减，内陆只剩海岸的
            // 1/4。而水汽本来只能送 80 格，两者叠加的结果是
            // **整块大陆腹地统一变成米色**（渲染图上就是一大片沙）。
            m *= 0.990;
            next[idx] = clamp01(m);
          }
        }

        // 扩散：这一行是「去掉发丝」的关键。
        // 纯平流把水汽压成 1 格宽的流线，而真实湍流扩散的尺度远大于一格。
        // 每遍掺入 30% 的 3×3 盒式平均，16 遍累积 ≈ 2 格半径的扩散：
        // 足以抹平脉络、让相邻风带的水汽互相渗透，但雨影依然清晰。
        mCur = mixBlur(next, W, H, 1, 0.30);
        // 沉积场同样每遍抹一次，避免降水被钉在推进路径上
        precipAcc = mixBlur(precipAcc, W, H, 1, 0.45);

        if ((pass & 3) === 0) {
          onProgress(0.82 + 0.05 * (pass / PASSES), '输运水汽…');
          await yieldToUi();
        }
      }
      moisture.set(mCur);

      // ---------- 大陆度干燥：越深入内陆越干 ----------
      //
      // 这一步是打破「纬度横带」的关键。原先只有输运过程中的衰减，
      // 内陆与沿海的差别被风带抹平，副热带从海岸到内陆都是一片荒漠；
      // 加上按距离的指数衰减后，湿润区会退到沿海/迎风侧，
      // 内陆形成真正的「大陆性干燥区」，群系因此成块分布。
      //
      // 【尺度】衰减半径 110 格 ≈ 40° 经度，地板 0.45。
      // 旧版地板 0.30 + 半径 90，等于「大陆中心最多只剩海岸的 30%」，
      // 而整块大陆中心都落在同一个值上 —— 大片平涂。
      // 抬到 0.45 后，内陆仍然明显偏干（够成草原/荒漠），
      // 但不至于全图一个色。
      for (let i = 0; i < N; i++) {
        if (cells[i].e < sea) continue;
        const d = distToSea[i] > 0 ? distToSea[i] : 0;
        const keep = 0.45 + 0.55 * Math.exp(-d / 110);
        moisture[i] = clamp01(moisture[i] * keep);
      }

      // ---------- 把两个场平滑到「气候区」尺度 ----------
      // r=3 的盒式模糊等效于 3 次 3×3，把残存的 1~2 格结构彻底抹掉。
      const pTerrain = boxBlur(precipAcc, W, H, 3);
      const pMoist = boxBlur(moisture, W, H, 3);

      // ---------- 降水量：合成 + 两端分位锚定的单调拉伸 ----------
      //
      // 降水由三部分组成：
      //   · 地形雨（pTerrain）：决定迎风坡/雨影的对比；
      //   · 残余水汽（pMoist）：反映「离海远近 + 风带输送」；
      //   · 季风降雨：季风区的雨季额外降水。
      //
      // 【为什么既不能用 pow(v/pMax)，也不能用分位映射】
      // 物理模拟给出的是**相对**干湿，绝对量级取决于一堆系数
      // （平流衰减、地形系数、大陆度衰减…），任何一个改一点，整条分布就平移。
      //
      // 试过两种归一化，都不行：
      //   ① pow(v / P97, γ)：模拟场的方差太小（实测 p50 是 p95 的 0.66，
      //      即「最湿」和「中位」差不多），γ 调到 1.2 森林 55%、荒漠 7%
      //      （整图一片绿），调到 1.6 温带全变荒漠。刀尖上走。
      //   ② 分位映射（按名次重排成固定分布）：份额确实可控了，但它**丢掉了
      //      绝对值** —— 实测把副热带海面水汽从 0.58 压到 0.28（落差一倍），
      //      输出的降水居然一个数都没变。因为「沿海」在整幅图的干湿排序里
      //      位置没动。于是「副热带西岸应该是沙漠」这类**量级**信息被洗掉了，
      //      海岸又变回等宽的绿边。
      //
      // 现在用第三种：**两端分位锚定 + gamma**。
      //   先把 P03 / P97 映射到 0 / 1（去掉离群值与整体平移），
      //   再做幂次拉伸控制中位数落点。
      // 它是**全局单调变换**，只改「标尺」，不改任何空间结构 ——
      // 干湿的排序、雨影、内陆梯度、纬度带落差全部原样保留；
      // 同时因为锚点固定在分位上，份额又可复现。

      let landCount = 0;
      for (let i = 0; i < N; i++) {
        const c = cells[i];
        if (c.e < sea) continue;
        const monsStr = Math.max(summer.strength[i], winter.strength[i]);
        c.precip = pTerrain[i] * 0.34 + pMoist[i] * 0.66 + monsStr * 0.10;
        landCount++;
      }
      const sorted = new Float32Array(landCount);
      {
        let k = 0;
        for (let i = 0; i < N; i++) if (cells[i].e >= sea) sorted[k++] = cells[i].precip;
        sorted.sort();
      }
      const qAt = (q) => sorted.length
        ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * q)))]
        : 0;
      const lo = qAt(0.03);
      const hi = qAt(0.97);
      const span = Math.max(1e-6, hi - lo);

      // 单因子 0.09：最干的陆地也不至于到 0（绝对荒漠也有一点露水）
      const PLOW = 0.09;
      const MED_TARGET = 0.37;
      const uMed = clamp01((qAt(0.5) - lo) / span);
      let gamma = 1.7;
      // 【幂次不写死，由中位数反解】写死 gamma 的老问题是：换一个 seed，
      // 模拟场的中位数位置就变了，固定 gamma 会把整张图推成「一片沙」
      // 或「一片绿」。这里直接要求「中位数必须落到 MED_TARGET」，
      // 反解出 gamma —— 无论种子/分辨率/地形怎么变，中位降水都是同一个值，
      // 只有分布形状随气候场变化。
      //
      // 【gamma 的夹取范围必须允许 < 1】模拟场通常是**右偏**的：
      // 大部分陆地在中低湿度（水汽一边走一边掉），少数迎风坡/海岸很高。
      // 这种分布的中位数落在 [P03,P97] 区间偏左的位置（实测 0.22），
      // 要把它拉到 0.44 需要 gamma < 1（凹函数）。
      // 早先夹在 [1.1, 3.0]，等于禁止「提亮」，于是 gamma 被钉死在 1.1，
      // 中位降水实际只有 0.26 —— 而代码注释还写着「中位数锁定 0.44」。
      if (uMed > 0.02 && uMed < 0.98) {
        gamma = Math.log((MED_TARGET - PLOW) / (1 - PLOW)) / Math.log(uMed);
      }
      // 【上限必须跟着场形状走】这一轮加入「海岸暖流加湿」之后，模拟场从
      // 右偏变成了**左偏**：大多数陆地都靠海（实测 93% 的陆地离海 ≤50 格），
      // 水汽供给被海温统一抬了一档，干区只剩深内陆和寒流岸。
      // 于是在 [P03,P97] 区间里，中位数被推到 0.76 的位置 ——
      // 反解出来 gamma 需要 4.1，而夹取上限还是 3.2，
      // 结果**归一化根本没达到自己写的目标**：MED_TARGET=0.37，
      // 实测中位降水却是 0.475，整张图偏湿（森林 58%、荒漠只剩 9.6%）。
      // 放宽到 5.0 让反解值真正能落地，中位数才真的被钉在 0.37。
      gamma = Math.max(0.45, Math.min(5.0, gamma));

      for (let i = 0; i < N; i++) {
        const c = cells[i];
        if (c.e < sea) continue;
        const u = clamp01((c.precip - lo) / span);
        c.precip = clamp01(PLOW + (1 - PLOW) * Math.pow(u, gamma));
        c.m = c.precip;
      }

      // ---------- 湿度的大尺度不均匀（去掉逐格噪声）----------
      //
      // 真实降水场除纬度带外，还有「大尺度湿中心 / 干中心」
      // （如沃克环流造成的暖池与冷舌）。
      //
      // 【旧实现错在哪】原来加的是 scale=4（约 4 格波长）的**高频**噪声
      // × 0.18，逐格独立地叠在降水上 —— 这是气候图「迷彩斑点」的直接来源。
      // 0.18 的幅度足以把降水推过 0.26 / 0.58 这些群系阈值，
      // 于是森林里冒出沙漠点、草原上冒出林地，全图碎成几十格的小块。
      // 现在改成尺度 2.2 的低频场、逐行去均值、模糊 r=2、幅度收到 0.07：
      // 它只负责让气候区边缘不规则，不负责造斑点。
      const pAnom = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const c = cells[i];
        pAnom[i] = this.noise(c.x / W, c.y / H - 0.5 + 50, 2.2, 3);
      }
      rowDemean(pAnom, W, H);
      const pAnomS = boxBlur(pAnom, W, H, 2);

      for (let i = 0; i < N; i++) {
        const c = cells[i];
        c.m = clamp01(c.precip + pAnomS[i] * 0.07);
        c.precip = c.m;
        // 记录「纯气候」基准值。水文算出来之后，还要叠加「河流/湖泊对
        // 局地生态的修正」（见 MapGenerator.applyWaterInfluence）。
        // 保存基准值是为了让编辑地形后重建水系时可以**重复计算**
        // 而不累积——否则每重建一次，河边就会更湿一点，最终变成沼泽。
        c.mBase = c.m;
        c.tempBase = c.temp;
      }

      // ---------- 5. 生态群系 ----------
      onProgress(0.88, '划分生态群系…');
      await yieldToUi();
      for (const c of cells) {
        c.biome = classifyBiome(c.temp, c.precip, c.e, sea, c.isLake, c.tempSea);
      }
      // 阈值切分会沿等值线切出大量几十格的碎块（「迷彩服」），
      // 用 2 遍多数表决把它们并入周围群系。详见 despeckleBiomes 注释。
      despeckleBiomes(cells, W, H, 2);
      // 再把小块（约 N/6000，即 50~85 格）整块并给邻接最多的群系：
      // 3×3 表决吃不掉 20~80 格的长条碎块，这一步才能把斑块中位数拉回「气候区」尺度。
      mergeSmallBiomeBlocks(cells, W, H, Math.max(40, Math.round(N / 6000)), 2);

      // 记录风场与季风，供渲染层绘制
      for (let i = 0; i < N; i++) {
        const c = cells[i];
        c.windU = windU[i];
        c.windV = windV[i];
        c.pressure = pressure[i];
        c.monsoon = Math.max(summer.strength[i], winter.strength[i]);
      }

      this.metrics = {
        totalMs: performance.now() - t0,
        windSample: { u: windU[0], v: windV[0] },
        monsoonMax: this.#maxOf(summer.strength),
      };
      return this;
    }

    #maxOf(arr) {
      let m = 0;
      for (let i = 0; i < arr.length; i++) if (arr[i] > m) m = arr[i];
      return m;
    }
  }

  FM.planetaryWind = planetaryWind;
  FM.monsoonField = monsoonField;
  FM.oceanCurrents = oceanCurrents;
  // 【LAPSE 必须对外暴露】选区塑形（terrain-ops.js）改完高度要按同一条
  // 直减率去修气温，否则新造的山按 0.45/unit 降温、气候按 0.42/unit 算，
  // 同一块地在两个阶段的气温对不上，编辑后再重算气候会看到温度跳变。
  FM.LAPSE = LAPSE;
  FM.classifyBiome = classifyBiome;
  FM.despeckleBiomes = despeckleBiomes;
  FM.mergeSmallBiomeBlocks = mergeSmallBiomeBlocks;
  FM.ClimateSystem = ClimateSystem;
})(window);
