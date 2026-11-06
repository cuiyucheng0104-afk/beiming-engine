/* ===== pixel.js · indexed-colour pixel-art kit (from styles/13-pixel) =====
   PX.init(stage, {pw:304, ph:171}) -> kit with an indexed buffer (palette ramps dark->light), Bayer dither,
   put/rect/line/circ, a 5x7 latin font, CJK glyphs rasterised from the system font at 12/16 px, sprites from
   string maps, auto-outline and flush() that scales the buffer x4 without smoothing. */
(function () {
  const RAMPS = [
    ['#07061a', '#0e0d2c', '#171745', '#22245e', '#2f3478', '#414a92'],            // 0 night
    ['#1d1430', '#33204a', '#4f2b62', '#74397a', '#a2508a', '#cf7397'],            // 1 dusk purple
    ['#4a1f2e', '#86353a', '#c4583f', '#ee8a4f', '#ffbd6b', '#ffe3a3'],            // 2 ember
    ['#08201c', '#0f3328', '#174c34', '#22693d', '#3a8f45', '#68b64b', '#a6dc62'], // 3 leaf
    ['#08222e', '#0f3b4c', '#17596a', '#24838e', '#3bb0ad', '#78dbc9', '#c8f6e8'], // 4 water / glass
    ['#1a0f0c', '#2e1a13', '#48291b', '#6a3f26', '#925d36', '#bf8a52'],            // 5 wood
    ['#14131f', '#24253a', '#393b54', '#575b73', '#80859b', '#b4b8c8'],            // 6 stone
    ['#2c0b18', '#5a1426', '#8f1f33', '#c9353e', '#ee5f53', '#ff9a83'],            // 7 red
    ['#6e4434', '#a8705a', '#d9a283', '#f6d2b2'],                                  // 8 skin
    ['#3a2a06', '#7d5c0d', '#c39318', '#f2c94c', '#fff09a', '#fffbe0'],            // 9 gold
    ['#ffffff'],                                                                    // 10 white
    ['#3b2318', '#5c3a26', '#86593a', '#b08458', '#d6b07f', '#f0d8b0'],            // 11 milk tea
    ['#3a1030', '#6a1d54', '#a3317a', '#d65aa0', '#f28fc0', '#ffc6e0'],            // 12 pink
    ['#0d1b3a', '#16306a', '#2251a8', '#3a7be0', '#6aa8ff', '#b4d6ff'],            // 13 blue
    ['#2a2a2a', '#4a4a4a', '#6e6e6e', '#9a9a9a', '#c6c6c6', '#ecebe6'],            // 14 grey / paper
  ];
  const FONT = {
    A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'], B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'], C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
    D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'], E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'], F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
    G: ['01111', '10000', '10000', '10111', '10001', '10001', '01111'], H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'], I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
    J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'], K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'], L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
    M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'], N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'], O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
    P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'], Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'], R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
    S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'], T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'], U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
    V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'], W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'], X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
    Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'], Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
    0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'], 1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'], 2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
    3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'], 4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'], 5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
    6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'], 7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'], 8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
    9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'], '!': ['00100', '00100', '00100', '00100', '00100', '00000', '00100'], ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
    x: ['00000', '00000', '10001', '01010', '00100', '01010', '10001'], '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'], '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
    ':': ['00000', '00100', '00100', '00000', '00100', '00100', '00000'], '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'], '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
    '>': ['01000', '00100', '00010', '00001', '00010', '00100', '01000'], '<': ['00010', '00100', '01000', '10000', '01000', '00100', '00010'], '?': ['01110', '10001', '00001', '00110', '00100', '00000', '00100'],
    '%': ['11001', '11010', '00010', '00100', '01000', '01011', '10011'], '¥': ['10001', '01010', '11111', '00100', '11111', '00100', '00100'], '*': ['00000', '10101', '01110', '11111', '01110', '10101', '00000'],
  };
  const B4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  function init(stage, O = {}) {
    const { lerp } = Reel;
    const RS = Reel.RS, W = Math.round(1920 * RS), H = Math.round(1080 * RS);
    const PW = O.pw || 304, PH = O.ph || 171;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H; cv.style.cssText = 'position:absolute;left:0;top:0;width:1920px;height:1080px;image-rendering:pixelated'; stage.appendChild(cv);
    const ctx = cv.getContext('2d');
    const small = document.createElement('canvas'); small.width = PW; small.height = PH; const sctx = small.getContext('2d'); const img = sctx.createImageData(PW, PH);
    const PAL = new Uint32Array(RAMPS.length * 8);
    RAMPS.forEach((rp, r) => rp.forEach((h, l) => { const v = parseInt(h.slice(1), 16); PAL[r * 8 + l] = 0xff000000 | ((v & 255) << 16) | (v & 0xff00) | (v >> 16); }));
    const RL = RAMPS.map((r) => r.length);
    const P = (r, l) => r * 8 + Math.max(0, Math.min(RL[r] - 1, l | 0));
    const buf = new Uint8Array(PW * PH), dep = new Uint8Array(PW * PH);
    const bay = (x, y) => (B4[(y & 3) * 4 + (x & 3)] + 0.5) / 16;
    const h1 = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
    const n1 = (x) => { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return lerp(h1(i), h1(i + 1), u); };
    function put(x, y, c, d = 5) { x |= 0; y |= 0; if (x < 0 || y < 0 || x >= PW || y >= PH) return; const i = y * PW + x; buf[i] = c; dep[i] = d; }
    function get(x, y) { x |= 0; y |= 0; if (x < 0 || y < 0 || x >= PW || y >= PH) return 0; return buf[y * PW + x]; }
    function bump(x, y, k, minD = 0) { x |= 0; y |= 0; if (x < 0 || y < 0 || x >= PW || y >= PH) return; const i = y * PW + x; if (dep[i] < minD) return; const c = buf[i], r = c >> 3; buf[i] = P(r, (c & 7) + k); }
    function rect(x, y, w, h, c, d) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(x + i, y + j, c, d); }
    function frame(x, y, w, h, c, d) { for (let i = 0; i < w; i++) { put(x + i, y, c, d); put(x + i, y + h - 1, c, d); } for (let j = 0; j < h; j++) { put(x, y + j, c, d); put(x + w - 1, y + j, c, d); } }
    function line(x0, y0, x1, y1, c, d) { const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1); for (let k = 0; k <= n; k++) put(Math.round(lerp(x0, x1, k / n)), Math.round(lerp(y0, y1, k / n)), c, d); }
    function circ(cx, cy, r, c, d, fill = true) { for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) { const q = Math.hypot(x, y); if (fill ? q <= r + 0.3 : Math.abs(q - r) < 0.6) put(cx + x, cy + y, c, d); } }
    // dithered vertical gradient between two palette entries
    function grad(x, y, w, h, c0, c1, d) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(x + i, y + j, bay(x + i, y + j) < j / h ? c1 : c0, d); }
    // 5x7 latin text (upper-case + digits); outline optional
    function text(s, x, y, col, sc = 1, outline = P(0, 0), d = 9) {
      const chars = [...String(s).toUpperCase()];
      const draw = (ox, oy, c) => chars.forEach((ch, k) => { const g = FONT[ch] || FONT[' ']; for (let j = 0; j < 7; j++) for (let i = 0; i < 5; i++) if (g[j][i] === '1') for (let a = 0; a < sc; a++) for (let b = 0; b < sc; b++) put(x + ox + (k * 6 + i) * sc + a, y + oy + j * sc + b, c, d); });
      if (outline !== null) for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [1, 1]]) draw(dx, dy, outline);
      draw(0, 0, col);
      return chars.length * 6 * sc;
    }
    const tw = (s, sc = 1) => [...String(s)].length * 6 * sc;
    // CJK glyphs rasterised from the system font (12 px cell by default), cached
    const GC = {}; const gcv = document.createElement('canvas'); gcv.width = 64; gcv.height = 64; const gx = gcv.getContext('2d', { willReadFrequently: true });
    function glyph(ch, size) {
      const key = ch + size; if (GC[key]) return GC[key];
      gx.clearRect(0, 0, 64, 64); gx.fillStyle = '#fff'; gx.font = `700 ${size}px "Noto Sans CJK SC"`; gx.textBaseline = 'top'; gx.fillText(ch, 0, 0);
      const w = Math.ceil(gx.measureText(ch).width), d = gx.getImageData(0, 0, 64, 64).data, bits = [];
      for (let y = 0; y < size + 2; y++) { const row = []; for (let x = 0; x < w; x++) row.push(d[(y * 64 + x) * 4 + 3] > 110 ? 1 : 0); bits.push(row); }
      return (GC[key] = { w, bits });
    }
    function cjk(s, x, y, col, size = 12, outline = P(0, 0), d = 9, sc = 1) {
      let cx = x; const out = [];
      for (const ch of s) { const g = glyph(ch, size); out.push([cx, g]); cx += (g.w + 1) * sc; }
      const draw = (ox, oy, c) => out.forEach(([px, g]) => g.bits.forEach((row, j) => row.forEach((v, i) => { if (v) for (let a = 0; a < sc; a++) for (let b = 0; b < sc; b++) put(px + ox + i * sc + a, y + oy + j * sc + b, c, d); })));
      if (outline !== null) for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [1, 1]]) draw(dx, dy, outline);
      draw(0, 0, col);
      return cx - x;
    }
    const cw = (s, size = 12, sc = 1) => { let w = 0; for (const ch of s) w += (glyph(ch, size).w + 1) * sc; return w; };
    // sprite from rows of chars, map char -> palette index (or null)
    function sprite(rows, map, x, y, d = 6, flip = false, outline = null) {
      const h = rows.length, w = rows[0].length;
      if (outline !== null) for (let j = -1; j <= h; j++) for (let i = -1; i <= w; i++) { const on = (jj, ii) => jj >= 0 && jj < h && ii >= 0 && ii < w && map[rows[jj][ii]] !== undefined && map[rows[jj][ii]] !== null; if (!on(j, i) && (on(j - 1, i) || on(j + 1, i) || on(j, i - 1) || on(j, i + 1))) put(x + (flip ? w - 1 - i : i), y + j, outline, d); }
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const c = map[rows[j][i]]; if (c !== undefined && c !== null) put(x + (flip ? w - 1 - i : i), y + j, c, d); }
    }
    // dialog box (RPG style)
    function box(x, y, w, h, bg = P(0, 1), edge = P(10, 0), d = 9) { rect(x, y, w, h, bg, d); frame(x, y, w, h, edge, d); frame(x + 1, y + 1, w - 2, h - 2, P(0, 3), d); }
    // iris wipe: everything outside radius r around (cx, cy) goes black
    function iris(cx, cy, r) { for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) if (Math.hypot(x - cx, (y - cy)) > r) put(x, y, P(0, 0), 10); }
    function flush() { const d32 = new Uint32Array(img.data.buffer); for (let i = 0; i < buf.length; i++) d32[i] = PAL[buf[i]]; sctx.putImageData(img, 0, 0); ctx.imageSmoothingEnabled = false; ctx.drawImage(small, 0, 0, W, H); }
    function clear(c = 0) { buf.fill(c); dep.fill(0); }
    return { PW, PH, P, put, get, bump, rect, frame, line, circ, grad, text, tw, cjk, cw, sprite, box, iris, flush, clear, bay, h1, n1, buf, dep };
  }
  window.PX = { init };
})();
