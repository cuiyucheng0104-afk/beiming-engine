// ProjectSpec 与 RenderResult 共用的版本、路径与诊断。
import { statSync } from 'node:fs';
import { isAbsolute, posix, relative, resolve, sep, win32 } from 'node:path';
import { RouteRegistryError, builtinRegistry, loadRouteRegistry } from './routes.js';

export const SCHEMA_VERSION = 1;

// eslint-disable-next-line no-control-regex -- 有意匹配控制字符（路径与 id 里不许出现）
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;
const WINDOWS_RESERVED = /[<>:"|?*]/;

/** 校验失败时抛出；diagnostics 保留每一条可定位的错误。 */
export class ContractError extends Error {
  /**
   * @param {Array<{code: string, path: string, message: string}>} diagnostics
   * @param {string} [label]
   */
  constructor(diagnostics, label = '契约校验失败') {
    super(`${label}：\n${diagnostics.map(d => `- [${d.code}] ${d.path}：${d.message}`).join('\n')}`);
    this.name = 'ContractError';
    this.diagnostics = diagnostics;
  }
}

export const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const isNonEmptyString = value => typeof value === 'string' && value.trim().length > 0;
export const isPositiveInteger = value => Number.isInteger(value) && value > 0;

export function diagnostic(code, path, message) {
  return { code, path, message };
}

/** path.relative 的结果是否仍在根内（'..draft' 这样的目录名在根内；'..'、'../x'、跨盘的绝对路径在外）。 */
export function relativeInside(rel) {
  return !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

export const statOrNull = file => { try { return statSync(file); } catch { return null; } };

/**
 * 词法解析仓库相对路径：拒绝绝对路径、盘符、UNC、控制字符与越界 `..`。
 * 不做文件系统查询，也不解析符号链接；写入范围只是词法提醒。
 * 绝对路径按 POSIX 与 Windows 两套规则同时判断（`/x`、`\x`、`C:`、`\\server` 在任何平台上都拒绝），
 * 所以同一份记录在 Mac 和 Windows 上结论一致。
 * @param {string} value
 * @returns {{ ok: true, segments: string[], path: string, isDirectory: boolean } | { ok: false, message: string }}
 */
export function normalizeRelativePath(value) {
  if (!isNonEmptyString(value)) return { ok: false, message: '路径必须是非空字符串' };
  if (CONTROL_CHAR.test(value)) return { ok: false, message: '路径不能包含控制字符' };
  const raw = value.trim();
  if (posix.isAbsolute(raw) || win32.isAbsolute(raw) || /^[A-Za-z]:/.test(raw) || raw.startsWith('\\') || raw.startsWith('//')) {
    return { ok: false, message: '只能使用仓库相对路径，不能是绝对路径或盘符路径' };
  }
  const normalized = raw.replace(/\\/g, '/');
  if (WINDOWS_RESERVED.test(normalized)) {
    return { ok: false, message: '路径包含 Windows 不允许的字符（< > : " | ? *）' };
  }
  const isDirectory = normalized.endsWith('/');
  const segments = [];
  for (const segment of normalized.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!segments.length) return { ok: false, message: '路径越出了项目授权范围（起点就是 ..）' };
      segments.pop();
      continue;
    }
    if (segment.endsWith('.')) return { ok: false, message: `路径段不能以点结尾：${segment}` };
    segments.push(segment);
  }
  if (!segments.length) return { ok: false, message: '路径为空或只包含 ./：需要一个具体文件/目录' };
  return { ok: true, segments, path: segments.join('/'), isDirectory };
}

/**
 * 把仓库相对路径解析成绝对路径，并确认没有穿出 rootDir。
 * @param {string} rootDir 仓库根或项目根
 * @param {string} value 仓库相对路径
 * @param {{ kind?: string }} [options]
 * @returns {{ absolute: string, relative: string, kind: string }}
 */
export function resolveProjectPath(rootDir, value, options = {}) {
  const kind = options.kind ?? 'path';
  if (!isNonEmptyString(rootDir)) throw new ContractError([diagnostic('root-invalid', kind, 'root 必须是非空字符串')], '路径解析失败');
  const parsed = normalizeRelativePath(value);
  if (!parsed.ok) {
    throw new ContractError([diagnostic('path-escape', kind, `${parsed.message}（收到：${String(value)}）`)], '路径解析失败');
  }
  const root = resolve(rootDir);
  const absolute = resolve(root, ...parsed.segments);
  const rel = relative(root, absolute);
  if (!rel || !relativeInside(rel)) {
    throw new ContractError([diagnostic('path-escape', kind, `路径穿出了根目录：${value}`)], '路径解析失败');
  }
  return { absolute, relative: rel.split(sep).join('/'), kind };
}

/** 读路线注册表；坏了不抛错，登记一条诊断后退回内置三条（校验函数约定不抛异常）。 */
export function registryFor(options, push) {
  if (options.registry) return options.registry;
  try {
    return loadRouteRegistry();
  } catch (error) {
    if (!(error instanceof RouteRegistryError)) throw error;
    push('routes-invalid', 'route', `${error.message}；本次按内置的 a / b / c / d 校验`);
    return builtinRegistry();
  }
}
