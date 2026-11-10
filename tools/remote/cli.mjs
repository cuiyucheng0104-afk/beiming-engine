#!/usr/bin/env node
// 北冥仓库 · 控制机 ↔ 工作站协作：让另一台机器按指定提交运行仓库命令（自检、建环境、出片），实时转发日志，取回产物并逐个核对 sha256。
//   node tools/remote/cli.mjs machines                                   列出机器档案
//   node tools/remote/cli.mjs check  <机器>                              连得上吗、远端 node / git / 显卡
//   node tools/remote/cli.mjs setup  <机器> [--commit <rev>]             在远端按该提交的锁文件建环境
//   node tools/remote/cli.mjs doctor <机器> [--commit <rev>] [--route a|b|c] [--gpu required]
//   node tools/remote/cli.mjs render <机器> films/<名> [--commit <rev>] [--profile <档位>]   用 tools/film/cli.mjs build 出片并取回
//   node tools/remote/cli.mjs run    <机器> [--commit <rev>] [--fetch <路径或模式>]… -- <命令…>
//   node tools/remote/cli.mjs cleanup <机器> [--run <run-id>] [--all]
// 机器档案在仓库外（BEIMING_MACHINES 或 ~/.config/beiming/machines.json），也可以用 --ssh / --shell / --root 临时给出；格式见 tools/remote/README.md。
// 做法：git bundle 只发远端缺的提交 → 远端缓存仓库里按 sha 建独立工作树 → 整机槽位锁 → （setup）→ 运行命令 → 产物与运行记录回传 → 本地核对 sha256 → 删除远端工作树。
// 退出码：远端命令的退出码原样返回；0 成功；2 用法错误；3 连不上或远端缺工具；5 远端槽位被占；1 传输或核对失败；130/143 中断（远端随即停止并清理）。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT, CliError, runCli, isMain, log, usageError, onCleanup, choice } from '../env/lib/cli.mjs';
import { resolveMachine, loadMachines, machinesFile } from './lib/profiles.mjs';
import { makeTransport, killTransports } from './lib/transport.mjs';
import { encodeToken } from './lib/shell.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const AGENT = path.join(ROOT, 'tools', 'remote', 'agent.mjs');
onCleanup(() => killTransports());

const HELP = `北冥仓库 · 控制机 ↔ 工作站

用法：
  node tools/remote/cli.mjs machines [--json]
  node tools/remote/cli.mjs check   <机器> [--json]
  node tools/remote/cli.mjs setup   <机器> [--commit <rev>] [--json]
  node tools/remote/cli.mjs doctor  <机器> [--commit <rev>] [--route a|b|c] [--gpu required] [--json]
  node tools/remote/cli.mjs render  <机器> films/<名> [--commit <rev>] [--profile <档位>] [--json]
  node tools/remote/cli.mjs run     <机器> [--commit <rev>] [--fetch <路径或模式>]… [--dest <本地目录>] -- <命令…>
  node tools/remote/cli.mjs cleanup <机器> [--run <run-id>] [--all] [--json]

通用选项：
  --commit <rev>      在远端运行的提交（默认 HEAD）；工作区有未提交改动时拒绝，除非加 --allow-dirty（远端仍只拿到已提交的内容）
  --no-setup          不在远端跑 npm run setup（该提交没有环境工具时用，环境靠机器档案的 env）
  --wait <秒>         远端槽位被占时排队等待（默认不等，直接 exit 5）
  --keep              保留远端工作树（排查问题用；之后 remote cleanup）
  --dest <目录>       产物放到本地哪里（render 默认按原路径放回仓库，例如 films/<名>/out/<run-id>/；run 默认 out/remote/<机器>/<run-id>/）
  --machines <文件>   机器档案（默认 ${machinesFile().replace(os.homedir(), '~')}，可用 BEIMING_MACHINES 改）
  --ssh <目标> --shell posix|powershell --root <远端目录> --transport ssh|local   不用档案，临时给出一台机器（机器名写 adhoc）
  --json              stdout 只输出一个 JSON 对象（C2 信封）

远端只需要：OpenSSH 服务（密钥登录）、git、Node 22+；其余（npm 依赖、浏览器、Python 3.12 环境）由 setup 按该提交的锁文件建好，
Python 环境按锁文件哈希在远端共享。产物逐个核对 sha256 后才算取回；运行记录（机器指纹、提交、命令、耗时、哈希）写到 out/remote/<机器>/<run-id>.json。
退出码：远端命令的退出码原样返回；2 用法错误；3 连不上或远端缺工具；5 远端槽位被占；1 传输或核对失败；130/143 中断（远端随即停止并清理）。`;

const sha256File = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
// 输出里的路径：仓库内写相对仓库根的路径（/ 分隔），仓库外写绝对路径，不写成 ../../ 这种难读的形式
const shown = p => { const r = path.relative(ROOT, p); return (r.startsWith('..') || path.isAbsolute(r) ? path.resolve(p) : r).split(path.sep).join('/'); };
function git(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20, ...opts });
  if (r.error) throw new CliError(EXIT.ENV, 'git-missing', '控制机上没有 git', '安装 git');
  return r;
}

function resolveCommit(rev = 'HEAD', allowDirty = false) {
  const r = git(['rev-parse', '--verify', `${rev}^{commit}`]);
  if (r.status !== 0) throw usageError(`找不到提交 ${rev}`, '用 git log 查一个存在的提交');
  const sha = r.stdout.trim();
  if (rev === 'HEAD' && !allowDirty) {
    const st = git(['status', '--porcelain', '--untracked-files=no']).stdout.trim();
    if (st) throw usageError('工作区有未提交的改动：远端只能拿到已提交的内容', '先提交（或 git stash），再运行；确实只想用已提交的版本时加 --allow-dirty');
  }
  return sha;
}

async function agent(t, m, op, req, opts = {}) {
  const agentRemote = t.remotePath(m.root, 'bin', `agent-${sha256File(AGENT).slice(0, 12)}.mjs`);
  const r = await t.exec([m.node, agentRemote, op, encodeToken({ root: m.root, git: m.git, ...req })], opts);
  if (r.error) throw new CliError(EXIT.ENV, 'transport', `无法连接 ${t.describe()}：${r.error.code || r.error.message}`, t.kind === 'ssh' ? '确认控制机有 ssh 客户端，且 ssh <目标> 能免密登录' : '检查 root 目录');
  if (r.code === 255 && t.kind === 'ssh') throw new CliError(EXIT.ENV, 'ssh-failed', `ssh 连接失败：${r.stderr.trim().split('\n').pop()}`, '先手动试 ssh <目标> 能否免密登录（只支持密钥），再检查机器档案的 ssh 与 sshOptions');
  const line = r.stdout.trim().split('\n').reverse().find(l => l.trim().startsWith('{'));
  let j = null;
  try { j = line && JSON.parse(line); } catch { /* 下面报错 */ }
  if (!j) {
    const tail = r.stderr.trim().split('\n').slice(-3).join(' / ');
    if (/not recognized|not found|找不到|无法将/.test(r.stderr)) throw new CliError(EXIT.ENV, 'node-missing', `远端找不到 node：${tail}`, '在机器档案里把 node 写成完整路径（非交互 ssh 会话的 PATH 常常更短）');
    throw new CliError(EXIT.FAIL, 'agent-output', `远端 agent 没有返回结果（退出码 ${r.code}）：${tail}`, '加 --keep 重跑，登录工作站看 <root>/runs 下的日志');
  }
  return j;
}

async function upload(t, m) {
  const binDir = t.remotePath(m.root, 'bin');
  // 代码里不用双引号和空格：Windows PowerShell 5.1 把参数传给原生程序时会吞掉双引号
  const mk = await t.exec([m.node, '-e', "require('fs').mkdirSync(process.argv[1],{recursive:true})", binDir], { onStderr: null });
  if (mk.error || mk.code !== 0) {
    if (mk.code === 255 && t.kind === 'ssh') throw new CliError(EXIT.ENV, 'ssh-failed', `ssh 连接失败：${mk.stderr.trim().split('\n').pop()}`, '先手动试 ssh <目标> 能否免密登录（只支持密钥）');
    throw new CliError(EXIT.ENV, 'node-missing', `远端运行 node 失败：${(mk.stderr || mk.error?.message || '').trim().split('\n').pop()}`, '确认远端装了 Node 22+；在机器档案里把 node 写成完整路径');
  }
  await t.put(AGENT, t.remotePath(binDir, `agent-${sha256File(AGENT).slice(0, 12)}.mjs`));
}

// 只发远端缺的对象：在临时目录建一个借用本仓库对象库的裸仓库，在那里建引用再打包，不改动本仓库的任何引用
function makeBundle(sha, remoteTips, dir) {
  const common = path.resolve(ROOT, git(['rev-parse', '--git-common-dir']).stdout.trim());
  const tmp = path.join(dir, 'bundle.git');
  if (git(['init', '--bare', '--quiet', tmp]).status !== 0) throw new CliError(EXIT.FAIL, 'bundle-failed', '建临时仓库失败');
  fs.writeFileSync(path.join(tmp, 'objects', 'info', 'alternates'), path.join(common, 'objects') + '\n');
  git(['-C', tmp, 'update-ref', 'refs/beiming/run', sha]);
  const not = remoteTips.filter(s => git(['-C', tmp, 'cat-file', '-e', `${s}^{commit}`]).status === 0 && git(['-C', tmp, 'merge-base', '--is-ancestor', s, sha]).status === 0);
  const out = path.join(dir, 'run.bundle');
  const r = git(['-C', tmp, 'bundle', 'create', '--quiet', out, 'refs/beiming/run', ...not.map(s => `^${s}`)]);
  if (r.status !== 0) throw new CliError(EXIT.FAIL, 'bundle-failed', `git bundle 失败：${r.stderr.trim()}`);
  return { file: out, size: fs.statSync(out).size, incremental: not.length > 0 };
}

async function remoteRun(m, { sha, cmd, fetch = [], setup = true, wait = 0, keep = false, dest = null, label }) {
  const t = makeTransport(m);
  const t0 = Date.now();
  log(`远程：${t.describe()}，提交 ${sha.slice(0, 12)}`);
  await upload(t, m);
  const prep = await agent(t, m, 'prepare', { sha });
  const runId = prep.runId;
  let bundle = false;
  if (!prep.have) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-remote-'));
    onCleanup(() => fs.rmSync(dir, { recursive: true, force: true }));
    const b = makeBundle(sha, prep.tips || [], dir);
    log(`发送代码包 ${(b.size / 1048576).toFixed(1)} MiB（${b.incremental ? '增量' : '首次，完整历史'}）…`);
    await t.put(b.file, t.remotePath(m.root, 'runs', `${runId}.bundle`));
    fs.rmSync(dir, { recursive: true, force: true });
    bundle = true;
  }
  const res = await agent(t, m, 'run', { sha, runId, bundle, cmd, fetch, setup, wait, slots: m.slots, env: m.env, watchStdin: true }, { keepStdin: true });
  const manifest = res.manifest || null;
  const files = manifest?.files || [];
  const machineDir = path.join(ROOT, 'out', 'remote', m.name);
  const destRoot = dest ? path.resolve(dest) : label === 'render' ? ROOT : path.join(machineDir, runId);
  const fetched = [], bad = [];
  if (res.runDir && files.length) {
    for (const f of files) {
      const local = path.join(destRoot, ...f.path.split('/'));
      if (fs.existsSync(local) && sha256File(local) !== f.sha256) { bad.push(`${f.path}：本地已有同名但内容不同的文件，没有覆盖`); continue; }
      await t.get(t.remotePath(res.runDir, ...f.path.split('/')), local);
      const got = sha256File(local);
      if (got !== f.sha256) { bad.push(`${f.path}：sha256 不一致（远端 ${f.sha256.slice(0, 12)}，取回 ${got.slice(0, 12)}）`); fs.rmSync(local, { force: true }); continue; }
      fetched.push({ path: shown(local), sha256: got, kind: 'remote-output', size: f.size });
    }
  }
  let manifestLocal = null;
  if (manifest) {
    fs.mkdirSync(machineDir, { recursive: true });
    manifestLocal = path.join(machineDir, `${runId}.json`);
    fs.writeFileSync(manifestLocal, JSON.stringify({ ...manifest, machineProfile: m.name, transport: t.kind, fetched, fetchProblems: bad, controller: { host: os.hostname(), platform: process.platform }, wallSeconds: (Date.now() - t0) / 1000 }, null, 2) + '\n');
  }
  if (!keep && res.runId) await agent(t, m, 'cleanup', { runId }).catch(e => log(`清理远端工作树失败（${e.message}），之后运行 remote cleanup ${m.name}`));
  return { res, runId, fetched, bad, manifestLocal, seconds: +((Date.now() - t0) / 1000).toFixed(1) };
}

function finish(r, label) {
  const remoteCode = r.res.exitCode ?? EXIT.FAIL;
  const exitCode = remoteCode !== 0 ? remoteCode : r.bad.length ? EXIT.FAIL : EXIT.OK;
  const outputs = [...r.fetched, ...(r.manifestLocal ? [{ path: shown(r.manifestLocal), sha256: sha256File(r.manifestLocal), kind: 'remote-run' }] : [])];
  return {
    exitCode, outputs, runJson: r.manifestLocal ? shown(r.manifestLocal) : null,
    error: remoteCode !== 0 ? (r.res.error || { code: 'remote-failed', message: `远端退出码 ${remoteCode}`, hint: '看上面转发的日志' })
      : r.bad.length ? { code: 'fetch-mismatch', message: `取回校验失败：${r.bad.join('；')}`, hint: '重跑；已核对通过的文件保留在本地' } : null,
    remote: { runId: r.runId, machine: r.res.manifest?.machine || null, timing: r.res.manifest?.timing || null, envelope: r.res.manifest?.envelope || null },
    human: `${label}：远端退出码 ${remoteCode}；取回 ${r.fetched.length} 个文件（sha256 全部核对${r.bad.length ? `，${r.bad.length} 个失败` : '通过'}）；运行记录 ${r.manifestLocal ? shown(r.manifestLocal) : '无'}；用时 ${r.seconds} 秒${r.fetched.length ? `\n${r.fetched.map(f => `  ${f.path}  ${f.sha256.slice(0, 16)}…`).join('\n')}` : ''}`,
  };
}

const SUBS = ['machines', 'check', 'setup', 'doctor', 'render', 'run', 'cleanup'];

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  const dd = argv.indexOf('--');
  const passthrough = dd >= 0 ? argv.slice(dd + 1) : [];
  runCli({
    command: `remote ${argv[0] || ''}`.trim(), help: HELP, argv: dd >= 0 ? argv.slice(0, dd) : argv, maxPositionals: 3,
    options: {
      commit: { type: 'string' }, 'allow-dirty': { type: 'boolean' }, 'no-setup': { type: 'boolean' }, wait: { type: 'string' }, keep: { type: 'boolean' },
      dest: { type: 'string' }, fetch: { type: 'string', multiple: true }, route: { type: 'string', multiple: true }, gpu: { type: 'string' }, profile: { type: 'string' },
      run: { type: 'string' }, all: { type: 'boolean' }, machines: { type: 'string' }, ssh: { type: 'string' }, shell: { type: 'string' }, root: { type: 'string' }, transport: { type: 'string' },
    },
    run: async (o, pos) => {
      const [sub, name, target] = pos;
      if (!sub) throw usageError(`缺少子命令（${SUBS.join(' / ')}）`);
      if (!SUBS.includes(sub)) throw usageError(`不认识的子命令 ${sub}（可选：${SUBS.join('、')}）`);
      if (sub === 'machines') {
        const db = loadMachines({ file: o.machines });
        const list = Object.entries(db.machines).map(([n, mm]) => ({ name: n, transport: mm.transport || 'ssh', ssh: mm.ssh || null, shell: mm.shell || null, root: mm.root || null }));
        return { exitCode: db.error ? EXIT.USAGE : EXIT.OK, error: db.error ? { code: 'usage', message: db.error, hint: '改正 JSON' } : null, file: db.file, machines: list,
          human: db.missing ? `还没有机器档案：${db.file}（格式见 tools/remote/README.md）` : `${db.file}\n${list.map(x => `  ${x.name.padEnd(12)} ${x.transport} ${x.ssh || ''} ${x.shell || ''} ${x.root || ''}`).join('\n') || '  （空）'}` };
      }
      const overrides = { transport: o.transport && choice('--transport', o.transport, ['ssh', 'local']), ssh: o.ssh, shell: o.shell && choice('--shell', o.shell, ['posix', 'powershell']), root: o.root };
      let m;
      try { m = resolveMachine(name, { file: o.machines, overrides }); } catch (e) { throw usageError(e.message, e.hint); }
      const wait = o.wait === undefined ? 0 : Number(o.wait);
      if (!Number.isFinite(wait) || wait < 0) throw usageError('--wait 要是不小于 0 的秒数');
      if (sub === 'check') {
        const t = makeTransport(m);
        await upload(t, m);
        const r = await agent(t, m, 'hello', {});
        const mc = r.machine || {};
        return { machine: mc, human: `${t.describe()}：${mc.hostname} ${mc.platform} ${mc.arch}，Node ${mc.node}，${mc.git || '没有 git'}${mc.gpus?.length ? `，${mc.gpus.map(g => `${g.name}（占用 ${g.util}%）`).join('、')}` : ''}` };
      }
      if (sub === 'cleanup') {
        const t = makeTransport(m);
        await upload(t, m);
        const r = await agent(t, m, 'cleanup', { runId: o.run, stale: !o.run, all: !!o.all });
        return { removed: r.removed, human: `已清理 ${r.removed?.length || 0} 个远端运行目录${r.removed?.length ? `：${r.removed.join('、')}` : ''}` };
      }
      const sha = resolveCommit(o.commit || 'HEAD', !!o['allow-dirty']);
      const common = { sha, setup: !o['no-setup'], wait, keep: !!o.keep, dest: o.dest };
      if (sub === 'setup') return finish(await remoteRun(m, { ...common, setup: true, cmd: ['node', '-e', 'console.log(JSON.stringify({ok:true,exitCode:0,command:"remote setup",error:null,outputs:[],runJson:null,warnings:[]}))'], label: 'setup' }), 'setup');
      if (sub === 'doctor') {
        const routes = (o.route || []).flatMap(r => r.split(',')).map(r => choice('--route', r.trim(), ['a', 'b', 'c']));
        const gpu = o.gpu ? ['--gpu', choice('--gpu', o.gpu, ['required', 'software-ok'])] : [];
        const r = await remoteRun(m, { ...common, cmd: ['node', 'tools/env/doctor.mjs', '--json', ...routes.flatMap(x => ['--route', x]), ...gpu], label: 'doctor' });
        const out = finish(r, 'doctor');
        return { ...out, doctor: r.res.manifest?.envelope || null };
      }
      if (sub === 'render') {
        if (!target) throw usageError('render 要写作品目录，例如 films/my-film');
        const film = target.replace(/\\/g, '/').replace(/\/+$/, '');
        if (!/^films\/[a-z0-9][a-z0-9-]*$/.test(film)) throw usageError(`作品目录要写成 films/<名字>（名字只用小写字母、数字与连字符）：${target}`);
        if (git(['cat-file', '-e', `${sha}:${film}/film.json`]).status !== 0) throw usageError(`提交 ${sha.slice(0, 12)} 里没有 ${film}/film.json`, '先提交作品目录（只提交源码，不提交 out/）');
        if (git(['cat-file', '-e', `${sha}:tools/film/cli.mjs`]).status !== 0) throw new CliError(EXIT.ENV, 'film-cli-missing', `提交 ${sha.slice(0, 12)} 里还没有统一出片命令 tools/film/cli.mjs`, '换到包含 tools/film 的提交；或用 remote run … -- <出片命令> --fetch <产物路径>');
        const cmd = ['node', 'tools/film/cli.mjs', 'build', film, '--json', ...(o.profile ? ['--profile', o.profile] : [])];
        return finish(await remoteRun(m, { ...common, cmd, fetch: o.fetch || [], label: 'render' }), 'render');
      }
      if (!passthrough.length) throw usageError('run 要在 -- 后面写远端命令，例如：remote run <机器> -- node tools/env/doctor.mjs --json');
      return finish(await remoteRun(m, { ...common, cmd: passthrough, fetch: o.fetch || [], label: 'run' }), 'run');
    },
  });
}

export { resolveCommit, makeBundle };
