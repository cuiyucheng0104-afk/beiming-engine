// 北冥仓库 · 远程机器档案：放在仓库外（主机名、账号、盘符都不进仓库），也可以全部用命令行参数临时给出。
//
// 档案位置：BEIMING_MACHINES；未设时 $XDG_CONFIG_HOME/beiming/machines.json；再未设时 ~/.config/beiming/machines.json
// 格式：
//   { "machines": { "<名字>": {
//       "transport": "ssh",                 ssh（默认）或 local（同一台机器上的另一个目录，测试与单机用）
//       "ssh": "<用户>@<主机>",             ssh 目标，可写 ~/.ssh/config 里的 Host 别名；只支持密钥登录（BatchMode）
//       "sshOptions": ["-p", "22"],         可选，原样加在 ssh / scp 前面
//       "shell": "powershell",              远端登录 shell：powershell（Windows）或 posix（macOS / Linux）
//       "root": "D:/beiming-remote",        远端工作根目录：只能是 ASCII、不含空格（缓存仓库、运行目录、锁、共享依赖都在这里）
//       "node": "node", "git": "git",       远端命令名或完整路径（非交互 ssh 会话里 PATH 常常更短）
//       "env": { "BEIMING_ANGLE": "vulkan" },   远端运行时附加的环境变量
//       "slots": 1                          这台机器同时允许几个远程任务（整机锁）
//   } } }
//
// 接口：machinesFile(env)、loadMachines({file, env}) → {file, machines, error}、resolveMachine(name, {file, env, overrides}) → 校验过的档案（不合格时抛错，带 hint）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function machinesFile(env = process.env) {
  if (env.BEIMING_MACHINES) return path.resolve(env.BEIMING_MACHINES);
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'beiming', 'machines.json');
}

export function loadMachines({ file, env = process.env } = {}) {
  const p = file ? path.resolve(file) : machinesFile(env);
  if (!fs.existsSync(p)) return { file: p, machines: {}, missing: true };
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { file: p, machines: j.machines || {} };
  } catch (e) {
    return { file: p, machines: {}, error: `机器档案 ${p} 不是合法 JSON：${e.message}` };
  }
}

const SAFE_ROOT = /^[A-Za-z0-9_:/\\.\-]+$/;

export function validateMachine(name, m) {
  const errors = [];
  const out = {
    name, transport: m.transport || 'ssh', ssh: m.ssh || null, sshOptions: Array.isArray(m.sshOptions) ? m.sshOptions.map(String) : [],
    shell: m.shell || (m.transport === 'local' ? (process.platform === 'win32' ? 'powershell' : 'posix') : 'posix'), root: m.root || null,
    node: m.node || 'node', git: m.git || 'git', env: m.env || {}, slots: m.slots ?? 1,
  };
  if (!['ssh', 'local'].includes(out.transport)) errors.push(`transport 只能是 ssh 或 local，收到 ${out.transport}`);
  if (out.transport === 'ssh' && !out.ssh) errors.push('缺 ssh（例如 render@workstation，或 ~/.ssh/config 里的 Host 别名）');
  if (!['posix', 'powershell'].includes(out.shell)) errors.push(`shell 只能是 posix 或 powershell，收到 ${out.shell}`);
  if (!out.root) errors.push('缺 root（远端工作根目录，例如 D:/beiming-remote 或 /srv/beiming-remote）');
  else if (!SAFE_ROOT.test(out.root)) errors.push(`root 只能用 ASCII 字母、数字与 _ : / \\ . -，不能有空格或中文：${out.root}`);
  if (!Number.isInteger(out.slots) || out.slots < 1) errors.push(`slots 要是正整数，收到 ${out.slots}`);
  if (typeof out.env !== 'object' || Array.isArray(out.env) || Object.values(out.env).some(v => typeof v !== 'string')) errors.push('env 要是 {变量名: 字符串}');
  return { machine: out, errors };
}

export function resolveMachine(name, { file, env = process.env, overrides = {} } = {}) {
  const set = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined && v !== null));
  const adhoc = Object.keys(set).length > 0 && (name === undefined || name === 'adhoc');
  const db = loadMachines({ file, env });
  if (db.error) throw Object.assign(new Error(db.error), { hint: '改正这个文件的 JSON 语法' });
  let base = {};
  if (!adhoc) {
    if (!name) throw Object.assign(new Error('没有指定机器'), { hint: `写机器名（档案 ${db.file}），或用 --ssh/--shell/--root 临时给出` });
    base = db.machines[name];
    if (!base) {
      const names = Object.keys(db.machines);
      throw Object.assign(new Error(`机器档案里没有「${name}」${db.missing ? `（${db.file} 不存在）` : ''}`),
        { hint: names.length ? `已有：${names.join('、')}` : `新建 ${db.file}，格式见 tools/remote/README.md；或用 --ssh/--shell/--root 临时给出` });
    }
  }
  const { machine, errors } = validateMachine(adhoc ? 'adhoc' : name, { ...base, ...set });
  if (errors.length) throw Object.assign(new Error(`机器「${machine.name}」的档案不合格：${errors.join('；')}`), { hint: `改 ${db.file}，格式见 tools/remote/README.md` });
  return machine;
}
