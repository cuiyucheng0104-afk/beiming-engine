// route-a.film-style：A 路线模版与 films/ 下 route = a 的作品，film.json 的 style 已登记、每镜 lookPreset 可解析且属于本片画风、
// lookOverrides 在画风 allowedOverrides 的范围内——与页面里 strict 解析同一套代码（engine/style/index.js），未登记即失败，不静默回退。
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
      let n = 0;
      for (const s of film.shots || []) {
        if (s.lookPreset === undefined) { out.push({ level: 'error', file, message: `镜头 ${s.id} 没写 lookPreset`, hint: '写成 <画风>@v<版本>/<预设>，例如 beiming-original@v1/wide' }); continue; }
        try {
          const p = parseLookPreset(s.lookPreset);
          if (styleKey(p) !== st.key) throw new Error(`属于 ${styleKey(p)}，不是本片画风 ${st.key}`);
          resolveLook(st.doc, p.preset, s.lookOverrides || {}, { strict: true });
          n++;
        } catch (e) { out.push({ level: 'error', file, message: `镜头 ${s.id} 的 lookPreset ${JSON.stringify(s.lookPreset)}：${e.message}`, hint: '预设名见画风锁定文件的 lookPresets；覆盖只能改 allowedOverrides 允许的字段与范围' }); }
      }
      if (n === (film.shots || []).length) out.push({ level: 'info', file, message: `画风 ${st.key}，${n} 个镜头的 lookPreset 都可解析` });
    }
    return out;
  },
};
