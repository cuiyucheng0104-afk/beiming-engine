// route-a.film-style：A 路线模版与 films/ 下 route = a 的作品，film.json 的 style 已登记、每镜 lookPreset 可解析且属于本片画风、
// lookOverrides 在画风 allowedOverrides 的范围内——与页面里 strict 解析同一套代码（engine/style/index.js），未登记即失败，不静默回退。
// lookPreset 在附录 C6 里是可选字段：镜像作品（film.mirror，画面由被镜像的源码决定）不写只记提示；照 A 模版做的作品必须写，
// 因为模版页面（main.js）按它取每镜的后期预设，缺了页面加载就报错。
import { parseLookPreset, styleKey, resolveLook } from '../../../../engine/style/index.js';
import { aFilms, styleFor, touched } from './_shared.mjs';

export default {
  id: 'route-a.film-style',
  title: 'A 路线作品的画风与每镜 lookPreset 都在画风注册表里，镜头覆盖不越界',
  run(ctx) {
    const out = [], { list, bad } = aFilms(ctx);
    for (const b of bad) out.push({ level: 'error', file: b.file, message: `不是合法 JSON：${b.message}` });
    for (const { dir, file, film, template } of list) {
      if (!touched(ctx, dir)) continue;
      if (film.schemaVersion !== 2) { out.push({ level: template ? 'error' : 'warn', file, message: '不是 film.json v2（附录 C6），画风与 lookPreset 无法核对', hint: 'node engine/production/film.js upgrade <作品目录> --write' }); continue; }
      let st;
      try { st = styleFor(ctx, film.style); } catch (e) { out.push({ level: 'error', file, message: `style：${e.message}`, hint: '写已登记的画风（engine/style/registry.json），新画风按 routes/a-webgl/LOOKDEV.md 签认后登记' }); continue; }
      let n = 0, free = 0;
      for (const s of film.shots || []) {
        if (s.lookPreset === undefined) {
          if (film.mirror) { free++; continue; }
          out.push({ level: 'error', file, message: `镜头 ${s.id} 没写 lookPreset（A 模版的页面按它取后期预设，缺了页面加载就报错）`, hint: '写成 <画风>@v<版本>/<预设>，例如 beiming-original@v1/wide' });
          continue;
        }
        try {
          const p = parseLookPreset(s.lookPreset);
          if (styleKey(p) !== st.key) throw new Error(`属于 ${styleKey(p)}，不是本片画风 ${st.key}`);
          resolveLook(st.doc, p.preset, s.lookOverrides || {}, { strict: true });
          n++;
        } catch (e) { out.push({ level: 'error', file, message: `镜头 ${s.id} 的 lookPreset ${JSON.stringify(s.lookPreset)}：${e.message}`, hint: '预设名见画风锁定文件的 lookPresets；覆盖只能改 allowedOverrides 允许的字段与范围' }); }
      }
      if (n + free === (film.shots || []).length) out.push({ level: 'info', file, message: free
        ? `画风 ${st.key}；镜像作品，${free} 个镜头没写 lookPreset（画面由源码决定，不核对）${n ? `，另 ${n} 个可解析` : ''}`
        : `画风 ${st.key}，${n} 个镜头的 lookPreset 都可解析` });
    }
    return out;
  },
};
