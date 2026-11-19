// route-d.runtime-and-template：D 路线（北冥光追 · 物理路径追踪，决定 D13）护栏：
//   1. git 不跟踪路径追踪运行时二进制（threert-render、threert-render.exe、libOpenImageDenoise*）；
//   2. engine/pathtrace 与 routes/d-pathtrace 下不放入 .rs / .wesl / .wgsl 源码或 Cargo 清单（着色器以 WGSL 字符串写在自有 .js / .ts 模块里）；
//   3. engine/pathtrace 已落地时，须包含纯 ESM 入口 index.js（Node 22 兼容）与结构完整的 runtime.lock.json（schemaVersion 1、MIT、40 位 commit、三平台条目与至少一个 64 位 binarySha256）；
//   4. routes/d-pathtrace/README.md 与 template/{film.json,scene.ts,mix.py,TREATMENT.md,README.md} 齐全且确定性合规。

const LOCK = 'engine/pathtrace/runtime.lock.json';
const INDEX_JS = 'engine/pathtrace/index.js';
const MANUAL = 'routes/d-pathtrace/README.md';
const TPL = 'routes/d-pathtrace/template';
const TPL_FILES = ['film.json', 'scene.ts', 'mix.py', 'TREATMENT.md', 'README.md'];
const SOURCE_DIRS = ['engine/pathtrace', 'routes/d-pathtrace'];
const PLATFORMS = ['linux-x64', 'macos-arm64', 'windows-x64'];
const BINARY_RE = /(^|\/)(threert-render)(\.exe)?$|(^|\/)libOpenImageDenoise[^/]*$/i;
const UPSTREAM_SRC_RE = /\.(rs|wesl|wgsl)$|(^|\/)Cargo\.(toml|lock)$/i;
const NON_DETERMINISTIC_RE = /\b(Math\.random|Date\.now|performance\.now)\s*\(/;

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

export default {
  id: 'route-d.runtime-and-template',
  title: 'D 路线手册与模版齐全，运行时锁有效，不跟踪二进制或 Rust/WESL/WGSL 源码',
  run(ctx) {
    const out = [];
    const err = (file, message, hint = null) => out.push({ level: 'error', file, message, ...(hint ? { hint } : {}) });

    // 1. 不跟踪路径追踪运行时二进制或降噪动态库
    const g = ctx.git(['ls-files', '-z']);
    const tracked = g.ok ? g.stdout.split('\0').filter(Boolean) : ['engine', 'routes', 'tools'].flatMap(d => ctx.walk(d));
    for (const f of tracked) {
      if (BINARY_RE.test(f)) {
        err(f, '路径追踪运行时二进制或降噪库不能进 git（决定 D10 / D13）',
          '执行 git rm --cached 移除；运行时放 ~/.cache/beiming/pathtrace/<版本>/ 或由 BEIMING_PT_BIN 指向');
      }
    }

    // 2. D 路线与光追引擎目录下不放入 .rs / .wesl / .wgsl / Cargo.toml
    for (const dir of SOURCE_DIRS) {
      if (!ctx.isDir(dir)) continue;
      for (const f of ctx.walk(dir)) {
        if (UPSTREAM_SRC_RE.test(f)) {
          err(f, 'D 路线目录里出现 Rust / WESL / WGSL 源文件或 Cargo 清单（决定 D10 / D13）',
            '不搬入上游运行时源码；作品与引擎自定义材质统一写成自有 .js / .ts 模块里的 WGSL 字符串');
        }
      }
    }

    // 3. engine/pathtrace 落地时核验纯 ESM 入口 index.js 与 runtime.lock.json 结构
    if (ctx.isDir('engine/pathtrace') && !ctx.exists(INDEX_JS)) {
      err(INDEX_JS, 'engine/pathtrace 缺少纯 ESM 入口 index.js（Node 22 兼容，决定 D09 / D13）',
        '提供 engine/pathtrace/index.js 与配套 .d.ts 类型声明，不在运行时依赖 .ts 入口');
    }
    if (ctx.exists(LOCK)) {
      let lock = null;
      try {
        lock = ctx.readJson(LOCK);
      } catch (e) {
        err(LOCK, `不是合法 JSON（${e.message}）`);
      }
      if (lock && typeof lock === 'object') {
        if (lock.schemaVersion !== 1) err(LOCK, `schemaVersion 应为 1，当前为 ${JSON.stringify(lock.schemaVersion)}`);
        if (lock.license !== 'MIT') err(LOCK, `license 应为 "MIT"，当前为 ${JSON.stringify(lock.license)}`);
        if (!/^\d+\.\d+\.\d+/.test(String(lock.version || ''))) err(LOCK, 'version 缺失或不是语义化版本号');
        if (!/^[0-9a-f]{40}$/.test(String(lock.commit || ''))) err(LOCK, 'commit 应为 40 位十六进制提交哈希');
        let lockedCount = 0;
        for (const p of PLATFORMS) {
          const item = lock.platforms?.[p];
          if (!item || typeof item !== 'object') { err(LOCK, `platforms 缺少平台 ${p}`); continue; }
          if (typeof item.binary !== 'string' || !item.binary.trim()) err(LOCK, `platforms.${p}.binary 缺失`);
          if (typeof item.oidn !== 'boolean') err(LOCK, `platforms.${p}.oidn 必须是布尔值（如实记录是否链接 OIDN）`);
          if (item.binarySha256 !== null && item.binarySha256 !== undefined) {
            if (!/^[0-9a-f]{64}$/.test(String(item.binarySha256))) err(LOCK, `platforms.${p}.binarySha256 不是 64 位十六进制哈希`);
            else lockedCount++;
          }
        }
        if (lockedCount === 0) err(LOCK, '没有任何平台锁定了可执行文件 binarySha256');
      }
    } else if (ctx.isDir('engine/pathtrace')) {
      err(LOCK, 'engine/pathtrace 目录已存在，但缺少运行时版本锁 runtime.lock.json', '补充 engine/pathtrace/runtime.lock.json 并锁定 binarySha256');
    }

    // 4. D 路线手册与起步模版完整性
    if (!ctx.exists(MANUAL)) {
      err(MANUAL, 'D 路线手册缺失', '补齐 routes/d-pathtrace/README.md（含 8 个标准二级标题）');
    }
    if (!ctx.isDir(TPL)) {
      err(TPL, 'D 路线模版目录 routes/d-pathtrace/template 缺失');
    } else {
      for (const name of TPL_FILES) {
        const rel = `${TPL}/${name}`;
        if (!ctx.exists(rel)) err(rel, `D 路线模版缺少 ${name}`);
      }
      const sceneFile = `${TPL}/scene.ts`;
      if (ctx.exists(sceneFile)) {
        const code = stripComments(ctx.read(sceneFile));
        if (NON_DETERMINISTIC_RE.test(code)) {
          err(sceneFile, '模版 scene.ts 使用了非确定性 API（Math.random / Date.now / performance.now）',
            '改用 engine/pathtrace/index.js 的 frameSeed(seed, frame) 或纯解析函数');
        }
        if (!/definePathtraceFilm/.test(code)) {
          err(sceneFile, '模版 scene.ts 未通过 definePathtraceFilm 导出纯帧号场景');
        }
        if (!/engine\/pathtrace\/index\.js/.test(code)) {
          err(sceneFile, '模版 scene.ts 应从 ../../engine/pathtrace/index.js 导入光追场景底座（Node 22 兼容）');
        }
      }
      const fjFile = `${TPL}/film.json`;
      if (ctx.exists(fjFile)) {
        try {
          const fj = ctx.readJson(fjFile);
          if (fj?.route !== 'd' || fj?.backend !== 'pathtrace') {
            err(fjFile, `模版 film.json 的 route/backend 应为 "d" / "pathtrace"，当前为 ${JSON.stringify([fj?.route, fj?.backend])}`);
          }
          if (!fj?.pathtrace || typeof fj.pathtrace !== 'object') {
            err(fjFile, '模版 film.json 缺少顶层 pathtrace 配置段');
          }
        } catch {
          // 非法 JSON 由 core.templates 统一报错
        }
      }
    }

    if (!out.some(x => x.level === 'error')) {
      out.push({ level: 'info', message: 'D 路线手册、起步模版、源码边界与运行时锁检查通过' });
    }
    return out;
  },
};
