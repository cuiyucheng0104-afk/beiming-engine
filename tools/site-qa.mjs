#!/usr/bin/env node
// 北冥作品站 · 集成验收（集成 QA 维护）
//
// 按 site/CONTRACT.md 第 6 节逐条跑 S1–S9 门禁，输出 <out>/report.json 与截图（JPG）：
//   S1      在 Node 里静态核对构建产物：构建标记、所有本地 src / href / srcset / poster / data-preview、
//           CSS url()、importmap、JS import 图（静态、动态、new URL(…, import.meta.url)）都能解析到文件
//   S2–S9   起本地服务，用 playwright-core + 本机 Chromium（Mac 加 --use-angle=metal --enable-gpu --ignore-gpu-blocklist）
//           分六轮打开页面，每轮一个全新的浏览器上下文：
//     perf     桌面 1440×900、像素比 2（MacBook）：首屏海报与文字出现时间、首次加载字节数、实时画面帧率（S7）
//     desktop  桌面 1440×900：开场三张、实时画面、拆层五层、作品区交互、样片、方法与页脚、文案、无障碍（S2 S3 S4 S8 S9）
//              放映台按主会话定的焦点口径验：打开后焦点落在片名上（键盘打开时窗灯金 2px 描边，按计算样式与截图像素双重核对），
//              Tab 一次进视频控件，Esc 收起、焦点回原格；文案按新口径验：成片“由代码合成出片”，素材来源见案例卡
//     mobile   手机 390×844：分段截图、横向溢出、字号（S6）
//     reduced  prefers-reduced-motion: reduce（S5）
//     nojs     关掉 JavaScript（S4 S5 S8）
//     nowebgl  启动参数 --disable-3d-apis，页面拿不到 WebGL（S5）
//
// 用法：
//   npm run site:qa -- --dir out/site --port 8110 --out out/qa/r1
//   node tools/site-qa.mjs --dir out/site --port 8110 --out out/qa/r1 [--only desktop,mobile] [--server python|range]
//        [--build [--previews-dir <目录>]] [--chrome <可执行文件>]
// 退出码：9 项门禁全部 PASS 为 0；有 FAIL / PARTIAL / NOT_RUN 为 1；脚本自身出错为 2。
//
// 服务：默认 python3 -m http.server（与 CONTRACT 第 5 节一致）。它不支持 Range：悬停预览会从片头播、放映台拖不了进度，
// 这是服务器的限制；--server range 换成脚本内置、支持 Range 的静态服务器（更接近 GitHub Pages）。
// 只用 --port 指定的端口，端口被占用就退出，不动别人的服务；退出时关掉自己起的服务。
// 环境变量：BEIMING_ANGLE=metal|vulkan|gl|default（同 engine/render/page.mjs），BEIMING_CHROME 指定浏览器。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const relp = p => path.relative(ROOT, p) || '.';
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (a, f) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(f * s.length))]; };
const r2 = x => (x == null ? null : Math.round(x * 100) / 100);
const MB = b => `${(b / 1e6).toFixed(2)} MB`;

class QAError extends Error {}

// ───────────────────────── 门禁与阈值（CONTRACT 第 6 节、DESIGN 第 7–8 节） ─────────────────────────
const GATES = [['S1', '构建'], ['S2', '加载'], ['S3', '拆层'], ['S4', '作品'], ['S5', '降级'], ['S6', '手机'], ['S7', '性能'], ['S8', '文案'], ['S9', '无障碍']];
const LIMIT = { heroMs: 2500, bytes: 2_500_000, fps: 50, contrast: 4.5, contrastLarge: 3 };
const STEPS = ['intro', 'form', 'shade', 'look', 'stage', 'time', 'rest'];
const LAYERS = ['form', 'shade', 'look', 'stage', 'time'];
const GLYPH = { intro: '拆开', form: '形', shade: '光', look: '笔', stage: '景', time: '时', rest: '收尾' };
const GROUP_COUNTS = { styles: 66, 'ppt-stories': 7, 'ppt-keynote': 6 };
const DATA_COUNTS = { all: 79, styles: 66, 'ppt-stories': 7, 'ppt-keynote': 6, archived: 96 };
const FORBIDDEN_TERMS = ['RAEA', 'raea', 'Lemo', 'lemo', 'Opuscar', 'opuscar', 'SY100', 'sy-style-100',
  'TREATMENT', 'Treatment', '导演阐述', '处理方案', '风格样片'];
const FORBIDDEN_DASHES = ['——', '—', '--'];
// DESIGN.md 第 7 节定稿文案里的数字：页面可见文字里必须能读到（作品引言里的“79 部成片”归下面的口径检查）
const FACTS = ['79 部作品', '1080p', '原生 4K', '10 秒', '0.52 毫秒', 'RTX 5090', '31 秒', '240 帧', 'SSIM 0.973',
  '第 137 帧', '86 式', '66 部成片与 20 种方法模板', '10 秒实验已跑通', '每部 18 到 20 秒', '2 到 4 分钟', '20 秒到 3 分钟', '960 宽'];
// 作品口径（DESIGN.md 第 7 节，主会话定）：成片“由代码合成出片”，素材来源写在案例卡里。
// 旧说法“每一帧都由代码渲染 / 画出来，不是素材剪辑”言过其实（部分作品用了提案原画、AI 生成的画面与公有领域影像），不能再出现
const CLAIM = {
  lede: /^(\d+) 部成片，每一部都由代码合成出片/,      // 作品区引言开头
  source: /来源写在每部的案例卡里/,                    // 作品区的注
  old: ['每一帧都由代码渲染', '每一帧都由代码画出来', '不是素材剪辑', '全部由代码逐帧渲染'],
};
// 时长标签：20 秒、2 分 51 秒；整分钟写“3 分钟”（只写“3 分”像缺了秒数）；不补零（旧站的“2 分 0051 秒”）
const DURATION = /^(\d{1,2} 秒|\d{1,2} 分钟|\d{1,2} 分 \d{1,2} 秒)$/;
const DESK = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };
const MOBILE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' };

// ───────────────────────── 参数 ─────────────────────────
const SCENES = ['perf', 'desktop', 'mobile', 'reduced', 'nojs', 'nowebgl'];
const USAGE = `用法：node tools/site-qa.mjs --dir <构建目录> --port <端口> --out <截图目录> [选项]
  --dir <目录>          构建产物（默认 out/site）
  --port <端口>         本地服务端口（默认 8110，集成 QA 专用）
  --out <目录>          截图与 report.json 的输出目录（默认 out/qa/latest）
  --only <场景,…>       只跑这些场景：${SCENES.join(' ')}（S1 静态核对总会跑）
  --server <类型>       python（默认，python3 -m http.server）或 range（内置，支持 Range 请求）
  --build               先用 tools/build-showcase.py 构建到 --dir（配合 --previews-dir）
  --previews-dir <目录> 构建时的本地预览视频目录
  --chrome <路径>       指定 Chromium 可执行文件（默认 playwright-core 自带）`;

function parseArgs(argv) {
  const o = { dir: 'out/site', port: 8110, out: 'out/qa/latest', only: null, server: 'python', build: false, previewsDir: null,
    chrome: process.env.BEIMING_CHROME || null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined || v.startsWith('--')) throw new QAError(`${a} 需要一个值`); return v; };
    switch (a) {
      case '--dir': o.dir = val(); break;
      case '--port': o.port = Number(val()); break;
      case '--out': o.out = val(); break;
      case '--only': o.only = val().split(',').map(s => s.trim()).filter(Boolean); break;
      case '--server': o.server = val(); break;
      case '--build': o.build = true; break;
      case '--previews-dir': o.previewsDir = val(); break;
      case '--chrome': o.chrome = val(); break;
      case '-h': case '--help': console.log(USAGE); process.exit(0); break;
      default: throw new QAError(`不认识的参数：${a}\n${USAGE}`);
    }
  }
  if (!Number.isInteger(o.port) || o.port < 1024 || o.port > 65535) throw new QAError('--port 要是 1024–65535 之间的整数');
  if (!['python', 'range'].includes(o.server)) throw new QAError('--server 只能是 python 或 range');
  for (const s of o.only || []) if (!SCENES.includes(s)) throw new QAError(`--only 里的「${s}」不是场景名（可选：${SCENES.join(' ')}）`);
  const home = p => (p && p.startsWith('~/') ? path.join(process.env.HOME || '', p.slice(2)) : p);
  o.dir = path.resolve(ROOT, home(o.dir));
  o.out = path.resolve(ROOT, home(o.out));
  if (o.previewsDir) o.previewsDir = path.resolve(ROOT, home(o.previewsDir));
  return o;
}

// ───────────────────────── 结果登记 ─────────────────────────
const CHECKS = [];
const SHOTS = [];
const METRICS = {};
const SCENE_LOG = {};
let SCENE = 'static';
let OUT = '';

function check(gate, name, pass, info = '') {
  const p = pass === null || pass === undefined ? null : Boolean(pass);
  const text = typeof info === 'string' ? info : JSON.stringify(info);
  CHECKS.push({ gate, scene: SCENE, name, pass: p, info: text });
  const mark = p === null ? '未验证' : p ? '通过' : '失败';
  console.log(`  [${gate}] ${mark}  ${name}${text ? `  · ${text.length > 240 ? text.slice(0, 240) + '…' : text}` : ''}`);
  return p;
}

// ───────────────────────── S1：静态核对构建产物 ─────────────────────────
function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out); else out.push(p);      // 软链接（预览视频）按文件算，不跟进去
  }
  return out;
}
const JS_TOKEN = /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|(\/\*[\s\S]*?\*\/)|(\/\/[^\n]*)/g;
const stripComments = code => code.replace(JS_TOKEN, (m, str) => str || ' ');
const STATIC_IMPORT = /(?<![\w$.])(?:import|export)\s*(?:[\w$*{}\s,]+?\s*from\s*)?(["'])([^"'\n]+)\1/g;
const DYNAMIC_IMPORT = /(?<![\w$.])import\s*\(\s*(["'`])([^"'`]*)\1\s*[,)]/g;
const URL_META = /new\s+URL\s*\(\s*(["'`])([^"'`]*)\1\s*,\s*import\.meta\.url\s*\)/g;
const HTML_REF = /\s(src|href|poster|data-preview|data-poster|data-src)\s*=\s*"([^"]*)"/g;
const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
const ENT = s => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

function staticChecks(dir) {
  SCENE = 'static';
  if (!fs.existsSync(path.join(dir, 'index.html'))) {
    check('S1', '构建产物里有 index.html', false, `${relp(dir)}/index.html 不存在：先跑 npm run site:build`);
    return null;
  }
  let marker = null;
  try { marker = JSON.parse(fs.readFileSync(path.join(dir, '.site-build.json'), 'utf8')); } catch { /* 缺标记 */ }
  check('S1', '构建器完整跑完 7 步（.site-build.json 带 counts，不是 building）', marker && marker.counts && !marker.status,
    marker ? `counts ${JSON.stringify(marker.counts)} · 预览 ${marker.previews} · 字体 ${marker.fonts} · gsap ${marker.gsap}` : '缺少 .site-build.json');

  // --out 放在构建目录里面时（例如 --dir out/r2 --out out/r2/qa），上一次的截图与报告不算产物
  const own = OUT && OUT.startsWith(dir + path.sep) ? OUT + path.sep : null;
  const files = walk(dir).filter(f => !own || !f.startsWith(own));
  const missing = [];
  let nRefs = 0;
  const exists = f => { try { fs.statSync(f); return true; } catch { return false; } };   // statSync 会跟随软链接
  const checkRef = (owner, ref, what, ids) => {
    ref = ENT(ref.trim());
    if (!ref || EXTERNAL.test(ref) || ref === '#') return;
    nRefs++;
    if (ref.startsWith('#')) { if (ids && !ids.has(decodeURIComponent(ref.slice(1)))) missing.push(`${relp(owner)} ${what}="${ref}"（锚点不存在）`); return; }
    if (ref.startsWith('/')) { missing.push(`${relp(owner)} ${what}="${ref}"（以 / 开头，Pages 子路径下会 404）`); return; }
    const p = decodeURIComponent(ref.split('#')[0].split('?')[0]);
    if (!p) return;
    const target = path.resolve(path.dirname(owner), p);
    if (!target.startsWith(dir + path.sep)) { missing.push(`${relp(owner)} ${what}="${ref}"（指到构建目录之外）`); return; }
    if (!exists(target)) missing.push(`${relp(owner)} ${what}="${ref}"`);
  };

  // HTML：属性引用、srcset、页内锚点、importmap
  let imap = {};
  const pages = files.filter(f => f.endsWith('.html'));
  for (const page of pages) {
    const code = fs.readFileSync(page, 'utf8');
    const ids = new Set([...code.matchAll(/\sid="([^"]+)"/g)].map(m => ENT(m[1])));
    for (const m of code.matchAll(HTML_REF)) checkRef(page, m[2], m[1], ids);
    for (const m of code.matchAll(/\ssrcset="([^"]*)"/g)) for (const c of m[1].split(',')) checkRef(page, c.trim().split(/\s+/)[0] || '', 'srcset', ids);
    const im = /<script type="importmap">([\s\S]*?)<\/script>/.exec(code);
    if (im) {
      try {
        const map = JSON.parse(im[1]).imports || {};
        if (page === path.join(dir, 'index.html')) imap = map;
        for (const [k, v] of Object.entries(map)) {
          nRefs++;
          const t = path.resolve(path.dirname(page), v);
          if (v.endsWith('/') ? !(exists(t) && fs.statSync(t).isDirectory()) : !exists(t)) missing.push(`${relp(page)} importmap "${k}" → ${v}`);
        }
      } catch (e) { missing.push(`${relp(page)} importmap 不是合法 JSON：${e.message}`); }
    }
  }
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  check('S1', '模板里的 <!-- @works --> 已被作品区标记替换', !/<!--\s*@works\s*-->/.test(html) && /data-works/.test(html));

  // CSS url()
  for (const css of files.filter(f => f.endsWith('.css'))) {
    for (const m of fs.readFileSync(css, 'utf8').matchAll(CSS_URL)) if (!m[2].startsWith('data:')) checkRef(css, m[2], 'url()');
  }

  // JS import 图：从产物里每个 .js 出发
  const jsMissing = [];
  const dynamic = [];
  let nImports = 0;
  const resolveSpec = (spec, from) => {
    if (EXTERNAL.test(spec)) return null;
    if (spec.startsWith('/')) return { error: '以 / 开头的绝对路径' };
    if (spec.startsWith('./') || spec.startsWith('../')) return { file: path.resolve(path.dirname(from), spec) };
    if (imap[spec]) return { file: path.resolve(dir, imap[spec]) };
    const key = Object.keys(imap).filter(k => k.endsWith('/') && spec.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    if (key) return { file: path.resolve(dir, imap[key] + spec.slice(key.length)) };
    return { error: `裸模块「${spec}」不在 importmap 里` };
  };
  for (const js of files.filter(f => f.endsWith('.js') && !f.includes(`${path.sep}vendor${path.sep}gsap${path.sep}`))) {
    const code = stripComments(fs.readFileSync(js, 'utf8'));
    const specs = [];
    for (const m of code.matchAll(STATIC_IMPORT)) specs.push(m[2]);
    for (const m of code.matchAll(DYNAMIC_IMPORT)) { if (m[1] === '`' && m[2].includes('${')) dynamic.push(`${relp(js)}: import(\`${m[2]}\`)`); else specs.push(m[2]); }
    for (const m of code.matchAll(URL_META)) { if (m[2].includes('${')) dynamic.push(`${relp(js)}: new URL(\`${m[2]}\`)`); else specs.push(m[2].startsWith('.') ? m[2] : './' + m[2]); }
    for (const spec of specs) {
      nImports++;
      const r = resolveSpec(spec, js);
      if (!r) continue;
      if (r.error) jsMissing.push(`${relp(js)}: "${spec}"（${r.error}）`);
      else if (!r.file.startsWith(dir + path.sep)) jsMissing.push(`${relp(js)}: "${spec}"（指到构建目录之外）`);
      else if (!exists(r.file)) jsMissing.push(`${relp(js)}: "${spec}"`);
    }
  }
  check('S1', '所有本地 src / href / srcset / poster / data-preview / CSS url() / importmap 都能解析到文件', missing.length === 0,
    missing.length ? `缺 ${missing.length} 处：${missing.slice(0, 8).join('；')}` : `核对 ${nRefs} 处引用`);
  check('S1', 'JS import 图（静态、动态、new URL）里的模块与资源都在产物里', jsMissing.length === 0,
    jsMissing.length ? `缺 ${jsMissing.length} 处：${jsMissing.slice(0, 8).join('；')}` : `核对 ${nImports} 处 import${dynamic.length ? `；${dynamic.length} 处无法静态解析：${dynamic.join('；')}` : ''}`);
  const strays = files.map(f => path.relative(dir, f)).filter(r => r.startsWith(`dev${path.sep}`) || (r.endsWith('.md') && r !== path.join('fonts', 'LICENSE.md')));
  check('S1', '产物里不含 site/dev/ 与 *.md（字体许可 fonts/LICENSE.md 除外）', strays.length === 0, strays.slice(0, 6).join('，'));
  let works = null;
  try { works = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'works.json'), 'utf8')); } catch { /* 下面报 */ }
  const okCounts = works && Object.entries(DATA_COUNTS).every(([k, v]) => works.counts?.[k] === v);
  check('S1', 'data/works.json 数量与契约一致（79 = 66 + 7 + 6，档案 96）', okCounts, works ? JSON.stringify(works.counts) : '缺少 data/works.json');
  let size = 0;
  for (const f of files) { const r = path.relative(dir, f); if (!r.startsWith(`media${path.sep}`) && !fs.lstatSync(f).isSymbolicLink()) size += fs.statSync(f).size; }
  METRICS.build = { marker, files: files.length, refs: nRefs, imports: nImports, sizeExceptMedia: size };
  console.log(`  产物 ${files.length} 个文件，除 media/ 外 ${MB(size)}`);
  return { works };
}

// ───────────────────────── 本地服务 ─────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.txt': 'text/plain; charset=utf-8' };

function portBusy(port) {
  return new Promise(resolve => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}
function probe(url) {
  return new Promise(resolve => {
    const req = http.get(url, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.setTimeout(1500, () => { req.destroy(); resolve(0); });
  });
}

async function startServer(dir, port, kind) {
  if (await portBusy(port)) throw new QAError(`端口 ${port} 已被占用：不动别人的服务，换一个 --port`);
  const url = `http://127.0.0.1:${port}/`;
  let close;
  if (kind === 'python') {
    const log = fs.openSync(path.join(OUT, 'server.log'), 'w');
    const child = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', dir], { stdio: ['ignore', log, log] });
    close = () => { try { child.kill('SIGTERM'); } catch { /* 已退出 */ } };
    process.on('exit', close);
  } else {
    const root = path.resolve(dir);
    const server = http.createServer((req, res) => {
      let p;
      try { p = decodeURIComponent(new URL(req.url, url).pathname); } catch { res.writeHead(400); return res.end(); }
      let file = path.resolve(root, '.' + p);
      if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
      let st;
      try { st = fs.statSync(file); if (st.isDirectory()) { file = path.join(file, 'index.html'); st = fs.statSync(file); } } catch { res.writeHead(404); return res.end(); }
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      let start = 0, end = st.size - 1, code = 200;
      const head = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
      if (m && (m[1] || m[2])) {
        if (m[1] === '') { start = Math.max(0, st.size - Number(m[2])); } else { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), st.size - 1); }
        if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
        code = 206; head['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
      }
      head['Content-Length'] = end - start + 1;
      res.writeHead(code, head);
      if (req.method === 'HEAD') return res.end();
      const s = fs.createReadStream(file, { start, end });
      s.on('error', () => res.destroy());
      res.on('close', () => s.destroy());
      s.pipe(res);
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    close = () => server.close();
  }
  for (let i = 0; i < 100; i++) { if ((await probe(url)) === 200) return { url, close }; await sleep(100); }
  close();
  throw new QAError(`本地服务 ${url} 10 秒内没有响应`);
}

// ───────────────────────── 浏览器 ─────────────────────────
function chromeArgs(extra = []) {
  const angle = process.env.BEIMING_ANGLE || (process.platform === 'darwin' ? 'metal' : 'default');
  return [...(angle === 'default' ? [] : [`--use-angle=${angle}`]), '--enable-gpu', '--ignore-gpu-blocklist',
    '--force-color-profile=srgb', '--font-render-hinting=none', ...extra];
}
let CHROME = null;
let SERVER_KIND = 'python';
const launch = (extra = []) => chromium.launch({ executablePath: CHROME || undefined, args: chromeArgs(extra) });

// 每个页面的报错收集
function watch(page, scene) {
  const rec = { pageErrors: [], consoleErrors: [], consoleWarnings: [], http: [], failed: [], blocked: [] };
  const short = u => u.replace(/^https?:\/\/127\.0\.0\.1:\d+\//, '/');
  page.on('pageerror', e => rec.pageErrors.push(String(e?.message || e).slice(0, 400)));
  page.on('console', m => {
    const t = m.type();
    if (t === 'error') rec.consoleErrors.push(m.text().slice(0, 400));
    else if (t === 'warning') rec.consoleWarnings.push(m.text().slice(0, 300));
  });
  page.on('response', r => { if (r.status() >= 400) rec.http.push(`${r.status()} ${short(r.url())}`); });
  page.on('requestfailed', r => {
    const f = r.failure()?.errorText || '';
    if (/ERR_ABORTED/.test(f) && /\.(mp4|webm)([?#]|$)/i.test(r.url())) return;   // 停掉预览视频时浏览器取消请求，属正常
    // 关掉 JS 时浏览器拒绝取脚本（<link rel="modulepreload"> 也一样），报 csp：是浏览器行为，不是站点缺陷，单独记下
    if (scene === 'nojs' && /csp/i.test(f) && /\.m?js([?#]|$)/i.test(r.url())) { rec.blocked.push(short(r.url())); return; }
    rec.failed.push(`${short(r.url())} ${f}`);
  });
  SCENE_LOG[scene] = rec;
  return rec;
}
function errorsCheck(gate, rec, label) {
  const bad = [...rec.pageErrors.map(e => `页面异常：${e}`), ...rec.consoleErrors.map(e => `控制台错误：${e}`),
    ...rec.http.map(e => `HTTP ${e}`), ...rec.failed.map(e => `请求失败：${e}`)];
  return check(gate, `${label}：无页面异常、控制台错误、4xx/5xx 与失败请求`, bad.length === 0,
    bad.length ? bad.slice(0, 6).join(' | ') : `控制台警告 ${rec.consoleWarnings.length} 条${rec.consoleWarnings.length ? `（${rec.consoleWarnings.slice(0, 2).join(' | ').slice(0, 160)}）` : ''}` +
      (rec.blocked.length ? `；浏览器因 JS 关闭拒绝取 ${rec.blocked.length} 个脚本（${rec.blocked.join('，')}），属正常` : ''));
}

// ───────────────────────── 图像分析页（在浏览器里解码 PNG、算差异与对比度，不用额外依赖） ─────────────────────────
function analyzerLib() {
  const store = new Map();
  const LUT = new Float32Array(256);
  for (let i = 0; i < 256; i++) { const c = i / 255; LUT[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  const lum = (r, g, b) => 0.2126 * LUT[r] + 0.7152 * LUT[g] + 0.0722 * LUT[b];
  const one = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
  function color(str) {
    one.clearRect(0, 0, 1, 1); one.fillStyle = 'rgba(0,0,0,0)'; one.fillStyle = str; one.fillRect(0, 0, 1, 1);
    const d = one.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255];
  }
  async function put(id, b64) {
    const blob = await (await fetch('data:image/png;base64,' + b64)).blob();
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(bmp.width, bmp.height), x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(bmp, 0, 0); bmp.close();
    store.set(id, { w: c.width, h: c.height, d: x.getImageData(0, 0, c.width, c.height).data, c });
    return [c.width, c.height];
  }
  async function jpeg(id, q) {
    const blob = await store.get(id).c.convertToBlob({ type: 'image/jpeg', quality: q });
    const u8 = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  const box = (im, r) => (r ? [Math.max(0, Math.floor(r[0])), Math.max(0, Math.floor(r[1])), Math.min(im.w, Math.ceil(r[0] + r[2])), Math.min(im.h, Math.ceil(r[1] + r[3]))] : [0, 0, im.w, im.h]);
  function diff(a, b, rect) {
    const A = store.get(a), B = store.get(b), [x0, y0, x1, y1] = box(A, rect);
    let sum = 0, n = 0, ch = 0;
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
      const i = (y * A.w + x) * 4;
      const d = (Math.abs(A.d[i] - B.d[i]) + Math.abs(A.d[i + 1] - B.d[i + 1]) + Math.abs(A.d[i + 2] - B.d[i + 2])) / 3;
      sum += d; n++; if (d > 12) ch++;
    }
    return { mean: n ? sum / n : 0, changed: n ? ch / n : 0 };
  }
  // 画面“指纹”：纸色（低饱和、亮）、墨（很暗）、彩色（饱和）各占多少
  function signature(id, rect) {
    const im = store.get(id), [x0, y0, x1, y1] = box(im, rect);
    let n = 0, paper = 0, ink = 0, colorful = 0, sat = 0;
    for (let y = y0; y < y1; y += 3) for (let x = x0; x < x1; x += 3) {
      const i = (y * im.w + x) * 4, r = im.d[i], g = im.d[i + 1], b = im.d[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), s = mx ? (mx - mn) / mx : 0, L = lum(r, g, b);
      n++; sat += s;
      if (s < 0.16 && L > 0.5) paper++;
      else if (L < 0.06) ink++;
      else if (s > 0.25 && L > 0.08) colorful++;
    }
    return { paper: paper / n, ink: ink / n, colorful: colorful / n, sat: sat / n, n };
  }
  // 对比度：文字藏起来之后截的图就是文字背后的真实背景；逐像素算文字色（含透明度混合）与背景的对比度
  function contrast(id, items, scale) {
    const im = store.get(id), out = [];
    for (const it of items) {
      const [tr, tg, tb, ta0] = color(it.color), ta = ta0 * it.opacity;
      if (ta < 0.05) { out.push({ id: it.id, skip: '透明文字' }); continue; }
      const ratios = [];
      const st = Math.max(1, Math.round(2 * scale));
      for (const r of it.rects) {
        const [x0, y0, x1, y1] = box(im, [r[0] * scale, r[1] * scale, r[2] * scale, r[3] * scale]);
        for (let y = y0; y < y1; y += st) for (let x = x0; x < x1; x += st) {
          const i = (y * im.w + x) * 4, br = im.d[i], bg = im.d[i + 1], bb = im.d[i + 2];
          const L1 = lum(Math.round(tr * ta + br * (1 - ta)), Math.round(tg * ta + bg * (1 - ta)), Math.round(tb * ta + bb * (1 - ta)));
          const L2 = lum(br, bg, bb);
          ratios.push((Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05));
        }
      }
      ratios.sort((p, q) => p - q);
      const at = f => ratios[Math.min(ratios.length - 1, Math.floor(f * ratios.length))];
      out.push(ratios.length ? { id: it.id, n: ratios.length, min: ratios[0], p10: at(0.1), median: at(0.5) } : { id: it.id, skip: '没有采到像素' });
    }
    return out;
  }
  // 焦点描边真的画出来了吗：元素框外侧第 1–8 圈像素里，接近目标色（窗灯金）的占多少。四条边分开算（各边只取中间 70%，
  // 避开圆角），各取最好的一圈；px 是达到六成的圈数，约等于描边宽度（CSS 像素）。outline 与 box-shadow 画的环都认
  function ring(id, rect, target, clipW) {
    const im = store.get(id), s = clipW ? im.w / clipW : 1, [tr, tg, tb] = color(target);
    const hit = (x, y) => {
      if (x < 0 || y < 0 || x >= im.w || y >= im.h) return 0;
      const i = (y * im.w + x) * 4;
      return Math.abs(im.d[i] - tr) + Math.abs(im.d[i + 1] - tg) + Math.abs(im.d[i + 2] - tb) <= 60 ? 1 : 0;
    };
    const L = Math.floor(rect[0] * s), T = Math.floor(rect[1] * s), R = Math.ceil((rect[0] + rect[2]) * s), B = Math.ceil((rect[1] + rect[3]) * s);
    const line = (a, b, f) => { const m = Math.round((b - a) * 0.15); let n = 0, k = 0; for (let t = a + m; t < b - m; t++) { n++; k += f(t); } return n ? k / n : 0; };
    const sides = { top: d => line(L, R, x => hit(x, T - 1 - d)), right: d => line(T, B, y => hit(R + d, y)),
      bottom: d => line(L, R, x => hit(x, B + d)), left: d => line(T, B, y => hit(L - 1 - d, y)) };
    const out = {};
    for (const [k, f] of Object.entries(sides)) {
      const cov = [];
      for (let d = 0; d < Math.round(8 * s); d++) cov.push(f(d));
      out[k] = { best: Math.round(Math.max(0, ...cov) * 100) / 100, px: Math.round(cov.filter(c => c >= 0.6).length / s * 10) / 10 };
    }
    return out;
  }
  window.__qa = { put, jpeg, diff, signature, contrast, ring, color, drop: id => { store.delete(id); return true; } };
}

let ANALYZER = null;
let IMG_ID = 0;
const A = (fn, ...args) => ANALYZER.evaluate(([f, a]) => window.__qa[f](...a), [fn, args]);
async function putImage(png) { const id = `i${++IMG_ID}`; await A('put', id, png.toString('base64')); return id; }

// 截图：PNG 进分析页（需要时留着做像素分析），另存一张 JPG 作证据
async function snap(page, name, desc, gates, { keep = false, clip = null } = {}) {
  const png = await page.screenshot({ type: 'png', ...(clip ? { clip } : {}) });
  const id = await putImage(png);
  const file = path.join(OUT, `${name}.jpg`);
  fs.writeFileSync(file, Buffer.from(await A('jpeg', id, 0.86), 'base64'));
  SHOTS.push({ file: relp(file), scene: SCENE, desc, gates });
  if (!keep) { await A('drop', id); return null; }
  return id;
}

// ───────────────────────── 页面里的检查函数（每次导航后装一次；关掉 JS 时 evaluate 照样能用） ─────────────────────────
function pageLib() {
  const describe = el => {
    if (!el || el.nodeType !== 1) return String(el);
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const cls = [...el.classList].filter(c => !/^is-/.test(c)).slice(0, 2);
    if (cls.length) s += '.' + cls.join('.');
    return s;
  };
  const opacityOf = el => { let o = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o; };
  const clipped = el => {
    for (let e = el, k = 0; e && e.nodeType === 1 && k < 8; e = e.parentElement, k++) {
      if (e.classList.contains('sr-only') || e.classList.contains('wk-sr')) return true;
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden') return true;
      const r = e.getBoundingClientRect();
      if ((cs.overflow !== 'visible' || cs.clipPath !== 'none') && (r.width <= 2 || r.height <= 2)) return true;
    }
    return false;
  };
  const navBox = () => {
    const nav = document.getElementById('nav');
    if (!nav) return null;
    const r = nav.getBoundingClientRect();
    return r.bottom <= 1 || Number(getComputedStyle(nav).opacity) < 0.1 ? null : r;
  };
  // 视口里所有可见文字（按所在元素归并），给对比度用
  function textItems() {
    const vw = innerWidth, vh = innerHeight, nav = navBox(), map = new Map(), range = document.createRange();
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (!n.nodeValue.trim()) continue;
      const el = n.parentElement;
      if (!el || el.closest('script,style,template,noscript,svg')) continue;
      const inNav = !!el.closest('#nav');
      range.selectNodeContents(n);
      const rects = [];
      for (const r of range.getClientRects()) {
        if (r.width < 3 || r.height < 3 || r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) continue;
        if (nav && !inNav && r.top < nav.bottom && r.bottom > nav.top) continue;      // 被固定导航压住的那一截不算
        const x = Math.max(0, r.left), y = Math.max(0, r.top);
        rects.push([x, y, Math.min(vw, r.right) - x, Math.min(vh, r.bottom) - y]);
      }
      if (!rects.length) continue;
      let it = map.get(el);
      if (!it) { it = { el, rects: [], text: '' }; map.set(el, it); }
      it.rects.push(...rects); it.text += n.nodeValue.replace(/\s+/g, ' ');
    }
    const items = [];
    for (const it of map.values()) {
      const el = it.el;
      if (clipped(el)) continue;
      const op = opacityOf(el);
      if (op < 0.5) continue;
      const cs = getComputedStyle(el), fs = parseFloat(cs.fontSize), fw = Number(cs.fontWeight) || 400;
      items.push({ id: items.length, desc: describe(el) + (el.parentElement ? ` < ${describe(el.parentElement)}` : ''), text: it.text.trim().slice(0, 28),
        color: cs.color, opacity: op, fontSize: fs, fontWeight: fw, large: fs >= 24 || (fs >= 18.66 && fw >= 700),
        ariaHidden: !!el.closest('[aria-hidden="true"]'), exempt: !!el.closest('[aria-disabled="true"], .nav-brand, .foot-brand'), nav: !!el.closest('#nav'), rects: it.rects });
    }
    return items;
  }
  // 固定导航：底色是否透明、此刻有没有正文压在它下面（文字叠字）
  function navOverlap() {
    const nav = document.getElementById('nav');
    if (!nav) return null;
    const r = nav.getBoundingClientRect(), cs = getComputedStyle(nav), range = document.createRange(), hits = [];
    const transparent = /^rgba\(\d+, \d+, \d+, 0\)$|^transparent$/.test(cs.backgroundColor);
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (!n.nodeValue.trim()) continue;
      const el = n.parentElement;
      if (!el || el.closest('#nav, script, style, template') || clipped(el) || opacityOf(el) < 0.5) continue;
      range.selectNodeContents(n);
      for (const b of range.getClientRects()) {
        if (b.width > 2 && b.bottom > r.top + 2 && b.top < r.bottom - 2 && b.right > r.left && b.left < r.right) { hits.push(n.nodeValue.trim().slice(0, 12)); break; }
      }
    }
    return { position: cs.position, theme: nav.dataset.nav, background: cs.backgroundColor, transparent, n: hits.length, hits: hits.slice(0, 4) };
  }
  function hideText(on) {
    let st = document.getElementById('__qa-hide');
    if (on && !st) {
      st = document.createElement('style'); st.id = '__qa-hide';
      st.textContent = 'body *:not(canvas):not(img):not(video):not(picture) { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; transition: none !important; caret-color: transparent !important; }';
      document.head.appendChild(st);
    }
    if (!on && st) st.remove();
    return true;                      // 等重绘交给 Node 侧 sleep：关掉 JS 时页面里的 rAF 不一定会跑
  }
  // 横向溢出：除了 scrollWidth，还要找被 body 的 overflow-x: clip 悄悄裁掉的元素
  function overflow() {
    const vw = document.documentElement.clientWidth, out = [], seen = [];
    for (const el of document.body.querySelectorAll('*')) {
      if (seen.some(s => s.contains(el))) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || (r.right <= vw + 1 && r.left >= -1)) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility !== 'visible' || cs.position === 'fixed' || el.closest('.stage')) continue;
      let contained = false;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const pc = getComputedStyle(p);
        if (pc.overflowX !== 'visible' || pc.clipPath !== 'none') {
          const pr = p.getBoundingClientRect();
          if (pr.right <= vw + 1 && pr.left >= -1) { contained = true; break; }
        }
      }
      if (contained || clipped(el)) continue;
      seen.push(el);
      const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
      out.push({ el: describe(el), left: Math.round(r.left), right: Math.round(r.right), text: text.slice(0, 30), decorative: !!el.closest('[aria-hidden="true"]') || !text });
    }
    return { vw, scrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth, n: out.length, items: out.slice(0, 20) };
  }
  // 字号：视口里可见文字的最小字号；成段正文（p、dd 里 20 字以上的句子，不含小标签与实时读数）单列
  function fonts() {
    const vw = innerWidth, vh = innerHeight, range = document.createRange(), small = [];
    let min = Infinity, bodyMin = Infinity, n = 0;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let t = w.nextNode(); t; t = w.nextNode()) {
      if (!t.nodeValue.trim()) continue;
      const el = t.parentElement;
      if (!el || el.closest('script,style,template,svg')) continue;
      range.selectNodeContents(t);
      const r = range.getBoundingClientRect();
      if (r.width < 2 || r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) continue;
      if (clipped(el) || opacityOf(el) < 0.5) continue;
      const fs = parseFloat(getComputedStyle(el).fontSize);
      const para = el.closest('p, dd');
      const body = !!para && para.textContent.trim().length >= 20 &&
        !el.closest('.hero-live, .label, .num, .eyebrow, .step-mod, .wk-label, .cap-meta, .wk-meta, .wk-key, .key');
      n++; min = Math.min(min, fs);
      if (body) bodyMin = Math.min(bodyMin, fs);
      if (fs < 11 || (body && fs < 13)) small.push({ el: describe(el), text: t.nodeValue.trim().slice(0, 16), fs: Math.round(fs * 10) / 10, body });
    }
    return { n, min: n ? Math.round(min * 10) / 10 : null, bodyMin: bodyMin === Infinity ? null : Math.round(bodyMin * 10) / 10, nSmall: small.length, small: small.slice(0, 12) };
  }
  function a11y() {
    const nameOf = el => {
      const lb = el.getAttribute('aria-labelledby');
      if (lb) return lb.split(/\s+/).map(id => (document.getElementById(id)?.textContent || '').trim()).join(' ').trim();
      return (el.getAttribute('aria-label') || '').trim();
    };
    const top = el => !el.closest('main, section, article, aside, nav');
    const hs = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(h => !h.closest('[hidden]') && getComputedStyle(h).display !== 'none');
    const levels = hs.map(h => Number(h.tagName[1]));
    const jumps = [];
    levels.forEach((lv, i) => { if (i && lv > levels[i - 1] + 1) jumps.push(`${hs[i - 1].tagName}→${hs[i].tagName}「${hs[i].textContent.trim().slice(0, 12)}」`); });
    const ctrls = [...document.querySelectorAll('a[href], button, [role="button"], video[controls]')].filter(e => !e.closest('[hidden]'));
    const unnamed = ctrls.filter(e => !((e.getAttribute('aria-label') || '').trim() || (e.getAttribute('title') || '').trim() || e.textContent.trim() ||
      e.querySelector('img[alt]:not([alt=""])'))).map(describe);
    const imgs = [...document.images];
    return {
      lang: document.documentElement.lang,
      main: document.querySelectorAll('main').length,
      banner: [...document.querySelectorAll('header')].filter(top).length,
      contentinfo: [...document.querySelectorAll('footer')].filter(top).length,
      navs: [...document.querySelectorAll('nav')].map(n => nameOf(n)),
      sections: [...document.querySelectorAll('main > section')].map(s => ({ id: s.id, name: nameOf(s), via: s.hasAttribute('aria-labelledby') ? 'labelledby' : s.hasAttribute('aria-label') ? 'label' : 'none', heading: s.querySelector('h1, h2')?.id || '' })),
      headings: hs.map(h => `${h.tagName}「${h.textContent.replace(/\s+/g, ' ').trim().slice(0, 14)}」`),
      h1: levels.filter(l => l === 1).length, first: levels[0] || 0, jumps,
      emptyHeadings: hs.filter(h => !h.textContent.trim()).map(describe),
      imgs: imgs.length,
      noAlt: imgs.filter(i => !i.hasAttribute('alt')).map(i => i.getAttribute('src')),
      emptyAlt: imgs.filter(i => i.getAttribute('alt') === '' && !i.closest('[aria-hidden="true"]')).map(i => i.getAttribute('src')),
      svgUnlabeled: [...document.querySelectorAll('svg')].filter(s => !s.closest('[aria-hidden="true"]') && !s.getAttribute('aria-label') && !s.querySelector('title')).length,
      unnamed,
      canvasHidden: [...document.querySelectorAll('canvas')].every(c => c.closest('[aria-hidden="true"]') || c.getAttribute('role') === 'img'),
      videos: [...document.querySelectorAll('video')].map(v => ({ title: v.getAttribute('title') || '', inHidden: !!v.closest('[aria-hidden="true"]') })),
    };
  }
  function copy() {
    const sel = s => document.querySelector(s);
    const meta = [document.title, sel('meta[name="description"]')?.content || '', sel('meta[property="og:title"]')?.content || '', sel('meta[property="og:description"]')?.content || ''];
    const all = [];
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (!n.parentElement?.closest('script,style,template')) all.push(n.nodeValue);
    const attrs = [];
    for (const el of document.querySelectorAll('[alt],[title],[aria-label],[placeholder]')) for (const a of ['alt', 'title', 'aria-label', 'placeholder']) { const v = el.getAttribute(a); if (v) attrs.push(v); }
    const text = s => (sel(s)?.textContent || '').replace(/\s+/g, ' ').trim();
    // 署名区块 [data-attribution]：上游项目名只许写在这里（决定 D04）。查代号时去掉它，查破折号时不去掉
    const blocks = [...document.querySelectorAll('[data-attribution]')];
    const inAttrib = n => !!(n.nodeType === 1 ? n : n.parentElement)?.closest('[data-attribution]');
    let visibleT = document.body.innerText;
    for (const b of blocks) visibleT = visibleT.split(b.innerText).join('');
    const allT = [];
    const w2 = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w2.nextNode(); n; n = w2.nextNode()) if (!n.parentElement?.closest('script,style,template') && !inAttrib(n)) allT.push(n.nodeValue);
    const attrsT = [];
    for (const el of document.querySelectorAll('[alt],[title],[aria-label],[placeholder]')) if (!inAttrib(el)) for (const a of ['alt', 'title', 'aria-label', 'placeholder']) { const v = el.getAttribute(a); if (v) attrsT.push(v); }
    return { meta, visible: document.body.innerText, all: all.join('\n'), attrs, visibleT, allT: allT.join('\n'), attrsT,
      attribBlocks: blocks.map(b => ({ inFooter: !!b.closest('footer'), text: b.innerText.replace(/\s+/g, ' ').trim() })),
      lede: text('#works .wk-lede'), note: text('#works .wk-note') };
  }
  // 当前焦点元素的描边（计算样式）：outline 是不是窗灯金、多宽，box-shadow 里有没有窗灯金的环；元素框给截图比对用
  function focusStyle() {
    const a = document.activeElement;
    if (!a || a === document.body || a === document.documentElement) return null;
    const probe = document.createElement('i');
    probe.style.cssText = 'position:absolute;color:var(--lamp)';
    document.body.appendChild(probe);
    const lamp = getComputedStyle(probe).color;
    probe.remove();
    const cs = getComputedStyle(a), r = a.getBoundingClientRect(), w = parseFloat(cs.outlineWidth) || 0;
    const on = cs.outlineStyle !== 'none' && w > 0;
    return { el: describe(a), text: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 16), fv: a.matches(':focus-visible'),
      outline: on ? `${cs.outlineStyle} ${cs.outlineWidth}` : 'none', width: on ? w : 0, outlineLamp: on && cs.outlineColor === lamp,
      shadowLamp: cs.boxShadow !== 'none' && cs.boxShadow.includes(lamp), lamp, rect: [r.left, r.top, r.width, r.height] };
  }
  function stepState() {
    const st = window.ScrollTrigger?.getById?.('engine-pin');
    return {
      cur: document.querySelector('#engine .step.is-current')?.dataset.step || null,
      vis: [...document.querySelectorAll('#engine .step-text')].filter(t => Number(getComputedStyle(t).opacity) > 0.05).map(t => t.parentElement.dataset.step),
      on: [...document.querySelectorAll('#rail li.is-on')].map(li => li.dataset.key),
      lit: [...document.querySelectorAll('#rail li.is-lit')].map(li => li.dataset.key),
      plates: [...document.querySelectorAll('#engine .step-plate')].map(f => {
        const cs = getComputedStyle(f), img = f.querySelector('img');
        return { step: f.closest('.step')?.dataset.step, display: cs.display, opacity: Math.round(Number(cs.opacity) * 100) / 100, loaded: !!(img && img.complete && img.naturalWidth) };
      }),
      mark: (() => { const em = document.querySelector('.engine-lede em'); return em ? getComputedStyle(em).getPropertyValue('--mark').trim() : ''; })(),
      live: document.documentElement.classList.contains('is-live'),
      q: st?.animation ? Math.round(st.animation.progress() * 1000) / 1000 : null,
      y: Math.round(scrollY),
    };
  }
  function pin() {
    const st = window.ScrollTrigger?.getById?.('engine-pin');
    return st ? { start: Math.round(st.start), end: Math.round(st.end), q: st.animation ? st.animation.progress() : null } : null;
  }
  function works() {
    const frames = [...document.querySelectorAll('#works .wk-frame')];
    const vis = f => { const r = f.getBoundingClientRect(), cs = getComputedStyle(f); return r.width > 0 && r.height > 0 && cs.visibility === 'visible' && cs.display !== 'none'; };
    return {
      all: frames.length, visible: frames.filter(vis).length,
      links: document.querySelectorAll('#works .wk-frame .wk-link[href$=".mp4"]').length,
      groups: [...document.querySelectorAll('#works .wk-group')].map(s => ({ key: s.dataset.group, n: s.querySelectorAll('.wk-frame').length,
        label: s.querySelector('.wk-group-n')?.textContent.trim() || '',
        toc: document.querySelector(`.wk-toc a[href="#works-${s.dataset.group}"] .wk-toc-n`)?.textContent.trim() || '' })),
      names: frames.map(f => f.querySelector('.wk-name')?.textContent.trim() || ''),
      durs: frames.map(f => f.querySelector('.wk-dur')?.textContent.trim() || ''),
      alts: frames.map(f => f.querySelector('img')?.getAttribute('alt') || ''),
      enhanced: !!document.querySelector('[data-works]')?.classList.contains('is-enhanced'),
      filterHidden: !!document.querySelector('#works .wk-filter')?.hidden,
    };
  }
  const poster = () => {
    const i = document.querySelector('.stage-poster');
    if (!i) return null;
    const cs = getComputedStyle(i);
    return { complete: i.complete, w: i.naturalWidth, src: (i.currentSrc || i.src).split('/').pop(), opacity: Number(cs.opacity), visibility: cs.visibility };
  };
  const heroCopy = () => [...document.querySelectorAll('.hero-copy > *')].map(e => { const cs = getComputedStyle(e); return Math.round(Number(cs.opacity) * 100) / 100 * (cs.visibility === 'visible' ? 1 : 0); });
  window.__qp = { describe, textItems, navOverlap, hideText, overflow, fonts, a11y, copy, focusStyle, stepState, pin, works, poster, heroCopy };
}
const installLib = page => page.evaluate(pageLib);
const P = (page, fn, ...args) => page.evaluate(([f, a]) => window.__qp[f](...a), [fn, args]);
const scrollToY = (page, y) => page.evaluate(y => window.scrollTo({ top: y, left: 0, behavior: 'instant' }), Math.round(y));
const scrollToSel = (page, sel, offset = 0) => page.evaluate(([s, o]) => {
  const el = document.querySelector(s);
  if (!el) return false;
  window.scrollTo({ top: el.getBoundingClientRect().top + scrollY - o, left: 0, behavior: 'instant' });
  return true;
}, [sel, offset]);
const waitLive = (page, timeout = 25000) => page.waitForFunction(() => document.documentElement.classList.contains('is-live') && Math.round(performance.now()), null, { timeout, polling: 200 })
  .then(h => h.jsonValue()).catch(() => null);

// 拆层：从上往下扫一遍固定滚动段，按 ScrollTrigger 动画进度记下每一步文字出现的区间
async function findSteps(page) {
  const pin = await P(page, 'pin');
  if (!pin) return null;
  const marks = [];
  const note = s => { if (s.cur && (!marks.length || marks[marks.length - 1][0] !== s.cur)) marks.push([s.cur, s.q ?? 0]); };
  await scrollToY(page, pin.start - 60);
  await sleep(900);
  const N = 72;
  for (let i = 0; i <= N; i++) {
    await scrollToY(page, pin.start + (pin.end - pin.start) * (i / N));
    await sleep(70);
    note(await P(page, 'stepState'));
  }
  await sleep(1300);
  note(await P(page, 'stepState'));
  const ranges = {};
  marks.forEach(([k, q], i) => { ranges[k] = [i === 0 ? 0 : q, marks[i + 1] ? marks[i + 1][1] : 1]; });
  return { pin, order: marks.map(m => m[0]), ranges };
}
async function gotoQ(page, pin, q, settle = 1300) {
  await scrollToY(page, pin.start + (pin.end - pin.start) * q);
  await page.waitForFunction(q => { const st = window.ScrollTrigger?.getById?.('engine-pin'); return !st?.animation || Math.abs(st.animation.progress() - q) < 0.003; }, q, { timeout: 4000, polling: 50 }).catch(() => {});
  await sleep(settle);
  return P(page, 'stepState');
}
const midQ = (ranges, k) => {
  const r = ranges?.[k];
  if (!r) return null;
  if (k === 'intro') return Math.min(r[1] * 0.4, 0.03);
  return (r[0] + r[1]) / 2;
};

// 对比度：记下视口里每段文字的颜色与位置 → 藏起全部文字截一张图（就是文字背后的真实背景）→ 逐像素算
const CONTRAST_ALL = [];
async function contrastAt(page, label, scale = 1) {
  const items = await P(page, 'textItems');
  if (!items.length) return [];
  await P(page, 'hideText', true);
  await sleep(150);
  const png = await page.screenshot({ type: 'png' });
  await P(page, 'hideText', false);
  const id = await putImage(png);
  const res = await A('contrast', id, items.map(({ id, color, opacity, rects }) => ({ id, color, opacity, rects })), scale);
  await A('drop', id);
  const out = [];
  for (const r of res) {
    const it = items[r.id];
    if (r.skip) continue;
    const need = it.large ? LIMIT.contrastLarge : LIMIT.contrast;
    const row = { state: label, text: it.text, el: it.desc, fontSize: r2(it.fontSize), large: it.large, need, p10: r2(r.p10), median: r2(r.median), min: r2(r.min),
      ariaHidden: it.ariaHidden, exempt: it.exempt, nav: it.nav, pass: r.p10 >= need };
    out.push(row);
    CONTRAST_ALL.push(row);
  }
  return out;
}

// 元素框（CSS 像素）四周各留 pad，裁到视口以内；太小（不在视口里）返回 null
function clipAround(page, [x, y, w, h], pad) {
  const vp = page.viewportSize();
  const x0 = Math.max(0, Math.floor(x - pad)), y0 = Math.max(0, Math.floor(y - pad));
  const x1 = Math.min(vp.width, Math.ceil(x + w + pad)), y1 = Math.min(vp.height, Math.ceil(y + h + pad));
  return x1 - x0 < 8 || y1 - y0 < 8 ? null : { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
// 焦点描边看不看得见：计算样式（窗灯金实线 outline ≥ 2px，或窗灯金的 box-shadow 环）+ 截图里元素四条边外侧都有窗灯金像素
// （没被 overflow 裁掉、没被别的层盖住）。返回 { ok, seen, style, …计算样式, px: 四条边的覆盖率与宽度 }
async function focusRing(page) {
  // 放映台打开时页面还可能在平滑滚动：等焦点元素的位置连续两次读数一致再截图
  let st = await P(page, 'focusStyle');
  for (let i = 0; st && i < 12; i++) {
    await sleep(120);
    const again = await P(page, 'focusStyle');
    const still = again && again.rect.every((v, k) => Math.abs(v - st.rect[k]) < 0.5);
    st = again;
    if (still) break;
  }
  if (!st) return { ok: false, seen: false, style: false, el: '无焦点' };
  const [x, y, w, h] = st.rect;
  const style = (st.outlineLamp && st.width >= 2) || st.shadowLamp;
  const clip = clipAround(page, st.rect, 12);
  if (!clip) return { ...st, ok: false, seen: false, style, note: '焦点元素不在视口里' };
  const id = await putImage(await page.screenshot({ type: 'png', clip }));
  const px = await A('ring', id, [x - clip.x, y - clip.y, w, h], st.lamp, clip.width);
  await A('drop', id);
  const seen = ['top', 'right', 'bottom', 'left'].every(k => px[k].best >= 0.6);
  return { ...st, px, seen, style, ok: style && seen };
}
const ringText = r => (r.px ? `${r.el}「${r.text}」：${r.outline}${r.outlineLamp ? ' 窗灯金' : ''}${r.shadowLamp ? '，box-shadow 窗灯金' : ''}${r.fv ? '，focus-visible' : ''}；` +
  `截图四边窗灯金 ${['top', 'right', 'bottom', 'left'].map(k => `${{ top: '上', right: '右', bottom: '下', left: '左' }[k]} ${Math.round(r.px[k].best * 100)}%/${r.px[k].px}px`).join(' ')}` : `${r.el}${r.note ? `（${r.note}）` : ''}`);

// ───────────────────────── 场景：perf（S7） ─────────────────────────
function perfInit() {
  const P = window.__qaPerf = { long: [], lcp: 0, lcpEl: '', classAt: {} };
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) P.long.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: 'longtask', buffered: true }); } catch { /* 不支持 */ }
  try {
    new PerformanceObserver(l => {
      for (const e of l.getEntries()) { P.lcp = e.startTime; P.lcpEl = e.element ? `${e.element.tagName.toLowerCase()}.${[...e.element.classList].join('.')}` : (e.url || ''); }
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch { /* 不支持 */ }
  new MutationObserver(ms => {
    for (const m of ms) if (m.target === document.documentElement) for (const c of document.documentElement.classList) if (!(c in P.classAt)) P.classAt[c] = Math.round(performance.now());
  }).observe(document, { attributes: true, subtree: true, attributeFilter: ['class'] });
}
// 实时读数（约每秒一次，即舞台真正画出的帧数）+ rAF 帧间隔
const fpsSample = (page, ms) => page.evaluate(ms => new Promise(resolve => {
  const node = document.getElementById('live-state'), vals = [], deltas = [];
  const mo = node ? new MutationObserver(() => { const m = /(\d+)\s*fps/.exec(node.textContent); if (m) vals.push(Number(m[1])); }) : null;
  if (mo) mo.observe(node, { subtree: true, childList: true, characterData: true });
  let last = 0, stop = false;
  const tick = t => { if (last) deltas.push(t - last); last = t; if (!stop) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  setTimeout(() => { stop = true; if (mo) mo.disconnect(); resolve({ vals, deltas }); }, ms);
}), ms);
const fpsSummary = ({ vals, deltas }) => {
  const v = vals.length > 3 ? vals.slice(1) : vals;
  const md = median(deltas);
  return { readouts: vals, median: median(v), min: v.length ? Math.min(...v) : null, rafFps: md ? r2(1000 / md) : null, p95FrameMs: r2(pct(deltas, 0.95)), frames: deltas.length };
};

async function scenePerf(browser, base, dir) {
  const ctx = await browser.newContext({ ...DESK, deviceScaleFactor: 2 });
  await ctx.addInitScript(perfInit);
  const page = await ctx.newPage();
  const rec = watch(page, 'perf');
  try {
    await page.goto(base, { waitUntil: 'commit' });
    const heroAt = await page.waitForFunction(() => {
      const img = document.querySelector('.stage-poster');
      const copy = [...document.querySelectorAll('.hero-copy > *')];
      const ok = img && img.complete && img.naturalWidth > 0 && copy.length > 0 &&
        copy.every(e => { const cs = getComputedStyle(e); return cs.visibility === 'visible' && Number(cs.opacity) >= 0.99; });
      return ok && performance.now();
    }, null, { polling: 'raf', timeout: 15000 }).then(h => h.jsonValue()).catch(() => null);
    const liveAt = await waitLive(page, 25000);
    await sleep(3000);
    await installLib(page);
    const gpu = await page.evaluate(() => {
      try {
        const gl = document.createElement('canvas').getContext('webgl2');
        if (!gl) return '';
        const e = gl.getExtension('WEBGL_debug_renderer_info');
        return String(gl.getParameter(e ? e.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
      } catch { return ''; }
    });
    const perf = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      const res = performance.getEntriesByType('resource');
      const size = e => e.transferSize || e.encodedBodySize || 0;
      const keep = res.filter(e => !/\.(mp4|webm)([?#]|$)/i.test(e.name));
      const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime || 0;
      const poster = res.find(e => /hero-poster/.test(e.name));
      return {
        total: size(nav) + keep.reduce((a, e) => a + size(e), 0), n: keep.length + 1,
        videoReqs: res.length - keep.length,
        list: keep.map(e => [e.name.replace(location.origin + '/', ''), size(e)]).sort((a, b) => b[1] - a[1]),
        html: size(nav), fcp: Math.round(fcp), posterEnd: poster ? Math.round(poster.responseEnd) : null,
        lcp: Math.round(window.__qaPerf?.lcp || 0), lcpEl: window.__qaPerf?.lcpEl || '', long: window.__qaPerf?.long || [], classAt: window.__qaPerf?.classAt || {},
      };
    });
    // 按 GitHub Pages 的 gzip 估一个真实传输量（文本类压缩，图片与字体原样）
    let gz = 0;
    for (const [u, b] of perf.list) {
      const f = path.join(dir, decodeURIComponent(u.split('?')[0]));
      if (/\.(js|css|html|json|svg|txt)$/i.test(f) && fs.existsSync(f)) gz += zlib.gzipSync(fs.readFileSync(f), { level: 9 }).length; else gz += b;
    }
    gz += zlib.gzipSync(fs.readFileSync(path.join(dir, 'index.html')), { level: 9 }).length;
    check('S7', `首屏海报与文字在 ${LIMIT.heroMs / 1000} 秒内出现（海报已解码、首屏文字全部不透明）`, heroAt != null && heroAt <= LIMIT.heroMs,
      heroAt != null ? `${Math.round(heroAt)} ms（海报下载完 ${perf.posterEnd} ms，FCP ${perf.fcp} ms，LCP ${perf.lcp} ms：${perf.lcpEl}）` : '15 秒内没有出现');
    check('S7', `除视频外首次加载 ≤ ${LIMIT.bytes / 1e6} MB（实时画面接管后再等 3 秒，不滚动）`, perf.total <= LIMIT.bytes,
      `${MB(perf.total)}（${perf.n} 个请求，本地服务不压缩；按 gzip 估算约 ${MB(gz)}）；最大：${perf.list.slice(0, 5).map(([u, b]) => `${u} ${Math.round(b / 1024)} KB`).join('，')}`);
    const software = !gpu || /swiftshader|llvmpipe|software|basic render/i.test(gpu);
    const heroFps = liveAt ? fpsSummary(await fpsSample(page, 10000)) : null;
    let layerFps = null;
    const steps = liveAt ? await findSteps(page) : null;
    if (steps && steps.ranges.stage) {
      await gotoQ(page, steps.pin, midQ(steps.ranges, 'stage'), 1500);
      layerFps = fpsSummary(await fpsSample(page, 8000));
    }
    const fpsLine = f => (f ? `中位 ${f.median} fps（每秒读数 ${f.readouts.join(' ')}），rAF ${f.rafFps} fps，p95 帧间隔 ${f.p95FrameMs} ms` : '没有实时画面');
    check('S7', `首屏实时画面中位帧率 ≥ ${LIMIT.fps}（1440×900、像素比 2）`, software ? null : heroFps && heroFps.median >= LIMIT.fps, `${fpsLine(heroFps)}；GPU：${gpu || '无'}`);
    check('S7', `拆层“景”这一步中位帧率 ≥ ${LIMIT.fps}`, software ? null : layerFps && layerFps.median >= LIMIT.fps, fpsLine(layerFps));
    // 离开首屏与拆层后应停止渲染（读数不再更新）
    let paused = null;
    if (liveAt) {
      await scrollToSel(page, '#works', 0);
      await sleep(1500);
      const s = await fpsSample(page, 3000);
      paused = s.vals.length === 0;
    }
    check('S7', '滚到作品区（舞台被盖住）后停止渲染：3 秒内实时读数不再更新', paused, paused == null ? '没有实时画面' : paused ? '' : '读数还在更新');
    METRICS.perf = { heroVisibleMs: heroAt && Math.round(heroAt), liveMs: liveAt, gpu, bytes: perf.total, gzipEstimate: gz, requests: perf.n, videoRequests: perf.videoReqs,
      fcp: perf.fcp, lcp: perf.lcp, lcpEl: perf.lcpEl, posterEnd: perf.posterEnd, longTasks: perf.long, classAt: perf.classAt, top: perf.list.slice(0, 12), heroFps, layerFps };
    errorsCheck('S7', rec, '性能轮（桌面 1440×900 像素比 2）');
  } finally { await ctx.close(); }
  METRICS.perfThrottled = await throttledHero(browser, base);
}

// 参考值（不进门禁）：限速到约 4G（下行 9 Mbps、上行 1.5 Mbps、RTT 60 ms，本地服务不压缩，偏保守）时首屏海报与文字多久出现
async function throttledHero(browser, base) {
  const ctx = await browser.newContext({ ...DESK, deviceScaleFactor: 2 });
  await ctx.addInitScript(perfInit);
  const page = await ctx.newPage();
  try {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 60, downloadThroughput: 9e6 / 8, uploadThroughput: 1.5e6 / 8 });
    await page.goto(base, { waitUntil: 'commit' });
    const heroAt = await page.waitForFunction(() => {
      const img = document.querySelector('.stage-poster');
      const copy = [...document.querySelectorAll('.hero-copy > *')];
      return img && img.complete && img.naturalWidth > 0 && copy.length > 0 &&
        copy.every(e => { const cs = getComputedStyle(e); return cs.visibility === 'visible' && Number(cs.opacity) >= 0.99; }) && performance.now();
    }, null, { polling: 'raf', timeout: 20000 }).then(h => h.jsonValue()).catch(() => null);
    const liveAt = await waitLive(page, 30000);
    const lcp = await page.evaluate(() => Math.round(window.__qaPerf?.lcp || 0));
    const out = { network: '下行 9 Mbps、上行 1.5 Mbps、RTT 60 ms（不压缩）', heroVisibleMs: heroAt && Math.round(heroAt), lcp, liveMs: liveAt };
    console.log(`  参考（限速约 4G）：首屏海报与文字 ${out.heroVisibleMs ?? '超时'} ms，LCP ${lcp} ms，实时画面接管 ${liveAt ?? '超时'} ms`);
    return out;
  } catch (e) {
    return { error: String(e?.message || e) };
  } finally { await ctx.close(); }
}

// ───────────────────────── 场景：desktop（S2 S3 S4 S8 S9） ─────────────────────────
async function sceneDesktop(browser, base) {
  const ctx = await browser.newContext(DESK);
  const page = await ctx.newPage();
  const rec = watch(page, 'desktop');
  try {
    // —— 开场：0.3 / 1 / 2.5 秒（从导航开始算） ——
    await page.goto(base, { waitUntil: 'commit' });
    const introAt = {};
    for (const t of [300, 1000, 2500]) {
      for (;;) { const now = await page.evaluate(() => performance.now()).catch(() => 0); if (now >= t - 12) break; await sleep(Math.max(5, Math.min(40, t - now - 10))); }
      introAt[t] = Math.round(await page.evaluate(() => performance.now()));
      await snap(page, `desk-intro-${String(t).padStart(4, '0')}`, `首屏开场 ${t / 1000} 秒（实际 ${introAt[t]} ms）`, ['S2', 'S7']);
    }
    METRICS.intro = introAt;
    await installLib(page);
    const liveAt = await waitLive(page, 25000);
    check('S2', 'Stage 就绪，实时画面交叉淡入并接管（html.is-live）', liveAt != null, liveAt ? `导航后 ${liveAt} ms` : '25 秒内没有进入实时画面');
    await sleep(1600);
    await page.mouse.move(1100, 300);
    await sleep(400);
    const hero = await page.evaluate(() => ({
      state: document.getElementById('hero-live')?.dataset.state, text: document.getElementById('hero-live')?.textContent.replace(/\s+/g, ' ').trim(),
      live: getComputedStyle(document.documentElement).getPropertyValue('--live').trim(),
      canvas: (() => { const c = document.getElementById('stage-canvas'); return c ? `${c.width}×${c.height}` : ''; })(),
      h264: document.createElement('video').canPlayType('video/mp4; codecs="avc1.640028, mp4a.40.2"'),
    }));
    METRICS.desktop = { liveMs: liveAt, readout: hero.text, canvas: hero.canvas, h264: hero.h264 };
    check('S2', '实时读数换成“实时渲染中 · fps · 三角形”', hero.state === 'live' && /实时渲染中 · \d+ fps · [\d,]+ 三角形/.test(hero.text), hero.text);
    const poster = await P(page, 'poster');
    check('S2', '首屏海报已加载（实时画面接管后藏起）', poster && poster.complete && poster.w > 0, JSON.stringify(poster));
    // 两帧相隔 0.7 秒应当不同（鲲的姿态、目光、墨线抖动都在变）
    const clip = { x: 560, y: 80, width: 860, height: 560 };
    const ia = await putImage(await page.screenshot({ type: 'png', clip }));
    await sleep(700);
    const ib = await putImage(await page.screenshot({ type: 'png', clip }));
    const d = await A('diff', ia, ib, null);
    await A('drop', ia); await A('drop', ib);
    check('S2', '实时画面在动（右上鲲的区域相隔 0.7 秒两帧有差异）', d.changed > 0.002 || d.mean > 0.3, `变化像素 ${(d.changed * 100).toFixed(2)}%，平均差 ${d.mean.toFixed(2)}/255`);
    await snap(page, 'desk-hero-live', '首屏：实时画面接管之后', ['S2']);
    const cHero = await contrastAt(page, '首屏');

    // —— 键盘：从页首按 Tab，焦点都要看得见（S9） ——
    const stops = [];
    for (let i = 0; i < 22; i++) {
      await page.keyboard.press('Tab');
      await sleep(160);
      stops.push(await page.evaluate(() => {
        const a = document.activeElement;
        if (!a || a === document.body) return null;
        const cs = getComputedStyle(a), r = a.getBoundingClientRect();
        const ow = parseFloat(cs.outlineWidth) || 0;
        const outline = cs.outlineStyle !== 'none' && ow >= 1 && !/rgba\(0, 0, 0, 0\)|transparent/.test(cs.outlineColor);
        return { el: window.__qp.describe(a), text: (a.getAttribute('aria-label') || a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 18),
          fv: a.matches(':focus-visible'), ok: outline || (cs.boxShadow && cs.boxShadow !== 'none'), inView: r.width > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth };
      }));
    }
    const bad = stops.filter(s => s && !(s.fv && s.ok && s.inView));
    check('S9', '键盘 Tab 走 22 步：每一步焦点都有窗灯金描边且在视口里', stops.filter(Boolean).length >= 10 && bad.length === 0,
      bad.length ? `看不见的焦点：${bad.map(s => `${s.el}「${s.text}」`).join('，')}` : `顺序：${stops.filter(Boolean).slice(0, 12).map(s => s.text || s.el).join(' → ')} …`);
    check('S9', 'Tab 第一步是“跳到正文”', stops[0] && /跳到正文/.test(stops[0].text), stops[0] ? stops[0].text : '无');
    await page.evaluate(() => document.activeElement?.blur());
    await scrollToY(page, 0);
    await sleep(1200);

    // —— 首屏样片：原地展开（不是模态框），Enter 打开、Esc 收起，焦点进出（S4） ——
    await page.focus('#film-open');
    await page.keyboard.press('Enter');
    await sleep(1600);
    const film = await page.evaluate(() => {
      const v = document.getElementById('film-video');
      return { open: !document.getElementById('hero-film').hidden, expanded: document.getElementById('film-open').getAttribute('aria-expanded'),
        active: document.activeElement?.id, paused: v.paused, t: Math.round(v.currentTime * 100) / 100, muted: v.muted, readyState: v.readyState };
    });
    await snap(page, 'desk-film-open', '首屏原地展开《北冥》样片', ['S4']);
    await page.keyboard.press('Escape');
    await sleep(900);
    const filmShut = await page.evaluate(() => ({ open: !document.getElementById('hero-film').hidden, active: document.activeElement?.id, paused: document.getElementById('film-video').paused }));
    check('S4', '首屏样片：Enter 原地展开、焦点进入视频、有声播放；Esc 收起、焦点回到按钮', film.open && film.expanded === 'true' && film.active === 'film-video' &&
      !film.paused && film.t > 0 && !film.muted && !filmShut.open && filmShut.paused && filmShut.active === 'film-open', `${JSON.stringify(film)} → ${JSON.stringify(filmShut)}`);
    await page.evaluate(() => document.activeElement?.blur());

    // —— 拆层（S3） ——
    const steps = await findSteps(page);
    const pinned = await page.evaluate(() => document.getElementById('engine')?.classList.contains('is-pinned'));
    check('S3', '拆层固定滚动已建立（#engine.is-pinned + ScrollTrigger engine-pin）', !!steps && pinned, steps ? `固定段 ${steps.pin.start}→${steps.pin.end} px（${((steps.pin.end - steps.pin.start) / 900).toFixed(1)} 屏）` : '没有 engine-pin');
    if (steps) {
      check('S3', '滚过 #engine：文字按 拆开 → 形 → 光 → 笔 → 景 → 时 → 收尾 依次出现', JSON.stringify(steps.order) === JSON.stringify(STEPS),
        `${steps.order.map(k => GLYPH[k] || k).join(' → ')}；区间 ${Object.entries(steps.ranges).map(([k, r]) => `${GLYPH[k]} ${r[0].toFixed(2)}–${r[1].toFixed(2)}`).join('，')}`);
      const sig = {}, sync = [];
      const region = [0.45 * 1440, 72, 0.55 * 1440 - 8, 900 - 80];
      const list = [['intro', 0], ...LAYERS.map((k, i) => [k, i + 1]), ['rest', 6]];
      for (const [k, i] of list) {
        const q = midQ(steps.ranges, k);
        if (q == null) continue;
        const s = await gotoQ(page, steps.pin, q, k === 'intro' ? 1700 : 1300);
        const name = k === 'intro' ? 'desk-engine-0-intro' : k === 'rest' ? 'desk-engine-6-rest' : `desk-engine-${i}-${k}`;
        const id = await snap(page, name, `拆层 q=${q.toFixed(3)}：${GLYPH[k]}（文字 ${s.cur}，九字轨当前 ${s.on.join('、') || '无'}）`, ['S3'], { keep: LAYERS.includes(k) });
        if (id) { sig[k] = await A('signature', id, region); await A('drop', id); }
        if (LAYERS.includes(k)) sync.push({ k, q: r2(q), cur: s.cur, vis: s.vis, on: s.on, ok: s.cur === k && s.vis.length === 1 && s.vis[0] === k && s.on.length === 1 && s.on[0] === k, live: s.live });
        if (k === 'form') METRICS.engineMark = s.mark;
        if (k === 'form') await contrastAt(page, '拆层·形');
        if (k === 'stage') await contrastAt(page, '拆层·景');
        if (k === 'rest') check('S3', '收尾：九字轨全部点亮，另外四层（人 界 声 片）为当前', s.cur === 'rest' && s.lit.length === 9 && ['paint', 'overlay', 'audio', 'render'].every(x => s.on.includes(x)), `当前 ${s.on.join('、')}；点亮 ${s.lit.length}`);
      }
      const badSync = sync.filter(s => !s.ok);
      check('S3', '五层各自的停留点：文字面板、九字轨与该层一致，且只有一步文字可见', sync.length === 5 && badSync.length === 0,
        badSync.length ? JSON.stringify(badSync) : sync.map(s => `${GLYPH[s.k]}@${s.q}`).join('，'));
      METRICS.layerSignature = Object.fromEntries(Object.entries(sig).map(([k, v]) => [k, { paper: r2(v.paper), ink: r2(v.ink * 100) / 100, colorful: r2(v.colorful), sat: r2(v.sat) }]));
      const g = sig;
      if (g.form && g.shade && g.look && g.stage && g.time) {
        const fmt = k => `${GLYPH[k]} 纸 ${(g[k].paper * 100).toFixed(0)}% 墨 ${(g[k].ink * 100).toFixed(1)}% 彩 ${(g[k].colorful * 100).toFixed(0)}%`;
        const live = sync.every(s => s.live);
        check('S3', '画面随层变化：形→光 上色（彩色占比升高），光→笔 落墨（墨线占比升高），景、时 天空铺满（纸色占比骤降）',
          live ? g.shade.colorful > g.form.colorful + 0.02 && g.look.ink > g.shade.ink + 0.001 && Math.min(g.form.paper, g.shade.paper, g.look.paper) > 0.3 && Math.max(g.stage.paper, g.time.paper) < 0.15 : null,
          `${live ? '' : '实时画面没有接管，未验证；'}右侧 7 栏：${LAYERS.map(fmt).join('；')}`);
      }
      await scrollToY(page, steps.pin.end + 900 * 0.55);
      await sleep(1300);
      await snap(page, 'desk-dusk', '拆层之后：入夜渐变带接作品区', ['S3']);
    }

    // —— 作品区（S4） ——
    await worksDesktop(page);

    // —— 方法与页脚 ——
    await scrollToSel(page, '#method', 0);
    await sleep(1300);
    await snap(page, 'desk-method', '方法篇章', ['S8', 'S9']);
    await contrastAt(page, '方法');
    await scrollToY(page, 1e7);
    await sleep(1300);
    await snap(page, 'desk-footer', '页脚', ['S8', 'S9']);
    await contrastAt(page, '页脚');
    const ov = await P(page, 'overflow');
    check('S6', '桌面 1440 宽：无横向滚动、无被裁掉的内容', ov.scrollWidth <= ov.vw && ov.items.filter(i => !i.decorative).length === 0, ov.n ? JSON.stringify(ov.items.slice(0, 4)) : `scrollWidth ${ov.scrollWidth}`);

    // —— 文案（S8） ——
    await copyChecks(page, 'JS 开启');

    // —— 无障碍（S9） ——
    await scrollToY(page, 0);
    await sleep(600);
    const a = await P(page, 'a11y');
    check('S9', '<html lang="zh-CN">', a.lang === 'zh-CN', a.lang);
    check('S9', '地标完整：页首 header、唯一的 main、页脚 footer、每个 nav 有名字、main 下每个 section 有可访问名称',
      a.main === 1 && a.banner >= 1 && a.contentinfo >= 1 && a.navs.every(Boolean) && a.sections.every(s => s.name),
      `nav：${a.navs.join(' / ')}；section：${a.sections.map(s => `#${s.id}「${s.name}」(${s.via})`).join('，')}`);
    const labelled = a.sections.filter(s => s.via === 'label' && s.heading);
    check('S9', '有可见标题的 section 用 aria-labelledby 指向标题（名称与可见标题一致）', labelled.length === 0,
      labelled.length ? labelled.map(s => `#${s.id} 用 aria-label「${s.name}」，可见标题是 #${s.heading}`).join('；') : '');
    check('S9', '标题层级：只有一个 h1、从 h1 开始、不跳级、没有空标题', a.h1 === 1 && a.first === 1 && a.jumps.length === 0 && a.emptyHeadings.length === 0,
      a.jumps.length ? `跳级：${a.jumps.join('，')}` : a.headings.join(' '));
    check('S9', '图片都有 alt（装饰图只出现在 aria-hidden 里），内联 SVG 不裸露', a.noAlt.length === 0 && a.emptyAlt.length === 0 && a.svgUnlabeled === 0,
      `${a.imgs} 张图；缺 alt：${a.noAlt.length}；空 alt 且没藏起：${a.emptyAlt.slice(0, 3).join('，') || 0}；无名 SVG：${a.svgUnlabeled}`);
    check('S9', '链接与按钮都有可访问名称；画布 aria-hidden；视频有 title', a.unnamed.length === 0 && a.canvasHidden && a.videos.every(v => v.title || v.inHidden),
      a.unnamed.length ? `无名：${a.unnamed.slice(0, 6).join('，')}` : `视频：${a.videos.map(v => v.title).join('、')}`);
    const fails = CONTRAST_ALL.filter(c => !c.pass && !c.exempt && !c.ariaHidden);
    const weak = CONTRAST_ALL.filter(c => !c.pass && (c.exempt || c.ariaHidden));
    const worst = [...CONTRAST_ALL].filter(c => !c.exempt).sort((x, y) => x.p10 / x.need - y.p10 / y.need).slice(0, 4);
    check('S9', `文字对比度（像素采样 10% 分位）：正文 ≥ ${LIMIT.contrast}:1、大字 ≥ ${LIMIT.contrastLarge}:1`, CONTRAST_ALL.length > 0 && fails.length === 0,
      `${CONTRAST_ALL.length} 段文字，${new Set(CONTRAST_ALL.map(c => c.state)).size} 个画面；${fails.length ? `不达标：${fails.slice(0, 6).map(c => `[${c.state}]「${c.text}」${c.el} ${c.p10}:1（要 ${c.need}）`).join('；')}` : `最低：${worst.map(c => `[${c.state}]「${c.text}」${c.p10}:1`).join('；')}`}${weak.length ? `；装饰或豁免文字偏低 ${weak.length} 段：${weak.slice(0, 3).map(c => `「${c.text}」${c.p10}:1`).join('，')}` : ''}`);
    METRICS.contrast = CONTRAST_ALL;
    errorsCheck('S2', rec, '桌面 1440×900 全程');
  } finally { await ctx.close(); }
}

async function worksDesktop(page) {
  const w0 = await P(page, 'works');
  check('S4', '作品区脚本已接管（initWorks → [data-works].is-enhanced）', w0.enhanced);
  check('S4', '开 JS：79 部作品都在，每格都链到预览视频', w0.all === 79 && w0.links === 79, `共 ${w0.all}，链接 ${w0.links}`);
  await scrollToSel(page, '#works', 0);
  await sleep(1400);
  await page.mouse.move(8, 450);
  await snap(page, 'desk-works-head', '作品区篇章头（入夜）', ['S4', 'S8']);
  await contrastAt(page, '作品·篇章头');
  // TOC 锚点：跳到分组后标题不能被固定导航压住
  const toc = await page.evaluate(() => [...document.querySelectorAll('.wk-toc a')].map(a => a.getAttribute('href')));
  const covered = [];
  for (const href of toc) {
    await scrollToSel(page, '#works', 0);
    await sleep(500);
    await page.click(`.wk-toc a[href="${href}"]`);
    await sleep(1600);
    const r = await page.evaluate(h => {
      const t = document.querySelector(`${h}-title`) || document.querySelector(h);
      const navH = document.getElementById('nav').offsetHeight;      // 导航此刻可能收起，但往上一滚就会出现：按它的高度留位
      const b = t.getBoundingClientRect();
      return { top: Math.round(b.top), navH, ok: b.top >= navH - 1 && b.top < innerHeight };
    }, href);
    if (!r.ok) covered.push(`${href}：标题 top ${r.top} px，导航高 ${r.navH} px`);
  }
  check('S9', '作品目录锚点：跳过去之后分组标题在视口里，且留出固定导航的高度（导航出现时不压住标题）', covered.length === 0, covered.join('；') || toc.join(' '));

  // 接触印样
  await scrollToSel(page, '#works-styles', 0);
  await sleep(1500);
  await page.mouse.move(8, 450);
  await sleep(300);
  await snap(page, 'desk-works-grid', '接触印样（66 部风格样片）与家族筛选', ['S4']);
  await contrastAt(page, '作品·接触印样');
  const cols = await page.evaluate(() => getComputedStyle(document.querySelector('.wk-sheet')).gridTemplateColumns.split(' ').length);
  METRICS.worksCols = cols;
  // 悬停预览
  const tile = page.locator('#works-styles .wk-frame').nth(2);
  const tb = await tile.locator('.wk-pic').boundingBox();
  await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
  await sleep(100);
  const early = await tile.evaluate(f => !!f.querySelector('video.wk-hover'));
  await sleep(1700);
  // 有悬停短循环（data-hover，构建时从海报那一帧剪好）就该播它；没有才播整部预览（#t= 从海报那一帧起，要服务器支持 Range）
  const hov = await tile.evaluate(f => {
    const v = f.querySelector('video.wk-hover');
    if (!v) return null;
    const file = (v.getAttribute('src') || '').split('#')[0];
    return { cls: f.classList.contains('is-previewing'), muted: v.muted, loop: v.loop, t: Math.round(v.currentTime * 100) / 100, start: Number(f.dataset.start || 0),
      paused: v.paused, src: file.split('/').pop(), clip: f.dataset.hover || '', usesClip: !!f.dataset.hover && file === f.dataset.hover };
  });
  if (hov) {
    METRICS.hoverStart = hov.clip
      ? { server: SERVER_KIND, mode: hov.usesClip ? 'clip' : 'preview', src: hov.src, start: hov.start, t: hov.t, fromPosterFrame: hov.usesClip,
        note: hov.usesClip ? '悬停播构建时剪好的短循环：从 previewStart（海报那一帧）起剪，片头就是海报，不依赖 Range' : '有 data-hover 却没播短循环' }
      : { server: SERVER_KIND, mode: 'preview', src: hov.src, start: hov.start, t: hov.t, fromPosterFrame: hov.start <= 0 || hov.t >= hov.start,
        note: SERVER_KIND === 'python' && hov.start > 0 ? 'python http.server 不支持 Range，#t= 被忽略，从片头播；GitHub Pages 支持 Range' : '' };
  }
  await snap(page, 'desk-works-hover', '悬停 1.8 秒：静音循环预览', ['S4']);
  await page.mouse.move(8, 450);
  await sleep(700);
  const left = await tile.evaluate(f => ({ cls: f.classList.contains('is-previewing'), v: !!f.querySelector('video.wk-hover') }));
  check('S4', '悬停预览：100 ms 时还没加载，180 ms 后静音循环播放（有短循环就播短循环），离开即停并移除',
    !early && hov && hov.cls && hov.muted && hov.loop && !hov.paused && hov.t > 0 && (!hov.clip || hov.usesClip) && !left.cls && !left.v,
    `${JSON.stringify(hov)} → 离开后 ${JSON.stringify(left)}`);
  // 原地放映（焦点口径，主会话定）：打开后焦点落在 #works-screen 的片名上（键盘打开时窗灯金 2px 描边，下面的键盘检查验），
  // Tab 一次进视频控件，Esc 收起、焦点回到原来那一格。鼠标点开按全站 :focus-visible 惯例不要求画描边，只记下来
  await tile.locator('.wk-link').click();
  await sleep(1900);
  const scr = await page.evaluate(() => {
    const s = document.getElementById('works-screen'), v = s?.querySelector('video'), a = document.activeElement;
    const link = document.querySelectorAll('#works-styles .wk-frame')[2]?.querySelector('.wk-link');
    return s && v ? { muted: v.muted, paused: v.paused, t: Math.round(v.currentTime * 100) / 100, controls: v.controls,
      focus: a && s.contains(a) && a.matches('.wk-screen-title') ? 'title' : a === v ? 'video' : window.__qp.describe(a),
      title: s.querySelector('.wk-screen-title')?.textContent, expanded: link?.getAttribute('aria-expanded'), controlsAttr: link?.getAttribute('aria-controls'),
      after: s.parentElement?.previousElementSibling?.dataset.n } : null;
  });
  await page.mouse.move(8, 450);
  const cr = scr ? await focusRing(page) : null;
  await snap(page, 'desk-works-screen', '点击第 3 格：在本行行尾原地展开放映台', ['S4']);
  check('S4', '点击：原地展开放映台（有声、带控件、焦点落在片名上、aria-expanded / aria-controls 正确）', scr && !scr.muted && !scr.paused && scr.t > 0 && scr.controls &&
    scr.focus === 'title' && scr.expanded === 'true' && scr.controlsAttr === 'works-screen',
    `${JSON.stringify(scr)}${cr ? `；鼠标点开的描边（不计入判定）：${cr.seen ? '看得见' : '没画'}，${ringText(cr)}` : ''}`);
  await page.keyboard.press('Escape');
  await sleep(1000);
  const closed = await page.evaluate(() => ({ screen: !!document.getElementById('works-screen')?.isConnected, n: document.activeElement?.closest('.wk-frame')?.dataset.n,
    expanded: document.activeElement?.getAttribute('aria-expanded'), preview: !!document.activeElement?.closest('.wk-frame')?.querySelector('video.wk-hover') }));
  check('S4', 'Esc 收起放映台，焦点回到原来那一格（不顺手起播预览）', !closed.screen && closed.n === '03' && closed.expanded === 'false' && !closed.preview, JSON.stringify(closed));
  // 键盘（焦点口径）：Tab 到第 8 格（焦点可见）→ Enter 打开，焦点落在 #works-screen 的片名上、窗灯金 2px 描边看得见
  //   → Tab 一次进视频控件 → Esc 收起，焦点回到第 8 格
  await page.locator('#works-styles .wk-frame').nth(6).locator('.wk-link').focus();
  await page.keyboard.press('Tab');
  await sleep(450);
  const kf = await page.evaluate(() => { const a = document.activeElement, cs = getComputedStyle(a); return { n: a.closest('.wk-frame')?.dataset.n, fv: a.matches(':focus-visible'), outline: `${cs.outlineStyle} ${cs.outlineWidth}` }; });
  const fb = await page.locator('#works-styles .wk-frame').nth(7).boundingBox();
  await snap(page, 'desk-works-focus', '键盘焦点落在第 8 格（窗灯金描边）', ['S4', 'S9'], { clip: { x: Math.max(0, fb.x - 30), y: Math.max(0, fb.y - 30), width: fb.width + 60, height: fb.height + 60 } });
  await page.keyboard.press('Enter');
  await sleep(1400);
  const ko = await page.evaluate(() => {
    const s = document.getElementById('works-screen'), a = document.activeElement;
    return { open: !!s?.isConnected, title: !!s && !!a && s.contains(a) && a.matches('.wk-screen-title'), el: window.__qp.describe(a) };
  });
  const kr = await focusRing(page);
  const kclip = kr.rect && clipAround(page, kr.rect, 40);
  if (kclip) await snap(page, 'desk-works-kbd-title', `键盘打开放映台：焦点落在片名「${kr.text}」上（窗灯金 2px 描边）`, ['S4', 'S9'], { clip: kclip });
  await page.keyboard.press('Tab');
  await sleep(300);
  const kv = await page.evaluate(() => {
    const s = document.getElementById('works-screen'), a = document.activeElement;
    return { video: !!s && !!a && s.contains(a) && a.tagName === 'VIDEO', el: window.__qp.describe(a), fv: !!a?.matches(':focus-visible') };
  });
  await page.keyboard.press('Escape');
  await sleep(900);
  const kc = await page.evaluate(() => {
    const a = document.activeElement;
    return { open: !!document.getElementById('works-screen')?.isConnected, n: a?.closest('.wk-frame')?.dataset.n, expanded: a?.getAttribute('aria-expanded'), fv: !!a?.matches(':focus-visible') };
  });
  check('S4', '键盘：Tab 焦点可见；Enter 打开后焦点落在片名上、窗灯金 2px 描边看得见；Tab 一次进视频；Esc 收起、焦点回原格',
    kf.n === '08' && kf.fv && /solid 2px/.test(kf.outline) && ko.open && ko.title && kr.ok && kv.video && !kc.open && kc.n === '08' && kc.expanded === 'false',
    `第 ${kf.n} 格 ${kf.outline}${kf.fv ? '（focus-visible）' : ''} → Enter：${ko.open ? '已展开' : '没展开'}，焦点 ${ko.title ? '片名' : ko.el}，描边${kr.ok ? '看得见' : kr.style ? '样式对但截图里看不见' : '没画或不是窗灯金 2px'}（${ringText(kr)}）` +
    ` → Tab：${kv.video ? '进了视频' : `落在 ${kv.el}`} → Esc：${kc.open ? '没收起' : '已收起'}，焦点第 ${kc.n ?? '?'} 格（aria-expanded ${kc.expanded}）`);
  // 画风家族筛选
  await scrollToSel(page, '#works-styles', 0);
  await sleep(600);
  const chips = await page.evaluate(() => [...document.querySelectorAll('.wk-chip')].map(c => ({ f: c.dataset.family, n: Number(c.querySelector('.wk-chip-n')?.textContent || 0), name: c.firstChild?.textContent.trim() })));
  const pick = chips.filter(c => c.f !== 'all' && c.n >= 4).sort((x, y) => Math.abs(x.n - 10) - Math.abs(y.n - 10))[0];
  let filt = null, back = null;
  if (pick) {
    await page.click(`.wk-chip[data-family="${pick.f}"]`);
    await sleep(1300);
    filt = await page.evaluate(() => ({ shown: [...document.querySelectorAll('#works-styles .wk-frame')].filter(f => !f.hidden).length,
      status: document.querySelector('[data-filter-status]')?.textContent || '', pressed: document.querySelector('.wk-chip[aria-pressed="true"]')?.dataset.family }));
    await page.mouse.move(8, 450);
    await snap(page, 'desk-works-filter', `筛选「${pick.name}」之后`, ['S4']);
    await page.click('.wk-chip[data-family="all"]');
    await sleep(1300);
    back = await page.evaluate(() => [...document.querySelectorAll('#works-styles .wk-frame')].filter(f => !f.hidden).length);
  }
  const famSum = chips.filter(c => c.f !== 'all').reduce((s, c) => s + c.n, 0);
  check('S4', '画风家族筛选：剩下的格数与按钮上的数字一致，读屏状态更新，回到“全部”恢复 66 部；各家族合计 66', !!pick && filt.shown === pick.n && filt.pressed === pick.f &&
    filt.status.includes(`${pick.n} 部`) && back === 66 && famSum === 66, pick ? `${pick.name} ${pick.n} → 显示 ${filt.shown}，状态「${filt.status}」，全部 ${back}；家族合计 ${famSum}` : '没有可用的筛选按钮');
  // 胶片条（故事片）：左右翻看 + 条下放映台
  await scrollToSel(page, '#works-ppt-stories', 0);
  await sleep(1200);
  await page.mouse.move(8, 450);
  const before = await page.evaluate(() => document.querySelector('#works-ppt-stories-track').scrollLeft);
  const nextBtn = page.locator('#works-ppt-stories .wk-strip-btn[data-dir="1"]');
  if (await nextBtn.isVisible()) { await nextBtn.click(); await sleep(1100); }
  const after = await page.evaluate(() => document.querySelector('#works-ppt-stories-track').scrollLeft);
  await page.locator('#works-ppt-stories .wk-frame').nth(2).locator('.wk-link').click();
  await sleep(1900);
  const st = await page.evaluate(() => { const s = document.getElementById('works-screen'); return s ? { host: s.parentElement.className, prev: s.parentElement.previousElementSibling?.className, playing: !s.querySelector('video').paused, title: s.querySelector('.wk-screen-title').textContent } : null; });
  await page.mouse.move(8, 450);
  await snap(page, 'desk-works-strip', '故事片胶片条：在条下方展开放映台', ['S4']);
  check('S4', '胶片条：向右翻看，点击后在条下方展开放映台并播放', after > before + 50 && st && /--strip/.test(st.host) && st.prev === 'wk-strip' && st.playing, `scrollLeft ${before}→${after}；${JSON.stringify(st)}`);
  await page.keyboard.press('Escape');
  await sleep(800);
  await scrollToSel(page, '#works-ppt-keynote', 0);
  await sleep(1200);
  await page.mouse.move(8, 450);
  await snap(page, 'desk-works-keynote', '发布会动画胶片条与作品区的注', ['S4', 'S8']);
  await contrastAt(page, '作品·发布会');
}

// 文案（S8）：可见文字、隐藏文字、alt/title/aria-label、meta 都查
async function copyChecks(page, label) {
  const c = await P(page, 'copy');
  // 每项是 [查破折号用的全文, 查代号用的文字（去掉了署名区块）]
  const corpora = { 可见文字: [c.visible, c.visibleT], 全部文字节点: [c.all, c.allT], '替代文字（alt / title / aria-label）': [c.attrs.join('\n'), c.attrsT.join('\n')], 'meta 与标题': [c.meta.join('\n'), c.meta.join('\n')] };
  const hits = [];
  for (const [name, [text, termText]] of Object.entries(corpora)) {
    for (const t of FORBIDDEN_TERMS) if (termText.includes(t)) hits.push(`${name}有「${t}」（上游项目名只能写在页脚署名区块里）：${termText.slice(Math.max(0, termText.indexOf(t) - 12), termText.indexOf(t) + 16).replace(/\s+/g, ' ')}`);
    for (const t of FORBIDDEN_DASHES) if (text.includes(t)) hits.push(`${name}有破折号「${t}」：${text.slice(Math.max(0, text.indexOf(t) - 12), text.indexOf(t) + 12).replace(/\s+/g, ' ')}`);
  }
  const strayAttrib = c.attribBlocks.filter(b => !b.inFooter);
  check('S8', `${label}：署名区块 [data-attribution] 只在页脚（共 ${c.attribBlocks.length} 处）`, strayAttrib.length === 0, strayAttrib.map(b => b.text.slice(0, 30)).join('；'));
  check('S8', `${label}：可见文字、替代文字与 meta 里没有破折号与内部代号、TREATMENT 等残留`, hits.length === 0, hits.slice(0, 6).join('；'));
  // 作品口径：引言以“N 部成片，每一部都由代码合成出片”开头，注里写明素材来源见案例卡；旧说法哪里都不能有
  const lede = CLAIM.lede.exec(c.lede);
  const ledeN = lede ? Number(lede[1]) : null;
  const stale = [];
  for (const [name, text] of Object.entries(corpora)) for (const t of CLAIM.old) if (text.includes(t)) stale.push(`${name}有旧说法「${t}」`);
  check('S8', `${label}：作品口径：引言写“79 部成片，每一部都由代码合成出片”，注写明素材来源在案例卡里，旧说法（每一帧都由代码渲染、不是素材剪辑）不再出现`,
    ledeN === DATA_COUNTS.all && CLAIM.source.test(c.note) && stale.length === 0,
    `引言「${c.lede.slice(0, 40) || '没找到 #works .wk-lede'}」；注${CLAIM.source.test(c.note) ? '写了素材来源' : `没写素材来源：「${c.note.slice(0, 40)}」`}${stale.length ? `；${stale.slice(0, 4).join('；')}` : ''}`);
  const flat = c.visible.replace(/\s+/g, ' ');
  const lost = FACTS.filter(f => !flat.includes(f));
  check('S8', `${label}：DESIGN 第 7 节的数字都在页面上（${FACTS.length} 条）`, lost.length === 0, lost.length ? `缺：${lost.join('，')}` : '');
  const w = await P(page, 'works');
  const groupsOk = w.groups.length === 3 && w.groups.every(g => GROUP_COUNTS[g.key] === g.n && g.label === `${g.n} 部` && (g.toc === '' || g.toc === String(g.n)));
  const ledeCount = /(\d+) 部成片/.exec(c.lede);                 // 只核数字；措辞归上面的口径检查
  check('S8', `${label}：各组实际格数 = 组标题数字 = 目录数字（66 / 7 / 6），合计 79 与引言一致`, groupsOk && w.all === 79 && !!ledeCount && Number(ledeCount[1]) === w.all,
    `${w.groups.map(g => `${g.key} ${g.n}（标题 ${g.label}，目录 ${g.toc}）`).join('，')}；引言 ${ledeCount ? ledeCount[1] : '读不出'} 部，实际 ${w.all} 部`);
  const badName = w.names.filter(n => !n || /TREATMENT|Treatment|导演阐述|处理方案|风格样片|\d+\s*秒|^\d+[\s._-]|[A-Za-z]{2,}-\d|_/.test(n));
  const badDur = w.durs.filter(d => !DURATION.test(d) || /\b0\d/.test(d));
  check('S8', `${label}：作品标题只写片名，时长标签格式正确（20 秒、2 分 51 秒、整分钟写 3 分钟）`, badName.length === 0 && badDur.length === 0,
    `${badName.length ? `可疑标题：${badName.slice(0, 5).join('，')}；` : ''}${badDur.length ? `可疑时长：${badDur.slice(0, 5).join('，')}` : `时长 ${new Set(w.durs).size} 种：${[...new Set(w.durs)].sort((a, b) => a.length - b.length || a.localeCompare(b)).join('，')}`}`);
  const longAlt = w.alts.filter(a => a.length > 40 || !a);
  check('S8', `${label}：作品简介（海报 alt）每条 1 到 40 字`, longAlt.length === 0, longAlt.slice(0, 3).join('；'));
}

// ───────────────────────── 场景：mobile（S6） ─────────────────────────
async function sceneMobile(browser, base) {
  const ctx = await browser.newContext(MOBILE);
  const page = await ctx.newPage();
  const rec = watch(page, 'mobile');
  const segs = [];
  const seg = async (name, desc) => {
    await page.mouse.move(1, 1).catch(() => {});
    await snap(page, name, desc, ['S6']);
    const ov = await P(page, 'overflow');
    const fz = await P(page, 'fonts');
    segs.push({ name, sw: ov.scrollWidth, vw: ov.vw, cut: ov.items.filter(i => !i.decorative), deco: ov.items.filter(i => i.decorative).length, min: fz.min, bodyMin: fz.bodyMin, small: fz.small });
  };
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await installLib(page);
    const liveAt = await waitLive(page, 25000);
    await sleep(1500);
    METRICS.mobile = { liveMs: liveAt, readout: await page.evaluate(() => document.getElementById('hero-live')?.textContent.replace(/\s+/g, ' ').trim()),
      canvas: await page.evaluate(() => { const c = document.getElementById('stage-canvas'); return c ? `${c.width}×${c.height}` : ''; }) };
    await seg('mob-1-hero', `手机首屏（${liveAt ? `实时画面 ${liveAt} ms 接管` : '海报'}）`);
    const steps = await findSteps(page);
    if (steps) {
      for (const [i, k] of LAYERS.entries()) {
        const q = midQ(steps.ranges, k);
        if (q == null) continue;
        await gotoQ(page, steps.pin, q, 1300);
        await seg(`mob-2-engine-${i + 1}-${k}`, `手机拆层：${GLYPH[k]}（鲲在上半屏，文字在下）`);
      }
    }
    check('S6', '手机拆层：固定滚动与五步文字顺序同桌面', !!steps && JSON.stringify(steps.order) === JSON.stringify(STEPS), steps ? steps.order.map(k => GLYPH[k]).join(' → ') : '没有固定滚动');
    await scrollToSel(page, '#works', 0);
    await sleep(1200);
    await seg('mob-3-works', '手机作品区篇章头');
    await scrollToSel(page, '#works-styles', 0);
    await sleep(1300);
    await seg('mob-4-sheet', '手机接触印样');
    const cols = await page.evaluate(() => getComputedStyle(document.querySelector('.wk-sheet')).gridTemplateColumns.split(' ').length);
    await page.locator('#works-styles .wk-frame').nth(1).locator('.wk-link').tap();
    await sleep(1800);
    const m = await page.evaluate(() => { const s = document.getElementById('works-screen'); return s ? { open: true, playing: !s.querySelector('video').paused } : { open: false }; });
    await seg('mob-5-screen', '手机：轻点直接原地放映');
    check('S6', `手机接触印样 ${cols} 列；轻点直接放映（触屏不先悬停）`, m.open && m.playing && cols === 2, JSON.stringify(m));
    const closeBtn = page.locator('#works-screen .wk-screen-close');
    if (await closeBtn.count()) { await closeBtn.tap(); await sleep(800); }
    await scrollToSel(page, '#works-ppt-stories', 0);
    await sleep(1200);
    await seg('mob-6-strip', '手机故事片胶片条');
    await scrollToSel(page, '#method', 0);
    await sleep(1200);
    await seg('mob-7-method', '手机方法篇章');
    await page.evaluate(() => window.scrollBy({ top: innerHeight * 0.9, behavior: 'instant' }));
    await sleep(1000);
    await seg('mob-8-routes', '手机方法篇章：三条路线');
    await scrollToY(page, 1e7);
    await sleep(1100);
    await seg('mob-9-footer', '手机页脚');
    await scrollToY(page, 0);
    await sleep(1600);
    await page.locator('#film-open').tap();
    await sleep(1600);
    await seg('mob-10-film', '手机：首屏原地展开样片');
    const wide = segs.filter(s => s.sw > s.vw || s.cut.length);
    check('S6', '390×844 各段：无横向滚动，也没有被 body 的 overflow-x 悄悄裁掉的内容', wide.length === 0,
      wide.length ? wide.map(s => `${s.name}：scrollWidth ${s.sw}/${s.vw}${s.cut.length ? `，被裁 ${s.cut.slice(0, 3).map(c => `${c.el}「${c.text}」${c.left}→${c.right}`).join('，')}` : ''}`).join('；') : `${segs.length} 段都在 ${segs[0]?.vw}px 以内`);
    const small = segs.flatMap(s => s.small.map(x => ({ ...x, seg: s.name })));
    const minFs = Math.min(...segs.map(s => s.min ?? 99));
    const bodyFs = Math.min(...segs.map(s => s.bodyMin ?? 99));
    check('S6', '文字可读：没有小于 11px 的字，成段正文不小于 13px', small.length === 0,
      small.length ? small.slice(0, 6).map(x => `${x.seg} ${x.el}「${x.text}」${x.fs}px`).join('；') : `最小字号 ${minFs}px（小标签、编号）；成段正文最小 ${bodyFs}px`);
    errorsCheck('S6', rec, '手机 390×844 全程');
  } finally { await ctx.close(); }
}

// ───────────────────────── 场景：reduced（S5） ─────────────────────────
async function sceneReduced(browser, base) {
  const ctx = await browser.newContext({ ...DESK, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const rec = watch(page, 'reduced');
  try {
    await page.goto(base, { waitUntil: 'load' });
    await installLib(page);
    await sleep(1800);
    const s = await page.evaluate(() => ({
      rm: document.documentElement.classList.contains('rm'), live: document.getElementById('hero-live')?.textContent.replace(/\s+/g, ' ').trim(),
      canvas: getComputedStyle(document.getElementById('stage-canvas')).opacity,
      stage: performance.getEntriesByType('resource').filter(e => /js\/stage\.js|three\.module|stage-sky/.test(e.name)).map(e => e.name.split('/').pop()),
      pinned: document.getElementById('engine').classList.contains('is-pinned'),
    }));
    const poster = await P(page, 'poster');
    const copy = await P(page, 'heroCopy');
    await snap(page, 'rm-1-hero', '减少动态：首屏只显示海报', ['S5']);
    check('S5', '减少动态：不加载舞台与 three.js，海报显示，首屏文字全部可见，读数写明已按系统设置减少动态', s.rm && s.stage.length === 0 && poster?.complete && poster.w > 0 &&
      poster.opacity > 0.99 && copy.every(o => o > 0.99) && /减少动态/.test(s.live) && s.canvas === '0', `${JSON.stringify({ ...s, poster, copy })}`);
    check('S5', '减少动态：拆层不固定滚动（静帧依次排列）', !s.pinned);
    const plates = [];
    for (let i = 0; i < 5; i++) {
      await page.evaluate(i => document.querySelectorAll('#engine .step-layer')[i]?.scrollIntoView({ block: 'center', behavior: 'instant' }), i);
      await sleep(700);
      if (i === 0 || i === 2 || i === 4) await snap(page, `rm-2-engine-${i + 1}-${LAYERS[i]}`, `减少动态：拆层静帧 ${GLYPH[LAYERS[i]]}`, ['S5']);
      plates.push((await P(page, 'stepState')).plates[i]);
    }
    const texts = await page.evaluate(() => [...document.querySelectorAll('#engine .step-text')].map(t => Number(getComputedStyle(t).opacity)));
    check('S5', '减少动态：五张静帧都显示并加载完成，七段拆层文字都可见', plates.every(p => p && p.display !== 'none' && p.loaded && p.opacity > 0.99) && texts.length === 7 && texts.every(o => o > 0.99),
      `${plates.map(p => `${p?.step} ${p?.display} ${p?.loaded ? '已载' : '未载'}`).join('，')}；文字不透明度 ${texts.join(' ')}`);
    await scrollToSel(page, '#works-styles', 0);
    await sleep(800);
    const hidden = await page.evaluate(() => [...document.querySelectorAll('#works .wk-frame')].filter(f => Number(getComputedStyle(f).opacity) < 0.99).length);
    const tile = page.locator('#works-styles .wk-frame').nth(0);
    const b = await tile.boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + 60);
    await sleep(900);
    const hv = await tile.evaluate(f => !!f.querySelector('video.wk-hover'));
    await snap(page, 'rm-3-works', '减少动态：作品区（悬停不播放）', ['S5']);
    await tile.locator('.wk-link').click();
    await sleep(1500);
    const rs = await page.evaluate(() => { const s = document.getElementById('works-screen'); return s ? { open: true, playing: !s.querySelector('video').paused } : { open: false }; });
    check('S5', '减少动态：作品不做入场隐藏，悬停不播放，点击才播放', hidden === 0 && !hv && rs.open && rs.playing, `未显示 ${hidden}；悬停起播 ${hv}；点击 ${JSON.stringify(rs)}`);
    await page.keyboard.press('Escape');
    errorsCheck('S5', rec, '减少动态');
  } finally { await ctx.close(); }
}

// ───────────────────────── 场景：nowebgl（S5） ─────────────────────────
async function sceneNoWebGL(base) {
  const browser = await launch(['--disable-3d-apis']);
  const ctx = await browser.newContext(DESK);
  const page = await ctx.newPage();
  const rec = watch(page, 'nowebgl');
  try {
    await page.goto(base, { waitUntil: 'load' });
    await installLib(page);
    const gl = await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'));
    await page.waitForFunction(() => document.documentElement.classList.contains('no-stage') || /不支持/.test(document.getElementById('hero-live')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
    await sleep(1200);
    const s = await page.evaluate(() => ({ cls: document.documentElement.className, live: document.getElementById('hero-live')?.textContent.replace(/\s+/g, ' ').trim(),
      canvas: getComputedStyle(document.getElementById('stage-canvas')).opacity }));
    const poster = await P(page, 'poster');
    const copy = await P(page, 'heroCopy');
    await snap(page, 'nogl-1-hero', '禁用 WebGL：首屏海报不动，读数写明不支持实时画面', ['S5']);
    check('S5', '禁用 WebGL：createStage 返回 null 后海报留着，读数写明不支持实时画面，首屏文字完整', !gl && /no-stage/.test(s.cls) && /不支持实时画面/.test(s.live) &&
      poster?.complete && poster.w > 0 && poster.opacity > 0.99 && copy.every(o => o > 0.99) && s.canvas === '0', `${JSON.stringify({ webgl2: gl, ...s, poster })}`);
    const steps = await findSteps(page);
    const res = [];
    if (steps) {
      for (const [i, k] of LAYERS.entries()) {
        const q = midQ(steps.ranges, k);
        const st = await gotoQ(page, steps.pin, q, 1400);
        const p = st.plates;
        res.push({ k, cur: st.cur, ok: st.cur === k && p[i]?.display !== 'none' && p[i]?.loaded && p[i]?.opacity > 0.95 && p.every((x, j) => j === i || x.opacity < 0.05) });
        if (k === 'form' || k === 'stage' || k === 'time') await snap(page, `nogl-2-engine-${i + 1}-${k}`, `禁用 WebGL：拆层改用静帧 ${GLYPH[k]}`, ['S5']);
      }
    }
    check('S5', '禁用 WebGL：拆层照常固定滚动，五张静帧按层交叉淡入，文字同步', !!steps && JSON.stringify(steps.order) === JSON.stringify(STEPS) && res.length === 5 && res.every(r => r.ok),
      steps ? res.map(r => `${GLYPH[r.k]}${r.ok ? '✓' : `✗(${r.cur})`}`).join(' ') : '没有固定滚动');
    const w = await P(page, 'works');
    check('S5', '禁用 WebGL：作品区照常（79 部，脚本已接管）', w.all === 79 && w.enhanced, `共 ${w.all}`);
    errorsCheck('S5', rec, '禁用 WebGL');
  } finally { await ctx.close(); await browser.close(); }
}

// ───────────────────────── 场景：nojs（S4 S5 S8） ─────────────────────────
async function sceneNoJS(browser, base) {
  const ctx = await browser.newContext({ ...DESK, javaScriptEnabled: false });
  const page = await ctx.newPage();
  const rec = watch(page, 'nojs');
  try {
    await page.goto(base, { waitUntil: 'load' });
    await installLib(page);
    await sleep(800);
    const s = await page.evaluate(() => ({ nojs: document.documentElement.classList.contains('no-js'), film: document.getElementById('film-open')?.getAttribute('href'),
      pinned: document.getElementById('engine').classList.contains('is-pinned'),
      glyphs: getComputedStyle(document.querySelector('.hero-glyphs')).color }));
    const poster = await P(page, 'poster');
    const copy = await P(page, 'heroCopy');
    await snap(page, 'nojs-1-hero', '关掉 JavaScript：首屏', ['S4', 'S5']);
    check('S5', '关掉 JS：首屏海报、毛笔标题文字与全部文案可见，样片按钮直接链到 mp4', s.nojs && poster?.complete && poster.w > 0 && copy.every(o => o > 0.99) &&
      s.film === 'media/beiming.mp4' && !/rgba\(0, 0, 0, 0\)/.test(s.glyphs), JSON.stringify({ ...s, poster, copy }));
    const plates = [];
    for (let i = 0; i < 5; i++) {
      await page.evaluate(i => document.querySelectorAll('#engine .step-layer')[i]?.scrollIntoView({ block: 'center', behavior: 'instant' }), i);
      await sleep(400);
      if (i === 0 || i === 3) await snap(page, `nojs-2-engine-${i + 1}-${LAYERS[i]}`, `关掉 JS：拆层静帧 ${GLYPH[LAYERS[i]]}`, ['S5']);
      plates.push((await P(page, 'stepState')).plates[i]);
    }
    check('S5', '关掉 JS：拆层静态版，五张静帧都显示并加载', !s.pinned && plates.every(p => p && p.display !== 'none' && p.loaded), plates.map(p => `${p?.step} ${p?.loaded ? '已载' : '未载'}`).join('，'));
    // 固定导航没有脚本来换配色：滚到纸面、作品区时还看不看得清，会不会和正文叠字
    await page.evaluate(() => document.querySelectorAll('#engine .step-layer')[0]?.scrollIntoView({ block: 'start', behavior: 'instant' }));
    await sleep(400);
    const navPaper = (await contrastAt(page, '关掉 JS·纸面')).filter(r => r.nav);
    const ovPaper = await P(page, 'navOverlap');
    await scrollToSel(page, '#works', 0);
    await sleep(600);
    await snap(page, 'nojs-3-works', '关掉 JS：作品区', ['S4']);
    await scrollToSel(page, '#works-ppt-stories', 0);
    await sleep(500);
    await snap(page, 'nojs-4-strip', '关掉 JS：故事片胶片条', ['S4', 'S5']);
    const ovNight = await P(page, 'navOverlap');
    const badNav = navPaper.filter(r => !r.pass);
    check('S5', '关掉 JS：滚过首屏后，固定导航的文字仍看得清，也不和正文叠字', navPaper.length > 0 && badNav.length === 0 && !(ovPaper?.transparent && ovPaper.n) && !(ovNight?.transparent && ovNight.n),
      `导航 ${ovPaper?.position}、配色 ${ovPaper?.theme}、底色 ${ovPaper?.background}；纸面上导航文字对比度 ${navPaper.map(r => `「${r.text}」${r.p10}:1`).join(' ')}；` +
      `叠字：纸面 ${ovPaper?.n ?? 0} 处${ovPaper?.n ? `（${ovPaper.hits.join('、')}）` : ''}，作品区 ${ovNight?.n ?? 0} 处${ovNight?.n ? `（${ovNight.hits.join('、')}）` : ''}`);
    const w = await P(page, 'works');
    check('S4', '关掉 JS：79 部作品都可见、都链到预览视频，筛选按钮不出现', w.all === 79 && w.visible === 79 && w.links === 79 && w.filterHidden, `共 ${w.all}，可见 ${w.visible}，链接 ${w.links}`);
    await copyChecks(page, 'JS 关闭');
    errorsCheck('S4', rec, '关掉 JS');
  } finally { await ctx.close(); }
}

// ───────────────────────── 主流程 ─────────────────────────
function gateStatus(id) {
  const cs = CHECKS.filter(c => c.gate === id);
  if (!cs.length || cs.every(c => c.pass === null)) return 'NOT_RUN';
  if (cs.some(c => c.pass === false)) return 'FAIL';
  return cs.every(c => c.pass === true) ? 'PASS' : 'PARTIAL';
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  OUT = opts.out;
  CHROME = opts.chrome;
  SERVER_KIND = opts.server;
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of fs.readdirSync(OUT)) if (/^(desk|mob|rm|nogl|nojs|perf)-.*\.jpg$|^report\.json$|^server\.log$|^build\.log$/.test(f)) fs.rmSync(path.join(OUT, f));
  const t0 = Date.now();
  console.log(`北冥作品站集成验收：${relp(opts.dir)} → 端口 ${opts.port}（${opts.server}），截图与报告写到 ${relp(OUT)}`);

  if (opts.build) {
    const args = ['tools/build-showcase.py', '--out', opts.dir, ...(opts.previewsDir ? ['--previews-dir', opts.previewsDir] : [])];
    console.log(`\n[构建] python3 ${args.join(' ')}`);
    const r = spawnSync('python3', args, { cwd: ROOT, encoding: 'utf8' });
    fs.mkdirSync(OUT, { recursive: true });          // --out 在构建目录里面时，构建器清空目录会把它一起删掉
    fs.writeFileSync(path.join(OUT, 'build.log'), `${r.stdout || ''}${r.stderr || ''}`);
    SCENE = 'build';
    check('S1', '构建器退出码 0', r.status === 0, `退出码 ${r.status}；日志 ${relp(path.join(OUT, 'build.log'))}`);
  }
  console.log('\n[S1] 静态核对构建产物');
  if (!fs.existsSync(opts.dir)) throw new QAError(`构建目录 ${opts.dir} 不存在：先跑 npm run site:build`);
  staticChecks(opts.dir);

  const run = s => !opts.only || opts.only.includes(s);
  const server = await startServer(opts.dir, opts.port, opts.server);
  let browser = null;
  const meta = {};
  try {
    browser = await launch();
    meta.browser = browser.version();
    const actx = await browser.newContext();
    ANALYZER = await actx.newPage();
    await ANALYZER.goto('about:blank');
    await ANALYZER.evaluate(analyzerLib);
    const scenes = [
      ['perf', '性能（S7）', () => scenePerf(browser, server.url, opts.dir), 'S7'],
      ['desktop', '桌面（S2 S3 S4 S8 S9）', () => sceneDesktop(browser, server.url), 'S2'],
      ['mobile', '手机（S6）', () => sceneMobile(browser, server.url), 'S6'],
      ['reduced', '减少动态（S5）', () => sceneReduced(browser, server.url), 'S5'],
      ['nojs', '关掉 JS（S4 S5 S8）', () => sceneNoJS(browser, server.url), 'S4'],
      ['nowebgl', '禁用 WebGL（S5）', () => sceneNoWebGL(server.url), 'S5'],
    ];
    for (const [key, label, fn, gate] of scenes) {
      if (!run(key)) continue;
      SCENE = key;
      const ts = Date.now();
      console.log(`\n[${key}] ${label}`);
      try { await fn(); } catch (e) { check(gate, `场景 ${key} 跑完`, false, `脚本异常：${String(e?.stack || e).split('\n').slice(0, 3).join(' ')}`); }
      console.log(`  用时 ${((Date.now() - ts) / 1000).toFixed(0)} 秒`);
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.close();
  }

  const gates = GATES.map(([id, title]) => {
    const cs = CHECKS.filter(c => c.gate === id);
    const status = gateStatus(id);
    const failed = cs.filter(c => c.pass === false).map(c => c.name);
    const pending = cs.filter(c => c.pass === null).map(c => c.name);
    const note = `${cs.filter(c => c.pass === true).length}/${cs.length} 项通过${failed.length ? `；失败：${failed.join('；')}` : ''}${pending.length ? `；未验证：${pending.join('；')}` : ''}`;
    return { id, title, status, note, checks: cs, evidence: SHOTS.filter(s => s.gates.includes(id)).map(s => s.file) };
  });
  const report = {
    tool: 'tools/site-qa.mjs', contract: 'site/CONTRACT.md 第 6 节',
    startedAt: new Date(t0).toISOString(), seconds: Math.round((Date.now() - t0) / 1000),
    dir: relp(opts.dir), url: `http://127.0.0.1:${opts.port}/`, server: opts.server, scenes: opts.only || SCENES,
    platform: `${process.platform} ${process.arch}`, chrome: meta.browser, chromeArgs: chromeArgs(),
    gates, metrics: METRICS, screenshots: SHOTS, logs: SCENE_LOG,
  };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
  console.log('\n—— 门禁 ——');
  for (const g of gates) console.log(`  ${g.id} ${g.title}  ${g.status.padEnd(8)} ${g.note.length > 200 ? g.note.slice(0, 200) + '…' : g.note}`);
  console.log(`\n截图 ${SHOTS.length} 张，报告 ${relp(path.join(OUT, 'report.json'))}，用时 ${report.seconds} 秒`);
  return gates.every(g => g.status === 'PASS') ? 0 : 1;
}

main().then(code => process.exit(code)).catch(e => {
  console.error(e instanceof QAError ? `出错：${e.message}` : e);
  process.exit(2);
});
