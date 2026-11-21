// 北冥仓库 · A / C 路线 `--backend webgpu` 同源作品脚手架（由 tools/new-film.mjs 在内存阶段调用，不改动受金标准保护的路线模版目录）：
//   applyWebgpuScaffold(root, routeId, files) → files
//     A 路线：保留模版的 sound.py 与 film.json 时间/画风骨架，切换 backend = "webgpu"、entry = "offscreen.mjs"，
//            注入基于 engine/offscreen 同源接口的多镜头 TSL 作品文件（offscreen.mjs / story.js / world.js / title.js / shots/s1.js / shots/s2.js / README.md）；
//     C 路线：保留模版的节拍时间表与水墨/宣纸/钤印模块（timeline.js / film.js / brush.js / paper.js / seal.js / mix.py），
//            切换 backend = "webgpu"、entry = "offscreen.mjs"，替换为跨端同源 type.js 与 createCanvasFilm 入口 offscreen.mjs。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEBGPU_A_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'webgpu-a');

const C_ISO_TYPE_JS = `// 字体：浏览器（Chrome WebGPU 预览）与 Node + Dawn（离屏出片）同源登记、按码位按需加载与缺字核对。
import { IS_NODE, readJson, registerCanvasFontsIso, rangeCoversAny } from '../../engine/offscreen/io.mjs';

const PROBE = ' ·probe';
let measureCtx = null;
let specsCache = [];
const manifestChunks = new Map();

const cssUrl = u => \`url("\${String(u).replace(/["\\\\]/g, '\\\\$&')}")\`;

function addBrowserFace(family, url, desc) {
  for (const [fam, extra] of [[family, {}], [family + PROBE, { sizeAdjust: '50%' }]]) {
    globalThis.document.fonts.add(new globalThis.FontFace(fam, cssUrl(url), { display: 'block', ...desc, ...extra }));
  }
}

export async function registerFonts(specs) {
  specsCache = Array.isArray(specs) ? [...specs] : [];
  manifestChunks.clear();
  if (IS_NODE) {
    const base = new globalThis.URL('./', import.meta.url);
    for (const s of specsCache) {
      if (!s?.family) throw new Error('registerFonts：每项字体必须给 family');
      if (s.manifest) {
        const m = await readJson(s.manifest, base);
        manifestChunks.set(s.family, m.chunks || []);
      } else if (!s.src) {
        throw new Error(\`字体 \${s.family} 要写 src（一个字体文件）或 manifest（分片清单）\`);
      }
    }
    return;
  }
  const baseUri = new globalThis.URL('./', import.meta.url).href;
  for (const s of specsCache) {
    if (s.manifest) {
      const at = new globalThis.URL(s.manifest, baseUri);
      const r = await globalThis.fetch(at);
      if (!r.ok) throw new Error(\`字体清单载不到：\${s.manifest}（HTTP \${r.status}）\`);
      const m = await r.json();
      for (const c of m.chunks) addBrowserFace(s.family, new globalThis.URL(c.file, at).href, { weight: String(m.weight ?? 400), style: m.style ?? 'normal', unicodeRange: c.unicodeRange });
    } else if (s.src) {
      addBrowserFace(s.family, new globalThis.URL(s.src, baseUri).href, { weight: String(s.weight ?? 400) });
    } else throw new Error(\`字体 \${s.family} 要写 src（一个字体文件）或 manifest（分片清单）\`);
  }
}

export async function loadGlyphs(text, families, weight = 400) {
  const t = [...new Set([...String(text || '')])].join('') || ' ';
  if (IS_NODE) {
    const active = specsCache.filter(s => !families?.length || families.includes(s.family));
    await registerCanvasFontsIso(active, { base: new globalThis.URL('./', import.meta.url), glyphs: t });
    return;
  }
  for (const fam of families) {
    for (const f of [fam, fam + PROBE]) {
      try { await globalThis.document.fonts.load(\`\${weight} 64px "\${f}"\`, t); }
      catch (e) { throw new Error(\`字体 \${fam} 载不下来（\${(e && e.message) || e}）\`); }
    }
  }
}

const glyphWidth = (font, ch) => {
  measureCtx ??= globalThis.document.createElement('canvas').getContext('2d');
  measureCtx.font = font;
  return measureCtx.measureText(ch).width;
};

export function missingGlyphs(text, family, weight = 400) {
  const miss = [];
  if (IS_NODE) {
    const chunks = manifestChunks.get(family);
    if (chunks) {
      for (const ch of new Set([...String(text || '')])) {
        if (/\\s/u.test(ch)) continue;
        const cp = ch.codePointAt(0);
        const covered = chunks.some(c => rangeCoversAny(c.unicodeRange, [cp]));
        if (!covered) miss.push(ch);
      }
      return miss;
    }
    return miss;
  }
  for (const ch of new Set([...String(text || '')])) {
    if (/\\s/u.test(ch)) continue;
    const a = glyphWidth(\`\${weight} 64px "\${family}", serif\`, ch);
    const b = glyphWidth(\`\${weight} 64px "\${family + PROBE}", serif\`, ch);
    if (Math.abs(a - b) < 0.25) miss.push(ch);
  }
  return miss;
}

export function pickFont(text, families, weight = 400) {
  const tried = families.map(family => ({ family, missing: missingGlyphs(text, family, weight) }));
  const full = tried.find(f => !f.missing.length);
  const best = full || tried.reduce((a, b) => (b.missing.length < a.missing.length ? b : a));
  return { family: best.family, missing: best.missing, tried };
}
`;

const C_OFFSCREEN_MJS = `// {{TITLE}} · C 路线同源离屏与 WebGPU 预览入口（createCanvasFilm + 节拍时间表）：
// 同一份模块可在 Chrome WebGPU 预览页（?work=/films/{{NAME}}/offscreen.mjs）实时播控，也在 Node + Dawn 里免浏览器高速出片。
import { FPS, DUR, TIMELINE, buildEvents } from './timeline.js';
import { setup, render, TEXTS, scene, FONTS, TITLE, SEAL_TEXT } from './film.js';
import { registerFonts, loadGlyphs } from './type.js';
import { createCanvasFilm } from '../../engine/offscreen/c2d.mjs';

export async function build({ THREE, TSL, renderer, pipeline, width: W, height: H, fps, query: q = new globalThis.URLSearchParams() }) {
  if (fps !== FPS) throw new Error(\`[{{NAME}}] 离屏帧率 \${fps} 与 film.json 的 \${FPS} 不一致\`);
  const notext = q.has('notext');
  const cFilm = await createCanvasFilm({ THREE, TSL, renderer, pipeline, width: W, height: H });
  await registerFonts(FONTS);
  await loadGlyphs(TITLE + SEAL_TEXT, FONTS.map(f => f.family));
  const report = setup(cFilm.canvas);
  for (const [role, text] of [['title', TITLE], ['seal', SEAL_TEXT]]) {
    const r = report.fonts[role];
    if (r.missing.length) {
      throw new Error(\`[字体缺字] \${role === 'title' ? '片名' : '印文'}「\${text}」缺字：\${r.missing.join('、')}（换字或把含该字的 OFL 字体加入 FONTS）\`);
    }
  }
  const events = buildEvents(scene());
  return cFilm.work({
    dur: DUR,
    fps: FPS,
    draw: (_ctx, t) => render(t),
    texts: notext ? () => [] : TEXTS,
    events,
    timeline: TIMELINE,
  });
}
`;

const A_README_MD = `# {{TITLE}}（A 路线 · WebGPU 同源离屏）

本片由 \`new-film a {{NAME}} --backend webgpu\` 生成（决定 D12）：同一份 \`offscreen.mjs\` 在 Chrome 的 WebGPU 工作台实时预览，在 Node + Dawn 里免浏览器高速出片。

## 常用命令（在仓库根目录执行）

\`\`\`sh
node tools/fonts/subset.mjs films/{{NAME}}                     # 生成本片字体子集（改了 film.json 的 texts 后重跑）
npm run serve                                                  # 本地预览：打开 http://127.0.0.1:8080/lab/offscreen/index.html?work=/films/{{NAME}}/offscreen.mjs
npm run film -- check    films/{{NAME}}                        # 只读契约与作品描述检查
npm run film -- stills   films/{{NAME}}                        # 风格关键帧（look 闸）
npm run film -- animatic films/{{NAME}}                        # 半分辨率动态预演（animatic 闸）
npm run film -- build    films/{{NAME}} --mode fast            # 工作版整片构建（NVENC 预览档；终渲加 --final，默认 --mode pro）
\`\`\`

路线规范见 [routes/a-webgl/README.md](../../routes/a-webgl/README.md) 与 [docs/offscreen/README.md](../../docs/offscreen/README.md)。
`;

const C_README_MD = `# {{TITLE}}（C 路线 · WebGPU 同源离屏）

本片由 \`new-film c {{NAME}} --backend webgpu\` 生成（决定 D12）：保留 C 路线的节拍时间表（\`film.json\` 的 \`tempo\` + \`cues\` → \`timeline.js\`）与程序化水墨画法（\`film.js\`），经 \`createCanvasFilm\` 在 Chrome WebGPU 实时预览、在 Node + Dawn 免浏览器出片。

## 常用命令（在仓库根目录执行）

\`\`\`sh
npm run serve                                                  # 本地预览：打开 http://127.0.0.1:8080/lab/offscreen/index.html?work=/films/{{NAME}}/offscreen.mjs
npm run film -- check    films/{{NAME}}                        # 只读契约与作品描述检查
npm run film -- stills   films/{{NAME}}                        # 风格关键帧（look 闸）
npm run film -- animatic films/{{NAME}}                        # 半分辨率动态预演（animatic 闸）
npm run film -- build    films/{{NAME}} --mode fast            # 工作版整片构建（NVENC 预览档；终渲加 --final，默认 --mode pro）
\`\`\`

路线规范见 [routes/c-style/README.md](../../routes/c-style/README.md) 与 [docs/offscreen/README.md](../../docs/offscreen/README.md)。
`;

function mkEntry(rel, content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  return { rel, abs: `<webgpu-scaffold>/${rel}`, mode: 0o644, buf };
}

export function applyWebgpuScaffold(root, routeId, files) {
  if (routeId === 'a') {
    const fjItem = files.find(f => f.rel === 'film.json');
    const tplJson = JSON.parse(fjItem.buf.toString('utf8'));
    tplJson.backend = 'webgpu';
    tplJson.entry = 'offscreen.mjs';
    tplJson.next = [
      {
        stage: 'build',
        title: '生成本片字体子集：按 texts 从锁定的 OFL 字体子集化，缺字直接失败（改了 texts 就重跑）',
        run: ['node', 'tools/fonts/subset.mjs', '{dir}'],
        requires: ['python'],
      },
      {
        stage: 'check',
        title: '只读检查：作品描述、离屏契约探测、档位、镜头表与闸门（免浏览器）',
        run: ['npm', 'run', 'film', '--', 'check', '{dir}'],
        requires: ['gpu'],
      },
      {
        stage: 'look',
        title: '风格关键帧与联系表，给用户定画风（D08 的 look 闸）',
        run: ['npm', 'run', 'film', '--', 'stills', '{dir}'],
        requires: ['gpu', 'ffmpeg', 'python'],
      },
      {
        stage: 'animatic',
        title: '半分辨率动态预演（时长、切点、声音事件同正片），给用户确认节奏（animatic 闸）',
        run: ['npm', 'run', 'film', '--', 'animatic', '{dir}'],
        requires: ['gpu', 'ffmpeg', 'python'],
      },
      {
        stage: 'build',
        title: '离屏出片：声音 → Dawn 逐帧 → 封装 → 网页版 → 免浏览器机器 QA（终渲加 --final）',
        run: ['npm', 'run', 'film', '--', 'build', '{dir}'],
        requires: ['gpu', 'ffmpeg', 'python'],
        output: '{dir}/out/latest',
      },
      {
        stage: 'check',
        title: '改完后跑仓库规范检查（A 路线规则：画风、镜头表、字体、底板）',
        run: ['npm', 'run', 'check:repo', '--', '--only', 'route-a'],
      },
    ];

    const kept = files.filter(f => f.rel === 'sound.py');
    const aRels = ['offscreen.mjs', 'story.js', 'world.js', 'title.js', 'shots/s1.js', 'shots/s2.js'];
    const codeEntries = aRels.map(rel => mkEntry(rel, fs.readFileSync(path.join(WEBGPU_A_DIR, ...`${rel}.tpl`.split('/')))));

    return [
      mkEntry('film.json', `${JSON.stringify(tplJson, null, 2)}\n`),
      mkEntry('README.md', A_README_MD),
      ...kept,
      ...codeEntries,
    ].sort((a, b) => a.rel.localeCompare(b.rel));
  }

  if (routeId === 'c') {
    const fjItem = files.find(f => f.rel === 'film.json');
    const tplJson = JSON.parse(fjItem.buf.toString('utf8'));
    delete tplJson.$comment;
    delete tplJson.dur;
    delete tplJson.fps;
    delete tplJson.size;
    tplJson.backend = 'webgpu';
    tplJson.entry = 'offscreen.mjs';
    tplJson.next = [
      {
        stage: 'check',
        title: '只读检查：作品描述、离屏契约与事件表探测（免浏览器）',
        run: ['npm', 'run', 'film', '--', 'check', '{dir}'],
        requires: ['gpu'],
      },
      {
        stage: 'look',
        title: '风格关键帧与联系表，给用户定画风（D08 的 look 闸）',
        run: ['npm', 'run', 'film', '--', 'stills', '{dir}'],
        requires: ['gpu', 'ffmpeg', 'python'],
      },
      {
        stage: 'animatic',
        title: '半分辨率动态预演，给用户确认节奏（animatic 闸）',
        run: ['npm', 'run', 'film', '--', 'animatic', '{dir}'],
        requires: ['gpu', 'ffmpeg', 'python'],
      },
      {
        stage: 'build',
        title: '离屏出片：事件探测 → 混音 → 拍点核对 → Dawn 逐帧 → 封装 → 免浏览器机器 QA（终渲加 --final）',
        run: ['npm', 'run', 'film', '--', 'build', '{dir}'],
        requires: ['gpu', 'ffmpeg', 'python'],
        output: '{dir}/out/latest',
      },
      {
        stage: 'check',
        title: '改完后跑仓库规范检查',
        run: ['npm', 'run', 'check:repo'],
      },
    ];

    const drop = new Set(['film.json', 'README.md', 'index.html', 'main.js', 'type.js', 'film.js']);
    const kept = files.filter(f => !drop.has(f.rel));
    const rawFilmJs = files.find(f => f.rel === 'film.js').buf.toString('utf8')
      .replace('W = canvas.width = innerWidth; H = canvas.height = innerHeight;', 'W = canvas.width; H = canvas.height;')
      .replaceAll('document.createElement(', 'globalThis.document.createElement(');
    return [
      mkEntry('film.json', `${JSON.stringify(tplJson, null, 2)}\n`),
      mkEntry('README.md', C_README_MD),
      mkEntry('offscreen.mjs', C_OFFSCREEN_MJS),
      mkEntry('type.js', C_ISO_TYPE_JS),
      mkEntry('film.js', rawFilmJs),
      ...kept,
    ].sort((a, b) => a.rel.localeCompare(b.rel));
  }

  throw new Error(`路线 ${routeId} 不支持 webgpu 脚手架`);
}
