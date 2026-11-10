#!/usr/bin/env node
// 北冥仓库 · 仓库规范检查的「画面基线」规则（只读：不渲染、不开浏览器、不改文件，几百毫秒内跑完）。
// 规则插件约定（供 tools/repo-check 的执行器加载）：
//   export const domain = 'baseline'
//   export const rules = [{ id, title, check(ctx) → findings[] }]
//     ctx = { root }：仓库根目录（绝对路径）
//     finding = { level: 'error' | 'warn', message, file?, hint? }：error 让检查不通过，warn 只提示
// 也能单独跑：node tools/repo-check/rules/baseline/index.mjs [--root <目录>] [--json]
//   退出码按附录 C1：0 没有 error；2 用法错误；4 有 error。--json 时 stdout 只有一个信封对象，人读输出走 stderr。
//
// 规则：
//   baseline.sets             tools/baseline/sets.json 结构合法
//   baseline.manifests        tests/golden/manifests/<平台键>/<集合>.json 都是工具生成的合法清单（摘要对得上、有审批、源提交干净），
//                             集合存在、目录名与平台键一致、没有本机路径；集合定义改了而清单没更新 → 提示
//   baseline.approvals        tests/golden/approvals.jsonl 每行可解析且字段齐全；每份清单的摘要都有一条审批记录
//   baseline.references       docs/style-baselines/<名>@v<版本>/：有 README.md；各平台清单是认可参照、名字与目录一致、
//                             同一参照的各平台登记同一提交与同一集合定义
//   baseline.no-render-products  tests/golden/ 与 docs/style-baselines/ 下不入库图片和视频（D10：渲染产物不进 git）
//   baseline.media-provenance docs/style-baselines/media-provenance.json 覆盖 media/ 的每个文件且 sha256 一致
//   baseline.determinism-scan engine 浏览器端代码、films/、路线模版里没有未登记的 Math.random / Date.now / performance.now / new Date；
//                             存量登记失效（已经扫不到）→ 提示删掉
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateSets, setHash } from '../../../baseline/lib/sets.mjs';
import { validateManifest, readApprovals, listManifests, listReferences, MANIFEST_DIR, REFERENCE_DIR, APPROVALS } from '../../../baseline/lib/manifest.mjs';
import { scanFiles, listFiles, defaultTargets, loadAllow } from '../../../baseline/lib/scan.mjs';

export const domain = 'baseline';

const rel = (root, p) => path.relative(root, p).split(path.sep).join('/');
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const LOCAL_PATH = /(?:\/Users\/|\/home\/[^/"]+\/|[A-Za-z]:\\\\Users\\\\|\/private\/var\/|\/private\/tmp\/)/;

function loadSetsSafe(root) {
  const f = path.join(root, 'tools/baseline/sets.json');
  if (!fs.existsSync(f)) return { sets: null, error: '没有 tools/baseline/sets.json' };
  try {
    const j = readJson(f);
    const errs = validateSets(j);
    return errs.length ? { sets: null, error: errs.join('；') } : { sets: j };
  } catch (e) { return { sets: null, error: `读不出来（${e.message}）` }; }
}

// 仓库跟踪的文件：git ls-files；不在 git 里（例如解压的发行包）时退回目录遍历
function trackedFiles(root, dir) {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--', dir], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    return out.split('\0').filter(Boolean);
  } catch {
    const out = [], base = path.join(root, dir);
    const walk = d => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) out.push(rel(root, p)); } };
    walk(base);
    return out;
  }
}
const sha256File = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

export const rules = [
  {
    id: 'baseline.sets', title: '金标准集合定义合法',
    check({ root }) {
      const { error } = loadSetsSafe(root);
      return error ? [{ level: 'error', file: 'tools/baseline/sets.json', message: error, hint: '照文件里现有集合的写法改；时刻写法见 tools/baseline/lib/sets.mjs 开头' }] : [];
    },
  },
  {
    id: 'baseline.manifests', title: '回归基线清单由工具生成、与集合定义一致',
    check({ root }) {
      const out = [];
      const { sets } = loadSetsSafe(root);
      for (const { platformKey, set, file } of listManifests(root)) {
        const f = rel(root, file);
        let m;
        try { m = readJson(file); } catch (e) { out.push({ level: 'error', file: f, message: `读不出来（${e.message}）` }); continue; }
        for (const e of validateManifest(m)) out.push({ level: 'error', file: f, message: e, hint: '清单只能由 node tools/baseline/golden.mjs update 生成，不要手改' });
        if (m.platformKey && m.platformKey !== platformKey) out.push({ level: 'error', file: f, message: `放在 ${platformKey}/ 下，清单里却是 ${m.platformKey}` });
        if (m.set && m.set !== set) out.push({ level: 'error', file: f, message: `文件名是 ${set}，清单里却是集合 ${m.set}` });
        if (LOCAL_PATH.test(fs.readFileSync(file, 'utf8'))) out.push({ level: 'error', file: f, message: '清单里有本机绝对路径', hint: '用 golden update 重新生成；清单只记相对信息' });
        if (sets) {
          if (!sets.sets[set]) out.push({ level: 'error', file: f, message: `tools/baseline/sets.json 里没有集合 ${set}`, hint: '集合删了就把清单一起删（并在审批记录里写明）' });
          else if (m.setHash && m.setHash !== setHash(sets, set)) out.push({ level: 'warn', file: f, message: `集合 ${set} 的定义改过，清单还是旧定义`, hint: `审批后 node tools/baseline/golden.mjs update --set ${set} …` });
        }
      }
      return out;
    },
  },
  {
    id: 'baseline.approvals', title: '每份清单都有审批记录',
    check({ root }) {
      const out = [], f = APPROVALS;
      const recs = readApprovals(root);
      recs.forEach((r, i) => {
        if (r.invalid) { out.push({ level: 'error', file: f, message: `第 ${r.line} 行不是合法 JSON` }); return; }
        for (const k of ['at', 'set', 'platformKey', 'by', 'reason', 'commit', 'after']) if (!r[k]) out.push({ level: 'error', file: f, message: `第 ${i + 1} 行缺 ${k}` });
      });
      const known = new Set(recs.filter(r => !r.invalid).map(r => `${r.platformKey}/${r.set}/${r.after}`));
      for (const { platformKey, set, file } of listManifests(root)) {
        let m; try { m = readJson(file); } catch { continue; }
        if (!known.has(`${platformKey}/${set}/${m.framesDigest}`)) out.push({ level: 'error', file: rel(root, file), message: '这份清单在 tests/golden/approvals.jsonl 里没有对应的审批记录（after 摘要对不上）', hint: '清单只能由 golden update 生成，它会同时追加审批记录' });
      }
      for (const { id, platformKey, file } of listReferences(root)) {
        let m; try { m = readJson(file); } catch { continue; }
        if (!recs.some(r => r.kind === 'style-reference' && r.referenceId === id && r.platformKey === platformKey && r.after === m.framesDigest)) {
          out.push({ level: 'error', file: rel(root, file), message: `认可参照 ${id}（${platformKey}）没有登记记录`, hint: '认可参照只能由 golden reference 生成' });
        }
      }
      return out;
    },
  },
  {
    id: 'baseline.references', title: '认可参照冻结、成套',
    check({ root }) {
      const out = [], dir = path.join(root, REFERENCE_DIR);
      if (!fs.existsSync(dir)) return out;
      const byId = new Map();
      for (const r of listReferences(root)) { if (!byId.has(r.id)) byId.set(r.id, []); byId.get(r.id).push(r); }
      for (const name of fs.readdirSync(dir)) {
        const d = path.join(dir, name);
        if (!fs.statSync(d).isDirectory() || name === 'records') continue;
        if (!/^[a-z0-9][a-z0-9-]*@v[1-9][0-9]*$/.test(name)) { out.push({ level: 'error', file: rel(root, d), message: `认可参照目录要叫 <名>@v<版本>（现在是 ${name}）` }); continue; }
        if (!fs.existsSync(path.join(d, 'README.md'))) out.push({ level: 'error', file: rel(root, d), message: '认可参照缺 README.md（是什么、认可依据、怎么用）' });
        const files = byId.get(name) || [];
        if (!files.length) out.push({ level: 'error', file: rel(root, d), message: '认可参照目录里没有任何平台清单（<平台键>.json）', hint: 'node tools/baseline/golden.mjs reference --set <集合> --id <名>@v<版本> …' });
        const seen = [];
        for (const { platformKey, file } of files) {
          const f = rel(root, file);
          let m; try { m = readJson(file); } catch (e) { out.push({ level: 'error', file: f, message: `读不出来（${e.message}）` }); continue; }
          for (const e of validateManifest(m)) out.push({ level: 'error', file: f, message: e });
          if (m.kind !== 'style-reference' || m.referenceId !== name) out.push({ level: 'error', file: f, message: `不是 ${name} 的认可参照清单（kind=${m.kind}，referenceId=${m.referenceId}）` });
          if (m.platformKey !== platformKey) out.push({ level: 'error', file: f, message: `文件名是 ${platformKey}，清单里却是 ${m.platformKey}` });
          seen.push({ platformKey, commit: m.source?.commit, setHash: m.setHash });
        }
        const commits = new Set(seen.map(s => s.commit)), hashes = new Set(seen.map(s => s.setHash));
        if (commits.size > 1 || hashes.size > 1) out.push({ level: 'error', file: rel(root, d), message: `同一个认可参照的各平台清单登记了不同的提交或集合定义：${seen.map(s => `${s.platformKey}@${String(s.commit).slice(0, 12)}`).join('、')}`, hint: '补登记新平台时用同一个提交与同一份集合定义' });
      }
      return out;
    },
  },
  {
    id: 'baseline.no-render-products', title: '渲染产物不进仓库（D10）',
    check({ root }) {
      const bad = [...trackedFiles(root, 'tests/golden'), ...trackedFiles(root, REFERENCE_DIR)]
        .filter(f => /\.(png|jpe?g|webp|gif|mp4|mov|webm|exr|tiff?)$/i.test(f));
      return bad.map(f => ({ level: 'error', file: f, message: '基线目录里入库了图片或视频', hint: 'PNG 只在 out/golden/ 本地缓存；需要分发时作为 Release 附件，清单里记 pngSha256' }));
    },
  },
  {
    id: 'baseline.media-provenance', title: 'media/ 的每个文件都有来源记录',
    check({ root }) {
      const out = [], pf = path.join(root, REFERENCE_DIR, 'media-provenance.json'), f = rel(root, pf);
      const media = trackedFiles(root, 'media');
      if (!fs.existsSync(pf)) return media.length ? [{ level: 'error', file: f, message: '没有 media 来源清单', hint: '每个 media/ 文件记 sha256、来源提交、生成命令、环境' }] : [];
      let j; try { j = readJson(pf); } catch (e) { return [{ level: 'error', file: f, message: `读不出来（${e.message}）` }]; }
      if (j.schema !== 'beiming-media-provenance/v1') out.push({ level: 'error', file: f, message: 'schema 应为 beiming-media-provenance/v1' });
      const recs = new Map((j.files || []).map(r => [r.path, r]));
      for (const m of media) {
        const r = recs.get(m);
        if (!r) { out.push({ level: 'error', file: m, message: `${f} 里没有这个文件的来源记录`, hint: '补一条：sha256、sourceCommit（查不到写 sourceState）、command、environment、status' }); continue; }
        for (const k of ['sha256', 'command', 'status']) if (!r[k]) out.push({ level: 'error', file: f, message: `${m} 的记录缺 ${k}` });
        if (!('sourceCommit' in r) || (r.sourceCommit === null && !r.sourceState)) out.push({ level: 'error', file: f, message: `${m} 的记录要写 sourceCommit，查不到时写 sourceState 说明来源` });
        if (r.sha256 && r.sha256 !== sha256File(path.join(root, m))) out.push({ level: 'error', file: m, message: `文件换了，来源记录还是旧的 sha256（${r.sha256.slice(0, 12)}…）`, hint: `换 media 文件时同步更新 ${f}` });
      }
      for (const p of recs.keys()) if (!media.includes(p)) out.push({ level: 'warn', file: f, message: `记录了 ${p}，仓库里已经没有这个文件` });
      return out;
    },
  },
  {
    id: 'baseline.determinism-scan', title: '渲染路径不用不确定的 API',
    check({ root }) {
      const out = [], allowFile = path.join(root, 'tools/baseline/determinism-allow.json');
      let allow = [];
      try { allow = loadAllow(allowFile); } catch (e) { return [{ level: 'error', file: rel(root, allowFile), message: `读不出来（${e.message}）` }]; }
      const r = scanFiles(root, listFiles(root, defaultTargets(root)), allow);
      for (const e of r.errors) out.push({ level: 'error', file: `${e.file}:${e.line}`, message: `${e.api}：${e.text}`, hint: '改成由 t 与固定种子算出；只用于计时打日志的写法在同一行写 // determinism-ok: <理由>' });
      // 存量登记只减不增：扫 src/ 与默认范围，登记过却已经扫不到的条目提示删掉
      const all = scanFiles(root, listFiles(root, [...defaultTargets(root), 'src']), allow).findings;
      for (const a of allow) {
        if (!all.some(f => f.file === a.file && f.api === a.api && a.re.test(f.text))) out.push({ level: 'warn', file: rel(root, allowFile), message: `存量登记已失效（${a.file} 里扫不到 ${a.api}）`, hint: '删掉这一条' });
      }
      return out;
    },
  },
];

export function runRules(root) {
  const results = [];
  for (const r of rules) {
    let findings;
    try { findings = r.check({ root }); } catch (e) { findings = [{ level: 'error', message: `规则本身出错（${e.message}）`, hint: '按报错修好对应文件后再跑' }]; }
    results.push({ id: r.id, title: r.title, findings });
  }
  return results;
}

// ── 单独运行 ──
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const argv = process.argv.slice(2);
  const wantJson = argv.includes('--json');
  const HELP = `仓库规范检查 · 画面基线规则（只读，不渲染）

用法：node tools/repo-check/rules/baseline/index.mjs [--root <仓库目录>] [--json]

规则：${rules.map(r => r.id).join('、')}
退出码：0 没有 error（可能有提示）；2 用法错误；4 有 error。
`;
  const fail = (code, msg) => {
    if (wantJson) process.stdout.write(JSON.stringify({ ok: false, exitCode: code, command: 'repo-check:baseline', error: { code: 'usage', message: msg, hint: '用 --help 看用法' }, outputs: [], runJson: null, warnings: [] }) + '\n');
    else console.error(`用法错误：${msg}`);
    process.exit(code);
  };
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(HELP); process.exit(0); }
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') continue;
    if (argv[i] === '--root') { if (!argv[i + 1]) fail(2, '--root 后面要跟目录'); root = path.resolve(argv[++i]); continue; }
    fail(2, `不认识的参数 ${argv[i]}`);
  }
  if (!fs.existsSync(root)) fail(2, `目录不存在：${root}`);
  const results = runRules(root);
  const errors = results.flatMap(r => r.findings.filter(f => f.level === 'error').map(f => ({ rule: r.id, ...f })));
  const warns = results.flatMap(r => r.findings.filter(f => f.level === 'warn').map(f => ({ rule: r.id, ...f })));
  for (const r of results) {
    const e = r.findings.filter(f => f.level === 'error').length, w = r.findings.filter(f => f.level === 'warn').length;
    console.error(`${e ? '✗' : '✓'} ${r.id}（${r.title}）${e ? `：${e} 个错误` : ''}${w ? `，${w} 个提示` : ''}`);
    for (const f of r.findings) console.error(`    ${f.level === 'error' ? '错误' : '提示'} ${f.file ? `${f.file}：` : ''}${f.message}${f.hint ? `\n      下一步：${f.hint}` : ''}`);
  }
  const exitCode = errors.length ? 4 : 0;
  if (wantJson) {
    process.stdout.write(JSON.stringify({
      ok: !errors.length, exitCode, command: 'repo-check:baseline',
      error: errors.length ? { code: 'rule-violation', message: `${errors.length} 个错误`, hint: '按每条的下一步修' } : null,
      outputs: [], runJson: null, warnings: warns.map(w => `${w.rule} ${w.file || ''} ${w.message}`.trim()), result: results,
    }) + '\n');
  }
  process.exit(exitCode);
}
