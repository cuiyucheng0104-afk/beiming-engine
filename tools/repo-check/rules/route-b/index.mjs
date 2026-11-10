#!/usr/bin/env node
// 北冥仓库规范检查 · B 路线（北冥原生 · BNE）规则包：只读，不改任何文件。
// 给 tools/repo-check 的「执行器 + rules/<包域>/ 插件」结构用（P02 接线）；也能单独跑：
//   node tools/repo-check/rules/route-b/index.mjs [--root 目录] [--json]     退出码：0 全过 · 2 用法 · 4 有错误
//
// 插件接口（与执行器约定）：export const rules = [{ id, title, run({ root }) → { errors: string[], warnings: string[], ok?: string } }]
//   run 只读 root 下的文件；路径一律相对 root、用 /。
//
// 规则
//   route-b.no-hardcoded-contract   模版与出片入口不写死某部片的契约：240 帧、-t 10、native-10s（加固计划 B1 验收）
//   route-b.runtime-lock            engine/native/runtime.lock.json：版本、FSL-1.1-ALv2 许可、三平台归档 sha256、至少一个平台的可执行文件 sha256
//   route-b.no-runtime-distribution 不分发上游运行时：仓库里不跟踪 raea / raea.exe / libraea* 等二进制，engine / routes / examples / tools
//                                   里没有上游版权头（决定 D03：不分发运行时、不复制其源码）
//   route-b.manual-boundary         B 路线手册写明 BNE 释义（Beiming Native Edition）、「基于 RAEA 原生运行时（FSL-1.1-ALv2）」与 FSL 使用边界
//   route-b.spawn-timeout           B 路线的 Node 代码不直接调 spawnSync / execSync / execFileSync（统一经 engine/native/cli.mjs 的
//                                   runQuick / spawnStream，必带超时与清理）
//   route-b.film-module-imports     作品目录里被 film.tsx 引用的辅助模块不 import 作品目录之外的文件（原生运行时打包限制，实测 canary.2）
//   route-b.aigc-label              用了 assets/plates（AI 生成底板）的 B 作品 / 模版，film.json 要写 aigc.contains = true（决定 D11）
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, '../../../..');
const posix = p => p.split(sep).join('/');
const read = (root, f) => readFileSync(join(root, f), 'utf8');
const exists = (root, f) => existsSync(join(root, f));

function walk(root, dir, out = []) {
  if (!exists(root, dir)) return out;
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (['node_modules', '.git', 'media', 'out', 'delivery'].includes(e.name)) continue;
    const r = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) walk(root, r, out); else out.push(r);
  }
  return out;
}
// 去掉注释后再查（注释里写「不要用 spawnSync」不算违规）
const code = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const FILM_DIRS = root => [
  'routes/b-native/template', 'examples/raea',
  ...(exists(root, 'films') ? readdirSync(join(root, 'films')).map(n => `films/${n}`).filter(d => {
    try { return JSON.parse(read(root, `${d}/film.json`)).route === 'b'; } catch { return false; }
  }) : []),
];

export const rules = [
  {
    id: 'route-b.no-hardcoded-contract', title: '模版与出片入口不写死某部片的契约',
    run({ root }) {
      const errors = [];
      for (const f of [...walk(root, 'routes/b-native/template'), 'engine/render/native.mjs']) {
        if (!exists(root, f) || !/\.(m?js|tsx?|json|py)$/.test(f)) continue;
        read(root, f).split('\n').forEach((l, i) => { if (/\b240\b|-t 10\b|native-10s/.test(l)) errors.push(`${f}:${i + 1} 写死了某部片的契约（240 帧 / -t 10 / native-10s）：从 film.json 读`); });
      }
      return { errors, warnings: [], ok: '模版与 engine/render/native.mjs 没有写死帧数、时长与产物名' };
    },
  },
  {
    id: 'route-b.runtime-lock', title: '原生运行时锁定记录完整',
    run({ root }) {
      const f = 'engine/native/runtime.lock.json', errors = [], warnings = [];
      let lock;
      try { lock = JSON.parse(read(root, f)); } catch (e) { return { errors: [`${f} 读不了或不是 JSON：${e.message}`], warnings }; }
      if (!/^\d+\.\d+\.\d+/.test(lock.version || '')) errors.push(`${f}：version 缺失`);
      if (lock.license !== 'FSL-1.1-ALv2') errors.push(`${f}：license 应为 FSL-1.1-ALv2`);
      if (!/^[0-9a-f]{40}$/.test(lock.sourceCommit || '')) errors.push(`${f}：sourceCommit 应为 40 位提交号`);
      for (const k of ['macos-arm64', 'windows-x64', 'linux-x64']) {
        const p = lock.platforms?.[k];
        if (!p) { errors.push(`${f}：缺平台 ${k}`); continue; }
        if (!/^[0-9a-f]{64}$/.test(p.sha256 || '')) errors.push(`${f}：${k} 的归档 sha256 缺失`);
        if (!p.binarySha256) warnings.push(`${f}：${k} 还没有可执行文件 sha256（在该平台运行 node engine/native/runtime.mjs hash 补齐）`);
      }
      if (!Object.values(lock.platforms || {}).some(p => /^[0-9a-f]{64}$/.test(p.binarySha256 || ''))) errors.push(`${f}：没有任何平台锁定了可执行文件 sha256`);
      return { errors, warnings, ok: `运行时 ${lock.version} 的许可、三平台归档与可执行文件哈希已锁定` };
    },
  },
  {
    id: 'route-b.no-runtime-distribution', title: '不分发上游运行时、不复制其源码',
    run({ root }) {
      const errors = [];
      let tracked = [];
      const g = spawnSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
      if (g.status === 0) tracked = g.stdout.split('\n').filter(Boolean);
      else tracked = ['engine', 'routes', 'examples', 'tools'].flatMap(d => walk(root, d));
      for (const f of tracked) if (/(^|\/)raea(\.exe)?$|(^|\/)libraea[^/]*$|(^|\/)raea-perceive(\.exe)?$/i.test(f)) errors.push(`${f}：上游运行时二进制不能进仓库（决定 D03）`);
      for (const d of ['engine', 'routes', 'examples', 'tools']) for (const f of walk(root, d)) {
        if (!/\.(m?js|tsx?|rs|wgsl|wesl)$/.test(f) || f.startsWith('tools/repo-check/rules/route-b/')) continue;
        if (/Copyright \d{4} Shane Murphy|Functional Source License/.test(read(root, f))) errors.push(`${f}：带上游版权 / 许可头，像是复制了上游源码（决定 D03：只写调用代码，不复制）`);
      }
      return { errors, warnings: [], ok: '没有跟踪上游运行时二进制，自有代码里没有上游源码' };
    },
  },
  {
    id: 'route-b.manual-boundary', title: 'B 路线手册写明 BNE 释义与 FSL 使用边界',
    run({ root }) {
      const f = 'routes/b-native/README.md';
      if (!exists(root, f)) return { errors: [`${f} 不存在`], warnings: [] };
      const t = read(root, f), errors = [];
      const need = [[/Beiming Native Edition/, 'BNE 的释义「Beiming Native Edition」'], [/基于 `?RAEA`? 原生运行时（FSL-1\.1-ALv2）/, '「基于 RAEA 原生运行时（FSL-1.1-ALv2）」'],
        [/内部制作层/, 'FSL 使用边界（只作内部制作层）'], [/--accept-license/, '获取运行时要显式接受许可'], [/书面许可/, '商业化前取得上游书面许可']];
      for (const [re, what] of need) if (!re.test(t)) errors.push(`${f} 缺少：${what}（决定 D03 / D04）`);
      const boundary = t.split(/^## /m).find(s => s.startsWith('边界与常见坑'));
      if (!boundary || !/FSL/.test(boundary)) errors.push(`${f}「边界与常见坑」一节要写 FSL 使用边界`);
      return { errors, warnings: [], ok: '手册写明 BNE 释义、上游署名与 FSL 使用边界' };
    },
  },
  {
    id: 'route-b.spawn-timeout', title: '外部进程统一经带超时的公共件调用',
    run({ root }) {
      const errors = [];
      const files = [...walk(root, 'engine/native'), 'engine/render/native.mjs', ...walk(root, 'examples/raea/tools')].filter(f => /\.mjs$/.test(f) && f !== 'engine/native/cli.mjs');
      for (const f of files) {
        if (!exists(root, f)) continue;
        code(read(root, f)).split('\n').forEach((l, i) => { if (/(?<![\w.])(spawnSync|execSync|execFileSync|exec)\s*\(/.test(l) && !/runQuick|spawnStream/.test(l)) errors.push(`${f}:${i + 1} 直接调外部进程：改用 engine/native/cli.mjs 的 runQuick（同步、必带超时）或 spawnStream（流式、超时、信号清理）`); });
      }
      return { errors, warnings: [], ok: 'B 路线代码的外部进程都经 runQuick / spawnStream（带超时）' };
    },
  },
  {
    id: 'route-b.film-module-imports', title: '作品的辅助模块不 import 作品目录之外',
    run({ root }) {
      const errors = [];
      for (const dir of FILM_DIRS(root)) {
        let entry = 'film.tsx';
        try { entry = JSON.parse(read(root, `${dir}/film.json`)).native?.entry || entry; } catch { /* 默认 */ }
        if (!exists(root, `${dir}/${entry}`)) continue;
        const local = [...read(root, `${dir}/${entry}`).matchAll(/from\s+['"](\.\/[^'"]+\.(?:m?js|tsx?))['"]/g)].map(m => posix(join(dir, m[1])));
        for (const f of local) {
          if (!exists(root, f)) continue;
          for (const m of code(read(root, f)).matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
            const spec = m[1];
            if (spec.startsWith('.') && relative(join(root, dir), resolve(join(root, f), '..', spec)).startsWith('..')) errors.push(`${f} import 了作品目录之外的 ${spec}：原生运行时打包时会 REFUSED。把需要的函数由 ${entry} 传进来`);
            else if (!spec.startsWith('.')) errors.push(`${f} import 了包 ${spec}：作品的辅助模块要写成不依赖任何包的纯函数`);
          }
        }
      }
      return { errors, warnings: [], ok: 'B 作品与模版的辅助模块只 import 作品目录里的文件' };
    },
  },
  {
    id: 'route-b.aigc-label', title: '用了 AI 生成底板的 B 作品写明 aigc',
    run({ root }) {
      const errors = [];
      for (const dir of FILM_DIRS(root)) {
        let film;
        try { film = JSON.parse(read(root, `${dir}/film.json`).replace(/\{\{(NAME|TITLE)\}\}/g, 'x')); } catch { continue; }
        const usesPlates = (film.native?.images || []).some(im => /assets\/plates\//.test(im.from || '') && !/paper\.png$/.test(im.from));
        if (usesPlates && film.aigc?.contains !== true) errors.push(`${dir}/film.json 用了 assets/plates 的 AI 生成底板，要写 "aigc": { "contains": true, "note": … }（决定 D11）`);
      }
      return { errors, warnings: [], ok: '用了 AI 生成底板的 B 作品都写了 aigc' };
    },
  },
];

export function check(root = DEFAULT_ROOT) {
  return rules.map(r => {
    try { const res = r.run({ root }); return { id: r.id, title: r.title, ...res, status: res.errors.length ? 'fail' : res.warnings.length ? 'warn' : 'pass' }; }
    catch (e) { return { id: r.id, title: r.title, errors: [`规则自身出错：${e.message}`], warnings: [], status: 'fail' }; }
  });
}

const isMain = () => { try { return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };
if (isMain()) {
  const argv = process.argv.slice(2), json = argv.includes('--json');
  if (argv.includes('--help')) { process.stdout.write('node tools/repo-check/rules/route-b/index.mjs [--root 目录] [--json]\n  B 路线（北冥原生 · BNE）的仓库规范检查，只读。退出码：0 全过 · 2 用法 · 4 有错误\n'); process.exit(0); }
  const ri = argv.indexOf('--root');
  const unknown = argv.filter((a, i) => a.startsWith('--') && !['--json', '--root', '--help'].includes(a) && argv[i - 1] !== '--root');
  if (unknown.length || (ri >= 0 && !argv[ri + 1])) {
    const msg = unknown.length ? `不认识的参数 ${unknown.join(' ')}` : '--root 后面要跟目录';
    if (json) process.stdout.write(JSON.stringify({ ok: false, exitCode: 2, command: 'repo-check:route-b', error: { code: 'usage', message: msg, hint: '加 --help 看用法' }, outputs: [], runJson: null, warnings: [] }) + '\n');
    else process.stderr.write(`失败（exit 2）：${msg}。下一步：加 --help 看用法\n`);
    process.exit(2);
  }
  const root = ri >= 0 ? resolve(argv[ri + 1]) : DEFAULT_ROOT;
  const results = check(root), bad = results.filter(r => r.status === 'fail');
  if (json) {
    process.stdout.write(JSON.stringify({ ok: !bad.length, exitCode: bad.length ? 4 : 0, command: 'repo-check:route-b', error: bad.length ? { code: 'rules', message: `${bad.length} 条 B 路线规则不通过`, hint: '按每条错误的说明修改' } : null, outputs: [], runJson: null, warnings: results.flatMap(r => r.warnings), results }) + '\n');
  } else {
    for (const r of results) {
      process.stderr.write(`${r.status === 'fail' ? '✗' : r.status === 'warn' ? '!' : '✓'} ${r.id}：${r.status === 'pass' ? r.ok || r.title : r.title}\n`);
      for (const e of r.errors) process.stderr.write(`    ✗ ${e}\n`);
      for (const w of r.warnings) process.stderr.write(`    ! ${w}\n`);
    }
  }
  process.exit(bad.length ? 4 : 0);
}
