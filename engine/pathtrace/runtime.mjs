#!/usr/bin/env node
// 北冥引擎 · 物理路径追踪运行时解析与锁校验（D 路线 · 北冥光追，决定 D13）
//
// 职责：读取 engine/pathtrace/runtime.lock.json，定位外部光追渲染器可执行文件（BEIMING_PT_BIN 或默认缓存
// ~/.cache/beiming/pathtrace/<version>/bin/threert-render），校验 sha256 与配套 presets/、sdk/ 目录，
// 并提供符合 docs/CLI.md 规范的 status / check 命令行入口。
//
// 导出接口：
//   LOCK_PATH                                       默认锁文件绝对路径
//   detectPlatform(platform?, arch?)                归一化平台键（linux-x64 / macos-arm64 / windows-x64）
//   loadLock(lockPath?)                             读取并校验 runtime.lock.json，违约抛 CliError（contract.*，退出码 4）
//   resolvePathtrace({ env, cwd, lock, platform }?) 定位并校验可执行文件，缺失或哈希不符抛 CliError（env.*，退出码 3），
//                                                   成功返回 { exe, homeDir, presetsDir, sdkDir, version, platform, binarySha256, verified, oidn }
//   probePathtraceGpu(exe, { env, timeoutMs }?)     运行 `<exe> info` 读取 GPU 适配器与硬件光追状态
//
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
/* global process */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CliError, EXIT, EXIT_MEANING, defineCommand, isMain, runCli, sha256, suggest, usageError } from '../../tools/lib/cli.mjs';

export const LOCK_PATH = fileURLToPath(new URL('./runtime.lock.json', import.meta.url));
const REPO_ROOT = path.resolve(path.dirname(LOCK_PATH), '..', '..');

/** 将 Node 的 process.platform + process.arch 映射为 runtime.lock.json 的平台键。 */
export function detectPlatform(platform = process.platform, arch = process.arch) {
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  if (platform === 'darwin' && arch === 'arm64') return 'macos-arm64';
  if (platform === 'win32' && arch === 'x64') return 'windows-x64';
  return `${platform}-${arch}`;
}

/** 读取并校验 runtime.lock.json；结构不合法抛 contract.*（退出码 4）。 */
export function loadLock(lockPath = LOCK_PATH) {
  const target = path.resolve(lockPath);
  if (!fs.existsSync(target)) {
    throw new CliError('contract.pathtrace-lock-missing', '缺少光追运行时锁文件 engine/pathtrace/runtime.lock.json', '确认仓库检出完整，不要删除 runtime.lock.json');
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (cause) {
    throw new CliError('contract.pathtrace-lock-json', `runtime.lock.json 不是合法 JSON：${cause.message}`, '恢复 engine/pathtrace/runtime.lock.json 后重试', { cause });
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CliError('contract.pathtrace-lock-shape', 'runtime.lock.json 顶层必须是对象', null);
  }
  if (raw.schemaVersion !== 1) {
    throw new CliError('contract.pathtrace-lock-version', `不支持的 runtime.lock.json schemaVersion：${JSON.stringify(raw.schemaVersion)}`, '期望 schemaVersion 为 1');
  }
  if (typeof raw.version !== 'string' || !raw.version.trim()) {
    throw new CliError('contract.pathtrace-lock-field', 'runtime.lock.json 缺少有效的 version 字段', null);
  }
  if (typeof raw.commit !== 'string' || !/^[0-9a-f]{40}$/i.test(raw.commit)) {
    throw new CliError('contract.pathtrace-lock-commit', `runtime.lock.json 的 commit 必须是 40 位十六进制 SHA：${JSON.stringify(raw.commit)}`, null);
  }
  if (!raw.platforms || typeof raw.platforms !== 'object' || Array.isArray(raw.platforms)) {
    throw new CliError('contract.pathtrace-lock-platforms', 'runtime.lock.json 缺少 platforms 映射表', null);
  }
  for (const [plat, info] of Object.entries(raw.platforms)) {
    if (!info || typeof info !== 'object') {
      throw new CliError('contract.pathtrace-lock-platform', `platforms.${plat} 必须是对象`, null);
    }
    if (typeof info.binary !== 'string' || !info.binary.trim()) {
      throw new CliError('contract.pathtrace-lock-binary', `platforms.${plat}.binary 必须是非空相对路径`, null);
    }
    if (info.binarySha256 !== null && (typeof info.binarySha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(info.binarySha256))) {
      throw new CliError('contract.pathtrace-lock-sha256', `platforms.${plat}.binarySha256 必须是 64 位十六进制字符串或 null`, null);
    }
    if (typeof info.oidn !== 'boolean') {
      throw new CliError('contract.pathtrace-lock-oidn', `platforms.${plat}.oidn 必须是布尔值`, null);
    }
  }
  return raw;
}

function defaultHomeDir(version, env, cwd) {
  const homeBase = env.HOME || env.USERPROFILE || os.homedir();
  const cacheBase = env.XDG_CACHE_HOME
    ? path.resolve(cwd, env.XDG_CACHE_HOME)
    : path.join(homeBase, '.cache');
  return path.join(cacheBase, 'beiming', 'pathtrace', version);
}

/**
 * 解析并核验本地光追运行时。
 * @param {{ env?: NodeJS.ProcessEnv, cwd?: string, lock?: object, platform?: string, homeDir?: string, presetsDir?: string, sdkDir?: string, allowUnverified?: boolean }} [options]
 * @returns {Promise<{ exe: string, homeDir: string, presetsDir: string, sdkDir: string, version: string, platform: string, binarySha256: string, verified: boolean, oidn: boolean }>}
 */
export async function resolvePathtrace(options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const lk = options.lock ?? loadLock();
  const platform = options.platform ?? detectPlatform();
  const platEntry = lk.platforms?.[platform] ?? null;
  const relBinary = platEntry?.binary ?? (platform.startsWith('windows') ? 'bin/threert-render.exe' : 'bin/threert-render');
  const cacheHome = defaultHomeDir(lk.version, env, cwd);

  let exe;
  let homeDir;
  if (env.BEIMING_PT_BIN && env.BEIMING_PT_BIN.trim()) {
    exe = path.resolve(cwd, env.BEIMING_PT_BIN.trim());
    if (options.homeDir && options.homeDir.trim()) {
      homeDir = path.resolve(cwd, options.homeDir.trim());
    } else {
      const parent = path.dirname(exe);
      homeDir = path.basename(parent) === 'bin' ? path.dirname(parent) : parent;
    }
  } else {
    homeDir = options.homeDir && options.homeDir.trim()
      ? path.resolve(cwd, options.homeDir.trim())
      : cacheHome;
    const nested = path.join(homeDir, ...relBinary.split('/'));
    const flat = path.join(homeDir, path.basename(relBinary));
    exe = fs.existsSync(nested) ? nested : (fs.existsSync(flat) ? flat : nested);
  }

  const pickDir = (explicit, sub) => {
    if (explicit && explicit.trim()) return path.resolve(cwd, explicit.trim());
    const localSub = path.join(homeDir, sub);
    if (fs.existsSync(localSub)) return localSub;
    const cacheSub = path.join(cacheHome, sub);
    if (fs.existsSync(cacheSub)) return cacheSub;
    return localSub;
  };
  const presetsDir = pickDir(options.presetsDir, 'presets');
  const sdkDir = pickDir(options.sdkDir, 'sdk');

  let stat;
  try {
    stat = fs.statSync(exe);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isFile()) {
    throw new CliError(
      'env.pathtrace-missing',
      `未找到 D 路线光追渲染器可执行文件（版本 ${lk.version}，平台 ${platform}）`,
      `将锁定构建放入 ~/.cache/beiming/pathtrace/${lk.version}/${relBinary}，或设置环境变量 BEIMING_PT_BIN 指向 threert-render`,
    );
  }

  const binarySha256 = sha256(fs.readFileSync(exe)).toLowerCase();
  const expectedSha = platEntry?.binarySha256 ? platEntry.binarySha256.toLowerCase() : null;
  let verified = false;
  if (expectedSha) {
    if (binarySha256 === expectedSha) {
      verified = true;
    } else if (options.allowUnverified) {
      verified = false;
    } else {
      throw new CliError(
        'env.pathtrace-hash-mismatch',
        `光追运行时 sha256 与锁文件不符（期望 ${expectedSha.slice(0, 12)}…，实际 ${binarySha256.slice(0, 12)}…）`,
        `请安装与 engine/pathtrace/runtime.lock.json 匹配的 ${lk.version} 构建`,
      );
    }
  }

  return {
    exe,
    homeDir,
    presetsDir,
    sdkDir,
    version: lk.version,
    platform,
    binarySha256,
    verified,
    oidn: Boolean(platEntry?.oidn),
  };
}

/** 调用 `threert-render info` 探测 GPU 适配器；失败返回 `{ ok: false, error }`。 */
export function probePathtraceGpu(exe, { env = process.env, timeoutMs = 15000 } = {}) {
  const res = spawnSync(exe, ['info'], {
    encoding: 'utf8',
    env,
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (res.error) return { ok: false, error: res.error.message };
  if (res.status !== 0) {
    const detail = (res.stderr || res.stdout || '').trim().split(/\r?\n/)[0] || `退出码 ${res.status}`;
    return { ok: false, error: detail };
  }
  const line = (res.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
  try {
    const parsed = JSON.parse(line);
    return { ok: true, ...parsed };
  } catch {
    return { ok: true, raw: line };
  }
}

function redactForDisplay(targetPath, env) {
  const posix = p => p.split(path.sep).join('/');
  const relRepo = posix(path.relative(REPO_ROOT, targetPath));
  if (!relRepo.startsWith('..') && !path.isAbsolute(relRepo)) return relRepo || '.';
  const home = env.HOME || env.USERPROFILE || os.homedir();
  if (home && (targetPath === home || targetPath.startsWith(home + path.sep))) {
    return '~/' + posix(targetPath.slice(home.length + 1));
  }
  return posix(path.basename(targetPath));
}

const SUBCOMMANDS = ['status', 'check'];

export const command = defineCommand({
  name: 'pathtrace-runtime',
  summary: '查看并核验 D 路线（北冥光追 · 物理路径追踪）外部渲染运行时与缓存目录',
  usage: [
    'node engine/pathtrace/runtime.mjs [status|check] [选项]',
  ],
  positionals: [
    {
      name: 'action',
      label: '<status|check>',
      describe: 'status 查看当前运行时与配套目录状态；check 严格校验预设与 SDK 目录完整性（默认 status）',
      required: false,
      default: 'status',
    },
  ],
  options: {
    bin: {
      type: 'string',
      arg: '<路径>',
      describe: '指定 threert-render 可执行文件路径（覆盖 BEIMING_PT_BIN）',
    },
    lock: {
      type: 'string',
      arg: '<文件>',
      describe: '指定锁文件路径（默认 engine/pathtrace/runtime.lock.json）',
    },
    home: {
      type: 'string',
      arg: '<目录>',
      describe: '指定光追运行时缓存根目录（默认 ~/.cache/beiming/pathtrace/<版本>）',
    },
    presets: {
      type: 'string',
      arg: '<目录>',
      describe: '覆盖 presets 目录路径',
    },
    sdk: {
      type: 'string',
      arg: '<目录>',
      describe: '覆盖 sdk 目录路径',
    },
    'allow-unverified': {
      type: 'boolean',
      describe: '跳过可执行文件 sha256 强制阻断（仅用于本地调试）',
    },
    'probe-gpu': {
      type: 'boolean',
      describe: '运行 threert-render info 核验当前 GPU 适配器与硬件光追能力',
    },
  },
  examples: [
    'node engine/pathtrace/runtime.mjs status --json',
    'node engine/pathtrace/runtime.mjs check --probe-gpu',
  ],
  exitCodes: {
    0: EXIT_MEANING[0],
    2: EXIT_MEANING[2],
    3: EXIT_MEANING[3],
    4: EXIT_MEANING[4],
  },
  run: async ctx => {
    const action = ctx.args.action || 'status';
    if (!SUBCOMMANDS.includes(action)) {
      const s = suggest(action, SUBCOMMANDS);
      throw usageError(
        'unknown-subcommand',
        `不认识的子命令「${action}」（可选：${SUBCOMMANDS.join(' / ')}）`,
        s ? `是不是想写 ${s}？` : '用法见 --help',
      );
    }
    const lock = ctx.opts.lock ? loadLock(ctx.opts.lock) : loadLock();
    const env = ctx.opts.bin ? { ...ctx.env, BEIMING_PT_BIN: ctx.opts.bin } : ctx.env;
    const rt = await resolvePathtrace({
      env,
      lock,
      homeDir: ctx.opts.home || undefined,
      presetsDir: ctx.opts.presets || undefined,
      sdkDir: ctx.opts.sdk || undefined,
      allowUnverified: Boolean(ctx.opts['allow-unverified']),
    });

    const presetsReady = fs.existsSync(path.join(rt.presetsDir, 'cinematic.json'))
      && fs.existsSync(path.join(rt.presetsDir, 'preview.json'));
    const sdkReady = fs.existsSync(path.join(rt.sdkDir, 'packages', 'scene'))
      && fs.existsSync(path.join(rt.sdkDir, 'packages', 'gameplay'));

    let gpu = null;
    if (ctx.opts['probe-gpu']) {
      gpu = probePathtraceGpu(rt.exe, { env });
      if (!gpu.ok) {
        throw new CliError(
          'env.pathtrace-gpu',
          `threert-render info 执行失败：${gpu.error}`,
          '检查当前机器的 Vulkan / Metal / DX12 驱动，或在无 GPU 环境去掉 --probe-gpu',
        );
      }
    }

    const data = {
      action,
      version: rt.version,
      upstream: lock.upstream,
      commit: lock.commit,
      license: lock.license,
      platform: rt.platform,
      binary: redactForDisplay(rt.exe, env),
      homeDir: redactForDisplay(rt.homeDir, env),
      presetsDir: redactForDisplay(rt.presetsDir, env),
      sdkDir: redactForDisplay(rt.sdkDir, env),
      binarySha256: rt.binarySha256,
      verified: rt.verified,
      oidn: rt.oidn,
      presetsReady,
      sdkReady,
      ...(gpu ? { gpu } : {}),
    };

    if (action === 'check' && (!presetsReady || !sdkReady)) {
      const missing = [
        !presetsReady && 'presets/{cinematic,preview}.json',
        !sdkReady && 'sdk/packages/{scene,gameplay}',
      ].filter(Boolean).join('、');
      throw new CliError(
        'env.pathtrace-incomplete',
        `光追运行时缓存缺少配套目录：${missing}`,
        `将 presets/ 与 sdk/ 安装到 ~/.cache/beiming/pathtrace/${rt.version}/`,
        { exitCode: EXIT.ENVIRONMENT, data },
      );
    }

    if (!rt.verified) {
      ctx.warn('env.pathtrace-unverified', '当前可执行文件未经锁文件哈希核验（已跳过或平台锁为空）', '正式交付前请使用锁定哈希的构建版本');
    }

    ctx.out(
      `北冥光追运行时就绪：${data.version}（${data.platform}，sha256 ${rt.binarySha256.slice(0, 12)}…，verified=${rt.verified}，oidn=${rt.oidn}）`
      + (gpu?.adapter ? ` · GPU：${gpu.adapter}（hwrt=${Boolean(gpu.hwrt)}）` : ''),
    );
    return { data };
  },
});

if (isMain(import.meta.url)) {
  await runCli(command);
}
