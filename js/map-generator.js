/**
 * map-generator.js —— 世界地图数据生成器
 *
 * 生成流程（每个阶段都会通过 onProgress 汇报进度并让出主线程）：
 *   A. 构造板块地形：球面 3D 噪声 + 板块 Voronoi + 碰撞造山
 *   B. 全局排序确定海平面，精确控制海陆比例
 *   C. 行星风带 / 洋流环流 / 温湿度传输
 *   D. 水文系统（hydrology.js）：填洼 → 流向 → 汇流 → 河网与湖泊
 *   E. 生态群系（Whittaker 温湿矩阵）
 */
(function (root) {
  'use strict';

  const FM = root.FM = root.FM || {};
  const { Hydrology } = FM;

  /** 让出主线程，让进度条能够刷新 */
  const yieldToUi = () => new Promise((resolve) => setTimeout(resolve, 0));

  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

  /**
   * 可复现的伪随机数（xorshift32 + FNV 字符串哈希）。
   *
   * 【为什么不用 Math.random】地形已按行带分给多个 Worker 并行计算，
   * 板块数据必须由主线程一次生成后分发；但「同一次生成」要能被完整复现
   * （基准测试要对比优化前后的数值、玩家也可能想复现同一张图），
   * 所以随机源要能由种子唯一确定。
   */
  function makeRng(seedStr) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < seedStr.length; i++) {
      h ^= seedStr.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    let state = h || 0x9e3779b9;
    return function next() {
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return state / 4294967296;
    };
  }

  // 测高曲线（陆地高度分布 / 海底深度分布）在 js/hypsometry.js 里，
  // 以 FM.HYPSO 暴露。生成与选区塑形共用同一份 —— 说明见那个文件。
  const HYPSO = FM.HYPSO;
  if (!HYPSO) throw new Error('hypsometry.js 必须在 map-generator.js 之前加载');

  class MapGenerator {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      this.seaLevel = 0.55;
      this.cells = [];
      this.rivers = [];
      this.lakes = [];
      this.hydrology = null;
      this.stats = {};
      this.simplex = null;
    }

    idx(x, y) {
      return y * this.width + x;
    }

    /**
     * 真·球面 3D 噪声映射。
     *
     * 实现已移到 terrain.js（主线程与 Worker 共用同一份代码），
     * 这里保留同名方法，供气候 / 渲染 / 编辑器继续按原方式调用。
     */
    noiseSeamless(nx, ny, baseFrequency, octaves = 5, persistence = 0.5, lacunarity = 2, offset = 0) {
      return FM.Terrain.noiseSeamless(
        this.simplex, nx, ny, baseFrequency, octaves, persistence, lacunarity, offset
      );
    }

    /**
     * 生成一张完整地图。
     * @param {{plateCount?:number, seaLevel?:number}} params
     * @param {(progress:number, label:string)=>void} onProgress
     */
    async generate(params = {}, onProgress = () => {}) {
      const t0 = performance.now();
      const W = this.width;
      const H = this.height;
      const N = W * H;

      const oceanRatio = clamp01(params.seaLevel ?? 0.7);
      const plateCount = Math.max(2, Math.min(20, params.plateCount ?? 6));

      this.cells = new Array(N);
      this.rivers = [];
      this.lakes = [];

      // 噪声种子：显式传入可复现（基准测试 / 调试），否则每次随机。
      // 【必须显式播种】地形按行带切给多个 Worker 并行计算，各线程必须
      // 拿到完全相同的 SimplexNoise 置换表，否则行带交界会出现错位缝。
      const seed = params.seed != null
        ? String(params.seed)
        : 'w' + Math.random().toString(36).slice(2);
      this.seed = seed;
      this.simplex = new SimplexNoise(seed);
      this._rand = makeRng(seed);

      /** 阶段切换：刷新进度 + 让出主线程 */
      const stage = async (progress, label) => {
        onProgress(progress, label);
        await yieldToUi();
      };

      // ==================== A. 构造板块地形 ====================
      await stage(0.0, '构造板块…');
      const plates = this.#createPlates(plateCount);

      // 逐像素独立 → 按行带交给 Worker 并行计算；内部自带「失败回退单线程」。
      // 单线程实测 9~11 s，4 核并行后约 2~3 s，结果逐位一致。
      const eArray = await FM.Terrain.computeElevation(
        { W, H, plates, seed },
        (progress) => onProgress(0.02 + 0.58 * progress, '构造板块地形…')
      );
      // 记录实际执行路径（Worker 并行 / 单线程兜底）与线程数，用于状态栏
      const terrainRun = FM.Terrain.lastRun();
      await yieldToUi();


      // ==================== A2. 削峰 + 细节重建 ====================
      //
      // 【问题】早期实现用 3 遍 3x3 高斯平滑来消除单格尖脊，
      // 但高斯是各向同性的低通滤波 —— 它不只削掉尖峰，也把整片地形的
      // 高频细节一起磨平。实测陆地平均二阶差分只剩 0.00049，
      // 于是斜面上出现"边缘平滑、形状突兀"的鼓包，看起来完全不像山。
      //
      // 【新方案】把"去尖刺"和"保细节"分开处理：
      //   1. 3x3 中值滤波：只替换明显偏离邻域的离群点（尖刺），
      //      对正常地形几乎零影响（中值天然抗噪，不模糊边缘）；
      //   2. 细节重建：把中值滤波"去掉的那部分"按比例加回去，
      //      即 e = median + (e - blur) * k。这样既削平了单格尖刺，
      //      又保留了山脊的起伏纹理，视觉上才是真正的山。
      await stage(0.58, '削峰与细节重建…');
      {
        const src = eArray;
        const med = new Float32Array(N);
        const win = new Float32Array(9);

        // --- 1. 3x3 中值 ---
        for (let y = 0; y < H; y++) {
          const rowUp = y > 0 ? y - 1 : y;
          const rowDn = y < H - 1 ? y + 1 : y;
          for (let x = 0; x < W; x++) {
            const xl = (x - 1 + W) % W;
            const xr = (x + 1) % W;
            win[0] = src[rowUp * W + xl];
            win[1] = src[rowUp * W + x];
            win[2] = src[rowUp * W + xr];
            win[3] = src[y * W + xl];
            win[4] = src[y * W + x];
            win[5] = src[y * W + xr];
            win[6] = src[rowDn * W + xl];
            win[7] = src[rowDn * W + x];
            win[8] = src[rowDn * W + xr];
            // 9 元素插入排序（比通用排序快得多）
            for (let a = 1; a < 9; a++) {
              const v = win[a];
              let b = a - 1;
              while (b >= 0 && win[b] > v) { win[b + 1] = win[b]; b--; }
              win[b + 1] = v;
            }
            med[y * W + x] = win[4];
          }
          if ((y & 63) === 0) {
            onProgress(0.58 + 0.02 * (y / H), '削峰与细节重建…');
            await yieldToUi();
          }
        }

        // --- 2. 轻度模糊（仅用于提取"细节层"） ---
        const blur = new Float32Array(N);
        for (let y = 0; y < H; y++) {
          const rowUp = y > 0 ? y - 1 : y;
          const rowDn = y < H - 1 ? y + 1 : y;
          for (let x = 0; x < W; x++) {
            const xl = (x - 1 + W) % W;
            const xr = (x + 1) % W;
            blur[y * W + x] = (
              med[rowUp * W + xl] + med[rowUp * W + x] * 2 + med[rowUp * W + xr] +
              med[y * W + xl] * 2 + med[y * W + x] * 4 + med[y * W + xr] * 2 +
              med[rowDn * W + xl] + med[rowDn * W + x] * 2 + med[rowDn * W + xr]
            ) / 16;
          }
          if ((y & 63) === 0) {
            onProgress(0.60 + 0.02 * (y / H), '削峰与细节重建…');
            await yieldToUi();
          }
        }

        // --- 3. 合成：基底用中值结果，细节层按 0.75 加回 ---
        // DETAIL_K 越大越"崎岖"；0.75 能保留山脊纹理但去掉刺眼尖峰。
        const DETAIL_K = 1.05;
        for (let i = 0; i < N; i++) {
          eArray[i] = blur[i] + (med[i] - blur[i]) * DETAIL_K;
        }
      }

      // ==================== B. 海平面 ====================
      //
      // 【曾经走错的路】为了让七档色带都能用上、让雪山出现，
      // 这里一度用「分位重标定」把陆地高度按排名强行均匀铺开。
      // 结果：每块大陆都被机械地分配到全部七档，色带变成一圈圈
      // 同心环，雪山变成一块实心白色平台（边界高度落差中位数仅 0.016）
      // —— 整张图看起来像「地球仪涂装」，完全没有真实地貌的层次。
      // 那条路走不通，但**根子不在"重分布"本身，而在分布的目标**：
      // 当时是把高度均匀铺满七档（等于假设地球一半陆地是高山），
      // 现在改成朝真实测高曲线压缩（三分之二是低平原）。
      await stage(0.62, '计算海平面…');
      const sortedE = Float32Array.from(eArray);
      sortedE.sort();
      this.seaLevel = sortedE[Math.floor(N * oceanRatio)];
      const sea = this.seaLevel;

      // --- 陆地：以海平面为基准做测高曲线重分布 ---
      //
      // 【为什么必须重分布，而不是只调对比度】
      // 分形地形的原始高度场几乎是**均匀分布**的，而真实陆地的高度分布
      // （测高曲线 / hypsometric curve）极度左偏：
      //   地球：33% 陆地 < 200 m、66% < 500 m、82% < 1000 m、93% < 2000 m。
      // 也就是说**三分之二的陆地是低平原**，高山只是极少数。
      //
      // 旧实现只把 P99.5 锚到 0.93 再乘一次 rel^(1/1.08)（≈原样），
      // 分位形态完全保留了下来。实测这块大陆：
      //   rel p50 = 0.264（≈2300 m）、p90 = 0.643（≈5700 m）
      // 对照地球应当是 p50 ≈ 0.04、p90 ≈ 0.23 —— **整体高了 5~6 倍**。
      //
      // 后果全部落在气候上，而且每一个都是用户看到的「不自然」：
      //   · 雪线横扫：rel 中位数就有 0.26，于是随便一块台地都越过雪线，
      //     实测 climate-verify 那张图 **22.6% 的陆地是雪地**；
      //   · 裸岩/高山冻原成片：大陆看起来像一片碎石高原，没有平原；
      //   · 草原几乎消失：高寒群系吃掉 35.5%，草原只剩 12.6%；
      //   · 气温被海拔拉低：`t -= rel·LAPSE` 让整块大陆比同纬度海洋冷，
      //     温带森林被压成针叶林。
      //
      // 现在用幂次做压缩：rel' = rel^LAND_HYPSO。
      // 取 1.9 相当于把「中位陆地」从 0.264 压到 0.078（≈690 m）、
      // p90 从 0.643 压到 0.42，同时峰顶仍然触得到 1 —— 因为只在
      // 分位锚定后的相对值上取幂，最高的 0.5% 不受影响。
      //
      // 【为什么不用「按名次重排成地球曲线」】
      // 那会把分布做得更准，但会让地形本身变成按高度排序的单调场，
      // 山头之间失去起伏（README 里记录过这次翻车：整块大陆变成
      // 一圈圈同心等高线、雪山变成实心白台）。幂次压缩是可逆的单调变换，
      // 完整保留原有的山脊走向与谷地结构，只是把「高原」压回「丘陵」。

      // --- 陆地：按真实测高曲线重分布 ---
      //
      // 【为什么幂次压缩不够】试过 rel' = rel^1.9，中位数确实压对了
      // （0.264 → 0.069，≈620 m），但**尾部压不动**：实测 p90 仍有 0.432
      // （≈3800 m），而地球的 p90 是 0.226。10% 的陆地高于 3800 m，
      // 雪线一过就是成片白 —— 雪地占陆地从 4.8% 涨到 16.9%（另一个 seed 33%）。
      // 幂次是"等比缩放"，形状没变；问题在**形状**本身：分形地形的
      // 高度分布近乎均匀，而真实陆地是"一大片低平原 + 一条薄薄的高山带"。
      //
      // 所以直接按**分位**映射到地球的测高曲线：第 r 分位的陆地，
      // 高度就是地球第 r 分位的高度。这样统计意义上的平原/高原/山地比例
      // 天然与地球一致，不管地形生成器的原始分布长什么样。
      //
      // 【为什么这次不会再翻车】README 里记录的那次"按排名均匀铺开"
      // 是把陆地**均匀**分配到七档（等于假设一半陆地是高山），
      // 于是每块大陆都被机械拉满全档、色带变成同心环。
      // 这里的映射是**单调**的，而且目标曲线强烈左偏：
      // 等高线的走向、山脊、谷地与原来逐格一致（单调变换不改变任何
      // 大小关系），改变的只是相邻等高线之间的间距 —— 平原变宽、陡坡变陡。
      {
        const rels = [];
        for (let i = 0; i < N; i++) {
          if (eArray[i] < sea) continue;
          rels.push((eArray[i] - sea) / (1 - sea));
        }
        rels.sort((a, b) => a - b);
        const nLand = rels.length;

        if (nLand > 0) {
          // 地球测高曲线（分位 → 相对高度，最高峰 8848 m 记作 1.0）
          // 【共享一份，不要在这里内联】选区塑形（terrain-ops.js 的
          // shapeRegion）必须用同一条曲线，否则圈出来的新大陆与已生成的
          // 老陆地高度量级对不上 —— 见 FM.HYPSO 的说明。
          const earthRel = HYPSO.rel;

          // 建一张「输入高度 → 输出高度」的查表，避免逐格二分查找。
          // 表按输入 rel 均匀分箱，箱内取分位映射后的目标值。
          const BINS = 1024;
          const relMax = rels[nLand - 1] > 1e-6 ? rels[nLand - 1] : 1;
          const lut = new Float32Array(BINS + 1);
          {
            let k = 0;
            for (let b = 0; b <= BINS; b++) {
              const edge = (b / BINS) * relMax;
              // 推进到第一个 > edge 的位置，得到该高度处的累积占比
              while (k < nLand && rels[k] <= edge) k++;
              lut[b] = earthRel(k / nLand);
            }
          }

          for (let i = 0; i < N; i++) {
            if (eArray[i] < sea) continue;
            const rel = (eArray[i] - sea) / (1 - sea);
            const f = Math.max(0, Math.min(BINS - 1e-6, (rel / relMax) * BINS));
            const b0 = f | 0;
            const t = f - b0;
            const out = lut[b0] * (1 - t) + lut[b0 + 1] * t;
            eArray[i] = sea + Math.max(0, Math.min(1, out)) * (1 - sea);
          }
        }
      }

      // --- 海洋：保留原始深度范围，只做温和对比度调整 ---
      //
      // 注意不要压缩深度范围：海洋色带是按「最深处」归一化的，
      // 如果把最大深度从 0.9 压到 0.35，整片海会显得又浅又平，
      // 深浅层次全部消失。这里保持量级不变，仅用幂次调整分布曲线。
      {
        let maxDepth = 0;
        for (let i = 0; i < N; i++) {
          const d = sea - eArray[i];
          if (d > maxDepth) maxDepth = d;
        }
        const SEA_EXP = 1.15;
        // 目标最大深度：保证有足够深的深海（约 0.75），色带能铺满
        const targetDeep = Math.max(0.75, maxDepth);
        for (let i = 0; i < N; i++) {
          if (eArray[i] >= sea) continue;
          const d = sea - eArray[i];
          const t = maxDepth > 1e-6 ? d / maxDepth : 0;
          eArray[i] = sea - Math.pow(t, SEA_EXP) * targetDeep;
        }
      }

      // ==================== C1. 格子结构初始化 ====================
      // 只建数据结构；温度/湿度/风场/洋流全部交给 climate.js 计算。
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const idx = this.idx(x, y);
          this.cells[idx] = {
            x, y, e: eArray[idx],
            m: 0,
            temp: 0,
            precip: 0,
            windU: 0,
            windV: 0,
            pressure: 0,
            monsoon: 0,
            isRiver: false,
            isLake: false,
            flow: 0,
            current: { u: 0, v: 0 },
            biome: '海洋',
          };
        }
        if ((y & 31) === 0) {
          onProgress(0.63 + 0.04 * (y / H), '初始化格点…');
          await yieldToUi();
        }
      }

      // ==================== C2. 气候系统 ====================
      //
      // 完整的气候模拟交给 climate.js：行星风带（三圈环流）→ 季风
      // （海陆热力差异）→ 洋流（风应力 + 西边界流 + 热盐环流）→
      // 水汽输运与降水（含季风雨季）→ 生态群系。
      //
      // 旧实现把气候内联在这里：风只是按纬度取 ±1 的水平方向，
      // 洋流只给海温加减 0.15，没有季风，也不参与降水与植被循环。
      await stage(0.68, '模拟季风与洋流…');
      const climate = new FM.ClimateSystem({
        width: W,
        height: H,
        cells: this.cells,
        seaLevel: this.seaLevel,
        noise: (nx, ny, f, o, p, l, off) => this.noiseSeamless(nx, ny, f, o, p, l, off),
      });
      await climate.solve(
        (p, label) => onProgress(0.68 + p * 0.20, label),
        yieldToUi
      );
      this.climate = climate;
      const climateStart = performance.now();

      // ==================== D. 水文系统 ====================
      await stage(0.87, '计算河流与湖泊…');
      const hydrology = new Hydrology({
        width: W,
        height: H,
        elevation: eArray,
        seaLevel: this.seaLevel,
      }).solve();

      this.hydrology = hydrology;
      this.rivers = hydrology.rivers;
      this.lakes = hydrology.lakes;
      for (let i = 0; i < N; i++) {
        const c = this.cells[i];
        c.isLake = hydrology.isLake[i] === 1;
        c.isRiver = hydrology.isRiver[i] === 1 && !c.isLake;
        c.flow = hydrology.flow[i];
      }

      // ==================== E. 生态群系 ====================
      // 群系已在 climate.js 的 solve() 里根据「温度 × 降水量」划分完毕。
      // 这里只把湖泊/河流的地表状态叠加到群系上（水体优先于植被）。
      await stage(0.92, '整理生态群系…');
      // 河流/湖泊对两岸生态的影响（湿度抬升 + 温度调节 + 重新分类群系）
      this.applyWaterInfluence();
      for (const c of this.cells) {
        if (c.isLake) c.biome = '湖泊';
        else if (c.e < this.seaLevel) {
          // 水体群系按深度细分
          const d = this.seaLevel - c.e;
          c.biome = d > 0.22 ? '深海' : d > 0.05 ? '海洋' : '浅海';
        }
      }


      onProgress(1.0, '完成');
      this.stats = {
        generateMs: performance.now() - t0,
        climateMs: performance.now() - climateStart,
        ...hydrology.metrics,
        riverCount: this.rivers.length,
        lakeCount: this.lakes.length,
        plateCount,
        oceanRatio,
        terrainMode: terrainRun.mode,
        terrainThreads: terrainRun.threads,
      };
      return this.stats;
    }

    /** 随机板块：偏向海洋板块，让大陆成片而不是碎岛 */
    #createPlates(plateCount) {
      const plates = [];

      // 【关键】必须保证「至少两块大陆板块相邻」。
      // 陆陆碰撞是唯一能造出高大山脉（以及雪线）的机制；
      // 若随机结果里全是海洋板块，或大陆板块彼此被海洋板块隔开，
      // 整张图就只会有一两座孤立小丘，雪线永远出不来。
      // 因此这里先确定 2~3 块大陆板块，并让它们位置相邻。
      const continentalCount = Math.max(2, Math.min(3, Math.floor(plateCount * 0.5)));

      for (let i = 0; i < plateCount; i++) {
        let px;
        let py;
        let type;

        if (i < continentalCount) {
          // 前几块是大陆板块，沿同一条大圆弧排布 → 彼此相邻 → 必然发生碰撞
          type = 'continental';
          const baseAngle = 0.18 + (i / Math.max(1, continentalCount)) * 0.30;
          px = (baseAngle + (this._rand() - 0.5) * 0.05) % 1;
          py = (this._rand() - 0.5) * 0.45;
        } else {
          // 其余是海洋板块，散布在别处
          type = 'oceanic';
          px = this._rand();
          py = this._rand() - 0.5;
        }

        const pLon = px * Math.PI * 2;
        const pLat = py * Math.PI;
        // 类型决定高度的「倾向」，但具体数值是连续的 ——
        // 避免所有大陆板块都是同一个 +0.10、所有海洋板块都是 -0.10，
        // 那样在板块交汇处会产生整齐的台阶。
        const base = type === 'continental' ? 0.055 : -0.055;
        const heightOffset = base + (this._rand() - 0.5) * 0.04;
        plates.push({
          x: px,
          y: py,
          x3: Math.cos(pLat) * Math.cos(pLon),
          y3: Math.sin(pLat),
          z3: Math.cos(pLat) * Math.sin(pLon),
          type,
          heightOffset,
        });
      }
      return plates;
    }

    /** 当前地形高度数组（供水文重算 / 序列化） */
    elevationArray() {
      const arr = new Float32Array(this.cells.length);
      for (let i = 0; i < this.cells.length; i++) arr[i] = this.cells[i].e;
      return arr;
    }

    /**
     * 让河流与湖泊影响局地生态。
     *
     * 【为什么需要单独一步】
     * 生成管线是「气候 → 水文」：气候在算温度/湿度/群系时，河流湖泊
     * 还不存在；水文算完之后，也没有任何一步回头修正生态。
     * 结果就是河流只是地图上的一条蓝线，对两岸植被毫无影响 ——
     * 撒哈拉里的尼罗河两岸和周围沙漠一模一样，这显然不真实。
     *
     * 【实现】以「河流格 + 湖泊格」为源做一次多源 BFS，得到每个陆地格
     * 到最近水体的距离，再按距离衰减地做两件事：
     *   1. 抬升湿度 → 河岸/湖滨出现更湿润的群系（荒漠里长出绿色走廊）；
     *   2. 轻微调节温度 → 水体热惯性让近水区更温和（内陆极端性减弱）。
     * 然后按新的温湿值重新分类群系。
     *
     * 【为什么用 mBase/tempBase】编辑地形会触发重建水系，本函数会被反复
     * 调用。必须从「纯气候基准值」重算，否则湿度逐次累加，河边最终会
     * 变成一片沼泽。
     */
    applyWaterInfluence() {
      const W = this.width;
      const H = this.height;
      const N = W * H;
      const cells = this.cells;
      const sea = this.seaLevel;
      const classify = FM.classifyBiome;

      // ---- 多源 BFS：到最近河流/湖泊的距离（格数）----
      const RIVER_REACH = 9;   // 河岸影响半径（见下方参数演进说明）
      const dist = new Int32Array(N).fill(-1);
      const queue = new Int32Array(N);
      let head = 0;
      let tail = 0;
      for (let i = 0; i < N; i++) {
        const c = cells[i];
        if (c.e < sea || c.isRiver || c.isLake) {
          dist[i] = 0;
          queue[tail++] = i;
        }
      }
      while (head < tail) {
        const i = queue[head++];
        const d = dist[i] + 1;
        if (d > 16) continue;          // 影响半径上限（约 3.5° / 400km）
        const x = i % W;
        const y = (i / W) | 0;
        for (let k = 0; k < 4; k++) {
          const nx2 = k === 0 ? (x - 1 + W) % W : k === 1 ? (x + 1) % W : x;
          const ny2 = k === 2 ? y - 1 : k === 3 ? y + 1 : y;
          if (ny2 < 0 || ny2 >= H) continue;
          const j = ny2 * W + nx2;
          if (dist[j] >= 0) continue;
          dist[j] = d;
          queue[tail++] = j;
        }
      }

      // ---- 按距离衰减地修正湿度与温度，并重新分类群系 ----
      for (let i = 0; i < N; i++) {
        const c = cells[i];
        if (c.e < sea || c.isLake || c.isRiver) continue;   // 水体本身不修正
        const d = dist[i];
        if (d < 0 || d > RIVER_REACH) continue;
        // d=1 → 0.71，d=4 → 0.40，d=8 → 0.17，d=REACH → ≈0.06
        const prox = Math.exp(-(d - 1) / 6.5);
        const mBase = c.mBase != null ? c.mBase : c.m;
        const tBase = c.tempBase != null ? c.tempBase : c.temp;
        // 【参数演进 —— 三次都朝「更窄、更弱」收】
        //   v1：半径 22、强度 0.58 → 一半以上陆地被推到「河边湿地」，
        //       大陆看起来是同一片绿；
        //   v2：半径 16、强度 0.40 → 仍然把**降水中位数整体抬高 0.11**。
        //       这一条是这一轮才量出来的：气候阶段把降水中位数精确钉在
        //       0.37（MED_TARGET），可地图生成完之后实测中位数是 0.487 ——
        //       差额全部来自这一步。而河流网络的密度很高，「距河 ≤16 格」
        //       已经覆盖了大部分陆地，于是等价于给整个世界加了一档湿度：
        //       森林 58.8%、荒漠只剩 9.6%，副热带的沙漠带被抹掉。
        //   v3：半径 9、强度 0.30 → 只影响真正的河岸带（d=1 → 0.71，
        //       d=5 → 0.31，d=9 → 0.10），既保留「沿河绿洲」，又不改全局水位。
        //       绿洲该是**断续的带**，不是把整个大陆泡湿。
        c.m = clamp01(mBase + prox * 0.30 * (1 - mBase));
        c.precip = c.m;
        // 水体热惯性：把温度往 0.5（温和）拉一点，越近越明显
        c.temp = clamp01(tBase + (0.5 - tBase) * prox * 0.06);
        if (classify) c.biome = classify(c.temp, c.m, c.e, sea, false, c.tempSea);
      }
      // 重新分类之后必须再去一次碎斑：河流是树枝状网络，
      // 「沿河变湿」会在河网上切出一串细碎的群系小块。
      if (FM.despeckleBiomes) FM.despeckleBiomes(cells, W, H, 2);
      if (FM.mergeSmallBiomeBlocks) FM.mergeSmallBiomeBlocks(cells, W, H, Math.max(40, Math.round(N / 6000)), 2);
    }

    /**
     * 地形被编辑之后重算气候（温度 / 湿度 / 降水 / 群系）。
     *
     * 【为什么编辑后必须重算】群系标签是由气候阶段写进去的，而编辑器
     * 只改高度。不重算的后果既错又显眼：
     *   · 把海抬成陆 → 这些格子还挂着「深海 / 浅海」的群系，
     *     卫星图上就是一块蓝色的陆地（用户说的"板块非常混乱"里最扎眼的一种）；
     *   · 新造的山 → 还挂着「草原」，山顶不出现裸岩/雪地；
     *   · 沉下去的陆 → 群系还是「森林」，只是被水体标签盖掉了。
     * 湿度是沿风向输运出来的，局部补算没有意义，只能整图重跑。
     * 1600×800 实测约 2 s，编辑器把它放在延后刷新里跑。
     *
     * 调用顺序必须是「气候 → 水文 → 水体群系」，与 generate() 一致。
     */
    async recomputeClimate(onProgress = () => {}, yieldFn = yieldToUi) {
      const climate = new FM.ClimateSystem({
        width: this.width,
        height: this.height,
        cells: this.cells,
        seaLevel: this.seaLevel,
        noise: (nx, ny, f, o, p, l, off) => this.noiseSeamless(nx, ny, f, o, p, l, off),
      });
      await climate.solve(onProgress, yieldFn);
      this.climate = climate;
      return climate;
    }

    rebuildHydrology() {      const hydrology = new Hydrology({
        width: this.width,
        height: this.height,
        elevation: this.elevationArray(),
        seaLevel: this.seaLevel,
      }).solve();

      this.hydrology = hydrology;
      this.rivers = hydrology.rivers;
      this.lakes = hydrology.lakes;
      for (let i = 0; i < this.cells.length; i++) {
        const c = this.cells[i];
        c.isLake = hydrology.isLake[i] === 1;
        c.isRiver = hydrology.isRiver[i] === 1 && !c.isLake;
        c.flow = hydrology.flow[i];
        // 水体优先于植被：湖泊与深浅海覆盖原群系
        if (c.isLake) c.biome = '湖泊';
        else if (c.e < this.seaLevel) {
          const d = this.seaLevel - c.e;
          c.biome = d > 0.22 ? '深海' : d > 0.05 ? '海洋' : '浅海';
        }
      }
      this.applyWaterInfluence();
      return hydrology.metrics;
    }
  }

  FM.MapGenerator = MapGenerator;
})(window);
