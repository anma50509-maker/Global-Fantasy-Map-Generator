/**
 * terrain.js —— 地形高度场的计算内核（可在主线程与 Worker 中共用）
 *
 * 【为什么要单独成文件】
 * 地形构造是整张图最重的一步：128 万像素、每像素约 14 次球面噪声采样、
 * 合计 1700 万次 noiseSeamless 调用（约 6800 万次 3D 单纯形噪声）。
 * 单线程实测 9~11 秒，远大于气候（1~2 s）与水文（0.6 s）。
 *
 * 这一步是**逐像素独立**的：某个像素的高度只取决于它自己的 (x, y)、
 * 板块参数与噪声种子，与邻居无关。因此可以按行带切开，丢给多个
 * Web Worker 并行计算，结果与单线程逐位一致（同一 seed → 同一置换表）。
 *
 * 本文件只做纯计算，不碰 DOM；主线程与 worker 通过 FM.Terrain 共用：
 *   - computeBand()      计算一段行带，返回 Float32Array
 *   - computeElevation() 对外门面：优先并行，失败自动回退单线程
 *   - noiseSeamless()    球面 3D 噪声（MapGenerator 的同名方法委托到这里）
 */
(function (root) {
  'use strict';

  const FM = root.FM = root.FM || {};

  /**
   * 真·球面 3D 噪声映射：彻底解决两极贴图放射状拉伸问题。
   *
   * 三角函数在八度循环外只算一次：球面坐标 (cosLat·cosLon, sinLat,
   * cosLat·sinLon) 只取决于 (nx, ny)，与频率无关。
   */
  function noiseSeamless(simplex, nx, ny, baseFrequency, octaves = 5, persistence = 0.5, lacunarity = 2, offset = 0) {
    let total = 0;
    let frequency = baseFrequency;
    let amplitude = 1;
    let maxValue = 0;

    const lon = nx * Math.PI * 2;
    const lat = ny * Math.PI;
    const cosLat = Math.cos(lat);
    const sinLat = Math.sin(lat);
    const cosLon = Math.cos(lon);
    const sinLon = Math.sin(lon);

    for (let i = 0; i < octaves; i++) {
      const R = frequency / Math.PI;
      total += simplex.noise3D(
        cosLat * cosLon * R + offset,
        sinLat * R + offset,
        cosLat * sinLon * R + offset
      ) * amplitude;
      maxValue += amplitude;
      amplitude *= persistence;
      frequency *= lacunarity;
    }
    return total / maxValue;
  }

  /**
   * 计算地形高度的一段行带。
   *
   * 纯函数：同样的 (W, H, plates, seed, rowStart, rowEnd) 必然得到同样的
   * 浮点数组，因此可以安全地切分到多个线程，拼回来与单线程完全一致。
   *
   * @param {{W:number,H:number,plates:Array,simplex:object,
   *          rowStart:number,rowEnd:number,onRow?:function}} opts
   * @returns {Float32Array} 长度 (rowEnd-rowStart)*W
   */
  function computeBand(opts) {
    const W = opts.W;
    const H = opts.H;
    const plates = opts.plates;
    const simplex = opts.simplex;
    const rowStart = opts.rowStart;
    const rowEnd = opts.rowEnd;
    const onRow = opts.onRow;
    const out = new Float32Array((rowEnd - rowStart) * W);
    /** 每个像素到各板块的距离，复用以避免重复开方 */
    const plateDist = new Float64Array(plates.length);

    const noise = (nx, ny, f, o, p, l, k) => noiseSeamless(simplex, nx, ny, f, o, p, l, k);

    for (let y = rowStart; y < rowEnd; y++) {
        for (let x = 0; x < W; x++) {
          const nx = x / W;
          const ny = y / H - 0.5;

          // 域扭曲：两极地区让 Y 轴扭曲衰减为 0，避免极点放射状伪影
          const warp = 0.08;
          const poleFade = Math.cos(ny * Math.PI);
          let wnx = nx + (noise(nx, ny, 3, 3, 0.5, 2, 100) - 0.5) * warp;
          const wny = ny + (noise(nx, ny + 10, 3, 3, 0.5, 2, 200) - 0.5) * warp * poleFade;
          wnx = wnx % 1.0;
          if (wnx < 0) wnx += 1.0;

          // 球面坐标 → 3D 笛卡尔，用真实欧几里得距离做 Voronoi
          const lon = wnx * Math.PI * 2;
          const lat = wny * Math.PI;
          const p3x = Math.cos(lat) * Math.cos(lon);
          const p3y = Math.sin(lat);
          const p3z = Math.cos(lat) * Math.sin(lon);

          let minDist = 999;
          let secMinDist = 999;
          let closestPlate = null;
          let secondPlate = null;
          // 距离只算一次、存下来给后面的「反距离加权」复用。
          // 旧实现为了拿权重把 6 个板块的距离又算了一遍（含 sqrt 与幂运算），
          // 整图等于多做 770 万次开方。
          for (let pi = 0; pi < plates.length; pi++) {
            const plate = plates[pi];
            const ddx = p3x - plate.x3;
            const ddy = p3y - plate.y3;
            const ddz = p3z - plate.z3;
            const dist = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz) / 2.0;
            plateDist[pi] = dist;
            if (dist < minDist) {
              secMinDist = minDist;
              secondPlate = closestPlate;
              minDist = dist;
              closestPlate = plate;
            } else if (dist < secMinDist) {
              secMinDist = dist;
              secondPlate = plate;
            }
          }

          const edgeDist = secMinDist - minDist;

          const continentNoise = (noise(nx, ny, 1.5, 4, 0.5, 2, 0) + 1) / 2;
          const baseNoise = (noise(nx, ny, 3.5, 6, 0.5, 2, 50) + 1) / 2;
          const detailNoise = (noise(nx, ny, 10, 4, 0.5, 2, 150) + 1) / 2;
          // ================= 地貌细节 =================
          //
          // 【陨石坑感的成因】早期版本给整张图均匀叠加各向同性噪声，
          // 结果地表到处是随机的小凸起和小坑（局部极大值高达 10/千格，
          // 且平原地带比山区还崎岖），看起来像被陨石砸过。
          //
          // 【真实地貌规律】细节强度应当与"地形起伏程度"正相关：
          //   - 平原、盆地、海岸：平缓，几乎无细节；
          //   - 山地：有沿一定方向延展的山脊线、冲沟与碎石。
          //
          // 因此这里做两件事：
          //   1. 用 ridged noise（1-|n|）生成"山脊线"而非孤立圆包 ——
          //      脊线天然成条、成网，而不是一个个点；
          //   2. 用「已有高度」做掩膜，只在本来就高的地方叠加细节，
          //      平原保持平整。这样既去掉麻点感，又保住山地纹理。
          const preliminaryE = continentNoise * 0.62 + baseNoise * 0.28 + detailNoise * 0.10;

          // 山脊线：ridge 值只在 0 附近成脊，配合平方使之更纤细
          const ridgeA = 1 - Math.abs(noise(nx, ny, 16, 4, 0.55, 2, 210));
          const ridgeB = 1 - Math.abs(noise(nx, ny, 34, 3, 0.5, 2, 260));
          const ridge = Math.pow(ridgeA, 2) * 0.65 + Math.pow(ridgeB, 2) * 0.35;

          // 冲沟（valley）：与山脊互补的负向纹理，让山体有沟壑
          const groove = noise(nx, ny, 52, 3, 0.5, 2, 310);

          // 平原碎屑：极小幅度的随机起伏，只做质感不做造型
          const grain = noise(nx, ny, 140, 2, 0.5, 2, 360);

          // 高度掩膜：0（平地）→ 1（高山）。用 preliminaryE 判断，
          // 避开"先有鸡还是先有蛋"（此时还没有最终高度）。
          const elevMask = Math.max(0, Math.min(1, (preliminaryE - 0.42) / 0.30));
          const maskSq = elevMask * elevMask;

          const relief =
            ridge * 0.075 * maskSq +          // 山脊：只在高处
            groove * 0.012 * maskSq +         // 冲沟：只在高处
            grain * 0.004;                    // 碎石质感：全局极轻

          let e = preliminaryE + relief;

          // ================= 板块高度偏移 =================
          //
          // 【旧实现的致命问题】高度偏移取自板块类型的离散值：
          //   continental → +0.10，oceanic → -0.10
          // 并且只用「最近 + 次近」两个板块做加权混合。
          //
          // 后果：在板块「三点交汇处」（Voronoi 顶点），最近板块从 A 变成 B、
          // 次近板块同时从 B 变成 C，混合对从 (A,B) 突变成 (B,C)。
          // 由于偏移量是离散的 ±0.10，这一步会瞬间跳出 0.10 的高度差
          // —— 表现就是板块边缘一道极其生硬、1 格宽的高度台阶。
          //
          // 【新实现】两个关键改动：
          //   1. 每个板块在生成时分配一个「连续」的高度偏移
          //      （不是只有 ±0.1 两种值），彼此不同且幅度更小；
          //   2. 用「反距离加权」对全部板块混合，权重为 (1/d)^p 归一化。
          //      该函数在空间上处处连续 —— 无论走到几块板块的交汇点，
          //      结果都是光滑过渡，不存在配对突变。
          //      p 取较大值（6）使其在远离边界时近似 Voronoi 分区，
          //      既保留了"板块内部高度统一"的地貌特征，又彻底消除台阶。
          let wsum = 0;
          let acc = 0;
          const P = 6;
          for (let pi = 0; pi < plates.length; pi++) {
            const dd = Math.max(1e-4, plateDist[pi]);
            const w = 1 / Math.pow(dd, P);
            wsum += w;
            acc += w * plates[pi].heightOffset;
          }
          e += acc / wsum;

          // ================= 板块接缝处的造山运动 =================
          //
          // 【两代旧实现的共同症结】
          //   第一代：collisionIntensity = smoothstep(1 - d/W)，沿整条接缝均匀，
          //           得到一条"宽度恒定、高度均匀"的光滑鼓包带 —— 光滑但突兀；
          //   第二代：加了噪声，但开关仍然是 "d < halfWidth"，
          //           于是沿整条 Voronoi 边界生成一圈连续的环形山脊 —— 更突兀。
          //
          // 【物理事实】造山只发生在板块碰撞的局部段落，不是整条边界。
          // 因此这一版引入两个真正决定"是否成山"的开关：
          //   a. 碰撞段掩码：用大尺度噪声把接缝切成"碰撞段 / 平静段"，
          //      只有碰撞段才可能隆起，其余段落几乎没有垂直运动；
          //   b. 山脉起伏包络：碰撞段内部再用中尺度噪声决定主峰与垭口，
          //      形成成串的山峰而不是均匀墙体；
          // 再叠加 ridged noise 生成山脊纹理，让表面分形细节真实。
          const seamDistRaw = Math.abs(edgeDist);

          if (seamDistRaw < 0.16) {
            // a. 碰撞段掩码：沿接缝走向的"哪里在碰撞"（0~1，低于阈值即平静）
            const collideZone = noise(nx, ny, 2.4, 3, 0.55, 2, 1700) * 0.5 + 0.5;
            //   尖峰化：只有较强区域的才明显成山，弱区域快速归零
            const collideMask = Math.max(0, (collideZone - 0.52) / 0.48);
            const collideMaskSq = collideMask * collideMask;

            if (collideMaskSq > 0.001) {
              // b. 山脉起伏包络：碰撞段内部的主峰/垭口
              const rangeEnv = noise(nx, ny, 6.5, 3, 0.55, 2, 1900) * 0.5 + 0.5;
              const envSharp = Math.pow(rangeEnv, 1.7);

              // c. 山脊纹理：ridged noise，形成锐利山脊与沟谷
              //
              // 【重要】频率必须通过 baseFrequency 控制，不能写成 nx * k / ny * k。
              // noiseSeamless 内部是球面映射：lon = nx*2π（nx∈[0,1]）、
              // lat = ny*π（ny∈[-0.5,0.5]）。把坐标整体乘 k 会让经度跨越
              // k 整圈 —— 一是接缝处不再连续（产生断裂），二是经度方向
              // 频率被额外放大，导致噪声纹理在 X 方向被拉长，
              // 山脉因此看起来"横向拉伸"。
              const ridgeN = noise(nx, ny, 70, 5, 0.55, 2, 1100);
              const ridge = Math.pow(1 - Math.abs(ridgeN), 1.6);
              const rough = noise(nx, ny, 238, 3, 0.5, 2, 1300) * 0.5 + 0.5;

              // 中心线摆动 + 宽度变化
              const wander = noise(nx, ny, 5.5, 3, 0.5, 2, 610);
              const halfWidth = 0.070 + (noise(nx, ny, 2.9, 2, 0.5, 2, 1500) * 0.5 + 0.5) * 0.050;
              const seamDist = Math.max(0, seamDistRaw + wander * 0.030);

              if (seamDist < halfWidth) {
                let u = 1 - seamDist / halfWidth;
                const profile = u * u * (3 - 2 * u);
                const core = Math.pow(u, 2.4);

                const contCont = closestPlate.type === 'continental' && secondPlate.type === 'continental';
                const oceanOcean = closestPlate.type === 'oceanic' && secondPlate.type === 'oceanic';

                // 通用的"是否成山"权重：碰撞段 × 起伏包络
                const mountainW = collideMaskSq * envSharp;

                if (contCont) {
                  // 陆陆碰撞：只有 mountainW 高的地方才有山脉，其余几乎平坦。
                  //
                  // 这里同时引入「大山脉系统」：用一组更大尺度的噪声选出
                  // 少数几条主山脉带，给予显著的高程加成。
                  // 真实大陆的山脉是成串、成带的高耸山系（如喜马拉雅、
                  // 安第斯），而不是整片均匀抬升 —— 只有这样才能出现
                  // 真正的高山与雪线，同时平原保持平坦。
                  const beltN = noise(nx, ny, 3.2, 3, 0.55, 2, 2100) * 0.5 + 0.5;
                  // 只在 beltN 较高的区域形成主山系（约 25% 的碰撞段）
                  // 阈值 0.50（原 0.58）让主山系覆盖更广，保证每张图都有
                  // 足够多的高峰能越过雪线阈值，而不是靠运气。
                  const beltMask = Math.max(0, (beltN - 0.50) / 0.50);
                  const beltMaskSq = beltMask * beltMask;
                  // 主山系的高程加成（显著大于普通碰撞隆起）
                  const beltBoost = beltMaskSq * (0.55 + ridge * 0.9);
                  const strength = mountainW * (0.35 + ridge * 0.9) * (0.65 + rough * 0.7);
                  e += profile * core * (strength * 0.55 + beltBoost * 1.25);
                } else if (oceanOcean) {
                  // 洋洋碰撞：海沟也只在碰撞段出现，避免整圈深色槽
                  const strength = collideMaskSq * (0.45 + ridge * 0.55);
                  e -= profile * core * strength * 0.10;
                } else {
                  // 海陆交界：俯冲带。基础下沉始终存在，岛弧只在碰撞段冒头
                  e -= profile * (0.012 + collideMaskSq * 0.035);
                  if (mountainW > 0.02) {
                    e += profile * core * mountainW * (0.4 + ridge * 0.9) * 0.55;
                  }
                }
              }
            }
          }

          // 高度必须允许取负值，否则所有海底都会被压成 0，
          // 形成一块巨大的"平底海床"，与陆地拼在一起时出现整条断崖。
          // 这里用软压缩把范围映射到 [-0.35, 1] 左右：
          //   e > 0 : 平方根式轻微抬高细节
          //   e < 0 : 同样压缩，保证海沟是连续的斜坡而不是断崖
          // 只做「软限幅」，不再做幂次压缩。
          // 旧代码的 e**1.05 + 顶部 ×0.35 压缩会把峰顶狠狠削平，
          // 导致最终陆地相对高度最高只有 0.69，雪线（0.90）永远达不到。
          // 真正的动态范围调整放到后面「按分位重标定」阶段统一处理。
          if (e > 1.0) e = 1.0 + (e - 1.0) * 0.25;
          if (e < -0.35) e = -0.35 + (e + 0.35) * 0.4;
          out[(y - rowStart) * W + x] = e;
        }

      if (onRow) onRow(y);
    }

    return out;
  }

  // ==================== 并行调度 ====================

  /** 复用的 Worker 池（跨多次生成保留，省掉每次 50~100 ms 的启动开销） */
  let pool = null;
  let poolFailed = false;
  /** 最近一次计算的实际执行方式，供界面显示 / 调试 */
  let lastMode = 'inline';
  let lastThreads = 1;

  function canUseWorkers() {
    if (poolFailed) return false;
    if (typeof Worker === 'undefined') return false;
    // 开发模式按路径加载 worker 脚本，file:// 下必然失败，直接回退单线程。
    // 但构建产物（build.js）会把 worker 源码内联成 Blob，此时 file:// 也
    // 有机会跑起来（各浏览器策略不同），所以交给下面的 try/catch 去试。
    const hasInline = typeof root.__FM_WORKER_SRC__ === 'string' && root.__FM_WORKER_SRC__.length > 0;
    if (!hasInline && typeof location !== 'undefined' && location.protocol === 'file:') {
      poolFailed = true;
      return false;
    }
    return true;
  }

  /** 内联 Worker 的 Blob URL（构建产物用；开发模式下为 null） */
  let inlineWorkerUrl = null;

  function workerSpecifier() {
    const src = root.__FM_WORKER_SRC__;
    if (typeof src === 'string' && src.length > 0 && typeof Blob !== 'undefined' && typeof URL !== 'undefined') {
      if (!inlineWorkerUrl) {
        inlineWorkerUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      }
      return inlineWorkerUrl;
    }
    return 'js/terrain-worker.js';
  }

  function getPool() {
    if (pool) return pool;
    if (!canUseWorkers()) return null;
    const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
    const size = Math.max(1, Math.min(8, cores));
    if (size < 2) return null;
    try {
      const workers = [];
      for (let i = 0; i < size; i++) {
        workers.push(new Worker(workerSpecifier()));
      }
      pool = { workers, size };
      return pool;
    } catch (err) {
      console.warn('[terrain] Worker 不可用，回退单线程：', err && err.message);
      poolFailed = true;
      return null;
    }
  }

  function disposePool() {
    if (!pool) return;
    for (const w of pool.workers) {
      try { w.terminate(); } catch (e) { /* 忽略 */ }
    }
    pool = null;
    poolFailed = true;
  }

  function runPool(p, params, onProgress) {
    const { W, H, plates, seed } = params;
    const size = p.size;
    const bandRows = Math.ceil(H / size);
    const parts = new Array(size);
    let done = 0;

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      for (let i = 0; i < size; i++) {
        const worker = p.workers[i];
        const rowStart = i * bandRows;
        const rowEnd = Math.min(H, rowStart + bandRows);
        if (rowStart >= rowEnd) {
          parts[i] = new Float32Array(0);
          done++;
          continue;
        }
        worker.onmessage = (e) => {
          if (settled) return;
          if (e.data && e.data.error) {
            fail(new Error(e.data.error));
            return;
          }
          parts[i] = new Float32Array(e.data.buffer);
          done++;
          if (onProgress) onProgress(done / size);
          if (done === size) {
            settled = true;
            resolve(parts);
          }
        };
        worker.onerror = (err) => fail(err && err.message ? err.message : 'worker error');
        worker.postMessage({ W, H, plates, seed, rowStart, rowEnd });
      }
      if (done === size) {
        settled = true;
        resolve(parts);
      }
    });
  }

  /** 单线程兜底：按行带分块计算，每块之间让出主线程刷新进度 */
  async function computeInline(params, onProgress) {
    const { W, H, plates, seed } = params;
    const eArray = new Float32Array(W * H);
    const simplex = new root.SimplexNoise(seed);
    const CHUNK = 64;
    for (let r0 = 0; r0 < H; r0 += CHUNK) {
      const r1 = Math.min(H, r0 + CHUNK);
      const band = computeBand({ W, H, plates, simplex, rowStart: r0, rowEnd: r1 });
      eArray.set(band, r0 * W);
      if (onProgress) onProgress(r1 / H);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return eArray;
  }

  /**
   * 计算整张地形高度场：优先多线程，任何异常都回退单线程。
   * @returns {Promise<Float32Array>} 长度 W*H
   */
  async function computeElevation(params, onProgress) {
    const { W, H } = params;
    const p = getPool();
    if (p) {
      try {
        const parts = await runPool(p, params, onProgress);
        const eArray = new Float32Array(W * H);
        let offset = 0;
        for (const part of parts) {
          eArray.set(part, offset);
          offset += part.length;
        }
        if (offset !== W * H) throw new Error('行带拼接长度不符');
        lastMode = 'worker';
        lastThreads = p.size;
        return eArray;
      } catch (err) {
        console.warn('[terrain] 并行计算失败，回退单线程：', err && err.message);
        disposePool();
      }
    }
    lastMode = 'inline';
    lastThreads = 1;
    return computeInline(params, onProgress);
  }

  FM.Terrain = {
    noiseSeamless,
    computeBand,
    computeElevation,
    /** 最近一次地形计算走的路径（worker / inline）与线程数 */
    lastRun: () => ({ mode: lastMode, threads: lastThreads }),
  };
})(typeof window !== 'undefined' ? window : self);
