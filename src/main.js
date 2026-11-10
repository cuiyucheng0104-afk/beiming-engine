// src/main.js —《北冥》10 秒概念样片 · 正片入口（合成与渲染总监）
// 三渲二 + 2.5D 合成，六层配方：
//   ① 3D 简单几何体（鲲、渡船）+ 实例化海草 / 藤壶 / 珊瑚 / 海葵   —— kun.js / ferry.js
//   ② 卡通着色（三档色阶、背光边缘光、锈斑噪点、抖动墨线）         —— toon.js + look.js（屏幕空间墨线）
//   ③ 2D 手绘底板作 3D 场景里的面片 / 穹顶分层，镜头运动产生真实视差 —— engine/stage + shotA/B/C
//   ④ 角色一拍二、鲲一拍三；镜头、底板、雾、水 24 fps 平滑          —— 各镜头 update(t, f) 里用 engine/core/clock.js 量化
//   ⑤ 后期：雾（3D 物体自带）→ bloom → 暖色调色 → Kuwahara 颜料笔触 → 墨线 → 纸纹 → 暗角 → 颗粒 —— look.js
//   ⑥ 逐帧离线渲染（engine/render），ffmpeg 编码，base64 单文件 HTML —— build.sh
// 渲染器、显示层画布、设计尺寸缩放、切镜头和页面约定由 engine/stage/film.js 负责；这里只有本片的底板名单、显示层配置和镜头表
// （镜头起点与片长在 src/timeline.js，全片只写那一处）。
// 调试参数：?nohud=1 不画显示层和片名（TEXTS 也不报）；?markers=1 / log 标出鲲的部位；?warm=5.3,7.5 改预热时刻（空 = 不预热，
// 用来核对“任意帧单独渲 = 顺序渲”）；其余见各镜头文件。
import { createFilm } from '../engine/stage/film.js';
import { TIMELINE } from './timeline.js';
import { createLook } from './look.js';
import { loadHUDFonts, drawHUD, drawTitle, textsAt, setHUDTheme, setTitleLayout, HUD_T } from './hud.js';
import { loadPlates } from '../engine/stage/plates.js';
import { buildShotA } from './shotA.js';
import { buildShotB } from './shotB.js';
import { buildShotC } from './shotC.js';

const q = new URLSearchParams(location.search);
// 镜头的底板、渡船、导航线按 1040 高的设计稿摆；后期（look.js 按 h/1080 缩放）和显示层（hud.js 按 h/1040 缩放）用实际像素
const film = createFilm({ designHeight: 1040 });
const { W, H, K, DW, DH } = film;
const hudPx = s => K === 1 ? s : { ...s, eye: s.eye && { x: s.eye.x * K, y: s.eye.y * K, r: s.eye.r * K }, nav: s.nav.map(p => ({ x: p.x * K, y: p.y * K })) };

const look = createLook(film.renderer, W, H, { ss: 2, msaa: 4, paperUrl: './assets/plates/paper.png' });

const NAMES = ['sky_dawn', 'sky_tall', 'shotB_sky', 'clouds_back', 'clouds_front_a', 'clouds_front_b', 'skyline_pudong', 'skyline_pudong_reflect', 'skyline_bund', 'river', 'mist_low'];
const [{ tex }] = await Promise.all([loadPlates(NAMES), loadHUDFonts()]);   // 纸纹不在这里：look.js 用 paperUrl 单独载入

// 显示层：按任务书色板用中性青白（#EAF6FF / #9FE8FF）；片名写得更快一点，让完整片名在画面上多停一会儿
setHUDTheme(q.get('theme') || 'neutral');
Object.assign(HUD_T, { titleA: [9.0, 9.27], titleB: [9.3, 9.6], subIn: 9.45, subFull: 9.72 });
setTitleLayout({ x: +(q.get('tx') || 0.088), y: +(q.get('ty') || 0.43) });   // 片名放在左侧中部的开阔天空里（鲲从画面上方离开）

const shotA = buildShotA({ W: DW, H: DH, K, tex, q });
const shotB = buildShotB({ W: DW, H: DH, K, img: tex.shotB_sky.image, q });
const shotC = buildShotC({ W: DW, H: DH, tex, q });

const DUR = TIMELINE.end, NOHUD = !!q.get('nohud');
// 预热：每个镜头至少一帧（改了镜头表要核对）；只为提前编译着色器、上传贴图，不影响任何一帧的画面
const WARM = q.has('warm') ? q.get('warm').split(',').filter(Boolean).map(Number) : [0.5, 2.0, 3.6, 5.3, 7.5, 9.6];
await film.run({
  dur: DUR, post: look, debug: q.get('dbg'),
  shots: [{ at: TIMELINE.A, shot: shotA }, { at: TIMELINE.B, shot: shotB }, { at: TIMELINE.C, shot: shotC }],
  draw: (ctx, t, S) => {
    if (!NOHUD) {
      if (S === shotC) drawHUD(ctx, t, W, H, hudPx(shotC.hudState));
      drawTitle(ctx, t, W, H);
    }
    if (q.get('markers') && S === shotC) {      // 标记按设计尺寸算，显示层是实际像素：先缩放 K（原生 4K 时 2）
      ctx.save(); ctx.setTransform(K, 0, 0, K, 0, 0); shotC.markers(ctx, q.get('markers') === 'log'); ctx.restore();
    }
  },
  // 该时刻画面上的文字：只依赖 t（不必先 render）。和 render 一样先把 t 夹进片长；显示层只在镜头 C 画，?nohud=1 时什么都不画
  texts: t => {
    if (NOHUD) return [];
    t = Math.min(Math.max(t, 0), DUR - 1e-6);
    return textsAt(t, W, H, t >= TIMELINE.C ? hudPx(shotC.hudAt(t)) : null);
  },
  warm: WARM,
});
