#!/usr/bin/env node
// 北冥代码动画风格 · 86 式的风格索引：生成、核对、按题材查候选。全部只读仓库内的快照与目录，不联网、不渲染。
//   node tools/c-styles.mjs                 重写 routes/c-style/STYLES.md 与 routes/c-style/styles.json（生成物，别手改）
//   node tools/c-styles.mjs --check         只核对：两个文件是否与快照、案例目录一致；数据本身有矛盾也报（不写文件）
//   node tools/c-styles.mjs find <关键词…> [--tech canvas2d|webgl|svg|dom] [--contract render|seek] [--made] [--top 5]
//                                           按题材 / 名称 / 画面描述打分排序，给出候选（关键词中英文都行，多个词取并集打分）
//   通用：--json 只在 stdout 输出一个结果对象（C2 信封）；--help 打印用法、不碰任何文件
// 退出码（docs/CLI 的 C1）：0 成功；2 用法错误；3 缺数据源（快照或目录不在）；4 核对不通过（文件过期或数据矛盾）。
//
// 数据来源（只读）：
//   cases/vendor/lock.json                                       两套风格库的仓库、固定提交与逐文件 sha256（"来源@提交"一列）
//   cases/vendor/lemo-opuscar/styles/<slug>/style.json、STYLE.md  Lemo 66 种：编号、中英文名、类别、适用题材（uses）、开篇一句、媒介陷阱
//   cases/vendor/lemo-opuscar/styles/<slug>/demo/                上游示例页：执行面检测
//   cases/vendor/sy-style-100/comp/meta.js、docs/STYLES.md、styles/<目录>/index.html   SY 20 种：名称、画面、技术、帧率与时长、用到的本机字体
//   cases/references.json、cases/catalog.json                    我们做过的那部：案例 id、状态、成片规格、预览；页面源码（自包含判断、节奏）
// 判断规则（启发式的都在表头说明里写明）：
//   执行面     从示例入口顺着 <script src> / import 把引用到的 .js 全读一遍，找 getContext('2d' / 'webgl')、three.js、SVG、CSS 3D
//   自包含     我们那部的页面源码（.html / .js / .mjs，tools/ 除外）里没有以 /core/ 开头的绝对路径；有就只能在 Lemo 库根目录下服务
//   节奏       我们那部源码里写的速度（BPM 40–220 之间的值）＋成片帧率；多个值是多个段落
// 输出不含时间戳：同一份快照重跑逐字节一致。
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUT_MD = 'routes/c-style/STYLES.md';
export const OUT_JSON = 'routes/c-style/styles.json';
const SY_DIR = 'cases/vendor/sy-style-100', LEMO_DIR = 'cases/vendor/lemo-opuscar';

const USAGE = `用法：
  node tools/c-styles.mjs                重写 ${OUT_MD} 与 ${OUT_JSON}
  node tools/c-styles.mjs --check        只核对，不写文件（过期或数据矛盾时退出码 4）
  node tools/c-styles.mjs find <关键词…> [--tech canvas2d|webgl|svg|dom] [--contract render|seek] [--made] [--top 5]
                                         按题材、名称、画面描述给候选排序（--made：只要我们做过成片的）
通用选项：--json（stdout 只输出一个结果对象）、--help
退出码：0 成功；2 用法错误；3 缺数据源；4 核对不通过`;

class Fail extends Error {
  constructor(code, message, hint = '') { super(message); this.exitCode = code; this.hint = hint; }
}
const errCode = { 2: 'usage', 3: 'missing-source', 4: 'check-failed', 1: 'failed' };

// ———————————————————————————— 读数据 ————————————————————————————
const abs = r => path.join(ROOT, r);
const read = r => fs.readFileSync(abs(r), 'utf8');
const isFile = r => { try { return fs.statSync(abs(r)).isFile(); } catch { return false; } };
const posix = p => p.split(path.sep).join('/');
const json = r => JSON.parse(read(r));

function need(r) {
  if (!fs.existsSync(abs(r))) throw new Fail(3, `缺少数据源 ${r}`, '这份索引从风格库快照与案例目录生成：确认在完整检出的仓库根目录运行，且没有删掉 cases/vendor 或 cases/catalog.json');
}

// 执行面检测：顺着引用读页面用到的脚本
const PATTERNS = [
  ['three.js', /from\s*['"]three['"]|\/node_modules\/three\/|three\.module\.js|\/core\/three\/|THREE\.WebGLRenderer/],
  ['WebGL', /getContext\(\s*['"](webgl2?|experimental-webgl)['"]/],
  ['Canvas2D', /getContext\(\s*['"]2d['"]/],
  ['SVG', /createElementNS\([^)]*svg|<svg[\s>]/],
  ['DOM/CSS', /preserve-3d|perspective\s*:\s*\d/],
];
function surfaces(entry, libRoot) {
  const seen = new Set(), found = new Set(), queue = [entry];
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f) || !isFile(f)) continue;
    seen.add(f);
    const src = read(f);
    for (const [name, re] of PATTERNS) if (re.test(src)) found.add(name);
    const refs = [...src.matchAll(/<script[^>]*\ssrc=["']([^"']+)["']/g), ...src.matchAll(/['"]((?:\.{1,2})?\/[^'"\s]+\.m?js)['"]/g)].map(m => m[1]);
    for (const r of refs) {
      if (/^https?:/.test(r)) continue;
      queue.push(posix(path.normalize(r.startsWith('/') ? path.join(libRoot, r) : path.join(path.dirname(f), r))));
    }
  }
  if (found.has('three.js')) found.add('WebGL');
  if (!found.size && isFile(posix(path.join(path.dirname(entry), 'tools/render.py')))) found.add('Python 合成');
  const order = ['WebGL', 'three.js', 'Canvas2D', 'SVG', 'DOM/CSS', 'Python 合成'];
  const list = order.filter(k => found.has(k));
  const text = list.filter(k => k !== 'three.js').map(k => (k === 'WebGL' && found.has('three.js') ? 'WebGL（three.js）' : k)).join(' + ') || '未检出';
  return { list, text };
}

const CORE_ABS = /['"`(]\/core\//;
const BPM = /(?:\bBPM|\bbpm|\bTEMPO|\btempo)\s*[:=]\s*(\d+(?:\.\d+)?)/g;
const cell = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const fpsOf = v => { const [a, b = '1'] = String(v || '').split('/'); const x = +a / +b; return Number.isFinite(x) && x > 0 ? +x.toFixed(3) : null; };

function lockInfo() {
  need('cases/vendor/lock.json');
  const lock = json('cases/vendor/lock.json'), out = {};
  for (const r of lock.repositories || []) {
    out[r.name] = { repository: r.repository, commit: r.commit, short: String(r.commit).slice(0, 7), files: new Map((r.files || []).map(f => [f.path, f.sha256])) };
  }
  for (const k of ['lemo-opuscar', 'sy-style-100']) if (!out[k]) throw new Fail(3, `cases/vendor/lock.json 里没有 ${k}`, '风格库快照的锁文件不完整：不要手改 lock.json，按 cases/vendor/README.md 的流程重新导入快照');
  return out;
}

// 我们那部（cases/catalog.json）的页面信息
function caseInfo(c) {
  const pages = c.files.filter(f => /\.(html|js|mjs)$/.test(f.path) && !f.path.startsWith('tools/') && f.source);
  let core = false;
  for (const f of pages) if (CORE_ABS.test(read(`cases/${f.source}`))) { core = true; break; }
  const bpm = new Set();
  for (const f of c.files) {
    if (!f.source || !/\.(js|mjs|py|json)$/.test(f.path)) continue;
    for (const m of read(`cases/${f.source}`).matchAll(BPM)) { const v = +m[1]; if (v >= 40 && v <= 220) bpm.add(v); }
  }
  const master = (c.artifacts || []).find(a => a.role === 'master' && a.video) || (c.artifacts || []).find(a => a.video);
  const v = master?.video;
  const acceptance = c.creativeAcceptance?.status || c.acceptance?.status || null;   // 目录将来补认可字段时直接读出；现在没有
  return {
    id: c.id, title: c.title, status: c.status, acceptance,
    entry: `cases/entries/${c.id}.md`, poster: c.poster ? `cases/${c.poster}` : null,
    preview: c.preview ? { url: c.preview.url, duration: c.preview.duration ?? null } : null,
    master: v ? { file: master.filename, width: v.width, height: v.height, fps: fpsOf(v.fps), frames: +v.frames || null, duration: v.duration ?? null } : null,
    selfContained: !core, needs: core ? ['/core/'] : [],
    tempo: { bpm: [...bpm].sort((a, b) => a - b), fps: v ? fpsOf(v.fps) : null },
  };
}

function firstSentence(md) {
  const q = (md.split('\n').find(l => l.startsWith('> ')) || '').slice(2).trim();
  return q.split(/(?<=[.!?])\s/)[0];
}
function section(md, n) {
  const lines = md.split('\n'), i = lines.findIndex(l => new RegExp(`^## ${n}\\.`).test(l));
  if (i < 0) return '';
  const out = [];
  for (let k = i + 1; k < lines.length && !/^## /.test(lines[k]); k++) out.push(lines[k]);
  return out.join('\n').trim();
}

export function collect() {
  for (const r of ['cases/catalog.json', 'cases/references.json', `${SY_DIR}/comp/meta.js`, `${SY_DIR}/docs/STYLES.md`, `${LEMO_DIR}/styles`]) need(r);
  const lock = lockInfo(), problems = [];
  const catalog = json('cases/catalog.json'), refs = json('cases/references.json');
  const caseById = new Map(catalog.cases.map(c => [c.id, c]));
  const lemo = lock['lemo-opuscar'], sy = lock['sy-style-100'];
  const inLock = (lib, rel, what) => { if (!lib.files.has(rel)) problems.push(`${what}：${rel} 不在 cases/vendor/lock.json 的文件清单里（快照与锁不一致）`); };
  const libs = [
    { id: 'lemo', name: 'lemo-opuscar', repository: lemo.repository, commit: lemo.commit, license: 'MIT', author: 'LemoLab', path: LEMO_DIR,
      guides: ['DIRECTOR.md', 'TECHNIQUE.md', 'MY-STYLES.md'].map(f => `${LEMO_DIR}/${f}`).filter(isFile) },
    { id: 'sy', name: 'sy-style-100', repository: sy.repository, commit: sy.commit, license: 'MIT', author: '肖雄 XIAOXIONG', path: SY_DIR,
      guides: ['README.md', 'SKILL.md', 'docs/STYLES.md'].map(f => `${SY_DIR}/${f}`).filter(isFile) },
  ];
  for (const l of libs) {
    const lic = `${l.path}/LICENSE`;
    if (!isFile(lic) || !/MIT License/i.test(read(lic))) problems.push(`${lic}：缺失或不是 MIT 许可文本（索引写的是 MIT，要与许可证一致）`);
  }

  // —— Lemo 66 种 ——
  const exBySlug = new Map(refs.examples.filter(e => e.repository === 'lemo').map(e => [e.id, e]));
  // 按库内编号排（L-01、L-02…），类别按第一次出现的顺序成节
  const slugs = fs.readdirSync(abs(`${LEMO_DIR}/styles`)).filter(d => !d.startsWith('_') && isFile(`${LEMO_DIR}/styles/${d}/style.json`))
    .map(d => [json(`${LEMO_DIR}/styles/${d}/style.json`).num, d]).sort((a, b) => String(a[0]).localeCompare(String(b[0])) || a[1].localeCompare(b[1])).map(x => x[1]);
  const styles = [];
  for (const slug of slugs) {
    const dir = `${LEMO_DIR}/styles/${slug}`, sj = json(`${dir}/style.json`), styleMd = `${dir}/STYLE.md`, demo = `${dir}/demo/index.html`;
    inLock(lemo, `styles/${slug}/style.json`, `L-${sj.num}`);
    if (!isFile(styleMd)) problems.push(`${styleMd} 缺失`);
    const md = isFile(styleMd) ? read(styleMd) : '';
    const sf = surfaces(demo, LEMO_DIR);
    const local = exBySlug.get(slug)?.localCase || null;
    let ours = null;
    if (local) {
      const c = caseById.get(local);
      if (!c) problems.push(`cases/references.json 说 ${slug} 的本机案例是 ${local}，但 cases/catalog.json 里没有这条`);
      else {
        if (c.upstreamStyle && c.upstreamStyle !== slug) problems.push(`${local} 的 upstreamStyle 是 ${c.upstreamStyle}，与风格 ${slug} 对不上`);
        ours = caseInfo(c);
      }
    }
    const pit = section(md, 9).split('\n').filter(l => l.startsWith('- ')).map(l => l.slice(2).trim());
    const selfContained = ours ? ours.selfContained : !surfacesUseCore(demo);
    styles.push({
      id: `lemo/${slug}`, code: `L-${sj.num}`, library: 'lemo', upstreamPath: `styles/${slug}`,
      name: { zh: sj.cn, en: sj.en }, category: { zh: sj.category_cn || '', en: sj.category_en || '' },
      uses: sj.uses || [], line: { zh: sj.line_cn || '', en: sj.line || '' }, essence: firstSentence(md),
      pitfalls: pit.slice(0, 3),
      surfaces: sf.list.filter(k => k !== 'three.js').concat(sf.list.includes('three.js') ? ['three.js'] : []), surfaceText: sf.text,
      contract: 'render(t)', renderer: selfContained ? 'engine-render' : 'lemo-core', selfContained,
      needs: selfContained ? [] : ['/core/'], systemFonts: [],
      tempo: ours?.tempo || null, maturity: ours ? 'made' : 'demo',
      case: ours,
      upstreamDemo: { duration: sj.dur ?? null },
      method: { style: styleMd, demo: isFile(demo) ? demo : null },
      gpuEnv: selfContained ? ['BEIMING_ANGLE'] : ['LEMO_ANGLE'],
      source: `lemo-opuscar@${lemo.short}`, license: 'MIT',
    });
  }

  // —— SY 20 种 ——
  const metaSrc = read(`${SY_DIR}/comp/meta.js`);
  const metas = [...metaSrc.matchAll(/\{\s*id:\s*'(\d+)',\s*dir:\s*'([^']+)',\s*zh:\s*\[([^\]]*)\],\s*en:\s*'([^']+)'[\s\S]*?desc:\s*'([^']*)',\s*tags:\s*\[([^\]]*)\]/g)]
    .map(m => ({ id: m[1], dir: m[2], zh: [...m[3].matchAll(/'([^']+)'/g)].map(x => x[1]).join(' · '), en: m[4], desc: m[5], tags: [...m[6].matchAll(/'([^']+)'/g)].map(x => x[1]) }));
  const syDoc = {};
  for (const line of read(`${SY_DIR}/docs/STYLES.md`).split('\n')) {
    const m = /^\|\s*(\d{2})\s*\|[^|]*\|\s*([^|]*)\|\s*([^|]*)\|/.exec(line);
    if (m) syDoc[m[1]] = { scene: m[2].trim(), tech: m[3].trim() };
  }
  if (metas.length !== 20) problems.push(`SY 的 comp/meta.js 读出 ${metas.length} 种，应为 20 种（格式变了就改本工具的解析）`);
  for (const s of metas) {
    const entry = `${SY_DIR}/styles/${s.dir}/index.html`;
    inLock(sy, `styles/${s.dir}/index.html`, `SY-${s.id}`);
    const page = isFile(entry) ? read(entry) : '';
    if (page && !/Reel\.scene\s*\(/.test(page)) problems.push(`${entry} 里没找到 Reel.scene(...)：SY 页面契约变了，"页面契约"一列要重新核对`);
    const sf = surfaces(entry, SY_DIR);
    const fonts = [...new Set([...page.matchAll(/px\s+\\?["']([^"'\\]+)\\?["']/g), ...page.matchAll(/px\s+([A-Z][A-Za-z]+)\b/g)].map(m => m[1].trim())
      .concat([...page.matchAll(/font-family\s*:\s*([^;"]+)/g)].flatMap(m => m[1].split(',').map(x => x.replace(/['"]/g, '').trim())))
      .filter(f => f && !/^(serif|sans-serif|monospace|system-ui|cursive|fantasy|inherit)$/i.test(f) && /^[A-Za-z][\w .-]*$/.test(f)))].sort();
    const fps = +(/fps\s*:\s*(\d+(?:\.\d+)?)/.exec(page)?.[1] || 30), dur = +(/duration\s*:\s*(\d+(?:\.\d+)?)/.exec(page)?.[1] || 0) || null;
    const bpm = [...(syDoc[s.id]?.tech || '').matchAll(/(\d+)\s*BPM/gi)].map(m => +m[1]);
    styles.push({
      id: `sy/${s.dir}`, code: `SY-${s.id}`, library: 'sy', upstreamPath: `styles/${s.dir}`,
      name: { zh: s.zh, en: s.en }, category: { zh: '', en: '' }, uses: [], tags: s.tags,
      line: { zh: syDoc[s.id]?.scene || s.desc, en: '' }, essence: syDoc[s.id]?.tech || '', pitfalls: [],
      surfaces: sf.list.filter(k => k !== 'three.js').concat(sf.list.includes('three.js') ? ['three.js'] : []), surfaceText: sf.text,
      contract: '__seek(t)', renderer: 'sy-render', selfContained: true, needs: [], systemFonts: fonts,
      tempo: { bpm, fps }, maturity: 'method', case: null, upstreamDemo: { duration: dur },
      method: { style: `${SY_DIR}/docs/STYLES.md`, demo: entry, readme: isFile(`${SY_DIR}/styles/${s.dir}/README.md`) ? `${SY_DIR}/styles/${s.dir}/README.md` : null },
      gpuEnv: ['HWGPU', 'BEIMING_ANGLE'],
      source: `sy-style-100@${sy.short}`, license: 'MIT',
    });
  }

  // 互相核对：Lemo 66 种都要有本机案例，案例与风格一一对应
  const lemoRows = styles.filter(s => s.library === 'lemo');
  const madeCases = new Set(lemoRows.filter(s => s.case).map(s => s.case.id));
  const styleCases = catalog.cases.filter(c => c.group === 'styles');
  for (const c of styleCases) if (!madeCases.has(c.id)) problems.push(`cases/catalog.json 的风格实验 ${c.id}（upstreamStyle ${c.upstreamStyle}）没有对应到任何一式`);
  const ids = new Set();
  for (const s of styles) { if (ids.has(s.id)) problems.push(`编号重复：${s.id}`); ids.add(s.id); }
  for (const s of styles) for (const f of [s.method.style, s.method.demo, s.case?.entry, s.case?.poster].filter(Boolean)) if (!isFile(f)) problems.push(`${s.id} 引用的 ${f} 不存在`);
  return { libs, styles, problems, counts: { lemo: lemoRows.length, sy: styles.length - lemoRows.length, made: madeCases.size } };
}

function surfacesUseCore(demo) {
  // 没有本机案例时（现在没有这种情况）退回看上游示例页本身
  if (!isFile(demo)) return false;
  const dir = path.dirname(demo);
  return fs.readdirSync(abs(dir)).filter(f => /\.(html|js|mjs)$/.test(f)).some(f => CORE_ABS.test(read(`${dir}/${f}`)));
}

// ———————————————————————————— 写表 ————————————————————————————
const RENDERER = {
  'engine-render': '`engine/render`',
  'lemo-core': 'Lemo `core/render`',
  'sy-render': 'SY `render.js`',
};
const MATURITY = { made: '做过', demo: '上游示例', method: '方法' };
const link = (text, target) => `[${text}](../../${target})`;
function oursCell(s) {
  if (!s.case) return '—';
  const c = s.case, st = c.status === 'historical-render' ? '历史出片' : c.status;
  return `${link(`\`${c.id}\``, c.entry)} · ${st} · ${c.acceptance ? `认可 ${c.acceptance}` : '认可未记录'}`;
}
function previewCell(s) {
  const bits = [];
  if (s.case?.poster) bits.push(link('图', s.case.poster));
  if (s.case?.preview?.url) bits.push(`[片](${s.case.preview.url})`);
  const d = s.case?.master?.duration ?? s.upstreamDemo.duration;
  if (d) bits.push(`${(+d).toFixed(1)} s`);
  return bits.join(' · ') || '—';
}
function tempoCell(s) {
  const t = s.tempo; if (!t) return '—';
  const b = t.bpm?.length ? `${t.bpm.join('/')} BPM` : '';
  return [b, t.fps ? `${t.fps} fps` : ''].filter(Boolean).join(' · ') || '—';
}
function usesCell(s) {
  if (s.library === 'lemo') return `${s.category.zh}：${s.uses.join(', ')}`;
  return `（上游未标题材）画面：${(s.line.zh.split(/(?<=[。！？])/)[0] || '').trim()}`;
}
function gpuCell(s) {
  if (s.library === 'sy') return '`HWGPU=1`（默认软件渲染）；适配页 `BEIMING_ANGLE`';
  return `\`${s.gpuEnv[0]}\``;
}
function methodCell(s) {
  const bits = [link('STYLE', s.method.style)];
  if (s.method.demo) bits.push(link('示例', s.method.demo));
  if (s.method.readme) bits.push(link('说明', s.method.readme));
  return bits.join(' · ');
}
const HEAD = '| 编号 | 风格 | 题材 | 节奏 | 执行面 | 契约 · 历史渲染器 | 自包含 | 成熟度 | 本仓库成片 · 认可 | 预览 · 时长 | 来源 · 许可 | GPU 变量 | 方法 |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|';
const ROW = s => `| \`${s.id}\`（${s.code}） | ${cell(`${s.name.zh}（${s.name.en}）`)} | ${cell(usesCell(s))} | ${tempoCell(s)} | ${s.surfaceText} | \`${s.contract}\` · ${RENDERER[s.renderer]} | ${s.selfContained ? '是' : '否（`/core/`）'} | ${MATURITY[s.maturity]} | ${oursCell(s)} | ${previewCell(s)} | ${s.source} · ${s.license} | ${gpuCell(s)} | ${methodCell(s)} |`;

export function render(data) {
  const { libs, styles, counts } = data;
  const lemo = styles.filter(s => s.library === 'lemo'), sy = styles.filter(s => s.library === 'sy');
  const cats = [...new Set(lemo.map(s => s.category.zh))];
  const tally = rows => {
    const n = k => rows.filter(r => r.surfaces.includes(k)).length;
    return [['Canvas2D', n('Canvas2D')], ['WebGL', n('WebGL')], ['SVG', n('SVG')], ['DOM/CSS', n('DOM/CSS')], ['Python 合成', n('Python 合成')]]
      .filter(([, v]) => v).map(([k, v]) => (k === 'WebGL' && n('three.js') ? `WebGL ${v}（其中 three.js ${n('three.js')}）` : `${k} ${v}`)).join('，');
  };
  const byRenderer = rows => Object.entries(rows.reduce((m, r) => ((m[r.renderer] = (m[r.renderer] || 0) + 1), m), {})).map(([k, v]) => `${RENDERER[k]} ${v}`).join('，');
  const L = libs.find(l => l.id === 'lemo'), S = libs.find(l => l.id === 'sy');
  const md = `# 北冥代码动画风格 · 86 式：风格索引

> 本文件由 \`node tools/c-styles.mjs\` 生成，**不要手改**；快照或案例目录变了就重跑，\`node tools/c-styles.mjs --check\` 校验是否最新。机器可读版本：[styles.json](styles.json)。按题材找候选：\`node tools/c-styles.mjs find <关键词…>\`。

共 **${styles.length}** 式，全部来自两套第三方 MIT 风格库的固定快照：Lemo 风格库 ${counts.lemo} 种（[\`${L.path}\`](../../${L.path}/)，${L.name}@${L.commit.slice(0, 7)}，MIT，${L.author}）＋ SY 风格库 ${counts.sy} 种（[\`${S.path}\`](../../${S.path}/)，${S.name}@${S.commit.slice(0, 7)}，MIT，${S.author}）。"86 式"是索引的名字，画法本身不是我们原创：作品用到哪一式，署名里写"<风格名>，方法来自 <库>@<提交>（MIT）"。其中 ${counts.made} 式我们按它做过风格实验、有历史成片（[cases/](../../cases/README.md)）。两套库的导演与技术手册：${L.guides.map(g => link(path.basename(g), g)).join('、')}（Lemo）；${S.guides.map(g => link(path.basename(g), g)).join('、')}（SY）。

## 怎么读这张表

- **编号**：\`lemo/<目录>\`、\`sy/<目录>\` 是稳定 id（与 styles.json、上游目录名一致）；括号里是库内编号。
- **题材**：Lemo 取 \`style.json\` 的类别与 \`uses\`（上游原文）；SY 取 \`comp/meta.js\` 的标签。按题材查用 \`find\`，它还会搜画面描述与开篇一句。
- **节奏**：我们那部成片源码里写的速度与成片帧率（多个速度 = 多个段落）；SY 是页面声明的帧率与"技术"栏里写的速度。新片照抄速度时要换算成每拍整帧。
- **执行面**：从示例入口顺着 \`<script src>\` / \`import\` 读到的源码里检测 Canvas 2D、WebGL、three.js、SVG、CSS 3D。是启发式结论：画面主体常常只在其中一种上，落地前打开示例源码确认。
- **契约 · 历史渲染器**：\`render(t)\` = \`window.DUR\` / \`render(t)\` / \`READY\`，与北冥 \`engine/render\` 的页面约定相同；\`__seek(t)\` = SY 的 \`Reel.scene\` 契约（加 \`?render=1\` 后暴露 \`window.__seek\` / \`__duration\` / \`__fps\`）。\`engine/render\` = 页面自包含，素材齐全（\`restore --download\`）时可直接用北冥渲染器；Lemo \`core/render\` = 页面用了 \`/core/\` 绝对路径，只能在 Lemo 库根目录下服务，用 \`node tools/c-runtime.mjs build <还原目录>\` 复刻；SY \`render.js\` = SY 自带渲染器，或 \`node tools/c-runtime.mjs sy <编号>\` 生成适配页后用 \`engine/render\`。
- **自包含**：看我们那部成片的页面源码（\`tools/\` 除外）有没有 \`/core/\` 绝对路径。
- **成熟度**：做过 = 我们按这一式出过片，可以照历史源码复刻、拿来对照；方法 = 只有上游示例页与说明，我们没出过片。
- **本仓库成片 · 认可**：历史出片只说明"出过片"；案例目录里没有用户认可记录的写"认可未记录"——不要写成"已认可"。
- **GPU 变量**：在哪个渲染器里选 GPU 后端：\`BEIMING_ANGLE\`（engine/render）、\`LEMO_ANGLE\`（Lemo core/render）、\`HWGPU=1\` 或 \`--hwgpu\`（SY render.js，默认 SwiftShader 软件渲染，WebGL 风格极慢）。
- **许可**：两套库都是 MIT：只读源码学方法；要搬代码就保留原作者版权与许可声明、在作品 CREDITS 写明来源（规则见 [THIRD-PARTY.md](../../THIRD-PARTY.md)）。\`cases/vendor/\` 是固定快照，不改。

${cats.map(cat => {
    const rows = lemo.filter(s => s.category.zh === cat);
    return `## Lemo 风格库 · ${cat}（${rows.length} 种）\n\n${HEAD}\n${rows.map(ROW).join('\n')}`;
  }).join('\n\n')}

## SY 风格库（${sy.length} 种）

SY 的页面用本机字体名（${[...new Set(sy.flatMap(s => s.systemFonts))].join('、') || '无'}），字体不随库分发：换一台机器字形就变，复刻或取方法时换成作品目录里带许可的字体子集。

${HEAD}
${sy.map(ROW).join('\n')}

## 统计

- Lemo：执行面 ${tally(lemo)}；历史渲染器 ${byRenderer(lemo)}
- SY：执行面 ${tally(sy)}；历史渲染器 ${byRenderer(sy)}
- 成熟度：${Object.entries(styles.reduce((m, r) => ((m[MATURITY[r.maturity]] = (m[MATURITY[r.maturity]] || 0) + 1), m), {})).map(([k, v]) => `${k} ${v} 式`).join('，')}
`;
  // 每式一行（紧凑、改一式只动一行），头部字段照常缩进
  const head = { schemaVersion: 1, generatedBy: 'tools/c-styles.mjs',
    note: '由 node tools/c-styles.mjs 生成，不要手改；字段含义见 routes/c-style/STYLES.md 的"怎么读这张表"', libraries: libs, counts };
  const top = JSON.stringify(head, null, 1).replace(/\n\}$/, '');
  const rows = styles.map(s => ' ' + JSON.stringify({ ...s, surfaceText: undefined }));
  return { md, json: `${top},\n "styles": [\n${rows.join(',\n')}\n ]\n}\n` };
}

// ———————————————————————————— 查候选 ————————————————————————————
const TECH = { canvas2d: 'Canvas2D', webgl: 'WebGL', svg: 'SVG', dom: 'DOM/CSS', three: 'three.js' };
export function find(styles, words, { tech = null, contract = null, made = false, top = 5 } = {}) {
  const toks = words.flatMap(w => String(w).toLowerCase().split(/[\s,，、]+/)).filter(Boolean);
  const fields = s => [
    [3, s.uses.join(' ') + ' ' + (s.tags || []).join(' ')],
    [2, `${s.name.zh} ${s.name.en} ${s.category.zh} ${s.category.en}`],
    [1, `${s.line.zh} ${s.line.en} ${s.essence}`],
  ];
  const rows = [];
  for (const s of styles) {
    if (tech && !s.surfaces.includes(TECH[tech])) continue;
    if (contract && s.contract !== (contract === 'seek' ? '__seek(t)' : 'render(t)')) continue;
    if (made && s.maturity !== 'made') continue;
    let score = 0; const hit = [];
    for (const t of toks) {
      for (const [w, text] of fields(s)) if (text.toLowerCase().includes(t)) { score += w; hit.push(t); break; }
    }
    if (toks.length && !score) continue;
    score += s.maturity === 'made' ? 0.5 : 0;
    rows.push({ id: s.id, code: s.code, name: `${s.name.zh}（${s.name.en}）`, score: +score.toFixed(2), matched: [...new Set(hit)],
      uses: s.library === 'lemo' ? s.uses : s.tags, surfaces: s.surfaces, contract: s.contract, renderer: s.renderer,
      case: s.case ? { id: s.case.id, status: s.case.status, acceptance: s.case.acceptance } : null, source: s.source, method: s.method.style });
  }
  rows.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return rows.slice(0, top);
}

// ———————————————————————————— 命令行 ————————————————————————————
function parse(argv) {
  const o = { cmd: 'write', json: false, help: false, words: [], tech: null, contract: null, made: false, top: 5 };
  const a = [...argv];
  if (a[0] === 'find') { o.cmd = 'find'; a.shift(); }
  while (a.length) {
    const x = a.shift();
    if (x === '--json') o.json = true;
    else if (x === '--help' || x === '-h') o.help = true;
    else if (x === '--check') { if (o.cmd === 'find') throw new Fail(2, 'find 不接受 --check'); o.cmd = 'check'; }
    else if (x === '--made') o.made = true;
    else if (x === '--tech' || x === '--contract' || x === '--top') {
      const v = a.shift();
      if (v === undefined || v.startsWith('--')) throw new Fail(2, `选项 ${x} 缺少取值`);
      if (x === '--tech') { if (!TECH[v.toLowerCase()]) throw new Fail(2, `--tech 只能是 ${Object.keys(TECH).join(' / ')}（收到 ${v}）`); o.tech = v.toLowerCase(); }
      if (x === '--contract') { if (!['render', 'seek'].includes(v)) throw new Fail(2, `--contract 只能是 render 或 seek（收到 ${v}）`); o.contract = v; }
      if (x === '--top') { if (!/^\d+$/.test(v) || +v < 1) throw new Fail(2, `--top 要正整数（收到 ${v}）`); o.top = +v; }
    } else if (x.startsWith('-')) throw new Fail(2, `不认识的选项 ${x}`);
    else if (o.cmd === 'find') o.words.push(x);
    else throw new Fail(2, `多余的参数 ${x}（查候选要写成 find <关键词…>）`);
  }
  if (o.cmd !== 'find' && (o.tech || o.contract || o.made || o.top !== 5)) throw new Fail(2, '--tech / --contract / --made / --top 只用于 find');
  return o;
}

const sha256 = async buf => (await import('crypto')).createHash('sha256').update(buf).digest('hex');

async function main(argv) {
  const env = { ok: true, exitCode: 0, command: `c-styles ${argv.join(' ')}`.trim(), error: null, outputs: [], runJson: null, warnings: [] };
  let o;
  try {
    o = parse(argv);
    if (o.help) { process.stdout.write(USAGE + '\n'); return 0; }
    const data = collect();
    if (o.cmd === 'find') {
      const res = find(data.styles, o.words, o);
      env.result = res;
      if (!o.json) {
        if (!res.length) console.log('没有匹配的风格：换个说法（中英文都试试），或去掉 --tech / --contract / --made');
        for (const [i, r] of res.entries()) {
          console.log(`${i + 1}. ${r.id}（${r.code}）${r.name}  分 ${r.score}  命中：${r.matched.join('、') || '—'}`);
          console.log(`   题材：${r.uses.join(', ')}；执行面：${r.surfaces.join(' + ')}；${r.contract} · ${RENDERER[r.renderer].replace(/`/g, '')}；${r.case ? `我们做过 ${r.case.id}（${r.case.status}，认可${r.case.acceptance || '未记录'}）` : '我们没出过片'}`);
          console.log(`   方法：${r.method}（${r.source}，MIT）`);
        }
      }
    } else {
      const { md, json: js } = render(data);
      if (data.problems.length) {
        throw Object.assign(new Fail(4, `数据有 ${data.problems.length} 处矛盾：\n  - ${data.problems.join('\n  - ')}`, '先按提示核对快照（cases/vendor/lock.json）与案例目录（cases/catalog.json），矛盾不消除就不生成索引'), { problems: data.problems });
      }
      const targets = [[OUT_MD, md, 'styles-index'], [OUT_JSON, js, 'styles-json']];
      if (o.cmd === 'check') {
        const stale = targets.filter(([f, txt]) => !fs.existsSync(abs(f)) || fs.readFileSync(abs(f), 'utf8') !== txt).map(([f]) => f);
        if (stale.length) throw new Fail(4, `${stale.join('、')} 不是最新（与快照或案例目录不一致）`, '运行 node tools/c-styles.mjs 重新生成，再提交生成物；不要手改');
        for (const [f, txt, kind] of targets) env.outputs.push({ path: f, sha256: await sha256(txt), kind });
        if (!o.json) console.log(`${OUT_MD} 与 ${OUT_JSON} 已是最新（${data.styles.length} 式：Lemo ${data.counts.lemo} + SY ${data.counts.sy}，做过 ${data.counts.made}）`);
      } else {
        for (const [f, txt, kind] of targets) {
          fs.mkdirSync(path.dirname(abs(f)), { recursive: true });
          fs.writeFileSync(abs(f), txt);
          env.outputs.push({ path: f, sha256: await sha256(txt), kind });
        }
        if (!o.json) console.error(`写入 ${OUT_MD}、${OUT_JSON}：${data.styles.length} 式（Lemo ${data.counts.lemo} + SY ${data.counts.sy}），做过 ${data.counts.made}`);
      }
    }
  } catch (e) {
    const code = e instanceof Fail ? e.exitCode : 1;
    env.ok = false; env.exitCode = code;
    env.error = { code: errCode[code] || 'failed', message: e.message, hint: e.hint || '' };
    if (!o?.json) { console.error(`c-styles：${e.message}`); if (e.hint) console.error(`下一步：${e.hint}`); if (code === 2) console.error(USAGE); }
  }
  if (o?.json || (!o && argv.includes('--json'))) process.stdout.write(JSON.stringify(env) + '\n');
  return env.exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exitCode = await main(process.argv.slice(2));
