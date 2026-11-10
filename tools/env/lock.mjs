#!/usr/bin/env node
// 北冥仓库 · 生成与核对 Python 锁文件：requirements.in → requirements.lock（Python 3.12；macOS arm64、Windows x64、Linux x64；带哈希）。
//   node tools/env/lock.mjs              按锁文件头里记录的 exclude-newer 时间点重新生成（结果可复现）
//   node tools/env/lock.mjs --upgrade    把时间点挪到今天，取范围内的最新版本
//   node tools/env/lock.mjs --check      重新解析并与现有锁文件比较，不写文件；过期时 exit 4
//   node tools/env/lock.mjs --json       输出 C2 信封
// 需要 uv 与网络（读 PyPI 元数据）。不联网的一致性检查（输入哈希、版本固定、每个包都有哈希）由 repo-check 的 env 规则负责。
// 做法：uv pip compile --universal --python-version 3.12 --generate-hashes --only-binary :all: --exclude-newer <时间点>；
// 另对三个目标平台各解析一次（--python-platform），确认每个平台都有二进制轮子且版本与通用锁一致。
import fs from 'node:fs';
import path from 'node:path';
import { EXIT, CliError, runCli, isMain, log } from './lib/cli.mjs';
import { run, which } from './lib/proc.mjs';
import { ROOT } from './lib/python.mjs';
import { parseLock, sha256, normalizeName } from './lib/lockfile.mjs';

const SPEC = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/env/spec.json'), 'utf8'));

const HELP = `北冥仓库 · Python 锁文件

用法：
  node tools/env/lock.mjs [--upgrade] [--check] [--json]

  （无参数）   按锁文件头记录的时间点重新生成 requirements.lock（同一时间点结果相同）
  --upgrade    时间点改为今天，取 requirements.in 范围内的最新版本
  --check      只比较不写文件；锁文件与重新解析的结果不同时 exit 4
  --json       stdout 只输出一个 JSON 对象（C2 信封）

需要 uv（${SPEC.python.uvFix[process.platform] || SPEC.python.uvFix.linux}）与网络。
退出码：0 成功；2 用法错误；3 没有 uv；4 --check 发现锁文件过期；1 解析失败。`;

function header({ inputSha, excludeNewer, uvVersion }) {
  return [
    '# 北冥仓库 · Python 依赖锁文件（自动生成，不要手改）',
    '# 生成：node tools/env/lock.mjs        核对：node tools/env/lock.mjs --check        升级：node tools/env/lock.mjs --upgrade',
    `# input: requirements.in sha256=${inputSha}`,
    `# python: ${SPEC.python.version}`,
    `# targets: ${SPEC.lockTargets.map(t => t.id).join(', ')}`,
    `# exclude-newer: ${excludeNewer}`,
    `# uv: ${uvVersion}`,
    '# 安装：npm run setup（uv pip sync --require-hashes --only-binary :all:；没有 uv 时 pip install --require-hashes --only-binary :all: --no-deps -r requirements.lock）',
    '',
  ].join('\n');
}

async function compile(uv, args) {
  const r = await run(uv, ['pip', 'compile', path.join(ROOT, SPEC.python.input), '--python-version', SPEC.python.version, '--only-binary', ':all:', '--no-header', '--quiet', ...args],
    { cwd: ROOT, timeout: 300_000, env: { ...process.env, UV_NO_PROGRESS: '1' } });
  if (r.code !== 0) throw new CliError(EXIT.FAIL, 'resolve-failed', `uv pip compile 失败：${(r.stderr || r.error?.message || '').trim().split('\n').slice(-6).join(' / ')}`,
    '检查网络或镜像（UV_DEFAULT_INDEX）；requirements.in 的范围是否在某个平台上没有 Python 3.12 的二进制轮子');
  return r.stdout;
}

export async function buildLock({ upgrade = false } = {}) {
  const uv = which('uv');
  if (!uv) throw new CliError(EXIT.ENV, 'uv-missing', '生成锁文件需要 uv', SPEC.python.uvFix[process.platform] || SPEC.python.uvFix.linux);
  const uvVersion = (await run(uv, ['--version'])).stdout.trim().replace(/^uv\s+/, '');
  const inPath = path.join(ROOT, SPEC.python.input), lockPath = path.join(ROOT, SPEC.python.lock);
  const inputSha = sha256(fs.readFileSync(inPath));
  const old = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf8') : null;
  const excludeNewer = (!upgrade && old && parseLock(old).header.excludeNewer) || `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
  log(`解析：Python ${SPEC.python.version}，时间点 ${excludeNewer}，uv ${uvVersion}`);
  const body = await compile(uv, ['--universal', '--generate-hashes', '--exclude-newer', excludeNewer, '--annotation-style', 'line']);
  const text = header({ inputSha, excludeNewer, uvVersion }) + body.replace(/\r\n/g, '\n').trimEnd() + '\n';
  const lock = parseLock(text);
  const universal = new Map(lock.pins.map(p => [p.name, p]));
  const problems = [];
  for (const p of lock.pins) {
    if (p.invalid) problems.push(`无法识别的行：${p.name}`);
    if (!p.hashes.length) problems.push(`${p.name} 没有哈希`);
  }
  const perTarget = {};
  for (const t of SPEC.lockTargets) {
    const out = await compile(uv, ['--python-platform', t.uvPlatform, '--exclude-newer', excludeNewer, '--no-annotate']);
    const pins = parseLock(out).pins;
    perTarget[t.id] = pins.map(p => `${p.name}==${p.version}`);
    for (const p of pins) {
      const u = universal.get(p.name);
      if (!u) problems.push(`${t.id} 需要 ${p.name}==${p.version}，通用锁里没有`);
      else if (u.version !== p.version) problems.push(`${t.id} 解析出 ${p.name}==${p.version}，通用锁是 ${u.version}`);
    }
    const names = new Set(pins.map(p => p.name));
    for (const u of lock.pins) if (!u.marker && !names.has(u.name)) problems.push(`${t.id} 的解析结果缺少 ${u.name}`);
  }
  if (problems.length) throw new CliError(EXIT.FAIL, 'lock-inconsistent', `三平台解析不一致：${problems.join('；')}`, '调整 requirements.in 的范围，使三个平台解析到同一组版本');
  const top = fs.readFileSync(inPath, 'utf8').split(/\r?\n/).map(l => l.replace(/#.*$/, '').trim()).filter(Boolean)
    .map(l => normalizeName(/^[A-Za-z0-9._-]+/.exec(l)[0]));
  for (const n of top) if (!universal.has(n)) problems.push(`顶层依赖 ${n} 不在锁文件里`);
  if (problems.length) throw new CliError(EXIT.FAIL, 'lock-inconsistent', problems.join('；'));
  return { text, old, lockPath, perTarget, excludeNewer, uvVersion, pins: lock.pins.map(p => `${p.name}==${p.version}${p.marker ? ` ; ${p.marker}` : ''}`) };
}

// 比较时忽略 uv 版本行：换 uv 小版本不算锁文件过期
const comparable = t => (t || '').split('\n').filter(l => !/^# uv: /.test(l)).join('\n');

if (isMain(import.meta.url)) {
  runCli({
    command: 'env:lock', help: HELP,
    options: { upgrade: { type: 'boolean' }, check: { type: 'boolean' } },
    run: async (o) => {
      const r = await buildLock({ upgrade: o.upgrade });
      const rel = path.relative(ROOT, r.lockPath);
      if (o.check) {
        const same = comparable(r.text) === comparable(r.old);
        return {
          exitCode: same ? EXIT.OK : EXIT.CONTRACT,
          error: same ? null : { code: 'lock-stale', message: `${rel} 与 requirements.in 重新解析的结果不同`, hint: '运行 node tools/env/lock.mjs 重新生成并提交' },
          lock: { path: rel, upToDate: same, excludeNewer: r.excludeNewer, pins: r.pins, perTarget: r.perTarget },
          human: same ? `${rel} 是最新的（${r.pins.length} 个包，三平台一致）` : '',
        };
      }
      fs.writeFileSync(r.lockPath, r.text);
      return {
        outputs: [{ path: rel, sha256: sha256(r.text), kind: 'lock' }],
        lock: { path: rel, excludeNewer: r.excludeNewer, pins: r.pins, perTarget: r.perTarget },
        human: `已写 ${rel}：${r.pins.length} 个包，时间点 ${r.excludeNewer}，三平台（${SPEC.lockTargets.map(t => t.id).join('、')}）解析一致\n${r.pins.map(p => '  ' + p).join('\n')}`,
      };
    },
  });
}
