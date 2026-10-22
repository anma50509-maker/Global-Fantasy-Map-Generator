/**
 * renderer.js —— 地图渲染器
 *
 * 负责把 generator 的数据画成 1600x800 的位图：
 *   - 逐像素上色（海洋深度 / 地形等高线 / 山体阴影 / 极地冰盖 / 湖泊）
 *   - 矢量叠加（分级河网、经纬网、季风与洋流图层）
 *   - 洋流粒子动画线（只画在可见画布，不进 3D 贴图）
 *   - 图例与高清 PNG 导出
 *
 * 所有 DOM 状态由 main.js 通过 setOptions 注入，像素循环里不再查询 DOM。
 */
(function (root) {
  'use strict';

  const FM = root.FM = root.FM || {};

  // 地形色表（按真实遥感图的实测色重建）
  //
  // 【采样依据】对 NASA Blue Marble 1600×800 做统计，陆地亮度分位为：
  //   p5=35  p25=78  p50=176  p75=239  p95=246
  // 说明真实陆地「暗部很暗（森林）、亮部极亮（沙漠/雪）」，动态范围巨大。
  //
  // 【旧色表的致命问题】全部落在 128~236 这个窄区间，
  // 暗端不够暗、亮端又不够亮，导致：
  //   · 海洋（150 左右）与陆地（180 左右）几乎同亮度，画面糊成一片；
  //   · 任何材质纹理的 ±10% 扰动都被淹没，看起来"纹理跟没开一样"。
  //
  // 【新色表】按实测分位重排，把暗端压到 45（深绿森林）、
  // 亮端提到 243（沙漠/雪），使陆地内部本身就有强烈的明暗层次，
  // 纹理才有立足之地。
  const TERRAIN_COLORS = [
    { limit: 0.10, r: 88,  g: 128, b: 62  }, // 平原：深草绿（暗部）
    { limit: 0.30, r: 132, g: 168, b: 82  }, // 丘陵：中绿
    { limit: 0.50, r: 176, g: 192, b: 108 }, // 高地：黄绿
    { limit: 0.65, r: 196, g: 176, b: 108 }, // 浅山：土黄
    { limit: 0.80, r: 168, g: 132, b: 88  }, // 中山：褐
    { limit: 0.90, r: 132, g: 100, b: 76  }, // 高山：深褐（暗部）
    { limit: 1.00, r: 243, g: 244, b: 246 }, // 雪线：近白
  ];
  const TERRAIN_NAMES = ['平原', '丘陵', '高地', '浅山', '中山', '高山', '雪线'];

  /**
   * 群系调色板（卫星影像风格）。
   *
   * 【为什么按「影像」而不是「示意图」配色】
   * 真实卫星影像里的植被不是鲜艳的绿，而是**低饱和、偏黄偏暗**的绿——
   * 因为树冠在可见光波段反射率并不高，且被大气散射压低了对比。
   * 早期版本用的是明亮的示意色（如 (58,122,58)），贴到地形上会像
   * 一块块色卡，缺少影像感。这里按 NASA Blue Marble 的观感重标：
   *   · 森林：深绿、明显偏暗（亮度约 60~90）；
   *   · 草原/稀树草原：黄绿到土黄，亮度 130~170；
   *   · 荒漠：高明度暖灰黄（亮度 190~210），是全图最亮的自然地表；
   *   · 冰/雪：接近 240，作为最亮端。
   * 这样「暗森林 / 亮荒漠 / 极亮冰雪」的动态范围才能撑起影像感。
   *
   * 顺序即图例顺序：海洋 → 极地冰雪 → 高寒 → 温带 → 亚热带 → 热带。
   */
  const BIOME_PALETTE = {
    // 水体
    '深海': [18, 34, 66],
    '海洋': [30, 62, 110],
    '浅海': [74, 140, 176],
    '湖泊': [58, 108, 148],
    // 极地与高寒（岩色去掉暖黄调，否则整片高原发土黄）
    '极地冰盖': [236, 242, 248],
    '雪地': [246, 248, 251],
    '高山冻原': [158, 162, 154],
    '裸岩': [131, 128, 124],
    '极地荒漠': [168, 164, 154],
    '苔原': [126, 132, 108],
    // ---- 森林：用「色相 + 明度」拉开，而不是只改一点点 RGB ----
    // 【为什么必须重排】旧配色把 7 种森林全挤在 G−R < 40 的同一段绿里
    // （泰加林 58,92,66 / 温带雨林 58,96,68 / 落叶阔叶林 86,122,76 /
    //   亚热带常绿林 68,112,72 / 季雨林 60,106,64 / 热带雨林 44,84,52），
    // 屏幕上一片糊。现在按真实地球的观感分开：
    //   寒温带 → 偏青的墨绿（冷、暗）；温带 → 偏黄的亮绿；
    //   热带 → 高饱和的深绿；季风林 → 黄绿（旱季落叶的观感）。
    '泰加林(针叶林)': [50, 78, 62],
    '温带雨林': [38, 92, 66],
    '落叶阔叶林': [88, 124, 62],
    // ---- 草原：必须是橄榄绿，不能是沙色 ----
    // 【这是一个纯粹由渲染链路放大的错误】草原原始色给成卡其
    // (154,158,92) 时，经过 renderer 的「向亮度去饱和 26% + gamma 0.88
    // 提亮」之后变成 (163,165,118) —— 在屏幕上就是一抹浅沙。
    // 草原占陆地 1/3，于是整块大陆看起来像沙漠星球，
    // 而群系分类其实是「草原」。真实遥感影像里的干草原是
    // 橄榄绿偏黄（约 120,130,80），明度低得多。
    // 沙漠色也必须比草原明显更暖、更亮，两者不能糊在一起。
    '寒冷草原': [106, 120, 88],
    '温带草原': [118, 132, 76],
    '温带沙漠': [188, 170, 146],
    // 亚热带
    '亚热带常绿林': [74, 126, 64],
    '季雨林': [64, 116, 52],
    '稀树草原': [120, 136, 66],
    '亚热带荒漠': [204, 172, 124],
    // 热带
    '热带雨林': [26, 82, 44],
    '热带沙漠': [218, 190, 134],
    // 海岸
    '沙滩': [220, 208, 176],
  };

  /** 群系名 → 图例分组，用于卫星地图图例 */
  const BIOME_GROUPS = [
    { name: '冰雪 / 高寒', keys: ['极地冰盖', '雪地', '高山冻原', '裸岩', '极地荒漠', '苔原'] },
    { name: '森林', keys: ['泰加林(针叶林)', '温带雨林', '落叶阔叶林', '亚热带常绿林', '季雨林', '热带雨林'] },
    { name: '草原 / 稀树草原', keys: ['寒冷草原', '温带草原', '稀树草原'] },
    { name: '荒漠', keys: ['温带沙漠', '亚热带荒漠', '热带沙漠'] },
    { name: '海岸', keys: ['沙滩'] },
  ];

  /** 河网分级：宽度与颜色随汇水面积递增 */
  const RIVER_LEVELS = [
    { width: 1.2, color: 'rgba(74, 150, 206, 0.95)' },
    { width: 2.0, color: 'rgba(52, 126, 186, 1)' },
    { width: 3.2, color: 'rgba(34, 104, 166, 1)' },
    { width: 4.6, color: 'rgba(22, 84, 144, 1)' },
  ];

/** 极地冰盖范围（纬度归一化距离），此区域不绘制河流与湖泊 */
const POLAR_BAND = 0.12;

/** 双线性采样的四个邻格字段名（提到模块级，避免逐像素创建数组） */
const SAMPLE_KEYS = ['i00', 'i10', 'i01', 'i11'];

/**
 * gamma 提亮查表（按 gamma 值缓存）。
 * 2048 级 + 线性插值，最大误差约 0.02/255（肉眼不可分辨），
 * 但把每像素 3 次 Math.pow 换成 3 次数组读取。
 */
const gammaTables = new Map();
function getGammaTable(gamma) {
  let table = gammaTables.get(gamma);
  if (table) return table;
  const SIZE = 2048;
  table = new Float32Array(SIZE + 1);
  for (let i = 0; i <= SIZE; i++) table[i] = 255 * Math.pow(i / SIZE, gamma);
  gammaTables.set(gamma, table);
  return table;
}

  /** 局部 smoothstep：把 x 从 [e0,e1] 平滑映射到 [0,1] */
  function smoothstepLocal(e0, e1, x) {
    const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  }

  class MapRenderer {
    constructor(canvas, width, height) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.width = width;
      this.height = height;
      canvas.width = width;
      canvas.height = height;

      // 离屏画布：保留无损的 1600x800，供主画布与 3D 球体共用
      this.textureCanvas = document.createElement('canvas');
      this.textureCanvas.width = width;
      this.textureCanvas.height = height;
      this.tCtx = this.textureCanvas.getContext('2d');

      // 地形层：只有逐像素地形着色，不含河网与经纬网。
      // 分成两层后，切换「经纬网 / 季风 / 洋流」等叠加选项只需重新合成，
      // 不必把 128 万像素重新着色一遍（旧实现每次切换都要 1.4~1.9 秒）。
      this.terrainCanvas = document.createElement('canvas');
      this.terrainCanvas.width = width;
      this.terrainCanvas.height = height;
      this.terrainCtx = this.terrainCanvas.getContext('2d');
      this.terrainDirty = true;

      // 等距圆柱 albedo 缓存（RGBA，与画布同尺寸）。
      // 投影视图下不再「每像素 shade 4 次再混合」，而是取缓存做双线性重采样，
      // 数学上完全等价（混合的就是同样那 4 个邻格颜色），耗时降到约 1/3。
      this.albedo = new Uint8ClampedArray(width * height * 4);
      this.albedoValid = false;

      // 只取决于像素坐标的噪声层（材质纹理 / 极地冰缘抖动），一次算好反复使用
      this.noiseLayers = null;

      this.generator = null;
      this.viewMode = 'satellite';
      /** 卫星地图的群系底色表（buildBiomeColorMap 预计算） */
      this.biomeColorMap = null;
      this.options = {
        showGrid: true,
        showOceanCurrents: false,
        showMonsoon: false,
      };
      this.onTextureChange = null;
      /** 海洋最深处与海平面之差，海洋着色据此归一化 */
      this.oceanDepthSpan = 0.2;
      /** 预计算的材质纹理表（避免每像素调用 3 次噪声） */
      this.textureMap = null;
      /** 平滑后的海深场（消除板块接缝造成的割裂） */
      this.oceanDepthMap = new Float32Array(0);
      this.oceanDepthMapMin = 0;
      this.oceanDepthMapMax = 1;
      this._r = 0;
      this._g = 0;
      this._b = 0;
    }

    setGenerator(generator) {
      this.generator = generator;
      // 噪声层只取决于像素坐标，换地图（同尺寸）不必重算
      this.albedoValid = false;
      this.terrainDirty = true;
      this.updateOceanDepth();
    }

    /**
     * 准备海洋着色数据（生成 / 导入 / 编辑地形后调用）。
     *
     * 为什么需要单独一张「平滑海底图」：
     * 原始高度场在板块交界处存在剧烈突变（海沟被压深、造山带被抬高），
     * 直接按高度做深度着色，就会出现一条条锐利的深蓝色裂缝 ——
     * 也就是视觉上的「板块割裂」。真实海洋的海底是连续沉积的，
     * 因此这里把海底高度做几次盒式模糊，得到一张连续的海深场，
     * 板块接缝在渲染上自然被抹平，而陆地形状完全不受影响。
     */
    updateOceanDepth() {
      const g = this.generator;
      if (!g || !g.cells || !g.cells.length) return;
      const W = this.width;
      const H = this.height;
      const N = W * H;

      let deepest = g.seaLevel;
      for (let i = 0; i < N; i++) {
        const e = g.cells[i].e;
        if (e < deepest) deepest = e;
      }
      this.oceanDepthSpan = Math.max(0.05, g.seaLevel - deepest);

      // 深度值（0~1），陆地记为 -1 以便模糊时跳过
      const depth = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const e = g.cells[i].e;
        depth[i] = e < g.seaLevel
          ? Math.max(0, Math.min(1, (g.seaLevel - e) / this.oceanDepthSpan))
          : -1;
      }

      // 3 次盒式模糊（近似高斯），只在海洋格之间扩散，避免把陆地深度带进来。
      // 【性能】内层不再用 (x+dx+W)%W 取环绕邻格：每像素 9 次取模、每次 1.28M 像素
      // × 3 轮 = 3400 万次整数取模。改为只在 x==0 / x==W-1 两列单独处理环绕，
      // 其余直接 ±1 索引；语义完全不变（左右邻在首尾列互相环绕）。
      let src = depth;
      let dst = new Float32Array(N);
      for (let iter = 0; iter < 3; iter++) {
        for (let y = 0; y < H; y++) {
          const rowUp = (y - 1) * W;
          const rowMid = y * W;
          const rowDn = (y + 1) * W;
          const hasUp = y > 0;
          const hasDn = y < H - 1;
          for (let x = 0; x < W; x++) {
            const i = rowMid + x;
            const v0 = src[i];
            if (v0 < 0) {
              dst[i] = -1;
              continue;
            }
            const xl = x === 0 ? W - 1 : x - 1;
            const xr = x === W - 1 ? 0 : x + 1;
            let sum = v0;
            let cnt = 1;

            const l = src[rowMid + xl];
            if (l >= 0) { sum += l; cnt++; }
            const r = src[rowMid + xr];
            if (r >= 0) { sum += r; cnt++; }

            if (hasUp) {
              const u = src[rowUp + x];
              if (u >= 0) { sum += u; cnt++; }
              const ul = src[rowUp + xl];
              if (ul >= 0) { sum += ul; cnt++; }
              const ur = src[rowUp + xr];
              if (ur >= 0) { sum += ur; cnt++; }
            }
            if (hasDn) {
              const d = src[rowDn + x];
              if (d >= 0) { sum += d; cnt++; }
              const dl = src[rowDn + xl];
              if (dl >= 0) { sum += dl; cnt++; }
              const dr = src[rowDn + xr];
              if (dr >= 0) { sum += dr; cnt++; }
            }
            dst[i] = sum / cnt;
          }
        }
        const t = src;
        src = dst;
        dst = t;
      }
      this.oceanDepthMap = src;

      // 重新统计平滑后的实际范围，保证色带铺满
      let mn = 1;
      let mx = 0;
      for (let i = 0; i < N; i++) {
        if (src[i] < 0) continue;
        if (src[i] < mn) mn = src[i];
        if (src[i] > mx) mx = src[i];
      }
      this.oceanDepthMapMin = mn;
      this.oceanDepthMapMax = Math.max(mn + 1e-4, mx);

      // 海深场 / 纹理表都变了 → 缓存的地形颜色与合成层作废
      this.albedoValid = false;
      this.terrainDirty = true;

      this.buildTextureMap();
    }

    /**
     * 预计算「只取决于像素坐标」的噪声层。
     *
     * 【为什么值得单独缓存】
     * 材质纹理（宏观/中观/微观三层）与极地冰缘抖动都由 (x, y) 唯一决定，
     * 与地形数据无关。旧实现把前者放在 buildTextureMap 里（每次编辑地形
     * 都要重算 1150 万次噪声，单次约 1.1 秒），后者更糟 —— 直接写在
     * shade() 里，**每一帧渲染**都要重算 258 万次。
     *
     * 现在整张图只算一次（约 1.2 秒，且只在首帧付出），后续的渲染、
     * 切换视图、编辑地形、重建纹理表都只做数组读取。
     */
    ensureNoiseLayers() {
      const g = this.generator;
      if (!g || typeof g.noiseSeamless !== 'function') return null;
      const W = this.width;
      const H = this.height;
      const N = W * H;
      if (this.noiseLayers && this.noiseLayers.N === N) return this.noiseLayers;

      const macro = new Float32Array(N);
      const meso = new Float32Array(N);
      const micro = new Float32Array(N);
      const ice = new Float32Array(N);

      for (let y = 0; y < H; y++) {
        const texV = y / H - 0.5;
        const normalizedY = y / H;
        // 极点收敛：球面噪声在极点处 cos(lat)→0，若仍按 x/W 采样，
        // 整圈经度塌缩成一点却铺满一整行，会出现密集经向条纹。
        // 把经度乘上当前纬度的 cos(lat)，采样点在高纬自动收拢。
        const latRad = (normalizedY - 0.5) * Math.PI;
        const lonScale = Math.max(0.02, Math.cos(latRad));
        const polarV = normalizedY - 0.5;
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          const texU = x / W;
          macro[i] = g.noiseSeamless(texU, texV, 190, 4, 0.55, 2, 501);
          meso[i] = g.noiseSeamless(texU, texV, 520, 3, 0.5, 2, 502);
          micro[i] = g.noiseSeamless(texU, texV, 1400, 2, 0.5, 2, 503);

          const polarU = (texU - 0.5) * lonScale + 0.5;
          ice[i] = g.noiseSeamless(polarU, polarV, 42, 3, 0.55, 2, 311) * 0.65 +
            g.noiseSeamless(polarU, polarV, 76, 2, 0.5, 2, 733) * 0.35;
        }
      }

      this.noiseLayers = { N, macro, meso, micro, ice };
      return this.noiseLayers;
    }

    /**
     * 预计算材质纹理表。
     *
     * 【为什么预计算】如果在 shade() 里逐像素调用 noiseSeamless，
     * 1600×800 需要 3 层 × 4 个八度 ≈ 1500 万次噪声采样，
     * 单次渲染要 2.7 秒，完全不可接受。
     *
     * 这里预先算出三层纹理并合成一个「亮度乘子」存进 Float32Array，
     * shade() 里只做一次数组读取 + 一次逐像素伪随机（极廉价），
     * 渲染耗时可以回到毫秒级。
     */
    buildTextureMap() {
      const g = this.generator;
      if (!g || !g.cells || !g.cells.length) return;
      const W = this.width;
      const H = this.height;
      const N = W * H;
      const sea = g.seaLevel;

      const tex = new Float32Array(N);
      // 三层噪声已由 ensureNoiseLayers() 预计算（只依赖像素坐标），这里只查表
      const layers = this.ensureNoiseLayers();
      if (!layers) return;
      const macroMap = layers.macro;
      const mesoMap = layers.meso;
      const microMap = layers.micro;

      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          const c = g.cells[i];

          const macro = macroMap[i];
          const meso = mesoMap[i];
          const micro = microMap[i];

          if (c.e < sea) {
            // 海洋：极轻微的水面纹理
            tex[i] = 1 + macro * 0.018;
            continue;
          }

          const landE = (c.e - sea) / (1 - sea);
          const hRel = Math.max(0, Math.min(1, landE));
          const rockness = smoothstepLocal(0.34, 0.72, hRel);
          const snowness = smoothstepLocal(0.82, 0.95, hRel);

          const vegBlotch = macro * 0.62 + meso * 0.38;
          const rockGrain = meso * 0.45 + micro * 0.35;
          const snowTex = meso * 0.5 + micro * 0.25;

          // 纹理强度按真实地表的「空间不均匀性」标定：
          //   · 森林/灌丛：树冠与裸土交错，纹理最强（实测标准差最大）
          //   · 岩石区  ：碎石与裂缝，纹理强且高频
          //   · 沙漠    ：沙丘平缓，纹理很弱
          //   · 雪/冰   ：表面光滑，纹理最弱
          const greenMod = 1 + vegBlotch * 0.30;
          const rockMod = 1 + rockGrain * 0.42;
          const snowMod = 1 + snowTex * 0.07;

          tex[i] =
            greenMod * (1 - rockness) * (1 - snowness) +
            rockMod * rockness * (1 - snowness) +
            snowMod * snowness;
        }
      }
      this.textureMap = tex;
      this.buildBiomeColorMap();
    }

    /**
     * 预计算「卫星地图」的陆地底色表（biomeColorMap，N×3 浮点 RGB）。
     *
     * 【设计目标】让自然群系和地形相互影响形成卫星地图的视图，
     * 代替原来的纯海拔色带混合（那套保留在「纯地形」视图里）：
     * 底色由**群系**（气候决定的植被/荒漠/冰雪）给出，
     * 再让**地形**（海拔）去调制它。
     *
     * 【为什么预计算】与 textureMap 同理：shade() 每像素调用上百万次，
     * 群系兜底推导 + 3×3 邻域平滑必须在建表时一次做完，渲染时只查表。
     *
     * 三个步骤：
     *   1) 基色：BIOME_PALETTE[biome]。
     *      导入配置后 biome 全是占位值「海洋」（见 storage.importData），
     *      陆地格按温度/降水重新推导并写回（只算这一次）。
     *   2) 邻域平滑：群系是离散分类，直接查表会在边界出现「色块硬边」
     *      （海报感）。用 3×3 加权平均，权重随色差衰减 ——
     *      相似群系自然过渡，对比强烈的边界保持清晰。
     *   3) 地形调制：海拔越高越冷、植被越稀，向岩色漂移并微微提亮；
     *      同一种群系因此在山地上呈现真实的「垂直分带」。
     *      雪线仍由 shade() 的冰盖逻辑统一处理（含极点收敛）。
     */
    buildBiomeColorMap() {
      const g = this.generator;
      if (!g || !g.cells || !g.cells.length) return;
      const W = this.width;
      const H = this.height;
      const N = W * H;
      const sea = g.seaLevel;
      const cells = g.cells;
      const classify = FM.classifyBiome;

      const base = new Float32Array(N * 3);

      // ---- 1) 群系基色（含导入配置后的兜底推导）----
      for (let i = 0; i < N; i++) {
        const c = cells[i];
        if (c.e < sea) continue;           // 海洋走通用海深色带，不进本表
        let name = c.biome;
        const known = name && BIOME_PALETTE[name];
        const isWaterName = name === '海洋' || name === '深海' || name === '浅海';
        if (!known || (!c.isLake && isWaterName)) {
          name = classify
            ? classify(c.temp, c.precip != null ? c.precip : c.m, c.e, sea, c.isLake, c.tempSea)
            : '温带草原';
          c.biome = name;                  // 写回，后续不再重算
        }
        const col = BIOME_PALETTE[name] || [140, 150, 120];
        base[i * 3] = col[0];
        base[i * 3 + 1] = col[1];
        base[i * 3 + 2] = col[2];
      }

      // ---- 2) 邻域平滑 + 3) 地形调制 ----
      const out = new Float32Array(N * 3);
      const SIGMA2 = 34 * 34;   // 色差衰减尺度：越大过渡越柔
      // 预计算陆地掩码：内层 9 邻域循环里不再读 cells[j].e（对象属性访问 + 比较）
      const landMask = new Uint8Array(N);
      for (let i = 0; i < N; i++) landMask[i] = cells[i].e >= sea ? 1 : 0;
      // gamma 提亮改用查表：每像素 3 次 Math.pow，整图约 160 万次，
      // 单次 pow 约 50 ns，是这张表最大的单项开销。
      const gammaTable = getGammaTable(0.88);
      const GT_SIZE = gammaTable.length - 1;
      const gammaLookup = (x) => {
        if (x <= 0) return 0;
        if (x >= 1) return 255;
        const f = x * GT_SIZE;
        const idx = f | 0;
        const frac = f - idx;
        return gammaTable[idx] + (gammaTable[idx + 1] - gammaTable[idx]) * frac;
      };

      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          const c = cells[i];
          const o = i * 3;
          if (c.e < sea) { out[o] = -1; continue; }   // -1 标记非陆地
          const r0 = base[o];
          const g0 = base[o + 1];
          const b0 = base[o + 2];

          // 左右邻格（经度环绕）：只在首尾两列需要特判，省掉每邻格两次取模
          const xm = x === 0 ? W - 1 : x - 1;
          const xp = x === W - 1 ? 0 : x + 1;

          let sr = 0;
          let sg = 0;
          let sb = 0;
          let sw = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= H) continue;
            const rowBase = yy * W;
            for (let k = 0; k < 3; k++) {
              const j = rowBase + (k === 0 ? xm : k === 1 ? x : xp);
              if (!landMask[j]) continue;
              const oj = j * 3;
              const dr = base[oj] - r0;
              const dg = base[oj + 1] - g0;
              const db = base[oj + 2] - b0;
              // 色差越大权重越小：森林贴着沙漠时边界仍清晰，
              // 而同一片森林内部的细微分类差异被抹平
              const w = 1 / (1 + (dr * dr + dg * dg + db * db) / SIGMA2);
              sr += base[oj] * w;
              sg += base[oj + 1] * w;
              sb += base[oj + 2] * w;
              sw += w;
            }
          }
          let r = sr / sw;
          let gg = sg / sw;
          let b = sb / sw;

          // ---- 色调对齐真实遥感图 ----
          // 与 NASA Blue Marble 同口径统计：
          //   真实陆地平均 RGB = (177, 185, 173) —— 明亮、低饱和、略偏灰绿
          //   本实现调整前   = (151, 156, 125) —— 偏暗、偏黄（蓝通道低 48）
          // 差异来源有两个：① 群系色卡是按「设计色」而非真实反射率给的，
          // 饱和度过高；② 真实影像受大气散射影响，整体被「洗灰」并提亮。
          // 因此这里做统一后处理：向自身亮度去饱和 28%，再提亮 10%。
          // 这不是随手调的滤镜，而是模拟大气程辐射的近似。
          {
            // 去饱和度过高会把人造地表「洗白」，绿色被冲淡、看起来像荒地。
            // 取 0.20：既贴近真实影像的低饱和观感，又保留植被的绿。
            const lumv = 0.299 * r + 0.587 * gg + 0.114 * b;
            // 真实遥感影像陆地饱和度实测仅 0.108（大气散射把色彩压得很平），
            // 而本实现为 0.27 —— 偏高会让画面显得「土黄」。
            // 取 desat 0.26 兼顾真实感与地图可辨识性，同时把亮度提到 1.20
            // （真实陆地明度 0.619，本实现原先只有 0.41，偏暗会加重枯黄观感）。
            // gamma 0.9 的提亮曲线：抬中间调而几乎不动高光，
            // 避免沙漠/雪线被乘爆成纯白（线性乘 1.3 会直接把沙漠压到 255）。
            // 目标是把陆地明度从 0.48 拉向真实影像的 0.60 左右。
            const desat = 0.26;
            r = gammaLookup((r + (lumv - r) * desat) / 255);
            gg = gammaLookup((gg + (lumv - gg) * desat) / 255);
            b = gammaLookup((b + (lumv - b) * desat) / 255);
          }

          // 地形调制：海拔升高 → 植被稀疏（向岩色漂移）+ 轻微提亮
          const landE = Math.max(0, Math.min(1, (c.e - sea) / (1 - sea)));
          const barren = smoothstepLocal(0.58, 0.94, landE);
          // 裸岩色去掉暖黄调（原来的 128/122/112 偏土黄，
          // 大面积高原叠加后会整片发枯）
          const rockR = 132;
          const rockG = 130;
          const rockB = 124;
          r += (rockR - r) * barren * 0.45;
          gg += (rockG - gg) * barren * 0.45;
          b += (rockB - b) * barren * 0.45;
          const lift = 1 + landE * 0.10;
          r *= lift;
          gg *= lift;
          b *= lift;

          out[o] = r;
          out[o + 1] = gg;
          out[o + 2] = b;
        }
      }
      this.biomeColorMap = out;
    }

    setViewMode(mode) {
      this.viewMode = mode;
      // 视图模式直接决定逐像素配色，地形层必须重绘
      this.terrainDirty = true;
      this.albedoValid = false;
    }

    setOptions(options) {
      Object.assign(this.options, options);
    }

    getTextureCanvas() {
      return this.textureCanvas;
    }

    // ==================== 主渲染入口 ====================

    render() {
      const g = this.generator;
      if (!g || !g.cells || !g.cells.length) return;
      // 地形只在数据 / 视图模式 / 投影变化时重绘；切换经纬网、季风、洋流
      // 这类叠加开关只重新合成一次（旧实现每次都要重着色 128 万像素）
      if (this.terrainDirty) this.paintTerrain();

      // 合成：地形层 + 矢量层（河网 / 经纬网）→ 纹理画布（3D 贴图同源）
      this.tCtx.clearRect(0, 0, this.width, this.height);
      this.tCtx.drawImage(this.terrainCanvas, 0, 0);
      this.paintRivers();
      this.paintGrid();

      this.ctx.drawImage(this.textureCanvas, 0, 0);
      this.paintMonsoonLayer();
      this.paintOceanCurrents();
      if (this.onTextureChange) this.onTextureChange(this.textureCanvas);
    }

    /**
     * 只重绘指定区域内的地形与湖泊（编辑时高频调用），不重画河网与经纬网。
     *
     * 参数是**数据坐标**（等距圆柱网格）下的矩形，因为笔刷作用在数据网格上。
     * 非等距圆柱投影时：先把矩形四边采样投影成画布包围盒，再逐画布像素
     * 反算数据坐标着色 —— 与 paintTerrain 的采样方式一致。
     * 若直接拿画布坐标当格子索引用，罗宾逊图上的笔刷会画到别的位置。
     */
    redrawDataRegion(x0, y0, x1, y1) {
      const g = this.generator;
      if (!g || !g.cells) return;
      const W = this.width;
      const H = this.height;
      const cells = g.cells;
      const proj = this.projector;
      const equirect = !proj || proj.name === 'equirect';

      let cx0 = Math.floor(x0);
      let cy0 = Math.floor(y0);
      let cx1 = Math.ceil(x1);
      let cy1 = Math.ceil(y1);

      if (!equirect) {
        // 数据矩形 → 画布包围盒（四边各采样 8 个点，避免漏掉被投影拉长的边）
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        const take = (px, py) => {
          const p = this.projectPixel(px, py);
          if (p.x < minX) minX = p.x;
          if (p.x > maxX) maxX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.y > maxY) maxY = p.y;
        };
        for (let k = 0; k <= 8; k++) {
          const t = k / 8;
          take(x0 + (x1 - x0) * t, y0);
          take(x0 + (x1 - x0) * t, y1);
          take(x0, y0 + (y1 - y0) * t);
          take(x1, y0 + (y1 - y0) * t);
        }
        cx0 = Math.floor(minX) - 2;
        cy0 = Math.floor(minY) - 2;
        cx1 = Math.ceil(maxX) + 2;
        cy1 = Math.ceil(maxY) + 2;
      }

      cx0 = Math.max(0, cx0);
      cy0 = Math.max(0, cy0);
      cx1 = Math.min(W, cx1);
      cy1 = Math.min(H, cy1);
      const w = cx1 - cx0;
      const h = cy1 - cy0;
      if (w <= 0 || h <= 0) return;

      const img = this.ctx.createImageData(w, h);
      const data = img.data;
      const tmp = this._sampleTmp || (this._sampleTmp = {});

      for (let y = 0; y < h; y++) {
        const cy = cy0 + y;
        for (let x = 0; x < w; x++) {
          const cx = cx0 + x;
          const i = cy * W + cx;
          const o = (y * w + x) * 4;
          if (equirect) {
            this.shade(cells, i, cx, cy);
            data[o] = this._r;
            data[o + 1] = this._g;
            data[o + 2] = this._b;
          } else if (!proj.valid[i]) {
            data[o] = 22;
            data[o + 1] = 46;
            data[o + 2] = 74;
          } else {
            proj.sampleBilinear(proj.sx[i], proj.sy[i], W, H, tmp);
            let sr = 0;
            let sg = 0;
            let sb = 0;
            const wsum = tmp.w00 + tmp.w10 + tmp.w01 + tmp.w11 || 1;
            for (const key of ['i00', 'i10', 'i01', 'i11']) {
              const ni = tmp[key];
              const wgt = tmp['w' + key.slice(1)] || 0;
              this.shade(cells, ni, ni % W, (ni / W) | 0);
              sr += this._r * wgt;
              sg += this._g * wgt;
              sb += this._b * wgt;
            }
            data[o] = sr / wsum;
            data[o + 1] = sg / wsum;
            data[o + 2] = sb / wsum;
          }
          data[o + 3] = 255;
        }
      }
      this.ctx.putImageData(img, cx0, cy0);
      // 局部重绘直接写在主画布上，地形层与 albedo 已不一致：
      // 标记为脏，等下一次完整 render() 重建（编辑笔画中不会触发）。
      this.terrainDirty = true;
      this.albedoValid = false;
    }

    // ==================== 像素级上色 ====================

    /**
     * 地形着色（写入 terrainCanvas，不含任何矢量叠加）。
     *
     * 数据始终是等距经纬网格；若启用了非等距投影，这里遍历「目标像素」，
     * 反算经纬度并双线性采样 —— 否则极地会被铺成一整行，横条问题无法消除。
     *
     * 【性能】投影视图不再「每像素 shade 4 次再混合」：
     * shade() 内部包含光照、冰盖、纹理等整套计算，一次要几十次运算；
     * 旧写法对 4 个邻格各算一遍，等于把着色成本乘 4（实测 1.9 秒）。
     * 现在先算一张等距圆柱的 albedo 缓存（每格一次），投影时只对
     * 4 个邻格的**颜色**做双线性混合 —— 数学结果完全相同，成本约 1/3。
     */
    paintTerrain() {
      const g = this.generator;
      if (!g || !g.cells || !g.cells.length) {
        this.terrainDirty = false;
        return;
      }
      const cells = g.cells;
      const W = this.width;
      const H = this.height;
      const proj = this.projector;
      const ctx = this.terrainCtx;
      const img = ctx.createImageData(W, H);
      const data = img.data;

      if (!proj || proj.name === 'equirect') {
        // 等距圆柱：一对一直接着色，顺手把颜色存入 albedo（供切投影时复用）
        const alb = this.albedo;
        for (let i = 0; i < cells.length; i++) {
          this.shade(cells, i, i % W, (i / W) | 0);
          const o = i * 4;
          const r = this._r;
          const gc = this._g;
          const b = this._b;
          data[o] = r;
          data[o + 1] = gc;
          data[o + 2] = b;
          data[o + 3] = 255;
          alb[o] = r;
          alb[o + 1] = gc;
          alb[o + 2] = b;
          alb[o + 3] = 255;
        }
        this.albedoValid = true;
      } else {
        if (!this.albedoValid) this.buildAlbedo();
        const alb = this.albedo;
        const tmp = this._sampleTmp || (this._sampleTmp = {});
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const i = y * W + x;
            const o = i * 4;
            if (!proj.valid[i]) {
              // 投影外区域（椭圆四角）：填成与深海一致的背景色，
              // 避免出现突兀的纯黑边框。
              data[o] = 22;
              data[o + 1] = 46;
              data[o + 2] = 74;
              data[o + 3] = 255;
              continue;
            }
            proj.sampleBilinear(proj.sx[i], proj.sy[i], W, H, tmp);
            let sr = 0;
            let sg = 0;
            let sb = 0;
            const wsum = tmp.w00 + tmp.w10 + tmp.w01 + tmp.w11 || 1;
            for (let k = 0; k < 4; k++) {
              const key = SAMPLE_KEYS[k];
              const o2 = tmp[key] * 4;
              const wgt = tmp['w' + key.slice(1)] || 0;
              sr += alb[o2] * wgt;
              sg += alb[o2 + 1] * wgt;
              sb += alb[o2 + 2] * wgt;
            }
            data[o] = sr / wsum;
            data[o + 1] = sg / wsum;
            data[o + 2] = sb / wsum;
            data[o + 3] = 255;
          }
        }
      }
      ctx.putImageData(img, 0, 0);
      this.terrainDirty = false;
    }

    /** 单独生成等距圆柱 albedo（非等距投影的首帧 / 缓存失效后调用） */
    buildAlbedo() {
      const g = this.generator;
      if (!g || !g.cells || !g.cells.length) return;
      const cells = g.cells;
      const W = this.width;
      const alb = this.albedo;
      for (let i = 0; i < cells.length; i++) {
        this.shade(cells, i, i % W, (i / W) | 0);
        const o = i * 4;
        alb[o] = this._r;
        alb[o + 1] = this._g;
        alb[o + 2] = this._b;
        alb[o + 3] = 255;
      }
      this.albedoValid = true;
    }

    /** 切换投影（会重建采样映射表） */
    setProjection(name) {
      if (!FM.Projector) return;
      if (!this.projector) {
        this.projector = new FM.Projector(name, this.width, this.height);
      } else {
        this.projector.setProjection(name, this.width, this.height);
      }
    }

    /**
     * 数据坐标（等距圆柱网格像素）→ 当前投影下的画布坐标。
     *
     * 【为什么需要】地图数据永远是等距圆柱网格，但画布可能显示罗宾逊/摩尔威德。
     * 地形是「逐画布像素反算经纬度」画出来的，所以自动正确；
     * 而河流、经纬网、季风/洋流这些**矢量叠加**是按数据坐标直接连线的，
     * 若不换算就会画到投影图形外面（罗宾逊下河流跑到椭圆外面）。
     *
     * 各投影的 forward() 对经度都是线性的，因此传超出一圈的坐标
     * （px < 0 或 > width）也能连续外推，方便处理跨经线的环绕副本。
     */
    projectPixel(px, py) {
      const proj = this.projector;
      if (!proj || proj.name === 'equirect') return { x: px, y: py };
      const lon = (px / this.width - 0.5) * Math.PI * 2;
      const lat = (0.5 - py / this.height) * Math.PI;
      const f = proj.proj.forward(lon, lat);
      return { x: f.x * this.width, y: f.y * this.height };
    }

    /**
     * 把后续绘制裁剪到「投影有效区域」内（非圆柱投影才有意义）。
     *
     * 【为什么需要】河流/洋流跨经线时，解缠坐标会越过经度 ±180°。
     * 在等距圆柱下越过边界只是画到画布外、被自然裁掉；
     * 但在罗宾逊/摩尔威德下，±180° 正是椭圆轮廓的边缘，
     * 越过之后投影结果会**落进椭圆外面的四角**，看起来就是「河流跑到图外」。
     * 用轮廓裁剪比逐段截断折线简单得多，且对河网/洋流/经纬网通用。
     *
     * 返回 true 表示已建立裁剪（调用方需自己 restore）。
     */
    clipToProjection(ctx) {
      const proj = this.projector;
      if (!proj || proj.name === 'equirect') return false;
      const W = this.width;
      const H = this.height;
      const STEP = 4;
      ctx.save();
      ctx.beginPath();
      let first = true;
      for (let y = 0; y <= H; y += STEP) {
        const p = this.projectPixel(W, y);
        if (first) {
          ctx.moveTo(p.x, p.y);
          first = false;
        } else {
          ctx.lineTo(p.x, p.y);
        }
      }
      for (let y = H; y >= 0; y -= STEP) {
        const p = this.projectPixel(0, y);
        ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
      ctx.clip();
      return true;
    }

    /**
     * 当前投影下的画布坐标 → 数据坐标；落在投影图形之外时返回 null。
     *
     * 编辑器的指针输入必须经过它，否则在罗宾逊图上点击会编辑到错误的格子。
     */
    unprojectPixel(x, y) {
      const proj = this.projector;
      if (!proj || proj.name === 'equirect') return { x, y };
      const ll = proj.proj.inverse(x / this.width, y / this.height);
      if (!ll) return null;
      const W = this.width;
      let px = (ll.lon / (Math.PI * 2) + 0.5) * W;
      px = ((px % W) + W) % W;
      return { x: px, y: (0.5 - ll.lat / Math.PI) * this.height };
    }

    /**
     * 生成一张「等距圆柱」的地球纹理，专供 3D 球体使用。
     *
     * 【为什么必须单独生成】3D 球体用的是 three.js SphereGeometry，
     * 它的 UV 约定是标准等距圆柱（矩形铺满球面，极点是一整行）。
     * 但 2D 画布可能正显示「罗宾逊投影」（椭圆轮廓、极点收缩为一点）。
     * 如果把罗宾逊的椭圆贴图直接贴到球上，极点会被拉伸成一圈椭圆暗斑，
     * 高纬纹理也全部扭曲 —— 这正是极地异常的原因。
     *
     * 因此这里临时切换到等距圆柱投影渲染一帧，取走纹理后再切回原投影，
     * 保证 3D 贴图与球体 UV 严格匹配。
     *
     * 【为什么不做「已是等距圆柱就直接复用」的捷径】
     * 主纹理画布上还画了经纬网（paintGrid）以及季风/洋流图层，
     * 复用会把虚线经纬网一起贴到球面上，看起来像「没对齐的网格」。
     * 这里始终在独立离屏画布上重画「地形 + 河流」，与 2D 装饰完全隔离。
     *
     * @returns {HTMLCanvasElement} 等距圆柱投影的地球贴图
     */
    renderEquirectTexture() {
      const g = this.generator;
      if (!g || !g.cells) return this.textureCanvas;

      const prevProjection = this.projector ? this.projector.name : 'equirect';

      // 始终渲染到独立离屏画布（不受当前投影与叠加图层影响）
      const off = this._equirectCanvas || (this._equirectCanvas = document.createElement('canvas'));
      off.width = this.width;
      off.height = this.height;
      const offCtx = off.getContext('2d');

      this.setProjection('equirect');
      // 地形层单独绘制（不含经纬网），再拷到离屏画布上叠河流
      this.paintTerrain();
      offCtx.drawImage(this.terrainCanvas, 0, 0);

      const savedTCtx = this.tCtx;
      this.tCtx = offCtx;
      this.paintRivers();
      this.tCtx = savedTCtx;

      this.setProjection(prevProjection);
      // 主视图已切回原投影，地形层要按原投影重画
      this.terrainDirty = true;

      return off;
    }

    /** 单个像素的最终颜色，写入 this._r/_g/_b */
    shade(cells, i, cx, cy) {
      const g = this.generator;
      const sea = g.seaLevel;
      const c = cells[i];
      const mode = this.viewMode;
      let r;
      let gch;
      let b;

      if (mode === 'climate') {
        const tempRatio = Math.max(0, Math.min(1, c.temp));
        //
        // 【为什么必须抖动】气候视图的底场几乎是纯纬向梯度（海洋尤其明显），
        // 而 8-bit 画布每通道只有 256 级：温度每跨过 1/150 的门槛，
        // 整行像素就同时跳 1 个色阶，形成上百条等值线状的「横向平行线」。
        // 地形视图看不到这个现象，是因为它的材质颗粒（±5%）天然起到了
        // 抖动作用；气候视图恰好是全图唯一没有任何抖动的视图。
        //
        // 解法：量化前加 ±0.7 的逐像素哈希抖动，把量化误差摊成
        // 不可见的细颗粒。哈希用整数运算（与 buildTextureMap 的 grain 同源），
        // 每像素约 5 次整数操作，对渲染耗时无感。
        let h = (i * 2654435761) >>> 0;
        h ^= h >>> 15;
        h = Math.imul(h, 2246822519) >>> 0;
        h ^= h >>> 13;
        const dither = ((h & 0xffff) / 65535 - 0.5) * 1.4;

        if (c.e < sea) {
          r = Math.floor(10 + tempRatio * 50 + dither);
          gch = Math.floor(50 + tempRatio * 150 + dither);
          b = Math.floor(120 + tempRatio * 80 + dither);
        } else {
          const moistRatio = Math.max(0, Math.min(1, c.m));
          const baseR = Math.floor(tempRatio * 220 + dither);
          const baseB = Math.floor((1.0 - tempRatio) * 220 + dither);
          r = Math.floor(baseR * 0.7 + (1.0 - moistRatio) * 150 * 0.3 + dither);
          gch = Math.floor(moistRatio * 200 + tempRatio * 55 + dither);
          b = Math.floor(baseB * 0.8 + moistRatio * 50 * 0.2 + dither);

          // 冰雪区：必须**平滑**过渡，不能用二元阈值。
          // 原来写成 if (c.temp < 0.2 && c.m > 0.4) 直接刷白 ——
          // 温度低于 0.2 在图上是一条水平纬度带，于是整行像素同时变白，
          // 形成一条非常突兀的「横向截段」。改为在温度/湿度上各做
          // smoothstep 再相乘，冰雪边界随地形与湿度犬牙交错，
          // 既保留冰盖的视觉信号，又不会出现整行硬切。
          const coldness = smoothstepLocal(0.26, 0.14, tempRatio);
          const wetness = smoothstepLocal(0.30, 0.48, moistRatio);
          const iceBlend = coldness * wetness;
          if (iceBlend > 0.001) {
            r = r * (1 - iceBlend) + 240 * iceBlend;
            gch = gch * (1 - iceBlend) + 245 * iceBlend;
            b = b * (1 - iceBlend) + 255 * iceBlend;
          }
        }
      } else if (mode === 'handdrawn') {
        // ==================== 手绘古地图 ====================
        //
        // 不是给卫星图叠一层滤镜，而是一套独立的着色语言，模仿 17~19 世纪
        // 铜版/手绘地图的观感：
        //   · 羊皮纸底色 + 纤维颗粒；
        //   · 陆地按海拔决定「墨色浓淡」，越高越深；
        //   · 山地用羽毛状排线（hachure）表现起伏，而不是写实光照 ——
        //     排线方向与等高线平行，坡越陡线越密，这是古地图的核心语汇；
        //   · 海岸线用深褐墨线勾边；
        //   · 水体是淡青灰平涂，带极细水纹。
        //
        // 因为 3D 球体的贴图来自「当前显示模式」，所以这一模式贴到球上
        // 天然就是一颗手绘地球仪，无需额外分支。
        const hdLandE = Math.max(0, Math.min(1, (c.e - sea) / (1 - sea)));
        let hh = (i * 2654435761) >>> 0;
        hh ^= hh >>> 15;
        hh = Math.imul(hh, 2246822519) >>> 0;
        hh ^= hh >>> 13;
        const paperGrain = ((hh & 0xffff) / 65535 - 0.5) * 7;

        if (c.e < sea) {
          // 水体：淡青灰平涂，越深略暗
          const dpt = Math.max(0, Math.min(1, (sea - c.e) / this.oceanDepthSpan));
          // 略压深：纸面上看是淡青灰，贴到球体上受光照后不会发白
          r = 172 - dpt * 26;
          gch = 190 - dpt * 24;
          b = 198 - dpt * 16;
          // 水纹：低频水平波纹，避免大片死板色块。
          // 逐像素两次 sin 太贵，改用一张预计算的周期表（查表 + 一次加法）。
          if (!this._hdWave) {
            const T = new Float32Array(1024);
            for (let k = 0; k < 1024; k++) T[k] = Math.sin((k / 1024) * Math.PI * 2) * 2.6;
            this._hdWave = T;
          }
          const wob = ((cx * 0.035) % 1 + 1) % 1;
          const waveIdx = ((cy * 0.75 + wob * 6.4) / (Math.PI * 2) * 1024) & 1023;
          const wave = this._hdWave[waveIdx];
          r += wave;
          gch += wave;
          b += wave;
        } else {
          // 陆地：纸色 → 墨色（海拔越高越深）
          // 用 sqrt 近似 Gamma 0.8 的曲线：视觉几乎无差别，
          // 但比 Math.pow 快一个数量级（这是逐像素调用，1600×800 共 128 万次）。
          const ink = Math.min(1, Math.sqrt(hdLandE) * 1.02);
          r = 237 - ink * 40;
          gch = 228 - ink * 48;
          b = 204 - ink * 58;

          // ---- 铜版排线：固定角度，密度随坡度增加 ----
          //
          // 【为什么不能用「沿等高线方向」的排线】
          // 逐像素求出的坡向在相邻像素间会抖动，用坡向做条纹坐标会把
          // 排线打成噪点（看起来像脏纸而不是刻线）。铜版画实际用的是
          // **固定角度**的排线，靠线距与线宽表现坡度 —— 视觉上更干净，
          // 也更接近古地图的语言。
          if (cx > 0 && cx < this.width - 1 && cy > 0 && cy < this.height - 1) {
            const l = cells[i - 1];
            const rr2 = cells[i + 1];
            const uu = cells[i - this.width];
            const dd = cells[i + this.width];
            if (l.e >= sea && rr2.e >= sea && uu.e >= sea && dd.e >= sea) {
              const gx = (rr2.e - l.e) * 0.5;
              const gy = (dd.e - uu.e) * 0.5;
              const slope = Math.sqrt(gx * gx + gy * gy);
              // 25° 固定排线方向
              const hx = cx * 0.906 + cy * 0.423;
              const period = 7.5 - Math.min(4.2, slope * 210);   // 越陡线越密
              const phase = ((hx % period) + period) % period;
              if (phase < 1.05) {
                const strength = Math.min(0.50, 0.10 + slope * 42);
                r *= 1 - strength;
                gch *= 1 - strength;
                b *= 1 - strength;
              }
            }
          }

          // ---- 等高线墨线：手绘地形图的标志性元素 ----
          const BANDS = 16;
          const myBand = Math.floor(hdLandE * BANDS);
          let contour = false;
          if (cx > 0) {
            const nl = cells[i - 1];
            if (nl.e >= sea && Math.floor(((nl.e - sea) / (1 - sea)) * BANDS) !== myBand) contour = true;
          }
          if (!contour && cy > 0) {
            const nu = cells[i - this.width];
            if (nu.e >= sea && Math.floor(((nu.e - sea) / (1 - sea)) * BANDS) !== myBand) contour = true;
          }
          if (contour) {
            r *= 0.80;
            gch *= 0.76;
            b *= 0.70;
          }

          // ---- 海岸墨线：紧邻海洋的一圈描深 ----
          let coast = false;
          if (cx > 0 && cells[i - 1].e < sea) coast = true;
          else if (cx < this.width - 1 && cells[i + 1].e < sea) coast = true;
          else if (cy > 0 && cells[i - this.width].e < sea) coast = true;
          else if (cy < this.height - 1 && cells[i + this.width].e < sea) coast = true;
          if (coast) {
            r *= 0.50;
            gch *= 0.45;
            b *= 0.38;
          }

          // ---- 极地/高山：留白，只保留极淡的冷灰 ----
          const hdLat = Math.abs(cy / this.height - 0.5) * 2;
          if (c.temp < 0.13 || hdLandE > 0.86) {
            let s = (0.13 - c.temp) * 5.5 + (hdLandE - 0.82) * 2.2;
            s = Math.max(0, Math.min(1, s));
            r = r * (1 - s) + 240 * s;
            gch = gch * (1 - s) + 242 * s;
            b = b * (1 - s) + 238 * s;
          }
        }
        r += paperGrain;
        gch += paperGrain;
        b += paperGrain;
      } else if (mode === 'biome') {
        const bc = BIOME_PALETTE[c.biome] || [200, 200, 200];
        r = bc[0];
        gch = bc[1];
        b = bc[2];
      } else if (c.e < sea) {
        // ---- 海洋：平滑海深场 → 连续色带 → 大陆架 ----
        //
        // 用预先模糊过的海深场（oceanDepthMap），而不是原始高度。
        // 原始高度在板块接缝处有突变，直接取值会画出锐利的深蓝裂缝；
        // 模糊后的深度场是连续的，板块边界在视觉上被自然抹平。
        const rawNorm = (sea - c.e) / this.oceanDepthSpan;
        let depthNorm = i < this.oceanDepthMap.length && this.oceanDepthMap[i] >= 0
          ? (this.oceanDepthMap[i] - this.oceanDepthMapMin) / (this.oceanDepthMapMax - this.oceanDepthMapMin)
          : Math.max(0, Math.min(1, rawNorm));
        depthNorm = Math.max(0, Math.min(1, depthNorm));
        const d = depthNorm;

        // 平滑色带：5 个控制点做连续插值（近岸青绿 → 深海蓝）
        //
        // 【配色演进】参考真实遥感图时发现，NASA Blue Marble 的深海
        // 平均 RGB 只有 (18,36,58)，几乎发黑。但完全照搬会让地图显得
        // 沉闷压抑 —— 这是「地图」而不是「卫星照片」。
        // 因此这里取中间路线：深海保持明显的蓝色而非接近黑，
        // 亮度大约比遥感图高 3 倍，既有层次又不失通透。
        //   深海 (46,104,152)：接近"深海军蓝"，比遥感图亮得多
        //   浅海 (128,206,212)：偏青绿，透光感强
        // 【采样依据】真实遥感图海洋亮度 p50=20、p95=66，几乎全黑。
        // 按"不要太黑"的要求取折中：比遥感图亮约 2.5 倍，
        // 但比旧的 (30,92,146) 更暗更饱和，以拉开与陆地的对比
        // （真实海洋:陆地亮度比约 1:9，旧实现只有 1:1.2，所以糊成一片）。
        // 【按真实遥感图重新标定】
        // 对 NASA Blue Marble 同口径统计（陆海按蓝通道判别）：
        //   真实海洋平均 RGB = (16, 103, 156)
        //   本实现调整前   = (56, 118, 150)
        // 红通道高了 40、蓝通道偏低 —— 视觉上海水发灰发青，
        // 像浅潟湖而不是深海。因此把红分量压下去、蓝分量提上来，
        // 同时保留「近岸青绿 → 深海蓝」的层次（海水不能太黑）。
        const ramp = [
          { at: 0.00, r: 44,  g: 126, b: 172 }, // 近岸浅海：青蓝（不再发青绿）
          { at: 0.18, r: 32,  g: 108, b: 162 },
          { at: 0.42, r: 24,  g: 92,  b: 150 },
          { at: 0.68, r: 18,  g: 74,  b: 136 },
          { at: 1.00, r: 14,  g: 56,  b: 112 }, // 深海：深海军蓝
        ];
        let lo = ramp[0];
        let hi = ramp[ramp.length - 1];
        for (let k = 0; k < ramp.length - 1; k++) {
          if (d >= ramp[k].at && d <= ramp[k + 1].at) {
            lo = ramp[k];
            hi = ramp[k + 1];
            break;
          }
        }
        let tt = hi.at > lo.at ? (d - lo.at) / (hi.at - lo.at) : 0;
        tt = Math.max(0, Math.min(1, tt));
        // smoothstep，色带过渡更柔
        tt = tt * tt * (3 - 2 * tt);
        r = lo.r + (hi.r - lo.r) * tt;
        gch = lo.g + (hi.g - lo.g) * tt;
        b = lo.b + (hi.b - lo.b) * tt;

        // 大陆架：近岸浅水提亮，模拟透光感。
        // 旧实现只判断紧邻陆地的 1 格，于是形成一圈 1 像素宽的亮边，
        // 看起来像给海岸线描了一道硬线。改为按「到海岸的距离」做
        // 2 级缓冲：紧邻 1 格强、2 格弱，过渡自然。
        let shelfDist = 0;
        if (cx > 0 && cells[i - 1].e >= sea) shelfDist = 1;
        else if (cx < this.width - 1 && cells[i + 1].e >= sea) shelfDist = 1;
        else if (cy > 0 && cells[i - this.width].e >= sea) shelfDist = 1;
        else if (cy < this.height - 1 && cells[i + this.width].e >= sea) shelfDist = 1;
        if (shelfDist === 0) {
          // 检查 2 格外的海岸
          const neighbors = [
            [cx - 2, cy], [cx + 2, cy], [cx, cy - 2], [cx, cy + 2],
          ];
          for (const [nx2, ny2] of neighbors) {
            if (ny2 < 0 || ny2 >= this.height) continue;
            const wx2 = ((nx2 % this.width) + this.width) % this.width;
            if (cells[ny2 * this.width + wx2].e >= sea) { shelfDist = 2; break; }
          }
        }
        // 大陆架提亮幅度压小：真实遥感图里近岸亮带很窄，
        // 之前 +10 会让大片浅海接近青绿，整片海洋看起来像潟湖。
        if (shelfDist === 1) {
          r += 6;
          gch += 6;
          b += 4;
        } else if (shelfDist === 2) {
          r += 2;
          gch += 3;
          b += 2;
        }

        // 等深线：仅在纯等高线视图绘制。
        // 其他视图里画等深线会在平坦海床上形成整行同色的"横线"，
        // 正是之前那个 bug 的另一半来源，这里彻底移除非等高线模式的等深线。
        if (mode === 'contour' && cx > 0) {
          const left = cells[i - 1];
          if (left.e < sea) {
            const leftNorm = Math.max(0, Math.min(1, (sea - left.e) / this.oceanDepthSpan));
            if (Math.floor(depthNorm * 6) !== Math.floor(leftNorm * 6)) {
              r *= 0.80;
              gch *= 0.82;
              b *= 0.86;
            }
          }
        }

        // 低纬海水偏暖亮，高纬偏冷暗（幅度很小，只做气氛）
        const latT = Math.abs(cy / this.height - 0.5) * 2;
        const warm = 1 - latT;
        r += warm * 6 - 2;
        gch += warm * 5 - 2;
        b += warm * 3 - 1;

        // ---- 极地海冰 ----
        //
        // 没有海冰的两极就是一片纯蓝海水 —— 一颗带完整气候系统（信风、
        // 副热带高压、西风带、极地东风）的行星却不结冰，读起来不像星球。
        //
        // 【为什么在这里做，而不是在 classifyBiome 里加一个海冰群系】
        // 群系里的「深海/海洋/浅海」只按深度判，「极地冰盖」是给陆地冰帽的。
        // 一旦把海冰也做成群系，despeckleBiomes 与 mergeSmallBiomeBlocks
        // 会把它当成陆地邻居参与投票，沿海陆地的群系会被冰一路蚕食，
        // 而且「陆地构成」的统计也会被海面污染。
        // 海冰是**海面的相态**，不是植被带 —— 交给渲染层按海温上色最干净。
        //
        // 【判据用海温，不用纬度】洋流会把冰界推歪（真实地球：北大西洋
        // 70°N 终年不冻，而同纬度的白令海结冰）。按纬度画会得到一条完美
        // 水平的白带，那正是最容易露馅的假。这里用海平面等效温度
        // （对海格即海温），再叠一层随经纬度缓慢变化的正弦扰动，
        // 让冰缘犬牙交错。
        const tSeaOcean = c.tempSea != null ? c.tempSea : c.temp;
        const iceWob = (Math.sin(cx * 0.031) + Math.sin(cy * 0.089 + 1.7)) * 0.013;
        const iceK = smoothstepLocal(0.265, 0.205, tSeaOcean + iceWob);
        if (iceK > 0.002) {
          r = r * (1 - iceK) + 234 * iceK;
          gch = gch * (1 - iceK) + 241 * iceK;
          b = b * (1 - iceK) + 248 * iceK;
        }
      } else {
        // 陆地
        const landE = (c.e - sea) / (1.0 - sea);
        if (mode === 'satellite' && this.biomeColorMap && this.biomeColorMap[i * 3] >= 0) {
          // ---- 卫星地图：群系定色，地形调制 ----
          // 底色已在 buildBiomeColorMap() 预计算：
          // 群系给色相（气候 → 植被/荒漠/冰雪），海拔给垂直分带；
          // 下面的山体阴影与材质纹理继续叠加，构成完整影像观感。
          const o3 = i * 3;
          r = this.biomeColorMap[o3];
          gch = this.biomeColorMap[o3 + 1];
          b = this.biomeColorMap[o3 + 2];
        } else {
        // 等高线色带（连续插值）——「纯地形」「纯等高线」视图用。
        // 旧实现是"找到第一个 limit 就取该档颜色"，相邻像素一旦跨档
        // 就会硬切（绿 → 白、浅褐 → 深褐），在山脊处形成锯齿状尖刺。
        // 现在改为在相邻两档之间做线性插值，颜色连续过渡，
        // 同时保留等高线视图里"跨档画线"的判断逻辑。
        {
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
          let tt = hiLimit > loLimit ? (landE - loLimit) / (hiLimit - loLimit) : 0;
          tt = Math.max(0, Math.min(1, tt));
          tt = tt * tt * (3 - 2 * tt);
          r = lo.r + (hi.r - lo.r) * tt;
          gch = lo.g + (hi.g - lo.g) * tt;
          b = lo.b + (hi.b - lo.b) * tt;
        }
        }

        // 极地冰盖
        //
        // 冰盖边界不能只按纬度切分（会得到一条贯穿全图的直线，即"怪横线"），
        // 也不能用带水平分量的大尺度噪声（会产生横向条纹）。
        // 这里改为「二维各向同性的球面噪声 + 海拔」共同决定：
        //   - 噪声用小尺度、各向同性，边界呈自然的犬牙交错；
        //   - 高海拔更容易积雪，低洼/沿海不易结冰；
        //   - 纬度只作为"整体趋势"，且与噪声相乘而非相加，
        //     避免任何方向上的直线或条带。
        const normalizedY = cy / this.height;
        const distToPoleBase = Math.min(normalizedY, 1.0 - normalizedY);

        // 【极点退化】球面噪声在极点处 cos(lat)→0，整圈经度塌缩成一个点，
        // 若仍按 cx/width 采样，相邻像素在球面上几乎重合却被铺满一整行，
        // 于是出现密集的经向条纹。修法：把经度乘上当前纬度的 cos(lat)，
        // 使采样点在高纬自动收拢（与真实球面一致）。
        //
        // 【性能】这两层噪声只依赖像素坐标，已由 ensureNoiseLayers() 预计算。
        // 原先直接写在这里，等于**每一帧渲染**都要跑 258 万次球面噪声采样
        // （实测占单次渲染耗时的 15% 以上）。
        const iceJitter = this.noiseLayers ? this.noiseLayers.ice[i] : 0;

        // 以「纬度」为唯一大趋势，海拔做加权，噪声只做边界抖动
        //
        // 范围收敛：极地驱动半径 0.26 → 0.19，海拔权重 0.45 → 0.30。
        // 旧参数下冰盖会从极地一路蔓延到中高纬，配合接近纯白的冰色，
        // 整块大陆看起来"泛白过曝"。
        const latDrive = Math.max(0, 1 - distToPoleBase / 0.19);
        const elevDrive = Math.max(0, Math.min(1, landE));
        let iceCover = latDrive * latDrive * 0.85 + elevDrive * elevDrive * 0.30;
        // 噪声按"局部"加，幅度与当前覆盖度相关（边缘扰动大、内部稳定）
        iceCover += iceJitter * 0.14 * Math.min(1, iceCover + 0.3);
        // 海洋调节：低海拔近海不易结冰
        iceCover -= (1 - elevDrive) * 0.10;

        // 冰色改为带冷调的浅灰蓝（不是纯白），避免在亮地形上"糊成一片白"
        if (iceCover > 0.62) {
          r = 228; gch = 236; b = 244;
        } else if (iceCover > 0.38) {
          const tt = (iceCover - 0.38) / 0.24;
          const s = tt * tt * (3 - 2 * tt);
          r = 228 * s + r * (1 - s);
          gch = 236 * s + gch * (1 - s);
          b = 244 * s + b * (1 - s);
        }

        // 圆柱投影的极点行会被拉伸成一整条：这里把最北/最南 2% 的像素
        // 统一收敛为纯冰色，避免出现"灰白相间的横向条带"。
        const poleRow = distToPoleBase * this.height; // 距极点还有多少像素
        if (poleRow < this.height * 0.018) {
          r = 230; gch = 238; b = 246;
        } else if (poleRow < this.height * 0.034) {
          const s = 1 - (poleRow - this.height * 0.018) / (this.height * 0.016);
          const ss = s * s * (3 - 2 * s);
          r = 230 * ss + r * (1 - ss);
          gch = 238 * ss + gch * (1 - ss);
          b = 246 * ss + b * (1 - ss);
        }

        if (mode === 'contour') {
          if (cx > 0 && cy > 0) {
            const left = cells[i - 1];
            const top = cells[i - this.width];
            if (left.e >= sea && top.e >= sea) {
              const leftLandE = (left.e - sea) / (1.0 - sea);
              const topLandE = (top.e - sea) / (1.0 - sea);
              for (let k = 0; k < TERRAIN_COLORS.length; k++) {
                const limit = TERRAIN_COLORS[k].limit;
                const crossed =
                  (landE <= limit && leftLandE > limit) || (landE <= limit && topLandE > limit) ||
                  (landE > limit && leftLandE <= limit) || (landE > limit && topLandE <= limit);
                if (crossed) { r = 100; gch = 100; b = 100; break; }
              }
            }
          }
        } else if (mode !== 'biome' && mode !== 'climate') {
          // 山体阴影：兰伯特（Lambert）光照模型，固定西北光源
          //
          // 旧实现 lightMod = 1 + sign(shade) * sqrt(|shade|)，平地为 1.0，
          // 亮面最高 ×1.45 —— 基色本已接近 220，乘 1.45 后必然被截到 255，
          // 大面积过曝、丢失地形层次；暗面又只压到 0.55，对比过于两极。
          //
          // 新实现用真实光照模型：
          //   1. 中心差分求高度梯度，构造表面法线 N = (-gx·S, -gy·S, 1)；
          //   2. 与西北上方光源方向 L 做点积，得到漫反射强度；
          //   3. 平地对齐到 1.0 后，映射到 [0.58, 1.12] 的温和增益区间，
          //      平地增益 0.88 —— 既整体压暗消除过曝，又保留明暗层次；
          //   4. 只在四周全为陆地时计算，避免海岸线出现黑边。
          if (cx > 0 && cx < this.width - 1 && cy > 0 && cy < this.height - 1) {
            const l = cells[i - 1];
            const rr = cells[i + 1];
            const u = cells[i - this.width];
            const dd = cells[i + this.width];
            if (l.e >= sea && rr.e >= sea && u.e >= sea && dd.e >= sea) {
              const gx = (rr.e - l.e) * 0.5;
              const gy = (dd.e - u.e) * 0.5;

              // 法线（S 控制起伏的夸张程度，越大山体越立体）
              //
              // 【S 为什么要跟着地形的测高曲线改】S 是「一格高差 → 法线倾斜」
              // 的放大倍数，它必须与**高度场的实际量级**配套。
              // 地形按真实测高曲线重分布后（map-generator 的 EARTH 表），
              // 平原区的 rel 从「每单位高度 2.1 个分位」变成 14.3 个分位 ——
              // 也就是同样一块平原，高差缩小了约 7 倍。
              // S 仍取 34 时整片大陆的 shade 都贴着 1.0，光照完全消失，
              // 地图看起来像一张平涂色块。
              // 取 110（约 3.2 倍）把平原的明暗层次补回来；山脊本来就已经
              // 撞到 clamped 的下限/上限，加大 S 只是让过渡带变窄，不会过曝。
              const S = 110;
              const nx = -gx * S;
              const ny = -gy * S;
              const nz = 1;
              const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;

              // 光源：西北方偏上（已归一化）
              const LX = -0.617;
              const LY = -0.617;
              const LZ = 0.487;
              const dot = (nx * LX + ny * LY + nz * LZ) / nlen;

              // 平地的 dot 恰好等于 LZ，据此归一化到 1.0
              const shade = dot / LZ;

              // 增益区间：最暗 0.52，平地 0.98，最亮 1.22
              // 平地 0.98 略低于 1，留出高光余量避免再次过曝；
              // 暗端放宽到 0.52，让背光面的山脊更有立体感。
              const lightMod = 0.52 + shade * 0.46;
              const clamped = Math.max(0.50, Math.min(1.22, lightMod));

              r *= clamped;
              gch *= clamped;
              b *= clamped;
            }
          }

          // ============ 材质纹理（Surface Texture）============
          //
          // 只有几何起伏 + 光照时，地表是一大片光滑渐变色，像塑料模型。
          // 真实地表充满远小于像素的高频细节（岩石颗粒、植被斑驳、雪面纹理），
          // 这些无法用几何表达，必须用材质扰动。
          //
          // 纹理值已在 buildTextureMap() 里预计算（见该方法说明），
          // 这里只做一次查表 + 一次廉价伪随机，保证渲染性能。
          if (this.textureMap && this.textureMap.length === cells.length) {
            // 逐像素细微颗粒：用整数哈希代替 Math.sin，快约 3 倍
            let h = (i * 2654435761) >>> 0;
            h ^= h >>> 15;
            h = Math.imul(h, 2246822519) >>> 0;
            h ^= h >>> 13;
            const grain = (h & 0xffff) / 65535;
            // 逐像素颗粒：模拟真实地表细碎的明暗跳变
            // 【为什么要把纹理压弱】这张表原本按 ±30% 的植被斑驳设计，
            // 在「地形混合」视图里没问题，但卫星视图整体明度更高，
            // 强纹理会让地表显得斑驳发干（用户反馈的「枯黄」感有一部分来自这里）。
            // 真实遥感影像的纹理对比度要低得多，因此把幅度压到 65%，
            // 逐像素颗粒也由 ±5% 降到 ±4%。
            const texMod = 1 + (this.textureMap[i] - 1) * 0.65 + (grain - 0.5) * 0.08;
            r = Math.max(0, Math.min(255, r * texMod));
            gch = Math.max(0, Math.min(255, gch * texMod));
            b = Math.max(0, Math.min(255, b * texMod));
          }
        }
      }

      // 湖泊（岸线加深）；极地冰盖上的洼地保持冰色
      const lakeNy = cy / this.height;
      const lakePolar = Math.min(lakeNy, 1 - lakeNy) < POLAR_BAND;
      if (c.isLake && !lakePolar) {
        let edge = false;
        if (cx > 0 && !cells[i - 1].isLake) edge = true;
        else if (cx < this.width - 1 && !cells[i + 1].isLake) edge = true;
        if (cy > 0 && !cells[i - this.width].isLake) edge = true;
        else if (cy < this.height - 1 && !cells[i + this.width].isLake) edge = true;
        if (mode === 'handdrawn') {
          // 手绘：湖面淡青灰，岸边压一道墨线
          r = edge ? 120 : 186;
          gch = edge ? 106 : 206;
          b = edge ? 88 : 210;
        } else if (mode === 'biome') {
          r = edge ? 62 : 96;
          gch = edge ? 128 : 172;
          b = edge ? 178 : 216;
        } else {
          r = edge ? 66 : 104;
          gch = edge ? 142 : 186;
          b = edge ? 200 : 232;
        }
      }

      this._r = r;
      this._g = gch;
      this._b = b;
    }

    // ==================== 矢量图层 ====================

    /**
     * 分级河网绘制。
     *
     * 关键点：地图在 X 方向是环绕的（圆柱投影），河流经常会跨越经线，
     * 此时相邻两点的 x 会突然从 ~0 跳到 ~width。若直接按点序连线，
     * 就会画出一条横穿整张地图的直线（这就是之前那条"怪横线"）。
     *
     * 正确做法：
     *   1. 解缠（unwrap）：把 x 改成连续坐标，跨经线时累加 ±width；
     *   2. 在解缠坐标上做法线扰动与平滑，几何完全连续；
     *   3. 绘制时对路径做 k*width 的环绕复制，只在副本与 [0,width] 相交时输出，
     *      这样跨经线的河会同时出现在左右两侧，且没有直线穿越。
     */
    paintRivers() {
      const g = this.generator;
      if (this.viewMode === 'contour') return;
      if (!g || !g.rivers || g.rivers.length === 0) return;

      const W = this.width;
      const threshold = g.hydrology ? g.hydrology.riverThreshold : 448;
      const tCtx = this.tCtx;
      /** 4 个等级，每级是若干条解缠后的折线（扁平数组 x0,y0,x1,y1...） */
      const levelPaths = [[], [], [], []];

      for (const river of g.rivers) {
        const { points, flows, count } = river;

        // ---- 1. 解缠 X 坐标 ----
        const xs = new Float64Array(count);
        const ys = new Float64Array(count);
        let shift = 0;
        for (let k = 0; k < count; k++) {
          const raw = points[k * 2];
          if (k > 0) {
            const d = raw - points[(k - 1) * 2];
            if (d > W / 2) shift -= W;
            else if (d < -W / 2) shift += W;
          }
          xs[k] = raw + shift;
          ys[k] = points[k * 2 + 1];
        }

        // ---- 2. 曲流扰动：法线方向叠加低频噪声，消除 D8 的 45° 折线感 ----
        const px = new Float64Array(count);
        const py = new Float64Array(count);
        for (let k = 0; k < count; k++) {
          let tx = 0;
          let ty = 0;
          if (k > 0) {
            tx += xs[k] - xs[k - 1];
            ty += ys[k] - ys[k - 1];
          }
          if (k < count - 1) {
            tx += xs[k + 1] - xs[k];
            ty += ys[k + 1] - ys[k];
          }
          const len = Math.hypot(tx, ty) || 1;
          let wobble = 0;
          if (k > 0 && k < count - 1) {
            // 用原始（环绕）坐标取噪声，保证地图两侧扰动一致
            wobble = Math.sin(k * 0.42 + (points[k * 2] + ys[k]) * 0.021) * 1.1 +
              Math.sin(k * 0.11 + ys[k] * 0.013) * 0.7;
          }
          px[k] = xs[k] - (ty / len) * wobble;
          py[k] = ys[k] + (tx / len) * wobble;
        }

        // ---- 3. 按「等级变化 / 极地冰盖」切段 ----
        let lastLevel = -1;
        let path = null;
        for (let k = 0; k < count; k++) {
          const ny = py[k] / this.height;
          const distToPole = Math.min(ny, 1 - ny);
          if (distToPole < POLAR_BAND) {
            lastLevel = -1;
            path = null;
            continue;
          }
          const level = MapRenderer.riverLevel(flows[k], threshold);
          if (level !== lastLevel || !path) {
            path = [px[k], py[k]];
            levelPaths[level].push(path);
            lastLevel = level;
          } else {
            path.push(px[k], py[k]);
          }
        }
      }

      // ---- 4. 绘制：每级一次 stroke，跨经线的路径做环绕复制 ----
      // 非圆柱投影下必须裁剪到投影轮廓，否则跨经线副本会画进椭圆四角
      const clipped = this.clipToProjection(tCtx);
      for (let level = 0; level < 4; level++) {
        const paths = levelPaths[level];
        if (paths.length === 0) continue;
        const conf = RIVER_LEVELS[level];
        // 手绘模式下河流改成墨线（深褐），与纸色底图统一；
        // 线宽也收细一点，更像铜版画里的河道。
        if (this.viewMode === 'handdrawn') {
          const inks = ['rgba(96, 78, 56, 0.85)', 'rgba(84, 66, 46, 0.9)',
                        'rgba(72, 56, 38, 0.94)', 'rgba(60, 46, 30, 0.97)'];
          tCtx.strokeStyle = inks[level] || inks[0];
          tCtx.lineWidth = conf.width * 0.72;
        } else {
          tCtx.strokeStyle = conf.color;
          tCtx.lineWidth = conf.width;
        }
        tCtx.lineCap = 'round';
        tCtx.lineJoin = 'round';
        tCtx.beginPath();
        for (const pts of paths) this.emitWrappedPath(pts, W);
        tCtx.stroke();
      }
      if (clipped) tCtx.restore();
    }

    /**
     * 把一条解缠折线写入当前 path，并按需输出左右环绕副本。
     *
     * 【投影】折线的点原本是数据坐标；每画一份副本都要先投影到画布坐标
     * （`projectPixel`）再连线，否则在罗宾逊/摩尔威德下河流会跑到图外。
     * 投影对经度是线性的，所以 ±W 的解缠偏移投影后依然连续。
     */
    emitWrappedPath(pts, W) {
      const n = pts.length / 2;
      if (n < 2) return;

      let minX = Infinity;
      let maxX = -Infinity;
      for (let k = 0; k < n; k++) {
        const x = pts[k * 2];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }

      // 找出所有与 [0, W] 相交的环绕副本（多画一份，避免投影压缩后边缘缺段）
      const from = Math.ceil(-maxX / W) - 1;
      const to = Math.floor((W - minX) / W) + 1;
      const tCtx = this.tCtx;
      const proj = new Array(n);

      for (let copy = from; copy <= to; copy++) {
        const off = copy * W;
        let visible = false;
        for (let k = 0; k < n; k++) {
          const p = this.projectPixel(pts[k * 2] + off, pts[k * 2 + 1]);
          proj[k] = p;
          if (p.x > -32 && p.x < W + 32) visible = true;
        }
        if (!visible) continue;

        tCtx.moveTo(proj[0].x, proj[0].y);
        // 中点二次贝塞尔：消除折线锯齿，且首尾保持原位置
        for (let k = 1; k < n - 1; k++) {
          const mx = (proj[k].x + proj[k + 1].x) / 2;
          const my = (proj[k].y + proj[k + 1].y) / 2;
          tCtx.quadraticCurveTo(proj[k].x, proj[k].y, mx, my);
        }
        tCtx.lineTo(proj[n - 1].x, proj[n - 1].y);
      }
    }

    static riverLevel(flow, threshold) {
      if (flow < threshold * 2) return 0;
      if (flow < threshold * 6) return 1;
      if (flow < threshold * 18) return 2;
      return 3;
    }

    /**
     * 经纬网。
     *
     * 用「虚线 + 低透明度」而不是实线：实线在平坦地形/海面上会形成
     * 贯穿全图的连续硬边，容易被误认为地图出现了"横线"瑕疵；
     * 虚线既保留定位功能，又不会抢地形的视觉主导权。
     */
    paintGrid() {
      if (!this.options.showGrid) return;
      const tCtx = this.tCtx;
      const W = this.width;
      const H = this.height;
      tCtx.setLineDash([5, 7]);
      tCtx.lineWidth = 1;
      const clipped = this.clipToProjection(tCtx);

      // 纬线（每 30° 一条）：用投影后的左右端点连线。
      // 罗宾逊/摩尔威德的纬线仍是水平直线，但宽度随纬度收拢，
      // 直接画 0→W 会伸出椭圆外面。
      const parallel = (y) => {
        const a = this.projectPixel(0, y);
        const b = this.projectPixel(W, y);
        tCtx.moveTo(a.x, a.y);
        tCtx.lineTo(b.x, b.y);
      };

      tCtx.strokeStyle = 'rgba(255, 255, 255, 0.13)';
      tCtx.beginPath();
      for (let i = 1; i < 6; i++) parallel((H / 6) * i);
      tCtx.stroke();

      // 赤道略明显
      tCtx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
      tCtx.beginPath();
      parallel(H / 2);
      tCtx.stroke();

      // 经线（每 30° 一条）：经线是非圆柱投影下的曲线，按纬度采样折线
      tCtx.strokeStyle = 'rgba(255, 255, 255, 0.13)';
      tCtx.beginPath();
      const SEG = 24;
      for (let i = 1; i < 12; i++) {
        const x = (W / 12) * i;
        const p0 = this.projectPixel(x, 0);
        tCtx.moveTo(p0.x, p0.y);
        for (let k = 1; k <= SEG; k++) {
          const p = this.projectPixel(x, (H * k) / SEG);
          tCtx.lineTo(p.x, p.y);
        }
      }
      tCtx.stroke();

      tCtx.setLineDash([]);
      if (clipped) tCtx.restore();
    }

    /** 洋流粒子追踪（仅覆盖在可见画布上，不进 3D 贴图） */
    /**
     * 洋流流线（风生环流 + 西边界流 + 热盐环流）。
     *
     * 用粒子追踪画出流线，并按「冷暖」着色：
     *   · 暖流（向高纬流动）→ 红橙色
     *   · 寒流（向低纬流动）→ 蓝色
     * 线宽随流速变化，流速越大越粗。
     */
    paintOceanCurrents() {
      if (!this.options.showOceanCurrents) return;
      const g = this.generator;
      if (!g || !g.cells) return;
      const ctx = this.ctx;
      const W = this.width;
      const H = this.height;

      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const clipped = this.clipToProjection(ctx);

      const numStreamlines = 180;
      const maxSteps = 120;
      const stepSize = 4.5;
      const seedInterval = Math.max(1, Math.floor((W * H) / numStreamlines));
      const visited = new Uint8Array(W * H);

      for (let i = 0; i < W * H; i += seedInterval) {
        const startCell = g.cells[i];
        if (!startCell || startCell.e >= g.seaLevel || !startCell.current) continue;
        if (visited[i]) continue;
        const speed0 = Math.hypot(startCell.current.u, startCell.current.v);
        if (speed0 < 0.15) continue;

        const latNorm = startCell.y / H - 0.5;
        const warm = startCell.current.v * -latNorm > 0;
        const baseColor = warm ? '255, 110, 70' : '70, 150, 235';

        let curX = startCell.x;
        let curY = startCell.y;
        let vx = startCell.current.u;
        let vy = startCell.current.v;
        const pts = [curX, curY];

        for (let step = 0; step < maxSteps; step++) {
          let gx = Math.floor(curX);
          let gy = Math.floor(curY);
          gx = (gx + W) % W;
          if (gy < 0 || gy >= H) break;
          const idx = gy * W + gx;
          const c = g.cells[idx];
          if (!c || c.e >= g.seaLevel || !c.current) break;

          vx = vx * 0.55 + c.current.u * 0.45;
          vy = vy * 0.55 + c.current.v * 0.45;
          const sp = Math.hypot(vx, vy);
          if (sp < 0.06) break;
          vx /= sp; vy /= sp;

          for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              const yy = gy + dy;
              if (yy < 0 || yy >= H) continue;
              visited[yy * W + ((gx + dx + W) % W)] = 1;
            }
          }

          curX += vx * stepSize;
          curY += vy * stepSize;
          if (curX < 0) curX += W;
          if (curX >= W) curX -= W;
          if (curY < 0 || curY >= H) break;
          pts.push(curX, curY);
        }

        const n = pts.length / 2;
        if (n < 8) continue;

        // 解缠 X：跨经线时累加 ±W，让折线在数据坐标里连续，
        // 之后投影才不会在接缝处连出一条横贯全图的直线。
        const ux = new Float64Array(n);
        const uy = new Float64Array(n);
        let shift = 0;
        for (let k = 0; k < n; k++) {
          const raw = pts[k * 2];
          if (k > 0) {
            const d = raw - pts[(k - 1) * 2];
            if (d > W / 2) shift -= W;
            else if (d < -W / 2) shift += W;
          }
          ux[k] = raw + shift;
          uy[k] = pts[k * 2 + 1];
        }

        const spd = Math.min(1, speed0 * 1.6);
        ctx.strokeStyle = 'rgba(' + baseColor + ',' + (0.35 + spd * 0.45).toFixed(2) + ')';
        ctx.lineWidth = 1.0 + spd * 1.8;

        // 环绕副本：投影后每份单独连线
        for (let copy = -1; copy <= 1; copy++) {
          const off = copy * W;
          const proj = new Array(n);
          let visible = false;
          for (let k = 0; k < n; k++) {
            const p = this.projectPixel(ux[k] + off, uy[k]);
            proj[k] = p;
            if (p.x > -32 && p.x < W + 32) visible = true;
          }
          if (!visible) continue;

          ctx.beginPath();
          ctx.moveTo(proj[0].x, proj[0].y);
          for (let k = 1; k < n; k++) ctx.lineTo(proj[k].x, proj[k].y);
          ctx.stroke();

          if (n > 12) {
            const a1 = proj[n - 1];
            const a2 = proj[n - 4];
            const ang = Math.atan2(a1.y - a2.y, a1.x - a2.x);
            if (Math.hypot(a1.x - a2.x, a1.y - a2.y) < 40) {
              ctx.fillStyle = 'rgba(' + baseColor + ',0.9)';
              ctx.beginPath();
              ctx.moveTo(a1.x + Math.cos(ang) * 8, a1.y + Math.sin(ang) * 8);
              ctx.lineTo(a1.x - Math.sin(ang) * 4.5, a1.y + Math.cos(ang) * 4.5);
              ctx.lineTo(a1.x + Math.sin(ang) * 4.5, a1.y - Math.cos(ang) * 4.5);
              ctx.closePath();
              ctx.fill();
            }
          }
        }
      }
      if (clipped) ctx.restore();
    }

    /**
     * 季风图层：色块表示季风强度，箭头表示季风风向。
     */
    paintMonsoonLayer() {
      if (!this.options.showMonsoon) return;
      const g = this.generator;
      if (!g || !g.cells) return;
      const ctx = this.ctx;
      const W = this.width;
      const H = this.height;
      const clipped = this.clipToProjection(ctx);

      const proj = this.projector;
      const equirect = !proj || proj.name === 'equirect';

      // 色块：按**画布像素**取样，再反算到数据网格读 monsoon。
      // 直接按数据网格 fillRect 在非等距圆柱下会错位（色块跑到投影外）。
      for (let y = 0; y < H; y += 2) {
        for (let x = 0; x < W; x += 2) {
          let sx = x;
          let sy = y;
          if (!equirect) {
            const src = this.unprojectPixel(x, y);
            if (!src) continue;
            sx = src.x;
            sy = src.y;
          }
          const c = g.cells[Math.floor(sy) * W + Math.floor(sx)];
          if (!c || c.monsoon <= 0.12) continue;
          const a = Math.min(0.30, c.monsoon * 0.32);
          ctx.fillStyle = 'rgba(255, 180, 60, ' + a.toFixed(3) + ')';
          ctx.fillRect(x, y, 2, 2);
        }
      }

      const step = 22;
      ctx.strokeStyle = 'rgba(255, 120, 40, 0.85)';
      ctx.fillStyle = 'rgba(255, 120, 40, 0.9)';
      ctx.lineWidth = 1.4;
      const len = 7;
      for (let y = step / 2; y < H; y += step) {
        for (let x = 0; x < W; x += step) {
          let sx = x;
          let sy = y;
          if (!equirect) {
            const src = this.unprojectPixel(x, y);
            if (!src) continue;
            sx = src.x;
            sy = src.y;
          }
          const c = g.cells[Math.floor(sy) * W + Math.floor(sx)];
          if (!c || c.monsoon < 0.18) continue;
          const u = c.windU;
          const v = c.windV;
          const sp = Math.hypot(u, v);
          if (sp < 0.25) continue;
          // 箭头两端都在数据坐标里取，再各自投影：
          // 这样箭头的方向会自动跟着投影变形（高纬经线收拢）。
          const ox = sx + (u / sp) * len;
          const oy = sy + (v / sp) * len;
          const p0 = this.projectPixel(sx, sy);
          const p1 = this.projectPixel(ox, oy);
          ctx.beginPath();
          ctx.moveTo(p0.x, p0.y);
          ctx.lineTo(p1.x, p1.y);
          ctx.stroke();
          const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x);
          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p1.x - Math.cos(ang - 0.5) * 3.5, p1.y - Math.sin(ang - 0.5) * 3.5);
          ctx.lineTo(p1.x - Math.cos(ang + 0.5) * 3.5, p1.y - Math.sin(ang + 0.5) * 3.5);
          ctx.closePath();
          ctx.fill();
        }
      }
      if (clipped) ctx.restore();
    }


    // ==================== 图例 ====================

    updateLegend(container) {
      if (!container) return;
      const mode = this.viewMode;
      if (mode === 'biome') {
        let html = '<h3>自然群系分布图例</h3>';
        for (const key of Object.keys(BIOME_PALETTE)) {
          if (key === '深海' || key === '海洋' || key === '浅海' || key === '湖泊') continue;
          const bc = BIOME_PALETTE[key];
          html += '<div class="legend-item"><div class="color-box" style="background-color: rgb(' +
            bc[0] + ',' + bc[1] + ',' + bc[2] + ')"></div><span>' + key + '</span></div>';
        }
        container.innerHTML = html;
        return;
      }
      if (mode === 'climate') {
        container.innerHTML = '<h3>气候分布图例</h3>' +
          '<div style="margin-bottom:10px;">' +
          '<div style="color:#eee;font-size:12px;margin-bottom:2px;">温度 (冷 → 暖)</div>' +
          '<div style="height:10px;width:100%;background:linear-gradient(to right,#0000ff,#ff0000);border:1px solid #555;"></div>' +
          '</div>' +
          '<div><div style="color:#eee;font-size:12px;margin-bottom:2px;">湿度 (干 → 湿)</div>' +
          '<div style="height:10px;width:100%;background:linear-gradient(to right,#ffff00,#00ff00);border:1px solid #555;"></div></div>';
        return;
      }
      if (mode === 'handdrawn') {
        container.innerHTML =
          '<h3>手绘古地图</h3>' +
          '<div class="legend-item"><div class="color-box" style="background-color: rgb(234,224,198)"></div><span>羊皮纸底（低地）</span></div>' +
          '<div class="legend-item"><div class="color-box" style="background-color: rgb(180,160,124)"></div><span>墨色加深（高地）</span></div>' +
          '<div class="legend-item"><div class="color-box" style="background-color: rgb(120,100,70)"></div><span>排线（山体起伏）</span></div>' +
          '<div class="legend-item"><div class="color-box" style="background-color: rgb(72,54,36)"></div><span>海岸墨线</span></div>' +
          '<div class="legend-item"><div class="color-box" style="background-color: rgb(198,211,213)"></div><span>水域平涂</span></div>';
        return;
      }
      if (mode === 'satellite') {
        let html = '<h3>卫星地图图例（群系 × 地形）</h3>';
        for (const group of BIOME_GROUPS) {
          html += '<div style="color:#999;font-size:11px;margin:8px 0 2px;">' + group.name + '</div>';
          for (const key of group.keys) {
            const bc = BIOME_PALETTE[key];
            html += '<div class="legend-item"><div class="color-box" style="background-color: rgb(' +
              bc[0] + ',' + bc[1] + ',' + bc[2] + ')"></div><span>' + key + '</span></div>';
          }
        }
        container.innerHTML = html;
        return;
      }
      let html = '<h3>标准等高线地形图例</h3>';
      html += '<div class="legend-item"><div class="color-box" style="background-color: rgb(10,55,100)"></div><span>深海</span></div>';
      html += '<div class="legend-item"><div class="color-box" style="background-color: rgb(70,110,160)"></div><span>浅海</span></div>';
      for (let i = 0; i < TERRAIN_COLORS.length; i++) {
        const tc = TERRAIN_COLORS[i];
        html += '<div class="legend-item"><div class="color-box" style="background-color: rgb(' +
          tc.r + ',' + tc.g + ',' + tc.b + ')"></div><span>' + TERRAIN_NAMES[i] + '</span></div>';
      }
      container.innerHTML = html;
    }

    /** 生成带图例的高清 PNG（dataURL） */
    exportPNG() {
      const g = this.generator;
      const mode = this.viewMode;
      const canvas = document.createElement('canvas');
      canvas.width = this.width;
      canvas.height = this.height;
      const ectx = canvas.getContext('2d');
      ectx.drawImage(this.canvas, 0, 0);

      let title = '标准等高线地形图例';
      if (mode === 'handdrawn') title = '手绘古地图';
      if (mode === 'satellite') title = '卫星地图图例（群系 × 地形）';
      if (mode === 'pure_terrain') title = '大陆地形图例';
      else if (mode === 'contour') title = '标准测绘等高线图例';
      else if (mode === 'biome') title = '自然群系分布图例';
      else if (mode === 'climate') title = '气候分布图例';

      const items = [];
      if (mode === 'biome') {
        for (const key of Object.keys(BIOME_PALETTE)) {
          if (key === '深海' || key === '海洋' || key === '浅海') continue;
          const bc = BIOME_PALETTE[key];
          items.push({ name: key, color: 'rgb(' + bc[0] + ',' + bc[1] + ',' + bc[2] + ')' });
        }
      } else if (mode === 'satellite') {
        for (const group of BIOME_GROUPS) {
          for (const key of group.keys) {
            const bc = BIOME_PALETTE[key];
            items.push({ name: key, color: 'rgb(' + bc[0] + ',' + bc[1] + ',' + bc[2] + ')' });
          }
        }
      } else if (mode !== 'climate') {
        for (let i = TERRAIN_COLORS.length - 1; i >= 0; i--) {
          const tc = TERRAIN_COLORS[i];
          items.push({ name: TERRAIN_NAMES[i], color: 'rgb(' + tc.r + ',' + tc.g + ',' + tc.b + ')' });
        }
        items.push({ name: '浅海', color: 'rgb(70,110,160)' });
        items.push({ name: '深海', color: 'rgb(10,55,100)' });
      }

      const twoColumns = items.length > 10;
      const boxWidth = twoColumns ? 320 : 220;
      const boxHeight = mode === 'climate' ? 120 : 40 + (twoColumns ? Math.ceil(items.length / 2) : items.length) * 25;
      const startY = this.height - boxHeight - 20;

      ectx.save();
      ectx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      ectx.shadowColor = 'rgba(0,0,0,0.3)';
      ectx.shadowBlur = 10;
      ectx.fillRect(20, startY, boxWidth, boxHeight);
      ectx.restore();

      ectx.fillStyle = '#333';
      ectx.font = 'bold 20px sans-serif';
      ectx.textAlign = 'left';
      ectx.fillText(title, 35, startY + 30);

      ectx.font = '16px sans-serif';
      if (mode === 'climate') {
        ectx.fillStyle = '#333';
        ectx.fillText('温度 (冷 → 暖)', 35, startY + 60);
        let grad = ectx.createLinearGradient(35, 0, 185, 0);
        grad.addColorStop(0, '#0000ff');
        grad.addColorStop(1, '#ff0000');
        ectx.fillStyle = grad;
        ectx.fillRect(35, startY + 70, 150, 10);
        ectx.strokeStyle = '#555';
        ectx.strokeRect(35, startY + 70, 150, 10);

        ectx.fillStyle = '#333';
        ectx.fillText('湿度 (干 → 湿)', 35, startY + 100);
        grad = ectx.createLinearGradient(35, 0, 185, 0);
        grad.addColorStop(0, '#ffff00');
        grad.addColorStop(1, '#00ff00');
        ectx.fillStyle = grad;
        ectx.fillRect(35, startY + 110, 150, 10);
        ectx.strokeRect(35, startY + 110, 150, 10);
      } else {
        let xOffset = 35;
        let yOffset = startY + 50;
        const half = Math.ceil(items.length / 2);
        for (let i = 0; i < items.length; i++) {
          if (twoColumns && i === half) {
            xOffset += 145;
            yOffset = startY + 50;
          }
          const item = items[i];
          ectx.fillStyle = item.color;
          ectx.fillRect(xOffset, yOffset, 25, 18);
          ectx.fillStyle = '#333';
          ectx.fillText(item.name, xOffset + 35, yOffset + 14);
          yOffset += 25;
        }
      }
      return canvas.toDataURL('image/png');
    }
  }

  FM.MapRenderer = MapRenderer;
})(window);
