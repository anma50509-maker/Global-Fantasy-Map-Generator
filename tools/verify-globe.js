#!/usr/bin/env node
/**
 * verify-globe.js —— js/globe.js 的量化验证
 *
 * 【为什么需要这个脚本】
 * 3D 视图「看起来有没有星球氛围」只能靠截图判断，但有一批**能算出来**的
 * 东西必须先守住，否则每次改材质/加层都可能悄悄改坏某个几何或生命周期：
 *
 *   1. 层级与半径关系：地形最高 1.055 < 云 1.075 < 内层大气 1.16 < 外层 1.60，
 *      地名精灵 1.068 必须在地形之上、云之下 —— 任何一层放错都会出现
 *      「山峰顶穿云层 / 大气断环 / 地名陷进山里」。
 *   2. 星空贴图：尺寸 2048×1024、固定种子、两次生成**逐操作一致**
 *      （用桩 canvas 记录绘图指令做哈希）。
 *   3. 云图：1536×768，极区平均 alpha 显著低于赤道（旧版的「极区白带」
 *      就是极区云量没压下去 + 极点行收敛造成的）。
 *   4. 地名精灵：坐标换算（球心在原点）、半径、尺寸钳制、最多 40 个、
 *      背面被 depthTest 挡住、模式切换/退出时纹理被 dispose（不泄漏）、
 *      getLabels 缺失/抛异常/返回脏数据时 3D 不崩。
 *
 * 这里用一套**桩 THREE + 桩 canvas** 在 Node 里真跑 init()，不是纯文本匹配：
 * 静态检查只能防「常量被改错」，跑起来才能防「方法调用写错、生命周期漏 dispose」。
 * 真实 WebGL 行为（光照/混合/像素）仍以浏览器截图为准。
 *
 * 用法：node tools/verify-globe.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const GLOBE_PATH = path.join(__dirname, '..', 'js', 'globe.js');
const SOURCE = fs.readFileSync(GLOBE_PATH, 'utf8');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name + (detail ? '  [' + detail + ']' : ''));
  } else {
    fail++;
    failures.push(name + (detail ? ' — ' + detail : ''));
    console.log('  ✗ ' + name + (detail ? '  [' + detail + ']' : ''));
  }
}

function section(title) {
  console.log('\n== ' + title + ' ==');
}

function approx(a, b, eps) {
  return Math.abs(a - b) <= (eps === undefined ? 1e-6 : eps);
}

// ==================== 1. 静态检查（常量 / 关键写法）====================

section('静态检查');

/** 从源码里抠出某个 const 的数值（比 eval 安全，也不依赖执行顺序） */
function constValue(name) {
  const re = new RegExp('const\\s+' + name + '\\s*=\\s*([0-9.]+)');
  const m = SOURCE.match(re);
  return m ? parseFloat(m[1]) : NaN;
}

const DISPLACEMENT = constValue('DISPLACEMENT');
const CLOUD_ALTITUDE = constValue('CLOUD_ALTITUDE');
const ATMO_INNER = constValue('ATMOSPHERE_INNER_RADIUS');
const ATMO_OUTER = constValue('ATMOSPHERE_OUTER_RADIUS');
const LABEL_RADIUS = constValue('LABEL_RADIUS');
const LABEL_MAX = constValue('LABEL_MAX');
const STAR_RADIUS = constValue('STAR_RADIUS');

check('常量 DISPLACEMENT = 0.055', approx(DISPLACEMENT, 0.055), String(DISPLACEMENT));
check('云层高于最高地形 (1+0.055)', CLOUD_ALTITUDE > 1 + DISPLACEMENT - 1e-9,
  'CLOUD_ALTITUDE=' + CLOUD_ALTITUDE);
check('内层大气高于云层', ATMO_INNER > CLOUD_ALTITUDE,
  'inner=' + ATMO_INNER + ' > cloud=' + CLOUD_ALTITUDE);
check('外层大气高于内层', ATMO_OUTER > ATMO_INNER,
  'outer=' + ATMO_OUTER);
check('地名精灵半径在地形之上、云层之下',
  LABEL_RADIUS > 1 + DISPLACEMENT - 1e-9 && LABEL_RADIUS < CLOUD_ALTITUDE,
  'label=' + LABEL_RADIUS);
check('地名精灵上限 40', LABEL_MAX === 40, String(LABEL_MAX));
check('星空球半径足够大（>30）', STAR_RADIUS > 30, String(STAR_RADIUS));
check('不再用纯黑 scene.background',
  !/scene\.background\s*=\s*new THREE\.Color\(0x02030a\)/.test(SOURCE));
check('地表材质用 MeshPhongMaterial + specularMap',
  /new THREE\.MeshPhongMaterial\([\s\S]{0,400}?specularMap:/.test(SOURCE));
check('材质保留 normalMap（地形凹凸不能丢）',
  /normalMap: this\.normalTexture/.test(SOURCE));
check('大气层双层构建（atmosphereInner 存在）',
  /this\.atmosphereInner\s*=\s*new THREE\.Mesh/.test(SOURCE));
check('云层贴图 1536×768',
  /const W = 1536;\s*\n\s*const H = 768;/.test(SOURCE));
check('星空贴图 2048×1024',
  /const W = 2048;\s*\n\s*const H = 1024;/.test(SOURCE));
check('相机距离 3.25（给球体留呼吸空间）',
  /camera\.position\.set\(0, 0, 3\.25\)/.test(SOURCE));
check('云层整体透明度 0.58', /opacity: 0\.58/.test(SOURCE));
check('地名只在手绘模式（named / lettered）显示',
  /mode !== 'named' && mode !== 'lettered'/.test(SOURCE));
check('sprite 开启 depthTest、关闭 depthWrite',
  /depthTest: true,\s*\n\s*depthWrite: false/.test(SOURCE));
check('刷新标签有签名去重', /_labelSignature/.test(SOURCE));
check('退出 3D 时清理标签', /#clearLabels\(\);[\s\S]{0,200}?domElement\.style\.display/.test(SOURCE));

// ==================== 2. 桩环境 ====================

/**
 * 极简 THREE 桩：只实现 globe.js 真正调用到的接口。
 * 所有数值都以普通对象暴露，方便断言几何/材质参数。
 */
function makeTHREEStub() {
  class V3 {
    constructor(x, y, z) { this.x = x || 0; this.y = y || 0; this.z = z || 0; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
    clone() { return new V3(this.x, this.y, this.z); }
    length() { return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z); }
    normalize() {
      const l = this.length() || 1;
      this.x /= l; this.y /= l; this.z /= l;
      return this;
    }
    multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
    addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
    sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
    subVectors(a, b) { this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this; }
    crossVectors(a, b) {
      const ax = a.x, ay = a.y, az = a.z, bx = b.x, by = b.y, bz = b.z;
      this.x = ay * bz - az * by;
      this.y = az * bx - ax * bz;
      this.z = ax * by - ay * bx;
      return this;
    }
    dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  }
  class V2 {
    constructor(x, y) { this.x = x || 0; this.y = y || 0; }
    set(x, y) { this.x = x; this.y = y; return this; }
  }
  class Texture {
    constructor(image) {
      this.image = image;
      this.repeat = { x: 1, y: 1 };
      this.wrapS = 1001;
      this.wrapT = 1001;
      this.anisotropy = 1;
      this.minFilter = 1006;
      this.magFilter = 1006;
      this.encoding = 3000;
      this.disposed = false;
    }
    dispose() { this.disposed = true; }
  }
  class Object3D {
    constructor() {
      this.position = new V3();
      this.rotation = { x: 0, y: 0, z: 0 };
      this.scale = new V3(1, 1, 1);
      this.children = [];
      this.visible = true;
      this.renderOrder = 0;
      this.userData = {};
    }
    add(o) { this.children.push(o); return this; }
    remove(o) {
      const i = this.children.indexOf(o);
      if (i >= 0) this.children.splice(i, 1);
      return this;
    }
    updateMatrixWorld() {}
  }
  class Group extends Object3D {}
  class Mesh extends Object3D {
    constructor(geometry, material) {
      super();
      this.geometry = geometry;
      this.material = material;
    }
  }
  class Points extends Object3D {
    constructor(geometry, material) {
      super();
      this.geometry = geometry;
      this.material = material;
    }
  }
  class Sprite extends Object3D {
    constructor(material) {
      super();
      this.material = material;
      this.isSprite = true;
      /** 记录 dispose 次数，供泄漏检查 */
      this._disposed = 0;
    }
    getWorldPosition(target) {
      // 桩环境里 labelGroup 只有 Y 轴旋转，按真实变换算一下
      const g = this.parentGroup;
      const ry = g ? g.rotation.y : 0;
      const c = Math.cos(ry);
      const s = Math.sin(ry);
      target.set(
        this.position.x * c + this.position.z * s,
        this.position.y,
        -this.position.x * s + this.position.z * c
      );
      return target;
    }
  }
  class BufferAttribute {
    constructor(array, itemSize) {
      this.array = array;
      this.itemSize = itemSize;
      this.count = array ? array.length / itemSize : 0;
      this.needsUpdate = false;
    }
  }
  class BufferGeometry {
    constructor() {
      this.attributes = {};
      this.disposed = false;
    }
    setAttribute(name, attr) { this.attributes[name] = attr; return this; }
    dispose() { this.disposed = true; }
  }
  class Geometry {
    constructor(widthSegments, heightSegments) {
      const count = (widthSegments + 1) * (heightSegments + 1);
      const n = count * 3;
      const arr = new Float32Array(n);
      // 粗略填充成球面单位向量（只为让位移循环有值可算）
      for (let i = 0; i < count; i++) {
        const iy = Math.floor(i / (widthSegments + 1));
        const ix = i % (widthSegments + 1);
        const v = iy / heightSegments;
        const u = ix / widthSegments;
        const theta = v * Math.PI;
        const phi = u * Math.PI * 2;
        arr[i * 3] = -Math.cos(phi) * Math.sin(theta);
        arr[i * 3 + 1] = Math.cos(theta);
        arr[i * 3 + 2] = Math.sin(phi) * Math.sin(theta);
      }
      const position = {
        count,
        array: arr,
        needsUpdate: false,
        getX(i) { return arr[i * 3]; },
        getY(i) { return arr[i * 3 + 1]; },
        getZ(i) { return arr[i * 3 + 2]; },
        setXYZ(i, x, y, z) { arr[i * 3] = x; arr[i * 3 + 1] = y; arr[i * 3 + 2] = z; },
      };
      this.attributes = { position };
    }
    computeVertexNormals() { this._normals = true; }
    dispose() { this._disposed = true; }
  }
  class ColorValue {
    constructor(hex) { this.hex = hex || 0; }
    setHex(hex) { this.hex = hex; return this; }
  }
  class Material {
    constructor(opts) {
      Object.assign(this, opts || {});
      this.color = new ColorValue(0xffffff);
      this.disposed = false;
    }
    dispose() { this.disposed = true; }
  }
  class WebGLRenderer {
    constructor() {
      this.domElement = makeFakeCanvas(1, 1);
      this.domElement.style = {};
      this.capabilities = { getMaxAnisotropy: () => 16 };
      this.outputEncoding = 3000;
      this.renderCount = 0;
    }
    setSize(w, h) { this.domElement.width = w; this.domElement.height = h; }
    setPixelRatio() {}
    render() { this.renderCount++; }
  }
  class Camera {
    constructor() {
      this.position = new V3(0, 0, 3.25);
      this.aspect = 1.4;
    }
    updateProjectionMatrix() {}
  }
  class OrbitControls {
    constructor() {}
    update() { return false; }
  }
  const THREE = {
    Scene: class extends Object3D {},
    Color: ColorValue,
    BufferAttribute,
    BufferGeometry,
    PerspectiveCamera: Camera,
    WebGLRenderer,
    CanvasTexture: Texture,
    Texture,
    SphereGeometry: class extends Geometry {
      constructor(radius, ws, hs) {
        super(ws, hs);
        this.radius = radius;
        this.params = { widthSegments: ws, heightSegments: hs };
      }
    },
    MeshPhongMaterial: class extends Material {},
    MeshLambertMaterial: class extends Material {},
    MeshBasicMaterial: class extends Material {},
    ShaderMaterial: class extends Material {},
    SpriteMaterial: class extends Material {},
    LineBasicMaterial: class extends Material {},
    PointsMaterial: class extends Material {},
    Mesh,
    Sprite,
    Points,
    LineSegments: class extends Mesh {},
    Group,
    DirectionalLight: class extends Object3D {
      constructor(color, intensity) { super(); this.color = new ColorValue(color); this.intensity = intensity; }
    },
    AmbientLight: class extends Object3D {
      constructor(color, intensity) { super(); this.color = new ColorValue(color); this.intensity = intensity; }
    },
    Vector2: V2,
    Vector3: V3,
    OrbitControls,
    RepeatWrapping: 1000,
    LinearMipmapLinearFilter: 1008,
    sRGBEncoding: 3001,
    AdditiveBlending: 2,
    NormalBlending: 1,
    BackSide: 1,
    FrontSide: 0,
  };
  return THREE;
}

// ==================== 桩 canvas（带绘图指令记录，用于确定性哈希）====================

function makeFakeCanvas(w, h) {
  const canvas = {
    width: w || 300,
    height: h || 150,
    _ops: [],
    _lastImageData: null,
    style: {},
    getContext() { return makeFakeCtx(canvas); },
    toDataURL() { return 'data:,'; },
  };
  return canvas;
}

function makeFakeCtx(canvas) {
  const ops = canvas._ops;
  const rec = (name, args) => {
    // 只记录会影响像素的参数，做确定性哈希
    ops.push(name + ':' + args.join(','));
  };
  const gradient = (kind, args) => {
    const g = {
      addColorStop(pos, color) { rec(kind + '.stop', [pos, color]); },
    };
    rec(kind, args);
    return g;
  };
  return {
    canvas,
    font: '',
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    lineJoin: 'miter',
    miterLimit: 10,
    textAlign: 'start',
    textBaseline: 'alphabetic',
    globalAlpha: 1,
    measureText(text) {
      // 粗略按 1em ≈ fontSize 估算（只为尺寸钳制逻辑服务）
      const m = /(\d+)px/.exec(this.font || '');
      const fs = m ? parseInt(m[1], 10) : 10;
      return { width: String(text).length * fs * 0.92 };
    },
    createLinearGradient(x0, y0, x1, y1) { return gradient('linear', [x0, y0, x1, y1]); },
    createRadialGradient(x0, y0, r0, x1, y1, r1) { return gradient('radial', [x0, y0, r0, x1, y1, r1]); },
    fillRect(x, y, w, h) { rec('fillRect', [x, y, w, h]); },
    beginPath() {},
    arc(x, y, r) { rec('arc', [x, y, r]); },
    fill() { rec('fill', [String(this.fillStyle)]); },
    stroke() { rec('stroke', [String(this.strokeStyle)]); },
    moveTo(x, y) { rec('moveTo', [x, y]); },
    lineTo(x, y) { rec('lineTo', [x, y]); },
    fillText(text, x, y) { rec('fillText', [text, x, y, String(this.fillStyle), this.font]); },
    strokeText(text, x, y) { rec('strokeText', [text, x, y, String(this.strokeStyle), this.lineWidth]); },
    drawImage() { rec('drawImage', []); },
    createImageData(w, h) {
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    },
    getImageData(x, y, w, h) {
      return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    },
    putImageData(img) {
      canvas._lastImageData = img;
      rec('putImageData', [img.width, img.height]);
    },
  };
}

/** FNV-1a 字符串哈希，用于比较两次星空绘制是否完全一致 */
function hashOps(ops) {
  let h = 0x811c9dc5;
  const s = ops.join('\n');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// ==================== 假 generator / renderer ====================

function makeGenerator(noise) {
  const W = 1600;
  const H = 800;
  const cells = new Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // 造一些陆地：以几个圆形大陆为骨架，其余为海
      const u = x / W;
      const v = y / H;
      let e = 0.55 +
        0.18 * Math.sin(u * Math.PI * 6) * Math.cos(v * Math.PI * 4) +
        0.10 * Math.sin(v * Math.PI * 9 + 1.3);
      cells[y * W + x] = { e };
    }
  }
  return {
    width: W,
    height: H,
    seaLevel: 0.58,
    cells,
    noiseSeamless: noise,
  };
}

/**
 * 轻量确定性噪声桩。
 * 真实 simplex 噪声在 Node 下太慢（1500×768 云图要十几秒），
 * 这里只追求「确定性 + 值域合理」，用来验证结构与统计性质。
 */
function makeCheapNoise() {
  const hash = (x, y, z) => {
    let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 2147483647);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const smooth = (t) => t * t * (3 - 2 * t);
  const value = (x, y, z) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const tx = smooth(x - xi), ty = smooth(y - yi), tz = smooth(z - zi);
    const lerp = (a, b, t) => a + (b - a) * t;
    const c000 = hash(xi, yi, zi), c100 = hash(xi + 1, yi, zi);
    const c010 = hash(xi, yi + 1, zi), c110 = hash(xi + 1, yi + 1, zi);
    const c001 = hash(xi, yi, zi + 1), c101 = hash(xi + 1, yi, zi + 1);
    const c011 = hash(xi, yi + 1, zi + 1), c111 = hash(xi + 1, yi + 1, zi + 1);
    const x00 = lerp(c000, c100, tx), x10 = lerp(c010, c110, tx);
    const x01 = lerp(c001, c101, tx), x11 = lerp(c011, c111, tx);
    const y0 = lerp(x00, x10, ty), y1 = lerp(x01, x11, ty);
    return lerp(y0, y1, tz) * 2 - 1;
  };
  return function noiseSeamless(nx, ny, baseFrequency, octaves, persistence, lacunarity, offset) {
    const lon = nx * Math.PI * 2;
    const lat = (0.5 - ny) * Math.PI;   // 与 globe.js 的调用方约定保持一致（ny=latN）
    const cosLat = Math.cos(lat);
    const sinLat = Math.sin(lat);
    const cosLon = Math.cos(lon);
    const sinLon = Math.sin(lon);
    let total = 0;
    let amp = 1;
    let freq = baseFrequency;
    let maxV = 0;
    // 桩环境只求「确定性 + 值域合理」，八度截到 2 个以缩短验证耗时
    const octCount = Math.min(octaves || 5, 2);
    for (let i = 0; i < octCount; i++) {
      const R = freq / Math.PI;
      total += value(cosLat * cosLon * R + (offset || 0), sinLat * R + (offset || 0), cosLat * sinLon * R + (offset || 0)) * amp;
      maxV += amp;
      amp *= (persistence || 0.5);
      freq *= (lacunarity || 2);
    }
    return total / maxV;
  };
}

function makeRenderer(generator) {
  const canvas = makeFakeCanvas(1600, 800);
  return {
    viewMode: 'satellite',
    width: 1600,
    height: 800,
    generator,
    renderEquirectTexture() { return canvas; },
    getLabels: null,
    _labels: null,
  };
}

// ==================== 3. 执行 globe.js ====================

const THREE = makeTHREEStub();
const noise = makeCheapNoise();
const generator = makeGenerator(noise);
const renderer = makeRenderer(generator);

const container = {
  clientWidth: 1200,
  clientHeight: 900,
  children: [],
  appendChild(el) { this.children.push(el); },
};

const sandbox = {
  THREE,
  console,
  Math,
  performance,
  document: {
    createElement(tag) {
      if (tag === 'canvas') return makeFakeCanvas(300, 150);
      return { style: {} };
    },
  },
  requestAnimationFrame() { return 1; },
  cancelAnimationFrame() {},
  addEventListener() {},
};
sandbox.window = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(SOURCE, sandbox, { filename: 'globe.js' });

const GlobeView = sandbox.FM && sandbox.FM.GlobeView;
check('globe.js 在桩环境加载成功，FM.GlobeView 存在', !!GlobeView);

// ==================== 4. init() 结构与几何断言 ====================

section('init() 结构 / 几何');

const globe = new GlobeView({
  container,
  renderer,
  generator,
  canvas2d: { style: {} },
});

const t0 = Date.now();
globe.init();
const initMs = Date.now() - t0;
console.log('  · 桩环境 init 耗时 ' + initMs + ' ms（真实耗时以浏览器 lastTimings 为准）');

check('init 完成（scene/globe/cloud/atmosphere 都在）',
  !!globe.scene && !!globe.globe && !!globe.cloudMesh && !!globe.atmosphere);
check('星空球已创建且 renderOrder = -1',
  !!globe.starField && globe.starField.renderOrder === -1);
check('星空贴图 2048×1024',
  globe.starField.material.map.image.width === 2048 &&
  globe.starField.material.map.image.height === 1024);
check('星空材质关闭 depthTest/depthWrite（不遮挡星球）',
  globe.starField.material.depthTest === false && globe.starField.material.depthWrite === false);
check('两个大气壳半径 ' + ATMO_INNER + ' / ' + ATMO_OUTER,
  !!globe.atmosphereInner &&
  approx(globe.atmosphereInner.geometry.radius, ATMO_INNER) &&
  approx(globe.atmosphere.geometry.radius, ATMO_OUTER));
check('大气两层都是加色混合 + BackSide + 不写深度',
  globe.atmosphereInner.material.blending === 2 &&
  globe.atmosphereInner.material.side === 1 &&
  globe.atmosphereInner.material.depthWrite === false &&
  globe.atmosphere.material.blending === 2);
check('大气着色器包含昼/夜调制与轮廓遮罩',
  /dayColor/.test(globe.atmosphere.material.uniforms.dayColor ? 'dayColor' : '') &&
  /sunDir/.test(globe.atmosphere.material.uniforms.sunDir ? 'sunDir' : '') &&
  /planetRadius/.test(globe.atmosphere.material.uniforms.planetRadius ? 'planetRadius' : ''));
check('大气着色器按"视线到球心垂距"做遮罩（避免旧版白带）',
  /length\(cross\(-cameraPosition, rayDir\)\)/.test(SOURCE));
check('地表材质是 Phong 且带 specularMap / normalMap',
  globe.globe.material instanceof THREE.MeshPhongMaterial &&
  !!globe.globe.material.specularMap &&
  !!globe.globe.material.normalMap);
check('shininess 在 55~80 区间',
  globe.globe.material.shininess >= 55 && globe.globe.material.shininess <= 80,
  'shininess=' + globe.globe.material.shininess);
check('法线贴图强度保留（normalScale 0.6）',
  globe.globe.material.normalScale &&
  approx(globe.globe.material.normalScale.x, 0.6) &&
  approx(globe.globe.material.normalScale.y, 0.6));
check('云层球半径 = CLOUD_ALTITUDE',
  approx(globe.cloudMesh.geometry.radius, CLOUD_ALTITUDE));
check('云层透明度 0.58', approx(globe.cloudMesh.material.opacity, 0.58));
check('云层贴图 1536×768',
  globe.cloudMesh.material.map.image.width === 1536 &&
  globe.cloudMesh.material.map.image.height === 768);
check('地名层与地表同朝向',
  globe.labelGroup && approx(globe.labelGroup.rotation.y, globe.globe.rotation.y),
  'rotation.y=' + globe.labelGroup.rotation.y.toFixed(4));
check('统计耗时已记录（lastTimings 非空）',
  Array.isArray(globe.lastTimings) && globe.lastTimings.length >= 4);

// ==================== 5. 云图：极区云量必须显著低于赤道 ====================

section('云图统计（极区不应有白带）');

const cloudCtx = globe.cloudMesh.material.map.image;
const cloudData = cloudCtx._lastImageData;
check('云图 alpha 已写入', !!cloudData && cloudData.width === 1536);
if (cloudData) {
  const W = cloudData.width;
  const H = cloudData.height;
  const rowMean = (y) => {
    let s = 0;
    for (let x = 0; x < W; x++) s += cloudData.data[(y * W + x) * 4 + 3] / 255;
    return s / W;
  };
  const bandMean = (fromDeg, toDeg) => {
    // 纬度（北纬正）→ 行
    const y0 = Math.round(((90 - toDeg) / 180) * H);
    const y1 = Math.round(((90 - fromDeg) / 180) * H);
    let s = 0;
    let n = 0;
    for (let y = y0; y < y1; y++) { s += rowMean(y); n++; }
    return n ? s / n : 0;
  };
  const equator = bandMean(-8, 8);
  const polarN = bandMean(82, 90);
  const polarS = bandMean(-90, -82);
  const polar = (polarN + polarS) / 2;
  console.log('  · 赤道平均 alpha=' + equator.toFixed(3) +
    '，极区(>82°)=北 ' + polarN.toFixed(3) + ' / 南 ' + polarS.toFixed(3));
  check('极区平均云量 < 赤道的 60%（无极区白带）', polar < equator * 0.6,
    'polar=' + polar.toFixed(3) + ' equator=' + equator.toFixed(3));
  check('云图不是全透明（有云）', equator > 0.05, 'equator=' + equator.toFixed(3));
  check('云图不是全白（没有糊满）', equator < 0.85, 'equator=' + equator.toFixed(3));
}

// ==================== 6. 星空：固定种子、两次生成一致 ====================

section('星空确定性');

const starCanvas1 = globe.starField.material.map.image;
const hash1 = hashOps(starCanvas1._ops);
check('星空绘制指令数量 > 2000（星点确实画了）', starCanvas1._ops.length > 2000,
  'ops=' + starCanvas1._ops.length);

// 再建一个 GlobeView：同种子应生成完全相同的绘图指令序列
const globe2 = new GlobeView({
  container: { clientWidth: 800, clientHeight: 600, appendChild() {} },
  renderer: makeRenderer(generator),
  generator,
  canvas2d: { style: {} },
});
globe2.init();
const starCanvas2 = globe2.starField.material.map.image;
const hash2 = hashOps(starCanvas2._ops);
check('两次生成星空完全一致（固定种子）', hash1 === hash2,
  'hash1=' + hash1 + ' hash2=' + hash2);

// 星点纬度：不能画在极区（会被等距圆柱拉成经向细条）
const starLatCheck = (() => {
  let maxAbsLat = 0;
  // 从绘图指令里恢复星点 y 坐标并换算纬度。
  // 注意只统计「星点」：暗星是 1~2px 的 fillRect，中等星是 r<20 的 arc；
  // 背景 fillRect(0,0,2048,1024) 和银河柔光斑（arc r≥80）都不算。
  for (const op of starCanvas1._ops) {
    let m = /^fillRect:([0-9.]+),([0-9.]+),([0-9.]+),([0-9.]+)$/.exec(op);
    if (m) {
      if (parseFloat(m[3]) >= 4 || parseFloat(m[4]) >= 4) continue;
      maxAbsLat = Math.max(maxAbsLat, Math.abs(90 - (parseFloat(m[2]) / 1024) * 180));
      continue;
    }
    m = /^arc:([0-9.]+),([0-9.]+),([0-9.]+)$/.exec(op);
    if (m && parseFloat(m[3]) < 20) {
      maxAbsLat = Math.max(maxAbsLat, Math.abs(90 - (parseFloat(m[2]) / 1024) * 180));
    }
  }
  return maxAbsLat;
})();
check('星点纬度全部 ≤ 70°（避开极点拉伸）', starLatCheck <= 70,
  'maxAbsLat=' + starLatCheck.toFixed(1));

// ==================== 7. 地名精灵 ====================

section('地名精灵（含防御性编程）');

/** 生成标签数据：60 个，覆盖不同纬度/经度/字号/重要度 */
function makeLabels(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      text: '地名' + i,
      kind: i % 7 === 0 ? 'ocean' : 'continent',
      x: (i * 137.5) % 1600,
      y: (i * 71.3) % 800,
      size: 14 + (i % 5) * 4,
      rotate: (i % 3) * 0.1,
      importance: 1 + (i % 5),
    });
  }
  return out;
}

// 7.1 非 named 模式：即使有标签也不显示
renderer.viewMode = 'satellite';
renderer.getLabels = () => makeLabels(60);
globe.refreshLabels();
check('satellite 模式不创建精灵', globe.labelSprites.length === 0,
  'sprites=' + globe.labelSprites.length);

// 7.2 named 模式：创建并截断到 40
renderer.viewMode = 'named';
renderer.getLabels = () => makeLabels(60);
globe.refreshLabels();
check('named 模式创建精灵且不超过 40（球面去重 + 上限截断）',
  globe.labelSprites.length > 0 && globe.labelSprites.length <= 40,
  'sprites=' + globe.labelSprites.length);

// 7.3 位置：半径 = LABEL_RADIUS；球心在世界原点
let maxRadiusErr = 0;
let minRadius = Infinity;
let maxRadius = 0;
for (const sp of globe.labelSprites) {
  const p = sp.position;
  const r = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
  minRadius = Math.min(minRadius, r);
  maxRadius = Math.max(maxRadius, r);
  maxRadiusErr = Math.max(maxRadiusErr, Math.abs(r - LABEL_RADIUS));
  if (!isFinite(p.x) || !isFinite(p.y) || !isFinite(p.z)) maxRadiusErr = Infinity;
}
check('精灵半径恒等于 LABEL_RADIUS', maxRadiusErr < 1e-6,
  'min=' + minRadius.toFixed(4) + ' max=' + maxRadius.toFixed(4));

// 7.4 坐标换算：地图中心 (800,400) → 局部 +X；北极 (any, 0) → +Y
{
  renderer.getLabels = () => [
    { text: '中央', kind: 'continent', x: 800, y: 400, size: 20, importance: 5 },
    { text: '北极', kind: 'continent', x: 800, y: 0, size: 20, importance: 5 },
    { text: '南级', kind: 'continent', x: 800, y: 800, size: 20, importance: 5 },
  ];
  globe.refreshLabels();
  const [center, north, south] = globe.labelSprites;
  check('地图中心 (800,400) → 局部 (+R, 0, 0)',
    approx(center.position.x, LABEL_RADIUS, 1e-6) &&
    approx(center.position.y, 0, 1e-6) &&
    approx(center.position.z, 0, 1e-6),
    'pos=(' + center.position.x.toFixed(3) + ',' + center.position.y.toFixed(3) + ',' + center.position.z.toFixed(3) + ')');
  check('北极 (…,0) → 局部 (0, +R, 0)',
    approx(north.position.y, LABEL_RADIUS, 1e-6) &&
    Math.hypot(north.position.x, north.position.z) < 1e-6);
  check('南极 (…,800) → 局部 (0, −R, 0)',
    approx(south.position.y, -LABEL_RADIUS, 1e-6));
  // 尺寸：宽度/高度都在钳制范围内
  let badScale = 0;
  for (const sp of globe.labelSprites) {
    if (!(sp.scale.x > 0 && sp.scale.x <= 0.30 + 1e-9)) badScale++;
    if (!(sp.scale.y >= 0.030 - 1e-9 && sp.scale.y <= 0.090 + 1e-9)) badScale++;
  }
  check('精灵尺寸在钳制范围内（宽 ≤0.30，高 0.03~0.09）', badScale === 0, 'bad=' + badScale);
  check('精灵 depthTest=true / depthWrite=false（背面被球体遮挡）',
    center.material.depthTest === true && center.material.depthWrite === false);
}

// 7.5 签名去重：同样的标签再刷一次，精灵实例应被复用
{
  renderer.getLabels = () => makeLabels(60);
  globe.refreshLabels();
  const first = globe.labelSprites[0];
  const count = globe.labelSprites.length;
  globe.refreshLabels();
  check('相同标签二次刷新不重建纹理（实例复用）',
    globe.labelSprites.length === count && globe.labelSprites[0] === first);
}

// 7.6 模式切回 satellite：精灵清空 + 纹理 dispose
{
  renderer.getLabels = () => makeLabels(60);
  globe.refreshLabels();
  const sprites = globe.labelSprites.slice();
  const textures = sprites.map((s) => s.material.map);
  globe.renderer.viewMode = 'satellite';
  globe.refreshLabels();
  check('切回 satellite 后精灵清空', globe.labelSprites.length === 0);
  check('纹理已 dispose（不泄漏显存）', textures.every((t) => t.disposed === true));
  check('材质已 dispose', sprites.every((s) => s.material.disposed === true));
}

// 7.7 防御性：getLabels 缺失 / 抛异常 / 返回脏数据
{
  renderer.viewMode = 'named';
  renderer.getLabels = undefined;
  let threw1 = false;
  try { globe.refreshLabels(); } catch (e) { threw1 = true; }
  check('getLabels 不存在时不抛错且无精灵', !threw1 && globe.labelSprites.length === 0);

  renderer.getLabels = () => { throw new Error('boom'); };
  let threw2 = false;
  try { globe.refreshLabels(); } catch (e) { threw2 = true; }
  check('getLabels 抛异常时不崩且无精灵', !threw2 && globe.labelSprites.length === 0);

  renderer.getLabels = () => [
    null,
    undefined,
    42,
    { text: '', x: 10, y: 10 },
    { text: '坐标坏了', x: NaN, y: 10 },
    { text: '正常', x: 100, y: 200, size: 18, importance: 3 },
  ];
  let threw3 = false;
  try { globe.refreshLabels(); } catch (e) { threw3 = true; }
  check('脏数据被逐项过滤（只保留 1 个合法标签）',
    !threw3 && globe.labelSprites.length === 1, 'sprites=' + globe.labelSprites.length);

  // 极端字号也不能生成巨图/负尺寸
  renderer.getLabels = () => [
    { text: '超长超长超长超长超长超长的地名', x: 400, y: 400, size: 9999, importance: 9 },
    { text: '极短', x: 1200, y: 400, size: -5, importance: -3 },
  ];
  let threw4 = false;
  try { globe.refreshLabels(); } catch (e) { threw4 = true; }
  check('异常字号被钳制且不抛错', !threw4 && globe.labelSprites.length === 2);
  let huge = false;
  for (const sp of globe.labelSprites) {
    if (!(sp.scale.x > 0 && sp.scale.x <= 0.30 + 1e-9)) huge = true;
    const tex = sp.material.map.image;
    if (!(tex.width > 0 && tex.width < 4096 && tex.height > 0 && tex.height < 4096)) huge = true;
  }
  check('异常字号下精灵尺寸与贴图尺寸仍有上限', !huge);
}

// 7.8 退出 3D：清空精灵
{
  renderer.getLabels = () => makeLabels(10);
  renderer.viewMode = 'named';
  globe.refreshLabels();
  const textures = globe.labelSprites.map((s) => s.material.map);
  globe.exit();
  check('exit() 后精灵清空', globe.labelSprites.length === 0);
  check('exit() 后纹理全部 dispose', textures.every((t) => t.disposed === true));
}

// ==================== 8. 性能相关：按需渲染开关仍在 ====================

section('性能优化保留');

check('按需渲染仍存在（_forceRender / controls.update）',
  /_forceRender/.test(SOURCE) && /controls\.update\(\)/.test(SOURCE));
check('云层自转降频逻辑保留',
  /cloudSpin/.test(SOURCE) && /Math\.abs\(targetAngle - this\.cloudMesh\.rotation\.y\)/.test(SOURCE));
check('antialias 仍为 false（省 overdraw）',
  /antialias: false/.test(SOURCE));
check('pixelRatio 限制在 1.5', /Math\.min\(window\.devicePixelRatio \|\| 1, 1\.5\)/.test(SOURCE));
check('sRGB 标记函数仍在', /function markSRGBTexture/.test(SOURCE));

// ==================== 汇总 ====================

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) {
  console.log('失败项：');
  for (const f of failures) console.log('  · ' + f);
  process.exitCode = 1;
} else {
  console.log('全部通过');
}
