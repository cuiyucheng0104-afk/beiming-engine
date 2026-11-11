// spec.mirror：《北冥》镜像 films/beiming-10s/film.json 与冻结样片的源码（src/timeline.js、src/main.js、src/hud.js…）
// 和声音表 audio/cues.json 一致：样片源码改了切点或事件时刻、镜像没跟上（或反过来），这里报错（ORCH-01）。
import { engineLibs, finding } from './_lib.mjs';
import { pathToFileURL } from 'node:url';

const DIR = 'films/beiming-10s';

export default {
  id: 'spec.mirror',
  title: '《北冥》镜像 films/beiming-10s 与冻结样片一致',
  async run(ctx) {
    if (!ctx.exists(`${DIR}/mirror-check.mjs`)) return [{ level: 'info', message: `${DIR} 不存在，跳过` }];
    const L = await engineLibs(ctx);
    const m = await import(pathToFileURL(ctx.abs(`${DIR}/mirror-check.mjs`)).href);
    let film;
    try { film = L.film.assertValidFilm(L.film.loadFilm(ctx.abs(DIR)), `${DIR}/film.json`); } catch (error) {
      return [finding('error', error.code ?? 'mirror-film', `${DIR}/film.json`, error.message, error.hint)];
    }
    const r = m.checkMirror(film, m.readSources(ctx.root), { root: ctx.root });
    const out = r.diagnostics.map(x => finding(x.level, x.code, `${DIR}/film.json`, `${x.path}：${x.message}`, x.hint || '确认样片源码是否被改过；镜像只描述样片现状'));
    if (!out.length) out.push({ level: 'info', message: '镜像与样片源码、声音表一致' });
    return out;
  },
};
