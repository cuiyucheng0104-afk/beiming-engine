// route-a.film-fonts：A 路线作品的文字与字体——texts 用到的字族都在 fonts 里声明、source 在字体锁定清单里；
// 作品（非模版）已经生成本片子集（tools/fonts/subset.mjs），子集覆盖全部文字、文件没被改过。缺字时页面会抛 GlyphError，
// 这里在提交前就拦下（审计 TOOLS-13 / ENV-14；QA 的 texts.glyphs 在渲出的画面上复查）。
import fs from 'node:fs';
import { parseFontsManifest, missingChars } from '../../../../engine/style/fonts.js';
import { sha256 } from '../../../lib/cli.mjs';
import { aFilms, touched, hasPlaceholder } from './_shared.mjs';

const LOCK = 'fonts/fonts.lock.json';

export default {
  id: 'route-a.film-fonts',
  title: 'A 路线作品的文字都有声明过的字族，作品的字体子集覆盖全部文字',
  run(ctx) {
    const out = [];
    let lock = null;
    try { lock = ctx.readJson(LOCK); } catch { lock = null; }
    const ids = new Set((lock?.fonts || []).map(f => f.id));
    for (const { dir, file, film, template } of aFilms(ctx).list) {
      if (!touched(ctx, dir) || film.schemaVersion !== 2 || !Array.isArray(film.texts) || !film.texts.length) continue;
      const n0 = out.length, fam = new Map((film.fonts || []).map(f => [f.family, f]));
      for (const f of fam.values()) if (lock && !ids.has(f.source)) out.push({ level: 'error', file, message: `字族 ${f.family} 的 source ${f.source} 不在 ${LOCK} 里`, hint: `可用：${[...ids].join('、')}` });
      for (const t of film.texts) if (!fam.has(t.font)) out.push({ level: 'error', file, message: `文字 ${t.id} 用了没声明的字族 ${t.font}`, hint: '在 film.json 的 fonts 里声明它（family → 锁定字体 source）' });
      if (!template) {
        const mf = `${dir}/fonts/fonts.json`, fix = `node tools/fonts/subset.mjs ${dir}`;
        if (!ctx.exists(mf)) out.push({ level: 'error', file, message: '还没生成本片的字体子集（页面会报「找不到字体清单」）', hint: fix });
        else {
          let M = null;
          try { M = parseFontsManifest(ctx.readJson(mf)); } catch (e) { out.push({ level: 'error', file: mf, message: e.message, hint: fix }); }
          if (M) {
            for (const t of film.texts) {
              if (hasPlaceholder(t.text)) { out.push({ level: 'error', file, message: `文字 ${t.id} 还是占位符 ${t.text}` }); continue; }
              const e = M.fonts.find(x => x.family === t.font), miss = e ? missingChars(e, t.text) : [...t.text];
              if (miss.length) out.push({ level: 'error', file, message: `文字 ${t.id} 缺字 ${miss.join('')}：子集过期`, hint: fix });
            }
            for (const e of M.fonts) {
              const p = `${dir}/fonts/${e.file}`;
              if (!ctx.exists(p)) out.push({ level: 'error', file: mf, message: `清单列的 ${e.file} 不存在`, hint: fix });
              else if (e.sha256 && ctx.memo(`sha256:${p}`, () => sha256(fs.readFileSync(ctx.abs(p)))) !== e.sha256) out.push({ level: 'error', file: mf, message: `${e.file} 与清单记的 sha256 不一致（被改过）`, hint: fix });
            }
          }
        }
      }
      if (out.length === n0) out.push({ level: 'info', file, message: `${film.texts.length} 条文字的字族都已声明${template ? '' : '，子集覆盖全部文字'}` });
    }
    return out;
  },
};

