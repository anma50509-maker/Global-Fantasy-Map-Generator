/**
 * main.js —— 应用装配
 *
 * 把生成器、渲染器、编辑器、3D 视图、存储模块接起来，并绑定所有 UI。
 * 页面脚本按依赖顺序加载：vendor/simplex-noise → hydrology → map-generator
 * → renderer → editor → globe → storage → main。
 */
(function () {
  'use strict';

  const FM = window.FM;
  const WIDTH = 1600;
  const HEIGHT = 800;

  const $ = (id) => document.getElementById(id);
  const els = {
    mapContainer: $('map-container'),
    canvas: $('mapCanvas'),
    overlay: $('overlayCanvas'),
    generateBtn: $('generateBtn'),
    toggle3DBtn: $('toggle3DBtn'),
    showClouds: $('showClouds'),
    cloudToggleWrap: $('cloudToggleWrap'),
    exportBtn: $('exportBtn'),
    plateCount: $('plateCount'),
    seaLevel: $('seaLevel'),
    seaLevelVal: $('seaLevelVal'),
    viewMode: $('viewMode'),
    projection: $('projection'),
    showGrid: $('showGrid'),
    showOceanCurrents: $('showOceanCurrents'),
    showMonsoon: $('showMonsoon'),
    importDataBtn: $('importDataBtn'),
    exportDataBtn: $('exportDataBtn'),
    importFileInput: $('importFileInput'),
    legend: $('legend'),
    legendContainer: $('legendContainer'),
    exportModal: $('exportModal'),
    exportedImg: $('exportedImg'),
    closeModal: $('closeModal'),
    directDownloadBtn: $('directDownloadBtn'),
    progressWrap: $('progressWrap'),
    progressFill: $('progressFill'),
    progressText: $('progressText'),
    statusBar: $('statusBar'),
    editMode: $('editMode'),
    editPanel: $('editPanel'),
    regionStrength: $('regionStrength'),
    regionStrengthVal: $('regionStrengthVal'),
    regionScale: $('regionScale'),
    regionScaleVal: $('regionScaleVal'),
    btnRegionLand: $('btnRegionLand'),
    btnRegionSea: $('btnRegionSea'),
    btnRegionClear: $('btnRegionClear'),
    undoBtn: $('undoBtn'),
    redoBtn: $('redoBtn'),
  };

  const generator = new FM.MapGenerator(WIDTH, HEIGHT);
  const renderer = new FM.MapRenderer(els.canvas, WIDTH, HEIGHT);
  renderer.setGenerator(generator);

  const editor = new FM.MapEditor({
    canvas: els.canvas,
    overlay: els.overlay,
    renderer,
    callbacks: {
      onStatus: (text) => setStatus(text),
      onHistoryChange: (undoDepth, redoDepth) => {
        els.undoBtn.disabled = undoDepth === 0;
        els.redoBtn.disabled = redoDepth === 0;
        els.undoBtn.textContent = '撤销' + (undoDepth ? ' (' + undoDepth + ')' : '');
        els.redoBtn.textContent = '重做' + (redoDepth ? ' (' + redoDepth + ')' : '');
      },
      onLassoChange: (has) => {
        // 有选区才让「隆起 / 沉陷」可用 —— 没有选区点了也是白点
        els.btnRegionLand.disabled = !has;
        els.btnRegionSea.disabled = !has;
        els.btnRegionClear.disabled = !has;
        els.btnRegionLand.classList.toggle('active', has);
        els.btnRegionSea.classList.toggle('active', has);
      },
    },
  });

  const globe = new FM.GlobeView({
    container: els.mapContainer,
    renderer,
    generator,
    canvas2d: els.canvas,
  });

  renderer.onTextureChange = () => {
    if (globe.scene) globe.updateTexture();
  };

  let busy = false;

  // ==================== 基础状态 ====================

  function setStatus(text) {
    els.statusBar.textContent = text;
  }

  function showProgress(visible) {
    els.progressWrap.style.display = visible ? 'block' : 'none';
  }

  function updateProgress(p, label) {
    const pct = Math.round(Math.max(0, Math.min(1, p)) * 100);
    els.progressFill.style.width = pct + '%';
    els.progressText.textContent = label + ' ' + pct + '%';
  }

  function refreshLegend() {
    renderer.updateLegend(els.legend);
    els.legendContainer.style.display = 'block';
  }

  // ==================== 生成地图 ====================

  async function generateMap() {
    if (busy) return;
    busy = true;
    const params = {
      plateCount: parseInt(els.plateCount.value, 10) || 6,
      seaLevel: (parseInt(els.seaLevel.value, 10) || 70) / 100,
    };

    els.generateBtn.disabled = true;
    els.generateBtn.textContent = '生成中…';
    showProgress(true);
    updateProgress(0, '准备…');
    setStatus('正在生成世界…');

    const t0 = performance.now();
    try {
      const stats = await generator.generate(params, (p, label) => updateProgress(p, label));
      editor.setGenerator(generator);
      renderer.updateOceanDepth();
      renderer.render();
      refreshLegend();
      const seconds = ((performance.now() - t0) / 1000).toFixed(1);
      setStatus(
        '生成完成（' + seconds + ' 秒' +
        (stats.terrainThreads > 1 ? ' · 地形 ' + stats.terrainThreads + ' 线程并行' : '') + '）· 河流 ' + stats.riverCount +
        ' 段 · 湖泊 ' + stats.lakeCount + ' 个 · 水文 ' + Math.round(stats.totalMs) + ' ms'
      );
    } catch (error) {
      console.error(error);
      setStatus('生成失败：' + error.message);
    } finally {
      busy = false;
      els.generateBtn.disabled = false;
      els.generateBtn.textContent = '生成新地图';
      showProgress(false);
    }
  }

  // ==================== UI 绑定：显示选项 ====================

  els.generateBtn.addEventListener('click', generateMap);

  els.viewMode.addEventListener('change', () => {
    renderer.setViewMode(els.viewMode.value);
    renderer.render();
    refreshLegend();
  });

  const refreshRender = () => {
    renderer.setOptions({
      showGrid: els.showGrid.checked,
      showOceanCurrents: els.showOceanCurrents.checked,
      showMonsoon: els.showMonsoon.checked,
    });
    renderer.render();
  };
  els.seaLevel.addEventListener('input', () => {
    els.seaLevelVal.textContent = els.seaLevel.value + '%';
  });

  els.projection.addEventListener('change', () => {
    renderer.setProjection(els.projection.value);
    renderer.render();
    setStatus('已切换投影：' + (FM.PROJECTIONS[els.projection.value] || {}).label);
  });
  els.showGrid.addEventListener('change', refreshRender);
  els.showOceanCurrents.addEventListener('change', refreshRender);
  els.showMonsoon.addEventListener('change', refreshRender);

  // ==================== 编辑器 UI ====================

  els.editMode.addEventListener('change', () => {
    const enabled = els.editMode.checked;
    if (enabled && globe.is3D) {
      globe.exit();
      update3DButton(false);
    }
    els.editPanel.style.display = enabled ? 'block' : 'none';
    els.overlay.style.display = enabled ? 'block' : 'none';
    els.canvas.classList.toggle('editing', enabled);
    editor.setEnabled(enabled);
    setStatus(enabled ? '编辑模式：在地图上圈一块地，再点「隆起成大陆」或「沉陷成海洋」' : '浏览模式');
  });

  els.regionStrength.addEventListener('input', () => {
    const value = parseFloat(els.regionStrength.value) || 0.82;
    els.regionStrengthVal.textContent = value.toFixed(2);
    editor.setStrength(value);
  });

  els.regionScale.addEventListener('input', () => {
    const value = parseFloat(els.regionScale.value) || 1;
    els.regionScaleVal.textContent = value.toFixed(2);
    editor.setDetailScale(value);
  });

  const regionAction = (mode) => {
    if (!editor.hasLasso()) {
      setStatus('请先在地图上按住拖动画一个圈');
      return;
    }
    const info = editor.selectionInfo();
    if (info && info.w < 24) {
      setStatus('选区太小（' + Math.round(info.w) + ' 格宽）· 画大一点才有海岸线');
      return;
    }
    editor.applyRegionAction(mode);
  };
  els.btnRegionLand.addEventListener('click', () => regionAction('land'));
  els.btnRegionSea.addEventListener('click', () => regionAction('sea'));
  els.btnRegionClear.addEventListener('click', () => editor.clearLasso());

  els.undoBtn.addEventListener('click', () => editor.undo());
  els.redoBtn.addEventListener('click', () => editor.redo());

  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key === 'z' || e.key === 'Z') {
      e.preventDefault();
      if (e.shiftKey) editor.redo();
      else editor.undo();
    } else if (e.key === 'y' || e.key === 'Y') {
      e.preventDefault();
      editor.redo();
    }
  });

  // ==================== 3D 视图 ====================

  function update3DButton(is3D) {
    els.toggle3DBtn.textContent = is3D ? '返回 2D 视图' : '进入 3D 视图';
    els.toggle3DBtn.style.backgroundColor = is3D ? '#e74c3c' : '#3498db';
    els.overlay.style.display = is3D ? 'none' : els.editMode.checked ? 'block' : 'none';
    // 云层开关只在 3D 模式下显示
    els.cloudToggleWrap.style.display = is3D ? 'block' : 'none';
  }

  els.showClouds.addEventListener('change', () => {
    globe.setCloudsVisible(els.showClouds.checked);
  });

  els.toggle3DBtn.addEventListener('click', () => {
    if (!FM.GlobeView.available) {
      setStatus('3D 视图初始化失败：three.js 未加载');
      return;
    }
    if (!globe.is3D && els.editMode.checked) {
      els.editMode.checked = false;
      els.editMode.dispatchEvent(new Event('change'));
    }
    try {
      const is3D = globe.toggle();
      update3DButton(is3D);
      setStatus(is3D ? '3D 视图：拖拽旋转，滚轮缩放' : '已返回 2D 视图');
    } catch (error) {
      console.error(error);
      update3DButton(false);
      setStatus('3D 视图初始化失败（可能是浏览器不支持 WebGL）：' + error.message);
    }
  });

  // ==================== 导入 / 导出 ====================

  els.exportBtn.addEventListener('click', () => {
    try {
      els.exportedImg.src = renderer.exportPNG();
      els.exportModal.style.display = 'block';
    } catch (error) {
      console.error(error);
      setStatus('导出图片失败：' + error.message);
    }
  });

  els.closeModal.addEventListener('click', () => {
    els.exportModal.style.display = 'none';
  });

  els.directDownloadBtn.addEventListener('click', () => {
    const link = document.createElement('a');
    link.download = 'fantasy_map_' + Date.now() + '.png';
    link.href = els.exportedImg.src;
    link.click();
  });

  els.exportDataBtn.addEventListener('click', () => {
    try {
      const data = FM.MapStorage.exportData(generator);
      const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.download = 'fantasy_map_' + Date.now() + '.json';
      link.href = url;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus('配置已导出（约 ' + (blob.size / 1048576).toFixed(1) + ' MB）');
    } catch (error) {
      console.error(error);
      setStatus('导出配置失败：' + error.message);
    }
  });

  els.importDataBtn.addEventListener('click', () => els.importFileInput.click());

  els.importFileInput.addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        const result = FM.MapStorage.importData(data, generator);
        editor.setGenerator(generator);
        renderer.updateOceanDepth();
        renderer.render();
        refreshLegend();
        setStatus(result.message);
      } catch (error) {
        console.error(error);
        setStatus('导入失败：' + error.message);
      } finally {
        event.target.value = '';
      }
    };
    reader.readAsText(file);
  });

  // ==================== 启动 ====================

  renderer.setProjection(els.projection.value || 'robinson');
  renderer.setViewMode(els.viewMode.value);   // 与 select 的选中项保持一致（默认卫星地图）
  els.overlay.width = WIDTH;
  els.overlay.height = HEIGHT;
  els.overlay.style.display = 'none';
  updateEditPanels();
  els.undoBtn.disabled = true;
  els.redoBtn.disabled = true;
  refreshLegend();

  // 调试 / 自动化测试钩子
  window.__FM_APP__ = {
    generator,
    renderer,
    editor,
    globe,
    generateMap,
    isBusy: () => busy,
  };

  generateMap();
})();
