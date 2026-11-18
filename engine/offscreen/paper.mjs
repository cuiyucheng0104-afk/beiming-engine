// 北冥引擎 · 离屏出片 · 图片纸纹加载（Node）：把纸纹 PNG 解码成 tsl/look.js 要的 { tex, mid }。
//   loadPaper(THREE, file) → { tex, mid, width, height }
//     tex  THREE.DataTexture（RGBA8，行序自上而下 = 图片行序，RepeatWrapping、线性过滤、不建 mip）
//     mid  中性亮度：Rec.709 亮度的整幅均值（GLSL 版 engine/look/paper.js 在 64×64 缩略图上算同一个量）
//   读不了（文件不存在、不是 PNG、隔行或位深 1/2/4）抛 Error，message 带上文件路径；不换成程序化纸纹（换了画面质感就变了）。
// shortcut: 不建 mip，纸纹缩小（scale × kp < 1）时会比 GLSL 版闪，要用缩小平铺时再加 mip。
import { readFileSync } from 'node:fs';
import { decodePng } from '../../tools/plates/png.mjs';

export function loadPaper(THREE, file) {
  let png;
  try { png = decodePng(readFileSync(file)); }
  catch (e) { throw Object.assign(new Error(`纸纹图读不了：${file}（${e.message}）`), { code: 'contract.paper' }); }
  const { width, height, data } = png;
  let s = 0;
  for (let i = 0; i < data.length; i += 4) s += (data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722) / 255;
  const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return { tex, mid: s / (width * height), width, height };
}
