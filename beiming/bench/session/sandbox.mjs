import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { envError, usageError } from './cli.mjs';
import { writeJson } from './files.mjs';
import { canonical, homeDir, isInside, toPosix } from './paths.mjs';

export const DEFAULT_EVAL_ROOT = () => path.join(homeDir(), '.cache', 'beiming', 'evals');

export const resolveEvalRoot = opt => path.resolve(opt || process.env.BEIMING_EVAL_ROOT || DEFAULT_EVAL_ROOT());

const INSTRUCTION_FILES = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', path.join('.claude', 'CLAUDE.md'), path.join('.claude', 'CLAUDE.local.md')];

/** dir 本身及其所有祖先目录里的指令文件（Claude Code 会沿父目录加载）。 */
export function ancestorInstructionFiles(dir) {
  const found = [];
  let cur = path.resolve(dir);
  for (;;) {
    for (const name of INSTRUCTION_FILES) {
      const f = path.join(cur, name);
      try { if (fs.statSync(f).isFile()) found.push(f); } catch { /* 不存在 */ }
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return found;
}

export function assertEvalRoot(root, repo, { isolation = 'isolated', allowAncestors = false } = {}) {
  const r = canonical(root);
  if (isInside(repo, r)) throw usageError(`评测根 ${root} 在源仓库 ${repo} 里面`, '评测检出必须放在仓库外：设 BEIMING_EVAL_ROOT 或 --root 到仓库外的目录');
  if (/[\\/]\.claude[\\/]worktrees([\\/]|$)/.test(r)) throw usageError(`评测根 ${root} 在 .claude/worktrees/ 下`, '计划书禁止使用 .claude/worktrees/：换一个仓库外的目录');
  if (isolation === 'isolated' && !allowAncestors) {
    const found = ancestorInstructionFiles(r);
    if (found.length) {
      throw envError('ancestor-instructions', `评测根的上级目录里有个人指令文件，会被 Claude Code 沿父目录加载，破坏隔离：${found.map(toPosix).join('、')}`,
        process.platform === 'win32'
          ? '把评测根放到不含这些文件的目录，例如系统盘根下：$env:BEIMING_EVAL_ROOT = "$env:SystemDrive\\beiming-evals"；做「带用户全局环境」的对照组时改用 --isolation user-env'
          : '把评测根放到不含这些文件的目录，例如 BEIMING_EVAL_ROOT=/var/tmp/beiming-evals；做「带用户全局环境」的对照组时改用 --isolation user-env');
    }
  }
  return r;
}

/** 隔离会话的配置文件：settings.json（权限）、mcp.json（空）、config/（CLAUDE_CONFIG_DIR）。 */
export function writeSessionConfig(sessionDir, { denyWeb = false } = {}) {
  fs.mkdirSync(path.join(sessionDir, 'config'), { recursive: true });
  const settings = {
    $comment: '北冥 agent 评测的会话设置：只放行做片需要的工具；项目 .claude/settings.json 的禁止规则照常生效（deny 优先）。',
    permissions: {
      allow: ['Bash', 'Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'TodoWrite', 'Task', 'Agent', 'Skill'],
      deny: denyWeb ? ['WebSearch', 'WebFetch'] : [],
    },
  };
  writeJson(path.join(sessionDir, 'settings.json'), settings);
  writeJson(path.join(sessionDir, 'mcp.json'), { mcpServers: {} });
  return { settings: path.join(sessionDir, 'settings.json'), mcp: path.join(sessionDir, 'mcp.json'), configDir: path.join(sessionDir, 'config') };
}

const STRIP_ENV = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CONFIG_DIR'];
// 冷启动不许借用评测机现成的 Python 环境：这些变量一律不传给会话
const COLD_STRIP_ENV = ['PYTHON', 'VIRTUAL_ENV', 'PYTHONPATH', 'PYTHONHOME', 'CONDA_PREFIX', 'CONDA_DEFAULT_ENV', 'UV_PROJECT_ENVIRONMENT'];

/** 会话进程的环境变量。isolated：换 CLAUDE_CONFIG_DIR；两种模式都换 TMPDIR；冷启动另换浏览器目录、去掉现成的 Python 环境。 */
export function sessionEnv(run, extra = {}) {
  const env = { ...process.env };
  for (const k of STRIP_ENV) delete env[k];
  if (run.meta.environment === 'cold') for (const k of COLD_STRIP_ENV) delete env[k];
  if ((run.meta.isolation ?? 'isolated') === 'isolated') env.CLAUDE_CONFIG_DIR = path.join(run.sessionDir, 'config');
  env.TMPDIR = run.tmpDir;
  env.TMP = run.tmpDir;
  env.TEMP = run.tmpDir;
  if (run.meta.environment === 'cold') env.PLAYWRIGHT_BROWSERS_PATH = path.join(run.dir, 'cache', 'ms-playwright');
  return { ...env, ...extra };
}

export const platformInfo = () => ({ os: process.platform, arch: process.arch, release: os.release(), node: process.version, cpus: os.cpus()?.[0]?.model ?? null });
