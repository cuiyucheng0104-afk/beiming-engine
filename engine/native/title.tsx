// 北冥引擎 · 原生层 · 片名与显示层：叠在三维之上的文字层（不受三维光照和后期影响），时间驱动的淡入淡出。
//
//   <FontFace family src />       声明字体：src 是 staticFile('fonts/x.woff2')（作品 media/ 下）或 data: URL
//                                 （原实验在 Windows 中文路径下外部字体加载失败，片名用内嵌 data URL 规避）
//   fadeWindow(t, a, b, fin, fout)   [a, b) 区间内的不透明度：a 起 fin 秒淡入，b 前 fout 秒淡出；区间外为 0
//   <TitleCard text t at fade style />  t ≥ at 时出现，fade 秒线性淡入；style 给位置、字体、字号等（绝对定位）
//   <Caption text t from until fadeIn? fadeOut? bottom? style? />
//                                 字幕条：[from, until) 显示，底部居中；bottom 是距底边像素

import { clamp } from './math.ts';

export function FontFace({ family, src }: { family: string, src: string }) {
  return <style>{`@font-face{font-family:${family};src:url('${src}')}`}</style>;
}

export function fadeWindow(t: number, a: number, b: number, fin = 0.3, fout = 0.3) {
  if (t < a || t >= b) return 0;
  const i = fin > 0 ? clamp((t - a) / fin) : 1, o = fout > 0 ? clamp((b - t) / fout) : 1;
  return Math.min(i, o);
}

export function TitleCard({ text, t, at, fade = 0.5, style }: { text: string, t: number, at: number, fade?: number, style: Record<string, unknown> }) {
  if (t < at) return null;
  return <div style={{ position: 'absolute', ...style, opacity: clamp((t - at) / fade) }}>{text}</div>;
}

export function Caption({ text, t, from, until, fadeIn = 0.25, fadeOut = 0.25, bottom = 72, style }: { text: string, t: number, from: number, until: number, fadeIn?: number, fadeOut?: number, bottom?: number, style?: Record<string, unknown> }) {
  const a = fadeWindow(t, from, until, fadeIn, fadeOut);
  if (a <= 0) return null;
  return <div style={{ position: 'absolute', left: 0, right: 0, bottom, display: 'flex', justifyContent: 'center', opacity: a }}>
    <div style={{ fontSize: 44, color: '#FFFFFF', letterSpacing: 4, ...style }}>{text}</div>
  </div>;
}
