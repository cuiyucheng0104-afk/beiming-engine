// render.compat-exports：engine/render/page.mjs 继续导出别的包在用的名字（tools/env 的 doctor 用 chromeArgs / SOFTWARE_RENDERER /
// defaultAngle，engine/native/sequence.mjs 用 openFilm / closeServer，tests/production 用 filmRelative / insideRoot / isSoftwareRenderer…），
// lib/server.mjs 导出 createServer（QA 门的页面服务可改用它）。改名或删掉会让别的命令在运行时才崩，这里在提交前拦下。
const REQUIRED = {
  'engine/render/page.mjs': ['openFilm', 'closeServer', 'locateFilm', 'renderFrame', 'finalFaultCheck', 'readContract', 'ROOT', 'CONTRACT_VERSION',
    'FilmError', 'takeSize', 'filmRelative', 'insideRoot', 'readyTimeoutMs', 'frameTimeoutMs', 'chromeArgs', 'chromeExecutable', 'defaultAngle',
    'isSoftwareRenderer', 'SOFTWARE_RENDERER'],
  'engine/render/lib/server.mjs': ['createServer', 'resolveRequest'],
  'engine/render/lib/gpu.mjs': ['launchBrowser', 'resolveAngle', 'resolveGpuPolicy', 'probeGpu', 'enforceGpu'],
  'engine/render/lib/slots.mjs': ['checkSharedGpu', 'guardGpu', 'acquireSlot'],
  'engine/render/lib/mux.mjs': ['mux', 'aigcMetadata'],
};

/** 源码里导出的名字（export function / class / const / let，与 export { a, b as c }） */
export function exportedNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const p = part.trim();
      if (!p) continue;
      const as = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(p);
      names.add(as ? as[1] : p.split(/\s+/)[0]);
    }
  }
  return names;
}

export default {
  id: 'render.compat-exports',
  title: 'engine/render 继续导出别的包在用的接口（page.mjs 的 chromeArgs、SOFTWARE_RENDERER、defaultAngle 等）',
  run(ctx) {
    const out = [];
    for (const [file, names] of Object.entries(REQUIRED)) {
      if (!ctx.exists(file)) { out.push({ level: 'error', file, message: `${file} 不存在`, hint: '渲染器的公共接口在这里：恢复它' }); continue; }
      const have = exportedNames(ctx.read(file));
      const missing = names.filter(n => !have.has(n));
      if (missing.length) out.push({ level: 'error', file, message: `${file} 不再导出 ${missing.join('、')}`, hint: '这些名字有别的包在用（见本规则文件头）：保留导出，改名就留一个别名一个版本' });
    }
    if (!out.length) out.push({ level: 'info', message: `渲染器的 ${Object.values(REQUIRED).flat().length} 个公共导出都在` });
    return out;
  },
};
