/**
 * toponymy.js —— 地名引擎（"手绘地名图"的数据源）
 *
 * 【这个模块解决什么问题】
 * "手绘地名图"需要在底图上写地名，而地名不是随手撒的字：
 * 它必须先理解地形 —— 哪块是大陆、哪片是洋、山脉朝哪个方向走、
 * 河流从哪流到哪、沙漠森林成片在哪。这些几何信息只有拿到
 * generator 的整张数据网格才能算出来；算完之后，渲染层
 * （renderer.js 的 named 视图）和 3D 球体（globe.js 的地名精灵）
 * 都只是把同一份标签画出来而已。
 *
 * 所以本模块只做一件事：**从 generator 提取特征 → 起中文幻想地名 →
 * 在二维数据坐标上做避让布局**，输出纯数据的标签表，完全不碰 DOM。
 *
 * 【为什么独立成文件而不是塞进 renderer】
 *   1. 特征提取（连通域 / 块聚合 / 群系斑块）与"画画"是两套东西，
 *      renderer.js 已经两千多行，再塞进来没人看得懂；
 *   2. 2D 与 3D 必须共用同一套地名，不能两边各算一套（名字会打架）；
 *   3. 不依赖 DOM，就能在 Node 里用合成地形验证（tools/verify-toponymy.js）。
 *
 * 【确定性：同一张图必须永远得到同一套地名】
 * 用户重新打开页面、切换显示模式、导出 PNG、进 3D 再回 2D，
 * 看到的必须是同一批名字。因此随机源由 generator.seed 派生
 * （FNV-1a 字符串哈希 + xorshift32），绝不使用 Math.random；
 * 同一次构建里的遍历顺序也全部是"数组下标从小到大"的稳定顺序。
 *
 * 【坐标约定】
 * 全是**数据坐标像素**：等距圆柱网格，x ∈ [0, W)、y ∈ [0, H)，
 * 格子 (x, y) 的中心记作 (x + 0.5, y + 0.5)。投影由渲染层自己套。
 * x 方向是环绕的（左右接壤），y 方向不环绕（上下是极点）。
 *
 * 【输出契约】（renderer 与 globe 都按这个消费，改动会破坏两边）
 *   FM.Toponymy.build(generator, opts?) -> { worldName, labels: Label[] }
 *   Label = {
 *     text: string,      // 含通名的完整地名，如 "艾瑟兰大陆"
 *     name: string,      // 去掉通名的专名，如 "艾瑟兰"
 *     kind: 'continent'|'ocean'|'sea'|'mountain'|'peak'|'desert'|'forest'|'river'|'lake'|'island',
 *     x, y: number,      // 数据坐标像素，x ∈ [0,W)，y ∈ [size, H-size]
 *     size: number,      // 建议字号（1600x800 画布像素；小网格会按宽度等比缩小）
 *     rotate: number,    // 弧度，水平 = 0
 *     importance: 1..5,  // 5 最重要（大陆 / 大洋）
 *     curve: null | { x0,y0,x1,y1,x2,y2 },  // 二次贝塞尔，供弧形排字
 *     path: null | number[]                 // 河流折线（上游→下游），仅 river 用
 *   }
 *
 * 【布局 bbox 公式】（tools/verify-toponymy.js 用同一套公式判重叠）
 *   直线：宽 = 字数 x size x 1.02，高 = size x 1.35，按 rotate 取旋转外接框；
 *   弧线：沿二次贝塞尔取 9 个采样点，包围盒再各向外扩 size x 0.6 / 0.9。
 *   矩形间留 8px padding，x 方向按环绕距离比较。
 */
(function (root) {
  'use strict';

  const FM = root.FM = root.FM || {};
  const VERSION = '1.0.0';

  const TAU = Math.PI * 2;
  /** 布局：两个标签矩形之间至少留出的空白（画布像素） */
  const PADDING = 8;
  /** 每个标签最多试探的候选位置数（螺旋试探） */
  const MAX_ATTEMPTS = 40;
  /** 一座山脉最多带几个山峰标签 */
  const MAX_PEAKS = 4;

  // ==================== 通用小工具 ====================

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  /** x 方向环绕：任何实数都折回 [0, W) */
  function wrapX(x, W) {
    const v = x % W;
    return v < 0 ? v + W : v;
  }

  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();
  }

  /**
   * 确定性伪随机（FNV-1a 哈希 + xorshift32）。
   *
   * 【为什么不用 Math.random】同一张地图刷新一次就换一批地名，用户会觉得
   * "刚才那个世界没了"。种子来自 generator.seed（地图本身的种子），
   * 于是只要地图一样，地名就完全一样。
   */
  function makeRng(seedStr) {
    let h = 2166136261 >>> 0;
    const s = String(seedStr == null ? '' : seedStr);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
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

  // ==================== 中文幻想地名字表 ====================
  //
  // 【设计原则】"像地名"而不是"随机字堆"。中文地名的语感来自
  // "一个响亮的音节 + 一个地理通名"，所以：
  //   · 首字只用发音清楚、字形好看的常用字（苍霜岚银赤墨…）；
  //   · 尾字用能"落地"的字（兰/尔/德/斯/恩/汀…），多字尾（瑞斯/海姆…）
  //     让名字有异域感但仍是常用字，渲染字体回退不会出现方块；
  //   · 山脉/沙漠/森林各自用专属后缀字（脊/崖/砾/旱/藤/幽），
  //     这样一听就知道是山还是沙，且同一种地貌的名字风格统一。
  const HEAD_CHARS = ('苍霜岚银赤墨星雾岩风潮烬檀璇澜穹祁曜瑟弥维诺厄洛萨泰伊安赫格' +
    '艾塞卡塔希奥莫奈修珂').split('');
  const TAIL_CHARS = '兰尔德斯恩汀娅诺瓦格洛瑞弥尔拉隆塞那林黎琳瑟塔朵丝'.split('');
  const TAIL_LONG = ['瑞斯', '里斯', '海姆', '加德', '维尔', '提斯', '瑟兰', '瑞恩', '兰德', '洛尔'];
  const MID_CHARS = '艾瑟伊尔拉洛瑞恩弥维卡塞阿丝塔德'.split('');
  /** 山脉专名的"地貌尾字"：雾脊山脉 / 霜崖山脉 / 岚岭山脉 */
  const RIDGE_CHARS = '脊崖岭坡岩峦'.split('');
  /** 荒漠专名的尾字：赤砾沙漠 / 星旱大漠 */
  const DUNE_CHARS = '砾旱荒燥砂'.split('');
  /** 森林专名的尾字：雾幽森林 / 银藤密林 */
  const WOOD_CHARS = '林森木藤叶幽'.split('');

  /**
   * 水域意译词库。
   * 水名不适合用"首字+尾字"硬拼（会拼出"苍尔海"这种不像水的词），
   * 直接用两字意境词，再接 洋/海/湾。全部常用字。
   */
  const WATER_NAMES = [
    '沧澜', '幽渊', '碧潮', '星汐', '霜潮', '无垠', '苍梧', '岚烟',
    '澄光', '沉璧', '银溟', '寒澈', '青漓', '琉璃', '琥珀', '微茫',
    '长风', '暮云', '空明', '云梦', '浩渺', '白露', '汐月', '苍溟',
  ];

  /** 各类要素的通名（后缀）表 */
  const SUFFIX = {
    continent: ['大陆'],
    island: ['岛'],
    ocean: ['洋'],
    sea: ['海'],
    mountain: ['山脉', '山岭', '群峰', '山地'],
    peak: ['峰'],
    desert: ['沙漠', '荒漠', '大漠'],
    forest: ['森林', '密林', '林海'],
    river: ['河', '江', '川'],
    lake: ['湖', '泽'],
  };

  /**
   * 名字工厂：负责"起名 + 全局去重"。
   * 同一个世界里不允许出现两个"艾瑟兰"，通名后的完整地名也一并去重。
   */
  function createNamer(rng) {
    const used = new Set();
    const rand = (n) => (rng() * n) | 0;
    const pick = (arr) => arr[rand(arr.length)];

    /** 2~4 字幻想专名（通用模板） */
    function makeName() {
      for (let guard = 0; guard < 80; guard++) {
        const a = pick(HEAD_CHARS);
        const roll = rng();
        let name;
        if (roll < 0.46) {
          const t = pick(TAIL_CHARS);
          if (t === a) continue;                 // 苍苍、诺诺 这类叠字要跳过
          name = a + t;
        } else if (roll < 0.74) {
          name = a + pick(TAIL_LONG);            // 苍提斯 / 星海姆（4 字）
        } else {
          const m = pick(MID_CHARS);
          const t = pick(TAIL_CHARS);
          if (m === a || t === a || t === m) continue;
          name = a + m + t;                      // 艾瑟兰（3 字）
        }
        if (!used.has(name)) {
          used.add(name);
          return name;
        }
      }
      // 兜底：按字表顺序找第一个没被占用的两字组合（保证不会死循环）
      for (let i = 0; i < HEAD_CHARS.length; i++) {
        const a = HEAD_CHARS[i];
        for (let j = 0; j < TAIL_CHARS.length; j++) {
          const t = TAIL_CHARS[j];
          if (t === a) continue;
          const name = a + t;
          if (!used.has(name)) {
            used.add(name);
            return name;
          }
        }
      }
      return '无名';
    }

    /** 带地形味的两字专名（山脉 / 荒漠 / 森林 / 峰） */
    function makeTopoName(chars) {
      for (let guard = 0; guard < 60; guard++) {
        const name = pick(HEAD_CHARS) + pick(chars);
        if (!used.has(name)) {
          used.add(name);
          return name;
        }
      }
      return makeName();
    }

    /** 水域专名：优先用意境词库，词库用尽后退化为普通专名 */
    function makeWaterName() {
      for (let guard = 0; guard < 80; guard++) {
        const name = pick(WATER_NAMES);
        if (!used.has(name)) {
          used.add(name);
          return name;
        }
      }
      return makeName();
    }

    /**
     * 生成一个完整地名。
     * @param {string} kind 要素类型
     * @param {string|number} [variant] 变体提示：大陆第一块用"大陆"、
     *   大岛用"群岛"、海用"海/湾"等
     */
    function labelFor(kind, variant) {
      let name;
      if (kind === 'mountain' || kind === 'peak') name = makeTopoName(RIDGE_CHARS);
      else if (kind === 'desert') name = makeTopoName(DUNE_CHARS);
      else if (kind === 'forest') name = makeTopoName(WOOD_CHARS);
      else if (kind === 'ocean' || kind === 'sea') name = makeWaterName();
      else name = makeName();

      let suffix;
      if (kind === 'continent') {
        suffix = variant === 0 ? '大陆' : '洲';
      } else if (kind === 'island') {
        suffix = variant === 'big' ? (rng() < 0.4 ? '群岛' : '岛') : '岛';
      } else if (kind === 'sea') {
        suffix = rng() < 0.75 ? '海' : '湾';
      } else {
        const list = SUFFIX[kind] || [''];
        suffix = pick(list);
      }
      return { name, text: name + suffix };
    }

    /** 世界名：3 字专名 + 世界/界/之境（如"艾瑟兰世界"） */
    function worldName() {
      for (let guard = 0; guard < 60; guard++) {
        const name = pick(HEAD_CHARS) + pick(MID_CHARS) + pick(TAIL_CHARS);
        if (used.has(name)) continue;
        used.add(name);
        return name + pick(['世界', '界', '之境']);
      }
      return '无名世界';
    }

    return { labelFor, worldName };
  }

  // ==================== 布局几何 ====================

  /** 二次贝塞尔求点 */
  function bezierPoint(curve, t) {
    const u = 1 - t;
    return {
      x: u * u * curve.x0 + 2 * u * t * curve.x1 + t * t * curve.x2,
      y: u * u * curve.y0 + 2 * u * t * curve.y1 + t * t * curve.y2,
    };
  }

  /**
   * 估算标签的轴对齐包围盒。
   * 与 tools/verify-toponymy.js 里的公式必须保持一致（重叠判据就靠它）。
   * @returns {{cx:number, cy:number, w:number, h:number}|null}
   */
  function measureExtent(text, size, rotate, curve, x, y) {
    if (curve) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let k = 0; k <= 8; k++) {
        const p = bezierPoint(curve, k / 8);
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
      // 弧形文字是"逐字居中压在贝塞尔路径上"的：字形会向路径两侧各伸出约
      // 半个字宽/字高，所以包围盒要在采样盒基础上加一整个字宽与字高，
      // 否则两条弧形标签在竖直方向上可能贴得太近。
      return {
        cx: (minX + maxX) / 2,
        cy: (minY + maxY) / 2,
        w: (maxX - minX) + size * 1.02,
        h: (maxY - minY) + size * 1.35,
      };
    }
    const w0 = text.length * size * 1.02;
    const h0 = size * 1.35;
    const c = Math.abs(Math.cos(rotate));
    const s = Math.abs(Math.sin(rotate));
    return {
      cx: x,
      cy: y,
      w: w0 * c + h0 * s,
      h: w0 * s + h0 * c,
    };
  }

  /** 两个矩形是否冲突（x 方向按环绕距离；pad 为额外留白） */
  function hitsPlaced(ext, placed, W, pad) {
    for (let i = 0; i < placed.length; i++) {
      const p = placed[i];
      let dx = ext.cx - p.cx;
      dx = ((dx % W) + W) % W;
      if (dx > W / 2) dx -= W;
      const dy = ext.cy - p.cy;
      if (Math.abs(dx) < (ext.w + p.w) / 2 + pad &&
          Math.abs(dy) < (ext.h + p.h) / 2 + pad) {
        return true;
      }
    }
    return false;
  }

  // ==================== 主入口 ====================

  /**
   * 从 generator 构建地名表。
   *
   * @param {object} generator
   *   { width, height, seaLevel, seed, cells, rivers, lakes }
   *   cells[i] = { e, biome, isLake, ... }（其余字段用不到）
   * @param {object} [options]
   *   padding     标签间留白，默认 8
   *   maxAttempts 每个标签的螺旋试探次数，默认 40
   * @returns {{worldName:string, labels:Array}}
   */
  function build(generator, options) {
    const t0 = nowMs();
    const g = generator || {};
    const opts = options || {};

    const W = Math.max(0, Math.floor(Number(g.width) || 0));
    const H = Math.max(0, Math.floor(Number(g.height) || 0));
    const cells = g.cells;
    const seed = g.seed != null ? String(g.seed) : 'fm-world';

    const rng = makeRng(seed + '|toponymy');
    const namer = createNamer(rng);

    /** 结果先在开头建好：即使输入不完整也能返回合法的空表 */
    const result = { worldName: namer.worldName(), labels: [] };

    if (!W || !H || !cells || !cells.length) return result;

    // cells 长度和 W*H 对不上时，只分析能拼成整行的部分（不抛错）
    const rows = Math.min(H, Math.floor(cells.length / W));
    if (rows < 8) return result;

    const n = W * rows;
    const seaRaw = Number(g.seaLevel);
    const sea = Number.isFinite(seaRaw) ? clamp(seaRaw, 0.01, 0.99) : 0.55;
    const den = Math.max(1e-6, 1 - sea);

    // 字号按画布宽度等比缩放：契约里的 34~44 是 1600 宽画布的值，
    // 640 宽的合成网格如果照搬 44px，标签会占满整块陆地、全部互相冲突。
    const sizeScale = clamp(W / 1600, 0.5, 1);
    const pad = Number.isFinite(opts.padding) ? opts.padding : PADDING;
    const maxAttempts = Math.max(1, Math.min(200,
      Number.isFinite(opts.maxAttempts) ? opts.maxAttempts : MAX_ATTEMPTS));

    // ==================== 1. 一次遍历：掩码 + 块统计 ====================
    //
    // 所有后续步骤都基于这几张 TypedArray，而不是反复访问 cells 对象。
    // 1.28M 格上逐格读对象字段是最大的一笔开销，所以尽量只扫一遍。
    const B = W >= 320 ? 16 : 8;                 // 山脉聚合块边长
    const bw = Math.ceil(W / B);
    const bh = Math.ceil(rows / B);
    const nb = bw * bh;

    const land = new Uint8Array(n);              // 1 = 陆地（含湖泊，保持大陆连通）
    const water = new Uint8Array(n);             // 1 = 海洋（不含湖泊）
    const lakeMask = new Uint8Array(n);
    const desertMask = new Uint8Array(n);
    const forestMask = new Uint8Array(n);
    const blkSum = new Float64Array(nb);         // 块内相对高度之和
    const blkLand = new Int32Array(nb);          // 块内陆地格数
    const blkElev = new Int32Array(nb);          // 块内参与高度统计的格数（不含湖）
    const blkCellCount = new Int32Array(nb);     // 块内总格数（边缘块小于 B*B）
    const blkMaxRel = new Float64Array(nb).fill(-1);
    const blkMaxIdx = new Int32Array(nb).fill(-1);

    let landCount = 0;
    let desertCount = 0;
    let forestCount = 0;
    // 群系字符串分类结果按"上一次所见"缓存。
    // cells 是行主序的，同一片群系在内存里是连续的一大段，所以 128 万格里
    // 绝大多数 indexOf 都会被缓存命中，真正做字符串查找的只有几十次。
    let lastBiome = null;
    let lastBiomeClass = 0;                      // 0 其它 | 1 荒漠 | 2 森林
    for (let by = 0; by < bh; by++) {
      const y0 = by * B;
      const y1 = Math.min(rows, y0 + B);
      for (let bx = 0; bx < bw; bx++) {
        const x0 = bx * B;
        const x1 = Math.min(W, x0 + B);
        const bi = by * bw + bx;
        blkCellCount[bi] = (y1 - y0) * (x1 - x0);
        // 块级统计先攒在局部变量里，最后一次性写回 TypedArray：
        // 逐格对 blkLand[bi]++ 这种"读-改-写"在 128 万格上很贵。
        let blkLandN = 0;
        let blkElevN = 0;
        let blkSumV = 0;
        let blkMax = -1;
        let blkMaxI = -1;
        for (let y = y0; y < y1; y++) {
          const rowBase = y * W;
          for (let x = x0; x < x1; x++) {
            const i = rowBase + x;
            const c = cells[i];
            if (!c) {
              water[i] = 1;
              continue;
            }
            const e = c.e;
            const isLakeCell = c.isLake === true;
            const eOk = typeof e === 'number' && e === e;      // NaN 视为海
            const isLand = isLakeCell || (eOk && e >= sea);
            if (!isLand) {
              water[i] = 1;
              continue;
            }
            land[i] = 1;
            landCount++;
            blkLandN++;
            if (isLakeCell) {
              lakeMask[i] = 1;
            } else if (eOk) {
              let rel = (e - sea) / den;
              if (rel < 0) rel = 0;
              else if (rel > 1) rel = 1;
              blkSumV += rel;
              blkElevN++;
              if (rel > blkMax) {
                blkMax = rel;
                blkMaxI = i;
              }
            }
            const bm = c.biome;
            if (bm !== lastBiome) {
              lastBiome = bm;
              lastBiomeClass = 0;
              if (typeof bm === 'string') {
                if (bm.indexOf('沙漠') >= 0 || bm.indexOf('荒漠') >= 0) lastBiomeClass = 1;
                else if (bm.indexOf('林') >= 0) lastBiomeClass = 2;
              }
            }
            if (lastBiomeClass === 1) {
              desertMask[i] = 1;
              desertCount++;
            } else if (lastBiomeClass === 2) {
              forestMask[i] = 1;
              forestCount++;
            }
          }
        }
        blkLand[bi] = blkLandN;
        blkElev[bi] = blkElevN;
        blkSum[bi] = blkSumV;
        blkMaxRel[bi] = blkMax;
        blkMaxIdx[bi] = blkMaxI;
      }
    }

    // 环绕方向的 cos/sin 表（求连通域质心用）。
    // 逐格 Math.cos 在 128 万格上是几十毫秒的开销，查表几乎免费。
    const COS = new Float64Array(W);
    const SIN = new Float64Array(W);
    for (let x = 0; x < W; x++) {
      const a = ((x + 0.5) / W) * TAU;
      COS[x] = Math.cos(a);
      SIN[x] = Math.sin(a);
    }

    const DY8 = [-1, -1, -1, 0, 0, 1, 1, 1];
    const DX8 = [-1, 0, 1, -1, 1, -1, 0, 1];
    const scratch = new Int32Array(n).fill(-1);
    const stack = new Int32Array(n);
    // 左右邻居的列索引查表：把"逐邻居取模/三元判断"降成一次数组读取。
    // 8 邻接在 128 万格上要跑上千万次，这里是整个模块最热的循环。
    const xL = new Int32Array(W);
    const xR = new Int32Array(W);
    for (let x = 0; x < W; x++) {
      xL[x] = x === 0 ? W - 1 : x - 1;
      xR[x] = x === W - 1 ? 0 : x + 1;
    }

    /**
     * 8 邻接连通域标注（x 方向环绕）。
     *
     * 【为什么用显式栈而不是递归】128 万格的大陆连成一片时递归会爆栈；
     * 【为什么不用 union-find】BFS 一边扫一边就能累计面积/质心/极值，
     * 这些恰好是后面挑"最大几块"所需的全部信息。
     *
     * @param {Uint8Array} mask 1 表示属于待标注集合
     * @param {Int32Array} idArr 输出：连通域 id，-1 表示不属于
     * @param {boolean} [measure] 是否统计质心/面积（群系小块也要）
     */
    function labelComponents(mask, idArr, measure) {
      const comps = [];
      let nextId = 0;
      for (let y = 0; y < rows; y++) {
        const rowBase = y * W;
        for (let x = 0; x < W; x++) {
          const s = rowBase + x;
          if (!mask[s] || idArr[s] >= 0) continue;
          const id = nextId++;
          let sp = 0;
          stack[sp++] = s;
          idArr[s] = id;
          let area = 0;
          let sumCos = 0;
          let sumSin = 0;
          let sumY = 0;
          let minY = rows;
          let maxY = -1;
          while (sp > 0) {
            const i = stack[--sp];
            const iy = (i / W) | 0;
            const ix = i - iy * W;
            area++;
            sumCos += COS[ix];
            sumSin += SIN[ix];
            sumY += iy;
            if (iy < minY) minY = iy;
            if (iy > maxY) maxY = iy;
            // 手写的 8 邻域（不查方向表、不取模）：
            // 左右先查 xL/xR，上下三格用行基址加减，热循环里省掉大量分支。
            const rowBase = iy * W;
            const lx = xL[ix];
            const rx = xR[ix];
            let j = rowBase + lx;
            if (mask[j] && idArr[j] < 0) {
              idArr[j] = id;
              stack[sp++] = j;
            }
            j = rowBase + rx;
            if (mask[j] && idArr[j] < 0) {
              idArr[j] = id;
              stack[sp++] = j;
            }
            if (iy > 0) {
              const up = rowBase - W;
              j = up + ix;
              if (mask[j] && idArr[j] < 0) {
                idArr[j] = id;
                stack[sp++] = j;
              }
              j = up + lx;
              if (mask[j] && idArr[j] < 0) {
                idArr[j] = id;
                stack[sp++] = j;
              }
              j = up + rx;
              if (mask[j] && idArr[j] < 0) {
                idArr[j] = id;
                stack[sp++] = j;
              }
            }
            if (iy < rows - 1) {
              const down = rowBase + W;
              j = down + ix;
              if (mask[j] && idArr[j] < 0) {
                idArr[j] = id;
                stack[sp++] = j;
              }
              j = down + lx;
              if (mask[j] && idArr[j] < 0) {
                idArr[j] = id;
                stack[sp++] = j;
              }
              j = down + rx;
              if (mask[j] && idArr[j] < 0) {
                idArr[j] = id;
                stack[sp++] = j;
              }
            }
          }
          if (measure) {
            const ang = Math.atan2(sumSin, sumCos);
            comps.push({
              id,
              area,
              // 环绕方向上的质心：用圆周均值，跨经线的大陆也不会算到地图另一边
              cx: ((ang < 0 ? ang + TAU : ang) / TAU) * W,
              cy: sumY / area,
              minY,
              maxY,
            });
          }
        }
      }
      return comps;
    }

    /** 5x5 窗口内 mask 为 1 的格数（x 环绕、y 截断） */
    function windowCount(mask, ix, iy, half) {
      let count = 0;
      for (let dy = -half; dy <= half; dy++) {
        const y = iy + dy;
        if (y < 0 || y >= rows) continue;
        const base = y * W;
        for (let dx = -half; dx <= half; dx++) {
          const nxr = ix + dx;
          const nx = nxr < 0 ? nxr + W : (nxr >= W ? nxr - W : nxr);
          if (mask[base + nx]) count++;
        }
      }
      return count;
    }

    const interiorRadius = Math.max(30, Math.round(Math.min(W, rows) * 0.12));
    // 水域标签的搜索半径要大得多：一片环绕世界的洋，它的质心很可能正好落在
    // 某块大陆的正中间（陆地挖掉之后，圆周均值指向剩下的角度），
    // 从质心到最近的洋面可能隔着几百像素。陆地标签不存在这个问题（质心就在
    // 自己身上），所以两套半径分开。
    const waterRadius = Math.max(90, Math.round(Math.max(W, rows) * 0.55));

    /**
     * 从质心向外螺旋找"内部点"：所属连通域正确，且 5x5 窗口大部分同类。
     * 质心可能落在海湾/岛上（尤其细长大陆），直接用它放字会压到海里。
     */
    function findInterior(cx, cy, idArr, id, mask, minCount, radius) {
      const sx = Math.round(cx);
      const sy = Math.round(cy);
      const rMax = radius || interiorRadius;
      let fallback = -1;
      for (let r = 0; r <= rMax; r += 2) {
        const steps = r === 0 ? 1 : Math.max(8, Math.round((TAU * r) / 2));
        for (let k = 0; k < steps; k++) {
          const ang = (k / steps) * TAU;
          const x = Math.round(sx + Math.cos(ang) * r);
          const y = Math.round(sy + Math.sin(ang) * r);
          if (y < 0 || y >= rows) continue;
          const ix = wrapX(x, W);
          const i = y * W + ix;
          if (idArr[i] !== id) continue;
          if (fallback < 0) fallback = i;
          if (windowCount(mask, ix, y, 2) >= minCount) {
            return { i, x: ix + 0.5, y: y + 0.5 };
          }
        }
      }
      if (fallback >= 0) {
        const fy = (fallback / W) | 0;
        return { i: fallback, x: (fallback - fy * W) + 0.5, y: fy + 0.5 };
      }
      return null;
    }

    /** 数据坐标 → 格索引（越界时夹取/环绕） */
    function cellIndex(x, y) {
      const ix = wrapX(Math.floor(x), W);
      const iy = clamp(Math.floor(y), 0, rows - 1);
      return iy * W + ix;
    }

    function isLandAt(x, y) {
      return land[cellIndex(x, y)] === 1;
    }

    // ==================== 2. 陆地连通域 → 大陆 / 岛屿 ====================
    const cands = [];
    let topLandArea = 0;

    if (landCount > 0) {
      const landComps = labelComponents(land, scratch, true);
      landComps.sort((a, b) => b.area - a.area || a.id - b.id);
      topLandArea = landComps.length ? landComps[0].area : 0;

      const minLandArea = Math.max(24, Math.round(n * 0.0008));
      const picked = [];
      for (let k = 0; k < landComps.length && picked.length < 8; k++) {
        if (landComps[k].area >= minLandArea) picked.push(landComps[k]);
      }

      // 大陆 = 面积最大的 1~3 块；其余够大的算岛屿
      let continentCount = 0;
      while (continentCount < 3 && continentCount < picked.length) {
        if (continentCount > 0 && picked[continentCount].area < topLandArea * 0.18) break;
        continentCount++;
      }

      for (let k = 0; k < continentCount; k++) {
        const comp = picked[k];
        const info = namer.labelFor('continent', k);
        const anchor = findInterior(comp.cx, comp.cy, scratch, comp.id, land, 21);
        if (!anchor) continue;
        const ratio = Math.pow(comp.area / topLandArea, 0.4);
        cands.push({
          kind: 'continent',
          name: info.name,
          text: info.text,
          x: anchor.x,
          y: anchor.y,
          size: Math.max(6, Math.round((34 + 9 * ratio) * sizeScale)),
          rotate: 0,
          importance: 5,
          need: 'land',
          waterId: -1,
          curveAllowed: true,
          curveDir: anchor.y < rows / 2 ? 1 : -1,
          path: null,
        });
      }

      const islandComps = picked.slice(continentCount, continentCount + 4);
      const islandTop = islandComps.length ? islandComps[0].area : 1;
      for (let k = 0; k < islandComps.length; k++) {
        const comp = islandComps[k];
        const anchor = findInterior(comp.cx, comp.cy, scratch, comp.id, land, 20);
        if (!anchor) continue;
        const ratio = Math.pow(comp.area / islandTop, 0.4);
        const info = namer.labelFor('island', ratio > 0.85 ? 'big' : 'small');
        cands.push({
          kind: 'island',
          name: info.name,
          text: info.text,
          x: anchor.x,
          y: anchor.y,
          size: Math.max(6, Math.round((17 + 4 * ratio) * sizeScale)),
          rotate: 0,
          importance: 3,
          need: 'land',
          waterId: -1,
          curveAllowed: false,
          curveDir: 0,
          path: null,
        });
      }
    }

    // ==================== 3. 海洋连通域 → 大洋 / 海 ====================
    const waterComp = new Int32Array(n).fill(-1);
    {
      const waterComps = labelComponents(water, waterComp, true);
      waterComps.sort((a, b) => b.area - a.area || a.id - b.id);
      const waterTop = waterComps.length ? waterComps[0].area : 0;
      const minWater = Math.max(48, Math.round(n * 0.0012));

      // 大洋：面积最大的 1~3 块。环绕的整片世界洋通常只有 1 块，
      // 被大陆/地峡隔开的内海才会出现第 2、3 块。
      let oceanCount = 0;
      for (let k = 0; k < waterComps.length && oceanCount < 4; k++) {
        const c = waterComps[k];
        if (c.area < minWater * 4) break;
        if (k > 0 && c.area < waterTop * 0.1) break;
        oceanCount++;
      }
      if (oceanCount === 0 && waterComps.length) oceanCount = 1;

      for (let k = 0; k < oceanCount; k++) {
        const comp = waterComps[k];
        const anchor = findInterior(comp.cx, comp.cy, waterComp, comp.id, water, 16, waterRadius);
        if (!anchor) continue;
        const info = namer.labelFor('ocean');
        const ratio = Math.pow(comp.area / waterTop, 0.4);
        cands.push({
          kind: 'ocean',
          name: info.name,
          text: info.text,
          x: anchor.x,
          y: anchor.y,
          size: Math.max(6, Math.round((30 + 8 * ratio) * sizeScale)),
          rotate: 0,
          importance: 5,
          need: 'water',
          waterId: comp.id,
          curveAllowed: true,
          curveDir: anchor.y < rows / 2 ? 1 : -1,
          path: null,
        });
      }

      // 海：剩下那些"不够大但成片"的水域（封闭/半封闭海湾、内海）
      const seaComps = [];
      for (let k = oceanCount; k < waterComps.length && seaComps.length < 4; k++) {
        const c = waterComps[k];
        if (c.area < minWater) continue;
        if (c.area >= waterTop * 0.1) continue;
        seaComps.push(c);
      }
      const seaTop = seaComps.length ? seaComps[0].area : 1;
      for (let k = 0; k < seaComps.length; k++) {
        const comp = seaComps[k];
        const anchor = findInterior(comp.cx, comp.cy, waterComp, comp.id, water, 13, waterRadius);
        if (!anchor) continue;
        const info = namer.labelFor('sea');
        const ratio = Math.pow(comp.area / seaTop, 0.4);
        cands.push({
          kind: 'sea',
          name: info.name,
          text: info.text,
          x: anchor.x,
          y: anchor.y,
          size: Math.max(6, Math.round((22 + 5 * ratio) * sizeScale)),
          rotate: 0,
          importance: 3,
          need: 'water',
          waterId: comp.id,
          curveAllowed: true,
          curveDir: anchor.y < rows / 2 ? 1 : -1,
          path: null,
        });
      }
    }

    // ==================== 4. 山脉与山峰（16x16 块聚合） ====================
    //
    // 【为什么按块聚合而不是逐格做连通域】山脊是细长的，逐格 8 邻接
    // 会把一条山脊切成无数小段（中间总有 1~2 格低地），根本连不成"山脉"。
    // 先把 16x16 的相对高度求平均，噪声被压掉，剩下的就是成片高地。
    const ranges = [];
    {
      const landFractions = new Float64Array(nb);
      const meanRels = new Float64Array(nb);
      const relsForQuantile = [];
      for (let bi = 0; bi < nb; bi++) {
        if (!blkCellCount[bi]) continue;
        const lf = blkLand[bi] / blkCellCount[bi];
        landFractions[bi] = lf;
        if (blkElev[bi] < 2) continue;
        const meanRel = blkSum[bi] / blkElev[bi];
        meanRels[bi] = meanRel;
        if (lf >= 0.45) relsForQuantile.push(meanRel);
      }
      relsForQuantile.sort((a, b) => a - b);
      const q = relsForQuantile.length
        ? relsForQuantile[Math.min(relsForQuantile.length - 1,
          Math.floor(relsForQuantile.length * 0.82))]
        : 0;
      // 阈值夹在 [0.38, 0.62]：太低会把普通丘陵当山脉，太高则整张图找不到山
      const baseThr = clamp(q, 0.38, 0.62);

      /** 给定阈值切出一批"高地块"连通域（x 方向环绕） */
      function rangesAtThreshold(thr) {
        const sel = new Uint8Array(nb);
        for (let bi = 0; bi < nb; bi++) {
          if (landFractions[bi] >= 0.45 && blkElev[bi] >= 2 && meanRels[bi] >= thr) sel[bi] = 1;
        }
        const seen = new Int32Array(nb).fill(-1);
        const out = [];
        let nextId = 0;
        for (let by = 0; by < bh; by++) {
          for (let bx = 0; bx < bw; bx++) {
            const b0 = by * bw + bx;
            if (!sel[b0] || seen[b0] >= 0) continue;
            const id = nextId++;
            let sp = 0;
            stack[sp++] = b0;
            seen[b0] = id;
            let blocks = 0;
            let sumW = 0;
            let sumCos = 0;
            let sumSin = 0;
            let sumPX = 0;
            let sumPY = 0;
            let sumPXX = 0;
            let sumPXY = 0;
            let sumPYY = 0;
            let bestBlock = -1;
            let bestRel = -1;
            while (sp > 0) {
              const b = stack[--sp];
              const by2 = (b / bw) | 0;
              const bx2 = b - by2 * bw;
              const wgt = meanRels[b];
              const px = bx2 + 0.5;
              const py = by2 + 0.5;
              blocks++;
              sumW += wgt;
              sumPX += px * wgt;
              sumPY += py * wgt;
              sumPXX += px * px * wgt;
              sumPXY += px * py * wgt;
              sumPYY += py * py * wgt;
              const cosIdx = wrapX(Math.round(px * B), W);
              sumCos += COS[cosIdx] * wgt;
              sumSin += SIN[cosIdx] * wgt;
              if (blkMaxRel[b] > bestRel) {
                bestRel = blkMaxRel[b];
                bestBlock = b;
              }
              for (let k = 0; k < 8; k++) {
                const ny = by2 + DY8[k];
                if (ny < 0 || ny >= bh) continue;
                const nxr = bx2 + DX8[k];
                const nx = nxr < 0 ? bw - 1 : (nxr >= bw ? 0 : nxr);
                const j = ny * bw + nx;
                if (sel[j] && seen[j] < 0) {
                  seen[j] = id;
                  stack[sp++] = j;
                }
              }
            }
            // 主轴角：块质心协方差矩阵的最大特征向量方向。
            // 块在 x/y 上是等大的正方形，所以块坐标里算出的角度就是
            // 数据坐标里的走向角，不需要再做比例换算。
            const meanPX = sumPX / sumW;
            const meanPY = sumPY / sumW;
            const covXX = sumPXX / sumW - meanPX * meanPX;
            const covYY = sumPYY / sumW - meanPY * meanPY;
            const covXY = sumPXY / sumW - meanPX * meanPY;
            let angle = 0.5 * Math.atan2(2 * covXY, covXX - covYY);
            if (angle > Math.PI / 2) angle -= Math.PI;
            if (angle < -Math.PI / 2) angle += Math.PI;
            // 夹到 ±0.6：手写地名倾斜超过约 35° 就很难认了（契约要求）
            angle = clamp(angle, -0.6, 0.6);
            const ang = Math.atan2(sumSin, sumCos);
            out.push({
              area: blocks,
              meanRel: sumW / blocks,
              cx: ((ang < 0 ? ang + TAU : ang) / TAU) * W,
              cy: meanPY * B,
              angle,
              bestBlock,
            });
          }
        }
        return out;
      }

      let list = [];
      const tryThresholds = [baseThr, baseThr * 0.7, 0.22, 0.1];
      for (let t = 0; t < tryThresholds.length; t++) {
        list = rangesAtThreshold(tryThresholds[t]);
        if (list.length) break;
      }
      list.sort((a, b) => (b.area * b.meanRel) - (a.area * a.meanRel) || a.cx - b.cx);
      const picks = list.slice(0, 4);
      const topScore = picks.length ? picks[0].area * picks[0].meanRel : 1;

      for (let k = 0; k < picks.length; k++) {
        const r = picks[k];
        if (r.area < 2 && k > 0) break;          // 单块"山脉"只留第一座当兜底
        const ratio = Math.pow((r.area * r.meanRel) / Math.max(1e-6, topScore), 0.4);
        const info = namer.labelFor('mountain');
        cands.push({
          kind: 'mountain',
          name: info.name,
          text: info.text,
          x: wrapX(r.cx, W),
          y: clamp(r.cy, 0, rows - 1),
          size: Math.max(6, Math.round((20 + 6 * ratio) * sizeScale)),
          rotate: r.angle,
          importance: 4,
          need: 'land',
          waterId: -1,
          curveAllowed: false,
          curveDir: 0,
          path: null,
        });
        ranges.push(r);
      }
    }

    // 山峰：每座山脉取最高格
    {
      const peaks = [];
      for (let k = 0; k < ranges.length && peaks.length < MAX_PEAKS; k++) {
        const r = ranges[k];
        if (r.bestBlock < 0) continue;
        const maxIdx = blkMaxIdx[r.bestBlock];
        if (maxIdx < 0) continue;
        const py = (maxIdx / W) | 0;
        const px = maxIdx - py * W;
        peaks.push({ x: px + 0.5, y: py + 0.5, rel: r.meanRel });
      }
      const topRel = peaks.length ? peaks[0].rel : 1;
      for (let k = 0; k < peaks.length; k++) {
        const p = peaks[k];
        const info = namer.labelFor('peak');
        const ratio = clamp(p.rel / Math.max(1e-6, topRel), 0, 1);
        cands.push({
          kind: 'peak',
          name: info.name,
          text: info.text,
          x: p.x,
          y: p.y,
          size: Math.max(6, Math.round((15 + 3 * ratio) * sizeScale)),
          rotate: 0,
          importance: 2,
          need: 'land',
          waterId: -1,
          curveAllowed: false,
          curveDir: 0,
          path: null,
        });
      }
    }

    // ==================== 5. 荒漠 / 森林斑块 ====================
    function pushPatches(mask, kind, labelVariant) {
      scratch.fill(-1);
      const comps = labelComponents(mask, scratch, true);
      comps.sort((a, b) => b.area - a.area || a.id - b.id);
      const minPatch = Math.max(48, Math.round(n * 0.00035));
      const picked = [];
      for (let k = 0; k < comps.length && picked.length < 3; k++) {
        if (comps[k].area < minPatch) continue;
        if (picked.length && comps[k].area < picked[0].area * 0.12) continue;
        picked.push(comps[k]);
      }
      const top = picked.length ? picked[0].area : 1;
      for (let k = 0; k < picked.length; k++) {
        const comp = picked[k];
        const anchor = findInterior(comp.cx, comp.cy, scratch, comp.id, mask, 16);
        if (!anchor) continue;
        const info = namer.labelFor(kind, labelVariant);
        const ratio = Math.pow(comp.area / top, 0.4);
        cands.push({
          kind,
          name: info.name,
          text: info.text,
          x: anchor.x,
          y: anchor.y,
          size: Math.max(6, Math.round((17 + 5 * ratio) * sizeScale)),
          rotate: 0,
          importance: 3,
          need: kind === 'desert' ? 'desert' : 'forest',
          waterId: -1,
          curveAllowed: false,
          curveDir: 0,
          path: null,
        });
      }
    }
    if (desertCount > 0) pushPatches(desertMask, 'desert');
    if (forestCount > 0) pushPatches(forestMask, 'forest');

    // ==================== 6. 河流 ====================

    /** 沿折线在 frac 处取点与切线（x 先解缠，跨经线的河不会甩出直线） */
    function riverPointAt(points, frac) {
      const count = points.length / 2;
      if (count < 2) return null;
      const xs = new Float64Array(count);
      const ys = new Float64Array(count);
      let shift = 0;
      xs[0] = points[0];
      ys[0] = points[1];
      for (let k = 1; k < count; k++) {
        const raw = points[k * 2];
        const prev = points[(k - 1) * 2];
        const d = raw - prev;
        if (d > W / 2) shift -= W;
        else if (d < -W / 2) shift += W;
        xs[k] = raw + shift;
        ys[k] = points[k * 2 + 1];
      }
      let total = 0;
      const segLen = new Float64Array(count);
      for (let k = 1; k < count; k++) {
        const dx = xs[k] - xs[k - 1];
        const dy = ys[k] - ys[k - 1];
        const len = Math.sqrt(dx * dx + dy * dy);
        segLen[k] = len;
        total += len;
      }
      if (total < 1e-6) return null;
      const target = total * clamp(frac, 0, 1);
      let acc = 0;
      let k = 1;
      for (; k < count; k++) {
        if (acc + segLen[k] >= target) break;
        acc += segLen[k];
      }
      if (k >= count) k = count - 1;
      const seg = segLen[k] || 1;
      const t = clamp((target - acc) / seg, 0, 1);
      const x = xs[k - 1] + (xs[k] - xs[k - 1]) * t;
      const y = ys[k - 1] + (ys[k] - ys[k - 1]) * t;
      let ang = Math.atan2(ys[k] - ys[k - 1], xs[k] - xs[k - 1]);
      // 归一到 [-π/2, π/2]：手写地名不会倒着写
      if (ang > Math.PI / 2) ang -= Math.PI;
      else if (ang < -Math.PI / 2) ang += Math.PI;
      return { x: wrapX(x, W), y, angle: ang };
    }

    {
      const rivers = Array.isArray(g.rivers) ? g.rivers.slice() : [];
      rivers.sort((a, b) => (Number(b && b.maxFlow) || 0) - (Number(a && a.maxFlow) || 0));
      const topFlow = rivers.length ? (Number(rivers[0].maxFlow) || 0) : 0;
      let count = 0;
      for (let i = 0; i < rivers.length && count < 6; i++) {
        const r = rivers[i];
        if (!r || !Array.isArray(r.points) || r.points.length < 6) continue;
        const flow = Number(r.maxFlow) || 0;
        if (count > 0 && topFlow > 0 && flow < topFlow * 0.02) continue;
        // 中点可能正好在河口/湖口（水面），沿折线往上游找一个落在陆地的位置
        let anchor = null;
        const fracs = [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65, 0.3, 0.7];
        for (let f = 0; f < fracs.length; f++) {
          const p = riverPointAt(r.points, fracs[f]);
          if (!p) continue;
          if (isLandAt(p.x, p.y)) {
            anchor = p;
            break;
          }
        }
        if (!anchor) continue;
        const info = namer.labelFor('river');
        const ratio = topFlow > 0 ? clamp(flow / topFlow, 0, 1) : 0.5;
        cands.push({
          kind: 'river',
          name: info.name,
          text: info.text,
          x: anchor.x,
          y: anchor.y,
          size: Math.max(6, Math.round((13 + 3 * ratio) * sizeScale)),
          rotate: anchor.angle,
          importance: 3,
          need: 'land',
          waterId: -1,
          curveAllowed: false,
          curveDir: 0,
          path: r.points,                         // 整条折线，渲染层沿它排字
        });
        count++;
      }
    }

    // ==================== 7. 湖泊 ====================
    {
      const lakes = Array.isArray(g.lakes) ? g.lakes.slice() : [];
      lakes.sort((a, b) => (Number(b && b.area) || 0) - (Number(a && a.area) || 0));
      const picked = [];
      for (let i = 0; i < lakes.length && picked.length < 4; i++) {
        const l = lakes[i];
        if (!l) continue;
        const area = Number(l.area) || 0;
        if (i > 0 && picked.length && area < (Number(picked[0].area) || 1) * 0.05) continue;
        picked.push(l);
      }
      const topArea = picked.length ? (Number(picked[0].area) || 1) : 1;
      for (let i = 0; i < picked.length; i++) {
        const l = picked[i];
        let lx = Number(l.x);
        let ly = Number(l.y);
        if (!Number.isFinite(lx)) lx = (Number(l.minX) + Number(l.maxX)) / 2;
        if (!Number.isFinite(ly)) ly = (Number(l.minY) + Number(l.maxY)) / 2;
        if (!Number.isFinite(lx) || !Number.isFinite(ly)) continue;
        let x = wrapX(lx + 0.5, W);
        let y = clamp(ly + 0.5, 0, rows - 1);
        // 湖心可能落在湖湾外的陆地（凹形湖），在附近找一格真正的湖面
        if (!lakeMask[cellIndex(x, y)]) {
          let found = null;
          for (let r = 2; r <= 24 && !found; r += 2) {
            for (let k = 0; k < 12; k++) {
              const ang = (k / 12) * TAU;
              const sx = wrapX(x + Math.cos(ang) * r, W);
              const sy = clamp(y + Math.sin(ang) * r, 0, rows - 1);
              if (lakeMask[cellIndex(sx, sy)]) {
                found = { x: sx, y: sy };
                break;
              }
            }
          }
          if (!found) continue;
          x = found.x;
          y = found.y;
        }
        const info = namer.labelFor('lake');
        const ratio = Math.pow((Number(l.area) || 1) / topArea, 0.4);
        cands.push({
          kind: 'lake',
          name: info.name,
          text: info.text,
          x,
          y,
          size: Math.max(6, Math.round((13 + 4 * ratio) * sizeScale)),
          rotate: 0,
          importance: 2,
          need: 'land',
          waterId: -1,
          curveAllowed: false,
          curveDir: 0,
          path: null,
        });
      }
    }

    if (!cands.length) return result;

    // ==================== 8. 避让布局 ====================
    //
    // 按 importance 从大到小贪心放置：先放最重要的，重要的地名可以挤开
    // 次要地名，但反过来不行。冲突时沿黄金角螺旋试探 40 个位置。
    const KIND_ORDER = {
      continent: 0, ocean: 1, mountain: 2, sea: 3, island: 4,
      desert: 5, forest: 6, river: 7, peak: 8, lake: 9,
    };
    cands.sort((a, b) =>
      (b.importance - a.importance) ||
      ((KIND_ORDER[a.kind] || 0) - (KIND_ORDER[b.kind] || 0)) ||
      (b.size - a.size) ||
      (a.x - b.x));

    const placed = [];
    const labels = [];

    /** 生成弧形排字路径（只在锚点附近、且整条弧不出界时使用） */
    function makeCurve(cand, x, y) {
      // 弧的弦长取"文字总宽"：渲染层（renderer.js）是沿整条曲线按字宽步进
      // 排字的，如果弦长比文字还短，最后几个字会被挤在终点。
      const w0 = cand.text.length * cand.size * 1.02;
      const span = w0 * 1.02;
      if (span < cand.size * 1.8) return null;
      const sag = Math.min(cand.size * 0.85, span * 0.09);
      const dir = cand.curveDir || 1;
      const curve = {
        x0: x - span / 2,
        y0: y,
        x1: x,
        y1: y - 2 * sag * dir,
        x2: x + span / 2,
        y2: y,
      };
      // 弧线一旦碰到画布左右/上下边缘就放弃弧形（否则渲染层会画到图外）
      for (let k = 0; k <= 8; k++) {
        const p = bezierPoint(curve, k / 8);
        if (p.x < 0 || p.x > W) return null;
        if (p.y < cand.size || p.y > rows - cand.size) return null;
      }
      return curve;
    }

    /** 水域标签：文字路径上的采样点必须大部分落在同一个水域连通域里 */
    function waterDomainOk(cand, x, y, ext, curve) {
      let ok = 0;
      const need = 4;
      if (curve) {
        for (let k = 0; k <= 4; k++) {
          const p = bezierPoint(curve, 0.1 + 0.2 * k);
          if (waterComp[cellIndex(p.x, p.y)] === cand.waterId) ok++;
        }
      } else {
        const probes = [
          [x, y],
          [x - ext.w * 0.35, y],
          [x + ext.w * 0.35, y],
          [x, y - ext.h * 0.5],
          [x, y + ext.h * 0.5],
        ];
        for (let k = 0; k < probes.length; k++) {
          if (waterComp[cellIndex(probes[k][0], probes[k][1])] === cand.waterId) ok++;
        }
      }
      return ok >= need;
    }

    function domainOk(cand, x, y, ext, curve) {
      if (cand.need === 'water') return waterDomainOk(cand, x, y, ext, curve);
      const i = cellIndex(x, y);
      if (cand.need === 'desert') return desertMask[i] === 1;
      if (cand.need === 'forest') return forestMask[i] === 1;
      return land[i] === 1;
    }

    for (let ci = 0; ci < cands.length; ci++) {
      const cand = cands[ci];
      const step = Math.max(20, Math.round(cand.size * 2.1));
      let done = false;
      for (let attempt = 0; attempt < maxAttempts && !done; attempt++) {
        let dx = 0;
        let dy = 0;
        if (attempt > 0) {
          // 黄金角螺旋：相邻候选方向不会重复，撒点比较均匀
          const ang = attempt * 2.399963229728653;
          const rad = step * Math.sqrt(attempt);
          dx = Math.cos(ang) * rad;
          dy = Math.sin(ang) * rad;
        }
        const x = wrapX(cand.x + dx, W);
        // 契约：y 必须落在 [size, H-size]，按每个标签自己的字号夹取；
        // 网格太矮（2*size > H）时退化为贴中线，保证仍有合法坐标。
        const y = clamp(cand.y + dy, Math.min(cand.size, rows / 2), Math.max(rows - cand.size, rows / 2));
        const curve = cand.curveAllowed ? makeCurve(cand, x, y) : null;
        const ext = measureExtent(cand.text, cand.size, curve ? 0 : cand.rotate, curve, x, y);
        if (!ext) continue;
        if (!domainOk(cand, x, y, ext, curve)) continue;
        if (hitsPlaced(ext, placed, W, pad)) continue;

        const mid = curve ? bezierPoint(curve, 0.5) : { x, y };
        labels.push({
          text: cand.text,
          name: cand.name,
          kind: cand.kind,
          x: mid.x,
          y: mid.y,
          size: cand.size,
          rotate: curve ? 0 : cand.rotate,
          importance: cand.importance,
          curve,
          path: cand.path || null,
        });
        placed.push({ cx: ext.cx, cy: ext.cy, w: ext.w, h: ext.h });
        done = true;
      }
    }

    // 极端情况下标签可能很多（碎岛 + 多河），契约上限 60 条，截掉最次要的
    if (labels.length > 60) labels.length = 60;
    result.labels = labels;
    return result;
  }

  FM.Toponymy = {
    version: VERSION,
    build,
  };
})(typeof window !== 'undefined' ? window : globalThis);
