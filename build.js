#!/usr/bin/env node
/**
 * build.js —— 零依赖单文件构建
 *
 * 产物：dist/index.html，双击即可打开（无需本地服务器、无需联网）。
 *
 * ==================== 为什么需要构建 ====================
 *
 * 原项目是「零构建」的：index.html 用一堆 <script src> 按顺序加载 IIFE。
 * 这在开发时很舒服，但有两个实际障碍：
 *
 *   1. **file:// 下没有并行**。地形计算占了生成时间的 60%，开着 Worker
 *      并行能把 3.6 s 压到 1.3 s；但 file:// 页面加载 worker 脚本会被
 *      同源策略拦掉，于是「双击打开」的版本永远是最慢的那个。
 *      构建时把 worker 源码（simplex-noise + terrain.js + 引导）拼成
 *      一个字符串，运行时用 Blob 造 URL，就有机会绕开文件路径限制。
 *
 *   2. **分享一个文件比分享一个目录容易**。50 多个文件（含 600 KB 的
 *      three.min.js）打进一个 HTML，发给别人就能直接看。
 *
 * ==================== 做了什么 ====================
 *
 *   · 把 css/style.css 内联成 <style>
 *   · 把每个 <script src> 换成同内容的内联 <script>（保持原有加载顺序，
 *     不合并成一个大 script —— 分块加载更接近开发时的作用域语义）
 *   · 在 terrain.js 之前注入 window.__FM_WORKER_SRC__，
 *     terrain.js 检测到它就用 Blob 创建 Worker
 *   · 不做压缩/混淆：产物要能直接读、能调试，体积主要是 three.min.js
 *
 * 用法：
 *   node build.js            输出到 dist/index.html
 *   node build.js --out=x.html
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function parseArgs(argv) {
  const out = { out: path.join(ROOT, 'dist', 'index.html') };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--out=')) out.out = path.resolve(ROOT, a.slice(6));
  }
  return out;
}

/**
 * Worker 源码。
 *
 * 顺序不能变：simplex-noise 必须先定义全局 SimplexNoise，
 * terrain.js 依赖它；引导代码最后挂 onmessage。
 * 这段字符串与 js/terrain-worker.js 做的事一一对应 ——
 * 改那边请同步改这边（build 会做一次行为一致性检查，见 verifyWorker）。
 */
function buildWorkerSource() {
  const simplex = read('js/vendor/simplex-noise.js');
  const terrain = read('js/terrain.js');
  return [
    '/* 内联 Worker：由 build.js 拼接 simplex-noise + terrain.js + 引导代码 */',
    'self.window = self;',
    simplex,
    'if (typeof SimplexNoise === "undefined" && typeof exports !== "undefined" && exports.SimplexNoise) {',
    '  self.SimplexNoise = exports.SimplexNoise;',
    '}',
    terrain,
    'self.onmessage = function (e) {',
    '  var msg = e.data;',
    '  try {',
    '    var simplex = new SimplexNoise(msg.seed);',
    '    var band = FM.Terrain.computeBand({',
    '      W: msg.W, H: msg.H, plates: msg.plates, simplex: simplex,',
    '      rowStart: msg.rowStart, rowEnd: msg.rowEnd',
    '    });',
    '    self.postMessage({ buffer: band.buffer }, [band.buffer]);',
    '  } catch (err) {',
    '    self.postMessage({ error: String((err && err.message) || err) });',
    '  }',
    '};',
  ].join('\n');
}

/** 内联到 HTML 里之前，必须把可能提前闭合 script 的序列打断 */
function guardScript(text) {
  return text.replace(/<\/script/gi, '<\\/script');
}

function main() {
  const args = parseArgs(process.argv);
  const t0 = Date.now();

  const html = read('index.html');
  const workerSource = buildWorkerSource();

  // 语法自检：拼出来的 worker 必须能解析，否则产物里的并行会静默失效
  try {
    new vm.Script(workerSource, { filename: 'inline-worker.js' });
  } catch (err) {
    console.error('✗ 内联 Worker 源码语法错误：' + err.message);
    process.exit(1);
  }

  const parts = [];
  const stats = [];
  let cssInlined = 0;

  // ---- 1. 内联样式表 ----
  let outHtml = html.replace(
    /^([ \t]*)<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>\s*$/gm,
    (m, indent, href) => {
      const css = read(href);
      cssInlined++;
      stats.push(['css  ' + href, Buffer.byteLength(css)]);
      return indent + '<style>\n' + css + '\n' + indent + '</style>';
    }
  );
  if (cssInlined === 0) {
    console.warn('⚠ 没有找到可内联的样式表（选择器可能变了）');
  }

  // ---- 2. 内联脚本（保持原有顺序）----
  outHtml = outHtml.replace(
    /^([ \t]*)<script src="([^"]+)"><\/script>\s*$/gm,
    (m, indent, src) => {
      const code = read(src);
      stats.push([src, Buffer.byteLength(code)]);
      let block = '';
      // terrain.js 之前注入 worker 源码
      if (src === 'js/terrain.js') {
        // 把 </ 转义成 <\/ ：JSON 合法，且不会提前闭合 script 标签
        const payload = JSON.stringify(workerSource).replace(/<\//g, '<\\/');
        block += indent + '<script>\n' +
          'window.__FM_WORKER_SRC__ = ' + payload + ';\n' +
          indent + '</script>\n';
      }
      block += indent + '<script>\n' + guardScript(code) + '\n' + indent + '</script>';
      return block;
    }
  );

  // ---- 3. 残留外链检查 ----
  const leftovers = [];
  const re = /(?:src|href)="((?!data:|#|https?:)[^"]+)"/g;
  let m;
  while ((m = re.exec(outHtml)) !== null) leftovers.push(m[1]);
  if (leftovers.length) {
    console.error('✗ 产物里仍有外部引用：' + leftovers.join(', '));
    process.exit(1);
  }

  // ---- 4. 写出 ----
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, outHtml, 'utf8');

  // ---- 5. 报告 ----
  const size = Buffer.byteLength(outHtml);
  const sorted = stats.slice().sort((a, b) => b[1] - a[1]);
  console.log('='.repeat(64));
  console.log('单文件构建完成 → ' + path.relative(ROOT, args.out));
  console.log('='.repeat(64));
  console.log('  产物大小   ' + (size / 1024).toFixed(0) + ' KB');
  console.log('  内联脚本   ' + stats.length + ' 个');
  console.log('  内联样式   ' + cssInlined + ' 个');
  console.log('  内联 Worker ' + (Buffer.byteLength(workerSource) / 1024).toFixed(0) + ' KB');
  console.log('  耗时       ' + (Date.now() - t0) + ' ms');
  console.log('\n  体积构成（前 6）:');
  for (const [name, bytes] of sorted.slice(0, 6)) {
    console.log('    ' + name.padEnd(32) + (bytes / 1024).toFixed(0).padStart(6) + ' KB');
  }
  console.log('\n  用浏览器直接打开该文件即可运行（首次生成约 8~13 秒）。');
}

main();
