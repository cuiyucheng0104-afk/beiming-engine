#!/usr/bin/env node
// 北冥引擎 · 取帧方式对比（实验，不在出片链路里）：同一部片，分别用「截图」与「直接读画布、原始流喂 FFmpeg」取帧并编码，
// 量每种方式的用时，并核对画面是否一致。结果与结论见 docs/capture-experiment.md。
//   node tools/rtx/capture-bench.mjs [影片目录，默认 .] [--out out/capture-bench] [--frames 240] [--reps 2] [--lanes 1,4]
//                                    [--single 方法,…] [--multi 方法,…]
// 方法：png（现在的无损截图）、jpeg（已有的有损截图）、rgba-b64 / rgba-ws（读画布 RGBA）、nv12-b64 / nv12-ws（显卡里转 YUV）、
//       nv12-ws-nvenc（再换显卡编码，FFmpeg 带 h264_nvenc 才跑）、png-again（PNG 再跑一遍，看两遍是否一致）。
//       b64 = 像素经调试通道（base64）传出浏览器；ws = 经本地 WebSocket 传出。
// 只适用于「一张 WebGL 画布 + 一张 2D 叠加层画布」的页面（engine/stage/film.js 建出来的就是）；页面型动画（DOM、SVG）读不到。
// stdout 是一个 JSON 对象（同时写到 <out>/results.json），进度走 stderr。成片留在 <out>/ 里，不提交。
// shortcut: WebSocket 服务端借用了 playwright-core 打包在内部的 ws（lib/utilsBundle.js），不是公开接口；真要做进出片链路时换成正式依赖。
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { openFilm, renderFrame } from '../../engine/render/page.mjs';
import { COLOR, x264Args, TAGS, FFMPEG } from '../../engine/render/lib/ffmpeg.mjs';

const require = createRequire(import.meta.url);
const { wsServer: WSS } = require(path.join(path.dirname(require.resolve('playwright-core/package.json')), 'lib/utilsBundle.js'));
const { values: opt, positionals } = parseArgs({ allowPositionals: true, options: {
  out: { type: 'string', default: 'out/capture-bench' }, frames: { type: 'string', default: '240' }, reps: { type: 'string', default: '2' },
  lanes: { type: 'string', default: '1,4' }, single: { type: 'string' }, multi: { type: 'string', default: 'png,jpeg,rgba-ws,nv12-ws,nv12-ws-nvenc' },
} });
const dir = positionals[0] ?? '.', outDir = path.resolve(opt.out);
const FPS = 24, W = 1920, H = 1040;
const TOTAL = +opt.frames, REPS = +opt.reps, LANE_LIST = opt.lanes.split(',').map(Number), LANES = Math.max(...LANE_LIST);
const SET = 'setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709';
fs.mkdirSync(outDir, { recursive: true });
const ff = FFMPEG();
const now = () => performance.now();
const say = s => process.stderr.write(s + '\n');

// 页内：另开一个 WebGL2 上下文，把 WebGL 画布与叠加层画布当纹理合成，输出 RGBA 或 NV12（有限范围 BT.709，色度 2×2 平均），整帧读回。
// NV12 的排法：目标宽 W/4、高 H×1.5，上面 H 行每个 RGBA 像素装 4 个亮度，下面 H/2 行每个像素装 U V U V，读回的字节序就是 NV12。
const install = () => {
  const cs = [...document.querySelectorAll('canvas')];
  const glc = cs.find(c => c.getContext('webgl2') || c.getContext('webgl')), ov = cs.find(c => c !== glc);
  const W = glc.width, H = glc.height;
  const HEAD = `#version 300 es
precision highp float; precision highp int; uniform sampler2D a, b; out vec4 o; const int H = ${H};
vec3 px(ivec2 q){ vec4 A = texelFetch(a, q, 0), B = texelFetch(b, q, 0); return B.rgb + A.rgb * (1.0 - B.a); }
`;
  const BODY = {
    rgba: `void main(){ o = vec4(px(ivec2(gl_FragCoord.xy)), 1.0); }`,
    nv12: `const vec3 K = vec3(0.2126, 0.7152, 0.0722);
float Yq(vec3 c){ return (16.0 + 219.0 * dot(c, K)) / 255.0; }
vec2 UVq(vec3 c){ float y = dot(c, K); return vec2(128.0 + 224.0 * (c.b - y) / 1.8556, 128.0 + 224.0 * (c.r - y) / 1.5748) / 255.0; }
vec3 avg(int x, int y){ return (px(ivec2(x, y)) + px(ivec2(x + 1, y)) + px(ivec2(x, y + 1)) + px(ivec2(x + 1, y + 1))) * 0.25; }
void main(){ ivec2 p = ivec2(gl_FragCoord.xy);
  if (p.y < H) { int x = p.x * 4; o = vec4(Yq(px(ivec2(x, p.y))), Yq(px(ivec2(x + 1, p.y))), Yq(px(ivec2(x + 2, p.y))), Yq(px(ivec2(x + 3, p.y)))); }
  else { int y = (p.y - H) * 2, x = p.x * 4; o = vec4(UVq(avg(x, y)), UVq(avg(x + 2, y))); } }`,
  };
  const mk = (tw, th, body) => {
    const c = document.createElement('canvas'); c.width = tw; c.height = th;
    const gl = c.getContext('webgl2', { antialias: false, depth: false, stencil: false });
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const pr = gl.createProgram();
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, `#version 300 es
void main(){ vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`));
    gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, HEAD + body));
    gl.linkProgram(pr); if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
    gl.useProgram(pr);
    gl.uniform1i(gl.getUniformLocation(pr, 'a'), 0); gl.uniform1i(gl.getUniformLocation(pr, 'b'), 1);
    const tex = i => {
      const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, t);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      return t;
    };
    const ta = tex(0), tb = tex(1);
    const target = gl.createTexture(); gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, target);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, tw, th);
    const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('fbo');
    // 叠加层按预乘透明度上传，合成式与浏览器一致：叠加层 + 底图 ×（1 − 叠加层透明度）
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true); gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.viewport(0, 0, tw, th); gl.disable(gl.BLEND);
    const buf = new Uint8Array(tw * th * 4);
    return () => {
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, ta); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, glc);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, tb); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, ov);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.readPixels(0, 0, tw, th, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      return buf;
    };
  };
  const cap = { rgba: mk(W, H, BODY.rgba), nv12: mk(W / 4, H * 3 / 2, BODY.nv12) };
  const b64 = u8 => { if (u8.toBase64) return u8.toBase64(); let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  window.__cap = {
    grab: mode => b64(cap[mode]()),
    open: url => new Promise((res, rej) => { const s = new WebSocket(url); s.binaryType = 'arraybuffer'; s.onopen = () => { window.__cap.sock = s; res(); }; s.onerror = () => rej(new Error('ws')); }),
    send: mode => new Promise(res => { const s = window.__cap.sock; s.onmessage = () => res(); s.send(cap[mode]()); }),
    shut: () => { window.__cap.sock?.close(); window.__cap.sock = null; },
    time: mode => { const a = performance.now(); cap[mode](); return performance.now() - a; },
  };
  return { W, H };
};

const RAW = fmt => ['-f', 'rawvideo', '-pix_fmt', fmt, '-s', `${W}x${H}`, '-framerate', String(FPS), '-i', '-'];
const PIPE = codec => ['-f', 'image2pipe', '-framerate', String(FPS), '-c:v', codec, '-i', '-'];
const X264 = x264Args({ crf: 14, preset: 'medium' });
const NVENC = ['-c:v', 'h264_nvenc', '-preset', 'p6', '-rc', 'vbr', '-cq', '16', '-b:v', '0'];
const YUV_VF = `format=yuv420p,${SET}`;
const grabNoRender = mode => async f => Buffer.from(await f.page.evaluate(mode => window.__cap.grab(mode), mode), 'base64');
const grabB64 = mode => async (f, t) => Buffer.from(await f.page.evaluate(async ({ t, mode }) => { await window.render(t); return window.__cap.grab(mode); }, { t, mode }), 'base64');
const shot = format => async (f, t, settle) => { await renderFrame(f, t, { settle }); return f.capture(format); };
const METHODS = {
  'png':           { label: '现在：PNG 截图', input: PIPE('png'), vf: COLOR.png, enc: X264, grab: shot('png') },
  'jpeg':          { label: '已有：JPEG 截图（有损）', input: PIPE('mjpeg'), vf: COLOR.jpeg, enc: X264, grab: shot('jpeg') },
  'rgba-b64':      { label: '读画布 RGBA，走调试通道', input: RAW('rgba'), vf: COLOR.png, enc: X264, grab: grabB64('rgba') },
  'rgba-ws':       { label: '读画布 RGBA，走本地 WebSocket', input: RAW('rgba'), vf: COLOR.png, enc: X264, ws: 'rgba' },
  'nv12-b64':      { label: '显卡里转 YUV，走调试通道', input: RAW('nv12'), vf: YUV_VF, enc: X264, grab: grabB64('nv12') },
  'nv12-ws':       { label: '显卡里转 YUV，走本地 WebSocket', input: RAW('nv12'), vf: YUV_VF, enc: X264, ws: 'nv12' },
  'nv12-ws-nvenc': { label: '显卡里转 YUV，再换显卡编码', input: RAW('nv12'), vf: YUV_VF, enc: NVENC, ws: 'nv12' },
  'png-again':     { label: '现在：PNG 截图（再跑一遍）', input: PIPE('png'), vf: COLOR.png, enc: X264, grab: shot('png') },
};

// 一路：一个浏览器页面渲 [a, b) 帧，喂给自己的 FFmpeg
async function lane(name, f, a, b, file, settle) {
  const m = METHODS[name];
  const p = spawn(ff, ['-y', '-loglevel', 'error', ...m.input, '-vf', m.vf, ...m.enc, ...TAGS, file], { stdio: ['pipe', 'ignore', 'inherit'] });
  const exited = new Promise(r => { p.once('close', r); p.once('error', () => r(-1)); });
  p.stdin.on('error', () => {});
  let wss = null, grabMs = 0;
  if (m.ws) {
    wss = new WSS({ host: '127.0.0.1', port: 0, perMessageDeflate: false, maxPayload: 64 << 20 });
    await new Promise(r => wss.once('listening', r));
    // 一帧写进 FFmpeg（管道满了等 drain）之后才回执，页面收到回执才渲下一帧
    wss.on('connection', sock => sock.on('message', data => { const ack = () => sock.send('k'); if (p.stdin.write(data)) ack(); else p.stdin.once('drain', ack); }));
    await f.page.evaluate(url => window.__cap.open(url), `ws://127.0.0.1:${wss.address().port}`);
  }
  for (let i = a; i < b; i++) {
    const s = now(), t = i / FPS;
    if (m.ws) await f.page.evaluate(async ({ t, mode }) => { await window.render(t); await window.__cap.send(mode); }, { t, mode: m.ws });
    else { const img = await m.grab(f, t, settle); if (!p.stdin.write(img)) await Promise.race([new Promise(r => p.stdin.once('drain', r)), exited]); }
    grabMs += now() - s;
  }
  if (m.ws) await f.page.evaluate(() => window.__cap.shut());
  p.stdin.end();
  const code = await exited;
  wss?.close();
  if (code !== 0) throw new Error(`${name}：FFmpeg 退出码 ${code}`);
  return { grabMs, bytes: fs.statSync(file).size };
}

async function runMethod(name, films, lanesN, settle) {
  const per = Math.floor(TOTAL / lanesN);
  let best = null;
  for (let r = 0; r < REPS; r++) {
    const t0 = now();
    const st = await Promise.all(films.slice(0, lanesN).map((f, i) => lane(name, f, i * per, (i + 1) * per, path.join(outDir, `${name}-L${lanesN}-${i}.mp4`), settle)));
    const wall = (now() - t0) / 1000, frames = per * lanesN;
    const res = { method: name, label: METHODS[name].label, lanes: lanesN, frames, wallSeconds: +wall.toFixed(2), fps: +(frames / wall).toFixed(1),
      grabMsPerFrame: +(st.reduce((x, s) => x + s.grabMs, 0) / frames).toFixed(1), bytes: st.reduce((x, s) => x + s.bytes, 0) };
    if (!best || res.wallSeconds < best.wallSeconds) best = res;
  }
  say(`${name} ×${lanesN} 路：${best.wallSeconds} 秒，${best.fps} 帧/秒，取帧 ${best.grabMsPerFrame} 毫秒/帧`);
  return best;
}

const run = (args, input) => spawnSync(ff, args, { input, maxBuffer: 256 << 20 });
function diff(a, b, { skipAlpha = false } = {}) {
  let n = 0, max = 0, sum = 0, cnt = 0;
  for (let i = 0; i < a.length; i++) { if (skipAlpha && (i & 3) === 3) continue; const d = Math.abs(a[i] - b[i]); cnt++; if (d) { n++; sum += d; if (d > max) max = d; } }
  return { differing: n, share: +(n / cnt * 100).toFixed(4), max, meanAbs: +(sum / cnt).toFixed(4) };
}

// ── 起浏览器、装页内读回、预热 ──
const info = { node: process.version, platform: process.platform, frames: TOTAL, reps: REPS, lanes: LANE_LIST, size: [W, H] };
let t = now();
const first = await openFilm(dir, { handleSignals: false });
info.setupFirstSeconds = +((now() - t) / 1000).toFixed(2);
t = now();
const rest = await Promise.all(Array.from({ length: LANES - 1 }, () => openFilm(dir, { handleSignals: false })));
info.setupOtherLanesSeconds = +((now() - t) / 1000).toFixed(2);
const films = [first, ...rest];
info.gpu = first.gpu; info.angle = first.info.angle;
const settle = first.info.angle === 'vulkan' ? 'raf2' : 'none';   // 与出片链路的 --settle auto 相同
info.settleForScreenshots = settle;
// 页面的请求拦截会让 WebSocket 之外的本地连接判成外网：实验里整个摘掉
for (const f of films) { await f.page.unroute('**/*'); info.page = await f.page.evaluate(install); }
t = now();
await Promise.all(films.map(async f => { for (let i = 0; i < TOTAL; i += 8) { await renderFrame(f, i / FPS, { settle }); await f.capture('png'); } }));
info.warmPassSeconds = +((now() - t) / 1000).toFixed(2);
say(`显卡：${info.gpu}（${info.angle}）；首个浏览器 ${info.setupFirstSeconds} 秒，其余 ${LANES - 1} 路 ${info.setupOtherLanesSeconds} 秒，预热 ${info.warmPassSeconds} 秒`);

// ── 画面一致性：同一次渲染下「截图」对「读画布」；同一帧渲两遍是否一致 ──
const fidelity = [];
for (const fr of [30, 120, 200].filter(x => x < TOTAL)) {
  await renderFrame(first, fr / FPS, { settle });
  const png = await first.capture('png');
  const refRgba = run(['-loglevel', 'error', '-f', 'image2pipe', '-c:v', 'png', '-i', '-', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], png).stdout;
  const refNv12 = run(['-loglevel', 'error', '-f', 'image2pipe', '-c:v', 'png', '-i', '-', '-vf', COLOR.png, '-f', 'rawvideo', '-pix_fmt', 'nv12', '-'], png).stdout;
  const rgba = await grabNoRender('rgba')(first), nv12 = await grabNoRender('nv12')(first);
  const again = await grabB64('rgba')(first, fr / FPS);
  fidelity.push({ frame: fr, rgb: diff(refRgba, rgba, { skipAlpha: true }), y: diff(refNv12.subarray(0, W * H), nv12.subarray(0, W * H)),
    uv: diff(refNv12.subarray(W * H), nv12.subarray(W * H)), rerender: diff(rgba, again, { skipAlpha: true }) });
}
// 页内纯读回耗时（不含把像素传出浏览器），24 帧取中位数
const inPage = {};
for (const mode of ['rgba', 'nv12']) {
  const xs = [];
  for (let i = 0; i < 24; i++) xs.push(await first.page.evaluate(async ({ t, mode }) => { await window.render(t); return window.__cap.time(mode); }, { t: Math.min(2, (TOTAL - 1) / FPS) + i / FPS / 24, mode }));
  xs.sort((a, b) => a - b); inPage[mode] = +xs[12].toFixed(2);
}

// ── 计时 ──
const hasNvenc = /h264_nvenc/.test(run(['-hide_banner', '-encoders']).stdout?.toString() ?? '');
const usable = name => METHODS[name] && (hasNvenc || !/nvenc/.test(name));
const SINGLE = (opt.single?.split(',') ?? Object.keys(METHODS)).filter(usable), MULTI = opt.multi.split(',').filter(usable);
if (!SINGLE.includes('png')) SINGLE.unshift('png');   // 成片对比的参照
const results = [];
for (const name of SINGLE) results.push(await runMethod(name, films, 1, settle));
for (const n of LANE_LIST.filter(n => n > 1)) for (const name of MULTI) results.push(await runMethod(name, films, n, settle));
await Promise.all(films.map(f => f.close()));

// ── 成片对比：各方法的单路成片逐帧对 PNG 路径的成片 ──
const refFile = path.join(outDir, 'png-L1-0.mp4');
const frameMd5 = file => (run(['-loglevel', 'error', '-i', file, '-map', '0:v', '-f', 'framemd5', '-']).stdout?.toString() ?? '').split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split(',').pop().trim());
const refFm = frameMd5(refFile);
for (const r of results.filter(r => r.lanes === 1)) {
  const file = path.join(outDir, `${r.method}-L1-0.mp4`);
  const fm = frameMd5(file);
  r.framesDifferentFromPng = fm.filter((x, i) => x !== refFm[i]).length + Math.max(0, refFm.length - fm.length);   // 少出的帧也算不同
  const e = run(['-hide_banner', '-i', file, '-i', refFile, '-lavfi', '[0:v][1:v]psnr;[0:v][1:v]ssim', '-f', 'null', '-']).stderr?.toString() ?? '';
  r.psnrVsPng = e.match(/PSNR.*average:([\d.inf]+)/)?.[1] ?? null;
  r.ssimVsPng = e.match(/SSIM.*All:([\d.]+)/)?.[1] ?? null;
}
const out = { info, inPageReadbackMs: inPage, fidelity, results };
fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(out, null, 1) + '\n');
console.log(JSON.stringify(out, null, 1));
process.exit(0);
