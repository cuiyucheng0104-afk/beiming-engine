// 北冥引擎 · 原生层（北冥原生 · BNE）组件库总出口。原生作品的 film.tsx 只写编排，从这里取通用件：
//   import { ShotCamera, PlateCard, ToonModel, palette, … } from '../../engine/native/index.ts';
// 路径按 films/<名字>/ 或 examples/<名字>/ 这一深度写；原生运行时能解析作品目录之外的相对 import（已实测）。
//
//   math.ts     确定性数学与随机（直接 re-export engine/core/math.js 与 clock.js）+ sinHash + ease
//   palette.ts  色板：从作品的 palette.json 读、校验、按名取色
//   camera.tsx  ShotCamera / shotAt：分段机位曲线
//   view.js     纯函数：project / cardOnScreen / edgeVisible / screenBox / overlap（世界 → 屏幕投影，Node 测试也用）、
//               skyShift（页面层天空跟镜头转）、headingYaw / behind（载具朝速度方向、尾迹在船尾后）
//   layers.tsx  Backdrop（二维底板视差）、PlateCard（三维绘画面片）、SequencePlane（序列帧图集面片）、
//               FrameSequence（逐帧 PNG 叠层）、PaperOverlay（整幅纸纹，一拍二换纸）、Vignette（整幅暗角）
//   toon.tsx    place、ToonMesh / ToonBox（带卡通材质的基本体）、ToonModel（GLB + 分材质卡通覆盖）、toonFromShade
//   title.tsx   FontFace、TitleReveal（片名逐字落定）、TitleCard（旧：只淡入）、Caption（字幕）、fadeWindow
//   post.ts     paperPass（只盖三维层的颗粒 + 暗角，整幅纸纹改用 PaperOverlay）、gradePass（engine/look/grade.js 同式调色）的 WESL 生成
//   surface.ts  waterWesl（绘画水面）、ribbonWesl（尾迹 / 拖痕）的 WESL 生成
// Node 侧工具（准备阶段，不在运行时里 import）：prepare.mjs、sequence.mjs、edge.mjs、film.mjs、delivery.mjs、runtime.mjs、cli.mjs、
// bridge/*.mjs，渲染入口 engine/render/native.mjs。

export * from './math.ts';
export * from './palette.ts';
export * from './camera.tsx';
export { project, unproject, cardRect, cardAxes, cardInView, faceYaw, cardOnScreen, edgeVisible, screenBox, overlap, skyShift, headingYaw, behind } from './view.js';
export * from './layers.tsx';
export * from './toon.tsx';
export * from './title.tsx';
export * from './post.ts';
export * from './surface.ts';
