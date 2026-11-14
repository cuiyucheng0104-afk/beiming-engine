// src/main.js —《北冥》30 秒概念样片 · 正片入口（合成与渲染总监，亦支持 ?dur=10 十秒预览）
// 三渲二 + 2.5D 合成，六层配方：
//   ① 3D 简单几何体（鲲、鲲鹏、渡船）+ 实例化海草 / 藤壶 / 珊瑚 / 海葵 —— kun.js / kun_peng.js / ferry.js
//   ② 卡通着色（三档色阶、背光边缘光、锈斑噪点、抖动墨线）         —— toon.js / toon_peng.js + look.js
//   ③ 2D 手绘底板作 3D 场景里的面片 / 穹顶分层，镜头运动产生真实视差 —— engine/stage + shotA–G
//   ④ 角色一拍二、鲲从一拍三到一拍二再到化鹏一拍一；镜头/底板/水 24 fps 平滑 —— engine/core/clock.js
//   ⑤ 后期：雾 → bloom → 暖色调色 → Kuwahara 颜料笔触 → 墨线 → 纸纹 → 暗角 → 颗粒 —— look.js
//   ⑥ 逐帧离线渲染（engine/render），ffmpeg 编码，base64 单文件 HTML —— build.sh
// 渲染器、显示层画布、设计尺寸缩放、切镜头和页面约定由 engine/stage/film.js 负责；这里只有本片的底板名单、显示层配置和镜头表。
import { createFilm } from '../engine/stage/film.js';
import { createLook } from './look.js';
import { loadHUDFonts, drawHUD, drawTitle, textsAt, setHUDTheme, setTitleLayout, HUD_T } from './hud.js';
import { loadPlates } from '../engine/stage/plates.js';
import { buildShotA } from './shotA.js';
import { buildShotB } from './shotB.js';
import { buildShotC } from './shotC.js';
import { buildShotD } from './shotD.js';
import { buildShotE } from './shotE.js';
import { buildShotF } from './shotF.js';
import { buildShotG } from './shotG.js';

const q = new URLSearchParams(location.search);
const dur = +(q.get('dur') || 30);
// 镜头的底板、渡船、导航线按 1040 高的设计稿摆；后期（look.js 按 h/1080 缩放）和显示层（hud.js 按 h/1040 缩放）用实际像素
const film = createFilm({ designHeight: 1040 });
const { W, H, K, DW, DH } = film;
const hudPx = s => !s || K === 1 ? s : {
  ...s,
  eye: s.eye && { x: s.eye.x * K, y: s.eye.y * K, r: s.eye.r * K },
  nav: (s.nav || []).map(p => ({ x: p.x * K, y: p.y * K })),
  ...(s.navCardAt ? { navCardAt: { x: s.navCardAt.x * K, y: s.navCardAt.y * K } } : {}),
};

const look = createLook(film.renderer, W, H, { ss: 2, msaa: 4, paperUrl: './assets/plates/paper.png' });

const NAMES = ['sky_dawn', 'sky_zenith', 'sky_tall', 'shotB_sky', 'clouds_back', 'clouds_front_a', 'clouds_front_b', 'skyline_pudong', 'skyline_pudong_reflect', 'skyline_bund', 'river', 'mist_low'];
const [{ tex }] = await Promise.all([loadPlates(NAMES, { linear: ['paper'] }), loadHUDFonts()]);

// 显示层：按任务书色板用中性青白（#EAF6FF / #9FE8FF）
setHUDTheme(q.get('theme') || 'neutral');
setTitleLayout({ x: +(q.get('tx') || 0.088), y: +(q.get('ty') || 0.43) });   // 片名放在左侧中部的开阔天空里

const shotA = buildShotA({ W: DW, H: DH, tex, q });
const shotB = buildShotB({ W: DW, H: DH, K, img: tex.shotB_sky.image, q });
const shotC = buildShotC({ W: DW, H: DH, tex, q });

let shots, warm;
if (dur === 10) {
  Object.assign(HUD_T, { titleA: [9.0, 9.27], titleB: [9.3, 9.6], subIn: 9.45, subFull: 9.72 });
  shots = [{ at: 0, shot: shotA }, { at: 3, shot: shotB }, { at: 5, shot: shotC }];
  warm = [0.5, 2.0, 3.6, 5.3, 7.5, 9.6];
} else {
  Object.assign(HUD_T, { titleA: [27.4, 27.85], titleB: [27.9, 28.45], subIn: 28.2, subFull: 28.85 });
  const shotD = buildShotD({ W: DW, H: DH, tex, q });
  const shotE = buildShotE({ W: DW, H: DH, K, tex, img: tex.shotB_sky.image, q });
  const shotF = buildShotF({ W: DW, H: DH, tex, q });
  const shotG = buildShotG({ W: DW, H: DH, tex, q });
  shots = [
    { at: 0, shot: shotA },
    { at: 3, shot: shotB },
    { at: 5, shot: shotC },
    { at: 10, shot: shotD },
    { at: 15, shot: shotE },
    { at: 19, shot: shotF },
    { at: 24.5, shot: shotG },
  ];
  warm = [0.5, 3.6, 7.5, 12.0, 15.8, 17.5, 21.5, 26.5, 28.8];
}

await film.run({
  dur, post: look, debug: q.get('dbg'),
  shots,
  draw: (ctx, t, S) => {
    if (!q.get('nohud')) {
      if (S.hudState) drawHUD(ctx, t, W, H, hudPx(S.hudState));
      drawTitle(ctx, t, W, H);
    }
    if (q.get('markers') && S.markers) S.markers(ctx, q.get('markers') === 'log');
  },
  texts: t => textsAt(t, W, H),
  warm,
});
