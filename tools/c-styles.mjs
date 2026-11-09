// 生成 routes/c-style/STYLES.md：北冥代码动画风格 · 86 式的风格索引（SY 20 种 + Lemo 66 种）。
//   node tools/c-styles.mjs            重写 routes/c-style/STYLES.md
//   node tools/c-styles.mjs --check    只比对，不一致时退出码 1（文件是生成物，别手改）
// 数据来源（全部只读）：
//   cases/vendor/sy-style-100/comp/meta.js 与 docs/STYLES.md        SY 20 种的编号、名称、"技术"一栏
//   cases/vendor/lemo-opuscar/styles/<slug>/style.json 与 STYLE.md   Lemo 66 种的名称、分类、开篇一句
//   cases/references.json 与 cases/catalog.json                     我们做过的作品（localCase）、预览图、预览视频
// 执行面是"按示例源码检测"：从示例入口 index.html 出发，顺着 <script src> 与 import 把引用到的 .js 全读一遍，
// 用正则找 getContext('2d' / 'webgl')、three.js、SVG、CSS 3D；是启发式结论，落地前读源码确认。
// 输出不含时间戳，同一份快照重跑结果逐字节一致。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SY = path.join(ROOT, 'cases/vendor/sy-style-100'), LEMO = path.join(ROOT, 'cases/vendor/lemo-opuscar');
const OUT = path.join(ROOT, 'routes/c-style/STYLES.md');
const rel = p => path.relative(ROOT, p).split(path.sep).join('/');
const read = p => fs.readFileSync(p, 'utf8');
const exists = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };

// —— 执行面检测：顺着引用读页面用到的脚本 ——
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
    if (seen.has(f) || !exists(f)) continue;
    seen.add(f);
    const src = read(f);
    for (const [name, re] of PATTERNS) if (re.test(src)) found.add(name);
    // <script src>、静态 import、以及任何写成字符串的脚本路径（覆盖 import(cond ? './a.js' : './b.js') 这类动态加载）
    const refs = [...src.matchAll(/<script[^>]*\ssrc=["']([^"']+)["']/g), ...src.matchAll(/['"]((?:\.{1,2})?\/[^'"\s]+\.m?js)['"]/g)].map(m => m[1]);
    for (const r of refs) {
      if (/^https?:/.test(r)) continue;
      queue.push(r.startsWith('/') ? path.join(libRoot, r) : path.resolve(path.dirname(f), r));
    }
  }
  if (found.has('three.js')) found.add('WebGL');
  // 页面不画画面、由 Python 逐帧合成的作品（如 city-symphony：页面只给 readcheck 暴露文字）
  if (!found.size && exists(path.join(path.dirname(entry), 'tools/render.py'))) found.add('Python 合成');
  const order = ['WebGL', 'three.js', 'Canvas2D', 'SVG', 'DOM/CSS', 'Python 合成'];
  const list = order.filter(k => found.has(k));
  const shown = list.filter(k => k !== 'three.js').map(k => (k === 'WebGL' && found.has('three.js') ? 'WebGL（three.js）' : k));
  return { list, text: shown.join(' + ') || '未检出', files: seen.size };
}
const advice = s => (s.list.includes('WebGL') ? '方法拿到 A 落地（要着色器 / 三维）'
  : s.list.includes('Python 合成') ? '读方法后自定（示例画面不在浏览器里）'
    : 'C 模版直接做（Canvas 2D / SVG / DOM）');

// —— 我们做过的作品 ——
const catalog = JSON.parse(read(path.join(ROOT, 'cases/catalog.json')));
const refs = JSON.parse(read(path.join(ROOT, 'cases/references.json')));
const caseById = Object.fromEntries(catalog.cases.map(c => [c.id, c]));
const ours = id => {
  const c = caseById[id]; if (!c) return '';
  const bits = [`[\`${c.id}\`](../../cases/entries/${c.id}.md)`];
  if (c.poster) bits.push(`[预览图](../../cases/${c.poster})`);
  if (c.preview?.url) bits.push(`[预览视频](${c.preview.url})`);
  return bits.join(' · ');
};
const cell = s => String(s).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

// —— SY 20 种 ——
const metaSrc = read(path.join(SY, 'comp/meta.js'));
const syMeta = [...metaSrc.matchAll(/\{\s*id:\s*'(\d+)',\s*dir:\s*'([^']+)',\s*zh:\s*\[([^\]]*)\],\s*en:\s*'([^']+)'/g)]
  .map(m => ({ id: m[1], dir: m[2], zh: [...m[3].matchAll(/'([^']+)'/g)].map(x => x[1]).join(' · '), en: m[4] }));
const syTech = {};
for (const line of read(path.join(SY, 'docs/STYLES.md')).split('\n')) {
  const m = /^\|\s*(\d{2})\s*\|[^|]*\|\s*([^|]*)\|\s*([^|]*)\|/.exec(line);
  if (m) syTech[m[1]] = { scene: m[2].trim(), tech: m[3].trim() };
}
const syRows = syMeta.map(s => {
  const entry = path.join(SY, 'styles', s.dir, 'index.html'), v2 = path.join(SY, 'vol2/styles', s.dir, 'index.html');
  const sf = surfaces(entry, SY);
  const t = syTech[s.id] || {};
  const method = [`[示例](../../${rel(entry)})`, exists(v2) ? `[第二期](../../${rel(v2)})` : '', `[说明](../../${rel(path.join(SY, 'docs/STYLES.md'))})`].filter(Boolean).join(' · ');
  return { key: `SY-${s.id}`, name: `${s.zh}（${s.en}）`, feat: t.tech || '', surf: sf.text, method, ours: '', adv: advice(sf) };
});

// —— Lemo 66 种 ——
const exByLemo = Object.fromEntries(refs.examples.filter(e => e.repository === 'lemo').map(e => [e.id, e]));
// _template 是写新风格用的空模版，不算一式
const slugs = fs.readdirSync(path.join(LEMO, 'styles')).filter(d => !d.startsWith('_') && exists(path.join(LEMO, 'styles', d, 'style.json'))).sort();
const lemoRows = slugs.map(slug => {
  const dir = path.join(LEMO, 'styles', slug), sj = JSON.parse(read(path.join(dir, 'style.json')));
  const style = path.join(dir, 'STYLE.md'), demo = path.join(dir, 'demo/index.html');
  const quote = (read(style).split('\n').find(l => l.startsWith('> ')) || '').slice(2).trim();
  const first = quote.split(/(?<=[.!?])\s/)[0];
  const sf = surfaces(demo, LEMO);
  const method = [`[STYLE](../../${rel(style)})`, exists(demo) ? `[示例](../../${rel(demo)})` : ''].filter(Boolean).join(' · ');
  const local = exByLemo[slug]?.localCase;
  return { key: `L-${sj.num}`, cat: sj.category_cn || sj.cat || '', name: `${sj.cn}（${sj.en}）`, feat: first, surf: sf.text, method, ours: local ? ours(local) : '', adv: advice(sf) };
}).sort((a, b) => a.key.localeCompare(b.key));

// —— 写表 ——
const head = '| 编号 | 风格 | 一句话特征 | 执行面（源码检测） | 方法参考 | 我们做过的作品 | 建议怎么落地 |\n|---|---|---|---|---|---|---|';
const row = r => `| ${r.key} | ${cell(r.name)} | ${cell(r.feat)} | ${r.surf} | ${r.method} | ${r.ours} | ${r.adv} |`;
const count = rows => rows.reduce((m, r) => (r.surf.split(' + ').forEach(k => { m[k] = (m[k] || 0) + 1; }), m), {});
const tally = rows => Object.entries(count(rows)).map(([k, v]) => `${k} ${v}`).join('，');
const lemoCats = [...new Set(lemoRows.map(r => r.cat))];
const total = syRows.length + lemoRows.length, made = lemoRows.filter(r => r.ours).length;

const md = `# 北冥代码动画风格 · 86 式：风格索引

> 本文件由 \`node tools/c-styles.mjs\` 从仓库内的风格库快照与案例目录生成，**不要手改**；快照或目录变了就重跑，\`--check\` 校验是否最新。

共 **${total}** 式：SY 风格库 ${syRows.length} 种（[\`cases/vendor/sy-style-100\`](../../cases/vendor/sy-style-100/)，MIT · 肖雄 XIAOXIONG）+ Lemo 风格库 ${lemoRows.length} 种（[\`cases/vendor/lemo-opuscar\`](../../cases/vendor/lemo-opuscar/)，MIT · LemoLab）。其中 ${made} 种我们自己做过风格实验，作品与预览在 [cases/](../../cases/README.md)。

怎么读这张表：

- **一句话特征**：SY 取 \`docs/STYLES.md\` 的"技术"一栏；Lemo 取各 \`STYLE.md\` 开篇引语的第一句（英文原文）。
- **执行面**：从示例入口顺着 \`<script src>\` / \`import\` 读到的源码里检测 \`getContext('2d')\`、\`getContext('webgl')\`、three.js、SVG、CSS 3D。是启发式结论：画面主体常常只在其中一种上，落地前打开示例源码确认。
- **建议怎么落地**：只用 Canvas 2D / SVG / DOM 的，用 C 模版（[routes/c-style/template](template/)）直接做；用到 WebGL / three.js 的，把方法拿到 A 路线（WebGL 三渲二，\`engine/\`）落地。这是起点建议，不是限制。
- **许可**：两套库都是 MIT，只能读源码学方法；要搬代码就保留原作者版权与许可声明，并在作品 CREDITS 里写明来源，规则见 [THIRD-PARTY.md](../../THIRD-PARTY.md)。\`cases/vendor/\` 是固定快照，不改。
- **我们做过的作品**：案例卡、预览图与预览视频。"存在成片"不等于"已获认可"，以案例卡的状态为准。

## SY 风格库 · 20 种

执行面统计：${tally(syRows)}。

${head}
${syRows.map(row).join('\n')}

${lemoCats.map(cat => {
  const rows = lemoRows.filter(r => r.cat === cat);
  return `## Lemo 风格库 · ${cat}（${rows.length} 种）\n\n${head}\n${rows.map(row).join('\n')}`;
}).join('\n\n')}

## 统计

- SY：${tally(syRows)}
- Lemo：${tally(lemoRows)}
- 落地建议：${Object.entries([...syRows, ...lemoRows].reduce((m, r) => ((m[r.adv] = (m[r.adv] || 0) + 1), m), {})).map(([k, v]) => `${k} ${v} 种`).join('；')}
`;

if (process.argv.includes('--check')) {
  const cur = exists(OUT) ? read(OUT) : '';
  if (cur !== md) { console.error(`${rel(OUT)} 不是最新：运行 node tools/c-styles.mjs 重新生成`); process.exit(1); }
  console.log(`${rel(OUT)} 已是最新（${total} 式）`);
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, md);
  console.log(`写入 ${rel(OUT)}：${total} 式（SY ${syRows.length} + Lemo ${lemoRows.length}），我们做过 ${made} 种`);
}
