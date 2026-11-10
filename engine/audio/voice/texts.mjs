// 北冥引擎 · 配音 · 字幕排版：把 engine/audio/voice 导出的 texts.json 排成每一时刻屏幕上的字幕行，同时给页面的 window.TEXTS(t)。
// 浏览器与 Node 都能 import，不碰画布、不读时钟；画字交给页面自己的文字层（例如 engine/overlay/text.js），位置用这里算的数，
// 这样 QA 的文字检查（tools/qa texts：安全区、停留时长、对比度、缺字）看到的方框就是真画出来的位置。
//
//   const layout = subtitleLayout(texts, { width, height, font, sizeRatio = 0.045, bottomRatio = 0.05, lineGap = 1.25, fadeFrames = 0 })
//   layout(t) → [{ text, x, y, box: [x, y, w, h], alpha, font, fontPx, cue }]
//       x 是行的水平中心、y 是基线；box 是这一行的外框（估算：汉字与全角标点 1 em，拉丁字母、数字 0.55 em，空格 0.3 em）
//       字高默认画高的 4.5%（VISUAL-DESIGN.md §6.3：1080 高下 4%–5%），最后一行的底边离画面底边 5%（底部安全区）
//   textsFrom(layout) → (t) => [{ text, box, alpha, font }]      直接挂成 window.TEXTS（附录 C5）
//   cueAt(texts, t) → 正在显示的字幕条（或 null）；起止按帧：startFrame ≤ round(t·fps) < endFrame
//
// 用法（页面）：
//   import texts from './out/dialogue/texts.json' with { type: 'json' };     // 或 fetch 后传进来
//   const layout = subtitleLayout(texts, { width: 1920, height: 1080, font: '"Noto Sans SC"' });
//   window.TEXTS = textsFrom(layout);
//   // render(t) 里：for (const l of layout(t)) drawText(ctx, l.text, l.x, l.y, { size: l.fontPx, alpha: l.alpha, align: 'center' });

const isWide = ch => /[⺀-鿿豈-﫿＀-￯　-〿‘-”…—]/.test(ch) || ch.codePointAt(0) > 0xFFFF;
export function emWidth(s) {
  let w = 0;
  for (const ch of s) w += ch === ' ' ? 0.3 : isWide(ch) ? 1 : 0.55;
  return w;
}

export function cueAt(texts, t) {
  const f = Math.round(t * texts.fps);
  for (const c of texts.cues) if (c.startFrame <= f && f < c.endFrame) return c;
  return null;
}

export function subtitleLayout(texts, { width, height, font = '"Noto Sans SC", sans-serif', sizeRatio = 0.045, bottomRatio = 0.05, lineGap = 1.25, fadeFrames = 0 } = {}) {
  if (!texts || !Array.isArray(texts.cues) || !texts.fps) throw new Error('subtitleLayout：要 engine/audio/voice 导出的 texts.json（{fps, cues}）');
  const W = width ?? texts.size?.[0] ?? 1920, H = height ?? texts.size?.[1] ?? 1080;
  const fontPx = Math.round(H * sizeRatio);
  const bottom = H * (1 - bottomRatio);
  return t => {
    const c = cueAt(texts, t);
    if (!c) return [];
    const f = t * texts.fps;
    let alpha = 1;
    if (fadeFrames > 0) alpha = Math.max(0, Math.min(1, (f - c.startFrame + 1) / fadeFrames, (c.endFrame - f) / fadeFrames));
    const n = c.lines.length;
    return c.lines.map((text, i) => {
      const y = bottom - (n - 1 - i) * fontPx * lineGap - fontPx * 0.18;     // 基线（下伸部约 0.18 em）
      const w = emWidth(text) * fontPx;
      const top = y - fontPx * 0.88;
      return { text, x: W / 2, y, box: [W / 2 - w / 2, top, w, fontPx * 1.06], alpha, font: `${fontPx}px ${font}`, fontPx, cue: c.id };
    });
  };
}

export const textsFrom = layout => t => layout(t).map(({ text, box, alpha, font }) => ({ text, box, alpha, font }));
