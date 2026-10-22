/**
 * terrain-ops.js —— 地形雕塑算子（编辑器的手）
 *
 * ==================== 为什么要重做 ====================
 *
 * 旧笔刷的本质是「沿笔迹盖一串圆」：每次 pointermove 在圆心附近加一个
 * `strength × 平滑衰减 × 噪声` 的常数增量。由此得到的地形必然是
 * **圆头圆尾的等高圆柱**，问题不在参数调校，而在模型本身：
 *
 *   1. 横截面永远是对称圆弧 —— 像一条挤出来的橡皮泥，不像山；
 *   2. 抬升量只与「到圆心的距离」有关，没有方向 —— 画不出山脊走向，
 *      更画不出「迎风坡缓 / 背风坡陡」这种真实山体的不对称性；
 *   3. 没有支脉结构 —— 真实山脉是鱼骨状（主脊 + 侧脊），不是单根香肠；
 *   4. 抬升直接写进 e，没有坡度约束 —— 边缘是垂直墙，视觉上像贴上去的；
 *   5. 没有质量再分配 —— 山顶抬升而周围不变，不符合任何侵蚀规律。
 *
 * ==================== 新模型 ====================
 *
 * 把「编辑地形」拆成四个可控的几何/物理量：
 *
 *   A. 轴线（axis）：笔迹是一条有走向的**线**，不是一个点序列。
 *      点 → 线的转换用「等弧长步进」（walker），所以节点位置只取决于
 *      笔迹几何，与指针事件频率无关（这是旧实现靠 RDP 简化勉强做的事，
 *      现在是结构性保证）。
 *
 *   B. 横剖面（cross profile）：到轴线的垂直距离 d 与**有符号法线偏移**
 *      共同决定高度。两侧用不同指数：陡侧 1.35（窄、尖、近似断崖），
 *      缓侧 0.58（宽肩、长斜坡）。哪侧陡由一个确定性 hash 决定，
 *      所以同一段脊线左右不对称、而整条脊线风格统一。
 *
 *   C. 支脉（spur）：主脊上按弧长分叉出短脊，conf 沿长度衰减、
 *      并向切线方向弯曲（真实山脊的分叉总是向下游偏）。这一步把
 *      「单脊」变成「山系」。
 *
 *   D. 侵蚀（erosion）：合成高度后必须跑一遍——否则改动区域与原始地形
 *      之间是一条硬的台阶。
 *        · 热力侵蚀（thermal）：相邻格高差超过休止角就把多余物质搬给
 *          低处，产生**碎石坡 / 冲积扇**，并把垂直墙压成自然坡角；
 *        · 水力侵蚀（hydraulic）：D8 流向 + 汇流累积 + stream power，
 *          按流量与坡度削蚀，产生**沟谷网**。
 *
 * ==================== 关于「自然度」的可验证性 ====================
 *
 * 「自然」不是形容词，可以用几个客观量刻画（见 tools/verify-editor.js）：
 *   · 各向异性比  = 沿走向起伏 / 垂直走向起伏。圆盘笔刷 ≈ 1，山脊应 > 1.5；
 *   · 横截面不对称度 = |左坡平均坡度 − 右坡平均坡度| / 两者均值；
 *   · 坡度分位    = 热力侵蚀后 99 分位坡度应被压在休止角附近；
 *   · 汇流树状度  = 侵蚀后高流量格子应连成树状而非散点。
 * 本文件所有函数都是纯函数（只碰 cells 的 e / temp 与 TypedArray），
 * 不依赖 DOM，因此可以在 Node 里逐项量化，不需要真实浏览器。
 */
(function (root) {
  'use strict';

  const FM = root.FM = root.FM || {};

  // ==================== 确定性噪声 ====================
  //
  // 这里**不用** simplex-noise，原因有两条：
  //  1. simplex 的 noiseSeamless 是球面映射，频率语义是「绕球几圈」，
  //     在笔刷尺度（几十到几百格）下要么太粗要么精度不足；
  //  2. 编辑器需要「以格为单位」控制特征尺度，整数 hash 值噪声更直观，
  //     而且完全自包含 —— Node 里跑验证不需要先搭 simplex 环境。
  //
  // 跨经线不连续的问题在这里不重要：笔迹本身已经在数据坐标里解缠，
  // 单笔影响范围远小于一个周长。

  /**
   * 高度差 → 温度差。分母是"陆地可用高度"，因为 e 的 1.0 是最高峰、
   * seaLevel 是海面，陆地实际跨度只有 1 − seaLevel。
   *
   * 【必须与 climate.js 的 LAPSE 同一个数】这个换算在本文件里出现过
   * 三份副本（塑形 / 合成 / 侵蚀），climate.js 一份 —— 塑形按 0.42 降温、
   * 侵蚀按 0.45 降温，同一块地在两个阶段的气温就对不上。
   * 现在唯一来源是 FM.LAPSE（由 climate.js 导出）。
   */
  function lapseFor(seaLevel) {
    return (FM.LAPSE != null ? FM.LAPSE : 0.42) / Math.max(0.05, 1 - seaLevel);
  }

  const HASH_A = 374761393;
  const HASH_B = 668265263;
  const HASH_C = 1442695041;

  /** 32 位整数 hash → [0,1)，用 Math.imul 保证不丢精度 */
  function hash2(ix, iy, seed) {
    let h = Math.imul(ix | 0, HASH_A) ^ Math.imul(iy | 0, HASH_B) ^ Math.imul(seed | 0, HASH_C);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  /** 双线性 + smoothstep 的值噪声，返回 [0,1) */
  function valueNoise(x, y, seed) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const a = hash2(ix, iy, seed);
    const b = hash2(ix + 1, iy, seed);
    const c = hash2(ix, iy + 1, seed);
    const d = hash2(ix + 1, iy + 1, seed);
    const top = a + (b - a) * ux;
    const bot = c + (d - c) * ux;
    return top + (bot - top) * uy;
  }

  /** 标准分形噪声，返回 [-1,1] */
  function fbm(x, y, octaves, lacunarity, gain, seed) {
    let sum = 0;
    let amp = 1;
    let freq = 1;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += (valueNoise(x * freq, y * freq, seed + i * 101) * 2 - 1) * amp;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return norm > 0 ? sum / norm : 0;
  }

  /**
   * Ridged multifractal，返回 [0,1]。
   *
   * 关键在 `prev`：下一层的幅度被上一层的脊值调制（越靠近脊线细节越强），
   * 这是 Musgrave 的 ridged multifractal 与「对噪声取绝对值」的本质区别——
   * 前者生成连续延展的脊线网，后者只会在噪声零等值线附近留下一圈缝。
   */
  function ridgedFbm(x, y, octaves, lacunarity, gain, seed) {
    let sum = 0;
    let amp = 1;
    let freq = 1;
    let norm = 0;
    let prev = 1;
    for (let i = 0; i < octaves; i++) {
      let n = 1 - Math.abs(valueNoise(x * freq, y * freq, seed + i * 131) * 2 - 1);
      n *= n;
      sum += n * amp * prev;
      norm += amp;
      prev = 0.55 + 0.45 * n;
      amp *= gain;
      freq *= lacunarity;
    }
    return norm > 0 ? sum / norm : 0;
  }

  // ==================== 距离变换 / 伪随机 ====================

  /**
   * 距离变换里的"无穷"。
   *
   * 【不能用真正的 Infinity】抛物线下包络的第一步要算
   * (f[q] + q² − f[v] + v²) / (2q − 2v)，两边都是 Infinity 时得到 NaN；
   * 而  恒为 false，单调栈会被静默写坏 ——
   * 实测整张距离图全是 Infinity，内切半径退化成 bbox 尺寸的 1.5 倍。
   * 换成大而有限的数之后，(BIG+BIG)/(2q−2v) 仍是有限值，且 q² 项相对
   * 1e18 可忽略，抛物线求交退化成正确的垂直平分线。
   */
  const EDT_INF = 1e18;

  /**
   * 一维平方距离变换（Felzenszwalb & Huttenlocher）。
   *
   * f[q] = 该位置的初值（源点 0，其余 +∞），输出 d[q] = min_p (f[p] + (q-p)²)。
   * 抛物线下包络 + 单调栈，O(n)。
   */
  function edt1d(f, n, d, v, z) {
    let k = 0;
    v[0] = 0;
    z[0] = -EDT_INF;
    z[1] = EDT_INF;
    for (let q = 1; q < n; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = EDT_INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      const dq = q - v[k];
      d[q] = dq * dq + f[v[k]];
    }
  }

  /**
   * 二维**精确**欧氏距离变换：返回每个格子到最近源点的距离（已开方）。
   *
   * 【为什么不能用两遍倒角（chamfer）】倒角只有 8 个方向可用，误差在
   * 对角线方向可达 8%，而且**误差本身是有 8 重对称的**。拿它当高度场用，
   * 就会看到一个从中心发散的八角星 —— 这与"海盆里有放射状条纹"
   * 是同一个现象。距离场在这里既决定岸线形状又决定大陆面高度，
   * 精度不够的代价是整块大陆的形状被八方向网格污染。
   *
   * @param {Uint8Array} src 1 = 源点
   * @returns {Float32Array} 距离（源点为 0）
   */
  function edt2d(src, w, h) {
    const n = Math.max(w, h);
    const f = new Float64Array(n);
    const d = new Float64Array(n);
    const v = new Int32Array(n + 1);
    const z = new Float64Array(n + 2);
    const sq = new Float64Array(w * h);
    for (let i = 0; i < w * h; i++) sq[i] = src[i] ? 0 : EDT_INF;

    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) f[y] = sq[y * w + x];
      edt1d(f, h, d, v, z);
      for (let y = 0; y < h; y++) sq[y * w + x] = d[y];
    }
    for (let y = 0; y < h; y++) {
      const base = y * w;
      for (let x = 0; x < w; x++) f[x] = sq[base + x];
      edt1d(f, w, d, v, z);
      for (let x = 0; x < w; x++) sq[base + x] = d[x];
    }

    const out = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) out[i] = Math.sqrt(sq[i]);
    return out;
  }

  /**
   * 32 位可复现伪随机（mulberry32）。
   * 塑形必须是**确定性**的：同一个 seed 重画同一个选区要得到同一块大陆，
   * 否则"再点一次"就成了抽奖。
   */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ==================== 笔刷算子（编辑器已不再接线）====================
  //
  // 从「轴线栅格化」到「抚平」这四节是上一版笔刷管线的算子：
  //   轴线栅格化 → 强度场 → 高度 → 侵蚀 → 抚平
  // 编辑器现在只走「选区塑形」（见下面那一节），这些函数不再被调用，
  // 但保留下来：它们是被 12 项指标验证过的（tools/verify-editor.js），
  // 想再做「局部雕刻」类工具时可以直接复用。
  // 【注意】它们导出在 FM.TerrainOps 上，删之前先确认没有别的调用点。

  // ==================== 轴线栅格化 ====================

  /** 节点间距 = 笔刷半径 / 6：脊线的折点密度，越密越贴合手绘曲线 */
  const NODE_SPACING_RATIO = 1 / 6;
  /** 8 邻域偏移与距离 */
  const NB_DX = [1, 1, 0, -1, -1, -1, 0, 1];
  const NB_DY = [0, 1, 1, 1, 0, -1, -1, -1];
  const NB_SQRT2 = Math.SQRT2;

  /**
   * 沿笔迹「等弧长步进」发射节点。
   *
   * 【为什么要自己走而不是按事件点采】
   * pointermove 的采样密度取决于操作系统的上报频率与手的移动速度：
   * 快拖时两点相隔 40 格，慢拖时隔 1 格。若直接按事件点建轴线，
   * 同一条手绘曲线会得到完全不同的折点集合 —— 这就是旧实现里
   * 「结果与鼠标事件频率有关」的根源。
   *
   * 这里把「上一次落点 → 本次落点」当作一条线段，按固定 spacing 在线上
   * 取整点。节点位置只由累计弧长决定，因此**快拖慢拖得到同一串节点**。
   */
  class StrokeWalker {
    constructor(spacing) {
      this.spacing = Math.max(1.5, spacing);
      /** 沿笔迹走过的总距离（绝对弧长，不取模、不重置） */
      this.travel = 0;
      /** 下一个要发射节点的绝对弧长 */
      this.nextEmit = 0;
      this.lastX = null;
      this.lastY = null;
      this.nodes = [];
    }

    /** 起点：直接产出一个节点 */
    begin(x, y) {
      this.lastX = x;
      this.lastY = y;
      this.travel = 0;
      this.nextEmit = this.spacing;
      this.nodes.length = 0;
      this.nodes.push({ x, y, arc: 0 });
      return this.nodes[0];
    }

    /**
     * 推进到新位置，返回本次新产出的节点数组（可能为空）。
     *
     * 【为什么用「绝对弧长 + 阈值」而不是「剩余量累减」】
     * 累减写法每次都要做 `spacing − acc` 和 `len − (t − spacing)` 两次减法，
     * 浮点误差会一路累积；实测在 280 格长的直线上，密集采样（每 0.5 格）
     * 与稀疏采样（两点）会得出 31 个 vs 30 个节点。多出的那个节点会让
     * 支脉的 index 整体错位、端部包络也按不同的 span 计算，
     * 于是同一笔画出完全不同的山 —— 差在 0.29 的强度值上。
     *
     * 改成「记录已走总距离 travel，与下一个目标弧长 nextEmit 比较」之后，
     * 两条路径的 nextEmit 序列完全相同（都是 spacing 的等和），
     * 只要总距离一致，节点集合就一致。
     */
    advance(x, y) {
      const out = [];
      if (this.lastX === null) {
        this.begin(x, y);
        return this.nodes.slice();
      }
      const x0 = this.lastX;
      const y0 = this.lastY;
      const dx = x - x0;
      const dy = y - y0;
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) return out;
      const ux = dx / len;
      const uy = dy / len;
      const segStart = this.travel;
      const segEnd = segStart + len;

      // 1e-6 容差：让「恰好落在端点上」的情况在密集/稀疏采样下判断一致
      while (this.nextEmit <= segEnd + 1e-6) {
        const t = Math.min(len, Math.max(0, this.nextEmit - segStart));
        const nx = x0 + ux * t;
        const ny = y0 + uy * t;
        const node = { x: nx, y: ny, arc: this.nextEmit };
        out.push(node);
        this.nodes.push(node);
        this.nextEmit += this.spacing;
      }
      this.travel = segEnd;
      this.lastX = x;
      this.lastY = y;
      return out;
    }
  }

  /**
   * 把一段轴线盖进强度场（max 合并）。
   *
   * 【为什么用 max 而不是 +=】
   * 强度场的语义是「这里该抬多高」，属于**形状**而不是**累积量**。
   * 用 max 合并有两个好处：
   *   1. 与栅格化顺序、分批方式无关 —— 增量算和一次算结果完全相同，
   *      这是「拖动预览」与「松手定稿」能共用同一份代码的前提；
   *   2. 支脉与主脊自然融合（谁高听谁的），不会在交汇处堆出双倍高度。
   *
   * @returns {{x0:number,y0:number,x1:number,y1:number}|null} 本段的包围盒
   */
  function stampSegment(field, W, H, ax, ay, bx, by, opt) {
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    // 两侧宽度不同：陡侧窄、缓侧宽，这是「不对称」的来源。
    // 用两个独立宽度而不是「同一个宽度配两个指数」——
    // 指数只改变衰减曲线形状，改变不了山体的**重心偏移**；
    // 真实山脊的脊线本来就不在山体正中（断层崖一侧窄得多）。
    const wSteep = opt.wSteep;
    const wGentle = opt.wGentle;
    const conf = opt.conf;
    // 【A/B 端点插值】段内参数不是常量，而是从 A 端线性过渡到 B 端。
    // 早先每段一个常量 conf，相邻两段的强度在衔接处直接跳一级；
    // max 合并之后那道跳变就是一条折痕 —— 一条长笔迹上能看到十几道棱，
    // 像没加平滑的低模。插值之后强度沿走向是连续的。
    const wSteepB = opt.wSteepB != null ? opt.wSteepB : wSteep;
    const wGentleB = opt.wGentleB != null ? opt.wGentleB : wGentle;
    const confB = opt.confB != null ? opt.confB : conf;
    if (Math.max(conf, confB) <= 0 || wSteep <= 0.5 || wGentle <= 0.5) return null;

    // 法线方向：决定「左坡 / 右坡」
    const len = Math.sqrt(lenSq);
    const nx = len > 1e-9 ? -dy / len : 0;
    const ny = len > 1e-9 ? dx / len : 1;
    const exp = opt.exp;
    const steepSide = opt.steepSide;

    const reach = Math.max(wSteep, wGentle, wSteepB, wGentleB) + 1;
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - reach));
    const y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by) + reach));
    // x 允许跨经线：轴线的 x 已在数据坐标里解缠，可能超出 [0,W)
    const cxMin = Math.floor(Math.min(ax, bx) - reach);
    const cxMax = Math.ceil(Math.max(ax, bx) + reach);

    let bx0 = Infinity;
    let bx1 = -Infinity;
    let by0 = Infinity;
    let by1 = -Infinity;

    const invLenSq = lenSq > 1e-9 ? 1 / lenSq : 0;

    for (let y = y0; y <= y1; y++) {
      const rowBase = y * W;
      for (let cx = cxMin; cx <= cxMax; cx++) {
        // 点到线段最近点参数
        let t = invLenSq > 0 ? ((cx - ax) * dx + (y - ay) * dy) * invLenSq : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = ax + dx * t;
        const py = ay + dy * t;
        const ddx = cx - px;
        const ddy = y - py;
        const dist = Math.sqrt(ddx * ddx + ddy * ddy);
        const side = (ddx * nx + ddy * ny) >= 0 ? 1 : -1;
        const wA = side === steepSide ? wSteep : wGentle;
        const wB = side === steepSide ? wSteepB : wGentleB;
        const w = wA + (wB - wA) * t;
        if (w <= 0.5 || dist >= w) continue;

        // u: 1 在脊线、0 在影响边缘；指数 > 1 → 脊顶尖、山脚展宽
        const u = 1 - dist / w;
        const c = conf + (confB - conf) * t;
        const v = c * Math.pow(u, exp);
        if (v <= 0.001) continue;

        const wx = ((cx % W) + W) % W;
        const i = rowBase + wx;
        if (v > field[i]) field[i] = v;

        if (cx < bx0) bx0 = cx;
        if (cx > bx1) bx1 = cx;
        if (y < by0) by0 = y;
        if (y > by1) by1 = y;
      }
    }
    if (bx0 > bx1) return null;
    return { x0: bx0, y0: by0, x1: bx1, y1: by1 };
  }

  /**
   * 从主脊节点派生「支脉」。
   *
   * 真实山脉的分叉是有规律的：
   *   · 主脊中部支脉最长、两端收敛（用 arcEnv 控制）；
   *   · 支脉不是笔直的，越往外越向下游偏（用 bend 让它沿切线方向弯）；
   *   · 支脉比主脊矮、窄，且越远越弱（conf 与 halfWidth 沿长度衰减）。
   *
   * @param {{x:number,y:number,arc:number,index:number}} node
   * @param {{x:number,y:number}} tangent 单位切线
   * @returns {Array} 段参数数组（未栅格化）
   */
  function spawnSpurs(node, tangent, radius, seed, arcEnv) {
    const out = [];
    // 【每个节点最多一条支脉，左右二选一】
    // 早先写的是「两侧各 42% 概率」，结果平均每个节点长 0.84 条支脉，
    // 而节点间距只有半径的 1/6 —— 渲染出来是一条"毛毛虫"，脊线被
    // 一堆等长等距的短刺包住，完全不像分水岭。
    // 真实山系里支脉间隔远大于脊宽，且左右交替而不是对称。
    if (hash2(node.index, 2, seed) > 0.44) return out;

    const side = hash2(node.index, 3, seed) > 0.5 ? 1 : -1;
    // 支脉方向 = 法线 + 切向 × 倾斜量：与主脊成 30~45°，
    // 且一律向下游偏 —— 分水岭从来不会垂直挂在主脊上。
    const tilt = 0.30 + 1.05 * hash2(node.index, 5, seed);
    let dx = -tangent.y * side + tangent.x * tilt;
    let dy = tangent.x * side + tangent.y * tilt;
    const dl0 = Math.hypot(dx, dy) || 1;
    dx /= dl0;
    dy /= dl0;

    // 长度：脊宽的两倍上下，长一点才像山腿而不是刺
    const len = radius * (0.62 + 0.55 * hash2(node.index, 9, seed)) * arcEnv;
    if (len < radius * 0.25) return out;

    // 轻微弯曲：越往外越向切向偏，形成自然的弧形山腿
    const bend = (hash2(node.index, 11, seed) - 0.5) * 0.5;
    const SEGS = 3;
    let px = node.x;
    let py = node.y;
    for (let k = 0; k < SEGS; k++) {
      const t0 = k / SEGS;
      const t1 = (k + 1) / SEGS;
      const bxAmt = bend * t1;
      let ux = dx + tangent.x * bxAmt;
      let uy = dy + tangent.y * bxAmt;
      const ul = Math.hypot(ux, uy) || 1;
      ux /= ul;
      uy /= ul;
      const qx = px + ux * (len * (t1 - t0));
      const qy = py + uy * (len * (t1 - t0));

      // conf 从 0.42 衰减到 0.08：支脉要明显低于主脊，末端融进原地形
      const conf = 0.42 * Math.pow(1 - t1 * 0.82, 1.2);
      // 半宽 0.40R→0.24R，口径同主脊（×2 后才是总宽）：
      // 支脉总宽 0.8R→0.48R，明显细于主脊的 1.3~1.8R —— 山腿根粗梢细
      const baseW = radius * (0.40 - 0.16 * t1);
      const skew = 0.44 + 0.14 * hash2(node.index, side + 61, seed);
      out.push({
        ax: px, ay: py, bx: qx, by: qy,
        conf,
        wSteep: 2 * baseW * skew,
        wGentle: 2 * baseW * (1 - skew),
        exp: 1.65,
        steepSide: hash2(node.index * 7 + k, side + 40, seed) > 0.5 ? 1 : -1,
      });
      px = qx;
      py = qy;
    }
    return out;
  }

  /**
   * 主脊的节点级参数。
   *
   * 【为什么按「节点」而不是「段」算】早先是每段一个常量 conf，
   * 段与段之间直接跳一级，max 合并后那道跳变就是一条折痕 ——
   * 一条长笔迹上能看到十几道棱。改成节点级参数 + 段内线性插值之后，
   * 强度沿走向才是连续的。
   *
   * 参数必须是**弧长的连续函数**（用 sin 而不是逐节点哈希），
   * 否则插值只是把随机跳变抹成锯齿。
   *
   * 沿走向用**绝对弧长**而不是归一化位置：拖动过程中笔迹还在延长，
   * 归一化位置会不断变化，已生成段的强度就会被"追溯修改"，
   * 预览会闪，结果也不可复现。
   */
  function axisNodeParams(arc, radius, stroke) {
    // 主峰 / 鞍部：波长约 1.55R，一条笔迹上能看到 2~4 个峰
    const wave = 0.5 + 0.5 * Math.sin((arc / (radius * 1.55)) * Math.PI * 2 + stroke.phase);
    const env = 0.40 + 0.60 * wave;
    // 宽度沿走向缓慢变化：山体不该是等宽的带子
    const baseW = radius * (0.56 + 0.18 * Math.sin((arc / (radius * 0.85)) * Math.PI * 2 + stroke.phase * 1.7));
    return {
      conf: env,
      // 【注意这两个宽度的口径】baseW 是「平均半宽」，
      // 乘 2 之后左右两侧加起来正好是 2×baseW ≈ 笔刷直径，
      // 才和光标的圆圈对得上。早先写成 wSteep = baseW*skew、
      // wGentle = baseW*(2-skew)，缓坡侧实际达到 1.55R ——
      // 一笔 46px 的笔刷铺出 160 格宽的山，高 0.28、宽 160，
      // 坡度只有 1:140，渲染出来就是一块薄饼（p50 坡度 0.0011）。
      wSteep: 2 * baseW * stroke.skew,
      wGentle: 2 * baseW * (1 - stroke.skew),
    };
  }

  /**
   * 整条笔迹共用的「断面风格」：陡坡朝哪一侧、脊线偏向哪一侧。
   *
   * 由种子决定而不是每段随机 —— 同一笔的左右不对称必须是一致的，
   * 否则统计上会互相抵消（见 axisNodeParams 的注释）。
   */
  function strokeStyle(seed) {
    return {
      steepSide: hash2(seed, 17, seed) > 0.5 ? 1 : -1,
      // 0.34~0.46：陡侧占 68%~92% 的平均半宽，缓侧占 108%~132%。
      // 比例再极端（早先 0.4~0.5 再乘 2 之后）缓坡会宽到 1.5R，
      // 山体的重心整个偏出去，看起来像被风堆出来的沙丘而不是山脊。
      skew: 0.34 + 0.12 * hash2(seed, 23, seed),
      // 峰谷相位的起点，让每一笔的峰位不重合
      phase: hash2(seed, 29, seed) * Math.PI * 2,
    };
  }

  /** 笔迹主方向（首尾连线），用于把细节噪声沿走向拉长 */
  function pathDirection(nodes) {
    if (nodes.length < 2) return { dirX: 1, dirY: 0 };
    const a = nodes[0];
    const b = nodes[nodes.length - 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dl = Math.hypot(dx, dy);
    if (dl < 1e-6) return { dirX: 1, dirY: 0 };
    return { dirX: dx / dl, dirY: dy / dl };
  }

  /**
   * 栅格化 nodes[fromIndex..] 这些节点产生的段。
   *
   * 拖动预览用 fromIndex = 已有节点数，只处理新增部分，
   * 于是每次 pointermove 的开销恒定，与笔画已经多长无关。
   *
   * max 合并的性质保证了「分批栅格化」与「一次栅格化」结果相同 ——
   * 唯一的差别是端部收敛包络：预览阶段还不知道总长度，
   * 所以用 opt.endFade === false 关掉，松手时再整体重算补上。
   */
  function stampIncremental(field, W, H, nodes, fromIndex, opt) {
    const radius = opt.radius;
    const seed = opt.seed | 0;
    const stroke = opt.stroke || strokeStyle(seed);
    const arcEnvBase = opt.arcEnv != null ? opt.arcEnv : 1;
    const dir = pathDirection(nodes);
    let box = null;
    const start = Math.max(0, fromIndex);

    // 端部收敛系数：笔迹两端不做满高，避免"断崖式收尾"
    const fadeAt = (i) => {
      if (opt.endFade === false) return 1;
      const span = Math.max(1, nodes.length - 1);
      const f = Math.min(
        Math.min(1, i / Math.max(1, span * 0.18)),
        Math.min(1, (nodes.length - 1 - i) / Math.max(1, span * 0.18))
      );
      return 0.45 + 0.55 * Math.sqrt(f);
    };

    for (let i = start; i < nodes.length; i++) {
      const a = nodes[i];
      if (i === 0) continue;
      const p = nodes[i - 1];
      const prev = nodes[i - 2] || p;
      const next = nodes[i + 1] || a;
      let tx = next.x - prev.x;
      let ty = next.y - prev.y;
      const tl = Math.hypot(tx, ty);
      if (tl > 1e-6) { tx /= tl; ty /= tl; } else { tx = dir.dirX; ty = dir.dirY; }

      const eA = arcEnvBase * fadeAt(i - 1);
      const eB = arcEnvBase * fadeAt(i);
      const pA = axisNodeParams(p.arc, radius, stroke);
      const pB = axisNodeParams(a.arc, radius, stroke);

      // ---- 第一层：主脊（窄、高） ----
      box = mergeBox(box, stampSegment(field, W, H, p.x, p.y, a.x, a.y, {
        conf: Math.min(1, pA.conf * eA),
        confB: Math.min(1, pB.conf * eB),
        wSteep: pA.wSteep, wSteepB: pB.wSteep,
        wGentle: pA.wGentle, wGentleB: pB.wGentle,
        // 指数 1.55：横剖面凹向上 —— 靠近山脊陡、往山脚逐渐放缓，
        // 剩下的「坡脚堆积」由热力侵蚀补完（那才是碎石坡的成因）。
        exp: 1.55,
        // 【关键】整条笔迹共用同一侧陡坡。
        // 曾经这里按段随机，结果左右坡交替，统计下来不对称度只有 0.02 ——
        // 视觉上就是"两边一样"的圆包。真实山脉的陡坡是连续的。
        steepSide: stroke.steepSide,
      }));

      // ---- 第二层：山体基座（宽、矮） ----
      //
      // 【为什么需要这一层】只有主脊时，山是一道薄墙：脊线两侧二十来格
      // 就掉回平地，没有"山脚"。真实的整座山是「陡脊 + 大片缓坡山体 +
      // 山麓冲积裙」，三个尺度叠在一起。
      // 这一层把同一根轴线铺到 1.9 倍宽、只抬到 0.42 倍高 ——
      // max 合并之后，脊线仍然是脊线（它更高），但外围多出一圈
      // 有起伏的山体，不再是"一根线插在平地上"。
      //
      // 【为什么不用支脉代替】早先试过从脊线派生支脉，结果每一段
      // 短短的胶囊各自收尾，末端全是尖端 —— 沿脊线排开就是一副鱼骨，
      // 渲染出来是密集的尖刺（消融实验里关掉支脉，尖刺立刻消失）。
      // 基座层是连续的，不会有收尾尖点。
      box = mergeBox(box, stampSegment(field, W, H, p.x, p.y, a.x, a.y, {
        conf: Math.min(1, pA.conf * eA) * 0.68,
        confB: Math.min(1, pB.conf * eB) * 0.68,
        wSteep: pA.wSteep * 2.15, wSteepB: pB.wSteep * 2.15,
        wGentle: pA.wGentle * 2.15, wGentleB: pB.wGentle * 2.15,
        // 基座用低指数（几乎线性）—— 它要的是「一大片缓坡」，
        // 指数一大就变成又一个尖包，白占宽度。
        exp: 1.25,
        steepSide: stroke.steepSide,
      }));

      if (opt.spurs === true) {
        const n = { x: a.x, y: a.y, arc: a.arc, index: i };
        const spurs = spawnSpurs(n, { x: tx, y: ty }, radius, seed, arcEnvBase * fadeAt(i));
        for (const sp of spurs) {
          box = mergeBox(box, stampSegment(field, W, H, sp.ax, sp.ay, sp.bx, sp.by, sp));
        }
      }
    }
    return box;
  }

  /**
   * 松手时的总闸：把整条笔迹（含支脉）整体栅格化一遍。
   *
   * 拖动中是增量累积的，理论上与一次栅格化等价（max 合并不依赖顺序）。
   * 这里仍然整体重算，是为了让**端部收敛**与**支脉朝向**按最终笔迹
   * 重新确定 —— 拖动时最后一个节点的切线还不存在，支脉会朝错方向。
   * 重算一遍让结果只取决于最终笔迹形状。
   */
  function buildStrokeField(field, W, H, nodes, opt) {
    field.fill(0);
    const seed = opt.seed | 0;
    const box = stampIncremental(field, W, H, nodes, 0, {
      radius: opt.radius,
      seed,
      spurs: opt.spurs,
      arcEnv: opt.arcEnv,
      endFade: true,
      stroke: strokeStyle(seed),
    });
    const dir = pathDirection(nodes);
    return { box, dirX: dir.dirX, dirY: dir.dirY };
  }

  function mergeBox(a, b) {
    if (!b) return a;
    if (!a) return { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 };
    if (b.x0 < a.x0) a.x0 = b.x0;
    if (b.y0 < a.y0) a.y0 = b.y0;
    if (b.x1 > a.x1) a.x1 = b.x1;
    if (b.y1 > a.y1) a.y1 = b.y1;
    return a;
  }

  // ==================== 强度场 → 高度 ====================

  /**
   * 把强度场合成为高度增量。
   *
   * @param {Array} cells
   * @param {{field:Float32Array, box:object, mode:string, amp:number,
   *          seaLevel:number, seed:number, mask?:Float32Array}} opt
   * @returns {{changed:number, maxDelta:number, box:object}}
   */
  function synthesize(cells, W, H, opt) {
    const field = opt.field;
    const box = opt.box;
    const mask = opt.mask || null;
    const mode = opt.mode || 'raise';
    const amp = opt.amp;
    const seed = opt.seed | 0;
    const seaLevel = opt.seaLevel;
    const sign = (mode === 'lower' || mode === 'basin') ? -1 : 1;
    const detailScale = opt.detailScale != null ? opt.detailScale : 0.11;
    const lapse = lapseFor(seaLevel);
    // 细节噪声的「走向」：把特征沿这个方向拉长
    const dirX = opt.dirX != null ? opt.dirX : 1;
    const dirY = opt.dirY != null ? opt.dirY : 0;

    let changed = 0;
    let maxDelta = 0;
    const outBox = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };

    const x0 = Math.max(0, Math.floor(box.x0));
    const x1 = Math.min(W - 1, Math.ceil(box.x1));
    const y0 = Math.max(0, Math.floor(box.y0));
    const y1 = Math.min(H - 1, Math.ceil(box.y1));

    for (let y = y0; y <= y1; y++) {
      const rowBase = y * W;
      for (let x = x0; x <= x1; x++) {
        const i = rowBase + x;
        let v = field[i];
        if (v <= 0.002) continue;
        if (mask) {
          v *= mask[i];
          if (v <= 0.002) continue;
        }

        // ---- 细节：ridged 山脊 + 碎石颗粒 ----
        //
        // 【为什么要旋转坐标系】如果细节噪声各向同性，它会在**所有方向**
        // 上等量地加起伏 —— 沿走向的起伏一多，山脊就碎成一串圆包，
        // 各向异性比被拉回 1 附近（实测旧写法只有 1.21）。
        // 真实山地的纹理是拉长的：脊线沿走向连续延伸，冲沟垂直走向排列。
        // 所以把采样坐标转到「沿走向 / 垂直走向」两轴上，并让前者的特征
        // 尺度是后者的 3 倍 —— 这就是「山看起来有方向」的直接来源。
        const along = x * dirX + y * dirY;
        const across = -x * dirY + y * dirX;
        // 【八度必须少】base 波长在 across 方向约 6 格，3 个八度之后
        // 最低层只剩 1.4 格 —— 山体阴影是逐格差分的，1 格波长的高频
        // 会直接变成一层"砂纸"（预览图里看得非常明显）。
        // 真实的细碎冲沟交给水力侵蚀去切，噪声只负责中尺度起伏。
        const ridge = ridgedFbm(along * detailScale * 0.45, across * detailScale * 1.15, 2, 2, 0.55, seed);
        const grain = fbm(x * detailScale * 2.2, y * detailScale * 2.2, 2, 2, 0.5, seed + 977);
        // 0.5 是 ridged 的中位水平；高于中位的地方再加一点，形成脊线凸起
        //
        // 幅度必须克制：detail 是**高频**项，在 90 倍夸张的山体阴影下，
        // ±0.35 的调制会变成一层"绒毛"（实测直接把山脊糊成毛刷）。
        const detail = (ridge - 0.45) * 0.26 + grain * 0.025;

        // ---- 中尺度「山块」起伏 ----
        //
        // 【为什么必须有这一层】没有它，强度场沿走向是均匀的：
        // 一条笔迹出来的就是一根等高等宽的管子，横截面像被挤出成型。
        // 真实山系的脊线是**一坨一坨的山块串起来的** —— 峰与峰之间有鞍部，
        // 山块两侧还会鼓出来。这一层用 2D 噪声（不做走向拉长，所以是
        // 各向同性的团块）乘到强度上，把管子捏成一串山块。
        // 幅度 0.40：再大就会把山脊切成一节一节的孤岛。
        // 沿走向略拉长（0.55 vs 1.30）：山块是「顺着山系排开」的，不是一堆等大的圆包。
        // 这一步同时把各向异性比从 1.42 拉回来一些 —— 各向同性的团块会把方向性稀释掉。
        const massif = fbm(along * detailScale * 0.55, across * detailScale * 1.30, 3, 2, 0.5, seed + 31);
        const bulge = 1 + massif * 0.40;

        // 【细节的权重不再乘 v】早先写的是 v*(1+detail*v)，detail 的作用
        // 正比于 v² —— 结果是山麓一带完全光滑，山体看起来像被抹了一层腻子，
        // 只有脊线附近有质感。真实山地的碎屑坡、冲沟、岩坎是一路铺到山脚的。
        // 改成 (0.55 + 0.45*v)：山麓也有 55% 的细节，脊线处仍是满额。
        // 夹到 [0,1]：shaped 是「相对峰值」，超过 1 没有意义 ——
        // 山块抖动与细节噪声会把它顶到 1.1~1.4，那部分会被 e=1 的硬上限
        // 截成一片没有明暗变化的纯白（预览里脊顶的白色小斑点就是它）。
        // 夹住之后，一笔的最大抬升恰好等于 amp，强度滑块与 landE 增幅
        // 变成线性对应，也不再出现莫名其妙的过曝。
        const shaped = Math.max(0, Math.min(1, v * bulge * (1 + detail * (0.55 + 0.45 * v))));

        const delta = sign * shaped * amp;
        if (Math.abs(delta) < 1e-5) continue;

        const c = cells[i];
        const before = c.e;
        let next = before + delta;
        // 高度硬边界：上限 1（雪线以上留空间），下限 -0.6（海沟量级）
        if (next > 1) next = 1;
        if (next < -0.6) next = -0.6;
        const real = next - before;
        if (Math.abs(real) < 1e-6) continue;

        c.e = next;
        // 气温随海拔同步：与 climate.js 的直减率保持一致（0.45 / 相对高度）
        c.temp = Math.max(0, Math.min(1, c.temp - real * lapse));
        changed++;
        const ad = Math.abs(real);
        if (ad > maxDelta) maxDelta = ad;
        if (x < outBox.x0) outBox.x0 = x;
        if (x > outBox.x1) outBox.x1 = x;
        if (y < outBox.y0) outBox.y0 = y;
        if (y > outBox.y1) outBox.y1 = y;
      }
    }
    return { changed, maxDelta, box: outBox };
  }

  // ==================== 侵蚀 ====================

  /**
   * 热力侵蚀（single pass）。
   *
   * 物理依据：松散物质的**休止角**。相邻格高差超过 talus 时，
   * 多余部分会崩塌到低处，直到坡度回落到休止角附近。
   *
   * 这一步做三件「自然」必需的事：
   *   1. 把编辑留下的垂直墙压成真实坡角（不会出现 90° 台阶）；
   *   2. 在山脚堆积出碎石坡 / 冲积扇（质量守恒，不是凭空削平）；
   *   3. 让不同笔画的交叠处自动融合 —— 后一笔的墙会被前一筆的坡吸收。
   */
  function thermalPass(h, bw, bh, talus, rate) {
    const n = bw * bh;
    const delta = new Float32Array(n);
    const diffs = new Float64Array(8);

    for (let y = 1; y < bh - 1; y++) {
      for (let x = 1; x < bw - 1; x++) {
        const i = y * bw + x;
        const hi = h[i];
        let total = 0;
        let maxExcess = 0;
        for (let k = 0; k < 8; k++) {
          const dx = NB_DX[k];
          const dy = NB_DY[k];
          const j = (y + dy) * bw + (x + dx);
          // 对角邻居距离 √2，允许的高差也按比例放大
          const limit = talus * (dx !== 0 && dy !== 0 ? NB_SQRT2 : 1);
          const excess = hi - h[j] - limit;
          if (excess > 0) {
            diffs[k] = excess;
            total += excess;
            if (excess > maxExcess) maxExcess = excess;
          } else {
            diffs[k] = 0;
          }
        }
        if (total <= 0) continue;
        // 一次最多搬走两倍「最大超出量」：防止在陡坡上来回震荡
        const move = Math.min(total, maxExcess * 2) * rate;
        if (move <= 1e-9) continue;
        delta[i] -= move;
        const inv = move / total;
        for (let k = 0; k < 8; k++) {
          if (diffs[k] <= 0) continue;
          const j = (y + NB_DY[k]) * bw + (x + NB_DX[k]);
          delta[j] += diffs[k] * inv;
        }
      }
    }
    for (let i = 0; i < n; i++) h[i] += delta[i];
  }

  /**
   * 水力侵蚀（single pass）。
   *
   * 流程与 hydrology.js 同构，但只作用于局部窗口：
   *   D8 最陡下降 → 按高度降序累积流量 → stream power 削蚀 + 部分沉积。
   *
   * stream power:  E = K · Q^0.5 · S
   *   Q 用「汇水格数 / 窗口面积」归一化，于是 K 与窗口大小无关；
   *   S 是到下游格的坡度（按距离归一）。
   * 只有 27% 的侵蚀物沉积在紧邻下游，其余视为被水流带出窗口 ——
   * 这样谷底会被真正掏深，而不是把土原地搬到旁边堆起来。
   */
  function hydraulicPass(h, bw, bh, kFactor, depositRatio, maxDrop, minAreaCells) {
    const n = bw * bh;
    if (n < 64) return;
    const down = new Int32Array(n).fill(-1);
    const slopeArr = new Float32Array(n);

    // ---- 1. D8 最陡下降 ----
    for (let y = 1; y < bh - 1; y++) {
      for (let x = 1; x < bw - 1; x++) {
        const i = y * bw + x;
        const hi = h[i];
        let best = -1;
        let bestSlope = 0;
        for (let k = 0; k < 8; k++) {
          const dx = NB_DX[k];
          const dy = NB_DY[k];
          const j = (y + dy) * bw + (x + dx);
          const dh = hi - h[j];
          if (dh <= 0) continue;
          const s = dh / (dx !== 0 && dy !== 0 ? NB_SQRT2 : 1);
          if (s > bestSlope) {
            bestSlope = s;
            best = j;
          }
        }
        down[i] = best;
        slopeArr[i] = bestSlope;
      }
    }

    // ---- 2. 桶排序（按高度升序）----
    // 用 2048 个桶代替 Array.sort：31 万格排序约 40 ms，桶排序约 3 ms。
    let minH = Infinity;
    let maxH = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = h[i];
      if (v < minH) minH = v;
      if (v > maxH) maxH = v;
    }
    const span = maxH - minH;
    const BINS = 2048;
    const order = new Int32Array(n);
    if (span < 1e-9) {
      for (let i = 0; i < n; i++) order[i] = i;
    } else {
      const count = new Int32Array(BINS);
      const inv = BINS / span;
      for (let i = 0; i < n; i++) {
        let b = ((h[i] - minH) * inv) | 0;
        if (b >= BINS) b = BINS - 1;
        count[b]++;
      }
      const start = new Int32Array(BINS);
      let acc = 0;
      for (let b = 0; b < BINS; b++) {
        start[b] = acc;
        acc += count[b];
      }
      const cursor = start.slice();
      for (let i = 0; i < n; i++) {
        let b = ((h[i] - minH) * inv) | 0;
        if (b >= BINS) b = BINS - 1;
        order[cursor[b]++] = i;
      }
    }

    // ---- 3. 汇流累积（从高到低）----
    const flow = new Float32Array(n);
    flow.fill(1);
    for (let idx = n - 1; idx >= 0; idx--) {
      const i = order[idx];
      const d = down[i];
      if (d >= 0) flow[d] += flow[i];
    }

    // ---- 4. 削蚀 + 沉积 ----
    //
    // 【汇水面积门槛】早先每一格都削（flow=1 也算），等于全坡面均匀剥蚀 ——
    // 整片高度一起降下去，反而把地形的凹凸抹平了：实测「沟谷下切度」
    // 侵蚀后比侵蚀前还低（0.00172 → 0.00153），根本切不出沟。
    // 真实的水力侵蚀是**集中**的：只有汇水面积足够大的地方才有持续的
    // 搬运能力，坡面上散流带不走多少东西。加一个门槛之后，只有河道下切、
    // 坡面基本不动，沟谷才会真正凹下去。
    // 【门槛必须是绝对汇水格数，不能是区域面积的比例】
    // 一条山脊向两侧散水，每条沟的汇水量只有几百格；区域却有七万多格。
    // 用「面积的 0.2%」当门槛（=148 格）已经超过实际最大汇水量（实测 271~312），
    // 于是几乎没有格子能过门槛，整段水力侵蚀变成空操作，
    // 调 kFactor 从 0.65 到 5.0 结果一个数都不变。
    // 绝对门槛的物理含义清楚：集水面积达到 30 格才形成沟。
    const minArea = minAreaCells != null ? minAreaCells : 30;
    const invN = 1 / n;
    for (let idx = n - 1; idx >= 0; idx--) {
      const i = order[idx];
      const d = down[i];
      if (d < 0) continue;
      if (flow[i] < minArea) continue;
      const q = Math.sqrt(flow[i] * invN);      // 归一化流量的平方根（stream power）
      let drop = kFactor * q * slopeArr[i];
      if (drop > maxDrop) drop = maxDrop;
      if (drop <= 1e-7) continue;
      h[i] -= drop;

      // 【沉积只发生在「坡度变缓」的地方】
      // 早先无条件把 27% 的削蚀量还给下游格 —— 可是下游格通常**就是河道本身**，
      // 于是同一条沟一边被切、一边被填，净效果是把凹形抹平。
      // 真实河流的沉积发生在出山口：坡度骤降、搬运能力不足 → 铺出冲积扇；
      // 在坡度平稳的河段，泥沙是被**带走**的，不会就地卸货。
      const nextSlope = slopeArr[d];
      const decel = slopeArr[i] > 1e-9 ? Math.max(0, 1 - nextSlope / slopeArr[i]) : 0;
      if (decel > 0) h[d] += drop * depositRatio * decel;
      // 剩下的部分视作被水流带出本区域
    }
  }

  /**
   * 对一个矩形区域跑侵蚀。
   *
   * 用局部 Float32Array 而不是直接读写 cells：cells 是对象数组，
   * 每次访问都有一次属性查找与装箱，8 邻域 × 多轮迭代下来差别很大
   * （实测局部缓冲快 3~4 倍）。
   *
   * @param {object} box 数据坐标矩形（会被外扩）
   * @returns {{box:object, ms:number}}
   */
  function erode(cells, W, H, box, opt) {
    const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
    const thermalIters = opt.thermalIters != null ? opt.thermalIters : 6;
    const thermalRate = opt.thermalRate != null ? opt.thermalRate : 0.5;
    const hydraulicIters = opt.hydraulicIters != null ? opt.hydraulicIters : 3;
    const kFactor = opt.kFactor != null ? opt.kFactor : 0.22;
    const seaLevel = opt.seaLevel != null ? opt.seaLevel : 0;

    // 外扩：热力侵蚀需要邻域，边界格留作固定边界
    const pad = opt.pad != null ? opt.pad : 3;
    const x0 = Math.max(0, Math.floor(box.x0) - pad);
    const x1 = Math.min(W - 1, Math.ceil(box.x1) + pad);
    const y0 = Math.max(0, Math.floor(box.y0) - pad);
    const y1 = Math.min(H - 1, Math.ceil(box.y1) + pad);
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    if (bw < 5 || bh < 5) return { box, ms: 0 };

    const hbuf = new Float32Array(bw * bh);
    for (let y = 0; y < bh; y++) {
      const rowBase = (y0 + y) * W;
      for (let x = 0; x < bw; x++) {
        const wx = ((x0 + x) % W + W) % W;
        hbuf[y * bw + x] = cells[rowBase + wx].e;
      }
    }

    // ---- 休止角与单次最大下切：按**局部高差**自适应 ----
    //
    // 【为什么不能用绝对常数】地形的高度量级随海平面变化极大：
    // 海平面 0.93 的图上，一整座山只高出海面 0.03；海平面 0.5 的图上是 0.5。
    // 早先把 talus 写死成 0.016，在 0.93 的图上没有任何一格坡度能碰到它 ——
    // 热力侵蚀整段空转，侵蚀前后一模一样（实测差值 0）。
    // 改成「占局部高差的比例」就与量级无关了。
    let hMin = Infinity;
    let hMax = -Infinity;
    for (let i = 0; i < hbuf.length; i++) {
      const v = hbuf[i];
      if (v < hMin) hMin = v;
      if (v > hMax) hMax = v;
    }
    const localRange = Math.max(1e-4, hMax - hMin);
    const talus = opt.talus != null ? opt.talus : localRange * (opt.talusRel != null ? opt.talusRel : 0.055);
    const maxDrop = opt.maxDrop != null ? opt.maxDrop : talus * 2.5;

    for (let it = 0; it < thermalIters; it++) {
      thermalPass(hbuf, bw, bh, talus, thermalRate);
    }
    for (let it = 0; it < hydraulicIters; it++) {
      hydraulicPass(hbuf, bw, bh, kFactor, 0.27, maxDrop, opt.minAreaCells);
    }

    // 写回。海洋格只允许被"填高"到不超过海平面的范围，避免削海底
    // 造成大片平底海床（那会破坏原有的深浅色带）。
    //
    // opt.field / opt.maskGain：把侵蚀限制在笔迹范围内（「冲蚀」笔刷用）。
    // 不传就是整块区域全量侵蚀。
    const lapse = lapseFor(seaLevel);
    const maskField = opt.field || null;
    const maskGain = opt.maskGain != null ? opt.maskGain : 2.5;
    for (let y = 0; y < bh; y++) {
      const rowBase = (y0 + y) * W;
      const lrow = y * bw;
      for (let x = 0; x < bw; x++) {
        const wx = ((x0 + x) % W + W) % W;
        const c = cells[rowBase + wx];
        const before = c.e;
        let next = hbuf[lrow + x];
        if (maskField) {
          const k = Math.min(1, maskField[rowBase + wx] * maskGain);
          if (k <= 0.002) continue;
          next = before + (next - before) * k;
        }
        if (next === before) continue;
        if (next > 1) next = 1;
        if (next < -0.6) next = -0.6;
        const real = next - before;
        if (Math.abs(real) < 1e-7) continue;
        c.e = next;
        c.temp = Math.max(0, Math.min(1, c.temp - real * lapse));
      }
    }

    const t1 = (typeof performance !== 'undefined' ? performance : Date).now();
    return {
      box: { x0, y0, x1, y1 },
      ms: t1 - t0,
    };
  }

  // ==================== 抚平 ====================

  /**
   * 加权低通（保留大尺度、只削高频）。
   *
   * 旧实现的「抚平」是把格子往 7×7 平均上拉，效果等于一层盒式模糊：
   * 山脊会被一起抹平，只剩一个圆包。这里改成**只削高频**：
   * 用 3×3 高斯算出局部趋势，只把「偏离趋势的部分」按比例收掉，
   * 山脊的走向保留，只是变得圆润。
   */
  function smoothRegion(cells, W, H, box, opt) {
    const strength = opt.strength != null ? opt.strength : 0.5;
    const field = opt.field || null;
    const x0 = Math.max(1, Math.floor(box.x0));
    const x1 = Math.min(W - 2, Math.ceil(box.x1));
    const y0 = Math.max(1, Math.floor(box.y0));
    const y1 = Math.min(H - 2, Math.ceil(box.y1));
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    if (bw < 3 || bh < 3) return 0;

    const buf = new Float32Array(bw * bh);
    for (let y = 0; y < bh; y++) {
      const rowBase = (y0 + y) * W;
      for (let x = 0; x < bw; x++) {
        buf[y * bw + x] = cells[rowBase + x0 + x].e;
      }
    }
    const out = new Float32Array(bw * bh);
    for (let y = 1; y < bh - 1; y++) {
      for (let x = 1; x < bw - 1; x++) {
        const i = y * bw + x;
        const blur = (
          buf[i - bw - 1] + buf[i - bw] * 2 + buf[i - bw + 1] +
          buf[i - 1] * 2 + buf[i] * 4 + buf[i + 1] * 2 +
          buf[i + bw - 1] + buf[i + bw] * 2 + buf[i + bw + 1]
        ) / 16;
        let t = strength;
        if (field) {
          const f = field[(y0 + y) * W + x0 + x];
          t *= Math.min(1, f * 2.2);
        }
        out[i] = buf[i] + (blur - buf[i]) * t;
      }
    }
    let changed = 0;
    for (let y = 1; y < bh - 1; y++) {
      const rowBase = (y0 + y) * W;
      for (let x = 1; x < bw - 1; x++) {
        const i = y * bw + x;
        const c = cells[rowBase + x0 + x];
        if (Math.abs(out[i] - c.e) < 1e-6) continue;
        c.e = out[i];
        changed++;
      }
    }
    return changed;
  }

  // ==================== 选区塑形：多边形 → 大陆 / 海洋 ====================

  /**
   * 多边形 → 软掩膜，且**海岸线被分形打碎**。
   *
   * 【为什么不能只是「距离 → 平滑衰减」】那是把选区长成一个圆润的水滴，
   * 边缘一圈光滑弧线 —— 现实里大陆的海岸线是碎的：半岛、海湾、潟湖、
   * 离岸小岛、三角洲。用硬 0/1 更糟，直接在选区边界切一道垂直墙。
   *
   * 做法：
   *   1. 扫描线填充 + 两遍倒角距离变换，得到「到边界的内距」d；
   *   2. 从 d 里减去一层多层分形噪声 w，再过 smoothstep。
   * 噪声的过零线就是新的海岸线 —— 于是岸线长度取决于噪声频谱，
   * 而不是选区的几何形状。三层频率分别负责「半岛 / 岬角 / 岸边碎屑」。
   *
   * 频率与幅度全部按**选区尺度**缩放（sc = 内切半径），所以大选区
   * 得到大尺度的海湾，小选区得到细碎的岸线 —— 不用给用户两个滑块。
   *
   * @returns {{box:object, mask:Float32Array, shelf:Float32Array, scale:number}|null}
   */
  function buildSelectionMask(mask, W, H, polygon, opt) {
    const seed = opt.seed | 0;
    mask.fill(0);
    // 「内陆度」缓冲：0 = 海岸线，1 = 内陆深处。与 mask 分开是必须的 ——
    // mask 的过渡带宽只有 0.085×sc（十几格），拿它当"离海多远"用，
    // 大陆面会在十几格内就抬满，于是整块内陆一样高、海岸还是一圈窄滩。
    // 实测高度与距海距离的相关系数只有 0.26，看起来就是"一块平板"。
    const shelf = (opt.shelfBuffer && opt.shelfBuffer.length === W * H)
      ? opt.shelfBuffer
      : new Float32Array(W * H);
    shelf.fill(0);

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of polygon) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    if (!(maxX > minX) || !(maxY > minY)) return null;

    // ---- 岸线位移的名义幅度 ----
    //
    // 【这是 bbox 外扩量的唯一定义处】外扩必须 ≥ 最大位移，否则被推到
    // bbox 外的海岸线会被**直线切掉** —— 一块大陆的东侧出现一条几十格
    // 长的笔直海岸，看起来就像"板块边缘"。早先 pad 写的是 0.65×sc+10，
    // 而位移上限是 0.8×sc+，两者对不上。
    // 现在先定 DISPL，再由它反推 pad，并且把位移硬夹在 DISPL 之内。
    const estMax = Math.min(maxX - minX, maxY - minY) * 0.5;
    const DISPL = estMax * 0.72;
    const band = Math.max(2.2, estMax * 0.085);
    const pad = Math.ceil(DISPL + band) + 6;
    const box = {
      x0: Math.max(0, Math.floor(minX) - pad),
      y0: Math.max(0, Math.floor(minY) - pad),
      x1: Math.min(W - 1, Math.ceil(maxX) + pad),
      y1: Math.min(H - 1, Math.ceil(maxY) + pad),
    };
    const bw = box.x1 - box.x0 + 1;
    const bh = box.y1 - box.y0 + 1;

    // ---- 1. 扫描线填充：得到「多边形内部」的布尔图 ----
    const inside = new Uint8Array(bw * bh);
    let area = 0;
    for (let y = box.y0; y <= box.y1; y++) {
      const xs = scanlineIntersections(polygon, y);
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      const lrow = (y - box.y0) * bw;
      for (let k = 0; k + 1 < xs.length; k += 2) {
        let a = Math.ceil(xs[k]);
        let b = Math.floor(xs[k + 1]);
        if (a < box.x0) a = box.x0;
        if (b > box.x1) b = box.x1;
        if (b < a) continue;
        for (let x = a; x <= b; x++) inside[lrow + (x - box.x0)] = 1;
        area += b - a + 1;
      }
    }
    if (area <= 0) return null;

    // ---- 2. 内外各一次**精确**欧氏距离变换 ----
    //
    // dIn  ：内部格到最近「外部格」的距离 → 内距（海岸线为 0）
    // dOut ：外部格到最近「内部格」的距离 → 外距（海岸线为 0）
    //
    // 【为什么必须精确】早先用两遍 8 邻域倒角近似，误差在对角方向约 8%，
    // 而且误差本身带 8 重对称。距离场既决定岸线形状、又决定大陆面高度，
    // 于是整块大陆被"八角星"污染：海盆里能看到从中心发散的放射条纹，
    // 大陆面上则是一圈一圈等距的阶梯。
    const inv = new Uint8Array(bw * bh);
    for (let i = 0; i < bw * bh; i++) inv[i] = inside[i] ? 0 : 1;
    const dIn = edt2d(inv, bw, bh);     // 源点 = 外部格
    const dOut = edt2d(inside, bw, bh); // 源点 = 内部格

    let maxDist = 1;
    for (let i = 0; i < bw * bh; i++) {
      if (inside[i] && dIn[i] > maxDist) maxDist = dIn[i];
    }
    const sc = maxDist;

    // ---- 3. 用分形噪声移动海岸线 ----
    //
    // 四层，波长与幅度都必须**随波长递减**：
    //   大层 1.30×sc → 半岛与海湾（大陆轮廓上真正的凹凸）
    //   中层 0.46×sc → 岬角与潟湖
    //   小层 0.19×sc → 岸线细节
    //   碎屑 9 格    → 岸线的"毛"
    //
    // 【碎屑层的幅度是这一轮的关键修正】早先它拿 0.34 的权重、乘
    // 0.80×sc 的位移，等于在 13 格波长上施加 14 格位移 —— 位移比波长还大，
    // 已经不是"海岸线"，而是逐格随机。看图就是沿整条海岸的一圈毛刺。
    // 现在权重降到 0.10，位移 0.72×sc，最大抖动 4 格。
    const f1 = 1 / (sc * 1.30);
    const f2 = 1 / (sc * 0.46);
    const f3 = 1 / (sc * 0.19);
    const f4 = 1 / 9;
    const A1 = 1.0;
    const A2 = 0.52;
    // 【A3/A4 必须够大，否则岸线是"大尺度平滑起伏"而不是碎岸】
    // 原来 0.20/0.10：细频位移只有 ±7 格，但被 A1 的 ±137 格大位移淹没，
    // 实测掩膜岸线破碎度只有 1.28（几乎是个圆），成形后 1.52。
    // 提到 0.45/0.22 后，34 格 / 9 格那两层才有肉眼可见的岬角与潟湖。
    // 只影响 mask（海岸带），shelf 仍只用 wLow，内陆不会被"沙化"。
    const A3 = 0.45;
    const A4 = 0.22;
    const NORM = 1 / (A1 + A2 + A3 + A4);
    // 大层在内陆度里占的比重：内陆度只用大层推歪，才能与海岸的大尺度
    // 形状对齐，又不带上小尺度的碎屑（那会把内陆"沙化"）
    const W1 = A1 * NORM;

    const invBand = 1 / band;
    // 内陆度在 0.30 倍内切半径处饱和。
    // 【不能给太大】0.55 倍时一块 380×256 的选区里有 65% 的陆地都还在
    // "海岸平原"的爬坡段上，landE 中位数只有 0.16 —— 整块大陆看起来是
    // 一圈惨白的窄滩围着中间一小坨。0.30 倍把爬坡段压到 37 格，内陆
    // 高地才占得住面积。
    const invShelf = 1 / (sc * 0.30);
    // 想让海岸线上场时覆盖的面积接近用户圈的那一块，就要给一点正偏置：
    // 噪声位移是零均值的，但凹岸吃掉的面积比凸岸多出来的少
    // （实测圈 81k 格只长出 66k）。
    const bias = sc * 0.10;
    const cap = DISPL;

    for (let y = box.y0; y <= box.y1; y++) {
      const row = y * W;
      const lrow = (y - box.y0) * bw;
      for (let x = box.x0; x <= box.x1; x++) {
        const li = lrow + (x - box.x0);
        const i = row + x;
        // 符号距离：内正外负
        const sd = inside[li] ? dIn[li] - 0.5 : -(Math.min(dOut[li] - 0.5, sc * 3));

        const nf1 = fbm(x * f1, y * f1, 3, 2, 0.5, seed);
        const wLow = nf1 * W1;
        let w = (
          nf1 * A1 +
          fbm(x * f2, y * f2, 3, 2, 0.5, seed + 71) * A2 +
          fbm(x * f3, y * f3, 3, 2, 0.5, seed + 131) * A3 +
          fbm(x * f4, y * f4, 2, 2, 0.5, seed + 191) * A4
        ) * NORM;                       // ≈ [-1, 1]
        // 硬夹：保证永远落在外扩余量之内（见上面 DISPL 的注释）
        if (w > 1) w = 1; else if (w < -1) w = -1;

        // 内陆度：符号距离 + **只用大层**的位移。
        // 【不能直接用 d2（四层都算）】小层波长只有 9 格、幅度 4 格，
        // 混进内陆度就是 9 格周期的 ±4 格高度抖动 —— 整块大陆看起来像
        // 撒了一层砂。海岸线要碎，内陆要平顺，两者必须分开。
        // 【也不能只用 d】多边形外恒为负，被噪声推出去的那圈新陆地会拿到
        // shelf = 0，高度锁死在 landE ≈ 0.03 —— 实测占陆地 41%，就是图上
        // 那圈惨白的浅绿裙边。
        let sh = (sd + bias + wLow * cap) * invShelf;
        sh = sh < 0 ? 0 : sh > 1 ? 1 : sh;
        shelf[i] = sh * sh * (3 - 2 * sh);

        // 【掩膜位移要放大】四层 fbm 的实测合成 w ≈ 0.15~0.35（层间互相抵消），
        // 乘 cap 只有 6~14 格 —— 岸线只是"缓弯"，不是"碎岸"（掩膜破碎度 1.28）。
        // 放大 1.35 倍后位移到 8~19 格，细频那两层才真正把岸线搓出岬角/潟湖。
        // 只放大 mask；shelf 仍用未放大的 wLow，内陆高度分布不受影响。
        let wm = w * 1.35;
        if (wm > 1) wm = 1; else if (wm < -1) wm = -1;
        let t = (sd + bias + wm * cap) * invBand;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        mask[i] = t * t * (3 - 2 * t);
      }
    }

    return { box, mask, shelf, scale: sc };
  }

  // ==================== 选区内的小规模板块构造 ====================

  /**
   * 在选区里合成一块新大陆的**基础高度场**（bbox 局部坐标，未归一化）。
   *
   * 【为什么不再"画山链"】
   * 前两版都是先画一条山脉轴线、再沿轴线铺强度场。这个模型能给出"山在
   * 一条线上"，但那根线是**等宽、光滑、两端收细的一条带** —— 看起来像
   * 用马克笔在地图上画了一道，而不是一块大陆。原因不在参数：真实的山是
   * **板块碰撞的副产品**，它的走向、宽窄、断续、多峰全由碰撞的样式决定，
   * 画一条线是画不出来的。
   *
   * 而 project 自己已经有一套被验证过的造山规则（js/terrain.js 里
   * "板块接缝处的造山运动"那一节）。那边是怎么解决这个问题的：
   *   1. 板块 Voronoi → 接缝距离 seamDist；
   *   2. 沿接缝的**碰撞段掩码** collideMask：大部分接缝是平静的，
   *      只有少数段落真的在挤 —— 于是山不是环，而是"成串"的；
   *   3. 碰撞段内部的**起伏包络** rangeEnv：主峰与垭口交替；
   *   4. **主山系加成** beltBoost：只有少数段落抬成真正的高山；
   *   5. 山脊纹理 ridge：ridged 噪声，只在成山处叠加。
   * 这一版把同一套规则搬进选区，只是把球面 Voronoi 换成平面 Voronoi
   * （选区只有几十格宽，球面曲率在这么小的范围里没有意义）。
   *
   * 于是"隆起成大陆"变成了一件有成因的事：**给这块地一副板块骨架，
   * 让它自己长** —— 而不是往一块软泥上按一个山形模具。
   *
   * 【频段必须挂在图宽 W 上，不能挂选区尺度 sc】塑形区旁边就是生成器
   * 造出来的陆地。两边频段不同，无论参数怎么调都会"看得出是贴上去的"。
   * 下面所有 f* 常数都是从 terrain.js 的 baseFrequency 换算过来的，
   * 换算关系见 shapeRegion 里"频段"那段注释。
   *
   * @param {Float32Array} maskL 局部掩膜
   * @returns {Float32Array} 高度（约 -0.2 ~ 1.2，仅相对大小有意义）
   */
  function synthesizeRegion(maskL, bw, bh, sc, seed, F) {
    const out = new Float32Array(bw * bh);
    const rnd = mulberry32((seed ^ 0x51ed270b) >>> 0);

    // ---------- 板块核 ----------
    //
    // 数量按选区大小定：一块半径 100 格（≈4000 km）的大陆内部大约有
    // 3~5 个构造单元。全部按"陆壳"处理 —— 这里要造的是一整块大陆，
    // 出现洋壳就会出现海，而海的形状已经由用户圈的选区决定了。
    const nP = Math.max(4, Math.min(7, Math.round(sc / 18)));
    const plates = [];
    for (let k = 0; k < nP; k++) {
      let px = bw * 0.5;
      let py = bh * 0.5;
      let ok = false;
      for (let t = 0; t < 60; t++) {
        px = bw * (0.12 + rnd() * 0.76);
        py = bh * (0.12 + rnd() * 0.76);
        const ix = px | 0;
        const iy = py | 0;
        if (ix >= 0 && ix < bw && iy >= 0 && iy < bh && maskL[iy * bw + ix] > 0.55) {
          ok = true;
          break;
        }
      }
      if (!ok) continue;
      // 高度偏移必须是**连续值**（terrain.js 那里踩过坑：离散的 ±0.1 会在
      // 板块交汇点造成 1 格宽的高度台阶）。
      // 【幅度只能到 ±0.055】它相当于"陆地可用高度"的 13%。给到 ±0.10 时，
      // 板块之间会形成深达 20% 的封闭洼地 —— 水文阶段把它们逐个填成
      // 800~1200 km 宽的大湖，整块大陆像被打了几个洞。
      plates.push({ x: px, y: py, hOff: (rnd() - 0.5) * 0.11 });
    }
    if (plates.length < 2) {
      // 选区太小 / 掩膜太碎：退化成一块均匀陆台，后面照样能过测高曲线
      for (let i = 0; i < bw * bh; i++) out[i] = 0.5;
      return out;
    }
    const P = plates.length;
    const pd = new Float64Array(P);

    // ---------- 每格 ----------
    const halfWidth0 = sc * 0.26;
    const warpAmt = sc * 0.22;

    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        // 【掩膜外不算】bbox 通常比选区大 3 倍（pad = DISPL + band + 6），
        // 但 shapeRegion 只读 mask > 0.002 的格子。这里跳过掩膜外，
        // 28 万格 → 9 万格，合成耗时直接砍掉一半以上。
        if (maskL[y * bw + x] <= 0.002) continue;
        // --- 平面 Voronoi ---
        let d1 = Infinity;
        let d2 = Infinity;
        for (let k = 0; k < P; k++) {
          const dx = x - plates[k].x;
          const dy = y - plates[k].y;
          const d = Math.sqrt(dx * dx + dy * dy);
          pd[k] = d;
          if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
        }
        const seamDist = Math.abs(d2 - d1);

        // --- 基础面：与 terrain.js 同权重的三层 ---
        const contN = fbm(x * F.cont, y * F.cont, 4, 2, 0.5, seed + 101) - F.dCont;
        const baseN = fbm(x * F.base, y * F.base, 6, 2, 0.5, seed + 102) - F.dBase;
        // 【det（50 格）的权重必须小】它直接决定"50 格级的群系斑块有多碎"。
        // 0.12 时整块大陆长出一片片互不相连的土黄 / 浅绿补丁（端到端出图
        // 上就是一张迷彩布），0.05 之后群系边界退回 100 格以上。
        const detN = fbm(x * F.det, y * F.det, 5, 2, 0.55, seed + 103);
        let e = 0.72 + (contN * 0.58 + baseN * 0.30 + detN * 0.05) * 0.95;

        // 板块高度：反距离加权（处处连续，交汇点不会跳变）
        let wsum = 0;
        let acc = 0;
        for (let k = 0; k < P; k++) {
          const w = 1 / Math.pow(Math.max(1e-3, pd[k] / sc), 6);
          wsum += w;
          acc += w * plates[k].hOff;
        }
        e += acc / wsum;

        // ---------- 接缝造山（先算，因为它要参与"高地"判定）----------
        let orog = 0;
        const rA = 1 - Math.abs(fbm(x * F.ridgeA, y * F.ridgeA, 4, 2, 0.55, seed + 210));
        const rB = 1 - Math.abs(fbm(x * F.ridgeB, y * F.ridgeB, 3, 2, 0.50, seed + 260));
        const ridge = rA * rA * 0.65 + rB * rB * 0.35;

        if (seamDist < halfWidth0 * 2.2) {
          const cz = fbm(x * F.collide, y * F.collide, 3, 2, 0.55, seed + 1700) * 0.5 + 0.5;
          let cm = (cz - 0.44) / 0.52;
          cm = cm < 0 ? 0 : cm > 1 ? 1 : cm;
          const cmSq = cm * cm;
          if (cmSq > 0.001) {
            const env = Math.pow(
              fbm(x * F.env, y * F.env, 3, 2, 0.55, seed + 1900) * 0.5 + 0.5, 1.7);
            const hwN = fbm(x * F.hw, y * F.hw, 2, 2, 0.5, seed + 1500) * 0.5 + 0.5;
            const hw = halfWidth0 * (0.7 + hwN * 0.7);
            const wander = fbm(x * F.wander, y * F.wander, 3, 2, 0.5, seed + 610);
            const sd = Math.max(0, seamDist + wander * warpAmt * 0.35);
            if (sd < hw) {
              const u = 1 - sd / hw;
              const profile = u * u * (3 - 2 * u);
              const core = Math.pow(u, 2.4);
              // 主山系：只有少数段落抬成真正的高山（terrain.js 的 beltBoost）
              const bn = fbm(x * F.belt, y * F.belt, 3, 2, 0.55, seed + 2100) * 0.5 + 0.5;
              let bm = (bn - 0.38) / 0.58;
              bm = bm < 0 ? 0 : bm > 1 ? 1 : bm;
              const beltBoost = bm * bm * (0.55 + ridge * 0.9);
              const rough = fbm(x * F.rough, y * F.rough, 3, 2, 0.5, seed + 1300) * 0.5 + 0.5;
              const strength = cmSq * env * (0.35 + ridge * 0.9) * (0.65 + rough * 0.7);
              orog = profile * core * (strength * 0.34 + beltBoost * 0.52);
            }
          }
        }
        e += orog;

        // ---------- 细节：只叠加在**本来就高**的地方 ----------
        //
        // 【这里的"高"不能直接用 e 判断】e 在整块选区里普遍在 0.7 上下
        // （选区全是陆地），如果按 (e−0.46)/0.30 算，整块大陆的掩膜都在
        // 0.8 以上 —— 于是山脊纹理铺满平原。后果不是"更粗糙"，而是
        // **群系被切成 30~50 格的补丁**：一点高度差就跨过一个降水/温度档，
        // 端到端出图是一张迷彩布，而旁边的老陆地是均匀的深绿。
        //
        // 真实地貌的分工是：平原**必须平整**，纹理只属于高地与山带。
        // 所以"高地"由**大陆级场 contN** 决定（哪半边是高地），
        // 山带再无条件算作高地。
        let hi = 0.40 + contN * 1.7;
        hi = hi < 0 ? 0 : hi > 1 ? 1 : hi;
        let em = hi + orog * 1.6;
        em = em < 0 ? 0 : em > 1 ? 1 : em;
        const emSq = em * em;
        if (emSq > 0.002) {
          e += ridge * 0.085 * emSq;
          e += fbm(x * F.groove, y * F.groove, 3, 2, 0.5, seed + 310) * 0.014 * emSq;
        }
        // 碎石：全局、极轻，只做质感。0.004 → 0.006 是因为平原现在真正平整了，
        // 完全没有颗粒会像一块塑料板。
        e += fbm(x * F.grain, y * F.grain, 2, 2, 0.5, seed + 360) * 0.006;

        out[y * bw + x] = e;
      }
    }
    return out;
  }

  /**
   * 软掩膜 → 地形（隆起成大陆 / 沉陷成海洋）。
   *
   * 【为什么不是「掩膜 × 幅度」】那样得到的是一块均匀抬高的台地 ——
   * 中间平、边缘圆，像一块橡皮泥。真实大陆是有**分异**的：
   * 山带、高原、盆地、平原，各自占不同的面积比例。
   *
   * 所以高度由三个尺度叠出来：
   *   · 大陆面（shelf = mask^0.9）：靠海低、内陆高的整体轮廓；
   *   · 山带（domain-warped ridged）：脊线处陡起，占陆地 20% 左右；
   *   · 高原/盆地（低频 fbm）：控制大块区域的基准高度；
   *   · 细节（11 格级 fbm）：让坡面不塑料。
   *
   * domain warp 是让山带"像山带"的关键：直接把 ridged 噪声铺在
   * 直角坐标上，得到的是等距排列的平行条纹；把采样坐标先用低频
   * 噪声推歪，条纹才会蜿蜒、分叉、时宽时窄 —— 那才像山脉。
   */
  /**
   * 排水保证：把缓冲里的**封闭洼地**抬平到溢出口高度。
   *
   * 【为什么要做】塑形区里只要有一处"四周都比它高、自己又没出口"的锅底，
   * 水文阶段就会把它灌成湖。小选区实测 9.4% 的格子是水面 —— 全是这类
   * 数值巧合，不是设计出来的地理。抬平之后内陆就没有洼地可灌，
   * 剩下的水面只可能是真正连着海的（岸线本身）。
   *
   * 做法：priority-flood（Barnes 等）。把**选区外的原始地形 / 海面**
   * （mL == 0，即 pad 环与未触及的格子）当作出水口往里灌：洪水沿连通
   * 路径由低到高推进，凡是比当前洪水位还低的格子（= 被挡在后面的锅底）
   * 一律抬到洪水位。这保证每一格都有一条"一路非递增"的下坡路通往出水口，
   * 即无封闭洼地。
   *
   * 只抬 mL != 0 的格子（真正被塑形改过的）；mL == 0 的原地形 / 海面
   * 一律不碰 —— 它们的排水由生成器负责，本来就是通的。
   *
   * @param {Float32Array} elevL 最终高度缓冲（原地修改）
   * @param {number} bw @param {number} bh bbox 尺寸
   * @param {Float32Array} mL 掩膜标记（1 = 我改过，可以抬；0 = 原样）
   */
  /**
   * 排水保证：把**内陆**封闭洼地抬平到溢出口高度，海岸带一律不动。
   *
   * 【为什么要分内陆/海岸】第一版把海岸潟湖也一起抬平了：岸线破碎度从
   * 1.78 掉到 1.37，近岸平均高度从"内陆的 4 成"抬到 9 成 —— 海岸平原
   * 被抹平。潟湖、沙嘴、岩礁本来就是海岸该有的东西，不是"数值洼地"。
   *
   * 【做法】只对 raiseL=1 的格子做 priority-flood：
   *   - 种子 = 不可抬格子（海岸带 / 选区外）里紧挨着可抬格子的那一圈；
   *   - 由低到高出队，锅底抬到当前洪水位；
   *   - 只向 raiseL=1 的格子扩散，绝不改海岸带与选区外。
   * 因为种子按高度出队，内陆锅底只会被抬到**最低的那个溢出口**，
   * 不会出现"另一个盆地的洪水位把这片低地误抬"的串味。
   *
   * @param {Float32Array} elevL  最终高度缓冲（原地修改）
   * @param {number} bw @param {number} bh bbox 尺寸
   * @param {Float32Array} raiseL 1 = 可抬（内陆），0 = 固定（海岸带 / 选区外）
   */
  function drainFill(elevL, bw, bh, raiseL) {
    const n = bw * bh;
    const visited = new Uint8Array(n);
    // 手写二叉小顶堆：按高度出队。域只含内陆，规模远小于整个 bbox。
    const he = new Float64Array(n + 1);
    const hi = new Int32Array(n + 1);
    let hn = 0;
    function hpush(e, i) {
      let k = ++hn;
      he[k] = e; hi[k] = i;
      while (k > 1) {
        const p = k >> 1;
        if (he[p] <= he[k]) break;
        const te = he[p]; he[p] = he[k]; he[k] = te;
        const ti = hi[p]; hi[p] = hi[k]; hi[k] = ti;
        k = p;
      }
    }
    function hpop() {
      const top = hi[1];
      he[1] = he[hn]; hi[1] = hi[hn]; hn--;
      let k = 1;
      for (;;) {
        const l = k << 1;
        if (l > hn) break;
        const r = l + 1;
        let m = l;
        if (r <= hn && he[r] < he[l]) m = r;
        if (he[k] <= he[m]) break;
        const te = he[k]; he[k] = he[m]; he[m] = te;
        const ti = hi[k]; hi[k] = hi[m]; hi[m] = ti;
        k = m;
      }
      return top;
    }

    // 种子 = 不可抬格子里紧邻可抬格子的那一圈（真实出水口高度）
    let seeds = 0;
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const i = y * bw + x;
        if (raiseL[i] === 0) continue;
        if (x > 0 && raiseL[i - 1] === 0) { const j = i - 1; if (!visited[j]) { visited[j] = 1; hpush(elevL[j], j); seeds++; } }
        if (x < bw - 1 && raiseL[i + 1] === 0) { const j = i + 1; if (!visited[j]) { visited[j] = 1; hpush(elevL[j], j); seeds++; } }
        if (y > 0 && raiseL[i - bw] === 0) { const j = i - bw; if (!visited[j]) { visited[j] = 1; hpush(elevL[j], j); seeds++; } }
        if (y < bh - 1 && raiseL[i + bw] === 0) { const j = i + bw; if (!visited[j]) { visited[j] = 1; hpush(elevL[j], j); seeds++; } }
      }
    }
    if (seeds === 0) return;

    let floodLevel = -Infinity;
    while (hn > 0) {
      const i = hpop();
      let e = elevL[i];
      if (e < floodLevel) {
        if (raiseL[i] !== 0) { e = floodLevel; elevL[i] = e; }
        // 种子格（海岸带 / 选区外）保持原值，不参与抬升。
      }
      if (e > floodLevel) floodLevel = e;

      const x = i % bw;
      const y = (i / bw) | 0;
      if (x > 0 && raiseL[i - 1] !== 0) { const j = i - 1; if (!visited[j]) { visited[j] = 1; hpush(elevL[j], j); } }
      if (x < bw - 1 && raiseL[i + 1] !== 0) { const j = i + 1; if (!visited[j]) { visited[j] = 1; hpush(elevL[j], j); } }
      if (y > 0 && raiseL[i - bw] !== 0) { const j = i - bw; if (!visited[j]) { visited[j] = 1; hpush(elevL[j], j); } }
      if (y < bh - 1 && raiseL[i + bw] !== 0) { const j = i + bw; if (!visited[j]) { visited[j] = 1; hpush(elevL[j], j); } }
    }
  }


  function shapeRegion(cells, W, H, maskBuf, box, opt) {
    const sea = opt.seaLevel;
    const seed = opt.seed | 0;
    const isSea = opt.mode === 'sea';
    // k = 目标高度，占「陆地可用高度」的比例（0.8 → 大陆最高处 landE 0.8）
    const k = opt.strength != null ? opt.strength : 0.8;
    const unit = Math.max(0.05, 1 - sea);
    const sc = Math.max(8, opt.scale || 60);
    // 【直减率必须与气候模块同一个数】早先这里写死 0.45，而 climate.js 用的是
    // LAPSE = 0.42 —— 塑形时按 0.45 降温、重算气候时按 0.42 反推，
    // 同一块地的气温在两个阶段对不上。renderer 的 S、气候的 LAPSE、
    // 测高曲线，都是这一类"同一个物理量写了两份"，一律从源头读。
    const lapse = (FM.LAPSE != null ? FM.LAPSE : 0.42) / unit;

    // ---- 频段（与 map-generator/js/terrain.js 逐档对齐）----
    //
    // 【这一组常数决定了"像不像同一张图"】塑形区旁边就是生成器造出来的
    // 陆地，两边只要频段不同，无论参数怎么调都会"看得出是贴上去的"。
    // 所以这里不自己发明频段，而是把 terrain.js 用的那七档换算过来：
    // terrain.js 的 noiseSeamless 里 baseFrequency = f 对应"绕球面 2f 个
    // 噪声单位"，落到 W 格宽的地图上就是 W/(2f) 格波长。
    //
    //   f 1.5  → 333 格   大陆尺度（决定"这里有没有一块高地"）
    //   f 3.5  → 143 格   地区尺度（高原 / 盆地）
    //   f 10   →  50 格   地貌尺度（山块）
    //   f 16   →  31 格   山脊主频
    //   f 34   →  15 格   山脊次频
    //   f 52   →  10 格   冲沟
    //   f 140  → 3.6 格   碎石质感
    //
    // 【为什么不再自己定 0.42/0.17 倍选区尺度】那样得到的是"这套参数只
    // 在这块选区里好看"——换一个选区大小，波长跟着变，质感就变了。
    // 挂在图宽上之后，塑形区与全图的纹理尺度天然一致。
    const wW = Math.max(64, W);
    // 波长（格）→ 频率。
    //
    // 【钳制必须钳"太粗"的一端，不能钳"太细"的一端】这句写反过一次，
    // 代价是所有细频（31 / 15 / 10 / 3.6 格）被一起掐成 1.35×sc = 135 格，
    // 于是山脊纹理、冲沟、碎石质感全部失效 —— 整块大陆变成一块光滑的
    // 绿色穹顶，而改幅度怎么改都没有反应（它们本来就没在起作用）。
    // 真正表达不出来的只有**比选区还粗**的波长：那在选区里连半个周期都
    // 走不完，只能算作一个常数偏移。
    const wl = (cells) => 1 / Math.min(cells, sc * 1.6);
    const F = {
      cont: wl(wW / 3),        // 333 格
      base: wl(wW / 7),        // 143 格
      det: wl(wW / 20),        //  50 格
      ridgeA: wl(wW / 32),     //  31 格
      ridgeB: wl(wW / 68),     //  15 格
      groove: wl(wW / 104),    //  10 格
      grain: wl(wW / 280),     // 3.6 格
      // 【这四个必须挂在**选区尺度**上，不能挂图宽】它们描述的是板块几何：
      // 碰撞段有多长、主山系有多宽、接缝摆动多少 —— 这些是 construct 尺度
      // 的量（与一块大陆同量级），不是地表纹理。挂在图宽上会得到 160~200 格
      // 的波长，而选区只有 200 格宽 —— 整块大陆落在同一个噪声值上，
      // 于是"要么所有接缝都在挤、要么一条都不挤"，实测整块大陆只有一处
      // 成山，其余全是平原。
      collide: 1 / (sc * 0.55),  // 碰撞段长度
      env: 1 / (sc * 0.32),      // 主峰 / 垭口
      hw: 1 / (sc * 0.70),       // 山带宽度变化
      belt: 1 / (sc * 0.80),     // 主山系分布
      wander: 1 / (sc * 0.55),   // 接缝摆动
      rough: wl(wW / 500),     //  2 格 → 山体粗糙度
      dCont: 0,
      dBase: 0,
    };
    const fSea = wl(sc * 0.8);

    const x0 = Math.max(1, box.x0);
    const x1 = Math.min(W - 2, box.x1);
    const y0 = Math.max(1, box.y0);
    const y1 = Math.min(H - 2, box.y1);
    const outBox = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    // 内陆度缓冲（buildSelectionMask 产出）。不传时退回用掩膜本身。
    const shelfBuf = opt.shelf || null;

    let changed = 0;
    let maxDelta = 0;

    // ---- 0. 各噪声层在**本选区内**的均值（去直流）----
    //
    // 【为什么必须去】波长与选区同量级的低频 fbm，在一个选区内的样本均值
    // 偏离 0 是常态 —— 实测某个 seed 上 macro 在整块大陆的平均值是 −0.5。
    // 它不像噪声，像一个常数偏置：整块大陆要么被压成低平原、要么被抬成
    // 一整块高原。更糟的是换一个选区大小、换一个种子偏置就变，
    // 于是"同一套参数有时好看有时难看"，怎么调都调不稳。
    // 抽样用 8 格步长，代价约 1/64 个整遍 —— 便宜且足够准。
    const STEP = 8;
    let dCont = 0;
    let dBase = 0;
    let nSamp = 0;
    for (let y = Math.max(0, y0); y <= y1; y += STEP) {
      for (let x = Math.max(0, x0); x <= x1; x += STEP) {
        if (maskBuf[y * W + x] <= 0.5) continue;
        dCont += fbm(x * F.cont, y * F.cont, 4, 2, 0.5, seed + 101);
        dBase += fbm(x * F.base, y * F.base, 6, 2, 0.5, seed + 102);
        nSamp++;
      }
    }
    if (nSamp > 8) {
      F.dCont = dCont / nSamp;
      F.dBase = dBase / nSamp;
    }

    // ---- 第一遍：只算「起伏量」，不落地 ----
    //
    // 【为什么要分两遍】塑形出来的高度必须**按分位**映射到与生成器同一套
    // 测高曲线（FM.HYPSO），否则新大陆的高度中位数会是 0.45，而全世界
    // 的陆地是 0.041 —— 新造的大陆比旁边任何一块老陆地高十一倍，看起来
    // 就是一块贴上去的褐色瘤子。分位映射要先知道整片选区的分布，
    // 所以第一遍只把起伏量存进缓冲，噪声只算一次，不重复采样。
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    const amt = new Float32Array(bw * bh);
    let nSel = 0;

    // ---- 在选区里跑一次小规模板块构造（一次性算好，第一遍只查表）----
    //
    // 把掩膜拷成 bbox 局部坐标：构造要按"这块地形里哪儿是陆地"决定板块
    // 核往哪儿放，不能拿整图的坐标去查。
    const maskL = new Float32Array(bw * bh);
    for (let ly = 0; ly < bh; ly++) {
      const row = (y0 + ly) * W + x0;
      for (let lx = 0; lx < bw; lx++) maskL[ly * bw + lx] = maskBuf[row + lx];
    }
    const synth = synthesizeRegion(maskL, bw, bh, sc, seed + 6661, F);

    for (let y = y0; y <= y1; y++) {
      const row = y * W;
      const lrow = (y - y0) * bw;
      for (let x = x0; x <= x1; x++) {
        const m = maskBuf[row + x];
        if (m <= 0.002) continue;

        // ---- 高度：直接取选区内板块构造的结果 ----
        //
        // synthesizeRegion 已经把"基础面 + 板块高度 + 细节 + 接缝造山"
        // 全部算完，这里只剩一件事：**靠海要低**。
        //
        // 【为什么靠海必须低】否则岸线会跑掉：排在最前面的 33% 会落在
        // 内陆，最靠外的几圈反而排在中段，海岸一带就变成一条陡坡，
        // 渲染出来是一圈发黑的描边。
        const sh = shelfBuf ? shelfBuf[row + x] : m;
        // 【taper 必须按「离岸距离」归一，不能直接 sh/0.30】shelf 在岸线处
        // 已经不是 0：buildSelectionMask 里加了 bias = 0.10*sc，岸线 sd=0
        // → smoothstep(0.10sc / 0.30sc) ≈ 0.26。早先写 taper = sh/0.30，
        // 等于岸线就有 0.87 —— 整块大陆连海岸都是满高度，没有海岸平原，
        // 岸线也被抹成一条光滑等值线（破碎度 1.78 → 1.43）。
        // 0.26 / 0.87 是 shelf 在「岸线 / 内陆 0.2sc」处的两个固定值，
        // 与 sc 无关（bias 与 invShelf 同比例缩放），拿它归一即可。
        let taper = (sh - 0.26) / 0.61;
        taper = taper < 0 ? 0 : taper > 1 ? 1 : taper;
        taper = taper * taper * (3 - 2 * taper);
        // 0.30 的下限：海岸格必须明显高于内陆最低处，否则它会在分位映射里
        // 落到 0 附近，渲染成一圈"贴着海平面的灰绿虚边"。
        const elev = 0.30 + 0.70 * taper;

        let amount;
        if (!isSea) {
          amount = elev * k * synth[lrow + (x - x0)];
        } else {
          // 海盆：几何深度（离选区边缘多远）主导，只加一点低频起伏做纹理。
          // 【为什么不能让噪声主导】原来写成 elev × (0.52 ± 噪声)，噪声幅度
          // 和基准同量级 —— 于是"离边缘多远"和"哪里深"几乎无关，沉出来的
          // 不是一个盆，而是一片深浅随机的浅滩。
          const wob = fbm(x * fSea, y * fSea, 3, 2, 0.5, seed + 77);
          amount = elev * (1 + wob * 0.14);
        }
        // 【原来的「软膝」已经删掉】它是在"高度=起伏量"的旧口径下，
        // 用来防止山顶被硬夹成一片平白高原的（见 README 海拔分层那节）。
        // 现在高度要走分位映射，映射本身是单调的 —— 软膝不改变任何大小
        // 关系，也就不会改变映射结果，留着只会让人误以为它还在起作用。

        amt[lrow + (x - x0)] = amount;
        if (m > 0.5) nSel++;
      }
    }

    // ---- 第二遍：起伏量 → 相对高度（分位映射到测高曲线）----
    //
    // 选区里第 r 分位的格子，高度取地球测高曲线第 r 分位的高度。
    // 于是新大陆的「平原 / 丘陵 / 山地」面积比天然与地球一致，
    // 与旁边已生成的陆地同源；而映射是单调的，海岸线位置、山谷走向、
    // 山脊全都逐格保留 —— 改变的只是相邻等高线的间距（平原变宽、
    // 陡坡变陡），这正是真实地形与"均匀台地"的区别。
    //
    // 岸线的定义也一并保留：**起伏量 = 0 仍然是岸线**。所以下半部分
    // 用「海深曲线」映射（浅滩 → 深海），上半部分用测高曲线映射，
    // 两边在 0 处连续，海岸形状与改造前完全一致。
    const relAt = buildRelMapper(amt, bw, bh, maskBuf, W, x0, y0, nSel, isSea);

    // 【为什么先算进缓冲、不直接写回】塑形出来的陆地里可能残留**封闭洼地**
    // （四周都比它高、自己又没有出口的锅底）。这种地形在水文阶段一定会被
    // 灌成湖 —— 小选区实测 9.4% 的格子是水面，看着像"内陆海"，其实是
    // 分位映射叠板块起伏凑出来的数值巧合，不是设计出来的地理。
    //
    // 与其继续调幅度去躲，不如从原理上保证：**塑形区里不许有封闭洼地**，
    // 每一格都必须有一条"一路下坡到选区外"的路。做法是对本 bbox 做一次
    // priority-flood（从选区外的原始地形 / 海面往里灌，锅底一律抬到
    // 溢出口的高度）。这样水文阶段就没有洼地可灌，内陆湖自然消失。
    const elevL = new Float32Array(bw * bh);
    const baseL = new Float32Array(bw * bh);
    const maskL2 = new Float32Array(bw * bh);   // 1 = 我改过，0 = 原样

    for (let ly = 0; ly < bh; ly++) {
      const y = y0 + ly;
      const row = y * W;
      for (let lx = 0; lx < bw; lx++) {
        const x = x0 + lx;
        const li = ly * bw + lx;
        const m = maskBuf[row + x];
        const c = cells[row + x];
        const before = c.e;
        baseL[li] = before;

        // 没碰过的格子（含 pad 环）保留原高度：它们是 priority-flood 的出水口，
        // 高度必须是真实的原始地形 / 海面，不能拿 0 去灌。
        if (m <= 0.002) { elevL[li] = before; maskL2[li] = 0; continue; }

        let rel = relAt(amt[li]);

        // ---- 海岸专供的碎屑噪声 ----
        if (!isSea) {
          const shCoast = shelfBuf ? shelfBuf[row + x] : m;
          // 【两层海岸噪声】单靠 9 格细频只能长出小岬角，岸线整体还是贴着
          // 掩膜轮廓（压线率 47%）。22 格那层负责"海湾 / 半岛"这种大弯，
          // 9 格那层负责"沙嘴 / 岩礁"这种碎边；两层叠起来才是自然岸线。
          const bayW = Math.pow(1 - shCoast, 1.4);
          const coastW = Math.pow(1 - shCoast, 2.0);
          if (bayW > 0.002) {
            rel += fbm(x * 0.045, y * 0.045, 2, 2, 0.5, seed + 421) * 0.050 * bayW;
          }
          if (coastW > 0.002) {
            rel += fbm(x * 0.111, y * 0.111, 2, 2, 0.5, seed + 419) * 0.075 * coastW;
          }
        }

        // ---- 地表微纹理（映射之后，不参与排名）----
        if (!isSea) {
          rel += fbm(x * 0.143, y * 0.143, 2, 2, 0.5, seed + 733) *
            0.007 * Math.min(1, Math.max(0, rel) * 40);
        }

        const target = sea + unit * rel;
        let next = before + (target - before) * m;
        if (next > 1) next = 1;
        if (next < -0.6) next = -0.6;

        elevL[li] = next;
        maskL2[li] = 1;
      }
    }

    // ---- 排水保证：抬平所有封闭洼地（只针对陆地模式）----
    //
    // 海盆模式不需要：沉下去的就是海，海底再深也是连通的，不存在"灌成湖"。
    // ---- 排水保证：只抬「内陆」封闭洼地，海岸带保持原样 ----
    //
    // 【为什么不能全抬】第一版把海岸潟湖也一起抬平了：岸线破碎度 1.78 →
    // 1.37，近岸平均高度从"内陆的 4 成"抬到 9 成 —— 海岸平原被抹平。
    // 潟湖、沙嘴、岩礁本来就是海岸该有的样子，不能被当成"数值洼地"填掉。
    //
    // 先在水里分出**与外海连通的那一部分**（从 bbox 边界 BFS），只对
    // 「离外海 >= 9 格」的内陆格子做排水保证；离海 9 格以内一律不动，
    // 内陆湖（不与外海连通）照旧被填平。
    if (!isSea) {
      const water = new Uint8Array(bw * bh);
      for (let i = 0; i < bw * bh; i++) water[i] = elevL[i] < sea ? 1 : 0;
      const ocean = new Uint8Array(bw * bh);
      const q = new Int32Array(bw * bh);
      let qh = 0;
      let qt = 0;
      for (let x = 0; x < bw; x++) {
        const a = x;
        const b = (bh - 1) * bw + x;
        if (water[a] && !ocean[a]) { ocean[a] = 1; q[qt++] = a; }
        if (water[b] && !ocean[b]) { ocean[b] = 1; q[qt++] = b; }
      }
      for (let y = 0; y < bh; y++) {
        const a = y * bw;
        const b = y * bw + bw - 1;
        if (water[a] && !ocean[a]) { ocean[a] = 1; q[qt++] = a; }
        if (water[b] && !ocean[b]) { ocean[b] = 1; q[qt++] = b; }
      }
      while (qh < qt) {
        const i = q[qh++];
        const x = i % bw;
        const y = (i / bw) | 0;
        if (x > 0 && water[i - 1] && !ocean[i - 1]) { ocean[i - 1] = 1; q[qt++] = i - 1; }
        if (x < bw - 1 && water[i + 1] && !ocean[i + 1]) { ocean[i + 1] = 1; q[qt++] = i + 1; }
        if (y > 0 && water[i - bw] && !ocean[i - bw]) { ocean[i - bw] = 1; q[qt++] = i - bw; }
        if (y < bh - 1 && water[i + bw] && !ocean[i + bw]) { ocean[i + bw] = 1; q[qt++] = i + bw; }
      }
      // 没有外海（全内陆选区）时不强行填：没有出水口，抬了也没意义。
      if (qt > 0) {
        // 距离用 4 邻域 BFS（曼哈顿），不用 EDT：这里只需要"离海 >= 9 格"
        // 这个阈值，BFS 一遍 O(n)，比 edt2d 每行分配 Float64Array 便宜得多；
        // 而且 verify 的 dsea 也是 BFS，两边口径一致。
        const distOcean = new Int16Array(bw * bh).fill(-1);
        qh = 0;
        qt = 0;
        for (let i = 0; i < bw * bh; i++) {
          if (ocean[i]) { distOcean[i] = 0; q[qt++] = i; }
        }
        while (qh < qt) {
          const i = q[qh++];
          const x = i % bw;
          const y = (i / bw) | 0;
          const nd = distOcean[i] + 1;
          if (x > 0 && distOcean[i - 1] < 0) { distOcean[i - 1] = nd; q[qt++] = i - 1; }
          if (x < bw - 1 && distOcean[i + 1] < 0) { distOcean[i + 1] = nd; q[qt++] = i + 1; }
          if (y > 0 && distOcean[i - bw] < 0) { distOcean[i - bw] = nd; q[qt++] = i - bw; }
          if (y < bh - 1 && distOcean[i + bw] < 0) { distOcean[i + bw] = nd; q[qt++] = i + bw; }
        }
        const raiseL = new Float32Array(bw * bh);
        for (let i = 0; i < bw * bh; i++) {
          raiseL[i] = (maskL2[i] !== 0 && distOcean[i] >= 9) ? 1 : 0;
        }
        drainFill(elevL, bw, bh, raiseL);
      }
    }

    // ---- 第三遍：写回（高度可能已被排水保证抬过）----
    for (let ly = 0; ly < bh; ly++) {
      const y = y0 + ly;
      const row = y * W;
      for (let lx = 0; lx < bw; lx++) {
        const li = ly * bw + lx;
        if (maskL2[li] === 0) continue;   // 没碰过的格子（含 pad 环）

        const x = x0 + lx;
        const next = elevL[li];
        const before = baseL[li];
        const real = next - before;
        if (real === 0) continue;

        const c = cells[row + x];
        c.e = next;
        c.temp = Math.max(0, Math.min(1, c.temp - real * lapse));
        changed++;
        const ad = Math.abs(real);
        if (ad > maxDelta) maxDelta = ad;
        if (x < outBox.x0) outBox.x0 = x;
        if (x > outBox.x1) outBox.x1 = x;
        if (y < outBox.y0) outBox.y0 = y;
        if (y > outBox.y1) outBox.y1 = y;
      }
    }

    return { changed, maxDelta, box: outBox.x0 === Infinity ? box : outBox };
  }

  /**
   * 建「起伏量 → 相对高度」的分位映射函数。
   *
   * @param {Float32Array} amt   第一遍存下的起伏量（bbox 局部坐标）
   * @param {number} nSel        mask > 0.5 的格数（统计样本）
   * @returns {(a:number)=>number} 正数=陆地相对高度，负数=海深
   */
  function buildRelMapper(amt, bw, bh, maskBuf, W, x0, y0, nSel, isSea) {
    const HY = typeof FM !== 'undefined' ? FM.HYPSO : null;
    // 样本太少（笔刷级别的小选区）时不做映射：分位统计不可靠，
    // 强行套曲线会把几个格子的噪声拉成"雪峰"。直接用原量。
    if (!HY || nSel < 400) return (a) => (isSea ? -Math.max(0.05, a) : a);

    let aMin = Infinity;
    let aMax = -Infinity;
    let nSea = 0;
    for (let ly = 0; ly < bh; ly++) {
      const row = (y0 + ly) * W;
      for (let lx = 0; lx < bw; lx++) {
        if (maskBuf[row + x0 + lx] <= 0.5) continue;
        const a = amt[ly * bw + lx];
        if (a < aMin) aMin = a;
        if (a > aMax) aMax = a;
        if (a <= 0) nSea++;
      }
    }
    if (!(aMax > aMin)) return (a) => (isSea ? -Math.max(0.05, a) : a);

    const span = aMax - aMin;
    const BINS = 512;
    const hist = new Float32Array(BINS + 1);
    for (let ly = 0; ly < bh; ly++) {
      const row = (y0 + ly) * W;
      for (let lx = 0; lx < bw; lx++) {
        if (maskBuf[row + x0 + lx] <= 0.5) continue;
        const b = Math.min(BINS, Math.max(0, Math.round(((amt[ly * bw + lx] - aMin) / span) * BINS)));
        hist[b]++;
      }
    }

    // 海面比例：保持"起伏量=0 即岸线"这条约定，于是海岸形状不变。
    // sea 模式没有内侧岸线（整个选区都要沉下去），qSea 记 0。
    const qSea = isSea ? 0 : nSea / nSel;
    const lut = new Float32Array(BINS + 1);
    let acc = 0;
    for (let b = 0; b <= BINS; b++) {
      const r = acc / nSel;          // 该箱下沿的累积占比
      acc += hist[b];
      if (isSea) {
        // 全部沉海：按名次给深度，最深处落在选区中心（起伏量最大处）。
        //
        // 【为什么整体再乘 1.8】只按"平均洋底深度"沉的话，新海盆的中位
        // 深度和周围大洋一样深 —— 但周围大洋本来就是从原来的地形挖出来的，
        // 这一块刚沉下去，视觉上就成了**比旁边浅一圈的浅滩**，
        // 像一块被水淹了的高台，不像"沉陷成海洋"。
        // 乘 1.8 之后中位深度落在周围洋底之下，边缘仍是浅滩（模拟陆架），
        // 中心深到 -0.75 左右（全世界最深处也是这个量级）。
        lut[b] = -Math.max(0.05, Math.min(1.55, HY.sea(r) * 1.8));
      } else if (r < qSea) {
        // 岸线以外：t 从 1（最远）收到 0（紧贴岸线），越远越深
        const t = qSea > 1e-6 ? (qSea - r) / qSea : 0;
        lut[b] = -Math.max(0.05, HY.sea(t));
      } else {
        // 陆地上：t 从 0（岸线）到 1（最高点）
        const t = qSea < 1 - 1e-6 ? (r - qSea) / (1 - qSea) : 1;
        // 0.002 的下限：让最靠岸的一圈刚好高于海平面，否则它们
        // 恰好压在海平面上，渲染时是一圈"海的陆地色"的虚边。
        lut[b] = 0.002 + HY.rel(t);
      }
    }

    return (a) => {
      const f = ((a - aMin) / span) * BINS;
      const b0 = Math.max(0, Math.min(BINS - 1, f | 0));
      const t = Math.max(0, Math.min(1, f - b0));
      return lut[b0] * (1 - t) + lut[b0 + 1] * t;
    };
  }

  // ==================== 套索：多边形 → 强度场（已不再接线）====================
  //
  // 上一版的套索造山：PCA 找主轴 → 沿主轴铺轴线 → 支脉 → 强度场。
  // 现在套索只做「选区塑形」（buildSelectionMask + shapeRegion），
  // 这里保留作为「在选区内长一条山链」的实验入口。


  /**
   * 由套索多边形构造强度场。
   *
   * 旧实现直接用「到多边形边界距离 + ridged noise」整体抬升，得到的是
   * 一块**各向同性**的隆起（像倒扣的碗）。真实的山是线性的：
   * 先有山链（主轴），再从主轴分叉。
   *
   * 因此这里先做 PCA 找主轴，沿主轴铺一条（可能弯曲的）轴线并派生支脉，
   * 再用「到多边形边界的距离」当掩膜限制在选区内。于是套索造山 =
   * 「在圈定范围里长一条山链」，而不是「把圈里的地整体抬高」。
   *
   * @returns {{box:object, mask:Float32Array|null, nodes:Array}}
   */
  function buildLassoField(field, W, H, polygon, opt) {
    const radius = opt.radius;
    const seed = opt.seed | 0;
    const mode = opt.mode || 'mountain';
    // 掩膜缓冲复用：套索一次可能连续操作，避免每次都分配 5 MB
    const mask = (opt.maskBuffer && opt.maskBuffer.length === W * H)
      ? opt.maskBuffer
      : new Float32Array(W * H);
    mask.fill(0);
    field.fill(0);

    // ---- 1. 包围盒 ----
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of polygon) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    if (!(maxX > minX) || !(maxY > minY)) return { box: null, mask, nodes: [] };

    const box = {
      x0: Math.max(0, Math.floor(minX) - 2),
      y0: Math.max(0, Math.floor(minY) - 2),
      x1: Math.min(W - 1, Math.ceil(maxX) + 2),
      y1: Math.min(H - 1, Math.ceil(maxY) + 2),
    };
    const yA = box.y0;
    const yB = box.y1;

    // ---- 2. 扫描线填充 + 倒角距离变换 ----
    //
    // 【为什么不用逐点射线法】旧实现是「遍历 bbox 内每个格子做 pointInPolygon」，
    // 复杂度 O(格子数 × 顶点数)，200 顶点 × 4 万格 = 800 万次跨立测试，
    // 单次套索操作就要几百毫秒。扫描线是 O(行数 × 顶点数 + 面积)。
    //
    // 【为什么要距离变换】掩膜必须是「到边界的内距」而不是硬 0/1：
    // 硬掩膜会在选区边缘切出一道垂直墙，是「不自然」最明显的来源。
    const INF = 1e9;
    const dist = mask;
    let area = 0;
    let sumX = 0;
    let sumY = 0;
    for (let y = yA; y <= yB; y++) {
      const xs = scanlineIntersections(polygon, y);
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        let a = Math.ceil(xs[k]);
        let b = Math.floor(xs[k + 1]);
        if (a < box.x0) a = box.x0;
        if (b > box.x1) b = box.x1;
        if (b < a) continue;
        const rowBase = y * W;
        const w = b - a + 1;
        // 水平距离作为初始内距
        for (let x = a; x <= b; x++) {
          dist[rowBase + x] = Math.min(x - a + 1, b - x + 1);
        }
        area += w;
        sumX += ((a + b) * 0.5) * w;
        sumY += y * w;
      }
    }
    if (area <= 0) return { box: null, mask, nodes: [] };
    const cx = sumX / area;
    const cy = sumY / area;

    // 两遍倒角（forward / backward），把「水平距离」传播成近似欧氏内距。
    // 只扫 bbox 内部；bbox 内、多边形外的格子保持 0，天然充当边界源。
    const D1 = 1;
    const D2 = Math.SQRT2;
    for (let y = yA + 1; y <= yB; y++) {
      const row = y * W;
      for (let x = box.x0; x <= box.x1; x++) {
        const i = row + x;
        let m = dist[i];
        if (m === 0) continue;
        if (x > 0) {
          if (m > dist[i - W - 1] + D2) m = dist[i - W - 1] + D2;
          if (m > dist[i - 1] + D1) m = dist[i - 1] + D1;
        }
        if (m > dist[i - W] + D1) m = dist[i - W] + D1;
        if (x < W - 1 && m > dist[i - W + 1] + D2) m = dist[i - W + 1] + D2;
        dist[i] = m;
      }
    }
    for (let y = yB - 1; y >= yA; y--) {
      const row = y * W;
      for (let x = box.x1; x >= box.x0; x--) {
        const i = row + x;
        let m = dist[i];
        if (m === 0) continue;
        if (x < W - 1) {
          if (m > dist[i + W + 1] + D2) m = dist[i + W + 1] + D2;
          if (m > dist[i + 1] + D1) m = dist[i + 1] + D1;
        }
        if (m > dist[i + W] + D1) m = dist[i + W] + D1;
        if (x > 0 && m > dist[i + W - 1] + D2) m = dist[i + W - 1] + D2;
        dist[i] = m;
      }
    }

    // ---- 3. 内距 → 掩膜 ----
    //
    // 两种形状，用途不同：
    //   plateau（造山用）：内距超过过渡带就饱和到 1，得到「平台 + 软边」。
    //     山体不该随着选区中心距离变远而均匀变矮 —— 那是碗；
    //   dome（抬升/压低用）：内距归一化后做球面隆起，中心最高、边缘归零。
    let maxDist = 1;
    for (let y = yA; y <= yB; y++) {
      const row = y * W;
      for (let x = box.x0; x <= box.x1; x++) {
        const d = dist[row + x];
        if (d > maxDist) maxDist = d;
      }
    }
    const plateau = mode === 'mountain' || mode === 'hills';
    const band = Math.max(1.5, maxDist * (plateau ? 0.3 : 1));
    for (let y = yA; y <= yB; y++) {
      const row = y * W;
      for (let x = box.x0; x <= box.x1; x++) {
        const i = row + x;
        const d = dist[i];
        if (d <= 0) { dist[i] = 0; continue; }
        let t;
        if (plateau) {
          // 过渡带内平滑爬升，之后饱和
          t = Math.min(1, d / band);
        } else {
          // 球面拱形：中心 1，边缘 0，切线连续
          const r = Math.min(1, d / maxDist);
          t = Math.sqrt(Math.max(0, 1 - r * r));
          t = Math.min(1, t * 1.6);
        }
        dist[i] = t * t * (3 - 2 * t);
      }
    }

    // ---- 4. 造山：沿主轴铺山链 ----
    //
    // 【为什么要 PCA 找主轴】旧实现是「整体抬升 × ridged noise」，
    // 得到的是一个各向同性的隆起（像倒扣的碗）。真实山脉是线性的：
    // 先有山链走向，再从主脊分叉出支脉。主轴由选区内部点的协方差
    // 矩阵最大特征向量给出 —— 也就是「选区最长的那个方向」。
    const nodes = [];
    let dirX = 1;
    let dirY = 0;
    if (mode === 'mountain' || mode === 'hills') {
      let sxx = 0;
      let syy = 0;
      let sxy = 0;
      for (let y = yA; y <= yB; y++) {
        const xs = scanlineIntersections(polygon, y);
        if (xs.length < 2) continue;
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const a = xs[k];
          const b = xs[k + 1];
          const mid = (a + b) * 0.5;
          const w = Math.max(0, b - a);
          if (w <= 0) continue;
          const dx = mid - cx;
          const dy = y - cy;
          // 【必须加上弦内方差 w²/12】
          // 把一行内的水平弦当成「质量集中在弦中点」是错的：
          // 长弦在 x 方向有额外的展布。漏掉这一项时，一个 30° 倾斜的
          // 长椭圆会被算成 47°（实测），因为 x 的离散度被系统性低估。
          sxx += (dx * dx + (w * w) / 12) * w;
          syy += dy * dy * w;
          sxy += dx * dy * w;
        }
      }
      const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      dirX = Math.cos(theta);
      dirY = Math.sin(theta);

      // 山链长度 ≈ 选区沿主轴方向的尺度，但至少要有笔刷那么大，
      // 否则小选区里塞不下一条山脊
      const proj = Math.max(Math.abs(maxX - minX) * Math.abs(dirX), 1) +
        Math.max(Math.abs(maxY - minY) * Math.abs(dirY), 1);
      const L = Math.max(radius * 1.1, Math.min(proj * 1.05, radius * 5));
      const count = Math.max(3, Math.ceil(L / (radius * 0.5)));
      const bendAmp = (hash2(seed, 7, seed) - 0.5) * L * 0.16;
      for (let i = 0; i <= count; i++) {
        const t = i / count - 0.5;
        const wob = Math.sin(t * Math.PI) * bendAmp;
        nodes.push({
          x: cx + dirX * (t * L) - dirY * wob,
          y: cy + dirY * (t * L) + dirX * wob,
          arc: i * (L / count),
          index: i,
        });
      }
      buildStrokeField(field, W, H, nodes, {
        radius: mode === 'hills' ? radius * 0.6 : radius,
        seed,
        spurs: true,
        arcEnv: mode === 'hills' ? 0.62 : 1,
      });
      // 山链 × 选区掩膜：山脊不能越出用户画的圈
      for (let y = yA; y <= yB; y++) {
        const row = y * W;
        for (let x = box.x0; x <= box.x1; x++) {
          const i = row + x;
          field[i] *= dist[i];
        }
      }
    } else {
      // 抬升 / 压低 / 扰动：不需要轴线，掩膜本身就是形状
      for (let y = yA; y <= yB; y++) {
        const row = y * W;
        for (let x = box.x0; x <= box.x1; x++) {
          field[row + x] = dist[row + x];
        }
      }
    }

    return { box, mask: dist, nodes, dirX, dirY };
  }

  /** 水平扫描线与多边形的交点（偶数个交点配对成内部区间） */
  function scanlineIntersections(polygon, y) {
    const xs = [];
    const n = polygon.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yi = polygon[i].y;
      const yj = polygon[j].y;
      if ((yi > y) === (yj > y)) continue;
      const xi = polygon[i].x;
      const xj = polygon[j].x;
      xs.push(xi + ((y - yi) / (yj - yi)) * (xj - xi));
    }
    return xs;
  }

  // ==================== 幅度换算 ====================

  /**
   * 笔刷强度 → 高度幅度。
   *
   * 归一化到「陆地可用高度」（1 − seaLevel），于是同样的强度滑块在
   * 海洋占比 50% 与 90% 的图上得到视觉相近的地形起伏 ——
   * 旧实现直接用绝对高度，海平面一改，笔刷就"变轻"或"变重"。
   */
  function amplitudeFor(strength, radius, seaLevel) {
    // 【下限只能设很小】这个下限原本写的是 0.15，可是 app 生成的地图
    // 海平面 P99.5 锚定在 0.93 —— 陆地只有 0.07 的高度空间，被 0.15
    // 一兜底就放大了 2.1 倍：默认强度 0.26 的一笔直接把地形顶到雪线
    // （landE 增幅实测 1.00），整片山变成一块白。下限只是为了防
    // 「全是海」的极端地图除以零，0.05 足够。
    const landRoom = Math.max(0.05, 1 - seaLevel);
    // 小笔刷造小丘，大笔刷造山系；指数式收敛避免 200px 笔刷一击入云
    const sizeFactor = Math.max(0.5, Math.min(1.15, 0.45 + radius / 120));
    // 2.15 是「手感补偿」系数：旧实现沿笔迹**累加**一串圆，
    // 同一笔重叠区会被叠到饱和（虽然会摊出平台，但确实抬得高）。
    // 新实现用 max 合并强度场，峰值就等于 amp 本身 —— 计算结果是对的，
    // 可是同一个强度滑块造出来的山矮了将近一半，用户会觉得"笔刷变没劲了"。
    // 因此把幅度整体抬到 2.15 倍，让默认强度下的观感与旧版接近。
    return strength * landRoom * sizeFactor * 2.15;
  }

  /**
   * 侵蚀的默认参数（编辑器与离屏预览共用同一份）。
   *
   * 【为什么要集中】之前编辑器和预览脚本各自写了一套，预览用的是
   * talus 0.012、编辑器用 0.009 —— 看图调参时改的根本不是实际生效的那一套。
   */
  const EROSION_DEFAULTS = {
    // 休止角占「局部高差」的比例（不是绝对值 —— 绝对值和地形量级强相关，
    // 见 erode() 里的说明）。0.055 ≈ 一座山每 18 格允许的最大高差。
    talusRel: 0.055,
    thermalIters: 6,
    thermalRate: 0.5,
    hydraulicIters: 6,
    kFactor: 10.0,
    // 【kFactor 的量级】drop = kFactor · √(flow/n) · slope。
    // 山脊场景里 flow 最大只有 300 格、n 却有七万多，√(flow/n) ≈ 0.06，
    // 所以 kFactor 必须到 10 量级，单次下切才有 0.5% 的峰高 —— 
    // 早先写 0.65 时整段水力侵蚀几乎不产生可测的变化（0.0009/轮）。
    // 实测「沟底下切度」随 kFactor 单调上升：3→0.00113、8→0.00148、15→0.00194，
    // 取 10 与纯热力（0.00134）相比有 +10% 的净贡献。
    // 河道起始门槛：绝对汇水格数（见 hydraulicPass 里的说明）。
    minAreaCells: 30,
    maxDrop: 0.005,
  };

  FM.TerrainOps = {
    // 噪声
    hash2,
    valueNoise,
    fbm,
    ridgedFbm,
    // 轴线
    StrokeWalker,
    NODE_SPACING_RATIO,
    stampSegment,
    stampIncremental,
    strokeStyle,
    pathDirection,
    spawnSpurs,
    buildStrokeField,
    // 合成
    synthesize,
    amplitudeFor,
    EROSION_DEFAULTS,
    // 侵蚀
    thermalPass,
    hydraulicPass,
    erode,
    smoothRegion,
    // 套索
    buildLassoField,
    buildSelectionMask,
    shapeRegion,
    scanlineIntersections,
  };
})(typeof window !== 'undefined' ? window : self);
