/**
 * editor.js —— 地图编辑器（选区塑形）
 *
 * ==================== 这一版只做一件事 ====================
 *
 * 圈一块地 → 点一个按钮 → 那块地变成大陆，或者变成海洋。
 *
 * 旧版是笔刷：沿笔迹盖一串衰减圆，再靠 ridged 噪声补救。问题不在参数，
 * 在模型 —— 「沿笔画扫过去」和「一块地怎么长成大陆」是两回事。笔刷只能在
 * 已有大陆上刻出局部起伏，**造不出一块新大陆**：海岸线还是原来那条。
 *
 * 新版把整个动作交给两个纯函数（terrain-ops.js）：
 *
 *   1. **buildSelectionMask**：多边形 → 距离场 → 用 fbm 把**海岸线**
 *      重新打碎。内距 d 减去噪声 w，过零线即新海岸线。三层噪声分别负责
 *      半岛 / 岬角 / 岸边碎屑，频率和幅度都按选区尺度缩放。
 *      所以长出来的是有海湾、半岛、离岸岛的海岸，而不是把多边形描一遍。
 *
 *   2. **shapeRegion**：软掩膜 → 高度。高度不是 m×幅度（那会得到一块
 *      橡皮泥台地），而是叠了三层地貌分异：
 *        · 大陆面（m^0.6）：靠海平缓、内陆抬满
 *        · 山带（domain-warped ridged × 造山带分布场）：脊线只在少数几条
 *          带上出现，其余是平原
 *        · 大/中频 fbm：高原与盆地的基准高度差
 *      再叠 11 格级细节，最后跑一遍热力 + 水力侵蚀切出沟谷。
 *
 * 反复点同一个选区不会把它越堆越高：shapeRegion 是**目标高度驱动**的
 * （`next = before + (target - before) * m`），第二次点得到同一个结果。
 *
 * ==================== 交互 ====================
 *
 * · 拖动只画线，不动数据。松手才成形。
 * · 成形是同步的（一次约 0.1~0.5 s，取决于选区大小），立刻重绘地形层。
 * · 海深 + 水系重建要 1 s 左右，推迟 160 ms 再跑，避免"松手就卡住"。
 * · 历史只记**真正变化**的格子（Float32 比较，见 #pushHistory）。
 */
(function (root) {
  'use strict';

  const FM = root.FM = root.FM || {};
  const Ops = FM.TerrainOps;

  /** 选区塑形的两种模式 */
  const MODE_LAND = 'land';
  const MODE_SEA = 'sea';

  /** 隆起幅度默认值：目标是「陆地可用高度」的比例，0.82 → 最高处接近雪线 */
  const STRENGTH_DEFAULT = 0.82;
  /** 地貌尺度默认值：乘到选区内切半径上，>1 得到更少更大的地貌 */
  const DETAIL_DEFAULT = 1.0;

  const EROSION = {
    // 侵蚀参数集中定义在 terrain-ops.js 的 EROSION_DEFAULTS ——
    // 离屏预览脚本（tools/preview-region.js）用的是同一份，
    // 避免「看图调参却调了另一套」。
    ...Ops.EROSION_DEFAULTS,
  };

  class MapEditor {
    constructor(options) {
      this.canvas = options.canvas;
      this.overlay = options.overlay;
      this.octx = this.overlay.getContext('2d');
      this.renderer = options.renderer;
      this.callbacks = options.callbacks || {};
      this.generator = null;

      this.enabled = false;
      this.strength = STRENGTH_DEFAULT;
      this.detailScale = DETAIL_DEFAULT;

      this.hoverPos = null;
      this.lassoPoints = [];
      this.draggingLasso = false;
      this._overlayRaf = null;

      this.history = [];
      this.redoStack = [];
      this.maxHistory = 15;

      /** 掩膜 / 内陆度缓冲（复用，避免每次分配 5 MB） */
      this._mask = null;
      this._shelf = null;
      this._busy = false;
      this._refreshTimer = null;

      this.#bindEvents();
    }

    setGenerator(generator) {
      this.generator = generator;
      this._mask = null;
      this._shelf = null;
      this.clearHistory();
      this.clearLasso();
    }

    setEnabled(enabled) {
      this.enabled = enabled;
      if (!enabled) {
        this.draggingLasso = false;
        this.lassoPoints = [];
      }
      this.drawOverlay();
      this.callbacks.onLassoChange?.(this.hasLasso());
    }

    /** 兼容旧接口：现在只有「选区」一个工具，传什么都一样 */
    setTool() {
      this.lassoPoints = [];
      this.drawOverlay();
      this.callbacks.onLassoChange?.(false);
    }

    /** 隆起幅度（占陆地可用高度的比例） */
    setStrength(value) {
      this.strength = Math.max(0.2, Math.min(1.1, value));
    }

    /** 地貌尺度：乘到选区尺度上，小于 1 → 更碎，大于 1 → 更整块 */
    setDetailScale(value) {
      this.detailScale = Math.max(0.5, Math.min(2.0, value));
    }

    // ==================== 事件绑定 ====================

    #bindEvents() {
      const canvas = this.canvas;
      canvas.addEventListener('pointerdown', (e) => this.#onPointerDown(e));
      canvas.addEventListener('pointermove', (e) => this.#onPointerMove(e));
      window.addEventListener('pointerup', (e) => this.#onPointerUp(e));
      canvas.addEventListener('pointerleave', () => {
        if (!this.draggingLasso) {
          this.hoverPos = null;
          this.drawOverlay();
        }
      });
      canvas.addEventListener('contextmenu', (e) => {
        if (this.enabled) e.preventDefault();
      });
    }

    /**
     * 指针位置 → **数据坐标**（等距圆柱网格像素）。
     *
     * 塑形作用在数据网格上，所以入口就要反算回来；否则在罗宾逊/摩尔威德
     * 视图下，圈的圈与实际成形的区域会错开，极区尤为明显。
     */
    #canvasPos(e) {
      const rect = this.canvas.getBoundingClientRect();
      const scaleX = this.canvas.width / rect.width;
      const scaleY = this.canvas.height / rect.height;
      let x = (e.clientX - rect.left) * scaleX;
      let y = (e.clientY - rect.top) * scaleY;
      x = ((x % this.canvas.width) + this.canvas.width) % this.canvas.width;
      y = Math.max(0, Math.min(this.canvas.height - 0.001, y));

      const r = this.renderer;
      const data = r && r.unprojectPixel ? r.unprojectPixel(x, y) : { x, y };
      if (!data) return null;
      return { x: data.x, y: Math.max(0, Math.min(this.canvas.height - 0.001, data.y)) };
    }

    /** 数据坐标 → 画布坐标（绘制叠加层用） */
    #toCanvas(p) {
      const r = this.renderer;
      if (r && r.projectPixel) return r.projectPixel(p.x, p.y);
      return p;
    }

    #onPointerDown(e) {
      const g = this.generator;
      if (!g || !g.cells || !this.enabled || this._busy) return;
      const pos = this.#canvasPos(e);
      if (!pos) return;

      e.preventDefault();
      this.canvas.setPointerCapture?.(e.pointerId);
      this.draggingLasso = true;
      this.lassoPoints = [pos];
      this.drawOverlay();
    }

    #onPointerMove(e) {
      if (!this.generator) return;
      const pos = this.#canvasPos(e);
      this.hoverPos = pos;
      if (!pos) {
        this.drawOverlay();
        return;
      }

      if (this.draggingLasso) {
        const last = this.lassoPoints[this.lassoPoints.length - 1];
        // 1.5 格的采样间隔：再密对多边形没意义，只是徒增顶点
        if (!last || Math.hypot(pos.x - last.x, pos.y - last.y) > 1.5) {
          this.lassoPoints.push(pos);
          this.#scheduleOverlay();
        }
        return;
      }
      this.#scheduleOverlay();
    }

    #onPointerUp(e) {
      if (!this.draggingLasso) return;
      this.draggingLasso = false;
      this.canvas.releasePointerCapture?.(e.pointerId);
      // 首尾闭合：手画的圈几乎不可能精确回到起点，直接补上闭合段
      this.callbacks.onLassoChange?.(this.hasLasso());
      this.drawOverlay();
      if (this.hasLasso()) {
        this.callbacks.onStatus?.('已圈定选区 · 选择「隆起成大陆」或「沉陷成海洋」');
      }
    }

    #scheduleOverlay() {
      if (this._overlayRaf) return;
      this._overlayRaf = requestAnimationFrame(() => {
        this._overlayRaf = null;
        this.drawOverlay();
      });
    }

    #ensureBuffers() {
      const W = this.canvas.width;
      const H = this.canvas.height;
      const n = W * H;
      if (!this._mask || this._mask.length !== n) {
        this._mask = new Float32Array(n);
        this._shelf = new Float32Array(n);
      }
    }

    // ==================== 选区 ====================

    hasLasso() {
      return this.lassoPoints.length >= 3;
    }

    clearLasso() {
      this.lassoPoints = [];
      this.drawOverlay();
      this.callbacks.onLassoChange?.(false);
    }

    /** 选区的包围盒与尺度（UI 用来显示"选区多大"，也用于判断太小） */
    selectionInfo() {
      const pts = this.lassoPoints;
      if (pts.length < 3) return null;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const p of pts) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
      return {
        minX, minY, maxX, maxY,
        w: maxX - minX,
        h: maxY - minY,
        scale: Math.min(maxX - minX, maxY - minY) * 0.5,
      };
    }

    /**
     * 选区塑形。
     *
     * @param {'land'|'sea'} mode  'land' 隆起成大陆 / 'sea' 沉陷成海洋
     * @returns {boolean} 是否真的改了东西
     */
    applyRegionAction(mode) {
      const g = this.generator;
      if (!g || !this.hasLasso() || this._busy) return false;
      const target = mode === MODE_SEA ? MODE_SEA : MODE_LAND;

      const W = this.canvas.width;
      const H = this.canvas.height;
      const cells = g.cells;
      const t0 = performance.now();

      this.#ensureBuffers();
      const seed = (Math.random() * 0x7fffffff) | 0;

      // ---- 1. 多边形 → 软掩膜（海岸线在这一步被分形打碎） ----
      const sel = Ops.buildSelectionMask(this._mask, W, H, this.lassoPoints, {
        seed,
        shelfBuffer: this._shelf,
      });
      if (!sel) {
        this.callbacks.onStatus?.('选区太小，画大一点');
        return false;
      }
      if (sel.scale < 9) {
        this.callbacks.onStatus?.(
          '选区太小（内切半径 ' + sel.scale.toFixed(1) + ' 格）· 至少 20 格以上才有海岸线细节'
        );
        return false;
      }

      // ---- 2. 快照 ----
      // 改动只可能落在 mask > 0.002 的格子上，而那只可能发生在 sel.box 之内
      // （buildSelectionMask 的外扩已经把海岸线的最大外推量算进去了）。
      // 侵蚀也传 mask 限制写回，所以不会把物质搬到选区外面去。
      const region = this.#clampRegion({
        x0: sel.box.x0 - 1, y0: sel.box.y0 - 1,
        x1: sel.box.x1 + 1, y1: sel.box.y1 + 1,
      });
      const snap = this.#snapshot(region);

      // ---- 3. 塑形 ----
      const shaped = Ops.shapeRegion(cells, W, H, sel.mask, sel.box, {
        seaLevel: g.seaLevel,
        mode: target,
        strength: this.strength,
        seed,
        scale: sel.scale * this.detailScale,
        shelf: sel.shelf,
      });

      if (!shaped.changed) {
        this.callbacks.onStatus?.('这一块已经是目标形态了');
        return false;
      }

      // ---- 4. 侵蚀：不跑这一步，改动区与原地形之间会是一道硬台阶 ----
      // field + maskGain 把写回限制在选区内：不传的话热力侵蚀会把周围的
      // 原始地形也一起抹一遍 —— 用户只想改圈里那块。
      this._busy = true;
      try {
        Ops.erode(cells, W, H, region, {
          ...EROSION,
          seaLevel: g.seaLevel,
          field: sel.mask,
          maskGain: 4.0,
        });
      } finally {
        this._busy = false;
      }

      // 3b. 先给「水陆身份翻了面」的格子一个临时群系。
      // 真群系要等延后刷新里的气候重算（1~2 s）才会出来，而这一帧已经
      // 在渲染了 —— 不补这一步，刚抬起来的陆地会挂着「深海」的群系，
      // 卫星图上就是一块**蓝色的大陆**，闪一秒才变绿。
      this.#patchFlippedBiomes(region);

      const label = target === MODE_SEA ? '沉陷成海洋' : '隆起成大陆';
      const changed = this.#pushHistory(snap, label);
      this.lassoPoints = [];
      this.callbacks.onLassoChange?.(false);

      // 第一段刷新：地形层立刻更新，给出反馈
      this.renderer.terrainDirty = true;
      this.renderer.albedoValid = false;
      this.renderer.render();
      this.drawOverlay();
      this.callbacks.onEdited?.();
      this.callbacks.onStatus?.(
        label + '完成（' + changed + ' 格 · ' + Math.round(performance.now() - t0) +
        ' ms）· 更新水系中…'
      );

      // 第二段刷新：海深 + 水系
      this.#scheduleGlobalRefresh();
      return true;
    }

    /** 旧接口兼容：把上一版的六个动作映射到现在的两个 */
    applyLassoAction(action) {
      if (action === MODE_LAND || action === MODE_SEA) return this.applyRegionAction(action);
      // 抬升 / 造山 → 大陆；下沉 / 冲蚀 → 海洋
      const asSea = action === 'lower' || action === 'sea' || action === 'erode';
      return this.applyRegionAction(asSea ? MODE_SEA : MODE_LAND);
    }

    /**
     * 给「水陆身份翻了面」的格子一个临时群系。
     *
     * 只改自相矛盾的格子（陆地挂着海群系、海里挂着陆群系），不做任何
     * 气候推断 —— 真正的群系由延后刷新里的重算气候给出。这一手纯粹是
     * 为了让**成形这一帧**不出现「蓝色陆地 / 绿色海面」的荒唐画面。
     */
    #patchFlippedBiomes(region) {
      const W = this.canvas.width;
      const sea = this.generator.seaLevel;
      const cells = this.generator.cells;
      const isOcean = (b) => b === '深海' || b === '海洋' || b === '浅海';
      for (let y = region.y0; y <= region.y1; y++) {
        const row = y * W;
        for (let x = region.x0; x <= region.x1; x++) {
          const c = cells[row + x];
          const land = c.e >= sea;
          if (land && c.biome && isOcean(c.biome)) c.biome = '草原';
          else if (!land && c.biome && !isOcean(c.biome) && c.biome !== '湖泊') c.biome = '浅海';
        }
      }
    }

    #clampRegion(r) {
      const W = this.canvas.width;
      const H = this.canvas.height;
      return {
        x0: Math.max(0, Math.floor(r.x0)),
        y0: Math.max(0, Math.floor(r.y0)),
        x1: Math.min(W - 1, Math.ceil(r.x1)),
        y1: Math.min(H - 1, Math.ceil(r.y1)),
      };
    }

    /** 记录区域内的 e / temp 快照，用于事后算 diff */
    #snapshot(region) {
      const W = this.canvas.width;
      const w = region.x1 - region.x0 + 1;
      const h = region.y1 - region.y0 + 1;
      const e = new Float32Array(w * h);
      const t = new Float32Array(w * h);
      const cells = this.generator.cells;
      for (let y = 0; y < h; y++) {
        const rowBase = (region.y0 + y) * W + region.x0;
        const out = y * w;
        for (let x = 0; x < w; x++) {
          const c = cells[rowBase + x];
          e[out + x] = c.e;
          t[out + x] = c.temp;
        }
      }
      return { x0: region.x0, y0: region.y0, x1: region.x1, y1: region.y1, w, h, e, t };
    }

    /**
     * 把「快照 → 当前」的差异写进历史。
     *
     * 只记录真正变了的格子：一块 400×260 的选区碰 10 万格，其中
     * 变化通常只有一半。用 TypedArray 存下标 + 前后值，比存 cell 引用
     * 省一个数量级内存。
     *
     * 【为什么必须按 float32 比较】snap.e 是 Float32Array，所以 b 已经是
     * float32；而 c.e 是 float64。海岸过渡带上有大量格子只变了 1e-12 量级
     * —— 按 float64 比较算"变了"，存进 Float32Array 之后前后值却完全相同，
     * 这种记录既占内存（实测曾占历史条目 44%）又撤销不出任何差别。
     */
    #pushHistory(snap, label) {
      const W = this.canvas.width;
      const cells = this.generator.cells;
      const idx = [];
      const beforeE = [];
      const afterE = [];
      const beforeT = [];
      const afterT = [];

      for (let y = 0; y < snap.h; y++) {
        const rowBase = (snap.y0 + y) * W + snap.x0;
        const off = y * snap.w;
        for (let x = 0; x < snap.w; x++) {
          const c = cells[rowBase + x];
          const b = snap.e[off + x];
          const nowE = Math.fround(c.e);
          if (nowE === b) continue;
          idx.push(rowBase + x);
          beforeE.push(b);
          afterE.push(nowE);
          beforeT.push(snap.t[off + x]);
          afterT.push(c.temp);
        }
      }
      if (idx.length === 0) return 0;

      this.history.push({
        label,
        idx: Int32Array.from(idx),
        beforeE: Float32Array.from(beforeE),
        afterE: Float32Array.from(afterE),
        beforeT: Float32Array.from(beforeT),
        afterT: Float32Array.from(afterT),
      });
      if (this.history.length > this.maxHistory) this.history.shift();
      this.redoStack.length = 0;
      this.callbacks.onHistoryChange?.(this.history.length, this.redoStack.length);
      return idx.length;
    }

    // ==================== 历史 ====================

    undo() {
      const item = this.history.pop();
      if (!item) return false;
      this.#applyHistory(item, 'before');
      this.redoStack.push(item);
      this.callbacks.onHistoryChange?.(this.history.length, this.redoStack.length);
      this.#afterHistory('已撤销：' + item.label);
      return true;
    }

    redo() {
      const item = this.redoStack.pop();
      if (!item) return false;
      this.#applyHistory(item, 'after');
      this.history.push(item);
      this.callbacks.onHistoryChange?.(this.history.length, this.redoStack.length);
      this.#afterHistory('已重做：' + item.label);
      return true;
    }

    #applyHistory(item, which) {
      const cells = this.generator.cells;
      const e = which === 'before' ? item.beforeE : item.afterE;
      const t = which === 'before' ? item.beforeT : item.afterT;
      for (let k = 0; k < item.idx.length; k++) {
        const c = cells[item.idx[k]];
        c.e = e[k];
        c.temp = t[k];
      }
    }

    #afterHistory(status) {
      this.renderer.terrainDirty = true;
      this.renderer.albedoValid = false;
      this.renderer.render();
      this.drawOverlay();
      this.callbacks.onEdited?.();
      this.callbacks.onStatus?.(status);
      this.#scheduleGlobalRefresh();
    }

    clearHistory() {
      this.history.length = 0;
      this.redoStack.length = 0;
      this.callbacks.onHistoryChange?.(0, 0);
    }

    // ==================== 全局收尾（海深 + 水系） ====================

    /**
     * 延后执行「重算气候 + 重建水系 + 重算海深 + 完整重绘」。
     *
     * 这几步合计约 2~3 s（气候 2 s、水文 0.9 s、海深 0.3 s、重绘 0.3 s）。
     * 放在成形瞬间同步执行，界面会僵住几秒，用户以为卡死；
     * 分成「先出地形、后补气候水系」两段，感知会好得多。
     *
     * 【为什么现在连气候也要重算】群系标签是气候阶段写的，而塑形只改高度。
     * 不重算的话，被抬起来的格子还挂着「深海」——卫星图上一块蓝色的陆地，
     * 正是用户说的"板块非常混乱"。
     */
    #scheduleGlobalRefresh() {
      if (this._refreshTimer) clearTimeout(this._refreshTimer);
      this._refreshTimer = setTimeout(() => {
        this._refreshTimer = null;
        const g = this.generator;
        if (!g) return;
        this.callbacks.onStatus?.('重算气候…');
        // 让状态栏先刷新到屏幕，再开始计算
        setTimeout(async () => {
          const t0 = performance.now();
          try {
            await g.recomputeClimate((p, label) => {
              this.callbacks.onStatus?.('重算气候… ' + label);
            });
          } catch (err) {
            console.error('[editor] 重算气候失败', err);
          }
          this.callbacks.onStatus?.('重建水系…');
          let metrics = null;
          try {
            metrics = g.rebuildHydrology();
          } catch (err) {
            console.error('[editor] 重建水系失败', err);
          }
          this.renderer.updateOceanDepth();
          this.renderer.terrainDirty = true;
          this.renderer.albedoValid = false;
          this.renderer.render();
          const ms = Math.round(performance.now() - t0);
          const rivers = metrics && metrics.riverCount != null ? metrics.riverCount : g.rivers.length;
          this.callbacks.onStatus?.(
            '气候与水系已更新（' + ms + ' ms · 河流 ' + rivers + ' 段）'
          );
          this.callbacks.onEdited?.();
          this.drawOverlay();
        }, 16);
      }, 160);
    }

    // ==================== Overlay ====================

    drawOverlay() {
      const ctx = this.octx;
      const W = this.overlay.width;
      const H = this.overlay.height;
      ctx.clearRect(0, 0, W, H);
      if (!this.enabled) return;

      if (this.lassoPoints.length >= 2) this.#drawLasso();
      if (this.draggingLasso && this.lassoPoints.length === 0 && this.hoverPos) {
        this.#drawCrosshair();
      }
    }

    #drawLasso() {
      const ctx = this.octx;
      const pts = this.#lassoCanvasPoints();
      if (pts.length < 2) return;
      const r = this.renderer;
      const clipped = r && r.clipToProjection ? r.clipToProjection(ctx) : false;

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();

      ctx.fillStyle = 'rgba(255, 90, 90, 0.10)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
      ctx.lineWidth = 3.2;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255, 74, 74, 0.98)';
      ctx.lineWidth = 1.6;
      ctx.setLineDash([7, 5]);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      for (let i = 0; i < pts.length; i += 12) {
        ctx.beginPath();
        ctx.arc(pts[i].x, pts[i].y, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      if (clipped) ctx.restore();
    }

    /** 起点准星：拖动过程中只有一个点时给一个可见的锚 */
    #drawCrosshair() {
      const ctx = this.octx;
      const p = this.#toCanvas(this.hoverPos);
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(p.x - 7, p.y);
      ctx.lineTo(p.x + 7, p.y);
      ctx.moveTo(p.x, p.y - 7);
      ctx.lineTo(p.x, p.y + 7);
      ctx.stroke();
      ctx.restore();
    }

    /** 套索顶点 → 画布坐标（跨经线先解缠，避免投影后横穿全图） */
    #lassoCanvasPoints() {
      const W = this.canvas.width;
      const pts = this.lassoPoints;
      const out = [];
      let shift = 0;
      for (let i = 0; i < pts.length; i++) {
        if (i > 0) {
          const d = pts[i].x - pts[i - 1].x;
          if (d > W / 2) shift -= W;
          else if (d < -W / 2) shift += W;
        }
        out.push(this.#toCanvas({ x: pts[i].x + shift, y: pts[i].y }));
      }
      return out;
    }
  }

  FM.MapEditor = MapEditor;
})(window);
