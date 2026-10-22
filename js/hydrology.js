/**
 * hydrology.js —— 新一代水文系统
 *
 * 旧实现的做法是「从随机源点沿严格下坡走，超过 80 格才算河」，这在程序化地形上
 * 几乎必然走两步就掉进局部洼地，实测 0 条河。本模块改用真实水文学的四步流程：
 *
 *   1. 填洼（Priority-Flood + eps）：保证每块陆地都有严格下降的排水路径；
 *   2. D8 流向：每个格子指向 8 邻域中最低的邻居；
 *   3. 汇流累积：按高度从高到低把水量推给下游，得到每格的汇水面积；
 *   4. 提取：汇水面积超过阈值的是河道，填平区域中成片的是湖泊。
 *
 * 全部计算使用 TypedArray，不产生逐格对象，128 万格约 0.6~1.5 秒。
 * 输出给渲染层的只有「河段折线 + 每点流量」和「湖泊掩码」。
 */
(function (root) {
  'use strict';

  /** 抬升用的极小量，保证填平后的地形严格单调 */
  const EPS = 1e-7;
  /** 判断「被填平」的高度差阈值 */
  const FILL_EPS = 5e-4;
  /** D8 邻域（4 正 4 斜） */
  const DX = [1, 1, 0, -1, -1, -1, 0, 1];
  const DY = [0, 1, 1, 1, 0, -1, -1, -1];

  /** 二叉最小堆（存「优先级 + 索引」两个平行数组，避免每格造对象） */
  class MinHeap {
    #priority;
    #value;
    size = 0;

    constructor(capacity) {
      this.#priority = new Float64Array(capacity);
      this.#value = new Int32Array(capacity);
    }

    push(priority, value) {
      const p = this.#priority, v = this.#value;
      let i = this.size++;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (p[parent] <= priority) break;
        p[i] = p[parent];
        v[i] = v[parent];
        i = parent;
      }
      p[i] = priority;
      v[i] = value;
    }

    pop() {
      const p = this.#priority, v = this.#value;
      const top = v[0];
      const lastPrio = p[--this.size];
      const lastVal = v[this.size];
      if (this.size > 0) {
        let i = 0;
        const n = this.size;
        for (;;) {
          let child = 2 * i + 1;
          if (child >= n) break;
          if (child + 1 < n && p[child + 1] < p[child]) child++;
          if (p[child] >= lastPrio) break;
          p[i] = p[child];
          v[i] = v[child];
          i = child;
        }
        p[i] = lastPrio;
        v[i] = lastVal;
      }
      return top;
    }
  }

  class Hydrology {
    /**
     * @param {{width:number, height:number, elevation:Float32Array, seaLevel:number,
     *          riverThreshold?:number, minLakeArea?:number}} options
     */
    constructor(options) {
      const { width, height, elevation, seaLevel } = options;
      this.W = width;
      this.H = height;
      this.n = width * height;
      this.elevation = elevation;
      this.seaLevel = seaLevel;
      this.riverThreshold = options.riverThreshold
        || Math.max(260, Math.round(this.n * 0.00095));
      this.minLakeArea = options.minLakeArea || 140;

      this.filled = new Float64Array(this.n);
      this.down = new Int32Array(this.n).fill(-1);
      this.flow = new Float32Array(this.n);
      this.isLake = new Uint8Array(this.n);
      this.isRiver = new Uint8Array(this.n);
      this.lakeLevel = new Float32Array(this.n);
      this.rivers = [];
      this.lakes = [];
      this.metrics = {};
      this.riverStats = {};
    }

    isLand(i) {
      return this.elevation[i] > this.seaLevel;
    }

    /** 执行完整水文模拟 */
    solve() {
      const t0 = Hydrology.now();
      this.#fillDepressions();
      const t1 = Hydrology.now();
      this.#computeFlowDirections();
      const t2 = Hydrology.now();
      this.#accumulateFlow();
      const t3 = Hydrology.now();
      this.#extractLakes();
      const t4 = Hydrology.now();
      this.#extractRivers();
      const t5 = Hydrology.now();

      this.metrics = {
        fillMs: t1 - t0,
        flowMs: t2 - t1,
        accumulateMs: t3 - t2,
        lakeMs: t4 - t3,
        riverMs: t5 - t4,
        totalMs: t5 - t0,
        riverThreshold: this.riverThreshold,
        ...this.riverStats,
      };
      return this;
    }

    /** Priority-Flood 填洼：从海岸线和南北边界向内推进，保证每个陆地格都有出口 */
    #fillDepressions() {
      const { W, H, n, elevation: elev, seaLevel: sea } = this;
      const filled = this.filled;
      const visited = new Uint8Array(n);
      const heap = new MinHeap(n);

      // 种子：海岸线附近的海洋格 + 南北边界行
      for (let y = 0; y < H; y++) {
        const row = y * W;
        for (let x = 0; x < W; x++) {
          const i = row + x;
          const e = elev[i];
          if (e <= sea) {
            let coastal = false;
            for (let k = 0; k < 8; k++) {
              const ny = y + DY[k];
              if (ny < 0 || ny >= H) { coastal = true; break; }
              if (elev[ny * W + ((x + DX[k] + W) % W)] > sea) { coastal = true; break; }
            }
            if (coastal) {
              visited[i] = 1;
              filled[i] = e;
              heap.push(e, i);
            }
          } else if (y === 0 || y === H - 1) {
            visited[i] = 1;
            filled[i] = Math.max(e, sea + EPS);
            heap.push(filled[i], i);
          }
        }
      }

      while (heap.size > 0) {
        const i = heap.pop();
        const y = (i / W) | 0;
        const x = i - y * W;
        const h = filled[i];
        for (let k = 0; k < 8; k++) {
          const ny = y + DY[k];
          if (ny < 0 || ny >= H) continue;
          const nx = (x + DX[k] + W) % W;
          const ni = ny * W + nx;
          if (visited[ni]) continue;
          visited[ni] = 1;
          const e = elev[ni];
          filled[ni] = e > h ? e : h + EPS;
          heap.push(filled[ni], ni);
        }
      }
    }

    /** D8 流向：指向 8 邻域中最低的一格；地图边缘的陆地格直接排入「边缘海」 */
    #computeFlowDirections() {
      const { W, H, elevation: elev, seaLevel: sea, filled, down } = this;
      for (let y = 0; y < H; y++) {
        const row = y * W;
        for (let x = 0; x < W; x++) {
          const i = row + x;
          if (elev[i] <= sea) continue;
          if (y === 0 || y === H - 1) { down[i] = -1; continue; }
          const h = filled[i];
          let best = -1;
          let bestH = h;
          for (let k = 0; k < 8; k++) {
            const ny = y + DY[k];
            if (ny < 0 || ny >= H) continue;
            const ni = ny * W + ((x + DX[k] + W) % W);
            const nh = filled[ni];
            if (nh < bestH) {
              bestH = nh;
              best = ni;
            }
          }
          down[i] = best;
        }
      }
    }

    /** 汇流累积：按填平后高度降序处理，把汇水面积推给下游 */
    #accumulateFlow() {
      const { n, elevation: elev, seaLevel: sea, filled, down, flow } = this;
      const land = [];
      for (let i = 0; i < n; i++) {
        if (elev[i] <= sea) continue;
        land.push(i);
        flow[i] = 1;
      }
      const order = Int32Array.from(land);
      order.sort((a, b) => filled[b] - filled[a]);
      for (let k = 0; k < order.length; k++) {
        const i = order[k];
        const d = down[i];
        if (d >= 0 && elev[d] > sea) flow[d] += flow[i];
      }
    }

    /** 湖泊：填平量成片的区域就是湖泊（面积太小当湿地忽略） */
    #extractLakes() {
      const { W, H, n, elevation: elev, seaLevel: sea, filled, flow, isLake, lakeLevel } = this;
      const visited = new Uint8Array(n);
      const stack = new Int32Array(n);
      const threshold = this.riverThreshold;

      for (let start = 0; start < n; start++) {
        if (visited[start]) continue;
        if (elev[start] <= sea) continue;
        if (filled[start] - elev[start] <= FILL_EPS) continue;

        let top = 0;
        stack[top++] = start;
        visited[start] = 1;
        const members = [];
        let sumLevel = 0;
        let maxFlow = 0;
        let minX = W, maxX = -1, minY = H, maxY = -1;

        while (top > 0) {
          const i = stack[--top];
          members.push(i);
          sumLevel += filled[i];
          if (flow[i] > maxFlow) maxFlow = flow[i];
          const y = (i / W) | 0;
          const x = i - y * W;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;

          for (let k = 0; k < 8; k++) {
            const ny = y + DY[k];
            if (ny < 0 || ny >= H) continue;
            const ni = ny * W + ((x + DX[k] + W) % W);
            if (visited[ni] || elev[ni] <= sea) continue;
            if (filled[ni] - elev[ni] <= FILL_EPS) continue;
            visited[ni] = 1;
            stack[top++] = ni;
          }
        }

        if (members.length < this.minLakeArea) continue;
        const level = sumLevel / members.length;
        for (const i of members) {
          isLake[i] = 1;
          lakeLevel[i] = level;
        }
        this.lakes.push({
          area: members.length,
          level,
          x: (minX + maxX) / 2,
          y: (minY + maxY) / 2,
          minX, maxX, minY, maxY,
          maxFlow,
        });
      }
    }

    /** 河网：汇水面积达标的格子组成河道；从每条支流的源头沿下游走成折线 */
    #extractRivers() {
      const { W, H, n, elevation: elev, seaLevel: sea, down, flow, isLake, isRiver } = this;
      const threshold = this.riverThreshold;

      // 上游链表（每格最多 8 个上游，用链表串起来，避免对象/数组分配）
      const head = new Int32Array(n).fill(-1);
      const next = new Int32Array(n).fill(-1);

      for (let i = 0; i < n; i++) {
        if (elev[i] <= sea) continue;
        if (flow[i] >= threshold && !isLake[i]) isRiver[i] = 1;
        const d = down[i];
        if (d >= 0 && elev[d] > sea) {
          next[i] = head[d];
          head[d] = i;
        }
      }

      const hasRiverUpstream = (i) => {
        let u = head[i];
        while (u !== -1) {
          if (isRiver[u]) return true;
          u = next[u];
        }
        return false;
      };

      let maxFlow = 0;
      let totalCells = 0;

      for (let start = 0; start < n; start++) {
        if (!isRiver[start]) continue;
        if (hasRiverUpstream(start)) continue;

        const points = [];
        const flows = [];
        let i = start;
        let guard = 0;
        let hitLake = false;

        while (i >= 0 && guard++ < n) {
          if (isLake[i]) { hitLake = true; break; }
          if (elev[i] <= sea) break;
          const y = (i / W) | 0;
          const x = i - y * W;
          points.push(x + 0.5, y + 0.5);
          flows.push(flow[i]);
          if (flow[i] > maxFlow) maxFlow = flow[i];
          if (down[i] < 0) break;
          i = down[i];
        }

        const count = points.length / 2;
        if (count < 3) continue;
        totalCells += count;
        this.rivers.push({
          points,
          flows,
          count,
          maxFlow: flows[flows.length - 1] || 1,
          hitLake,
        });
      }

      this.riverStats = {
        maxFlow,
        riverCells: totalCells,
        riverCount: this.rivers.length,
        lakeCount: this.lakes.length,
      };
    }
  }

  Hydrology.now = (typeof performance !== 'undefined' && performance.now)
    ? () => performance.now()
    : () => Date.now();

  const target = root.FM = root.FM || {};
  target.Hydrology = Hydrology;
  target.MinHeap = MinHeap;
})(typeof window !== 'undefined' ? window : globalThis);
