// 北冥 QA · 联系表：从成片里取帧拼一张 JPEG，供代理审片与报告引用（不替代全片观看）。
// 选帧：全片均匀约 24 张 + 镜头表每个切点的前后帧 + 有发现的帧（红框、标 !）+ 要求有声的事件帧；最多 48 格，按帧号排列。
// 每格标签：帧号、时间码、镜头号；CUT = 镜头表切点。标签用内置 5×7 点阵字（只有 ASCII），不依赖 FFmpeg 的 drawtext 与系统字体。
//
//   contactSheet({ input, probe, film, report, framesOfInterest, timeoutMs }) → { jpeg: Buffer, cells: [{ frame, shot, cut, flagged }], width, height }
import { grabRgb } from './frames.mjs';
import { run, tool, tail } from './proc.mjs';
import { rate } from './probe.mjs';

const G = {
  '0': [' ### ', '#   #', '#  ##', '# # #', '##  #', '#   #', ' ### '], '1': ['  #  ', ' ##  ', '  #  ', '  #  ', '  #  ', '  #  ', ' ### '],
  '2': [' ### ', '#   #', '    #', '   # ', '  #  ', ' #   ', '#####'], '3': ['#####', '   # ', '  #  ', '   # ', '    #', '#   #', ' ### '],
  '4': ['   # ', '  ## ', ' # # ', '#  # ', '#####', '   # ', '   # '], '5': ['#####', '#    ', '#### ', '    #', '    #', '#   #', ' ### '],
  '6': ['  ## ', ' #   ', '#    ', '#### ', '#   #', '#   #', ' ### '], '7': ['#####', '    #', '   # ', '  #  ', ' #   ', ' #   ', ' #   '],
  '8': [' ### ', '#   #', '#   #', ' ### ', '#   #', '#   #', ' ### '], '9': [' ### ', '#   #', '#   #', ' ####', '    #', '   # ', ' ##  '],
  A: [' ### ', '#   #', '#   #', '#####', '#   #', '#   #', '#   #'], B: ['#### ', '#   #', '#   #', '#### ', '#   #', '#   #', '#### '],
  C: [' ### ', '#   #', '#    ', '#    ', '#    ', '#   #', ' ### '], D: ['###  ', '#  # ', '#   #', '#   #', '#   #', '#  # ', '###  '],
  E: ['#####', '#    ', '#    ', '#### ', '#    ', '#    ', '#####'], F: ['#####', '#    ', '#    ', '#### ', '#    ', '#    ', '#    '],
  G: [' ### ', '#   #', '#    ', '# ###', '#   #', '#   #', ' ####'], H: ['#   #', '#   #', '#   #', '#####', '#   #', '#   #', '#   #'],
  I: [' ### ', '  #  ', '  #  ', '  #  ', '  #  ', '  #  ', ' ### '], J: ['  ###', '   # ', '   # ', '   # ', '   # ', '#  # ', ' ##  '],
  K: ['#   #', '#  # ', '# #  ', '##   ', '# #  ', '#  # ', '#   #'], L: ['#    ', '#    ', '#    ', '#    ', '#    ', '#    ', '#####'],
  M: ['#   #', '## ##', '# # #', '# # #', '#   #', '#   #', '#   #'], N: ['#   #', '#   #', '##  #', '# # #', '#  ##', '#   #', '#   #'],
  O: [' ### ', '#   #', '#   #', '#   #', '#   #', '#   #', ' ### '], P: ['#### ', '#   #', '#   #', '#### ', '#    ', '#    ', '#    '],
  Q: [' ### ', '#   #', '#   #', '#   #', '# # #', '#  # ', ' ## #'], R: ['#### ', '#   #', '#   #', '#### ', '# #  ', '#  # ', '#   #'],
  S: [' ####', '#    ', '#    ', ' ### ', '    #', '    #', '#### '], T: ['#####', '  #  ', '  #  ', '  #  ', '  #  ', '  #  ', '  #  '],
  U: ['#   #', '#   #', '#   #', '#   #', '#   #', '#   #', ' ### '], V: ['#   #', '#   #', '#   #', '#   #', '#   #', ' # # ', '  #  '],
  W: ['#   #', '#   #', '#   #', '# # #', '# # #', '# # #', ' # # '], X: ['#   #', '#   #', ' # # ', '  #  ', ' # # ', '#   #', '#   #'],
  Y: ['#   #', '#   #', ' # # ', '  #  ', '  #  ', '  #  ', '  #  '], Z: ['#####', '    #', '   # ', '  #  ', ' #   ', '#    ', '#####'],
  ':': ['     ', '  #  ', '  #  ', '     ', '  #  ', '  #  ', '     '], '.': ['     ', '     ', '     ', '     ', '     ', ' ##  ', ' ##  '],
  '-': ['     ', '     ', '     ', '#####', '     ', '     ', '     '], '+': ['     ', '  #  ', '  #  ', '#####', '  #  ', '  #  ', '     '],
  '/': ['    #', '    #', '   # ', '  #  ', ' #   ', '#    ', '#    '], '#': [' # # ', ' # # ', '#####', ' # # ', '#####', ' # # ', ' # # '],
  '!': ['  #  ', '  #  ', '  #  ', '  #  ', '  #  ', '     ', '  #  '], '(': ['   # ', '  #  ', ' #   ', ' #   ', ' #   ', '  #  ', '   # '],
  ')': [' #   ', '  #  ', '   # ', '   # ', '   # ', '  #  ', ' #   '], '_': ['     ', '     ', '     ', '     ', '     ', '     ', '#####'],
  '=': ['     ', '     ', '#####', '     ', '#####', '     ', '     '], '%': ['##   ', '##  #', '   # ', '  #  ', ' #   ', '#  ##', '   ##'],
  '?': [' ### ', '#   #', '    #', '   # ', '  #  ', '     ', '  #  '], '@': [' ### ', '#   #', '# ###', '# # #', '# ###', '#    ', ' ####'], '|': ['  #  ', '  #  ', '  #  ', '  #  ', '  #  ', '  #  ', '  #  '],
};

function drawText(img, W, x, y, str, rgb, s = 2) {
  let cx = x;
  for (const ch0 of String(str)) {
    const ch = /[a-z]/.test(ch0) ? ch0.toUpperCase() : ch0;
    const g = ch === ' ' ? null : G[ch] || G['?'];
    if (g) {
      for (let gy = 0; gy < 7; gy++) for (let gx = 0; gx < 5; gx++) {
        if (g[gy][gx] !== '#') continue;
        for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) {
          const px = cx + gx * s + dx, py = y + gy * s + dy;
          if (px < 0 || px >= W || py < 0) continue;
          const i = (py * W + px) * 3;
          if (i + 2 < img.length) { img[i] = rgb[0]; img[i + 1] = rgb[1]; img[i + 2] = rgb[2]; }
        }
      }
    }
    cx += 6 * s;
  }
}
function fill(img, W, x, y, w, h, rgb) {
  for (let yy = Math.max(0, y); yy < y + h; yy++) for (let xx = Math.max(0, x); xx < Math.min(W, x + w); xx++) {
    const i = (yy * W + xx) * 3;
    if (i + 2 < img.length) { img[i] = rgb[0]; img[i + 1] = rgb[1]; img[i + 2] = rgb[2]; }
  }
}
const tc = (f, fps) => { const s = f / fps; const m = Math.floor(s / 60); return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(2).padStart(5, '0')}`; };

export async function contactSheet({ input, probe, film = null, report = null, framesOfInterest = [], timeoutMs }) {
  const v = probe.video;
  const fps = (rate(v.avg_frame_rate) || rate(v.r_frame_rate) || { value: 24 }).value;
  const n = report?.facts?.frames || Number(v.nb_frames) || Math.round((Number(v.duration) || 0) * fps);
  if (!n) throw new Error('帧数未知，没法选帧');
  const pick = new Set();
  const k = Math.max(1, Math.ceil(n / 24));
  for (let f = 0; f < n; f += k) pick.add(f);
  pick.add(n - 1);
  const cuts = new Set((film?.cuts || []).map(c => c.frame).filter(f => f > 0 && f < n));
  for (const c of cuts) { pick.add(c - 1); pick.add(c); }
  const flagged = new Set(framesOfInterest.filter(f => f >= 0 && f < n).slice(0, 12));
  for (const f of flagged) pick.add(f);
  for (const e of (film?.events || []).filter(x => x.needsSound && Number.isInteger(x.frame)).slice(0, 12)) if (e.frame < n) pick.add(e.frame);
  let frames = [...pick].sort((a, b) => a - b);
  if (frames.length > 48) {
    const must = frames.filter(f => cuts.has(f) || cuts.has(f + 1) || flagged.has(f));
    const rest = frames.filter(f => !must.includes(f));
    const keep = Math.max(0, 48 - must.length);
    frames = [...must, ...rest.filter((_, i) => i % Math.ceil(rest.length / Math.max(1, keep)) === 0)].slice(0, 48).sort((a, b) => a - b);
  }
  const portrait = v.height > v.width;
  const tw = portrait ? Math.round(240 * v.width / v.height / 2) * 2 : 320, th = portrait ? 240 : Math.round(320 * v.height / v.width / 2) * 2;
  const thumbs = await grabRgb(input, frames, { w: tw, h: th, timeoutMs });
  const cols = portrait ? 8 : 6, gap = 6, label = 36, head = 34;
  const rows = Math.ceil(frames.length / cols);
  const W = cols * (tw + gap) + gap, H = head + rows * (th + label + gap) + gap;
  const img = Buffer.alloc(W * H * 3, 24);
  const shotOf = f => (film?.shots || []).find(s => f >= s.in && f < s.out)?.id || '';
  const ok = report ? report.ok : null;
  drawText(img, W, gap + 2, 9, `QA ${film?.id || ''} ${report?.profile?.id || ''} ${ok === null ? '' : ok ? 'PASS' : 'FAIL'}  ${n}F @ ${Math.round(fps * 100) / 100}FPS`.replace(/\s+/g, ' '), ok === false ? [255, 110, 100] : [220, 230, 220], 2);
  const cells = [];
  frames.forEach((f, idx) => {
    const cx = gap + (idx % cols) * (tw + gap), cy = head + Math.floor(idx / cols) * (th + label + gap);
    const isCut = cuts.has(f), isFlag = flagged.has(f);
    if (isFlag) fill(img, W, cx - 3, cy - 3, tw + 6, th + label + 6, [210, 50, 40]);
    fill(img, W, cx, cy, tw, th + label, [40, 40, 40]);
    const t = thumbs.get(f);
    if (t) for (let y = 0; y < th; y++) img.set(t.subarray(y * tw * 3, (y + 1) * tw * 3), ((cy + y) * W + cx) * 3);
    drawText(img, W, cx + 4, cy + th + 4, `F${f} ${tc(f, fps)}`, [235, 235, 235], 2);
    const sh = shotOf(f);
    drawText(img, W, cx + 4, cy + th + 20, `${sh ? sh + ' ' : ''}${isCut ? 'CUT ' : ''}${isFlag ? '!' : ''}`.trim() || ' ', isCut ? [255, 214, 90] : [200, 200, 200], 2);
    cells.push({ frame: f, shot: sh || null, cut: isCut, flagged: isFlag });
  });
  const r = await run(tool('ffmpeg'), ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-i', 'pipe:0', '-frames:v', '1', '-q:v', '3', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'], { timeoutMs, stdin: img });
  if (r.code !== 0 || !r.stdout.length) throw new Error(`编码联系表失败：${tail(r.stderr)}`);
  return { jpeg: r.stdout, cells, width: W, height: H };
}
