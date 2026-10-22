/**
 * storage.js —— 地图配置的导入与导出
 *
 * 只序列化「改变地图所必需」的数据：地形高度与湖泊标记。
 * 气候、群系、河流等一律在导入后按地形重新推导，
 * 这样旧存档不会因为算法升级而出现脏数据。
 */
(function (root) {
  'use strict';

  const FM = root.FM = root.FM || {};

  const CHUNK = 0x8000;

  function bufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  function base64ToBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  class MapStorage {
    /** 导出为普通对象（调用方再 JSON.stringify） */
    static exportData(generator) {
      const W = generator.width;
      const H = generator.height;
      const N = W * H;
      const eArr = new Float32Array(N);
      const lakeArr = new Uint8Array(N);
      for (let i = 0; i < N; i++) {
        const c = generator.cells[i];
        eArr[i] = c.e;
        lakeArr[i] = c.isLake ? 1 : 0;
      }
      return {
        version: 2,
        width: W,
        height: H,
        seaLevel: generator.seaLevel,
        eData: bufferToBase64(eArr.buffer),
        lakeData: bufferToBase64(lakeArr.buffer),
      };
    }

    /** 从导出对象恢复地图；返回 { ok, message } */
    static importData(data, generator) {
      if (!data || typeof data !== 'object') throw new Error('不是有效的地图配置文件');
      const W = data.width;
      const H = data.height;
      if (!W || !H) throw new Error('缺少地图尺寸');
      if (W !== generator.width || H !== generator.height) {
        throw new Error('地图尺寸不匹配：文件为 ' + W + 'x' + H + '，当前为 ' + generator.width + 'x' + generator.height);
      }
      if (!data.eData) throw new Error('缺少地形数据');
      if (!generator.simplex) generator.simplex = new SimplexNoise();

      const e = new Float32Array(base64ToBuffer(data.eData));
      if (e.length !== W * H) throw new Error('数据长度与地图尺寸不符');

      generator.seaLevel = data.seaLevel;
      generator.cells = new Array(W * H);
      generator.simplex = new SimplexNoise();

      // 重建格子：温度和湿度按地形重新推导
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          const elev = e[i];
          const nx = x / W;
          const ny = y / H - 0.5;
          const m = (generator.noiseSeamless(nx, ny + 20, 2, 4) + 1) / 2;
          const latT = 1.0 - Math.abs(ny * 2) ** 1.2;
          let temp = latT * 0.85 + ((generator.noiseSeamless(nx, ny + 30, 2, 3) + 1) / 2) * 0.15;
          if (elev > generator.seaLevel) {
            temp -= ((elev - generator.seaLevel) / (1.0 - generator.seaLevel)) * 0.7;
          }
          generator.cells[i] = {
            x, y,
            e: elev,
            m,
            temp: Math.max(0, Math.min(1, temp)),
            isRiver: false,
            isLake: false,
            flow: 0,
            current: { u: 0, v: 0 },
            biome: '海洋',
          };
        }
      }

      // 气候、群系、水系全部按新地形重新推导
      generator.rebuildHydrology();

      return { ok: true, message: '已导入 ' + W + 'x' + H + ' 地图' };
    }
  }

  FM.MapStorage = MapStorage;
})(window);
