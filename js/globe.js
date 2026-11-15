/**
 * globe.js —— 3D 星球视图（星空 + 真实地形起伏 + 体积云 + 双层大气 + 地名精灵）
 *
 * 旧实现只是给一个光滑球体贴上 2D 地图纹理，没有任何几何起伏，
 * 也没有云层，看起来就是「贴了图的地球仪」。
 *
 * 本版本重建为五层结构（由外到内 / 按渲染顺序）：
 *
 *   0. 星空背景（StarField）
 *      程序化星图：深空渐变 + 分层星点 + 极淡银河带，固定种子（同一页面
 *      每次进入 3D 星图都一样，便于截图比对）。贴在一个 BackSide 大球上，
 *      而不是 scene.background —— 背景球会随相机转动产生正确的视差，
 *      也让星空真正「包住」星球。
 *
 *   1. 地表层（TerrainMesh）
 *      用 SphereGeometry 的顶点做**真实位移**（displacement）：
 *      按 2D 生成器的海拔数据，逐顶点沿法线方向外推。
 *      海洋保持球面，陆地从海平面开始隆起，最高峰约为球半径的 5.5%。
 *      同时用顶点法线自动计算光照，山体产生真实的明暗与阴影。
 *      材质用 MeshPhongMaterial + specularMap：海面反光、陆地哑光，
 *      法线贴图保留山体的细碎凹凸（见 #buildTerrain / #makeSpecularTexture）。
 *
 *   2. 云层（VolumetricClouds）
 *      在球面外侧覆盖一层半透明的程序化云。
 *      用多层噪声生成云团（而非均匀灰雾），并按纬度带控制云量
 *      （赤道对流云多、副热带少、中纬风暴带多）。
 *      云层独立于地表缓慢自转，产生立体感。
 *
 *   3. 双层大气（Atmosphere）
 *      内层：贴着云顶的薄边缘光（锐 Fresnel）；
 *      外层：更大半径的柔和辉光（宽 Fresnel）。
 *      两层都按太阳方向做昼/夜调制，并在星球剪影内侧淡出，
 *      避免旧版「边缘一圈发白过曝」的白带。
 *
 *   4. 地名精灵（LabelSprites）
 *      仅在「手绘地名图 / 手绘题名图」（named / lettered）模式下显示：
 *      从 renderer.getLabels() 取经纬度标签，每个标签一张 CanvasTexture，
 *      做成始终朝向相机的 THREE.Sprite，贴在球面上方（depthTest 让背面
 *      标签被球体遮住）。题名模式额外使用逐字手写与更大的字号。
 */
(function (root) {
  'use strict';

  const FM = root.FM = root.FM || {};

  /**
   * 位移强度：最高峰占球半径的比例。
   *
   * 真实地球的珠峰也只有半径的 0.14%，照搬几乎看不出起伏。
   * 这里取 0.055（约真实值的 40 倍）—— 属于「合理夸张」，
   * 让 3D 视图能明确看到山脉隆起，又不至于变成科幻星球。
   */
  const DISPLACEMENT = 0.055;
  /**
   * 云层相对地表的高度。
   *
   * 【必须高于最高峰】地表位移最大到 1 + DISPLACEMENT = 1.055。
   * 之前云层取 1.018，低于这个值 —— 于是海拔较高（相对高度 > 0.47）的山脉
   * 会直接戳出云层球壳，云被山体切开，轮廓上出现硬边。
   * 现在留 0.02 余量，云始终是「覆盖在地形之上的一层」。
   */
  const CLOUD_ALTITUDE = 1.075;
  /**
   * 大气层半径（双层）。
   *
   * 同理必须包住最高的山（1.055）与云层（1.075），否则大气辉光壳会被
   * 山峰/云顶穿，球体边缘出现一圈断掉的亮环。
   *
   * 【为什么改两层】旧版只有一层 Fresnel 壳：它既想当「紧贴地表的边缘光」，
   * 又想当「向外扩散的柔光」，结果 rim 曲线只能取中间值 —— 亮环太窄显得
   * 生硬，加宽又会把星球边缘糊成一条发白的亮带（截图里最明显的问题）。
   * 拆成两层后各司其职：内层锐而薄（勾边），外层宽而淡（氛围）。
   */
  const ATMOSPHERE_INNER_RADIUS = 1.16;
  // 外层壳半径远大于可见辉光范围（约 0.5R 外就衰减到 0），
  // 避免「亮带被球壳几何边缘切断」。
  const ATMOSPHERE_OUTER_RADIUS = 1.60;
  /**
   * 星空背景球半径。
   *
   * 只要远大于星球、又落在相机远裁剪面（1000）内即可。
   * 相机最近只到 1.15，所以 90 足够大、不会出现「星空被拖到眼前」。
   */
  const STAR_RADIUS = 90;
  /**
   * 星点所在半径（略小于背景球）。
   *
   * 【踩过的坑】早先这里写的是 `opts.radius || STAR_POINT_RADIUS`，
   * 但 STAR_POINT_RADIUS 从未定义 —— 进入 3D 时 init() 在 #buildStarField
   * 抛 ReferenceError，整个 3D 视图直接起不来。现在补上常量，
   * 并让星点落在背景球内侧 4% 处，避免与星空球壳共面产生 z-fighting。
   */
  const STAR_POINT_RADIUS = STAR_RADIUS * 0.96;
  /**
   * 地名精灵所在的球面半径。
   *
   * 【必须高于最高地形】地表位移最大到 1.055，精灵放在 1.068 ——留 0.013 余量，
   * 比云层（1.075）略低：云是半透明的，地名透过薄云反而更像「画在星球上」，
   * 且云层不写深度，不会遮住精灵。
   */
  const LABEL_RADIUS = 1.068;
  /** 精灵数量上限：每张标签一张纹理，40 张是「清晰度 / 显存 / 排序开销」的折中 */
  const LABEL_MAX = 40;
  /**
   * 标签字体栈：与 2D「手绘地名图」模式保持一致。
   * 楷体在 Windows / macOS 上都可命中（KaiTi / STKaiti / 楷体），
   * 最后退到 cursive，保证任何系统都有个手写感字体兜底。
   */
  const LABEL_FONT_STACK = '"KaiTi", "STKaiti", "楷体", "Kaiti SC", "STXihei", "cursive"';
  /**
   * 3D 经纬网半径。
   *
   * 地表最高峰在 1 + DISPLACEMENT = 1.055，网格线放在 1.062 ——
   * 贴在山峰上方一点点，既不会被山体吞掉，也不会像「套在球外的笼子」。
   * 地名精灵在 1.068，仍高于网格，保证文字不会被线穿。
   */
  const GRATICULE_RADIUS = 1.062;
  /** 手绘类模式：3D 要像「画在纸上的地球仪」，而不是写实卫星星球 */
  const HAND_MODES = { handdrawn: true, named: true, lettered: true };

  /**
   * 标记「颜色贴图」为 sRGB。
   *
   * 【踩过的坑】three.js r128 用的是 texture.encoding，r152+ 改叫 colorSpace。
   * 之前只写了 `if (THREE.SRGBColorSpace) tex.colorSpace = ...` —— 在 r128 上
   * 该分支永远不执行，贴图因此被当成**线性数据**采样；而渲染器又开着
   * `outputEncoding = sRGBEncoding`，输出时再编码一次 sRGB，
   * 等于对颜色做了双重 gamma —— 实测平均提亮 +57、最坏 +133（整张球发白发灰）。
   * 这里两种 API 都兜住，颜色才能与 2D 画布一致。
   *
   * 注意：只对**颜色**贴图调用；粗糙度/法线属于线性数据，不能标 sRGB。
   */
  function markSRGBTexture(tex) {
    if (!tex || typeof THREE === 'undefined') return tex;
    if (THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
    if (THREE.SRGBColorSpace !== undefined) tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /**
   * 确定性伪随机数（mulberry32）。
   *
   * 星空必须「随机但可复现」：每次进入 3D、每次截图都应该得到同一片星空，
   * 否则调参只能凭运气，也没法和别的截图逐像素对比。
   * 这里用固定种子的 mulberry32（32 位状态、无外部依赖），
   * 与 Math.random() 无关 —— 页面里其它模块调用 Math.random 不会影响它。
   */
  function makeRandom(seed) {
    let a = seed >>> 0;
    return function random() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** 平滑阶梯，与 GLSL smoothstep 同义（three 的 saturate 辅助） */
  function smoothstepLocal(edge0, edge1, x) {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0 || 1e-6)));
    return t * t * (3 - 2 * t);
  }

  class GlobeView {
    constructor(options) {
      this.container = options.container;
      this.renderer = options.renderer;
      this.generator = options.generator;
      this.canvas2d = options.canvas2d;

      this.scene = null;
      this.camera = null;
      this.globeRenderer = null;
      this.globe = null;
      this.cloudMesh = null;
      /** 外层大气（保留旧字段名，外层是视觉主体） */
      this.atmosphere = null;
      /** 内层大气（薄边缘光） */
      this.atmosphereInner = null;
      /** 星空背景球 */
      this.starField = null;
      this.controls = null;
      this.animationId = null;
      this.active = false;
      this.texture = null;
      /** 海面高光遮罩：海=白、陆=黑（线性数据，不能标 sRGB） */
      this.specularTexture = null;
      this.normalTexture = null;
      this.cloudTexture = null;
      this.starTexture = null;

      /** 地名精灵：Group 跟随地表朝向，内部每个标签一个 Sprite */
      this.labelGroup = null;
      this.labelSprites = [];
      /** 上次 refreshLabels 时的模式，避免原地重复重建纹理 */
      this._labelMode = null;
      /** 3D 经纬网（跟随地表朝向） */
      this.graticule = null;
      /** 主光 / 环境光 / 轮廓光：按 2D 显示模式调色（见 #applyViewModeStyle） */
      this.sunLight = null;
      this.ambientLight = null;
      this.rimLight = null;
      /** 当前已应用的 2D 显示模式（避免重复改材质） */
      this._styleMode = null;
      /** 2D 侧重绘时若不在 3D，只记脏；下次进入 3D 再更新贴图/地形 */
      this._textureDirty = false;
      /** 各阶段初始化耗时（ms），供性能自查 / 控制台查看 */
      this.lastTimings = null;

      /** 云层自转速度 */
      this.cloudSpin = 0;
      /** 云层基准朝向（与地表一致），自转在此基础上叠加 */
      this.cloudBaseAngle = -Math.PI / 2;
      /** 是否显示云层 */
      this.showClouds = true;
    }

    static get available() {
      return typeof THREE !== 'undefined';
    }

    get is3D() {
      return this.active;
    }

    // ==================== 场景初始化 ====================

    init() {
      if (this.scene) return;
      const container = this.container;
      const W = container.clientWidth;
      const H = container.clientHeight;

      this.scene = new THREE.Scene();
      // 【星空背景】不再用 scene.background 的纯黑/深蓝纯色：
      // 纯色背景在截图里就是「一片死黑」，星球像悬在虚空里。
      // 改为程序化星空球（#buildStarField），本行只为极端情况兜底。
      this.scene.background = null;

      // 相机距离 3.25：旧值 2.9 让球体几乎顶满容器（截图里球被上下切掉），
      // 稍微拉远给星球留出「呼吸空间」，也能同时看到大气与星空。
      this.camera = new THREE.PerspectiveCamera(40, W / H, 0.01, 1000);
      this.camera.position.set(0, 0, 3.25);

      // antialias 关闭：球体边缘的锯齿几乎看不出来，
      // 但能省下 2~4 倍的填充率开销（半透明云 + 大气层 overdraw 很吃性能）。
      // 需要抗锯齿时可用 CSS 或后处理，代价是可选的。
      this.globeRenderer = new THREE.WebGLRenderer({ antialias: false });
      this.globeRenderer.setSize(W, H);
      // pixelRatio 限制到 1.5：2x 屏幕上有 4 倍像素，性能代价过大
      this.globeRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      if ('outputEncoding' in this.globeRenderer && THREE.sRGBEncoding !== undefined) {
        this.globeRenderer.outputEncoding = THREE.sRGBEncoding;
      }
      const dom = this.globeRenderer.domElement;
      dom.id = 'threeCanvas';
      dom.style.position = 'absolute';
      dom.style.top = '0';
      dom.style.left = '0';
      dom.style.width = '100%';
      dom.style.height = '100%';
      container.appendChild(dom);

      // 逐阶段计时：初始化失败或「进 3D 要等很久」时，这几项数字能直接指出
      // 是贴图、云层还是着色器编译慢（控制台：__FM_APP__.globe.lastTimings）。
      const initStart = performance.now();
      const timings = [];
      const mark = (name, t) => {
        timings.push({ name, ms: +(performance.now() - t).toFixed(1) });
      };

      let t = performance.now();
      this.texture = this.#makeTexture();
      this.specularTexture = this.#makeSpecularTexture();
      this.normalTexture = this.#makeNormalTexture();
      mark('地表/高光/法线贴图', t);

      t = performance.now();
      this.cloudTexture = this.#makeCloudTexture();
      mark('云层贴图', t);

      t = performance.now();
      this.starTexture = this.#makeStarTexture();
      this.#buildStarField();
      mark('星空贴图+背景球', t);

      t = performance.now();
      this.#buildTerrain();
      this.#buildClouds();
      this.#buildAtmosphere();
      this.#buildLights();
      this.#buildGraticule();
      mark('几何体与材质', t);

      t = performance.now();
      this.labelGroup = new THREE.Group();
      // 与地表同朝向（贴图 repeat.x = -1 + 球体绕 Y -90° 的补偿链，见 #buildTerrain）
      this.labelGroup.rotation.y = this.globe ? this.globe.rotation.y : -Math.PI / 2;
      this.scene.add(this.labelGroup);
      // 3D 的配色 / 光照 / 云量跟随当前 2D 显示模式（手绘模式得到温暖的地球仪）
      this.#applyViewModeStyle();
      mark('地名层初始化', t);

      this.lastTimings = timings;
      /** init() 总耗时（ms），供性能自查 */
      this.lastInitTotalMs = +(performance.now() - initStart).toFixed(1);

      this.controls = new THREE.OrbitControls(this.camera, dom);
      this.controls.enablePan = false;
      this.controls.minDistance = 1.15;
      this.controls.maxDistance = 6.0;
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.06;
      // 让用户能俯视/仰视，观察极地
      this.controls.minPolarAngle = 0.05;
      this.controls.maxPolarAngle = Math.PI - 0.05;

      window.addEventListener('resize', () => this.#onResize());

      this._textureDirty = false;
      // 首次进入 3D 时如果已经处于手绘地名模式，立刻补上精灵
      this.refreshLabels();
    }

    /** 标记「2D 已重绘、3D 贴图/地形待同步」，等真正进入 3D 时再付这笔开销 */
    markTextureDirty() {
      this._textureDirty = true;
    }

    // ==================== 地表：真实顶点位移 ====================

    /**
     * 构建带位移的地表网格。
     *
     * 做法：
     *   1. 用较高的细分（256×128）保证山脊不会变成锯齿；
     *   2. 遍历每个顶点，把它的球面坐标换算成 2D 地图的经纬度；
     *   3. 采样该处的海拔，沿法线方向外推 —— 海洋不动，陆地隆起；
     *   4. 重新计算法线，让光照产生真实的山体明暗。
     */
    #buildTerrain() {
      const generator = this.generator;
      const sea = generator.seaLevel;
      const cells = generator.cells;
      const mapW = generator.width;
      const mapH = generator.height;

      // 细分度：256 段经度 × 128 段纬度，约 33k 顶点，兼顾山脊细节与性能
      const geo = new THREE.SphereGeometry(1, 256, 128);
      const pos = geo.attributes.position;
      const count = pos.count;

      // 采样海拔（双线性），并做轻微平滑避免单格尖刺
      const sampleElev = (lonN, latN) => {
        // lonN ∈ [0,1)，latN ∈ [0,1)（0=北极）
        let fx = lonN * mapW;
        let fy = latN * (mapH - 1);
        fx = ((fx % mapW) + mapW) % mapW;
        fy = Math.max(0, Math.min(mapH - 1, fy));
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const x1 = (x0 + 1) % mapW;
        const y1 = Math.min(mapH - 1, y0 + 1);
        const tx = fx - x0;
        const ty = fy - y0;
        const e00 = cells[y0 * mapW + x0].e;
        const e10 = cells[y0 * mapW + x1].e;
        const e01 = cells[y1 * mapW + x0].e;
        const e11 = cells[y1 * mapW + x1].e;
        return (e00 * (1 - tx) + e10 * tx) * (1 - ty) + (e01 * (1 - tx) + e11 * tx) * ty;
      };

      // 归一化陆地高度（0=海平面, 1=最高峰）
      let maxLandRel = 0.0001;
      for (let i = 0; i < cells.length; i++) {
        if (cells[i].e >= sea) {
          const rel = (cells[i].e - sea) / (1 - sea);
          if (rel > maxLandRel) maxLandRel = rel;
        }
      }

      const v = new THREE.Vector3();
      for (let i = 0; i < count; i++) {
        v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
        // 从球面坐标反推经纬度
        const lat = Math.asin(Math.max(-1, Math.min(1, v.y))); // -PI/2 ~ PI/2
        const lon = Math.atan2(v.z, v.x);                       // -PI ~ PI
        const latN = 0.5 - lat / Math.PI;   // 0=北极, 1=南极
        const lonN = lon / (Math.PI * 2) + 0.5;

        const e = sampleElev(lonN, latN);
        // 只有陆地隆起；海洋保持球面（真实地球也是海洋近乎球面）
        let h = 0;
        if (e >= sea) {
          const rel = Math.max(0, Math.min(1, (e - sea) / (1 - sea) / maxLandRel));
          // 用 pow 让低海拔平缓、高峰突出，形成真实的大陆架轮廓
          h = Math.pow(rel, 1.35) * DISPLACEMENT;
        }
        // 沿法线外推
        const len = v.length() || 1;
        const scale = (1 + h) / len;
        pos.setXYZ(i, v.x * scale, v.y * scale, v.z * scale);
      }
      pos.needsUpdate = true;
      geo.computeVertexNormals();

      // ============ 地表材质：Phong + 高光遮罩 ============
      //
      // 【为什么从 Standard 换成 Phong】
      // 需求的核心是「海面有太阳高光、陆地哑光」。MeshStandardMaterial 的
      // 高光由 roughnessMap 控制，但它没有 specularMap —— 海面想亮只能把
      // roughness 调低，可粗糙度是全局标量 × 贴图，海陆的差别只能靠 150/235
      // 这么小的比值（≈0.59 vs 0.92），高光糊成一片灰白，看不出「反光」。
      //
      // Phong 的 specularMap 是**逐像素**的：海面写白（镜面反射）、陆地写黑
      // （完全哑光），再配合 shininess 控制高光斑的锐度。于是海面出现一枚
      // 太阳倒影，陆地依旧哑光 —— 这是「星球感」最便宜也最有效的一笔。
      //
      // 【必须保留的部分】
      //   · normalMap + normalScale 不动：山体表面的细碎凹凸全靠它，
      //     去掉地形细节就重新变成「光滑贴图球」。
      //   · metalness 概念在 Phong 里不存在（Phong 本来就不是金属模型），
      //     默认就是 0，不会出现金属白斑。
      //
      // 【高光不能爆白】shininess 60 + 偏暗的 specular（0x1b3a58）：
      // 峰值亮度 ≈ specular * 光强（1.85）≈ 0.4~0.65，叠在海洋漫反射上
      // 仍是「亮蓝白」而不是纯白斑。旧版 roughness 150 的教训见
      // #makeSpecularTexture 的注释。
      const material = new THREE.MeshPhongMaterial({
        map: this.texture,
        normalMap: this.normalTexture,
        normalScale: new THREE.Vector2(0.6, 0.6),
        specularMap: this.specularTexture,
        specular: new THREE.Color(0x1b3a58),
        shininess: 60,
      });

      this.globe = new THREE.Mesh(geo, material);
      // 【朝向】贴图 x 方向做了镜像（repeat.x = -1）以匹配球体 UV，
      // 绕 Y 轴 -90° 后，地图 x = W/2（经度 0°）正好朝向相机：
      // 于是「2D 地图中央」在 3D 里就是正面，不会出现进入 3D 后
      // 画面跳到地图另一侧、与 2D 中心对不上的错位感。
      this.globe.rotation.y = -Math.PI / 2;
      this.scene.add(this.globe);
    }

    /**
     * 在 3D 里重新生成 / 导入地图后，刷新顶点位移。
     *
     * 【为什么不是重建整个 Mesh】颜色贴图由 updateTexture 换掉，但顶点位置
     * 是几何体属性，不跟着贴图走 —— 旧版本只换贴图，于是新地图会贴在
     * **上一张地图的地形起伏**上（山脊与纹理对不上）。这里把现有顶点归一化
     * 回单位球（位移是沿法线的径向操作，归一化即可还原方向），再按新海拔
     * 重新外推，最后重算法线。33k 顶点，开销远小于重建 Mesh。
     */
    #refreshTerrainGeometry() {
      const generator = this.generator;
      if (!generator || !this.globe || !this.globe.geometry) return;
      const sea = generator.seaLevel;
      const cells = generator.cells;
      const mapW = generator.width;
      const mapH = generator.height;
      const geo = this.globe.geometry;
      const pos = geo.attributes.position;
      const count = pos.count;
      if (!count) return;

      const sampleElev = (lonN, latN) => {
        let fx = lonN * mapW;
        let fy = latN * (mapH - 1);
        fx = ((fx % mapW) + mapW) % mapW;
        fy = Math.max(0, Math.min(mapH - 1, fy));
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const x1 = (x0 + 1) % mapW;
        const y1 = Math.min(mapH - 1, y0 + 1);
        const tx = fx - x0;
        const ty = fy - y0;
        const e00 = cells[y0 * mapW + x0].e;
        const e10 = cells[y0 * mapW + x1].e;
        const e01 = cells[y1 * mapW + x0].e;
        const e11 = cells[y1 * mapW + x1].e;
        return (e00 * (1 - tx) + e10 * tx) * (1 - ty) + (e01 * (1 - tx) + e11 * tx) * ty;
      };

      let maxLandRel = 0.0001;
      for (let i = 0; i < cells.length; i++) {
        if (cells[i].e >= sea) {
          const rel = (cells[i].e - sea) / (1 - sea);
          if (rel > maxLandRel) maxLandRel = rel;
        }
      }

      const v = new THREE.Vector3();
      for (let i = 0; i < count; i++) {
        v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize();
        const lat = Math.asin(Math.max(-1, Math.min(1, v.y)));
        const lon = Math.atan2(v.z, v.x);
        const latN = 0.5 - lat / Math.PI;
        const lonN = lon / (Math.PI * 2) + 0.5;
        const e = sampleElev(lonN, latN);
        let h = 0;
        if (e >= sea) {
          const rel = Math.max(0, Math.min(1, (e - sea) / (1 - sea) / maxLandRel));
          h = Math.pow(rel, 1.35) * DISPLACEMENT;
        }
        const scale = 1 + h;
        pos.setXYZ(i, v.x * scale, v.y * scale, v.z * scale);
      }
      pos.needsUpdate = true;
      geo.computeVertexNormals();
    }

    // ==================== 体积云 ====================

    /**
     * 构建云层。
     *
     * 用一张程序化生成的云图（多层噪声叠加，按纬度带控制云量）
     * 贴在略大于地表的球面上，双面渲染、半透明。
     * 云层独立自转，产生云影移动的立体感。
     */
    #buildClouds() {
      const geo = new THREE.SphereGeometry(CLOUD_ALTITUDE, 128, 64);
      const mat = new THREE.MeshLambertMaterial({
        map: this.cloudTexture,
        transparent: true,
        // 云是"薄纱"不是"棉被"：整体透明度压到 0.58，
        // 能透出下方地形与海面高光（0.70 会把地表糊住，云层细节也一起糊掉）。
        // 云图本身已经带了 alpha（见 #makeCloudTexture），这里再乘一层整体透明度。
        opacity: 0.58,
        depthWrite: false,
        // 球面云层只需正面渲染：DoubleSide 会让每个像素画两次（overdraw），
        // 而云的背面永远不会朝向相机，纯属浪费。
        side: THREE.FrontSide,
        blending: THREE.NormalBlending,
      });
      this.cloudMesh = new THREE.Mesh(geo, mat);
      // 与地表保持同一基准朝向（否则云会相对陆地整体偏转 90°）
      this.cloudMesh.rotation.y = this.cloudBaseAngle;
      this.cloudMesh.visible = this.showClouds;
      this.scene.add(this.cloudMesh);
    }

    /**
     * 程序化云图。
     *
     * 云的形成与大气环流有关：
     *   · 赤道低压带：上升气流 → 对流云旺盛（多云）
     *   · 副热带高压带（±30°）：下沉气流 → 晴朗少云
     *   · 中纬西风带：气旋活跃 → 多云
     *   · 极地：温度低，云量少
     * 这里按纬度调制云量，再用多层噪声生成云团形状。
     */
    #makeCloudTexture() {
      // ============ 分辨率：1536×768 ============
      //
      // 【为什么从 1024×512 提到 1536×768】旧版云层「糊」的直接原因是贴图
      // 分辨率不够：1024 宽在 2π 周长上只有 2.8 px/度，云絮边缘被放大成
      // 一团团棉球，球面上的云看起来像贴纸。
      //
      // 提到 1536×768（像素量 ×2.25）后，云边细节足够在球面上撑住；
      // 再高（2048×1024）视觉收益明显递减，而初始化要多花约 2.5 秒
      // （噪声调用量随像素数线性增长），得不偿失。
      //
      // 【为什么低频噪声在半分辨率网格上采样】基频 14 的云场特征尺度约
      // 110 px，逐像素调用 noiseSeamless（5 个八度）纯属浪费：在 1/2 分辨率
      // 网格上采样一次再双线性插值，球面上肉眼看不出差别，却省掉 3/4 的
      // 计算量。基频 34/78 与边缘噪声仍逐像素算，保证云絮边缘的锐度。
      const W = 1536;
      const H = 768;
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext('2d');
      const img = ctx.createImageData(W, H);
      const data = img.data;
      /** 云的不透明度，极冠收敛后再统一写入像素 */
      const alphaBuf = new Float32Array(W * H);

      const noise = this.generator ? this.generator.noiseSeamless.bind(this.generator) : null;
      if (!noise) return new THREE.CanvasTexture(canvas);

      // ==================== 飓风（热带气旋）====================
      //
      // 真实热带气旋的特征：
      //   · 只生成在低纬（约 5°~25°），赤道正上方因科氏力为零不会形成；
      //   · 中心是「眼」——晴空、无云，外围是密集的螺旋云带；
      //   · 云带绕中心旋转，形成螺旋臂；
      //   · 生命史有限，因此同一时刻只有少数几个。
      //
      // 这里在云图上叠加若干个程序化的螺旋风暴结构。
      // 坐标为「贴图像素」，但用 cos(lat) 修正经度尺度，
      // 保证风暴在球面上是圆的而不是被极点拉伸成椭圆。
      const storms = [];
      const stormCount = 5 + Math.floor(Math.random() * 4); // 5~8 个
      for (let s = 0; s < stormCount; s++) {
        // 纬度落在 5°~25°（南北半球都有可能），避免赤道
        const hemi = Math.random() < 0.5 ? 1 : -1;
        const latDeg = (5 + Math.random() * 20) * hemi;
        const latN = latDeg / 180; // -0.5~0.5 对应 -90~90
        // 经度随机
        const lonN = Math.random();
        // 风暴半径（以球面角计，约 3°~7°）
        const radiusDeg = 3 + Math.random() * 4;
        storms.push({
          latN,
          lonN,
          radius: radiusDeg / 180,   // 归一化到 latN 的单位
          spin: Math.random() < 0.5 ? 1 : -1, // 旋转方向（南北半球相反）
          intensity: 0.75 + Math.random() * 0.25,
        });
      }

      // ---------- 低频云场 n1 的半分辨率网格 ----------
      //
      // GW = W/2（偶数，保证经度方向环绕插值闭合）、GH = H/2 + 1
      // （多一行给最南一行 y=H-1 的插值用）。
      // 注意 gy 与 ny 的换算必须与逐像素时完全一致：ny = y/H - 0.5，
      // y = 2*gy → ny = 2*gy/H - 0.5。写错一位云图就会在纬度上整体偏移。
      const GW = W >> 1;
      const GH = (H >> 1) + 1;
      const n1Grid = new Float32Array(GW * GH);
      for (let gy = 0; gy < GH; gy++) {
        const gyLatN = ((gy * 2) / H) - 0.5;
        for (let gx = 0; gx < GW; gx++) {
          const gxLonN = (gx * 2) / W;
          n1Grid[gy * GW + gx] = noise(gxLonN, gyLatN + 11, 14, 5, 0.55, 2, 901) * 0.5 + 0.5;
        }
      }
      /** 双线性取样 n1 网格：经度环绕、纬度钳制 */
      const sampleN1 = (px, py) => {
        const gxf = px * 0.5;
        const gyf = py * 0.5;
        const x0 = gxf | 0;
        const y0 = gyf | 0;
        const tx = gxf - x0;
        const ty = gyf - y0;
        const x1 = x0 + 1 >= GW ? 0 : x0 + 1;   // 经度方向环绕，接缝天然闭合
        const y1 = y0 + 1 >= GH ? GH - 1 : y0 + 1;
        const a = n1Grid[y0 * GW + x0];
        const b = n1Grid[y0 * GW + x1];
        const c = n1Grid[y1 * GW + x0];
        const d = n1Grid[y1 * GW + x1];
        const top = a + (b - a) * tx;
        const bot = c + (d - c) * tx;
        return top + (bot - top) * ty;
      };

      for (let y = 0; y < H; y++) {
        const latN = y / H - 0.5;       // -0.5 ~ 0.5
        const absLat = Math.abs(latN * 2); // 0 ~ 1
        // 云量：赤道峰 + 中纬峰 - 副热带谷 - 极地递减
        const itcz = Math.exp(-((absLat / 0.13) ** 2)) * 1.0;
        const midLat = Math.exp(-(((absLat - 0.62) / 0.18) ** 2)) * 0.75;
        const subtropical = Math.exp(-(((absLat - 0.34) / 0.11) ** 2)) * 0.85;
        // 【极区云量】旧参数 (absLat - 0.80) * 0.5 在极点只压掉 0.10 的预算，
        // 极区仍是浓云；再叠上等距圆柱极点行的收敛，球顶/球底就出现一圈
        // 糊状白带（截图里最扎眼的问题之一）。现在从 |lat| ≈ 72° 开始快速
        // 抑制，到极点预算基本清零，极区变成「稀薄卷云」而不是厚云盖。
        const polar = Math.max(0, absLat - 0.72) * 1.35;
        const cloudBudget = Math.max(0, 0.30 + itcz - subtropical + midLat - polar);

        // 经度尺度的修正因子：高纬经线收拢，贴图上 1 像素代表的实际距离更小
        const lonScale = Math.max(0.05, Math.cos(latN * Math.PI));

        for (let x = 0; x < W; x++) {
          const nx = x / W;
          const ny = latN;

          // ---------- 基础云场（三层噪声）----------
          //
          // 【曾经的做法（错误）】把经度坐标压成 corrU = (nx-0.5)*cos(lat)+0.5，
          // 想补偿「高纬经线收拢」。但 noiseSeamless 内部已经是把 (nx, ny) 映射到
          // **球面单位向量**再取 3D 噪声，特征本来就是物理各向同性的；
          // 再做一次压缩等于把高纬云团沿经度挤扁 → 球面上变成绕极点的径向细条
          // （用户反馈的「极地纹理拉伸」）。而且这个映射把 [0,1] 压成子区间，
          // nx=0 与 nx=1 采到不同的值 → 云图左右边缘对不上（接缝）。
          //
          // 正确做法：直接把 nx 交给 noiseSeamless，接缝天然连续、特征天然各向同性。
          // n1 走半分辨率网格（见上）；n2/n3 逐像素，保留云絮的中高频形状
          const n1 = sampleN1(x, y);
          const n2 = noise(nx, ny + 23, 34, 4, 0.5, 2, 902) * 0.5 + 0.5;
          const n3 = noise(nx, ny + 37, 78, 3, 0.5, 2, 903) * 0.5 + 0.5;
          let cloud = n1 * 0.55 + n2 * 0.30 + n3 * 0.15;

          // ---------- 叠加飓风 ----------
          let stormAlpha = 0;
          for (let si = 0; si < storms.length; si++) {
            const st = storms[si];
            // 到风暴中心的距离（经度按 cos(lat) 修正，保证球面上是正圆）
            let dLon = nx - st.lonN;
            if (dLon > 0.5) dLon -= 1;
            if (dLon < -0.5) dLon += 1;
            const dLat = ny - st.latN;
            const dist = Math.sqrt((dLon * lonScale) ** 2 + dLat ** 2);
            if (dist > st.radius * 1.6) continue;

            const rNorm = dist / st.radius; // 0=中心, 1=边缘

            // 螺旋臂：角度 + 距离决定相位
            let ang = Math.atan2(dLat, dLon * lonScale);
            const spiral = Math.sin(ang * 2 + rNorm * 9 * st.spin) * 0.5 + 0.5;

            // 眼墙：中心是晴空（台风眼），一圈强对流，外面逐渐减弱
            let ring;
            if (rNorm < 0.16) {
              // 台风眼：几乎无云
              ring = 0.05;
            } else if (rNorm < 0.34) {
              // 眼墙：最强
              ring = 1.0;
            } else {
              // 外围螺旋云带：随距离衰减，叠加螺旋调制
              ring = Math.max(0, 1 - (rNorm - 0.34) / 1.1) * (0.45 + spiral * 0.55);
            }
            ring *= st.intensity;
            if (ring > stormAlpha) stormAlpha = ring;
          }

          // 风暴云并入基础云场（取最大值，避免叠加过亮）
          cloud = Math.max(cloud, stormAlpha);

          // ============ 生成云的 alpha ============
          //
          // 【难点】要同时满足三点：
          //   · 不稀疏（用户第一版的反馈）
          //   · 不糊成一片白（阈值过低）
          //   · 边缘要蓬松，不能像贴纸（阈值过渡太窄）
          //
          // 关键：噪声叠加后 cloud 落在 0.35~0.65，必须用「相对该范围」的
          // 阈值，且过渡带宽要足够（0.10 → 0.22），才能得到柔和的云絮边缘。
          // 同时用 fractal detail 做二次调制，打破纯噪声的块状感。
          const threshold = 0.58 - cloudBudget * 0.20;
          let alpha = 0;
          if (cloud > threshold) {
            alpha = Math.min(1, (cloud - threshold) / 0.22);
            // 用两级细粒度噪声扰动边缘，产生"棉絮"轮廓而不是圆形团块：
            //   edge1（基频 210）：云絮的主体锯齿；
            //   edge2（基频 430）：更细的毛边，负责在 1536 宽下把云边
            //   从「光滑圆团」打碎成「丝絮」。少了这一层，即便贴图分辨率
            //   提高，云边依然显得像贴纸（旧版就是这个问题）。
            const edge1 = noise(nx, ny + 71, 210, 3, 0.5, 2, 904) * 0.5 + 0.5;
            const edge2 = noise(nx, ny + 93, 430, 2, 0.5, 2, 905) * 0.5 + 0.5;
            // 0.40 + 0.52*edge1 + 0.26*edge2 → 约 0.40 ~ 1.18，钳到 1
            alpha *= 0.40 + edge1 * 0.52 + edge2 * 0.26;
            alpha = Math.min(1, alpha);
          }
          // 边缘柔化，避免硬边
          alpha = alpha * alpha * (3 - 2 * alpha);
          // 云朵亮度：厚处偏白，薄处略带灰蓝
          // 云朵亮度：厚处偏白，薄处略带灰蓝（纯 255 白在球面上会过曝）
          const shade = 0.70 + cloud * 0.30;
          const i4 = (y * W + x) * 4;
          data[i4] = Math.min(255, 246 * shade + 4);
          data[i4 + 1] = Math.min(255, 248 * shade + 4);
          data[i4 + 2] = Math.min(255, 252 * shade + 3);
          // alpha 先缓存，极冠处理后再写入（见下方）
          alphaBuf[y * W + x] = alpha;
        }
      }

      // ============ 极冠收敛（云）============
      //
      // 云图同样是等距圆柱：|lat| > 80° 的整行会收拢到一点，
      // 行内的云量差异被投射成绕极点的放射状条纹。
      // 这里把极区各行的 alpha 向该行均值混合，让极地成为均匀的薄云/晴空，
      // 与地表的极冠处理保持一致。
      // poleDist 同样是「到极点的角距离」：极点 0、赤道 90。
      // 只在极区（poleDist < 10°，即 |lat| > 80°）处理，权重随靠近极点而增大。
      // 【旧版白带的另一半原因】收敛目标取的是「该行平均 alpha」——极区
      // 只要有一半经度有云，整行就会被拉成均匀的半透明白环；越靠极点
      // 这一行在球面上越收拢成一个点，白环叠成白斑。
      // 现在目标值下调到 mean * 0.45（极区只保留稀薄卷云），并额外按
      // 极距做一次淡出，极点附近几乎无云。
      const CAP_ZONE = 14;
      for (let y = 0; y < H; y++) {
        const latDeg = 90 - ((y + 0.5) / H) * 180;
        const poleDist = 90 - Math.abs(latDeg);
        if (poleDist >= CAP_ZONE) continue;
        const base = y * W;
        let sum = 0;
        for (let x = 0; x < W; x++) sum += alphaBuf[base + x];
        const mean = sum / W;
        let w = 1 - poleDist / CAP_ZONE;
        w = w * w * (3 - 2 * w);
        // 收敛目标：行均值的一半，再随极距再做一次平方衰减
        const polarFade = 1 - w * 0.45;
        const target = mean * 0.45 * polarFade;
        for (let x = 0; x < W; x++) {
          const k = base + x;
          alphaBuf[k] += (target - alphaBuf[k]) * w;
        }
      }
      for (let i = 0; i < W * H; i++) {
        data[i * 4 + 3] = Math.round(Math.min(1, alphaBuf[i]) * 255);
      }

      ctx.putImageData(img, 0, 0);

      const tex = new THREE.CanvasTexture(canvas);
      markSRGBTexture(tex);
      tex.wrapS = THREE.RepeatWrapping;
      tex.repeat.x = -1;
      return tex;
    }

    // ==================== 星空背景 ====================

    /**
     * 程序化星空贴图（等距圆柱，2048×1024）。
     *
     * 构成：
     *   1. 深空渐变：顶部深蓝 → 中段偏蓝紫 → 底部略暖（极夜方向），
     *      避免整张图是纯黑（纯黑背景在截图里就是一块死色）。
     *   2. 银河带：一条倾斜的大圆，用一串低透明度的柔和光斑堆出来。
     *      不逐像素算噪声，绘制开销可忽略。
     *   3. 星尘：约 900 颗极淡的小点，只作为「银河里的尘埃」增加层次；
     *      真正会被看到的星星是 Points（见 #buildStarField）。
     *
     * 【为什么不把星星画在这张贴图上】这是第一版踩的坑：背景球半径 90，
     * 视野只覆盖球面约 40°，一张 2048 宽的贴图在这一小片区域会被放大
     * 8~10 倍 —— 贴图里 2px 的星点到了屏幕上就是 20px 的模糊光斑，整片
     * 星空看起来像虚焦的散景。而且等距圆柱的极点会把星点拉成经向细条。
     * 现在星点改用 THREE.Points（sizeAttenuation=false，尺寸直接以屏幕
     * 像素计），无论球多大都保持锐利圆点、也不会被极点拉伸；这张贴图
     * 只负责「平滑的深空底色 + 银河」，放大多少倍都不失真。
     *
     * 【为什么不用 scene.background】纯色/贴图背景在 r128 里是一个贴在
     * 屏幕上的平面，转动相机时星空纹丝不动，像贴在镜头前的一张纸；
     * 用 BackSide 大球则让星空真正「包住」星球，随视角产生视差。
     */
    #makeStarTexture() {
      const W = 2048;
      const H = 1024;
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext('2d');
      const rnd = makeRandom(0x51a2f00d);

      // ---------- 1) 深空渐变 ----------
      const bg = ctx.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0.00, '#04060e');
      bg.addColorStop(0.30, '#070c1a');
      bg.addColorStop(0.52, '#0a1020');
      bg.addColorStop(0.74, '#090d18');
      bg.addColorStop(1.00, '#0e0c12');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);

      // 一条很淡的横向亮度带，让深空不是「纯色平涂」
      const haze = ctx.createLinearGradient(0, H * 0.16, 0, H * 0.74);
      haze.addColorStop(0, 'rgba(30, 46, 84, 0)');
      haze.addColorStop(0.45, 'rgba(34, 52, 96, 0.15)');
      haze.addColorStop(1, 'rgba(30, 46, 84, 0)');
      ctx.fillStyle = haze;
      ctx.fillRect(0, 0, W, H);

      // ---------- 2) 银河带 ----------
      // 球面方向 → 贴图像素
      const toCanvas = (d) => {
        const lat = Math.asin(Math.max(-1, Math.min(1, d.y)));
        const lon = Math.atan2(d.z, d.x);
        return [(lon / (Math.PI * 2) + 0.5) * W, (0.5 - lat / Math.PI) * H];
      };
      const drawBlob = (cx, cy, r, rgb, alpha) => {
        const draw = (x) => {
          const g = ctx.createRadialGradient(x, cy, 0, x, cy, r);
          g.addColorStop(0, 'rgba(' + rgb + ', ' + alpha + ')');
          g.addColorStop(0.5, 'rgba(' + rgb + ', ' + (alpha * 0.42) + ')');
          g.addColorStop(1, 'rgba(' + rgb + ', 0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(x, cy, r, 0, Math.PI * 2);
          ctx.fill();
        };
        // 经度方向环绕：贴着接缝的光斑要在另一侧补一份，否则接缝处有断口
        draw(cx);
        if (cx - r < 0) draw(cx + W);
        if (cx + r > W) draw(cx - W);
      };

      // 大圆法向量：稍微倾斜，看起来像真实的银河走向
      const n = new THREE.Vector3(0.36, 0.62, -0.70).normalize();
      const helper = Math.abs(n.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
      const u = new THREE.Vector3().crossVectors(helper, n).normalize();
      const v = new THREE.Vector3().crossVectors(n, u).normalize();
      const dir = new THREE.Vector3();

      // 沿大圆撒柔和光斑：宽约 ±0.09 rad，中心稍亮
      for (let i = 0; i < 520; i++) {
        const t = rnd() * Math.PI * 2;
        // 用三次均匀分布之和做「中间密、两边稀」的抖动
        const wobble = (rnd() + rnd() + rnd() - 1.5) * 0.085;
        dir.copy(u).multiplyScalar(Math.cos(t))
          .addScaledVector(v, Math.sin(t))
          .addScaledVector(n, wobble)
          .normalize();
        const [sx, sy] = toCanvas(dir);
        const r = 80 + rnd() * 150;
        const rgb = rnd() < 0.5 ? '150, 158, 200' : '176, 166, 190';
        drawBlob(sx, sy, r, rgb, 0.018 + rnd() * 0.030);
      }

      // ---------- 3) 星尘（真正的星星在 #buildStarField 的 Points 里）----------
      //
      // 这层只画「极淡的小点」：贴图被放大 8~10 倍后，它们变成几像素的
      // 柔和光晕，正好充当银河里的尘埃。不能画亮星 —— 会被放大成虚焦光斑。
      for (let i = 0; i < 900; i++) {
        // 星尘限制在 |lat| ≤ 70°：等距圆柱贴图的极点行会被拉成经向细条，
        // 星点落在这里会变成一圈放射状噪点（回归脚本对此有断言）。
        const z = (rnd() * 2 - 1) * Math.sin(Math.PI * 70 / 180);
        const phi = rnd() * Math.PI * 2;
        const s = Math.sqrt(Math.max(0, 1 - z * z));
        dir.set(s * Math.cos(phi), z, s * Math.sin(phi));
        // 30% 的星尘拉向银河带，让银河看起来更「有料」
        if (rnd() < 0.3) {
          const t = rnd() * Math.PI * 2;
          const wobble = (rnd() + rnd() + rnd() - 1.5) * 0.11;
          dir.copy(u).multiplyScalar(Math.cos(t))
            .addScaledVector(v, Math.sin(t))
            .addScaledVector(n, wobble)
            .normalize();
        }
        const [sx, sy] = toCanvas(dir);
        const a = 0.06 + rnd() * 0.14;
        const warm = rnd() < 0.28;
        const c = warm ? '255, 236, 208' : '205, 224, 255';
        ctx.fillStyle = 'rgba(' + c + ', ' + a.toFixed(3) + ')';
        const sz = 0.7 + rnd() * 1.1;
        ctx.fillRect(sx, sy, sz, sz);
      }

      const tex = new THREE.CanvasTexture(canvas);
      markSRGBTexture(tex);
      tex.wrapS = THREE.RepeatWrapping;
      // 星空只要「够细」：用线性过滤即可，mipmap 能省掉极区采样噪点
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      return tex;
    }

    /**
     * 星星用的点贴图（PointsMaterial.map）。
     *
     *   · 'round'：柔光圆点（暗星/亮星都用它，只是尺寸不同）
     *   · 'cross'：带十字光芒的亮星
     */
    #makeStarPointTexture(kind) {
      const size = kind === 'cross' ? 64 : 32;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      const c = size / 2;

      if (kind === 'cross') {
        // 中心柔光核
        const core = ctx.createRadialGradient(c, c, 0, c, c, size * 0.22);
        core.addColorStop(0, 'rgba(255,255,255,1)');
        core.addColorStop(0.35, 'rgba(255,255,255,0.55)');
        core.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = core;
        ctx.fillRect(0, 0, size, size);
        // 十字光芒：两条沿轴线的渐变
        ctx.lineWidth = Math.max(1, size * 0.05);
        const armH = ctx.createLinearGradient(0, c, size, c);
        armH.addColorStop(0, 'rgba(255,255,255,0)');
        armH.addColorStop(0.5, 'rgba(255,255,255,0.75)');
        armH.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.strokeStyle = armH;
        ctx.beginPath();
        ctx.moveTo(0, c);
        ctx.lineTo(size, c);
        ctx.stroke();
        const armV = ctx.createLinearGradient(c, 0, c, size);
        armV.addColorStop(0, 'rgba(255,255,255,0)');
        armV.addColorStop(0.5, 'rgba(255,255,255,0.60)');
        armV.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.strokeStyle = armV;
        ctx.beginPath();
        ctx.moveTo(c, 0);
        ctx.lineTo(c, size);
        ctx.stroke();
      } else {
        const g = ctx.createRadialGradient(c, c, 0, c, c, c);
        g.addColorStop(0, 'rgba(255,255,255,1)');
        g.addColorStop(0.30, 'rgba(255,255,255,0.85)');
        g.addColorStop(0.62, 'rgba(255,255,255,0.18)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, size, size);
      }

      const tex = new THREE.CanvasTexture(canvas);
      markSRGBTexture(tex);
      return tex;
    }

    /**
     * 生成一层星星（THREE.Points）。
     *
     * 【为什么用 Points 而不是把星点画进背景贴图】背景球半径 90，视野只看到
     * 球面的约 40°，2048 宽的等距贴图在这片区域被放大 8~10 倍：贴图里
     * 2px 的星点到了屏幕上就是约 20px 的模糊圆斑（第一版实测就是这个效果）。
     * Points 用 sizeAttenuation=false，点的直径直接以**屏幕像素**计，
     * 无论背景球多大都保持锐利；且点始终是圆的，极点也不会把星拉成细条。
     */
    #makeStarPoints(opts) {
      const count = opts.count;
      const rnd = makeRandom(opts.seed);
      const positions = new Float32Array(count * 3);
      const colors = new Float32Array(count * 3);
      const radius = opts.radius || STAR_POINT_RADIUS;
      for (let i = 0; i < count; i++) {
        // 球面均匀分布：z 均匀 → 方向在球面上均匀（不会在两极堆积）
        const z = rnd() * 2 - 1;
        const phi = rnd() * Math.PI * 2;
        const s = Math.sqrt(Math.max(0, 1 - z * z));
        positions[i * 3] = s * Math.cos(phi) * radius;
        positions[i * 3 + 1] = z * radius;
        positions[i * 3 + 2] = s * Math.sin(phi) * radius;

        // 亮度与色温：略偏冷的星多，少数暖白（真实星空的色温分布近似）
        const bright = 0.55 + rnd() * 0.45;
        const warm = rnd() < 0.26;
        const warmBoost = opts.warm || 0;
        colors[i * 3] = (warm ? 1.0 : 0.80) * bright;
        colors[i * 3 + 1] = (warm ? 0.86 + warmBoost * 0.10 : 0.86) * bright;
        colors[i * 3 + 2] = (warm ? 0.70 : 1.0) * bright;
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

      const mat = new THREE.PointsMaterial({
        size: opts.size,
        // 关键：尺寸不随距离衰减 → 以屏幕像素计，星星永远锐利
        sizeAttenuation: false,
        map: opts.texture,
        transparent: true,
        opacity: opts.opacity,
        vertexColors: true,
        // depthTest 保留：星球（不透明）会挡住它背后的星星；
        // depthWrite=false：星星之间、星星与其它半透明层不互相裁切。
        depthTest: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      });

      const points = new THREE.Points(geo, mat);
      // 透明队列按距离排序：星星在 60 左右，云/大气更近，因此星星先画
      points.renderOrder = 0;
      return points;
    }

    /** 星空：背景球（渐变 + 银河）+ 多层 Points 星点 */
    #buildStarField() {
      // ---------- 背景球 ----------
      const geo = new THREE.SphereGeometry(STAR_RADIUS, 64, 32);
      const mat = new THREE.MeshBasicMaterial({
        map: this.starTexture,
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false,
        fog: false,
      });
      this.starField = new THREE.Mesh(geo, mat);
      // renderOrder = -1：保证在星球之前绘制（opaque 队列按 renderOrder 排序）
      this.starField.renderOrder = -1;
      this.scene.add(this.starField);

      // ---------- 星点 ----------
      // 三层亮度 + 一层十字光芒：总数 2600 + 36，与需求「1500~3000 颗」一致。
      // 分层画是为了用三档屏幕尺寸模拟亮度差异（PointsMaterial 的 size 是
      // 材质级参数，不能逐点设置）。
      this.starPointTexture = this.#makeStarPointTexture('round');
      this.starCrossTexture = this.#makeStarPointTexture('cross');
      const tiers = [
        { count: 1800, seed: 0x51a7e1, size: 1.8, opacity: 0.55, warm: 0 },
        { count: 650, seed: 0x51a7e2, size: 2.8, opacity: 0.78, warm: 0 },
        { count: 150, seed: 0x51a7e3, size: 4.4, opacity: 1.0, warm: 0.5 },
        // 少数最亮星带十字光芒（用专门的贴图）
        { count: 36, seed: 0x51a7e4, size: 15.0, opacity: 0.9, warm: 0.6, cross: true },
      ];
      this.starPoints = [];
      for (let i = 0; i < tiers.length; i++) {
        const t = tiers[i];
        const points = this.#makeStarPoints({
          count: t.count,
          seed: t.seed,
          size: t.size,
          opacity: t.opacity,
          warm: t.warm,
          texture: t.cross ? this.starCrossTexture : this.starPointTexture,
        });
        this.starPoints.push(points);
        this.scene.add(points);
      }
    }

    // ==================== 大气辉光（双层）====================

    /**
     * 大气层的通用着色器。
     *
     * 【旧版为什么是一圈发白的亮带】
     * 旧实现是「BackSide 大球 + Fresnel」的经典写法，但对**远半球**来说，
     * Fresnel 项 1-|dot(n, view)| 在 p（视线到球心的垂距）越大时越亮：
     * 中心 p=0 处 Fresnel 最强，可那里被星球本体挡住；真正可见的
     * p ∈ [R, 壳半径] 这一段，亮度却是**向外递增**的，到球壳边缘突然
     * 被几何裁掉 —— 于是形成一条「外缘最亮、边界一刀切」的白亮带，
     * 叠加在星球明亮的冰盖/云顶上就过曝成白色。
     *
     * 【本版做法】改成按「大气光学厚度」建模：用解析几何求出该片元的
     * 视线到球心的垂距 p，令 x = (p - R)/R，亮度取 exp(-x·decay) ——
     * 紧贴星球轮廓处最亮，向外指数衰减。
     *   · 壳半径取足够大（内 1.16 / 外 1.60），保证衰减到几何边缘时已
     *     接近 0，不会出现「亮带被切断」的硬边；
     *   · x≈0 处用 smoothstep 淡入，避免与星球剪影之间出现锯齿状接缝；
     *   · 昼/夜分量：用「片元方向 · 太阳方向」的余弦调制颜色与强度，
     *     夜面一侧只剩很暗的蓝，昼面一侧是偏亮的青蓝 —— 星球立刻有了
     *     「被恒星照亮的一侧」的方向感。
     *
     * 背景知识：p 由相机位置与片元方向直接算出（相机在原点、星球在
     * 世界原点），不需要额外传矩阵；three.js 的 ShaderMaterial 会自动
     * 注入 cameraPosition 这个内置 uniform。
     */
    #makeAtmosphereMaterial(radius, opacity, colorDay, colorNight, decay) {
      return new THREE.ShaderMaterial({
        transparent: true,
        blending: THREE.AdditiveBlending,
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: {
          dayColor: { value: new THREE.Color(colorDay) },
          nightColor: { value: new THREE.Color(colorNight) },
          sunDir: { value: new THREE.Vector3(5, 2, 3).normalize() },
          planetRadius: { value: 1.0 },
          glowDecay: { value: decay },
          glowGain: { value: opacity },
          shellRadius: { value: radius },
        },
        vertexShader: [
          'varying vec3 vWorldPos;',
          'void main() {',
          '  vec4 wp = modelMatrix * vec4(position, 1.0);',
          '  vWorldPos = wp.xyz;',
          '  gl_Position = projectionMatrix * viewMatrix * wp;',
          '}',
        ].join('\n'),
        fragmentShader: [
          'uniform vec3 dayColor;',
          'uniform vec3 nightColor;',
          'uniform vec3 sunDir;',
          'uniform float planetRadius;',
          'uniform float glowDecay;',
          'uniform float glowGain;',
          'varying vec3 vWorldPos;',
          'void main() {',
          '  // 视线方向（相机 → 片元），以及视线到星球球心的垂距 p',
          '  vec3 rayDir = normalize(vWorldPos - cameraPosition);',
          '  float p = length(cross(-cameraPosition, rayDir));',
          '  // x = 超出星球轮廓的比例（0 = 正贴轮廓）',
          '  float x = max(0.0, p - planetRadius) / planetRadius;',
          '  // 轮廓处淡入（0~0.6% 半径），消除与球体剪影之间的硬接缝',
          '  float inner = smoothstep(0.0, 0.006, x);',
          '  // 指数衰减：模拟大气透过率随高度下降',
          '  float profile = exp(-x * glowDecay) * inner;',
          '  // 昼 / 夜：片元所在方向与太阳方向的余弦',
          '  float day = smoothstep(0.16, 0.92, dot(normalize(vWorldPos), sunDir) * 0.5 + 0.5);',
          '  vec3 col = mix(nightColor, dayColor, day);',
          '  float a = profile * glowGain * (0.30 + 0.70 * day);',
          '  if (a < 0.002) discard;',
          '  gl_FragColor = vec4(col, a);',
          '}',
        ].join('\n'),
      });
    }

    #buildAtmosphere() {
      // 内层：贴着云顶的薄边缘光。半径只比云层高一点，decay 很大 → 非常锐，
      // 负责把「星球轮廓」勾出来；颜色偏青白，但透明度上限只有 0.34，
      // 叠在明亮的冰盖上也不会爆成白色。
      const geoInner = new THREE.SphereGeometry(ATMOSPHERE_INNER_RADIUS, 64, 32);
      this.atmosphereInner = new THREE.Mesh(
        geoInner,
        this.#makeAtmosphereMaterial(ATMOSPHERE_INNER_RADIUS, 0.34, 0xbdf0ff, 0x1d3550, 34)
      );
      this.atmosphereInner.renderOrder = 1;
      this.scene.add(this.atmosphereInner);

      // 外层：宽而淡的柔和辉光（decay 小 → 扩散到约 0.5R 之外才归零）。
      // 壳半径 1.60 远大于可见辉光范围，避免「亮带被球壳边缘切断」。
      const geoOuter = new THREE.SphereGeometry(ATMOSPHERE_OUTER_RADIUS, 64, 32);
      this.atmosphere = new THREE.Mesh(
        geoOuter,
        this.#makeAtmosphereMaterial(ATMOSPHERE_OUTER_RADIUS, 0.26, 0x63b6ea, 0x0e2138, 9)
      );
      this.atmosphere.renderOrder = 0;
      this.scene.add(this.atmosphere);
    }

    // ==================== 光照 ====================

    #buildLights() {
      // 光照配比的目标：让 3D 里的海色接近 2D 的深蓝（22,56,96），
      // 而不是被环境光整体提亮成灰白。
      //
      // 旧配比 sun=1.25 / ambient=0.75 会把深色海洋推向亮灰 —— 环境光
      // 对所有像素无差别加亮，深海（本身很暗）被抬得最明显。
      // 现在提高主光、压低环境光，让「明暗由太阳决定」，
      // 深色区域保持深色，只有受光面才亮。
      const sun = new THREE.DirectionalLight(0xfff4e6, 1.85);
      sun.position.set(5, 2, 3);
      this.scene.add(sun);
      this.sunLight = sun;

      // 环境光只做最低限度的补光，避免暗面纯黑
      const ambient = new THREE.AmbientLight(0x556688, 0.34);
      this.scene.add(ambient);
      this.ambientLight = ambient;

      // 背面轮廓光：勾勒球体边缘
      const rim = new THREE.DirectionalLight(0x5588cc, 0.32);
      rim.position.set(-4, -2, -3);
      this.scene.add(rim);
      this.rimLight = rim;
    }

    // ==================== 3D 经纬网 ====================

    /**
     * 经纬网：把 2D 的「显示经纬网」选项原样带进 3D。
     *
     * 2D 的网格是画在贴图上的（renderEquirectTexture 特意不带网格），
     * 所以进 3D 之后原本会完全消失。这里用真正的 3D 线条重建：
     * 经线每 30°、纬线每 15°，半径 1.062（高于最高峰、低于地名精灵）。
     * 用**一个 LineSegments** 而不是几十个 Line，控制 draw call。
     */
    #buildGraticule() {
      const R = GRATICULE_RADIUS;
      const positions = [];
      const push = (a, b) => {
        positions.push(a[0], a[1], a[2], b[0], b[1], b[2]);
      };
      const point = (latDeg, lonDeg) => {
        const lat = (latDeg * Math.PI) / 180;
        const lon = (lonDeg * Math.PI) / 180;
        const cosLat = Math.cos(lat);
        return [cosLat * Math.cos(lon) * R, Math.sin(lat) * R, cosLat * Math.sin(lon) * R];
      };

      // 纬线：±75° 到 75°，每 15°；赤道单独加强（见下方材质分组）
      const latitudes = [];
      for (let lat = -75; lat <= 75; lat += 15) latitudes.push(lat);
      for (let k = 0; k < latitudes.length; k++) {
        const lat = latitudes[k];
        let prev = point(lat, 0);
        for (let lon = 6; lon <= 360; lon += 6) {
          const cur = point(lat, lon);
          push(prev, cur);
          prev = cur;
        }
      }

      // 经线：每 30°，从北极到南极
      for (let lon = 0; lon < 360; lon += 30) {
        let prev = point(-84, lon);
        for (let lat = -80; lat <= 84; lat += 4) {
          const cur = point(lat, lon);
          push(prev, cur);
          prev = cur;
        }
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
      const mat = new THREE.LineBasicMaterial({
        color: 0x9fd4ef,
        transparent: true,
        opacity: 0.18,
        depthWrite: false,
        depthTest: true,
      });
      this.graticule = new THREE.LineSegments(geo, mat);
      this.graticule.rotation.y = this.globe ? this.globe.rotation.y : -Math.PI / 2;
      // 在星球之后、云与地名之前绘制
      this.graticule.renderOrder = 2;
      this.scene.add(this.graticule);
      this.setGraticuleVisible(this.renderer && this.renderer.options
        ? this.renderer.options.showGrid !== false
        : true);
    }

    /** 显示 / 隐藏 3D 经纬网（main.js 的「显示经纬网」开关直接调它） */
    setGraticuleVisible(visible) {
      this.showGraticule = !!visible;
      if (this.graticule) this.graticule.visible = this.showGraticule;
      this.requestRender();
    }

    /**
     * 3D 外观跟随 2D 显示模式。
     *
     * 【为什么要做】手绘地图贴到球上后，如果还是写实蓝大气 + 厚白云 + 海面强高光，
     * 会变成「一颗贴了旧地图的卫星」，两种语言互相打架。
     * 手绘模式（handdrawn / named / lettered）统一换成：
     *   · 暖金大气 + 暖阳主光（羊皮纸地球仪）；
     *   · 云量压到 30%、染成米黄（像纸上的薄云）；
     *   · 海面高光收得很低（墨线和排线才是画面主角）。
     *
     * 默认卫星 / 地形模式仍保持原先的冷蓝写实星球。
     */
    #applyViewModeStyle() {
      const renderer = this.renderer;
      const mode = (renderer && renderer.viewMode) || 'satellite';
      if (this._styleMode === mode) {
        // 模式没变也要同步网格开关（切换叠加层会走 updateTexture）
        this.setGraticuleVisible(renderer && renderer.options
          ? renderer.options.showGrid !== false
          : true);
        return;
      }
      this._styleMode = mode;
      const hand = !!HAND_MODES[mode];
      // 题名图的纸色本来就接近纯白，若再用「明亮暖光」照一遍会变成一颗
      // 过曝的白球。它单独用更低的太阳光/环境光，并把材质色压成米灰，
      // 让墨线与海岸重新成为画面骨架。
      const lettered = mode === 'lettered';

      if (this.sunLight) {
        this.sunLight.color.setHex(hand ? 0xfff0d8 : 0xfff4e6);
        this.sunLight.intensity = hand ? (lettered ? 1.16 : 1.36) : 1.85;
      }
      if (this.ambientLight) {
        this.ambientLight.color.setHex(hand ? 0x8a7358 : 0x556688);
        this.ambientLight.intensity = hand ? (lettered ? 0.20 : 0.28) : 0.34;
      }
      if (this.rimLight) {
        this.rimLight.color.setHex(hand ? 0xc8a878 : 0x5588cc);
        this.rimLight.intensity = hand ? 0.24 : 0.32;
      }

      if (this.atmosphereInner && this.atmosphereInner.material) {
        const u = this.atmosphereInner.material.uniforms;
        if (u && u.dayColor && u.nightColor) {
          u.dayColor.value.setHex(hand ? 0xffe8b8 : 0xbdf0ff);
          u.nightColor.value.setHex(hand ? 0x2a1c12 : 0x1d3550);
          u.glowGain.value = hand ? 0.26 : 0.34;
        }
      }
      if (this.atmosphere && this.atmosphere.material) {
        const u = this.atmosphere.material.uniforms;
        if (u && u.dayColor && u.nightColor) {
          u.dayColor.value.setHex(hand ? 0xd9b36e : 0x63b6ea);
          u.nightColor.value.setHex(hand ? 0x1a120a : 0x0e2138);
          u.glowGain.value = hand ? 0.22 : 0.26;
        }
      }

      if (this.cloudMesh && this.cloudMesh.material) {
        const cm = this.cloudMesh.material;
        cm.opacity = hand ? (lettered ? 0.20 : 0.28) : 0.58;
        cm.color.setHex(hand ? 0xf6e8cc : 0xffffff);
      }

      if (this.globe && this.globe.material) {
        const gm = this.globe.material;
        gm.shininess = hand ? 14 : 60;
        if (gm.specular) gm.specular.setHex(hand ? 0x2e2318 : 0x1b3a58);
        if (gm.normalScale) gm.normalScale.set(hand ? 0.34 : 0.6, hand ? 0.34 : 0.6);
        // 材质色乘法：题名图压到 0.79，地名图 0.88，普通模式恢复纯白
        gm.color.setHex(hand ? (lettered ? 0xc9bca4 : 0xe0d5c2) : 0xffffff);
      }

      if (this.graticule && this.graticule.material) {
        this.graticule.material.color.setHex(hand ? 0xf0e0bd : 0x9fd4ef);
        this.graticule.material.opacity = hand ? 0.24 : 0.18;
      }

      this.setGraticuleVisible(renderer && renderer.options
        ? renderer.options.showGrid !== false
        : true);
      this.requestRender();
    }

    /** 供 main.js 在切换经纬网时立即同步（不必等下一次贴图重建） */
    syncGraticule() {
      this.setGraticuleVisible(this.renderer && this.renderer.options
        ? this.renderer.options.showGrid !== false
        : true);
    }

    // ==================== 地名精灵（仅手绘地名模式）====================

    /**
     * 同步 3D 地名精灵。
     *
     * 调用时机：
     *   · 进入 3D（init 末尾 / enter）；
     *   · 贴图更新（updateTexture —— 2D 侧任何一次重绘之后）；
     *   · 退出 3D（清空并释放纹理）。
     *
     * 数据来自 renderer.getLabels()（T2 提供）。**全程防御性编程**：
     * getLabels 可能不存在、可能返回 null、元素的字段可能缺失 —— 任何
     * 一个异常都不允许把 3D 视图带崩（3D 是可选装饰，底图才是主功能）。
     * 因此这里逐项校验 + try/catch，失败时只是「没有地名」。
     */
    refreshLabels() {
      if (!this.scene || !this.labelGroup) return;   // 3D 尚未初始化
      const renderer = this.renderer;

      // 只有手绘地名模式（named / lettered）才在球面上画地名
      const mode = renderer && renderer.viewMode;
      if (!renderer || (mode !== 'named' && mode !== 'lettered')) {
        this._labelMode = null;
        this.#clearLabels();
        this.requestRender();
        return;
      }
      this._labelMode = mode;

      let raw = null;
      try {
        raw = typeof renderer.getLabels === 'function' ? renderer.getLabels() : null;
      } catch (error) {
        console.warn('[globe] getLabels() 抛出异常，3D 地名已跳过：', error);
        raw = null;
      }
      if (!raw || typeof raw.length !== 'number' || !raw.length) {
        this.#clearLabels();
        this.requestRender();
        return;
      }

      // 逐项校验：文本非空、坐标是有限数
      const valid = [];
      for (let i = 0; i < raw.length; i++) {
        const lb = raw[i];
        if (!lb || typeof lb !== 'object') continue;
        if (typeof lb.text !== 'string' || !lb.text.trim()) continue;
        if (!isFinite(Number(lb.x)) || !isFinite(Number(lb.y))) continue;
        valid.push(lb);
      }
      if (!valid.length) {
        this.#clearLabels();
        this.requestRender();
        return;
      }

      // 按重要度降序选点，并做一次球面距离去重：
      // 每张标签是一块 2D 精灵，两个标签若在球面上挨得太近，在 3D 里
      // 会叠成一团（尤其大陆名 + 山脉名 + 山峰名）。重要度高的先占位，
      // 后来的若落在 4° 以内就丢弃 —— 这是 3D 版的「地名避让」。
      valid.sort((a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0));
      const mapW = Math.max(1, this.generator ? this.generator.width : 1600);
      const mapH = Math.max(1, this.generator ? this.generator.height : 800);
      const MIN_SEP = 0.070;   // 弧度，约 4°
      const picked = [];
      for (let i = 0; i < valid.length && picked.length < LABEL_MAX; i++) {
        const lb = valid[i];
        const lat = Math.PI * (0.5 - Math.max(0, Math.min(1, Number(lb.y) / mapH)));
        const lon = Math.PI * 2 * (Number(lb.x) / mapW - 0.5);
        let tooClose = false;
        for (let k = 0; k < picked.length; k++) {
          const p = picked[k];
          const pLat = p._lat3d;
          const pLon = p._lon3d;
          let dLon = Math.abs(lon - pLon);
          if (dLon > Math.PI) dLon = Math.PI * 2 - dLon;
          const midLat = (lat + pLat) * 0.5;
          const dist = Math.sqrt((lat - pLat) * (lat - pLat) +
            Math.pow(dLon * Math.cos(midLat), 2));
          if (dist < MIN_SEP) { tooClose = true; break; }
        }
        if (tooClose) continue;
        lb._lat3d = lat;
        lb._lon3d = lon;
        picked.push(lb);
      }

      // 【签名去重】toggle 经纬网 / 洋流这类操作会触发 2D 重绘 → updateTexture
      // → refreshLabels。标签没变时没必要重建 40 张画布 + 纹理（约 30~80 ms）。
      let sig = mode + '|';
      for (let i = 0; i < picked.length; i++) {
        const lb = picked[i];
        sig += lb.text + '|' + (lb.kind || '') + '|' +
          Math.round(Number(lb.x) || 0) + '|' + Math.round(Number(lb.y) || 0) + '|' +
          Math.round(Number(lb.size) || 0) + '|' + (Number(lb.rotate) || 0).toFixed(2) + ';';
      }
      if (sig === this._labelSignature && this.labelSprites.length) {
        this.requestRender();
        return;
      }

      // 先清空旧精灵（含纹理释放），再逐个重建
      this.#clearLabels();
      this._labelSignature = sig;

      for (let i = 0; i < picked.length; i++) {
        const sprite = this.#makeLabelSprite(picked[i], mapW, mapH, mode);
        if (!sprite) continue;
        this.labelGroup.add(sprite);
        this.labelSprites.push(sprite);
      }
      this.#updateLabelFade();
      this.requestRender();
    }

    /**
     * 清空精灵并释放 GPU 资源。
     *
     * 【为什么要手动 dispose】CanvasTexture 每张都占显存；Sprite 被移出
     * 场景并不会自动释放它引用的 texture / material。反复进出 3D 或反复
     * 切模式若不释放，显存会一路涨到浏览器回收（表现为越来越卡）。
     */
    #clearLabels() {
      if (!this.labelSprites.length) {
        this._labelSignature = null;
        return;
      }
      for (let i = 0; i < this.labelSprites.length; i++) {
        const sp = this.labelSprites[i];
        if (sp.material) {
          if (sp.material.map) sp.material.map.dispose();
          sp.material.dispose();
        }
        if (this.labelGroup) this.labelGroup.remove(sp);
      }
      this.labelSprites.length = 0;
      this._labelSignature = null;
    }

    /**
     * 单个标签 → THREE.Sprite。
     *
     * 【坐标换算】标签的 x/y 是**等距圆柱数据贴图的像素坐标**（T2 约定），
     * 与 3D 球体的经纬度一一对应。球体局部坐标下（与 #buildTerrain 里
     * 反推经纬度的公式互逆）：
     *   latN = y / mapH            （0 = 北极）
     *   lat  = π · (0.5 − latN)
     *   lon  = 2π · (x/mapW − 0.5)
     *   p    = (cosLat·cosLon, sinLat, cosLat·sinLon) · LABEL_RADIUS
     * 精灵挂在 labelGroup 上，labelGroup 与 globe 同 rotation.y，因此精灵
     * 与地表贴图严格对齐（不用再考虑贴图 repeat.x = −1 的镜像链）。
     */
    #makeLabelSprite(label, mapW, mapH, mode) {
      const text = String(label.text).trim().slice(0, 24);
      if (!text) return null;
      const brush = mode === 'lettered';

      // 数据像素字号，做上下限保护（万一上游给了异常值也不会生成巨图）。
      // 题名模式字号整体放大 18%：它的信息主角就是地名。
      const basePx = Math.max(9, Math.min(64, Number(label.size) || 20));
      const fontPx = brush ? basePx * 1.18 : basePx;
      // 2 倍分辨率：精灵在镜头拉近时会被放大，1x 会直接糊
      const RES = 2;
      const fontSize = Math.round(fontPx * RES);

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      // 先量文本宽度（此时画布尺寸未定，resize 后 context 状态会重置）
      ctx.font = '600 ' + fontSize + 'px ' + LABEL_FONT_STACK;
      const textW = Math.ceil(ctx.measureText(text).width) || fontSize;
      const pad = Math.round(fontSize * (brush ? 0.42 : 0.30));
      canvas.width = textW + pad * 2;
      canvas.height = Math.ceil(fontSize * 1.5) + pad * 2;

      // resize 后重新设置绘图状态
      ctx.font = '600 ' + fontSize + 'px ' + LABEL_FONT_STACK;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;

      // 纸色描边：地名压在深海 / 雪山 / 云上也读得出来
      const haloWidth = Math.max(2, fontSize * (brush ? 0.30 : 0.24));
      const halo = brush ? 'rgba(248, 242, 226, 0.95)' : 'rgba(246, 240, 226, 0.92)';
      // 深褐墨色；海洋名略偏冷
      const ink = label.kind === 'ocean' || label.kind === 'sea'
        ? (brush ? 'rgb(38, 52, 62)' : 'rgb(44, 60, 76)')
        : (brush ? 'rgb(46, 34, 24)' : 'rgb(58, 44, 32)');

      if (brush) {
        // 题名模式：逐字画，手写抖动全部由字符码派生（同一标签每次一致）
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        let acc = 0;
        const chars = Array.from(text);
        for (let k = 0; k < chars.length; k++) {
          const ch = chars[k];
          const adv = ctx.measureText(ch).width || fontSize;
          const cx = pad + acc + adv / 2;
          const cy = canvas.height / 2;
          acc += adv;
          if (ch === ' ') continue;
          let h = ((ch.charCodeAt(0) || 0) * 2246822519 + k * 2654435761) >>> 0;
          h ^= h >>> 15;
          h = Math.imul(h, 2246822519) >>> 0;
          h ^= h >>> 13;
          const j1 = (h & 0xff) / 255 - 0.5;
          const j2 = ((h >>> 8) & 0xff) / 255 - 0.5;
          const j3 = ((h >>> 16) & 0xff) / 255 - 0.5;
          ctx.save();
          ctx.translate(cx, cy + j2 * fontSize * 0.035);
          ctx.rotate(j1 * 0.032);
          ctx.scale(1 + j3 * 0.035, 1 + j3 * 0.035);
          ctx.strokeStyle = halo;
          ctx.lineWidth = haloWidth;
          ctx.strokeText(ch, 0, 0);
          // 两遍填墨：第二遍略偏、半透明，模拟笔锋的浓淡
          ctx.fillStyle = ink;
          ctx.globalAlpha = 0.92;
          ctx.fillText(ch, 0, 0);
          ctx.globalAlpha = 0.34;
          ctx.fillText(ch, fontSize * 0.035, -fontSize * 0.022);
          ctx.globalAlpha = 1;
          ctx.restore();
        }
      } else {
        ctx.strokeStyle = halo;
        ctx.lineWidth = haloWidth;
        ctx.strokeText(text, canvas.width / 2, canvas.height / 2);
        ctx.fillStyle = ink;
        ctx.fillText(text, canvas.width / 2, canvas.height / 2);
      }

      const tex = new THREE.CanvasTexture(canvas);
      // 这是**颜色**贴图，必须标 sRGB（见 markSRGBTexture 的踩坑注释）
      markSRGBTexture(tex);
      if (this.globeRenderer && this.globeRenderer.capabilities) {
        tex.anisotropy = this.globeRenderer.capabilities.getMaxAnisotropy();
      }

      // 【尺寸换算】1 数据像素对应球面弧长 2π/mapW。
      // 再乘 0.62：精灵的视觉字号约为 2D 的 62%（球面外凸会被视角压缩，
      // 加上云与大气会削弱对比，直接照搬 2D 字号会显得过大）。
      // 最后按 importance 在 0.9~1.12 之间微调。
      const pxToWorld = (Math.PI * 2) / mapW;
      const imp = Math.max(0, Math.min(1, ((Number(label.importance) || 3) - 1) / 4));
      const texelWorld = (pxToWorld * 0.62) / RES;
      const scaleBoost = 0.90 + 0.22 * imp;

      let worldH = canvas.height * texelWorld * scaleBoost;
      // 高度钳制：太小看不清、太大像贴纸；题名图地名是画面主角，上下限都抬高
      worldH = Math.max(brush ? 0.040 : 0.030, Math.min(brush ? 0.108 : 0.090, worldH));
      let worldW = worldH * (canvas.width / canvas.height);
      // 宽度上限：长地名（例如「西尔维娅大冰原」）不能横跨半个球面
      const maxW = 0.30;
      if (worldW > maxW) {
        const k = maxW / worldW;
        worldW *= k;
        worldH *= k;
      }

      // 平面内旋转：T2 的 rotate 是弧度；异常值一律当 0
      let rot = Number(label.rotate);
      if (!isFinite(rot)) rot = 0;
      rot = Math.max(-Math.PI, Math.min(Math.PI, rot));

      const material = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        // depthTest：球体（不透明）会遮住背面的精灵 —— 这是「背面看不到
        // 地名」的关键；depthWrite=false：精灵之间不互相裁切。
        depthTest: true,
        depthWrite: false,
        sizeAttenuation: true,
        rotation: rot,
        opacity: 0.92,
      });
      const sprite = new THREE.Sprite(material);
      // 精灵必须压在地经纬网之上（网格 renderOrder = 2）
      sprite.renderOrder = 3;

      const latN = Math.max(0, Math.min(1, Number(label.y) / mapH));
      const lonN = Number(label.x) / mapW;
      const lat = Math.PI * (0.5 - latN);
      const lon = Math.PI * 2 * (lonN - 0.5);
      const cosLat = Math.cos(lat);
      sprite.position.set(
        cosLat * Math.cos(lon) * LABEL_RADIUS,
        Math.sin(lat) * LABEL_RADIUS,
        cosLat * Math.sin(lon) * LABEL_RADIUS
      );
      sprite.scale.set(worldW, worldH, 1);

      // 记录基准不透明度，供 #updateLabelFade 每帧调制
      sprite.userData.baseOpacity = (brush ? 0.84 : 0.78) + 0.18 * imp;
      sprite.userData.text = text;
      sprite.userData.mode = mode;
      return sprite;
    }

    /**
     * 标签随朝向淡出 / 夜面压暗。
     *
     * depthTest 已经能让背面的标签被球体挡住，但落在轮廓边缘的标签会被
     * 透视压成一条薄片、仍然很抢眼；这里按「标签法线与视线夹角」淡出，
     * 让它们自然消失在球体边缘。同时按太阳方向压暗夜面标签（保留
     * 58% 以上的不透明度，保证可读）。
     *
     * 只在相机移动时调用（≤40 个精灵，开销可忽略）。
     */
    #updateLabelFade() {
      const sprites = this.labelSprites;
      if (!sprites.length || !this.camera) return;
      if (!this._fadeTmpPos) {
        this._fadeTmpPos = new THREE.Vector3();
        this._fadeTmpDir = new THREE.Vector3();
        this._fadeTmpSun = new THREE.Vector3(5, 2, 3).normalize();
      }
      const pos = this._fadeTmpPos;
      const toCam = this._fadeTmpDir;
      const sun = this._fadeTmpSun;
      const cam = this.camera.position;
      this.labelGroup.updateMatrixWorld();
      for (let i = 0; i < sprites.length; i++) {
        const sp = sprites[i];
        sp.getWorldPosition(pos);
        const len = pos.length() || 1;
        toCam.copy(cam).sub(pos).normalize();
        // 球面法线 = 归一化的位置（球心在世界原点）
        const facing = (pos.x * toCam.x + pos.y * toCam.y + pos.z * toCam.z) / len;
        const edge = smoothstepLocal(-0.02, 0.20, facing);
        const day = smoothstepLocal(-0.22, 0.55, (pos.x * sun.x + pos.y * sun.y + pos.z * sun.z) / len);
        const base = sp.userData.baseOpacity || 0.9;
        sp.material.opacity = base * edge * (0.58 + 0.42 * day);
      }
    }

    // ==================== 贴图 ====================

    #makeTexture() {
      // 必须用「等距圆柱」投影的贴图：3D 球体的 UV 就是等距圆柱约定。
      // 若直接用 2D 画布（可能是罗宾逊椭圆投影），极点会被拉伸成椭圆暗斑。
      const tex = new THREE.CanvasTexture(this.#prepareGlobeCanvas(this.renderer.renderEquirectTexture()));
      tex.anisotropy = this.globeRenderer.capabilities.getMaxAnisotropy();
      markSRGBTexture(tex);
      tex.wrapS = THREE.RepeatWrapping;
      tex.repeat.x = -1;
      return tex;
    }

    /**
     * 把等距圆柱贴图整理成「球面友好」的版本：收敛极冠。
     *
     * 【为什么需要】等距圆柱的极点是「一整行像素收拢成一个点」，
     * 由此产生两个固有缺陷：
     *   1. 极点行的横向色差会被投射成放射状辐条（像切开的西瓜纹）；
     *   2. 该处 UV 各向异性趋于无穷，GPU 只能选最粗的 mip，
     *      极点变成一坨模糊的色斑 —— 也就是「贴到球上极点纹理变了」。
     * 真实行星的极区本来就是均质的冰盖，因此把 |lat| > 78° 的行
     * 逐行向「极冠平均色」平滑混合，既消除辐条与模糊，又不影响
     * 南极大陆海岸线（纬度只到 ~70°）。
     */
    #prepareGlobeCanvas(src) {
      const W = src.width;
      const H = src.height;
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(src, 0, 0);

      const CAP_START_DEG = 12;   // 从极点向外 12°（即 |lat| > 78°）开始收敛
      const CAP_SAMPLE_DEG = 4;   // 用极距 < 4° 的行求极冠平均色
      const capRows = Math.max(2, Math.round((CAP_SAMPLE_DEG / 180) * H));

      const img = ctx.getImageData(0, 0, W, H);
      const d = img.data;

      const avgRows = (fromY, toY) => {
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let y = fromY; y < toY; y++) {
          const base = y * W * 4;
          for (let x = 0; x < W; x++) {
            const i = base + x * 4;
            r += d[i];
            g += d[i + 1];
            b += d[i + 2];
            n++;
          }
        }
        return n ? [r / n, g / n, b / n] : null;
      };
      const northCap = avgRows(0, capRows);
      const southCap = avgRows(H - capRows, H);
      if (!northCap || !southCap) return canvas;

      // 【注意】poleDist 是「到极点的角距离」：极点 = 0，赤道 = 90。
      // 要收敛的是极区（poleDist < 12°），而不是赤道带 —— 权重必须随
      // poleDist 减小而增大。写成 (poleDist - 78) / 12 会把整条赤道
      // 混成极冠白色，球面上出现一圈刺眼的白环（已踩过）。
      for (let y = 0; y < H; y++) {
        const latDeg = 90 - ((y + 0.5) / H) * 180;      // +90 → -90
        const poleDist = 90 - Math.abs(latDeg);         // 0（极点）→ 90（赤道）
        if (poleDist >= CAP_START_DEG) continue;        // 仅极区

        let w = 1 - poleDist / CAP_START_DEG;           // 极点=1 → 边界=0
        w = w * w * (3 - 2 * w);                        // smoothstep，边界无突变
        const cap = y < H / 2 ? northCap : southCap;
        const base = y * W * 4;
        for (let x = 0; x < W; x++) {
          const i = base + x * 4;
          d[i] += (cap[0] - d[i]) * w;
          d[i + 1] += (cap[1] - d[i + 1]) * w;
          d[i + 2] += (cap[2] - d[i + 2]) * w;
        }
      }

      ctx.putImageData(img, 0, 0);
      return canvas;
    }

    /**
     * 海面高光遮罩（specularMap）。
     *
     * specularMap 是逐像素的「哪里反光」：白 = 镜面反射强，黑 = 完全哑光。
     *   · 海洋：220 —— 反光、能看到太阳倒影；
     *   · 陆地：18  —— 几乎不反光（山脉的湿润雪面也不该像镜子）。
     *
     * 【踩过的坑：高光爆白】旧实现用 roughnessMap（海洋 150 / 陆地 235），
     * 再叠加强度 1.85 的平行光，海面高光会糊成一坨白斑 —— 因为粗糙度
     * 150/255 ≈ 0.59 仍算「比较光滑」，而高光又是加色混合。
     * 现在把强度交给 specular 颜色（0x1b3a58，偏暗的蓝）+ shininess 60，
     * 峰值只有漫反射的一半左右，高光呈「亮蓝白」而不是死白。
     *
     * 【贴图编码】specular 属于**线性数据**，绝不能标 sRGB，
     * 否则会被当颜色再编一次 gamma，黑色陆地变灰、高光整体偏亮。
     *
     * 坐标与 cells 完全同源（等距圆柱网格），因此与球体 UV 天然匹配，
     * 只需和颜色贴图一样做 repeat.x = -1 的镜像。
     */
    #makeSpecularTexture() {
      const W = this.generator.width;
      const H = this.generator.height;
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext('2d');
      const img = ctx.createImageData(W, H);
      const data = img.data;
      const cells = this.generator.cells;
      const sea = this.generator.seaLevel;

      // 【海陆边界柔化】硬切边会让高光在海岸线上「一刀切」——
      // 2D 地图的 cells 是像素网格，直接按 e < sea 二值化，
      // 球面上会沿每格边缘出现锯齿。这里用 1 像素的余弦过渡，
      // 让高光从海里自然淡出到岸上（代价可忽略，只在贴图生成时算一次）。
      const seaSmooth = (i) => {
        const c = cells[i];
        if (!c) return 0;
        // e 与海平面的相对差（正=陆地），映射到 [-1,1] 后做 smoothstep
        const d = (c.e - sea) / Math.max(1e-6, 1 - sea);
        const k = Math.max(0, Math.min(1, (d + 0.004) / 0.008));
        return 1 - k * k * (3 - 2 * k);
      };

      for (let i = 0; i < W * H; i++) {
        const v = Math.round(18 + seaSmooth(i) * 202); // 陆 18 → 海 220
        data[i * 4] = v;
        data[i * 4 + 1] = v;
        data[i * 4 + 2] = v;
        data[i * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      const tex = new THREE.CanvasTexture(canvas);
      tex.wrapS = THREE.RepeatWrapping;
      tex.repeat.x = -1;
      return tex;
    }

    /**
     * 法线贴图：由海拔梯度生成，让平面贴图也带有凹凸细节。
     * 这样即使顶点位移较粗，山体表面仍有细碎的高光变化。
     */
    #makeNormalTexture() {
      // 同理：法线贴图由 cells 的海拔梯度生成，坐标即等距圆柱网格。
      const W = this.generator.width;
      const H = this.generator.height;
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext('2d');
      const img = ctx.createImageData(W, H);
      const data = img.data;
      const cells = this.generator.cells;
      const sea = this.generator.seaLevel;
      const S = 42; // 法线强度

      const heightAt = (x, y) => {
        const wx = ((x % W) + W) % W;
        const wy = Math.max(0, Math.min(H - 1, y));
        const c = cells[wy * W + wx];
        if (!c || c.e < sea) return 0;
        return (c.e - sea) / (1 - sea);
      };

      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const hl = heightAt(x - 1, y);
          const hr = heightAt(x + 1, y);
          const hu = heightAt(x, y - 1);
          const hd = heightAt(x, y + 1);
          const dx = (hr - hl) * S;
          const dy = (hd - hu) * S;
          // 构造法线并映射到 [0,1]
          let nx = -dx;
          let ny = -dy;
          let nz = 1;
          const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
          nx /= len;
          ny /= len;
          nz /= len;
          const i4 = (y * W + x) * 4;
          data[i4] = Math.round((nx * 0.5 + 0.5) * 255);
          data[i4 + 1] = Math.round((ny * 0.5 + 0.5) * 255);
          data[i4 + 2] = Math.round((nz * 0.5 + 0.5) * 255);
          data[i4 + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      const tex = new THREE.CanvasTexture(canvas);
      tex.wrapS = THREE.RepeatWrapping;
      tex.repeat.x = -1;
      return tex;
    }

    /** 2D 渲染完成后同步贴图与法线 */
    updateTexture() {
      if (!this.globe) {
        this._textureDirty = true;
        return;
      }
      this._textureDirty = false;
      // 与初始贴图保持一致：使用等距圆柱投影
      const next = this.#makeTexture();
      next.anisotropy = this.globeRenderer.capabilities.getMaxAnisotropy();
      this.globe.material.map = next;
      this.globe.material.needsUpdate = true;
      if (this.texture) this.texture.dispose();
      this.texture = next;

      const nrm = this.#makeNormalTexture();
      this.globe.material.normalMap = nrm;
      this.globe.material.needsUpdate = true;
      if (this.normalTexture) this.normalTexture.dispose();
      this.normalTexture = nrm;

      // 海陆遮罩同样随海拔变化（重新生成 / 导入后海平面可能不同）
      const spec = this.#makeSpecularTexture();
      this.globe.material.specularMap = spec;
      this.globe.material.needsUpdate = true;
      if (this.specularTexture) this.specularTexture.dispose();
      this.specularTexture = spec;

      // 颜色与法线只是"皮肤"；新地图的地形起伏必须同步到顶点
      this.#refreshTerrainGeometry();

      // 贴图更新往往意味着 2D 侧刚重绘过（模式切换 / 编辑 / 重新生成）：
      // 手绘地名图模式下标签可能已经变了，这里同步一次（内部有签名去重，
      // 标签没变时不会重建纹理）。
      this.#applyViewModeStyle();
      this.refreshLabels();
      this.requestRender();
    }

    /** 切换云层显示 */
    setCloudsVisible(visible) {
      this.showClouds = visible;
      if (this.cloudMesh) this.cloudMesh.visible = visible;
      this.requestRender();
    }

    // ==================== 进入/退出 ====================

    enter() {
      this.init();
      this.active = true;
      this.canvas2d.style.visibility = 'hidden';
      this.globeRenderer.domElement.style.display = 'block';
      this.#onResize();
      // 2D 侧在 3D 关闭期间可能换过地图/模式：进入时补一次同步
      if (this._textureDirty) this.updateTexture();
      // 首次进入时 init() 已同步过；再次进入时 scene 已存在、init 提前
      // return，需要在这里补一次（签名去重保证不会重复建纹理）
      this.#applyViewModeStyle();
      this.refreshLabels();
      this.#animate();
    }

    exit() {
      this.active = false;
      if (this.animationId) cancelAnimationFrame(this.animationId);
      this.animationId = null;
      // 退出 3D（含模式切换）时释放地名纹理：CanvasTexture 每张都占显存，
      // 留在场景里没有任何意义。
      this.#clearLabels();
      if (this.globeRenderer) this.globeRenderer.domElement.style.display = 'none';
      this.canvas2d.style.visibility = 'visible';
    }

    toggle() {
      if (this.active) {
        this.exit();
        return false;
      }
      this.enter();
      return true;
    }

    /**
     * 动画循环（按需渲染）。
     *
     * 【为什么改成按需渲染】旧实现无条件每帧重绘，即使相机静止、
     * 云层也几乎不动。3D 场景有半透明云 + 大气层 overdraw，
     * 持续满帧渲染会明显掉帧。
     *
     * 现在：
     *   · 只有「相机在动」（OrbitControls 阻尼未收敛）或「云层在自转」时才重绘；
     *   · 云层自转降频到约 20fps（视觉上足够平滑，开销降为 1/3）；
     *   · 完全静止时停止渲染，CPU/GPU 占用接近 0。
     */
    #animate() {
      this.animationId = requestAnimationFrame(() => this.#animate());

      // controls.update() 返回 true 表示相机仍有变化（含阻尼惯性）
      const moving = this.controls.update();

      const now = performance.now();
      const dt = now - (this._lastFrameTime || now);
      this._lastFrameTime = now;

      // 云层自转：累积时间，但重绘频率限制在 ~20fps
      let cloudMoved = false;
      if (this.cloudMesh && this.cloudMesh.visible) {
        this.cloudSpin += 0.00035 * (dt / 16.67);
        const targetAngle = this.cloudBaseAngle + this.cloudSpin;
        // 每 3 帧更新一次角度，减少无谓的矩阵计算
        if (Math.abs(targetAngle - this.cloudMesh.rotation.y) > 0.0004) {
          this.cloudMesh.rotation.y = targetAngle;
          cloudMoved = true;
        }
      }

      // 相机移动时更新标签的朝向淡出（背面标签已被 depthTest 挡住，
      // 这里处理轮廓边缘的「薄片」以及夜面压暗）
      if (moving && this.labelSprites.length) {
        this.#updateLabelFade();
      }

      // 只有在画面会变化时才真正渲染
      if (moving || cloudMoved || this._forceRender) {
        this._forceRender = false;
        this.globeRenderer.render(this.scene, this.camera);
      }
    }

    /** 强制下一帧重绘（贴图更新、云层开关等场景调用） */
    requestRender() {
      this._forceRender = true;
    }

    #onResize() {
      if (!this.globeRenderer) return;
      const W = this.container.clientWidth;
      const H = this.container.clientHeight;
      this.camera.aspect = W / H;
      this.camera.updateProjectionMatrix();
      this.globeRenderer.setSize(W, H);
    }
  }

  FM.GlobeView = GlobeView;
})(window);
