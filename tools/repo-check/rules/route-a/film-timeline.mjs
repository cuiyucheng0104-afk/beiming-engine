// route-a.film-timeline：A 路线作品的镜头表与事件表（film.json v2，单位：帧）——镜头半开区间 [in, out) 首尾相接覆盖 [0, frameCount)、
// 镜头模块文件存在（镜像作品 mirror.paths = "repo" 时按仓库根找）、事件帧是整数且落在所属镜头内。画面、声音、字幕都读这一张表（附录 C6），表断了三者就对不上。
import { aFilms, touched, moduleBase } from './_shared.mjs';

export default {
  id: 'route-a.film-timeline',
  title: 'A 路线作品的镜头表首尾相接覆盖全片、事件落在所属镜头内、镜头模块存在',
  run(ctx) {
    const out = [];
    for (const { dir, file, film } of aFilms(ctx).list) {
      if (!touched(ctx, dir) || film.schemaVersion !== 2) continue;
      const n0 = out.length, N = film.output?.frameCount, shots = film.shots || [];
      if (!(Number.isInteger(N) && N > 0)) out.push({ level: 'error', file, message: 'output.frameCount 要是正整数' });
      let at = 0;
      for (const s of shots) {
        if (!(Number.isInteger(s.in) && Number.isInteger(s.out) && s.out > s.in)) { out.push({ level: 'error', file, message: `镜头 ${s.id}：in / out 要是整数帧且 out > in` }); continue; }
        if (s.in !== at) out.push({ level: 'error', file, message: `镜头 ${s.id} 从第 ${s.in} 帧开始，上一镜到第 ${at} 帧为止`, hint: '镜头是半开区间 [in, out)，下一镜的 in 等于上一镜的 out' });
        at = s.out;
        if (!s.module || !ctx.exists(`${moduleBase(dir, film)}${s.module}`)) out.push({ level: 'error', file, message: `镜头 ${s.id} 的模块 ${s.module} 不存在` });
      }
      if (Number.isInteger(N) && at !== N) out.push({ level: 'error', file, message: `镜头表到第 ${at} 帧结束，output.frameCount 是 ${N}`, hint: '改时长只改 film.json：最后一镜的 out 等于 frameCount' });
      for (const e of film.events || []) {
        const s = shots.find(x => x.id === e.shot);
        if (!Number.isInteger(e.frame)) out.push({ level: 'error', file, message: `事件 ${e.id} 的 frame 要是整数帧` });
        else if (!s) out.push({ level: 'error', file, message: `事件 ${e.id} 指向不存在的镜头 ${e.shot}` });
        else if (e.frame < s.in || e.frame >= s.out) out.push({ level: 'error', file, message: `事件 ${e.id} 在第 ${e.frame} 帧，不在镜头 ${s.id} 的 [${s.in}, ${s.out}) 里` });
      }
      if (out.length === n0) out.push({ level: 'info', file, message: `${shots.length} 个镜头首尾相接覆盖 [0, ${N})，${(film.events || []).length} 个事件都落在所属镜头里` });
    }
    return out;
  },
};
