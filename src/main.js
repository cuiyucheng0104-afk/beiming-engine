// src/main.js —《北冥》10 秒概念样片 · 正片入口（合成与渲染总监）
// 三渲二 + 2.5D 合成，六层配方：
//   ① 3D 简单几何体（鲲、渡船）+ 实例化海草 / 藤壶 / 珊瑚 / 海葵   —— kun.js / ferry.js
//   ② 卡通着色（三档色阶、背光边缘光、锈斑噪点、抖动墨线）         —— toon.js + look.js（屏幕空间墨线）
//   ③ 2D 手绘底板作 3D 场景里的面片 / 穹顶分层，镜头运动产生真实视差 —— engine/stage + shotA/B/C
//   ④ 角色一拍二、鲲一拍三；镜头、底板、雾、水 24 fps 平滑          —— 各镜头 update(t, f) 里用 engine/core/clock.js 量化
//   ⑤ 后期：雾（3D 物体自带）→ bloom → 暖色调色 → Kuwahara 颜料笔触 → 墨线 → 纸纹 → 暗角 → 颗粒 —— look.js
//   ⑥ 逐帧离线渲染（engine/render），ffmpeg 编码，base64 单文件 HTML —— build.sh
// 渲染器、显示层画布、设计尺寸缩放、切镜头和页面约定由 engine/stage/film.js 负责；这里只有本片的底板名单、显示层配置和镜头表。
import { createFilm } from '../engine/stage/film.js';
import { createLook } from './look.js';
import { loadHUDFonts, drawHUD, drawTitle, textsAt, setHUDTheme, setTitleLayout, HUD_T } from './hud.js';
import { loadPlates } from './scene.js';
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
const [{ tex }] = await Promise.all([loadPlates(NAMES), loadHUDFonts()]);

// 显示层：按任务书色板用中性青白（#EAF6FF / #9FE8FF）；片名写得更快一点，让完整片名在画面上多停一会儿
setHUDTheme(q.get('theme') || 'neutral');
Object.assign(HUD_T, { titleA: [9.0, 9.27], titleB: [9.3, 9.6], subIn: 9.45, subFull: 9.72 });
setTitleLayout({ x: +(q.get('tx') || 0.088), y: +(q.get('ty') || 0.43) });   // 片名放在左侧中部的开阔天空里（鲲从画面上方离开）

const shotA = buildShotA({ W: DW, H: DH, tex, q });
const shotB = buildShotB({ W: DW, H: DH, K, img: tex.shotB_sky.image, q });
const shotC = buildShotC({ W: DW, H: DH, tex, q });

await film.run({
  dur: 10, post: look, debug: q.get('dbg'),
  shots: [{ at: 0, shot: shotA }, { at: 3, shot: shotB }, { at: 5, shot: shotC }],
  draw: (ctx, t, S) => {
    if (!q.get('nohud')) {
      if (S === shotC) drawHUD(ctx, t, W, H, hudPx(shotC.hudState));
      drawTitle(ctx, t, W, H);
    }
    if (q.get('markers') && S === shotC) shotC.markers(ctx, q.get('markers') === 'log');
  },
  texts: t => textsAt(t, W, H),
  warm: [0.5, 2.0, 3.6, 5.3, 7.5, 9.6],
});
