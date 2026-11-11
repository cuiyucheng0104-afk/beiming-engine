#!/usr/bin/env node
// 北冥仓库 · 金标准基线：证明一次改动没有把画面改坏。PNG 不进 git（D10），仓库只存每帧像素哈希的清单与审批记录。
//   node tools/baseline/golden.mjs <capture|compare|update|approve|reference|keyframes|list> [选项]      （--help 看全部）
// 设计与阈值：docs/style-baselines/POLICY.md；集合定义：tools/baseline/sets.json；清单：tests/golden/<平台键>/manifest.json。
// 命令约定（参数、--help、--json 信封、退出码、信号收尾）用 tools/lib/cli.mjs（docs/CLI.md）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineCommand, runCli, isMain } from '../lib/cli.mjs';
import { CliError, EXIT, usage, log, setQuiet, bindCleanups, echoWarnings, onCleanup, offCleanup, sha256File, sha256, displayPath } from './lib/cli.mjs';
import { loadSets, setHash, shotOf } from './lib/sets.mjs';
import { captureSet, captureUsable, assertCaptured } from './lib/capture.mjs';
import { compareFrames, summaryLine, worstStats } from './lib/compare.mjs';
import { headCommit, resolveCommit, commitExists, pixelTreeDigest, dirtyPixelPaths, withSnapshot, runId, isGitRepo, PIXEL_PATHS } from './lib/git.mjs';
import {
  platformRel, readPlatform, writePlatform, emptyPlatform, referencePath, toBaseline, validateManifest, diffFrames,
  appendApproval, readManifest, listManifests, listReferences, APPROVALS, PK_RE, REFERENCE_DIR,
} from './lib/manifest.mjs';
import { decodePNG, encodePNG } from './lib/png.mjs';
import { contactSheet, downscale } from './lib/metrics.mjs';
import { osKey } from './lib/platform.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SETS_FILE = path.join(ROOT, 'tools/baseline/sets.json');
const OUT = path.join(ROOT, 'out/golden');
const GPU_POLICIES = ['required', 'any', 'software-ok'];

// 每个子命令接受哪些选项（全局的 --json --quiet --help --version 总是可以）
const SUBS = {
  capture: ['set', 'platform', 'gpu', 'jobs', 'frame-timeout', 'out', 'sets'],
  compare: ['set', 'platform', 'against', 'ref-dir', 'reference', 'perturb', 'strict', 'no-render-ref', 'no-cache', 'gpu', 'jobs', 'frame-timeout', 'out', 'work-dir', 'sets'],
  update: ['set', 'by', 'reason', 'commit', 'ref', 'dry-run', 'gpu', 'jobs', 'frame-timeout'],
  approve: ['set', 'platform', 'by', 'reason', 'commit', 'ref', 'dry-run'],
  reference: ['set', 'id', 'by', 'reason', 'commit', 'ref', 'dry-run', 'gpu', 'jobs', 'frame-timeout'],
  keyframes: ['reference', 'gpu', 'jobs', 'frame-timeout', 'work-dir', 'no-cache', 'dry-run'],
  list: ['sets'],
};

const angleKey = () => `${osKey()}-${process.env.BEIMING_ANGLE || 'default'}`;
const cacheDir = (sha, set) => path.join(OUT, 'cache', sha, angleKey(), set);
const rel = p => displayPath(ROOT, p);
const out = (p, kind) => ({ path: rel(p), sha256: sha256File(p), kind });

function lock(dir) {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const f = `${dir}.lock`;
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(f, String(process.pid), { flag: 'wx' });
      const release = () => fs.rmSync(f, { force: true });
      release.sync = release;
      onCleanup(release);
      return () => { offCleanup(release); release(); };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(fs.readFileSync(f, 'utf8'));
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch { alive = false; }
      if (alive && pid !== process.pid) throw new CliError('busy.cache-lock', `另一个进程（pid ${pid}）正在写 ${rel(dir)}`, { hint: '等它结束再跑；确认它已不存在时删掉同名 .lock 文件', exitCode: EXIT.BUSY });
      fs.rmSync(f, { force: true });
    }
  }
  throw new CliError('busy.cache-lock', `拿不到锁 ${rel(dir)}.lock`, { exitCode: EXIT.BUSY });
}

// 这些集合用到的像素相关路径：引擎、样片、自测页、素材、字体、页面入口，加上集合引用的页面目录与模版
function pagePaths(sets, names) {
  const ps = new Set();
  for (const n of names) for (const g of sets.sets[n].shots) {
    const p = sets.pages[g.page];
    for (const r of [p.dir, p.template, p.requires]) if (r && r !== '.') ps.add(r);
  }
  return [...ps];
}
const pixelPathsFor = (sets, names) => [...new Set([...PIXEL_PATHS.filter(p => !['tests/golden/fixtures', 'tools/baseline/sets.json'].includes(p)), ...pagePaths(sets, names)])].sort();

// 截一个集合到 dir（先写到临时目录，成功后整体改名，半截的缓存永远不会被当成可用）
async function captureInto({ tree, sets, setName, dir, opts, source, perturb = '' }) {
  const release = lock(dir);
  const tmp = `${dir}.tmp-${process.pid}`;
  const rmTmp = () => fs.rmSync(tmp, { recursive: true, force: true });
  rmTmp.sync = rmTmp;
  onCleanup(rmTmp);
  try {
    rmTmp();
    const { manifest, failures } = await captureSet({
      tree, sets, setName, outDir: tmp, gpu: opts.gpu, jobs: opts.jobs, frameTimeoutMs: opts.frameTimeoutMs, log, source, perturb,
    });
    assertCaptured(failures);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(tmp, dir);
    return manifest;
  } finally {
    offCleanup(rmTmp); rmTmp(); release();
  }
}

// 当前工作树的来源：提交、是否有未提交的像素相关改动；干净时另记像素路径摘要（候选审批时据此核对登记提交）
function sourceOf(tree, sets, names) {
  const { sha } = headCommit(tree);
  const dirty = dirtyPixelPaths(tree);
  const src = { commit: sha, dirty: dirty.length > 0, ...(dirty.length ? { dirtyPaths: dirty.slice(0, 50) } : {}) };
  if (sha && !dirty.length && sets) {
    src.pixelPaths = pixelPathsFor(sets, names);
    src.pixelTree = pixelTreeDigest(tree, sha, src.pixelPaths);
  }
  return src;
}

async function captureCurrent(sets, setName, opts, dir, sourceOverride = null) {
  const source = sourceOverride || sourceOf(ROOT, sets, [setName]);
  log(`截 ${setName}（${source.commit ? source.commit.slice(0, 7) : '无 git'}${source.dirty ? '，有未提交的像素相关改动' : ''}）→ ${rel(dir)}`);
  // --perturb 只作用于当前工作树这一次截帧：参照（缓存、现渲的源提交）永远不加
  const manifest = await captureInto({ tree: ROOT, sets, setName, dir, opts, source, perturb: opts.perturb || '' });
  if (opts.perturb) log(`  （网址加了 --perturb ${opts.perturb}，帧编号不变）`);
  log(`  ${manifest.frames.length} 帧，${manifest.seconds} 秒，平台 ${manifest.platformKey}（${manifest.renderer}），浏览器 ${manifest.browser}`);
  if (opts.platform && manifest.platformKey !== opts.platform) {
    throw new CliError('env.platform-mismatch', `--platform ${opts.platform}，本机实际渲出的是 ${manifest.platformKey}（${manifest.renderer}）`, {
      hint: `平台键由 WebGL 实际报出的渲染器决定：检查 BEIMING_ANGLE（软件渲染设 swiftshader）；或改用 --platform ${manifest.platformKey}`,
      exitCode: EXIT.ENV,
    });
  }
  return { manifest, dir };
}

// 参照：现场渲染提交（有缓存且环境一致就复用）。requests = [{ setName, sha, want }]，同一个提交的多个集合只导出一次快照
const refKey = (sha, setName) => `${sha}/${setName}`;
async function captureRefs(sets, requests, opts) {
  const got = new Map(), todo = new Map();
  for (const r of requests) {
    const dir = cacheDir(r.sha, r.setName);
    const m = opts.noCache ? null : captureUsable(dir, { setHash: setHash(sets, r.setName), ...r.want });
    if (m) { log(`参照 ${r.sha.slice(0, 7)} / ${r.setName} 用缓存 ${rel(dir)}`); got.set(refKey(r.sha, r.setName), { manifest: m, dir }); continue; }
    if (!todo.has(r.sha)) todo.set(r.sha, []);
    todo.get(r.sha).push(r);
  }
  const head = headCommit(ROOT).sha, clean = dirtyPixelPaths(ROOT).length === 0;
  for (const [sha, reqs] of todo) {
    const run = async tree => {
      for (const r of reqs) {
        const dir = cacheDir(sha, r.setName);
        const manifest = await captureInto({ tree, sets, setName: r.setName, dir, opts: { ...opts, perturb: '' }, source: { commit: sha, dirty: false } });
        got.set(refKey(sha, r.setName), { manifest, dir });
      }
    };
    if (sha === head && clean) { log(`参照 ${sha.slice(0, 7)} 就是当前工作树（干净），直接截`); await run(ROOT); }
    else await withSnapshot(ROOT, sha, { workDir: opts.workDir, log, paths: pagePaths(sets, reqs.map(r => r.setName)) }, run);
  }
  return got;
}

function readPlatformSafe(pk) {
  try { return readPlatform(ROOT, pk); } catch (e) {
    throw new CliError('contract.bad-manifest', `${platformRel(pk)} 读不出来（${e.message}）`, { hint: '清单只能由 golden update / approve 生成；用 git checkout 还原', exitCode: EXIT.CONTRACT });
  }
}

const SOFTWARE_PK = /-(swiftshader|llvmpipe|warp)$/;
function normalizeOpts(o) {
  // --gpu 不写时：--platform 指明的是软件光栅平台（如 linux-swiftshader）就默认 software-ok，否则 required
  const gpu = o.gpu || (o.platform && SOFTWARE_PK.test(o.platform) ? 'software-ok' : 'required');
  if (!GPU_POLICIES.includes(gpu)) {
    throw usage(`--gpu 只能是 ${GPU_POLICIES.join(' | ')}，现在是 ${gpu}`);
  }
  if (o.platform && !PK_RE.test(o.platform)) throw usage(`--platform 要写成 <系统>-<后端>，例如 darwin-metal、win-vulkan、linux-swiftshader（现在是 ${o.platform}）`);
  return { ...o, gpu, jobs: o.jobs || 2, frameTimeoutMs: Math.round((o.frameTimeout || 60) * 1000) };
}
function needSets(sets, names) {
  if (!names.length) throw usage('要用 --set 指定集合', `可用集合：${Object.keys(sets.sets).join('、')}`);
  for (const n of names) if (!sets.sets[n]) throw new CliError('usage.unknown-set', `没有集合 ${n}`, { hint: `可用集合：${Object.keys(sets.sets).join('、')}`, exitCode: EXIT.USAGE });
  return [...new Set(names)];
}

// 审批用的总览：一个集合的全部帧按 4 列拼成一张（每格 320 宽），写在截帧目录里。审批人转正候选前看的就是它
function reviewSheet(dir, manifest) {
  const imgs = manifest.frames.map(f => downscale(decodePNG(fs.readFileSync(path.join(dir, f.file))), 320));   // 逐张缩小，4K 帧也不占大内存
  const rows = [];
  for (let i = 0; i < imgs.length; i += 4) rows.push(imgs.slice(i, i + 4));
  const file = path.join(dir, 'contact.png');
  fs.writeFileSync(file, encodePNG(contactSheet(rows, { tileW: 320 })));
  return file;
}

// ── capture ──
// 输出：--out 给了就写 <out>/<集合>/；工作树干净时写缓存 out/golden/cache/<提交>/<系统-后端>/<集合>/（compare 取参照像素时复用）；
// 否则写 out/golden/runs/<运行编号>/<集合>/。
// --platform：核对本机平台键；还没有经审批基线的集合另写成待审批候选，放进 tests/golden/<平台键>/manifest.json（CI 首次采集用）
async function cmdCapture(opts, sets) {
  const outputs = [], result = [], warnings = [];
  const names = needSets(sets, opts.set);
  const id = runId(ROOT);
  const caps = {};
  for (const s of names) {
    const source = sourceOf(ROOT, sets, [s]);
    const dir = opts.out ? path.resolve(opts.out, s) : source.commit && !source.dirty ? cacheDir(source.commit, s) : path.join(OUT, 'runs', id, s);
    const { manifest } = await captureCurrent(sets, s, opts, dir, source);
    caps[s] = manifest;
    outputs.push(out(path.join(dir, 'capture.json'), 'golden-capture'));
    if (opts.platform) {
      const sheet = reviewSheet(dir, manifest);
      outputs.push(out(sheet, 'contact-sheet'));
      log(`  总览（审批时看）：${rel(sheet)}`);
    }
    result.push({ set: s, dir: rel(dir), platformKey: manifest.platformKey, device: manifest.device, frames: manifest.frames.length, seconds: manifest.seconds, source: { commit: manifest.source.commit, dirty: manifest.source.dirty } });
  }
  if (opts.platform) {
    const pk = opts.platform;
    const doc = readPlatformSafe(pk) || emptyPlatform(pk);
    const written = [];
    for (const s of names) {
      const m = caps[s], prev = doc.sets[s];
      if (prev && prev.status !== 'candidate') { warnings.push(`${s}：${pk} 已有经审批的基线，capture 不覆盖（画面有意改了用 golden update）`); continue; }
      if (m.source.dirty || !m.source.pixelTree) { warnings.push(`${s}：像素相关路径有未提交改动（或不在 git 里），不能写成候选：先提交再采集`); continue; }
      doc.sets[s] = toBaseline(m, null);
      written.push(s);
    }
    if (written.length) {
      const f = writePlatform(ROOT, pk, doc);
      outputs.push(out(f, 'golden-candidate'));
      log(`候选写进 ${rel(f)}：${written.join('、')}（status=candidate，还没有审批）`);
      log(`  审批人看过画面后转正：node tools/baseline/golden.mjs approve --platform ${pk} ${written.map(s => `--set ${s}`).join(' ')} --by <审批人> --reason <理由> [--commit <提交>]`);
      warnings.push(`${written.join('、')} 写成了 ${pk} 的待审批候选（${platformRel(pk)}）：经 golden approve 转正前不参与比对`);
    }
    for (const r of result) r.candidate = written.includes(r.set);
  }
  return { outputs, warnings, data: result };
}

// ── compare ──
// 三步：① 截当前工作树的每个集合；② 定参照（--against / --ref-dir / --reference / 本平台清单），需要现渲的按提交分组、
// 每个提交只导出一次快照；③ 逐集合比对、出报告
async function cmdCompare(opts, sets) {
  const names = needSets(sets, opts.set);
  if ([opts.against, opts.refDir, opts.reference].filter(Boolean).length > 1) throw usage('--against、--ref-dir、--reference 只能选一个');
  if (opts.reference) checkRefId(opts.reference);
  const againstSha = opts.against ? resolveCommit(ROOT, opts.against) : null;
  const id = runId(ROOT);
  const reportRoot = opts.out ? path.resolve(opts.out) : path.join(OUT, 'compare', id);
  const outputs = [], warnings = [], result = [];
  let failed = false;
  const missing = [];

  // ① 当前
  const cur = {};
  for (const s of names) cur[s] = await captureCurrent(sets, s, opts, path.join(reportRoot, 'current', s));

  // ② 参照
  const plan = {}, requests = [];
  for (const s of names) {
    const curM = cur[s].manifest, want = { platformKey: curM.platformKey, device: curM.device, browser: curM.browser };
    if (againstSha) {
      plan[s] = { kind: 'against', sha: againstSha };
      requests.push({ setName: s, sha: againstSha, want });
    } else if (opts.refDir) {
      const d = path.resolve(opts.refDir, fs.existsSync(path.join(opts.refDir, s, 'capture.json')) ? s : '');
      const m = readManifest(path.join(d, 'capture.json'));
      if (!m) throw new CliError('env.no-ref-dir', `--ref-dir 里找不到 ${s} 的 capture.json：${d}`, { hint: '传 golden capture 输出的目录（含 capture.json 与 frames/）', exitCode: EXIT.ENV });
      plan[s] = { kind: 'dir', m, dir: d };
    } else {
      let m, label;
      if (opts.reference) {
        const mf = referencePath(ROOT, opts.reference, curM.platformKey);
        m = readManifest(mf);
        label = `认可参照 ${opts.reference}（${rel(mf)}）`;
        if (m && m.set !== s) throw usage(`认可参照 ${opts.reference} 登记的是集合 ${m.set}，不是 ${s}`, `用 --set ${m.set}`);
      } else {
        const doc = readPlatformSafe(curM.platformKey);
        m = doc?.sets?.[s] || null;
        label = `${platformRel(curM.platformKey)} 的 ${s}`;
        if (m?.status === 'candidate') {
          missing.push(`${label} 只有待审批的候选，还没有经审批的基线：审批人用 golden approve --platform ${curM.platformKey} --set ${s} … 转正后再比`);
          result.push({ set: s, ok: false, error: 'candidate-only', platformKey: curM.platformKey });
          continue;
        }
      }
      if (!m) {
        missing.push(`本平台（${curM.platformKey}）还没有 ${s} 的${opts.reference ? `认可参照 ${opts.reference}` : `基线（${platformRel(curM.platformKey)}）`}`);
        result.push({ set: s, ok: false, error: 'no-baseline', platformKey: curM.platformKey });
        continue;
      }
      const errs = validateManifest(m);
      if (errs.length) throw new CliError('contract.bad-manifest', `${label} 不合法：${errs.join('；')}`, { hint: '清单只能由 golden update / approve / reference 生成', exitCode: EXIT.CONTRACT });
      if (m.setHash !== curM.setHash) warnings.push(`${s}：集合定义与基线清单不一致（sets.json 改过），多出 / 缺少的帧要经审批 update`);
      if (m.device !== curM.device || m.browser !== curM.browser) warnings.push(`${s}：基线来自 ${m.device} / 浏览器 ${m.browser}，本机是 ${curM.device} / ${curM.browser}；哈希不同的帧会现渲基线提交来区分「代码改动」与「环境漂移」`);
      const curById = new Map(curM.frames.map(f => [f.id, f]));
      const differing = m.frames.filter(f => curById.get(f.id) && curById.get(f.id).pixelSha256 !== f.pixelSha256);
      plan[s] = { kind: 'manifest', m, label, differing: differing.length };
      if (differing.length && !opts.noRenderRef) {
        if (!commitExists(ROOT, m.source.commit)) warnings.push(`${s}：基线源提交 ${m.source.commit.slice(0, 12)} 在本仓库里找不到（浅克隆？CI 用 fetch-depth: 0），${differing.length} 帧哈希不同却拿不到参照像素`);
        else {
          log(`${s}：${differing.length} 帧哈希与清单不同，现渲基线源提交 ${m.source.commit.slice(0, 7)} 取参照像素`);
          requests.push({ setName: s, sha: m.source.commit, want });
        }
      }
    }
  }
  const refs = requests.length ? await captureRefs(sets, requests, opts) : new Map();

  // ③ 比对
  for (const s of names) {
    const P = plan[s];
    if (!P) continue;
    const curM = cur[s].manifest, tolAll = sets.sets[s].tolerance || {};
    let ref, refLabel, mode, drift = [];
    if (P.kind === 'against') {
      const r = refs.get(refKey(P.sha, s));
      ref = { frames: r.manifest.frames, dir: r.dir };
      refLabel = `提交 ${P.sha.slice(0, 12)}（现场渲染）`;
      mode = r.manifest.platformKey === curM.platformKey ? 'same-platform' : 'cross-platform';
    } else if (P.kind === 'dir') {
      ref = { frames: P.m.frames, dir: P.dir };
      refLabel = `目录 ${P.dir}（${P.m.platformKey}，${P.m.device}）`;
      mode = P.m.platformKey === curM.platformKey ? 'same-platform' : 'cross-platform';
    } else {
      const m = P.m;
      ref = { frames: m.frames, dir: null };
      refLabel = `${P.label}（源提交 ${m.source.commit.slice(0, 12)}）`;
      mode = 'same-platform';
      const r = refs.get(refKey(m.source.commit, s));
      if (r) {
        const local = new Map(r.manifest.frames.map(f => [f.id, f]));
        // 本机渲染基线提交得到的哈希与清单不同 = 环境漂移（设备、驱动、浏览器）；此时拿本机渲染的基线提交当参照
        drift = m.frames.filter(f => local.get(f.id) && local.get(f.id).pixelSha256 !== f.pixelSha256).map(f => f.id);
        ref = { frames: m.frames.map(f => local.get(f.id) || f), dir: r.dir };
        if (drift.length) warnings.push(`${s}：${drift.length} 帧环境漂移（本机渲染基线提交 ≠ 清单）；这些帧改为与本机渲染的基线提交比较。漂移确认无害后，经审批为本机环境重建基线`);
      }
    }
    const tolerance = mode === 'cross-platform' ? (tolAll.crossPlatform || {}) : (tolAll.samePlatform || {});
    const strict = opts.strict && mode !== 'cross-platform';
    if (opts.strict && mode === 'cross-platform') warnings.push(`${s}：跨平台比对不可能逐像素一致，--strict 不适用，按跨平台容差判定`);
    const dir = path.join(reportRoot, s);
    const cmp = compareFrames({ ref, cur: { frames: curM.frames, dir: cur[s].dir }, tolerance, strict, outDir: dir, log });
    // 给每帧标上镜头（sets.json 顶层 annotations 的镜头表），汇总差异落在哪些镜头
    const meta = new Map([...ref.frames, ...curM.frames].map(f => [f.id, f]));
    const byShot = {};
    for (const f of cmp.frames) {
      const m = meta.get(f.id), shot = m ? shotOf(sets, m.page, m.t) : null;
      if (shot) f.shot = shot;
      if (shot && !['identical', 'within'].includes(f.status)) byShot[shot] = (byShot[shot] || 0) + 1;
    }
    const report = {
      schemaVersion: 1, kind: 'golden-compare', set: s, mode, strict, tolerance,
      reference: refLabel, current: { dir: rel(cur[s].dir), source: curM.source, platformKey: curM.platformKey, device: curM.device, renderer: curM.renderer, browser: curM.browser, env: curM.env },
      ok: cmp.ok, summary: cmp.summary, worst: worstStats(cmp.frames), byShot, drift, contact: cmp.contact,
      frames: cmp.frames,
    };
    fs.mkdirSync(dir, { recursive: true });
    const rp = path.join(dir, 'report.json');
    fs.writeFileSync(rp, JSON.stringify(report, null, 1) + '\n');
    outputs.push(out(rp, 'golden-report'));
    if (cmp.contact) outputs.push(out(path.join(dir, cmp.contact), 'contact-sheet'));
    log(`${cmp.ok ? '通过' : '不通过'} ${s}（${mode === 'cross-platform' ? '跨平台' : '同平台'}${strict ? '，严格' : ''}）对 ${refLabel}：${summaryLine(cmp.summary)}`);
    if (Object.keys(byShot).length) log(`  差异所在镜头：${Object.entries(byShot).map(([k, n]) => `镜头 ${k} ${n} 帧`).join('、')}`);
    for (const f of cmp.frames.filter(x => !['identical', 'within'].includes(x.status)).slice(0, 12)) {
      log(`  ✗ ${f.id}：${f.status}${f.reasons ? ` · ${f.reasons.join('；')}` : ''}${f.diff ? ` · 热图 ${rel(path.join(dir, f.diff))}` : ''}`);
    }
    if (!cmp.ok) failed = true;
    result.push({ set: s, ok: cmp.ok, mode, summary: cmp.summary, worst: report.worst, byShot, report: rel(rp) });
  }
  const runJson = outputs.find(o => o.kind === 'golden-report')?.path ?? null;
  if (failed) {
    return { exitCode: EXIT.CONTRACT, outputs, warnings, data: result, runJson,
      error: { code: 'contract.golden-mismatch', message: '与基线不一致（见报告与差异热图）', hint: '确认是有意的画面改动后，请审批人用 golden update 更新基线（docs/style-baselines/POLICY.md 第 6 节）；否则修代码' } };
  }
  if (missing.length) {
    return { exitCode: EXIT.ENV, outputs, warnings: [...warnings, ...missing.slice(1)], data: result, runJson,
      error: { code: 'env.no-baseline', message: missing[0], hint: '先 capture 再由审批人 update（本机）或 approve（CI 采集的候选）建立本平台基线；或用 --against <提交> 现场对比' } };
  }
  return { outputs, warnings, data: result, runJson };
}

// ── update / reference ──
const REF_ID = /^[a-z0-9][a-z0-9-]*@v[1-9][0-9]*$/;
function checkRefId(id) {
  if (!REF_ID.test(id || '')) throw usage(`认可参照的名字要写成 <名>@v<版本>，例如 beiming-original@v1（现在是 ${JSON.stringify(id)}）`);
}
function needApproval(opts, what) {
  for (const k of ['by', 'reason']) if (!opts[k] || !String(opts[k]).trim()) throw usage(`${what} 必须写 --${k}`, '要留审批记录：--by 审批人 --reason 理由（引用批准出处）');
}
async function cmdUpdate(opts, sets, { reference = false } = {}) {
  const names = needSets(sets, opts.set);
  needApproval(opts, reference ? 'reference' : 'update');
  if (!opts.commit) throw usage(`${reference ? 'reference' : 'update'} 必须写 --commit`, '登记哪个提交：HEAD，或与 HEAD 在像素相关路径上逐字节相同的提交');
  if (reference) {
    checkRefId(opts.id);
    if (names.length !== 1) throw usage('reference 一次只登记一个集合');
  }
  if (!isGitRepo(ROOT)) throw new CliError('env.no-git', '不在 git 工作树里，没法登记来源提交', { exitCode: EXIT.ENV });
  const sha = resolveCommit(ROOT, opts.commit), head = headCommit(ROOT).sha;
  const dirty = dirtyPixelPaths(ROOT);
  if (dirty.length) throw new CliError('contract.dirty', `像素相关路径有未提交改动：${dirty.slice(0, 8).join('、')}${dirty.length > 8 ? ' …' : ''}`, { hint: '先提交或还原这些改动；基线只能来自已提交的代码', exitCode: EXIT.CONTRACT });
  // 登记的提交可以不是 HEAD，但这些集合用到的像素相关路径必须与 HEAD 逐字节相同：
  // 这样可以把基线登记在集成分支上更稳定的提交（例如合并基底），工作分支被压扁合并后清单里的提交仍然找得到
  const paths = pixelPathsFor(sets, names);
  if (sha !== head) {
    if (pixelTreeDigest(ROOT, sha, paths) !== pixelTreeDigest(ROOT, head, paths)) {
      throw new CliError('contract.not-equivalent', `--commit ${opts.commit}（${sha.slice(0, 12)}）与当前 HEAD（${head.slice(0, 12)}）在这些集合用到的像素相关路径上不一样`,
        { hint: `用 --commit HEAD，或先 git checkout ${sha.slice(0, 12)} 再登记；查差异：git diff --stat ${sha.slice(0, 12)} HEAD -- ${paths.join(' ')}`, exitCode: EXIT.CONTRACT });
    }
    log(`登记提交 ${sha.slice(0, 12)}：这些集合用到的像素相关路径与 HEAD（${head.slice(0, 12)}）逐字节相同，用当前工作树渲染`);
  }
  const outputs = [], result = [];
  const docs = {};   // 平台键 → 平台清单（update 改的是它）
  for (const s of names) {
    const sp = pixelPathsFor(sets, [s]);
    const cur = await captureCurrent(sets, s, opts, cacheDir(sha, s), { commit: sha, dirty: false, ...(sha !== head ? { renderedAt: head } : {}), pixelPaths: sp, pixelTree: pixelTreeDigest(ROOT, sha, sp) });
    const m = cur.manifest;
    const approval = { by: opts.by.trim(), reason: opts.reason.trim(), commit: sha, at: new Date().toISOString(), ...(opts.ref ? { ref: opts.ref } : {}) };
    const baseline = toBaseline(m, approval);
    let target, before = null;
    if (reference) {
      Object.assign(baseline, { kind: 'style-reference', referenceId: opts.id });
      target = referencePath(ROOT, opts.id, m.platformKey);
      if (fs.existsSync(target)) {
        throw new CliError('contract.reference-frozen', `认可参照 ${opts.id} 在 ${m.platformKey} 上已经登记过：${rel(target)}`,
          { hint: `认可参照冻结后不改；画面的认可变了就另立新版本（例如 ${opts.id.replace(/@v(\d+)$/, (_, v) => `@v${+v + 1}`)}），旧版本留着做历史对照`, exitCode: EXIT.CONTRACT });
      }
      // 同一个认可参照的各平台文件必须登记同一个提交、同一份集合定义
      for (const o of listReferences(ROOT).filter(x => x.id === opts.id)) {
        const om = readManifest(o.file);
        if (om && (om.source?.commit !== sha || om.setHash !== baseline.setHash)) {
          throw new CliError('contract.reference-mismatch', `认可参照 ${opts.id} 已有的 ${o.platformKey} 版本登记的是提交 ${om.source?.commit?.slice(0, 12)}、集合哈希 ${om.setHash?.slice(0, 12)}，与这次不同`,
            { hint: `给新平台补登记时用同一个提交：--commit ${om.source?.commit?.slice(0, 12)}，且不要改 sets.json 里这个集合`, exitCode: EXIT.CONTRACT });
        }
      }
    } else {
      const pk = m.platformKey;
      docs[pk] = docs[pk] || readPlatformSafe(pk) || emptyPlatform(pk);
      before = docs[pk].sets[s] || null;
      if (before?.status === 'candidate') before = null;   // 候选不算已有基线
      target = path.join(ROOT, platformRel(pk));
    }
    const d = diffFrames(before?.frames, baseline.frames);
    const same = before && before.framesDigest === baseline.framesDigest && before.setHash === baseline.setHash;
    log(`${s} → ${rel(target)}${reference ? '' : ` 的 ${s}`}：${before ? `新增 ${d.added.length}、删除 ${d.removed.length}、像素变化 ${d.changed.length}` : `首次建立（${baseline.frames.length} 帧）`}${same ? '（与现有基线逐帧相同）' : ''}`);
    result.push({ set: s, manifest: rel(target), platformKey: m.platformKey, device: m.device, frames: baseline.frames.length, before: before?.framesDigest ?? null, after: baseline.framesDigest, ...d, dryRun: !!opts.dryRun, ...(reference ? { referenceId: opts.id } : {}) });
    if (opts.dryRun) continue;
    if (reference) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(baseline, null, 1) + '\n');
    } else {
      docs[m.platformKey].sets[s] = baseline;
      writePlatform(ROOT, m.platformKey, docs[m.platformKey]);
    }
    appendApproval(ROOT, {
      at: approval.at, kind: reference ? 'style-reference' : 'golden-baseline', ...(reference ? { referenceId: opts.id } : {}),
      set: s, platformKey: m.platformKey, device: m.device, by: approval.by, reason: approval.reason, commit: sha,
      ...(opts.ref ? { ref: opts.ref } : {}), before: before?.framesDigest ?? null, after: baseline.framesDigest, setHash: baseline.setHash, ...d,
    });
    if (!outputs.some(o => o.file === target)) outputs.push({ file: target, kind: reference ? 'style-reference' : 'golden-manifest' });
  }
  const outs = outputs.map(o => out(o.file, o.kind));
  if (!opts.dryRun) outs.push(out(path.join(ROOT, APPROVALS), 'approval-log'));
  return { outputs: outs, data: result };
}

// ── approve：把 capture --platform 写下的待审批候选转正 ──
// 候选来自另一台机器（通常是 CI 的 linux-swiftshader），本机渲不出同样的像素，所以不重渲：
// 核对候选的集合定义仍是现在的、它记下的像素路径摘要与登记提交一致，然后写审批记录。
async function cmdApprove(opts, sets) {
  if (!opts.platform) throw usage('approve 要用 --platform 指明转正哪个平台的候选，例如 --platform linux-swiftshader');
  const names = needSets(sets, opts.set);
  needApproval(opts, 'approve');
  if (!isGitRepo(ROOT)) throw new CliError('env.no-git', '不在 git 工作树里，没法核对登记提交', { exitCode: EXIT.ENV });
  const pk = opts.platform;
  const doc = readPlatformSafe(pk);
  if (!doc) throw new CliError('contract.no-candidate', `没有 ${platformRel(pk)}`, { hint: `先在 ${pk} 上 capture --platform ${pk}（CI 的 smoke-render 首次运行会采集并上传工件 golden-capture，在仓库根目录解开）`, exitCode: EXIT.CONTRACT });
  const at = new Date().toISOString(), result = [];
  const commit = opts.commit ? resolveCommit(ROOT, opts.commit) : null;
  for (const s of names) {
    const c = doc.sets[s];
    if (!c || c.status !== 'candidate') throw new CliError('contract.no-candidate', `${platformRel(pk)} 里没有 ${s} 的待审批候选${c ? '（它已经是经审批的基线）' : ''}`, { hint: c ? '画面有意改了用 golden update 在那台机器上重登记' : `先 capture --set ${s} --platform ${pk}`, exitCode: EXIT.CONTRACT });
    const errs = validateManifest(c, { allowCandidate: true });
    if (errs.length) throw new CliError('contract.bad-manifest', `${s} 的候选不合法：${errs.join('；')}`, { hint: '重新采集', exitCode: EXIT.CONTRACT });
    if (c.setHash !== setHash(sets, s)) throw new CliError('contract.stale-candidate', `${s} 的候选是按旧的集合定义截的（sets.json 改过）`, { hint: '按现在的 sets.json 重新采集', exitCode: EXIT.CONTRACT });
    const sha = commit || (commitExists(ROOT, c.source.commit) ? c.source.commit : null);
    if (!sha) throw usage(`候选的源提交 ${c.source.commit.slice(0, 12)} 在本仓库里找不到（CI 的合并提交在 PR 合入后就没有了）`, '用 --commit 指一个像素相关路径与它逐字节相同的提交（例如合入后的 main），工具会按候选记下的摘要核对');
    const digest = pixelTreeDigest(ROOT, sha, c.source.pixelPaths);
    if (digest !== c.source.pixelTree) {
      throw new CliError('contract.not-equivalent', `提交 ${sha.slice(0, 12)} 在 ${s} 用到的像素相关路径上与候选的源提交 ${c.source.commit.slice(0, 12)} 不一样`, {
        hint: '换一个与采集时代码相同的提交；或在那台机器上用现在的代码重新采集', exitCode: EXIT.CONTRACT,
      });
    }
    const approval = { by: opts.by.trim(), reason: opts.reason.trim(), commit: sha, at, ...(opts.ref ? { ref: opts.ref } : {}) };
    const { status, ...rest } = c;
    const baseline = { ...rest, source: { ...c.source, commit: sha, ...(sha !== c.source.commit ? { capturedAt: c.source.commit } : {}) }, approval };
    result.push({ set: s, platformKey: pk, commit: sha, capturedAt: c.source.commit, frames: c.frameCount, after: c.framesDigest, dryRun: !!opts.dryRun });
    log(`${s}（${pk}）：候选 ${c.frameCount} 帧转正，登记提交 ${sha.slice(0, 12)}${sha !== c.source.commit ? `（采集于 ${c.source.commit.slice(0, 12)}，像素路径摘要一致）` : ''}`);
    if (opts.dryRun) continue;
    doc.sets[s] = baseline;
    appendApproval(ROOT, {
      at, kind: 'golden-baseline', set: s, platformKey: pk, device: c.device, by: approval.by, reason: approval.reason, commit: sha,
      ...(opts.ref ? { ref: opts.ref } : {}), capturedAt: c.source.commit, before: null, after: c.framesDigest, setHash: c.setHash,
      added: c.frames.length, removed: 0, changed: 0,
    });
  }
  if (opts.dryRun) return { data: result };
  const f = writePlatform(ROOT, pk, doc);
  return { outputs: [out(f, 'golden-manifest'), out(path.join(ROOT, APPROVALS), 'approval-log')], data: result };
}

// ── keyframes：在本机重建认可参照的关键帧（登记提交渲出的原样 PNG），写到 out/style-baselines/<名@v版本>/keyframes/ ──
// PNG 是渲染产物，不入库（D10）；入库的只有登记 docs/style-baselines/<名@v版本>/keyframes.json（名字 → 帧编号、像素哈希、
// 首次导出时的字节哈希）。先在登记里写好「名字 → 帧编号」，本命令现渲认可参照的登记提交，逐帧核对像素与认可参照清单完全一致后出图；
// 登记里还没有像素哈希（草稿）时顺带补全并写回登记，已登记完整时不改任何入库文件。
// 只能在认可参照已登记的平台上做（像素必须与那个平台的参照清单逐位相同）。
const KEYFRAMES_OUT = path.join(ROOT, 'out/style-baselines');
async function cmdKeyframes(opts, sets) {
  if (!opts.reference) throw usage('keyframes 要用 --reference 指明认可参照，例如 --reference beiming-original@v1');
  checkRefId(opts.reference);
  const id = opts.reference, kfFile = path.join(ROOT, REFERENCE_DIR, id, 'keyframes.json');
  const kf = readManifest(kfFile);
  if (!kf || !Array.isArray(kf.keyframes) || !kf.keyframes.length) {
    throw new CliError('contract.no-keyframes', `没有 ${rel(kfFile)}（或里面没有 keyframes）`, { hint: '先写好 { "schema": "beiming-style-keyframes/v1", "reference": "<名@v版本>", "keyframes": [{ "name": "wide", "frame": "<帧编号>" }] }', exitCode: EXIT.CONTRACT });
  }
  if (kf.schema !== 'beiming-style-keyframes/v1' || kf.reference !== id) throw new CliError('contract.bad-keyframes', `${rel(kfFile)} 的 schema 应为 beiming-style-keyframes/v1、reference 应为 ${id}`, { exitCode: EXIT.CONTRACT });
  for (const k of kf.keyframes) if (!/^[a-z0-9][a-z0-9-]*$/.test(k.name || '') || !k.frame) throw new CliError('contract.bad-keyframes', `关键帧条目要有 name（小写字母、数字、-）与 frame（帧编号）：${JSON.stringify(k)}`, { exitCode: EXIT.CONTRACT });
  const refs = listReferences(ROOT).filter(r => r.id === id);
  if (!refs.length) throw new CliError('contract.no-reference', `认可参照 ${id} 还没有任何平台的清单`, { hint: '先 golden reference 登记', exitCode: EXIT.CONTRACT });
  const any = readManifest(refs[0].file);
  const setName = any.set;
  if (!sets.sets[setName]) throw new CliError('contract.bad-reference', `认可参照 ${id} 登记的集合 ${setName} 在 sets.json 里没有了`, { exitCode: EXIT.CONTRACT });
  // 现渲登记提交（有缓存且 PNG 完好就复用）
  const sha = any.source.commit;
  if (!commitExists(ROOT, sha)) throw new CliError('env.no-commit', `认可参照的登记提交 ${sha.slice(0, 12)} 在本仓库里找不到`, { hint: '用完整克隆（不是浅克隆）', exitCode: EXIT.ENV });
  const got = await captureRefs(sets, [{ setName, sha, want: {} }], opts);
  const r = got.get(refKey(sha, setName));
  const pk = r.manifest.platformKey;
  const refM = readManifest(referencePath(ROOT, id, pk));
  if (!refM) throw new CliError('env.no-reference-platform', `认可参照 ${id} 没有本机平台 ${pk} 的清单，关键帧只能从与参照逐像素一致的渲染导出`, { hint: `在已登记的平台上做：${refs.map(x => x.platformKey).join('、')}`, exitCode: EXIT.ENV });
  // 登记记的是哪个平台的像素：本机就是那个平台（或登记还是草稿）时逐条核对并可补全；别的平台只按本平台的参照清单出图，不碰登记
  const own = !kf.platformKey || kf.platformKey === pk;
  const refById = new Map(refM.frames.map(f => [f.id, f])), gotById = new Map(r.manifest.frames.map(f => [f.id, f]));
  const plan = [];
  for (const k of kf.keyframes) {
    const want = refById.get(k.frame), have = gotById.get(k.frame);
    if (!want) throw new CliError('contract.bad-keyframes', `关键帧 ${k.name} 的帧 ${k.frame} 不在认可参照 ${id} 里`, { hint: `可用帧：${refM.frames.map(f => f.id).join('、')}`, exitCode: EXIT.CONTRACT });
    if (own && k.pixelSha256 && k.pixelSha256 !== want.pixelSha256) {
      throw new CliError('contract.bad-keyframes', `${rel(kfFile)} 里关键帧 ${k.name} 登记的像素哈希与认可参照清单里 ${k.frame} 的不同`, { hint: '登记由本命令生成、冻结不改：手改了就 git checkout 还原', exitCode: EXIT.CONTRACT });
    }
    if (!have || have.pixelSha256 !== want.pixelSha256) {
      throw new CliError('contract.reference-drift', `本机渲出的登记提交 ${sha.slice(0, 12)} 在 ${k.frame} 与认可参照 ${pk} 清单不一致`, { hint: '本机环境（设备、驱动、浏览器）与登记时不同；在登记那台机器上做，或先查清漂移', exitCode: EXIT.CONTRACT });
    }
    plan.push({ k, want, src: path.join(r.dir, have.file) });
  }
  const kfDir = path.join(KEYFRAMES_OUT, id, 'keyframes');
  const entries = [], outputs = [], warnings = [];
  for (const { k, want, src } of plan) {
    const file = path.join(kfDir, `${k.name}.png`);
    const bytes = fs.readFileSync(src), h = sha256(bytes);
    if (!opts.dryRun) { fs.mkdirSync(kfDir, { recursive: true }); fs.writeFileSync(file, bytes); outputs.push(out(file, 'style-keyframe')); }
    if (own && k.sha256 && k.sha256 !== h) warnings.push(`${k.name}：像素与登记一致，PNG 字节与首次导出的不同（浏览器的 PNG 编码器换了）；以像素哈希为准`);
    entries.push({ name: k.name, frame: k.frame, t: want.t, ...(k.shot ? { shot: k.shot } : {}), ...(k.看什么 ? { 看什么: k.看什么 } : {}),
      file: `keyframes/${k.name}.png`, width: want.width, height: want.height, pixelSha256: want.pixelSha256,
      sha256: own && k.sha256 ? k.sha256 : h, bytes: own && k.bytes ? k.bytes : bytes.length });
    log(`${opts.dryRun ? '将写' : '写入'} ${rel(file)}（${(bytes.length / 1048576).toFixed(2)} MiB，像素与 ${pk} 认可参照一致）`);
  }
  const draft = own && kf.keyframes.some(k => !k.pixelSha256);
  if (!own) warnings.push(`${rel(kfFile)} 登记的是 ${kf.platformKey} 的关键帧；本机（${pk}）按本平台的认可参照清单出图，不改登记`);
  if (draft && !opts.dryRun) {
    const doc = { schema: 'beiming-style-keyframes/v1', reference: id, ...(kf.说明 ? { 说明: kf.说明 } : {}), platformKey: pk, commit: sha, set: setName, keyframes: entries };
    fs.writeFileSync(kfFile, JSON.stringify(doc, null, 1) + '\n');
    outputs.push(out(kfFile, 'style-keyframes'));
    log(`补全登记 ${rel(kfFile)}（${entries.length} 个关键帧的像素哈希与字节哈希）：它要入库，PNG 不入库`);
  }
  return { outputs, warnings, data: { reference: id, platformKey: pk, commit: sha, dir: rel(kfDir), registered: draft && !opts.dryRun,
    keyframes: entries.map(e => ({ name: e.name, frame: e.frame, file: rel(path.join(kfDir, `${e.name}.png`)), pixelSha256: e.pixelSha256 })), dryRun: !!opts.dryRun } };
}

// ── list ──
function cmdList(sets) {
  const result = { sets: [], platforms: [], references: [] };
  log('集合（tools/baseline/sets.json）：');
  for (const [name, s] of Object.entries(sets.sets)) {
    log(`  ${name.padEnd(20)} ${s.description || ''}`);
    result.sets.push({ name, description: s.description || '', groups: s.shots.length, setHash: setHash(sets, name) });
  }
  log('平台清单（tests/golden/<平台键>/manifest.json）：');
  const ms = listManifests(ROOT);
  if (!ms.length) log('  （还没有）');
  for (const { platformKey, set, file, m, error } of ms) {
    if (error) { log(`  ${platformKey}：读不出来（${error}）`); continue; }
    const stale = m && sets.sets[set] && m.setHash !== setHash(sets, set);
    const cand = m?.status === 'candidate';
    log(`  ${platformKey}/${set}：${m?.frameCount ?? '?'} 帧，源提交 ${m?.source?.commit?.slice(0, 12) ?? '?'}，${m?.device ?? '?'}，${cand ? '待审批候选' : `审批 ${m?.approval?.by ?? '?'}`}${stale ? '（集合定义已变，待更新）' : ''}`);
    result.platforms.push({ platformKey, set, file: rel(file), frames: m?.frameCount ?? null, commit: m?.source?.commit ?? null, device: m?.device ?? null, status: cand ? 'candidate' : 'approved', stale: !!stale });
  }
  log('认可参照（docs/style-baselines/）：');
  const refs = listReferences(ROOT);
  if (!refs.length) log('  （还没有）');
  for (const { id, platformKey, file } of refs) {
    const m = readManifest(file);
    log(`  ${id}（${platformKey}）：集合 ${m?.set ?? '?'}，${m?.frameCount ?? '?'} 帧，源提交 ${m?.source?.commit?.slice(0, 12) ?? '?'}，登记 ${m?.approval?.by ?? '?'}`);
    result.references.push({ id, platformKey, set: m?.set ?? null, file: rel(file), frames: m?.frameCount ?? null, commit: m?.source?.commit ?? null });
  }
  return { data: result };
}

// ── 命令声明 ──
const camel = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), v]));
const given = v => v === true || (Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined && v !== false);

export const command = defineCommand({
  name: 'golden',
  summary: '金标准基线：证明一次改动没有把画面改坏（PNG 不进 git，仓库只存像素哈希清单与审批记录）',
  usage: [
    'node tools/baseline/golden.mjs compare --set <集合> [--platform <平台键>] [--strict] [--against <提交> | --ref-dir <目录> | --reference <名@v版本>]',
    'node tools/baseline/golden.mjs capture --set <集合> [--platform <平台键>] [--out <目录>]',
    'node tools/baseline/golden.mjs update --set <集合> --by <审批人> --reason <理由> --commit <提交> [--ref <出处>]',
    'node tools/baseline/golden.mjs approve --platform <平台键> --set <集合> --by <审批人> --reason <理由> [--commit <提交>]',
    'node tools/baseline/golden.mjs reference --set <集合> --id <名@v版本> --by <登记人> --reason <认可依据> --commit <提交>',
    'node tools/baseline/golden.mjs keyframes --reference <名@v版本>',
    'node tools/baseline/golden.mjs list',
  ],
  description: () => [
    '子命令：',
    '  capture    截当前工作树，PNG 与截帧清单写到 out/golden/（不改入库文件）；加 --platform 时核对本机平台键，',
    '             并把还没有经审批基线的集合写成「待审批候选」放进 tests/golden/<平台键>/manifest.json（CI 首次采集用），',
    '             另在截帧目录拼一张总览 contact.png（全部帧，4 列），审批人转正前看它',
    '  compare    与本平台清单 tests/golden/<平台键>/manifest.json 比（或 --against 现场渲染另一个提交、--ref-dir 另一台机器的截帧、',
    '             --reference 认可参照）；哈希不同的帧自动现渲清单的源提交取参照像素，再按容差判定，出报告、差异热图与接触印',
    '  update     把当前提交的截帧登记为本平台基线，并在 tests/golden/approvals.jsonl 追加审批记录（必须 --by --reason --commit）',
    '  approve    把另一台机器（通常是 CI）采集的待审批候选转正：不重渲，核对集合定义与像素路径摘要后写审批记录',
    '  reference  冻结一份认可参照 docs/style-baselines/<名@v版本>/<平台键>.json，已存在就拒绝（只增不改）',
    '  keyframes  按登记 docs/style-baselines/<名@v版本>/keyframes.json 在本机重建认可参照的关键帧原样 PNG，写到 out/style-baselines/<名@v版本>/keyframes/',
    '             （像素必须与参照逐位相同，所以只能在参照已登记的平台上做；PNG 不入库，登记还是草稿时顺带补全登记）',
    '  list       列出集合、平台清单与认可参照',
    `集合（tools/baseline/sets.json）：${(() => { try { return Object.keys(JSON.parse(fs.readFileSync(SETS_FILE, 'utf8')).sets).join('、'); } catch { return '（读不出来）'; } })()}`,
    '平台键 = <系统>-<WebGL 后端>，由 WebGL 实际报出的渲染器决定：darwin-metal、win-vulkan、win-d3d11、linux-swiftshader……',
    '同一平台键按像素比（--strict 要求逐像素一致）；不同平台键只按 SSIM / PSNR 容差比。规则与实测阈值见 docs/style-baselines/POLICY.md。',
    '环境变量：BEIMING_ANGLE（metal | vulkan | d3d11 | gl | swiftshader）、BEIMING_CHROME（浏览器可执行文件）。',
  ],
  positionals: [{ name: 'subcommand', label: '<子命令>', describe: Object.keys(SUBS).join(' | ') }],
  options: {
    set: { type: 'list', split: ',', arg: '<集合>', describe: '可重复，也可逗号分隔；capture / compare / update / approve / reference 必须给', example: 'beiming-core' },
    platform: { type: 'string', arg: '<平台键>', describe: 'capture / compare：本机应有的平台键（不符即 exit 3；软件光栅平台如 linux-swiftshader 默认 --gpu software-ok），capture 时另写候选；approve：转正哪个平台的候选', example: 'linux-swiftshader' },
    against: { type: 'string', arg: '<提交>', describe: 'compare：把该提交的页面（约 60 MB）导出到临时目录现场渲染来比；不建 worktree，结束即删', example: 'HEAD~1' },
    'ref-dir': { type: 'string', arg: '<目录>', describe: 'compare：另一台机器 capture 出来的目录（含 capture.json 与 frames/）' },
    reference: { type: 'string', arg: '<名@v版本>', describe: 'compare：与认可参照比；keyframes：导出哪个认可参照的关键帧', example: 'beiming-original@v1' },
    perturb: { type: 'string', arg: '<k=v&…>', describe: 'compare：给当前工作树的页面网址加查询串（不改帧编号），证明闸门抓得到一个已知的小改动，如 lw=2', example: 'lw=2' },
    strict: { type: 'boolean', describe: 'compare：任何不是逐像素一致的帧都算失败（合入前的「像素保护」用这个）' },
    'no-render-ref': { type: 'boolean', describe: 'compare：哈希不同时不自动现渲源提交（只报哈希差异，判为无法核实）' },
    'no-cache': { type: 'boolean', describe: 'compare / keyframes：参照一律现渲，不用 out/golden/cache/ 里的缓存' },
    gpu: { type: 'string', arg: '<策略>', choices: GPU_POLICIES, describe: '落到软件渲染时：required 即 exit 3（默认）；software-ok 给 CI 的 SwiftShader；不写时 --platform 是软件光栅平台就取 software-ok' },
    jobs: { type: 'integer', arg: '<n>', min: 1, max: 16, describe: '同时开几个页面（默认 2）', example: '2' },
    'frame-timeout': { type: 'number', arg: '<秒>', min: 1, max: 3600, describe: '单帧 render + 截图的上限（默认 60）', example: '60' },
    out: { type: 'string', arg: '<目录>', describe: 'capture / compare 的输出目录（默认 out/golden/…）' },
    'work-dir': { type: 'string', arg: '<目录>', describe: '现渲旧提交时临时快照放哪（默认系统临时目录）' },
    by: { type: 'string', arg: '<名字>', describe: 'update / approve / reference：审批人或登记人（人名或角色；agent 不得给自己的画面改动当批准人）' },
    reason: { type: 'string', arg: '<理由>', describe: 'update / approve / reference：为什么 / 认可依据（引用批准出处，如 PR 链接或用户原话出处）' },
    commit: { type: 'string', arg: '<提交>', describe: 'update / reference：登记哪个提交（HEAD，或像素相关路径与 HEAD 逐字节相同的提交）；approve：候选的源提交找不到时指定' },
    ref: { type: 'string', arg: '<出处>', describe: 'update / approve / reference：可选，审批证据的链接或位置' },
    id: { type: 'string', arg: '<名@v版本>', describe: 'reference：认可参照的名字', example: 'beiming-original@v1' },
    'dry-run': { type: 'boolean', describe: 'update / approve / reference / keyframes：只算会改什么，不写文件' },
    sets: { type: 'string', arg: '<文件>', describe: 'capture / compare / list：改用另一份集合定义（测试与实验用）' },
  },
  examples: [
    'node tools/baseline/golden.mjs compare --set beiming-core,lab,templates --strict',
    'node tools/baseline/golden.mjs compare --set lab --perturb lw=2            # 灵敏度自检：应当 exit 4',
    'node tools/baseline/golden.mjs compare --set beiming-core --against HEAD~3   # 二分是哪个提交改了像素',
    'BEIMING_ANGLE=swiftshader node tools/baseline/golden.mjs compare --set beiming-core --set lab --platform linux-swiftshader --json   # CI 冒烟同款',
    'node tools/baseline/golden.mjs update --set lab --by 集成负责人 --reason "PR #12 有意改墨线" --commit HEAD --ref <PR 链接>',
  ],
  exitCodes: {
    0: '通过', 1: '运行失败（页面报错、渲染失败）', 2: '用法错误', 3: '环境不满足（没浏览器、软件渲染被拒、平台键不符、本平台没有基线）',
    4: '不通过（超出容差、无法核实、缺帧、清单或集合不合法、审批前提不满足）', 5: '资源忙（另一个进程在写同一份缓存）', 124: '超时', 130: '收到 SIGINT，已清理', 143: '收到 SIGTERM，已清理',
  },
  async run(ctx) {
    setQuiet(ctx.quiet);
    const sub = ctx.args.subcommand;
    if (!SUBS[sub]) throw usage(`不认识的子命令 ${sub}`, `子命令：${Object.keys(SUBS).join(' | ')}`);
    for (const [k, v] of Object.entries(ctx.opts)) {
      if (['json', 'quiet', 'help', 'version'].includes(k) || !given(v)) continue;
      if (!SUBS[sub].includes(k)) throw new CliError('usage.option-not-allowed', `${sub} 不接受 --${k}`, { hint: `${sub} 可用：${SUBS[sub].map(x => `--${x}`).join(' ')}`, exitCode: EXIT.USAGE });
    }
    const done = bindCleanups(ctx);
    try {
      const opts = camel(ctx.opts);
      const sets = loadSets(opts.sets ? path.resolve(opts.sets) : SETS_FILE);
      if (sub === 'list') return cmdList(sets);
      const o = normalizeOpts(opts);
      const r = sub === 'capture' ? await cmdCapture(o, sets) : sub === 'compare' ? await cmdCompare(o, sets)
        : sub === 'approve' ? await cmdApprove(o, sets) : sub === 'keyframes' ? await cmdKeyframes(o, sets)
          : await cmdUpdate(o, sets, { reference: sub === 'reference' });
      return echoWarnings(r);
    } finally { await done(); }
  },
});

if (isMain(import.meta.url)) await runCli(command);
