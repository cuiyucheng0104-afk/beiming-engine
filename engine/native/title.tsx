// 北冥引擎 · 原生层 · 片名与显示层：叠在三维之上的文字层（不受三维光照和后期影响），全部是时间的纯函数。
//
//   <FontFace family src />       声明字体：src 是 staticFile('fonts/x.woff2')（作品 media/ 下）或 data: URL
//                                 （原实验在 Windows 中文路径下外部字体加载失败，片名用内嵌 data URL 规避）
//   fadeWindow(t, a, b, fin, fout)   [a, b) 区间内的不透明度：a 起 fin 秒淡入，b 前 fout 秒淡出；区间外为 0
//   <TitleReveal text t at style stagger? settle? rise? spread? until? fadeOut? rule? />
//                                 片名「逐字落定」：每个字晚 stagger 秒起动，在 settle 秒里从下方 rise（em）处、略放大、字距略松
//                                 的状态缓出落到位，墨晕（文字阴影）随之收紧；全部落定后可选一道细线从左向右写出（rule）。
//                                 until / fadeOut 给出退场。适合任何文字；要书法笔顺，用 A 路页面经 sequences 渲成逐帧 PNG
//                                 再用 layers.tsx 的 <FrameSequence>（examples/raea 的做法）。
//                                 版式自己保证：落在安全区内（左右各 ≥ 5% 画宽、上下 ≥ 120/1080 画高），与主体不重叠，
//                                 与背后像素的明度对比 ≥ 3:1（raea check 会查；模版用 view.js 投影在 Node 里先核对）
//   <TitleCard text t at fade style />  旧接口：t ≥ at 时线性淡入（只做淡入，不再推荐给片名用）
//   <Caption text t from until fadeIn? fadeOut? bottom? scale? style? />
//                                 字幕条：[from, until) 显示，底部居中；默认离底边 150·scale 像素（让开平台界面区）、
//                                 44·scale 号字、带一层柔和阴影保证对比

import { clamp, eo } from './math.ts';

export function FontFace({ family, src }: { family: string, src: string }) {
  return <style>{`@font-face{font-family:${family};src:url('${src}')}`}</style>;
}

export function fadeWindow(t: number, a: number, b: number, fin = 0.3, fout = 0.3) {
  if (t < a || t >= b) return 0;
  const i = fin > 0 ? clamp((t - a) / fin) : 1, o = fout > 0 ? clamp((b - t) / fout) : 1;
  return Math.min(i, o);
}

interface Rule { width: number, thickness?: number, color?: string, delay?: number, duration?: number, gap?: number }

export function TitleReveal({ text, t, at, style, stagger = 0.14, settle = 0.9, rise = 0.22, spread = 0.18, until = Infinity, fadeOut = 0.4, glow = 'rgba(28,24,64,0.55)', rule }: {
  text: string, t: number, at: number, style: Record<string, unknown>, stagger?: number, settle?: number, rise?: number, spread?: number,
  until?: number, fadeOut?: number, glow?: string, rule?: Rule,
}) {
  if (t < at || t >= until) return null;
  const chars = [...text], size = Number(style.fontSize ?? 64), ls = Number(style.letterSpacing ?? 0);
  const out = Number.isFinite(until) && fadeOut > 0 ? clamp((until - t) / fadeOut) : 1;
  const last = eo(clamp((t - at - (chars.length - 1) * stagger) / settle));
  const ruleDone = at + (chars.length - 1) * stagger + settle;
  return <div style={{ position: 'absolute', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', opacity: out, ...style, letterSpacing: 0 }}>
    <div style={{ display: 'flex', flexDirection: 'row' }}>
      {chars.map((ch, i) => {
        const e = eo(clamp((t - at - i * stagger) / settle));
        const blur = (1 - e) * 0.35 * size;
        return <span key={i} style={{
          opacity: Math.pow(e, 0.8), marginRight: i < chars.length - 1 ? ls + (1 - last) * spread * size : 0,
          transform: `translateY(${((1 - e) * rise * size).toFixed(2)}px) scale(${(1 + (1 - e) * 0.06).toFixed(4)})`,
          textShadow: `0 ${(0.04 * size).toFixed(1)}px ${(0.12 * size + blur).toFixed(1)}px ${glow}`,
        }}>{ch}</span>;
      })}
    </div>
    {rule && <div style={{ marginTop: rule.gap ?? 0.18 * size, height: rule.thickness ?? Math.max(2, Math.round(size * 0.035)), backgroundColor: rule.color ?? (style.color as string) ?? '#FFFFFF',
      width: rule.width * eo(clamp((t - ruleDone - (rule.delay ?? 0.1)) / (rule.duration ?? 0.7))) }} />}
  </div>;
}

export function TitleCard({ text, t, at, fade = 0.5, style }: { text: string, t: number, at: number, fade?: number, style: Record<string, unknown> }) {
  if (t < at) return null;
  return <div style={{ position: 'absolute', ...style, opacity: clamp((t - at) / fade) }}>{text}</div>;
}

export function Caption({ text, t, from, until, fadeIn = 0.25, fadeOut = 0.25, bottom, scale = 1, style }: { text: string, t: number, from: number, until: number, fadeIn?: number, fadeOut?: number, bottom?: number, scale?: number, style?: Record<string, unknown> }) {
  const a = fadeWindow(t, from, until, fadeIn, fadeOut);
  if (a <= 0) return null;
  return <div style={{ position: 'absolute', left: 0, right: 0, bottom: bottom ?? 150 * scale, display: 'flex', justifyContent: 'center', opacity: a }}>
    <div style={{ fontSize: 44 * scale, color: '#FFFFFF', letterSpacing: 4 * scale, textShadow: `0 ${2 * scale}px ${10 * scale}px rgba(20,16,48,0.75)`, ...style }}>{text}</div>
  </div>;
}
