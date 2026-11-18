#!/usr/bin/env node
// 北冥引擎 · 光追场景打包与元数据探针（D 路线 · 北冥光追，决定 D13）
//
// 职责：将作品目录中的 scene.ts 与光追运行时缓存内的 @threert/scene、@threert/gameplay 及本仓库的
// engine/pathtrace 模块打包为单文件自包含 QuickJS 场景包（work/scene.bundle.js），并在 Node 隔离沙箱
// 中执行无状态探针（probeFilm），导出统一格式的 events.json、timeline.json 与 work/texts.json。
// 优先使用运行时缓存 sdk/node_modules 中的 esbuild 插件打包（兼容导入 engine/pathtrace/index.js 或 index.ts）；
// 在无 esbuild 的最小环境（如 CI 单元测试）下自动回退至内置轻量类型擦除打包器，兼容全部 Node 22.0+ 版本。
//
// 导出接口：
//   bundlePathtraceFilm({ filmDir, entry, outBundle, probeOut, film, width, height, fps, sdkDir, env }?)
//     -> Promise<{ bundlePath, bundleSha256, eventsPath, timelinePath, textsPath, frameCount, fps, width, height, probe }>
//
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
/* global process, Buffer */

import fs from 'node:fs';
import * as nodeModule from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { CliError, EXIT_MEANING, defineCommand, isMain, runCli, sha256 } from '../../tools/lib/cli.mjs';
import { legacyEvents, legacyTimeline, timingOf } from '../production/timeline.js';
import { resolvePathtrace } from './runtime.mjs';

const { createRequire } = nodeModule;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

const posix = p => p.split(path.sep).join('/');
const repoRel = p => {
  const r = posix(path.relative(REPO_ROOT, p));
  return (!r.startsWith('..') && !path.isAbsolute(r)) ? (r || '.') : posix(path.basename(p));
};

let tmpSeq = 0;

function writeAtomic(targetPath, contents) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(targetPath)}.tmp-${process.pid}-${++tmpSeq}`);
  try {
    fs.writeFileSync(tmp, contents);
    fs.renameSync(tmp, targetPath);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 已清理 */ }
    throw err;
  }
}

function resolveSdkPackageEntry(sdkDir, pkgShortName) {
  const pkgRoot = path.join(sdkDir, 'packages', pkgShortName);
  const candidates = [
    path.join(pkgRoot, 'src', 'index.ts'),
    path.join(pkgRoot, 'src', 'index.js'),
    path.join(pkgRoot, 'src', 'index.mjs'),
    path.join(pkgRoot, 'index.ts'),
    path.join(pkgRoot, 'index.js'),
    path.join(pkgRoot, 'index.mjs'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function loadEsbuild(sdkDir) {
  const searchAnchors = [];
  if (sdkDir && fs.existsSync(path.join(sdkDir, 'package.json'))) {
    searchAnchors.push(path.join(sdkDir, 'package.json'));
  }
  searchAnchors.push(import.meta.url);
  for (const anchor of searchAnchors) {
    try {
      const req = createRequire(anchor);
      return req('esbuild');
    } catch {
      // 继续尝试下一个候选或使用内置打包器
    }
  }
  return null;
}

function makeEsbuildSdkPlugin(sdkDir, presetsDir) {
  const map = new Map([
    ['@threert/scene', resolveSdkPackageEntry(sdkDir, 'scene')],
    ['@threert/gameplay', resolveSdkPackageEntry(sdkDir, 'gameplay')],
  ]);
  const fallbackPresets = presetsDir || path.resolve(sdkDir, '..', 'presets');
  return {
    name: 'beiming-pathtrace-sdk',
    setup(build) {
      build.onResolve({ filter: /^@threert\/(scene|gameplay)$/ }, args => {
        const hit = map.get(args.path);
        if (!hit) {
          return {
            errors: [{
              text: `未在光追 SDK 目录中找到 ${args.path}（已查找 packages/${args.path.split('/')[1]}/src/index.ts）`,
            }],
          };
        }
        return { path: hit };
      });
      // 兼容作品 scene.ts 导入 ../../engine/pathtrace/index.js 或历史写法 ../../engine/pathtrace/index.ts
      build.onResolve({ filter: /(?:^|\/)engine\/pathtrace\/(index|camera|hud)(?:\.(?:ts|js))?$/ }, args => {
        const m = /(?:^|\/)engine\/pathtrace\/(index|camera|hud)(?:\.(?:ts|js))?$/.exec(args.path);
        const direct = path.resolve(args.resolveDir, args.path);
        if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return { path: direct };
        if (direct.endsWith('.ts')) {
          const asJs = `${direct.slice(0, -3)}.js`;
          if (fs.existsSync(asJs) && fs.statSync(asJs).isFile()) return { path: asJs };
        }
        if (m) {
          const canonical = path.join(HERE, `${m[1]}.js`);
          if (fs.existsSync(canonical)) return { path: canonical };
        }
        return null;
      });
      build.onResolve({ filter: /(?:^|\/)presets\/[^/]+\.json$/ }, args => {
        const direct = path.resolve(args.resolveDir, args.path);
        if (fs.existsSync(direct)) return { path: direct };
        const byCache = path.join(fallbackPresets, path.basename(args.path));
        if (fs.existsSync(byCache)) return { path: byCache };
        return null;
      });
    },
  };
}

function resolveModuleFile(specifier, fromDir, sdkDir) {
  if (specifier === '@threert/scene') {
    const hit = resolveSdkPackageEntry(sdkDir, 'scene');
    if (hit) return hit;
    throw new CliError('env.pathtrace-sdk-missing', '光追 SDK 缺少 @threert/scene', '请确认缓存目录包含 sdk/packages/scene');
  }
  if (specifier === '@threert/gameplay') {
    const hit = resolveSdkPackageEntry(sdkDir, 'gameplay');
    if (hit) return hit;
    throw new CliError('env.pathtrace-sdk-missing', '光追 SDK 缺少 @threert/gameplay', '请确认缓存目录包含 sdk/packages/gameplay');
  }
  if (specifier.startsWith('.') || path.isAbsolute(specifier)) {
    const base = path.resolve(fromDir, specifier);
    const candidates = [base];
    if (base.endsWith('.ts')) candidates.push(`${base.slice(0, -3)}.js`, `${base.slice(0, -3)}.mjs`);
    if (base.endsWith('.js')) candidates.push(`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.mjs`);
    candidates.push(
      `${base}.ts`,
      `${base}.js`,
      `${base}.mjs`,
      path.join(base, 'index.js'),
      path.join(base, 'index.ts'),
      path.join(base, 'index.mjs'),
    );
    const engineMatch = /(?:^|[\\/])engine[\\/]pathtrace[\\/](index|camera|hud)(?:\.(?:ts|js))?$/.exec(base);
    if (engineMatch) candidates.push(path.join(HERE, `${engineMatch[1]}.js`));
    for (const c of candidates) {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    }
    throw new CliError('contract.pathtrace-import', `无法解析场景模块引用：${specifier}`, '检查 scene.ts 中的相对路径拼写');
  }
  if (sdkDir) {
    const nmPkg = path.join(sdkDir, 'node_modules', specifier);
    const pj = path.join(nmPkg, 'package.json');
    if (fs.existsSync(pj)) {
      const meta = JSON.parse(fs.readFileSync(pj, 'utf8'));
      const entry = typeof meta.module === 'string' ? meta.module
        : typeof meta.main === 'string' ? meta.main : 'index.js';
      const resolved = path.resolve(nmPkg, entry);
      if (fs.existsSync(resolved)) return resolved;
    }
  }
  throw new CliError('contract.pathtrace-import', `不支持的裸模块导入：${specifier}`, '场景代码仅导入 @threert/scene、engine/pathtrace 或作品内相对模块');
}

function parseNamedBindings(clause) {
  return clause
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(part => {
      const cleaned = part.replace(/^type\s+/, '').trim();
      const m = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(cleaned);
      return m ? { imported: m[1], local: m[2], typeOnly: /^type\s+/.test(part) } : { imported: cleaned, local: cleaned, typeOnly: /^type\s+/.test(part) };
    })
    .filter(b => !b.typeOnly && b.imported);
}

/** 兼容 Node 22.0–22.5（尚未内置 nodeModule.stripTypeScriptTypes）的最小 TS 擦除退路。 */
function stripTypesFallback(source) {
  return source
    .replace(/(^|\n)[ \t]*export\s+(?:interface|type)\s+[A-Za-z_$][\w$]*[\s\S]*?(?=\n(?:export|import|function|class|const|let|var|$))/g, '$1')
    .replace(/(^|\n)[ \t]*(?:interface|type)\s+[A-Za-z_$][\w$]*[\s\S]*?(?=\n(?:export|import|function|class|const|let|var|$))/g, '$1')
    .replace(/\(([^()]*?)\s+as\s+[^()]+\)/g, '($1)')
    .replace(/\b(function\s+[A-Za-z_$][\w$]*)\s*<[^>()]+>\s*\(/g, '$1(')
    .replace(/(\b(?:constructor|set|[A-Za-z_$][\w$]*)\s*\([^)]*\))\s*:\s*[A-Za-z_$][\w$<>[\]|&\s,]*(\s*\{)/g, '$1$2')
    .replace(/([,(]\s*[A-Za-z_$][\w$]*\??)\s*:\s*[A-Za-z_$][\w$<>[\]|&]*(?=\s*(?:=|,|\)))/g, '$1')
    .replace(/(;\s*|\{\s*|\n[ \t]*)([A-Za-z_$][\w$]*)\s*:\s*[A-Za-z_$][\w$<>[\]|&]*\s*(?==|;)/g, '$1$2 ');
}

function stripTsSource(rawSource, filename) {
  if (typeof nodeModule.stripTypeScriptTypes === 'function') {
    return nodeModule.stripTypeScriptTypes(rawSource, { mode: 'strip', sourceUrl: filename });
  }
  return stripTypesFallback(rawSource);
}

/**
 * 零外部依赖的内置轻量打包器（当运行环境未安装 esbuild 时用于测试或最小构建）：
 * 先擦除 TS 类型，再将静态 ESM 依赖图编译为单文件 IIFE。
 */
function bundleWithBuiltinStripper(virtualEntryCode, entryResolveDir, sdkDir) {
  const idByPath = new Map();
  const modules = [];
  let depVarSeq = 0;

  function visitModule(absPath, rawSource, fromDir) {
    if (idByPath.has(absPath)) return idByPath.get(absPath);
    const id = modules.length;
    idByPath.set(absPath, id);
    modules.push({ id, code: '' });

    let js = absPath.endsWith('.ts')
      ? stripTsSource(rawSource, path.basename(absPath))
      : rawSource;

    const depId = spec => {
      const target = resolveModuleFile(spec, fromDir, sdkDir);
      return visitModule(target, fs.readFileSync(target, 'utf8'), path.dirname(target));
    };

    // 1. import 语句重写（静态顶层 ESM 导入）
    js = js.replace(
      /(^|\n)[ \t]*import\s+(?:type\s+[^;]*?from\s+(['"])([^'"]+)\2|([\s\S]*?)\s+from\s+(['"])([^'"]+)\5|(['"])([^'"]+)\7)[ \t]*;?/g,
      (full, lead, _qType, typeSpec, clause, _qFrom, fromSpec, _qBare, bareSpec) => {
        if (typeSpec) return `${lead}`;
        if (bareSpec) {
          const targetId = depId(bareSpec);
          return `${lead}__req(${targetId});`;
        }
        const spec = fromSpec;
        const targetId = depId(spec);
        const trimmed = clause.trim();
        const tmp = `__dep_${++depVarSeq}`;
        if (trimmed.startsWith('*')) {
          const nsMatch = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(trimmed);
          if (nsMatch) return `${lead}const ${nsMatch[1]} = __req(${targetId});`;
        }
        if (trimmed.startsWith('{')) {
          const bindings = parseNamedBindings(trimmed.slice(1, -1));
          if (!bindings.length) return `${lead}__req(${targetId});`;
          const destruct = bindings.map(b => (b.imported === b.local ? b.imported : `${b.imported}: ${b.local}`)).join(', ');
          return `${lead}const { ${destruct} } = __req(${targetId});`;
        }
        const splitIdx = trimmed.indexOf(',');
        if (splitIdx > 0) {
          const defName = trimmed.slice(0, splitIdx).trim();
          const namedPart = trimmed.slice(splitIdx + 1).trim();
          const lines = [`const ${tmp} = __req(${targetId});`, `const ${defName} = ${tmp}.default;`];
          if (namedPart.startsWith('{')) {
            const bindings = parseNamedBindings(namedPart.slice(1, -1));
            if (bindings.length) {
              const destruct = bindings.map(b => (b.imported === b.local ? b.imported : `${b.imported}: ${b.local}`)).join(', ');
              lines.push(`const { ${destruct} } = ${tmp};`);
            }
          }
          return `${lead}${lines.join(' ')}`;
        }
        return `${lead}const ${trimmed} = __req(${targetId}).default;`;
      },
    );

    // 2. export * / export { ... } from '...' 重写
    js = js.replace(/(^|\n)[ \t]*export\s+\*\s+from\s+(['"])([^'"]+)\2[ \t]*;?/g, (_m, lead, _q, spec) => {
      const targetId = depId(spec);
      return `${lead}__reexport(__exports, __req(${targetId}));`;
    });
    js = js.replace(/(^|\n)[ \t]*export\s+\{([^}]*)\}\s+from\s+(['"])([^'"]+)\3[ \t]*;?/g, (_m, lead, body, _q, spec) => {
      const bindings = parseNamedBindings(body);
      if (!bindings.length) return `${lead}`;
      const targetId = depId(spec);
      const tmp = `__re_${++depVarSeq}`;
      const props = bindings
        .map(b => `Object.defineProperty(__exports, ${JSON.stringify(b.local)}, { enumerable: true, get: () => ${tmp}[${JSON.stringify(b.imported)}] });`)
        .join(' ');
      return `${lead}{ const ${tmp} = __req(${targetId}); ${props} }`;
    });

    // 3. 本地 export 语句重写
    const localExports = [];
    js = js.replace(/(^|\n)[ \t]*export\s+\{([^}]*)\}[ \t]*;?/g, (_m, lead, body) => {
      const bindings = parseNamedBindings(body);
      for (const b of bindings) localExports.push(b);
      return `${lead}`;
    });
    js = js.replace(/(^|\n)[ \t]*export\s+default\s+/g, '$1__exports.default = ');
    js = js.replace(/(^|\n)[ \t]*export\s+(async\s+function|function|class)\s+([A-Za-z_$][\w$]*)/g, (_m, lead, kw, name) => {
      localExports.push({ imported: name, local: name });
      return `${lead}${kw} ${name}`;
    });
    js = js.replace(/(^|\n)[ \t]*export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)/g, (_m, lead, kw, name) => {
      localExports.push({ imported: name, local: name });
      return `${lead}${kw} ${name}`;
    });

    const tail = localExports
      .map(b => `Object.defineProperty(__exports, ${JSON.stringify(b.local)}, { enumerable: true, configurable: true, get: () => ${b.imported} });`)
      .join('\n');
    modules[id].code = `${js}\n${tail}`;
    return id;
  }

  const entryId = visitModule('__beiming_pathtrace_entry__.ts', virtualEntryCode, entryResolveDir);
  const table = modules
    .map(m => `  ${m.id}: function(__exports, __req, __reexport) {\n${m.code}\n  }`)
    .join(',\n');

  return [
    '(() => {',
    '  const __cache = Object.create(null);',
    '  function __reexport(dst, src) {',
    '    for (const k of Object.keys(src)) {',
    '      if (k === "default" || Object.prototype.hasOwnProperty.call(dst, k)) continue;',
    '      Object.defineProperty(dst, k, { enumerable: true, configurable: true, get: () => src[k] });',
    '    }',
    '  }',
    '  const __modules = {',
    table,
    '  };',
    '  function __req(id) {',
    '    if (__cache[id]) return __cache[id].exports;',
    '    const m = { exports: {} };',
    '    __cache[id] = m;',
    '    __modules[id](m.exports, __req, __reexport);',
    '    return m.exports;',
    '  }',
    `  __req(${entryId});`,
    '})();',
    '',
  ].join('\n');
}

function normalizeFilmForBundle(rawFilm, overrides = {}) {
  const base = rawFilm && typeof rawFilm === 'object' ? structuredClone(rawFilm) : {};
  const tm = (() => {
    try {
      return timingOf(base);
    } catch {
      const fps = Math.max(1, Math.trunc(overrides.fps ?? base.output?.fps ?? base.fps ?? 24));
      const frameCount = Math.max(
        1,
        Math.trunc(
          base.output?.frameCount
          ?? (typeof base.dur === 'number' && base.dur > 0 ? Math.round(base.dur * fps) : fps),
        ),
      );
      return {
        fps,
        frameCount,
        width: overrides.width ?? base.output?.width ?? base.size?.[0] ?? 1920,
        height: overrides.height ?? base.output?.height ?? base.size?.[1] ?? 1080,
        shots: Array.isArray(base.shots) && base.shots.length ? base.shots : [{ id: 'S01', in: 0, out: frameCount }],
      };
    }
  })();

  const width = Math.max(2, Math.trunc(overrides.width ?? tm.width ?? 1920));
  const height = Math.max(2, Math.trunc(overrides.height ?? tm.height ?? 1080));
  const fps = Math.max(1, Math.trunc(overrides.fps ?? tm.fps ?? 24));
  const frameCount = Math.max(1, Math.trunc(tm.frameCount));
  const shots = Array.isArray(tm.shots) && tm.shots.length
    ? tm.shots.map(s => ({ ...s, in: s.in, out: s.out }))
    : [{ id: 'S01', in: 0, out: frameCount }];

  return {
    ...base,
    schemaVersion: 2,
    output: {
      ...(base.output ?? {}),
      width,
      height,
      fps,
      frameCount,
    },
    shots,
    events: Array.isArray(base.events) ? base.events : [],
  };
}

function executeNodeProbe(bundleCode, bundlePath, normalizedFilm, { width, height, fps }) {
  const logs = [];
  const sandbox = {
    console: {
      log: (...a) => logs.push(a.map(String).join(' ')),
      info: (...a) => logs.push(a.map(String).join(' ')),
      warn: (...a) => logs.push(a.map(String).join(' ')),
      error: (...a) => logs.push(a.map(String).join(' ')),
      debug: () => {},
    },
    performance: { now: () => 0 },
    structuredClone: v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v))),
    TextEncoder,
    TextDecoder,
    atob: globalThis.atob,
    btoa: globalThis.btoa,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Symbol,
    RegExp,
    Error,
    TypeError,
    RangeError,
    SyntaxError,
    JSON,
    Date,
    Promise,
    Proxy,
    Reflect,
    ArrayBuffer,
    DataView,
    Int8Array,
    Uint8Array,
    Uint8ClampedArray,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array,
    BigInt64Array,
    BigUint64Array,
  };
  sandbox.globalThis = sandbox;

  try {
    vm.runInNewContext(bundleCode, sandbox, { filename: bundlePath, timeout: 60000 });
  } catch (cause) {
    throw new CliError(
      'failure.pathtrace-probe-eval',
      `执行光追场景包失败：${cause?.message ?? cause}`,
      '检查 scene.ts 是否存在顶层异常或访问了浏览器专属 DOM 接口',
      { cause },
    );
  }

  const mod = sandbox.__BEIMING_PT_MOD__;
  if (mod && typeof mod.probeFilm === 'function') {
    try {
      return mod.probeFilm({ film: normalizedFilm, width, height, fps });
    } catch (cause) {
      throw new CliError(
        'contract.pathtrace-probe',
        `场景 probeFilm 逐帧求值失败：${cause?.message ?? cause}`,
        '确认 renderFrame(frame, ctx) 与 textsAt(frame, ctx) 为纯帧号函数且不依赖外部 I/O',
        { cause },
      );
    }
  }

  const frameCount = normalizedFilm.output.frameCount;
  return {
    evaluation: 'absolute',
    width,
    height,
    fps,
    frameCount,
    seed: Number.isFinite(normalizedFilm.pathtrace?.seed) ? Math.trunc(normalizedFilm.pathtrace.seed) : 2026,
    frames: Array.from({ length: frameCount }, (_, f) => {
      const shot = normalizedFilm.shots.find(s => f >= s.in && f < s.out)?.id ?? normalizedFilm.shots[0].id;
      return { frame: f, t: +(f / fps).toFixed(6), shot, items: [] };
    }),
    summary: [],
  };
}

/**
 * 打包作品 scene.ts 为 QuickJS 自包含脚本，并运行 Node 探针生成 events.json、timeline.json 与 work/texts.json。
 */
export async function bundlePathtraceFilm(options = {}) {
  const env = options.env ?? process.env;
  const filmDir = options.filmDir ? path.resolve(options.filmDir) : process.cwd();
  if (!fs.existsSync(filmDir) || !fs.statSync(filmDir).isDirectory()) {
    throw new CliError('usage.film-missing', `作品目录不存在：${options.filmDir ?? filmDir}`, '请传入包含 film.json 与 scene.ts 的目录');
  }

  let rawFilm = options.film;
  if (!rawFilm) {
    const filmJsonPath = path.join(filmDir, 'film.json');
    if (!fs.existsSync(filmJsonPath)) {
      throw new CliError('contract.film-missing', '作品目录缺少 film.json', '先运行 npm run new -- d <名字> 生成作品模版');
    }
    try {
      rawFilm = JSON.parse(fs.readFileSync(filmJsonPath, 'utf8'));
    } catch (cause) {
      throw new CliError('contract.film-json', `film.json 解析失败：${cause.message}`, null, { cause });
    }
  }

  const normalizedFilm = normalizeFilmForBundle(rawFilm, {
    width: options.width,
    height: options.height,
    fps: options.fps,
  });
  const { width, height, fps, frameCount } = normalizedFilm.output;

  const entryRel = options.entry || rawFilm.entry || 'scene.ts';
  const entryAbs = path.resolve(filmDir, entryRel);
  if (!fs.existsSync(entryAbs) || !fs.statSync(entryAbs).isFile()) {
    throw new CliError('contract.entry-missing', `未找到场景入口文件：${entryRel}`, '确认 film.json 的 entry 字段与作品目录下的 scene.ts 一致');
  }

  let sdkDir = options.sdkDir ? path.resolve(options.sdkDir) : null;
  let presetsDir = options.presetsDir ? path.resolve(options.presetsDir) : null;
  if (!sdkDir) {
    const rt = await resolvePathtrace({ env });
    sdkDir = rt.sdkDir;
    presetsDir = presetsDir || rt.presetsDir;
  }
  presetsDir = presetsDir || path.resolve(sdkDir, '..', 'presets');
  if (!resolveSdkPackageEntry(sdkDir, 'scene') || !resolveSdkPackageEntry(sdkDir, 'gameplay')) {
    throw new CliError(
      'env.pathtrace-sdk-missing',
      '光追运行时缓存缺少 sdk/packages/{scene,gameplay}',
      '请按 D 路线说明安装完整光追缓存包（含 bin/、presets/、sdk/），或通过 --sdk 指定目录',
    );
  }

  const probeOutDir = options.probeOut ? path.resolve(options.probeOut) : path.join(filmDir, 'out');
  const bundlePath = options.outBundle
    ? path.resolve(options.outBundle)
    : path.join(probeOutDir, 'work', 'scene.bundle.js');

  const relEntry = path.relative(filmDir, entryAbs);
  const entrySpec = path.isAbsolute(relEntry)
    ? posix(entryAbs)
    : (posix(relEntry).startsWith('.') ? posix(relEntry) : `./${posix(relEntry)}`);
  const bootPayload = { film: normalizedFilm, width, height, fps };
  const virtualEntry = [
    `globalThis.__BEIMING_FILM_BOOT__ = ${JSON.stringify(bootPayload)};`,
    `import mod from ${JSON.stringify(entrySpec)};`,
    `import { defineGame, installNodeHost } from "@threert/gameplay";`,
    `globalThis.__BEIMING_PT_MOD__ = mod;`,
    `const gameDef = typeof mod === "function"`,
    `  ? defineGame({ state: { frame: 0, hideTexts: false }, setup: () => mod(), handlers: {} })`,
    `  : (mod && mod.__beimingPathtraceFilm ? defineGame(mod) : mod);`,
    `installNodeHost(gameDef);`,
  ].join('\n');

  const esbuild = loadEsbuild(sdkDir);
  let bundleCode;
  if (esbuild) {
    const nodePaths = [];
    if (fs.existsSync(path.join(sdkDir, 'node_modules'))) nodePaths.push(path.join(sdkDir, 'node_modules'));
    if (fs.existsSync(path.join(REPO_ROOT, 'node_modules'))) nodePaths.push(path.join(REPO_ROOT, 'node_modules'));
    try {
      const built = await esbuild.build({
        stdin: {
          contents: virtualEntry,
          resolveDir: filmDir,
          sourcefile: 'beiming-pathtrace-entry.ts',
          loader: 'ts',
        },
        bundle: true,
        plugins: [makeEsbuildSdkPlugin(sdkDir, presetsDir)],
        nodePaths,
        format: 'iife',
        platform: 'neutral',
        target: 'es2022',
        minifySyntax: true,
        legalComments: 'none',
        write: false,
        logLevel: 'silent',
      });
      bundleCode = built.outputFiles[0].text;
    } catch (cause) {
      const detail = cause?.errors?.[0]?.text || cause?.message || String(cause);
      throw new CliError('failure.pathtrace-bundle', `esbuild 打包光追场景失败：${detail}`, '检查 scene.ts 的语法与类型导入', { cause });
    }
  } else {
    bundleCode = bundleWithBuiltinStripper(virtualEntry, filmDir, sdkDir);
  }

  writeAtomic(bundlePath, bundleCode);
  const bundleSha256 = sha256(Buffer.from(bundleCode, 'utf8'));

  const probe = executeNodeProbe(bundleCode, bundlePath, normalizedFilm, { width, height, fps });
  const eventsData = legacyEvents(normalizedFilm);
  const timelineData = legacyTimeline(normalizedFilm);
  const textsData = {
    schemaVersion: 1,
    evaluation: probe.evaluation,
    width,
    height,
    fps,
    frameCount,
    seed: probe.seed,
    frames: probe.frames,
    summary: probe.summary,
  };

  const eventsPath = path.join(probeOutDir, 'events.json');
  const timelinePath = path.join(probeOutDir, 'timeline.json');
  const textsPath = path.join(probeOutDir, 'work', 'texts.json');

  writeAtomic(eventsPath, JSON.stringify(eventsData));
  writeAtomic(timelinePath, JSON.stringify(timelineData, null, 1) + '\n');
  writeAtomic(textsPath, JSON.stringify(textsData, null, 2) + '\n');

  return {
    bundlePath,
    bundleSha256,
    eventsPath,
    timelinePath,
    textsPath,
    frameCount,
    fps,
    width,
    height,
    probe: textsData,
  };
}

export const command = defineCommand({
  name: 'pathtrace-bundle',
  summary: '打包 D 路线作品场景（scene.ts → work/scene.bundle.js）并导出事件与逐帧文字安全区探针数据',
  usage: [
    'node engine/pathtrace/bundle.mjs <作品目录> [选项]',
  ],
  positionals: [
    {
      name: 'filmDir',
      label: '<作品目录>',
      describe: '包含 film.json 与 scene.ts 的作品目录（如 films/my-film）',
      required: true,
    },
  ],
  options: {
    entry: {
      type: 'string',
      arg: '<文件>',
      describe: '覆盖场景入口文件（默认取 film.json 的 entry 或 scene.ts）',
    },
    out: {
      type: 'string',
      arg: '<目录>',
      describe: '探针与中间产物输出目录（默认 <作品目录>/out）',
    },
    bundle: {
      type: 'string',
      arg: '<路径>',
      describe: '覆盖生成的 QuickJS 场景包路径（默认 <输出目录>/work/scene.bundle.js）',
    },
    sdk: {
      type: 'string',
      arg: '<目录>',
      describe: '覆盖光追 SDK 目录路径',
    },
    presets: {
      type: 'string',
      arg: '<目录>',
      describe: '覆盖光追 presets 目录路径',
    },
    size: {
      type: 'string',
      arg: '<宽x高>',
      describe: '覆盖探测画幅（如 1920x1080）',
    },
    fps: {
      type: 'integer',
      min: 1,
      max: 240,
      arg: '<帧率>',
      describe: '覆盖探测整数帧率',
    },
  },
  examples: [
    'node engine/pathtrace/bundle.mjs films/my-film --json',
    'node engine/pathtrace/bundle.mjs films/my-film --out films/my-film/out/dev',
  ],
  exitCodes: {
    0: EXIT_MEANING[0],
    1: EXIT_MEANING[1],
    2: EXIT_MEANING[2],
    3: EXIT_MEANING[3],
    4: EXIT_MEANING[4],
  },
  run: async ctx => {
    let width;
    let height;
    if (ctx.opts.size) {
      const m = /^(\d+)x(\d+)$/.exec(ctx.opts.size);
      if (!m || +m[1] < 16 || +m[2] < 16 || +m[1] % 2 || +m[2] % 2) {
        throw new CliError('usage.bad-value', `--size 需要写成 ≥16 的偶数 宽x高，收到「${ctx.opts.size}」`, '例如 --size 1920x1080');
      }
      width = +m[1];
      height = +m[2];
    }

    const res = await bundlePathtraceFilm({
      filmDir: ctx.args.filmDir,
      entry: ctx.opts.entry || undefined,
      probeOut: ctx.opts.out || undefined,
      outBundle: ctx.opts.bundle || undefined,
      sdkDir: ctx.opts.sdk || undefined,
      presetsDir: ctx.opts.presets || undefined,
      width,
      height,
      fps: ctx.opts.fps ?? undefined,
      env: ctx.env,
    });

    const outputs = [
      { path: repoRel(res.bundlePath), sha256: res.bundleSha256, kind: 'bundle' },
      { path: repoRel(res.eventsPath), sha256: sha256(fs.readFileSync(res.eventsPath)), kind: 'events' },
      { path: repoRel(res.timelinePath), sha256: sha256(fs.readFileSync(res.timelinePath)), kind: 'timeline' },
      { path: repoRel(res.textsPath), sha256: sha256(fs.readFileSync(res.textsPath)), kind: 'texts' },
    ];
    const data = {
      bundle: repoRel(res.bundlePath),
      bundleSha256: res.bundleSha256,
      width: res.width,
      height: res.height,
      fps: res.fps,
      frameCount: res.frameCount,
      textTracks: res.probe.summary.length,
    };

    ctx.out(
      `光追场景已打包：${data.bundle}（${res.width}×${res.height} @ ${res.fps}fps，共 ${res.frameCount} 帧，文字轨道 ${data.textTracks} 条）`,
    );
    return { outputs, data };
  },
});

if (isMain(import.meta.url)) {
  await runCli(command);
}
