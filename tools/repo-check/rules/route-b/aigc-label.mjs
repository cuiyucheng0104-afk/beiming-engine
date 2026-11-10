// route-b.aigc-label：用了 assets/plates 下 AI 生成底板（纸纹除外）的 B 作品、模版、样张，film.json 要写 aigc.contains = true
// 和 note（决定 D11；渲染入口据此在 mp4 写隐式标识、在 player.html 写显式标识）。plates.json 记了这些底板的来源链。
import { filmDirs } from './_shared.mjs';

export default {
  id: 'route-b.aigc-label',
  title: '用了 AI 生成底板的 B 作品写明 aigc',
  run(ctx) {
    const out = [];
    let n = 0;
    for (const dir of filmDirs(ctx)) {
      const f = `${dir}/film.json`;
      let film;
      try { film = ctx.readJson(f); } catch { continue; }
      const plates = (film.native?.images || []).map(im => String(im.from || '')).filter(p => /assets\/plates\//.test(p) && !/paper\.png$/.test(p));
      if (!plates.length) continue;
      n++;
      if (film.aigc?.contains !== true) out.push({ level: 'error', file: f, message: `用了 AI 生成的底板（${plates.map(p => p.split('/').pop()).join('、')}），但没有写 aigc.contains = true`, hint: '加 "aigc": { "contains": true, "note": "…由 AI 生成后人工整理（assets/plates/plates.json）" }（决定 D11）' });
      else if (!film.aigc.note) out.push({ level: 'warn', file: f, message: 'aigc 缺 note：说明哪些画面由 AI 生成', hint: '写进 aigc.note，渲染入口会写进 player.html' });
    }
    if (!out.length) out.push({ level: 'info', message: `${n} 部用了 AI 生成底板的 B 作品都写了 aigc` });
    return out;
  },
};
