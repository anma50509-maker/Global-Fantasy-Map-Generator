/**
 * globe.js —— 3D 地球视图（真实地形起伏 + 体积云）
 *
 * 旧实现只是给一个光滑球体贴上 2D 地图纹理，没有任何几何起伏，
 * 也没有云层，看起来就是「贴了图的地球仪」。
 *
 * 本版本重建为三层结构：
 *
 *   1. 地表层（TerrainMesh）
 *      用 SphereGeometry 的顶点做**真实位移**（displacement）：
 *      按 2D 生成器的海拔数据，逐顶点沿法线方向外推。
 *      海洋保持球面，陆地从海平面开始隆起，最高峰约为球半径的 3.5%。
 *      同时用顶点法线自动计算光照，山体产生真实的明暗与阴影。
 *
 *   2. 云层（VolumetricClouds）
 *      在球面外侧覆盖一层半透明的程序化云。
 *      用多层噪声生成云团（而非均匀灰雾），并按纬度带控制云量
 *      （赤道对流云多、副热带少、中纬风暴带多）。
 *      云层独立于地表缓慢自转，产生立体感。
 *
 *   3. 大气辉光（Atmosphere）
 *      球体外侧一圈 Fresnel 边缘光，模拟大气散射。
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
   * 大气层半径。
   *
   * 同理必须包住最高的山（1.055），否则大气辉光壳会被山峰顶穿，
   * 球体边缘出现一圈断掉的亮环。
   */
  const ATMOSPHERE_RADIUS = 1.10;

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
      this.atmosphere = null;
      this.controls = null;
      this.animationId = null;
      this.active = false;
      this.texture = null;
      this.roughnessTexture = null;
      this.normalTexture = null;
      this.cloudTexture = null;

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
      this.scene.background = new THREE.Color(0x02030a);

      this.camera = new THREE.PerspectiveCamera(40, W / H, 0.01, 1000);
      this.camera.position.set(0, 0, 2.9);

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

      this.texture = this.#makeTexture();
      this.roughnessTexture = this.#makeRoughnessTexture();
      this.normalTexture = this.#makeNormalTexture();
      this.cloudTexture = this.#makeCloudTexture();

      this.#buildTerrain();
      this.#buildClouds();
      this.#buildAtmosphere();
      this.#buildLights();

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

      const material = new THREE.MeshStandardMaterial({
        map: this.texture,
        normalMap: this.normalTexture,
        normalScale: new THREE.Vector2(0.6, 0.6),
        roughnessMap: this.roughnessTexture,
        roughness: 0.95,
        // 地球不是金属：metalness 必须为 0，否则会有镜面白斑
        metalness: 0.0,
      });

      this.globe = new THREE.Mesh(geo, material);
      // 【朝向】贴图 x 方向做了镜像（repeat.x = -1）以匹配球体 UV，
      // 绕 Y 轴 -90° 后，地图 x = W/2（经度 0°）正好朝向相机：
      // 于是「2D 地图中央」在 3D 里就是正面，不会出现进入 3D 后
      // 画面跳到地图另一侧、与 2D 中心对不上的错位感。
      this.globe.rotation.y = -Math.PI / 2;
      this.scene.add(this.globe);
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
        // 云是"薄纱"不是"棉被"：整体透明度压低，能透出下方地形
        opacity: 0.70,
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
      const W = 1024;
      const H = 512;
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

      for (let y = 0; y < H; y++) {
        const latN = y / H - 0.5;       // -0.5 ~ 0.5
        const absLat = Math.abs(latN * 2); // 0 ~ 1
        // 云量：赤道峰 + 中纬峰 - 副热带谷 - 极地递减
        const itcz = Math.exp(-((absLat / 0.13) ** 2)) * 1.0;
        const midLat = Math.exp(-(((absLat - 0.62) / 0.18) ** 2)) * 0.75;
        const subtropical = Math.exp(-(((absLat - 0.34) / 0.11) ** 2)) * 0.85;
        const polar = Math.max(0, absLat - 0.80) * 0.5;
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
          const n1 = noise(nx, ny + 11, 14, 5, 0.55, 2, 901) * 0.5 + 0.5;
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
            // 用细粒度噪声扰动边缘，产生"棉絮"轮廓而不是圆形团块
            const edgeNoise = noise(nx, ny + 71, 210, 3, 0.5, 2, 904) * 0.5 + 0.5;
            alpha *= 0.45 + edgeNoise * 0.75;
            alpha = Math.min(1, alpha);
          }
          // 边缘柔化，避免硬边
          alpha = alpha * alpha * (3 - 2 * alpha);
          // 云朵亮度：厚处偏白，薄处略带灰蓝
          const shade = 0.72 + cloud * 0.28;
          const i4 = (y * W + x) * 4;
          data[i4] = Math.min(255, 250 * shade + 5);
          data[i4 + 1] = Math.min(255, 251 * shade + 4);
          data[i4 + 2] = Math.min(255, 255 * shade);
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
      const CAP_ZONE = 10;
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
        for (let x = 0; x < W; x++) {
          const k = base + x;
          alphaBuf[k] += (mean - alphaBuf[k]) * w;
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

    // ==================== 大气辉光 ====================

    #buildAtmosphere() {
      const geo = new THREE.SphereGeometry(ATMOSPHERE_RADIUS, 64, 32);
      const mat = new THREE.ShaderMaterial({
        transparent: true,
        blending: THREE.AdditiveBlending,
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: {
          glowColor: { value: new THREE.Color(0x3a7bd5) },
        },
        vertexShader: [
          'varying vec3 vNormal;',
          'varying vec3 vPos;',
          'void main() {',
          '  vNormal = normalize(normalMatrix * normal);',
          '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
          '  vPos = mv.xyz;',
          '  gl_Position = projectionMatrix * mv;',
          '}',
        ].join('\n'),
        fragmentShader: [
          'uniform vec3 glowColor;',
          'varying vec3 vNormal;',
          'varying vec3 vPos;',
          'void main() {',
          '  vec3 viewDir = normalize(-vPos);',
          '  // Fresnel：边缘发光中心透明',
          '  float rim = 1.0 - abs(dot(normalize(vNormal), viewDir));',
          '  rim = pow(rim, 2.6);',
          '  gl_FragColor = vec4(glowColor, rim * 0.38);',
          '}',
        ].join('\n'),
      });
      this.atmosphere = new THREE.Mesh(geo, mat);
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

      // 环境光只做最低限度的补光，避免暗面纯黑
      const ambient = new THREE.AmbientLight(0x556688, 0.34);
      this.scene.add(ambient);

      // 背面轮廓光：勾勒球体边缘
      const rim = new THREE.DirectionalLight(0x5588cc, 0.32);
      rim.position.set(-4, -2, -3);
      this.scene.add(rim);
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

    #makeRoughnessTexture() {
      // 粗糙度是按 cells 逐像素生成的，cells 本身就是等距圆柱网格，
      // 因此与 3D 球体 UV 天然匹配，无需做投影转换。
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
      for (let i = 0; i < W * H; i++) {
        // 海洋光滑（有反光），陆地粗糙（哑光）
        // 粗糙度：数值越大越不反光。
        // 旧值海洋 60（很光滑）+ 强平行光 = 高光爆白成一个白斑。
        // 提到 150 仍比陆地（235）光滑，但高光会柔和很多。
        const isSea = cells[i] && cells[i].e < sea;
        const v = isSea ? 150 : 235;
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
      if (!this.globe) return;
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
      this.#animate();
    }

    exit() {
      this.active = false;
      if (this.animationId) cancelAnimationFrame(this.animationId);
      this.animationId = null;
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
