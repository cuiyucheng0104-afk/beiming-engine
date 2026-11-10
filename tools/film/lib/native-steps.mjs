// 北冥仓库 · 出片编排 · B 北冥原生 · BNE 的出片步骤（调用 engine/native/prepare.mjs 与 engine/render/native.mjs，不改它们）。
//   prepare    node engine/native/prepare.mjs <作品>        素材进作品自己的 media/（B 的设计：原生运行时只认 media/）；输入没变就跳过
//   preflight  node engine/render/native.mjs <作品> --check-only   运行时版本、工具与素材齐全；不启动 GPU
//   native     node engine/render/native.mjs <作品> --mux copy --out <运行目录>/master.mp4   画面逐位复制原生编码（不二次有损），
//              声音两遍线性 loudnorm 后编 AAC；预演用 --quality draft 出 animatic.mp4
// native.mjs 写死的 out/native.mp4、out/render.json、out/render.*.log 由 ctx.legacy 收进运行目录（native/、logs/）并还原原位置。
// B 的画幅与帧率来自 film.json（native.mjs 与 film.tsx 都读它），档位不一致时拒绝（退出码 4），不偷偷改画面尺寸。
// 运行时不随仓库分发（决定 D03）：RAEA_BIN 未设时一行中文指引 + 退出码 3。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './repo.mjs';

const NATIVE = path.join(ROOT, 'engine/render/native.mjs');
const PREPARE = path.join(ROOT, 'engine/native/prepare.mjs');
const FILM_EXCLUDE = ['out', 'review', 'events.json', 'timeline.json'];

export function raeaInfo() {
  const bin = process.env.RAEA_BIN;
  if (!bin) return { ok: false, reason: 'unset' };
  if (!fs.existsSync(bin)) return { ok: false, reason: 'missing', bin };
  let version = null;
  try { version = fs.readFileSync(path.resolve(path.dirname(fs.realpathSync(bin)), '../share/raea/VERSION'), 'utf8').trim(); } catch { /* 下面报 */ }
  return { ok: !!version, reason: version ? null : 'no-version', bin, version };
}

export function requireRaea(ctx) {
  const r = raeaInfo();
  if (r.ok) return r;
  const why = r.reason === 'unset' ? '没有设 RAEA_BIN' : r.reason === 'missing' ? `RAEA_BIN 指向的文件不存在：${r.bin}` : `RAEA_BIN 的安装包里没有 share/raea/VERSION：${r.bin}`;
  ctx.fail(3, 'raea-missing', `B 路线需要单独安装的原生运行时（${why}）`,
    '把 RAEA_BIN 设为运行时可执行文件的完整路径（安装包保留 bin/ 与 share/，版本 0.1.0-canary.2），例：macOS / Linux `RAEA_BIN=/路径/raea npm run film -- build films/<名>`；PowerShell `$env:RAEA_BIN="D:\\路径\\raea.exe"`');
}

function legacyNative(ctx) {
  const o = path.join(ctx.film.dir, 'out');
  return { mp4: path.join(o, 'native.mp4'), manifest: path.join(o, 'render.json'), out: path.join(o, 'render.stdout.log'), err: path.join(o, 'render.stderr.log'), stills: path.join(o, 'stills') };
}

// 从运行时日志里认出实际设备、图形后端与编码器（日志没写的不猜，写 null）
export function nativeDevice(ctx, stdout, stderrText) {
  const ad = /AdapterInfo \{ name: "([^"]+)"[^}]*backend: (\w+)/.exec(stderrText);
  const sys = /SystemInfo \{[^}]*cpu: "([^"]+)"/.exec(stderrText);
  let encoder = null;
  for (const line of stdout.split('\n')) { try { const j = JSON.parse(line); if (j.video) { encoder = j.video; break; } } catch { /* 不是 JSON 行 */ } }
  const metal = /on metal/i.test(stderrText);
  return {
    device: ad ? ad[1] : process.platform === 'darwin' && sys ? `${sys[1]}（集成 GPU，按 SystemInfo 推断）` : null,
    backend: ad ? ad[2] : process.env.WGPU_BACKEND || (metal ? 'Metal（运行时默认）' : null),
    encoder,
  };
}

export const prepare = {
  id: 'prepare', title: '原生素材准备（engine/native/prepare.mjs）',
  key: ctx => {
    const N = ctx.film.native || {};
    const srcs = [...(N.images || []), ...(N.models || [])].map(x => x.from || x.module).filter(Boolean)
      .map(f => path.resolve(ctx.film.dir, f)).filter(f => fs.existsSync(f) && fs.statSync(f).isFile()).sort();
    return ctx.hashJson({
      step: 'prepare@1', film: ctx.hashTree(ctx.film.dir, { exclude: [...FILM_EXCLUDE, 'media'] }), srcs: srcs.map(f => [ctx.rel(f), ctx.fileHash(f)]),
      native: ctx.hashTree(path.join(ROOT, 'engine/native')), audio: ctx.hashTree(path.join(ROOT, 'engine/audio')), python: ctx.tools.python || null,
    });
  },
  // 产物在作品的 media/（不在运行目录）：缓存只记哈希，命中条件是 media/prepared.json 列的每个文件都还在且哈希不变
  cacheHit(ctx, key) {
    const m = readJson(path.join(ctx.outRoot, 'cache', 'prepare', key, 'manifest.json'));
    const p = readJson(path.join(ctx.film.dir, 'media', 'prepared.json'));
    if (!m || !p?.assets || JSON.stringify(m.assets) !== JSON.stringify(p.assets)) return null;
    for (const [f, h] of Object.entries(p.assets)) { const fp = path.join(ctx.film.dir, 'media', f); if (!fs.existsSync(fp) || ctx.fileHash(fp) !== h) return null; }
    return { runId: m.runId };
  },
  cacheStore(ctx, key) {
    const p = readJson(path.join(ctx.film.dir, 'media', 'prepared.json'));
    const dir = path.join(ctx.outRoot, 'cache', 'prepare', key);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ step: 'prepare', key, runId: ctx.run.id, createdAt: new Date().toISOString(), assets: p?.assets || {} }, null, 1));
  },
  async run(ctx) {
    await ctx.exec(process.execPath, [PREPARE, ctx.film.dir], { label: '原生素材准备', env: ctx.env, timeoutSec: ctx.opts.timeout || 1800, stallSec: ctx.opts.stall || 600 });
    const p = readJson(path.join(ctx.film.dir, 'media', 'prepared.json'));
    return { assets: Object.keys(p?.assets || {}).length };
  },
};

const preflight = {
  id: 'preflight', title: '原生预检（native.mjs --check-only）',
  async run(ctx) {
    const raea = requireRaea(ctx);
    const r = await ctx.exec(process.execPath, [NATIVE, ctx.film.dir, '--check-only'], { label: '原生预检', env: ctx.env, timeoutSec: 120, quiet: true });
    ctx.raea = raea;
    return { runtime: `RAEA ${raea.version}`, said: r.stdout.trim().split('\n').slice(-1)[0] || null };
  },
};

function nativeStep({ kind }) {
  const draft = kind === 'animatic';
  const outName = draft ? 'animatic.mp4' : 'master.mp4';
  return {
    id: 'native', title: draft ? '原生预演（--quality draft）' : '原生渲染与封装（native.mjs --mux copy）',
    key: ctx => ctx.hashJson({
      step: `native@1:${kind}`, film: ctx.hashTree(ctx.film.dir, { exclude: FILM_EXCLUDE }), native: ctx.hashTree(path.join(ROOT, 'engine/native')),
      entry: ctx.fileHash(NATIVE), quality: draft ? 'draft' : 'master', mux: 'copy', raea: (ctx.raea || {}).version || null,
      backend: process.env.WGPU_BACKEND || null, platform: `${process.platform}-${process.arch}`,
    }),
    outputs: () => ({ [draft ? 'animatic' : 'master']: outName, technical: draft ? 'native/technical.json' : 'technical.json', manifest: 'native/render.json' }),
    restored: (ctx, meta) => { ctx.gpu = meta.gpu || null; ctx.nativeDevice = meta.device || null; },
    async run(ctx) {
      const L = legacyNative(ctx);
      for (const p of [L.mp4, L.manifest, L.out, L.err]) ctx.legacy.protect(p, { move: true });
      const out = path.join(ctx.run.dir, outName);
      const args = [NATIVE, ctx.film.dir, '--mux', 'copy', '--out', out, '--quality', draft ? 'draft' : 'master'];
      let r;
      try {
        r = await ctx.exec(process.execPath, args, { label: draft ? '原生预演' : '原生渲染', env: ctx.env, timeoutSec: ctx.opts.timeout || Math.round(300 + ctx.frames * 2), stallSec: ctx.opts.stall || 600 });
      } finally {
        const nd = path.join(ctx.run.dir, 'native');
        ctx.legacy.collect(L.manifest, path.join(nd, 'render.json'));
        ctx.legacy.collect(L.out, path.join(ctx.run.logs, 'native.render.stdout.log'));
        ctx.legacy.collect(L.err, path.join(ctx.run.logs, 'native.render.stderr.log'));
        // 原生母版的画面已逐位复制进 master.mp4，原始编码文件不再单独保留
        if (fs.existsSync(L.mp4)) fs.rmSync(L.mp4, { force: true });
        if (draft && fs.existsSync(path.join(ctx.run.dir, 'technical.json'))) ctx.legacy.collect(path.join(ctx.run.dir, 'technical.json'), path.join(nd, 'technical.json'));
      }
      const errLog = path.join(ctx.run.logs, 'native.render.stderr.log');
      const outLog = path.join(ctx.run.logs, 'native.render.stdout.log');
      const dev = nativeDevice(ctx, fs.existsSync(outLog) ? fs.readFileSync(outLog, 'utf8') : '', fs.existsSync(errLog) ? fs.readFileSync(errLog, 'utf8') : '');
      ctx.nativeDevice = dev;
      ctx.gpu = dev.device;
      const tj = readJson(path.join(ctx.run.dir, draft ? 'native/technical.json' : 'technical.json'));
      return { gpu: dev.device, device: dev, renderSeconds: tj?.renderSeconds ?? null, checks: tj?.checks ?? null, said: r.stdout.trim().split('\n').slice(-1)[0] || null };
    },
  };
}

export function nativeSteps({ kind = 'build' } = {}) {
  return [prepare, preflight, nativeStep({ kind })];
}

// B 的静帧：native.mjs --at 把 PNG 按请求顺序写成 out/stills/frame-00000.png …（不是按帧号），这里按顺序映射回帧号
export async function nativeStills(ctx, frames, destDir) {
  requireRaea(ctx);
  const L = legacyNative(ctx);
  ctx.legacy.protect(L.stills, { move: true });
  const sorted = [...new Set(frames)].sort((a, b) => a - b);
  const done = new Map();
  try {
    for (let i = 0; i < sorted.length; i += 200) {
      const batch = sorted.slice(i, i + 200);
      fs.rmSync(L.stills, { recursive: true, force: true });
      await ctx.exec(process.execPath, [NATIVE, ctx.film.dir, '--at', batch.join(',')], { label: `原生静帧 ${batch.length} 张`, env: ctx.env, timeoutSec: ctx.opts.timeout || 120 + batch.length * 10, stallSec: ctx.opts.stall || 600 });
      const got = fs.existsSync(L.stills) ? fs.readdirSync(L.stills).filter(n => /\.png$/i.test(n)).sort() : [];
      if (got.length !== batch.length) ctx.fail(1, 'native-stills', `原生静帧只得到 ${got.length}/${batch.length} 张`, '看 logs/ 下的输出');
      fs.mkdirSync(destDir, { recursive: true });
      got.forEach((n, k) => {
        const dst = path.join(destDir, `f${String(batch[k]).padStart(6, '0')}.png`);
        fs.renameSync(path.join(L.stills, n), dst);
        done.set(batch[k], dst);
      });
    }
  } finally {
    fs.rmSync(L.stills, { recursive: true, force: true });
  }
  return done;
}

export function nativeKey(ctx) {
  return ctx.hashJson({ step: 'native-stills@1', film: ctx.hashTree(ctx.film.dir, { exclude: FILM_EXCLUDE }), native: ctx.hashTree(path.join(ROOT, 'engine/native')), entry: ctx.fileHash(NATIVE), raea: raeaInfo().version || null, platform: `${process.platform}-${process.arch}` });
}

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
