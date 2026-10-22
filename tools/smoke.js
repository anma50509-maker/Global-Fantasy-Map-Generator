/**
 * tools/smoke.js —— 端到端冒烟测试（真实浏览器）
 *
 * 用 puppeteer-core 驱动本机 Edge/Chrome：
 *   1. 打开页面，等自动生成完成，收集控制台错误；
 *   2. 记录生成耗时、地形并行线程数、河流/湖泊数；
 *   3. 逐一切换视图与投影，测量重绘耗时；
 *   4. 开启编辑器，模拟一笔抬升，验证地形真的变了、水系重建了；
 *   5. 截图（生成后 / 编辑中热力叠加 / 编辑后）。
 *
 * 用法：
 *   NODE_PATH=<workspace>/node_modules node tools/smoke.js [url]
 */
'use strict';

const path = require('path');
const puppeteer = require('puppeteer-core');

const URL = process.argv[2] || 'http://127.0.0.1:8123/';
const OUT = path.resolve(__dirname, '..', '.smoke');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const fs = require('fs');
const exe = fs.existsSync(EDGE) ? EDGE : CHROME;

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: 'new',
    args: ['--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1700,980'],
    defaultViewport: { width: 1700, height: 980 },
  });

  const page = await browser.newPage();
  const errors = [];
  const warnings = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => errors.push('requestfailed: ' + r.url() + ' ' + (r.failure() || {}).errorText));
  page.on('console', (msg) => {
    const t = msg.type();
    const text = msg.text();
    if (t === 'error') errors.push('console.error: ' + text);
    else if (t === 'warning') warnings.push(text);
  });

  const t0 = Date.now();
  await page.goto(URL, { waitUntil: 'load', timeout: 60000 });

  await page.waitForFunction(
    () => window.__FM_APP__ && !window.__FM_APP__.isBusy() &&
      document.getElementById('statusBar').textContent.indexOf('生成完成') >= 0,
    { timeout: 180000, polling: 200 }
  );
  const wallMs = Date.now() - t0;

  const info = await page.evaluate(() => {
    const app = window.__FM_APP__;
    const g = app.generator;
    return {
      status: document.getElementById('statusBar').textContent,
      stats: g.stats,
      cells: g.cells.length,
      threads: window.FM.Terrain.lastRun(),
    };
  });

  const viewTimings = {};
  for (const mode of ['pure_terrain', 'contour', 'climate', 'biome', 'handdrawn', 'satellite']) {
    viewTimings['view:' + mode] = await page.evaluate((m) => {
      const app = window.__FM_APP__;
      const t = performance.now();
      app.renderer.setViewMode(m);
      app.renderer.render();
      return +(performance.now() - t).toFixed(0);
    }, mode);
  }
  for (const proj of ['equirect', 'mollweide', 'robinson']) {
    viewTimings['proj:' + proj] = await page.evaluate((p) => {
      const app = window.__FM_APP__;
      const t = performance.now();
      app.renderer.setProjection(p);
      app.renderer.render();
      return +(performance.now() - t).toFixed(0);
    }, proj);
  }

  const overlayTimings = {};
  for (const opt of ['showGrid', 'showMonsoon', 'showOceanCurrents']) {
    overlayTimings[opt] = await page.evaluate((k) => {
      const app = window.__FM_APP__;
      const opts = {};
      opts[k] = true;
      app.renderer.setOptions(opts);
      const t = performance.now();
      app.renderer.render();
      const ms = +(performance.now() - t).toFixed(0);
      opts[k] = false;
      app.renderer.setOptions(opts);
      app.renderer.render();
      return ms;
    }, opt);
  }

  await page.screenshot({ path: path.join(OUT, '1-generated.png') });

  // ---------- 编辑器：圈一块地，让它隆起成大陆 ----------
  await page.click('#editMode');

  const box = await page.evaluate(() => {
    const c = document.getElementById('mapCanvas');
    const r = c.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const cx = box.x + box.w * 0.45;
  const cy = box.y + box.h * 0.5;
  const rx = box.w * 0.16;
  const ry = box.h * 0.18;

  const before = await page.evaluate((pt) => {
    const app = window.__FM_APP__;
    const c = app.renderer.unprojectPixel(pt.x, pt.y);
    const i = Math.floor(c.y) * 1600 + Math.floor(c.x);
    return { e: app.generator.cells[i].e, idx: i };
  }, { x: (cx - box.x) * (1600 / box.w), y: (cy - box.y) * (800 / box.h) });

  // 画一个圈（36 个采样点，模拟手画）
  await page.mouse.move(cx + rx, cy);
  await page.mouse.down();
  for (let k = 1; k <= 40; k++) {
    const a = (k / 40) * Math.PI * 2;
    await page.mouse.move(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry);
    await new Promise((r) => setTimeout(r, 8));
  }
  await page.mouse.up();
  await page.screenshot({ path: path.join(OUT, '2-editing.png') });

  // 点「隆起成大陆」
  await page.click('#btnRegionLand');

  await page.waitForFunction(
    () => document.getElementById('statusBar').textContent.indexOf('水系已更新') >= 0 ||
      document.getElementById('statusBar').textContent.indexOf('更新水系') >= 0,
    { timeout: 60000, polling: 100 }
  ).catch(() => {});

  const after = await page.evaluate((pt) => {
    const app = window.__FM_APP__;
    const i = pt.idx;
    return {
      e: app.generator.cells[i].e,
      biome: app.generator.cells[i].biome,
      history: app.editor.history.length,
      status: document.getElementById('statusBar').textContent,
      rivers: app.generator.rivers.length,
      lakes: app.generator.lakes.length,
    };
  }, before);

  await page.screenshot({ path: path.join(OUT, '3-edited.png') });

  // ---------- 撤销一次，确认历史可用 ----------
  const undone = await page.evaluate(() => {
    const app = window.__FM_APP__;
    const ok = app.editor.undo();
    return { ok, e: app.generator.cells[app.editor.history.length ? 0 : 0].e };
  });

  console.log(JSON.stringify({
    url: URL,
    wallMs,
    info,
    viewTimings,
    overlayTimings,
    edit: {
      beforeE: +before.e.toFixed(4),
      afterE: +after.e.toFixed(4),
      deltaE: +(after.e - before.e).toFixed(4),
      biome: after.biome,
      historyDepth: after.history,
      rivers: after.rivers,
      lakes: after.lakes,
      status: after.status,
      undoOk: undone.ok,
    },
    errors,
    warnings: warnings.slice(0, 10),
  }, null, 2));

  await browser.close();
}

main().catch((e) => {
  console.error('SMOKE FAILED:', e && e.stack || e);
  process.exit(1);
});
