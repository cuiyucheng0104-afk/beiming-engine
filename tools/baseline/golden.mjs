#!/usr/bin/env node
// 北冥仓库 · 金标准基线：证明一次改动没有把画面改坏。PNG 不进 git（D10），仓库只存每帧像素哈希的清单与审批记录。
//   node tools/baseline/golden.mjs <capture|compare|update|list> [选项]      （--help 看全部）
// 设计与阈值：docs/style-baselines/POLICY.md；集合定义：tools/baseline/sets.json；清单：tests/golden/manifests/<平台键>/。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMain, CliError, EXIT, usage, log, onCleanup, offCleanup, sha256File, displayPath } from './lib/cli.mjs';
import { loadSets, setHash } from './lib/sets.mjs';
import { captureSet, captureUsable, assertCaptured } from './lib/capture.mjs';
import { compareFrames, summaryLine, worstStats } from './lib/compare.mjs';
import { git, headCommit, resolveCommit, dirtyPixelPaths, withSnapshot, runId, isGitRepo } from './lib/git.mjs';
import { manifestPath, toBaseline, validateManifest, diffFrames, appendApproval, readManifest, listManifests, APPROVALS } from './lib/manifest.mjs';
import { osKey } from './lib/platform.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SETS_FILE = path.join(ROOT, 'tools/baseline/sets.json');
const OUT = path.join(ROOT, 'out/golden');

const HELP = `北冥仓库 · 金标准基线（golden）

用法：
  node tools/baseline/golden.mjs capture --set <集合> [--set …]          截当前工作树，PNG 与截帧清单写到 out/golden/（不改任何入库文件）
  node tools/baseline/golden.mjs compare --set <集合> [--against <提交>]  与本平台的基线清单比（或现场渲染另一个提交来比）
  node tools/baseline/golden.mjs update  --set <集合> --by <审批人> --reason <理由> --commit <提交>
                                                                          把当前提交的截帧登记为基线，并追加审批记录
  node tools/baseline/golden.mjs list                                     列出集合与已有清单

集合（tools/baseline/sets.json）：beiming-core（《北冥》40 帧 + 原生 4K 4 帧）、lab（10 个自测页 × 6 帧）、
  templates（A、C 模版各 6 帧）、beiming-detail（切点 ±1、声画事件帧、关键时刻、无显示层与后期中间层）、fixtures（测试夹具）

compare 的参照（三选一）：
  默认              tests/golden/manifests/<平台键>/<集合>.json；哈希不同的帧自动现渲清单的源提交取参照像素，再按容差判定
  --against <提交>  把该提交的页面（引擎、样片、自测页、素材、字体、模版，约 60 MB）导出到临时目录现场渲染，结束即删；
                    逐帧比，用来二分定位是哪个提交改了像素。不建 git worktree，不改仓库任何状态
  --ref-dir <目录>  另一台机器 capture 出来的目录（含 capture.json 与 frames/）；平台键不同时按跨平台容差（SSIM / PSNR）比

选项：
  --set <集合>             可重复，也可逗号分隔；capture / compare / update 必须给
  --strict                 compare：任何不是逐像素一致的帧都算失败（合入前的「像素保护」用这个）
  --no-render-ref          compare：哈希不同时不自动现渲源提交（只报哈希差异，判为无法核实）
  --no-cache               compare：参照一律现渲，不用 out/golden/cache/ 里的缓存
  --gpu <策略>             required（默认：落到软件渲染即 exit 3）| any | software-ok（CI 的 SwiftShader、有意的软件渲染）
  --jobs <n>               同时开几个页面（默认 2）
  --frame-timeout <秒>     单帧 render + 截图的上限（默认 60）
  --out <目录>             capture / compare 的输出目录
  --work-dir <目录>        --against 与现渲参照的临时快照放哪（默认系统临时目录）
  --by <名字>              update：审批人（人名或角色，不能空）
  --reason <理由>          update：为什么要更新基线（引用审批来源，如 PR 链接或用户原话出处）
  --commit <提交>          update：登记哪个提交；必须等于当前 HEAD，且像素相关路径没有未提交改动
  --ref <出处>             update：可选，审批证据的链接或位置
  --dry-run                update：只算会改哪些帧，不写清单
  --sets <文件>            capture / compare / list：改用另一份集合定义（测试与实验用；update 只认 tools/baseline/sets.json）
  --json                   stdout 只输出一个 JSON 信封（{ok, exitCode, command, error, outputs, runJson, warnings}）

退出码：0 通过；1 运行失败（页面报错、渲染失败）；2 用法错误；3 环境不满足（没浏览器、软件渲染被拒、本平台没有基线）；
       4 不通过（超出容差、无法核实、缺帧、清单或集合不合法、update 前提不满足）；5 资源忙（另一个进程在写同一份缓存）；
       124 超时；130 / 143 收到中断，已清理。
环境变量：BEIMING_ANGLE（metal | vulkan | d3d11 | gl | swiftshader）、BEIMING_CHROME（指定浏览器可执行文件），与出片相同。
`;

const SPEC = {
  flags: {
    '--set': 'list', '--against': 'string', '--ref-dir': 'string', '--strict': 'bool', '--no-render-ref': 'bool', '--no-cache': 'bool',
    '--gpu': 'string', '--jobs': 'int', '--frame-timeout': 'number', '--out': 'string', '--work-dir': 'string',
    '--by': 'string', '--reason': 'string', '--commit': 'string', '--ref': 'string', '--dry-run': 'bool', '--sets': 'string', '--json': 'bool',
  },
  positionals: [1, 1],
};
const ALLOWED = {
  capture: ['--set', '--gpu', '--jobs', '--frame-timeout', '--out', '--sets', '--json'],
  compare: ['--set', '--against', '--ref-dir', '--strict', '--no-render-ref', '--no-cache', '--gpu', '--jobs', '--frame-timeout', '--out', '--work-dir', '--sets', '--json'],
  update: ['--set', '--by', '--reason', '--commit', '--ref', '--dry-run', '--gpu', '--jobs', '--frame-timeout', '--json'],
  list: ['--sets', '--json'],
};

function checkFlags(cmd, argv) {
  if (!ALLOWED[cmd]) throw usage(`不认识的子命令 ${cmd}`, '子命令：capture | compare | update | list');
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const name = a.split('=')[0];
    if (name !== '--help' && !ALLOWED[cmd].includes(name)) throw usage(`${cmd} 不接受 ${name}`, `${cmd} 可用：${ALLOWED[cmd].join(' ')}`);
  }
}

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
      if (alive && pid !== process.pid) throw new CliError('busy', `另一个进程（pid ${pid}）正在写 ${rel(dir)}`, { hint: '等它结束再跑；确认它已不存在时删掉同名 .lock 文件', exitCode: EXIT.BUSY });
      fs.rmSync(f, { force: true });
    }
  }
  throw new CliError('busy', `拿不到锁 ${rel(dir)}.lock`, { exitCode: EXIT.BUSY });
}

// 截一个集合到 dir（先写到临时目录，成功后整体改名，半截的缓存永远不会被当成可用）
async function captureInto({ tree, sets, setName, dir, opts, source }) {
  const release = lock(dir);
  const tmp = `${dir}.tmp-${process.pid}`;
  const rmTmp = () => fs.rmSync(tmp, { recursive: true, force: true });
  rmTmp.sync = rmTmp;
  onCleanup(rmTmp);
  try {
    rmTmp();
    const { manifest, failures } = await captureSet({
      tree, sets, setName, outDir: tmp, gpu: opts.gpu, jobs: opts.jobs, frameTimeoutMs: opts.frameTimeoutMs, log, source,
    });
    assertCaptured(failures);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(tmp, dir);
    return manifest;
  } finally {
    offCleanup(rmTmp); rmTmp(); release();
  }
}

function sourceOf(tree) {
  const { sha } = headCommit(tree);
  const dirty = dirtyPixelPaths(tree);
  return { commit: sha, dirty: dirty.length > 0, ...(dirty.length ? { dirtyPaths: dirty.slice(0, 50) } : {}) };
}

async function captureCurrent(sets, setName, opts, dir) {
  const source = sourceOf(ROOT);
  log(`截 ${setName}（${source.commit ? source.commit.slice(0, 7) : '无 git'}${source.dirty ? '，有未提交的像素相关改动' : ''}）→ ${rel(dir)}`);
  const manifest = await captureInto({ tree: ROOT, sets, setName, dir, opts, source });
  log(`  ${manifest.frames.length} 帧，${manifest.seconds} 秒，平台 ${manifest.platformKey}（${manifest.renderer}），浏览器 ${manifest.browser}`);
  return { manifest, dir };
}

// 参照：现场渲染提交（有缓存且环境一致就复用）。requests = [{ setName, sha, want }]，同一个提交的多个集合只导出一次快照
const refKey = (sha, setName) => `${sha}/${setName}`;
function pagePaths(sets, names) {
  const ps = new Set();
  for (const n of names) for (const g of sets.sets[n].shots) {
    const p = sets.pages[g.page];
    for (const r of [p.dir, p.template, p.requires]) if (r && r !== '.') ps.add(r);
  }
  return [...ps];
}
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
        const manifest = await captureInto({ tree, sets, setName: r.setName, dir, opts, source: { commit: sha, dirty: false } });
        got.set(refKey(sha, r.setName), { manifest, dir });
      }
    };
    if (sha === head && clean) { log(`参照 ${sha.slice(0, 7)} 就是当前工作树（干净），直接截`); await run(ROOT); }
    else await withSnapshot(ROOT, sha, { workDir: opts.workDir, log, paths: pagePaths(sets, reqs.map(r => r.setName)) }, run);
  }
  return got;
}
const commitExists = sha => git(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], { cwd: ROOT, allowFail: true }) != null;

function normalizeOpts(o) {
  const gpu = o.gpu || 'required';
  if (!['required', 'any', 'software-ok'].includes(gpu)) throw usage(`--gpu 只能是 required | any | software-ok，现在是 ${gpu}`);
  if (o.jobs != null && (o.jobs < 1 || o.jobs > 16)) throw usage('--jobs 要在 1–16 之间');
  if (o.frameTimeout != null && !(o.frameTimeout > 0 && o.frameTimeout <= 3600)) throw usage('--frame-timeout 要在 0–3600 秒之间');
  return { ...o, gpu, jobs: o.jobs || 2, frameTimeoutMs: Math.round((o.frameTimeout || 60) * 1000) };
}
function needSets(sets, names) {
  if (!names.length) throw usage('要用 --set 指定集合', `可用集合：${Object.keys(sets.sets).join('、')}`);
  for (const n of names) if (!sets.sets[n]) throw usage(`没有集合 ${n}`, `可用集合：${Object.keys(sets.sets).join('、')}`);
  return [...new Set(names)];
}

// ── capture ──
// 输出：--out 给了就写 <out>/<集合>/；工作树干净时写缓存 out/golden/cache/<提交>/<系统-后端>/<集合>/（compare 取参照像素时复用）；
// 否则写 out/golden/runs/<运行编号>/<集合>/
async function cmdCapture(opts, sets) {
  const outputs = [], result = [];
  const source = sourceOf(ROOT), id = runId(ROOT);
  for (const s of needSets(sets, opts.set)) {
    const dir = opts.out ? path.resolve(opts.out, s) : source.commit && !source.dirty ? cacheDir(source.commit, s) : path.join(OUT, 'runs', id, s);
    const { manifest } = await captureCurrent(sets, s, opts, dir);
    outputs.push(out(path.join(dir, 'capture.json'), 'golden-capture'));
    result.push({ set: s, dir: rel(dir), platformKey: manifest.platformKey, device: manifest.device, frames: manifest.frames.length, seconds: manifest.seconds, source: manifest.source });
  }
  return { outputs, result };
}

// ── compare ──
// 三步：① 截当前工作树的每个集合；② 定参照（--against / --ref-dir / 本平台清单），需要现渲的按提交分组、每个提交只导出一次快照；③ 逐集合比对、出报告
async function cmdCompare(opts, sets) {
  const names = needSets(sets, opts.set);
  if (opts.against && opts.refDir) throw usage('--against 与 --ref-dir 只能二选一');
  const againstSha = opts.against ? resolveCommit(ROOT, opts.against) : null;
  const id = runId(ROOT);
  const reportRoot = opts.out ? path.resolve(opts.out) : path.join(OUT, 'compare', id);
  const outputs = [], warnings = [], result = [];
  let failed = false, envMissing = false;

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
      if (!m) throw new CliError('no-ref', `--ref-dir 里找不到 ${s} 的 capture.json：${d}`, { hint: '传 golden capture 输出的目录（含 capture.json 与 frames/）', exitCode: EXIT.ENV });
      plan[s] = { kind: 'dir', m, dir: d };
    } else {
      const mf = manifestPath(ROOT, curM.platformKey, s);
      const m = readManifest(mf);
      if (!m) {
        envMissing = true;
        warnings.push(`本平台（${curM.platformKey}）还没有 ${s} 的基线清单：${rel(mf)}`);
        result.push({ set: s, ok: false, error: 'no-baseline', platformKey: curM.platformKey });
        continue;
      }
      const errs = validateManifest(m);
      if (errs.length) throw new CliError('bad-manifest', `${rel(mf)} 不合法：${errs.join('；')}`, { hint: '清单只能由 golden update 生成', exitCode: EXIT.CONTRACT });
      if (m.setHash !== curM.setHash) warnings.push(`${s}：集合定义与基线清单不一致（sets.json 改过），多出 / 缺少的帧要经审批 update`);
      if (m.device !== curM.device || m.browser !== curM.browser) warnings.push(`${s}：基线来自 ${m.device} / 浏览器 ${m.browser}，本机是 ${curM.device} / ${curM.browser}；哈希不同的帧会现渲基线提交来区分「代码改动」与「环境漂移」`);
      const curById = new Map(curM.frames.map(f => [f.id, f]));
      const differing = m.frames.filter(f => curById.get(f.id) && curById.get(f.id).pixelSha256 !== f.pixelSha256);
      plan[s] = { kind: 'manifest', m, mf, differing: differing.length };
      if (differing.length && !opts.noRenderRef) {
        if (!commitExists(m.source.commit)) warnings.push(`${s}：基线源提交 ${m.source.commit.slice(0, 12)} 在本仓库里找不到（浅克隆？），${differing.length} 帧哈希不同却拿不到参照像素`);
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
      refLabel = `清单 ${rel(P.mf)}（源提交 ${m.source.commit.slice(0, 12)}）`;
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
    const report = {
      schemaVersion: 1, kind: 'golden-compare', set: s, mode, strict, tolerance,
      reference: refLabel, current: { dir: rel(cur[s].dir), source: curM.source, platformKey: curM.platformKey, device: curM.device, renderer: curM.renderer, browser: curM.browser, env: curM.env },
      ok: cmp.ok, summary: cmp.summary, worst: worstStats(cmp.frames), drift, contact: cmp.contact,
      frames: cmp.frames,
    };
    fs.mkdirSync(dir, { recursive: true });
    const rp = path.join(dir, 'report.json');
    fs.writeFileSync(rp, JSON.stringify(report, null, 1) + '\n');
    outputs.push(out(rp, 'golden-report'));
    if (cmp.contact) outputs.push(out(path.join(dir, cmp.contact), 'contact-sheet'));
    log(`${cmp.ok ? '通过' : '不通过'} ${s}（${mode === 'cross-platform' ? '跨平台' : '同平台'}${strict ? '，严格' : ''}）对 ${refLabel}：${summaryLine(cmp.summary)}`);
    for (const f of cmp.frames.filter(x => !['identical', 'within'].includes(x.status)).slice(0, 12)) {
      log(`  ✗ ${f.id}：${f.status}${f.reasons ? ` · ${f.reasons.join('；')}` : ''}${f.diff ? ` · 热图 ${rel(path.join(dir, f.diff))}` : ''}`);
    }
    if (!cmp.ok) failed = true;
    result.push({ set: s, ok: cmp.ok, mode, summary: cmp.summary, worst: report.worst, report: rel(rp) });
  }
  if (failed) {
    return { exitCode: EXIT.CONTRACT, outputs, warnings, result, runJson: outputs[0]?.path ?? null,
      error: { code: 'golden-mismatch', message: '与基线不一致（见报告与差异热图）', hint: '确认是有意的画面改动后，请审批人用 golden update 更新基线；否则修代码' } };
  }
  if (envMissing) {
    return { exitCode: EXIT.ENV, outputs, warnings, result,
      error: { code: 'no-baseline', message: warnings.find(w => w.includes('还没有')), hint: '先 capture 再由审批人 update 建立本平台基线；或用 --against <提交> 现场对比' } };
  }
  return { outputs, warnings, result, runJson: outputs[0]?.path ?? null };
}

// ── update ──
async function cmdUpdate(opts, sets) {
  const names = needSets(sets, opts.set);
  for (const k of ['by', 'reason', 'commit']) if (!opts[k] || !String(opts[k]).trim()) throw usage(`update 必须写 --${k}`, '基线更新要留审批记录：--by 审批人 --reason 理由 --commit 对应提交');
  if (!isGitRepo(ROOT)) throw new CliError('no-git', '不在 git 工作树里，没法登记来源提交', { exitCode: EXIT.ENV });
  const sha = resolveCommit(ROOT, opts.commit), head = headCommit(ROOT).sha;
  if (sha !== head) throw new CliError('not-head', `--commit ${opts.commit}（${sha.slice(0, 12)}）不是当前 HEAD（${head.slice(0, 12)}）`, { hint: `先 git checkout ${sha.slice(0, 12)} 再登记，基线必须由被登记的那个提交渲出来`, exitCode: EXIT.CONTRACT });
  const dirty = dirtyPixelPaths(ROOT);
  if (dirty.length) throw new CliError('dirty', `像素相关路径有未提交改动：${dirty.slice(0, 8).join('、')}${dirty.length > 8 ? ' …' : ''}`, { hint: '先提交或还原这些改动；基线只能来自已提交的代码', exitCode: EXIT.CONTRACT });
  const outputs = [], result = [];
  for (const s of names) {
    const cur = await captureCurrent(sets, s, opts, cacheDir(sha, s));
    const m = cur.manifest;
    const approval = { by: opts.by.trim(), reason: opts.reason.trim(), commit: sha, at: new Date().toISOString(), ...(opts.ref ? { ref: opts.ref } : {}) };
    const baseline = toBaseline(m, approval);
    const mf = manifestPath(ROOT, m.platformKey, s);
    const before = readManifest(mf);
    const d = diffFrames(before?.frames, baseline.frames);
    const same = before && before.framesDigest === baseline.framesDigest && before.setHash === baseline.setHash;
    log(`${s} → ${rel(mf)}：${before ? `新增 ${d.added.length}、删除 ${d.removed.length}、像素变化 ${d.changed.length}` : `首次建立（${baseline.frames.length} 帧）`}${same ? '（与现有基线逐帧相同）' : ''}`);
    result.push({ set: s, manifest: rel(mf), platformKey: m.platformKey, device: m.device, frames: baseline.frames.length, before: before?.framesDigest ?? null, after: baseline.framesDigest, ...d, dryRun: !!opts.dryRun });
    if (opts.dryRun) continue;
    fs.mkdirSync(path.dirname(mf), { recursive: true });
    fs.writeFileSync(mf, JSON.stringify(baseline, null, 1) + '\n');
    appendApproval(ROOT, {
      at: approval.at, set: s, platformKey: m.platformKey, device: m.device, by: approval.by, reason: approval.reason, commit: sha,
      ...(opts.ref ? { ref: opts.ref } : {}), before: before?.framesDigest ?? null, after: baseline.framesDigest, setHash: baseline.setHash, ...d,
    });
    outputs.push(out(mf, 'golden-manifest'));
  }
  if (!opts.dryRun) outputs.push(out(path.join(ROOT, APPROVALS), 'approval-log'));
  return { outputs, result };
}

// ── list ──
function cmdList(sets) {
  const ms = listManifests(ROOT).map(x => ({ ...x, m: readManifest(x.file) }));
  const result = { sets: [], manifests: [] };
  log('集合（tools/baseline/sets.json）：');
  for (const [name, s] of Object.entries(sets.sets)) {
    log(`  ${name.padEnd(15)} ${s.description || ''}`);
    result.sets.push({ name, description: s.description || '', groups: s.shots.length, setHash: setHash(sets, name) });
  }
  log('基线清单（tests/golden/manifests/）：');
  if (!ms.length) log('  （还没有）');
  for (const { platformKey, set, file, m } of ms) {
    const stale = m && sets.sets[set] && m.setHash !== setHash(sets, set);
    log(`  ${platformKey}/${set}：${m?.frameCount ?? '?'} 帧，源提交 ${m?.source?.commit?.slice(0, 12) ?? '?'}，${m?.device ?? '?'}，审批 ${m?.approval?.by ?? '?'}${stale ? '（集合定义已变，待更新）' : ''}`);
    result.manifests.push({ platformKey, set, file: rel(file), frames: m?.frameCount ?? null, commit: m?.source?.commit ?? null, device: m?.device ?? null, stale: !!stale });
  }
  return { result };
}

await runMain({
  command: 'golden', spec: SPEC, help: HELP,
  main: async ({ opts, positionals }) => {
    const cmd = positionals[0];
    checkFlags(cmd, process.argv.slice(2));
    const sets = loadSets(opts.sets ? path.resolve(opts.sets) : SETS_FILE);
    if (cmd === 'list') return cmdList(sets);
    const o = normalizeOpts(opts);
    if (cmd === 'capture') return cmdCapture(o, sets);
    if (cmd === 'compare') return cmdCompare(o, sets);
    return cmdUpdate(o, sets);
  },
});
