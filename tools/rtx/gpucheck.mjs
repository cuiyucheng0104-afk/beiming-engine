#!/usr/bin/env node
// 北冥引擎 · GPU 自检（npm run env:gpu）：逐个 ANGLE 后端看无头 Chrome 的 WebGL 落在哪块 GPU 上，推荐渲染该用哪个后端。
//   node tools/rtx/gpucheck.mjs [--backends metal,gl] [--angle 后端] [--bench-frames 20] [--json]
// 浏览器、启动参数与渲染器完全相同：都经 engine/render/lib/gpu.mjs 的 launchBrowser（默认 Playwright 自带、package.json 锁定的
// chromium-headless-shell，设了 BEIMING_CHROME 才用它指定的可执行文件），所以这里看到的就是渲染时的结果。
// 渲染器实际会用的后端（--angle / BEIMING_ANGLE / 平台默认：macOS metal、Windows vulkan、Linux default）标 ★。
// 每个后端另跑一个重着色器的微基准（每像素 400 次噪声循环，近似 Kuwahara / 体积云这类后期的负载）：它只说明 GPU 着色快慢，
// 不是出片吞吐——出片的瓶颈在截图与编码，估算整片耗时用 node engine/render/video.mjs <目录> --plan。
// 退出码：0 ★ 后端落在硬件 GPU 上；3 ★ 后端落到软件渲染（SwiftShader / llvmpipe / WARP）或起不来（结果里列出可用的硬件后端）；
//   2 用法错误；130 / 143 被中断（已关掉浏览器）。--help 不启动浏览器。
//
// 来源：WebGL 全屏三角形的编译与绑定写法改写自 LemoLab 的 lemo-opuscar
// （cases/vendor/lemo-opuscar/styles/urban-sketch/demo/engine.js，固定提交 bebbbe1），按其 MIT 许可使用并保留版权声明，许可全文见
// cases/licenses/LemoLab-MIT.txt；其余部分为北冥引擎原创。
// @provenance lemo-opuscar@bebbbe1:styles/urban-sketch/demo/engine.js
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
// SPDX-FileCopyrightText: 2026 LemoLab
import { isMain, runCli } from '../lib/cli.mjs';
import { RenderError } from '../../engine/render/lib/errors.mjs';
import { renderCommand } from '../../engine/render/lib/command.mjs';
import { launchBrowser, resolveAngle, validAngles, isSoftwareRenderer, chromeExecutable, chromeArgs } from '../../engine/render/lib/gpu.mjs';

// 推荐顺序：本平台上通常最快、最稳的硬件后端在前
const PREFER = { darwin: ['metal', 'default', 'gl'], win32: ['vulkan', 'd3d11', 'default', 'gl', 'd3d9'], linux: ['vulkan', 'gl', 'gles', 'default'] };

async function probe(angle, frames, life) {
  let browser, unregister = () => {};
  try {
    browser = await launchBrowser({ angle });
    unregister = life.closer(() => browser.close().catch(() => {}));
    const page = await browser.newPage({ viewport: { width: 1920, height: 1040 } });
    await page.setContent('<canvas id=c width=1920 height=1040></canvas>');
    const r = await page.evaluate(async n => {
      const c = document.getElementById('c'), g = c.getContext('webgl2');
      if (!g) return { err: '建不起 WebGL2 上下文' };
      const e = g.getExtension('WEBGL_debug_renderer_info');
      const name = e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : String(g.getParameter(g.RENDERER));
      const vs = '#version 300 es\nin vec2 p; void main(){ gl_Position = vec4(p,0.,1.); }';
      const fs = `#version 300 es
precision highp float; out vec4 o; uniform float t;
float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
void main(){ vec2 u = gl_FragCoord.xy/1000.; float a = 0.; for(int i=0;i<400;i++){ a += h(u + float(i)*0.013 + t); } o = vec4(vec3(a/400.),1.); }`;
      const sh = (ty, src) => { const s = g.createShader(ty); g.shaderSource(s, src); g.compileShader(s); return s; };
      const pr = g.createProgram(); g.attachShader(pr, sh(g.VERTEX_SHADER, vs)); g.attachShader(pr, sh(g.FRAGMENT_SHADER, fs)); g.linkProgram(pr); g.useProgram(pr);
      const b = g.createBuffer(); g.bindBuffer(g.ARRAY_BUFFER, b); g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), g.STATIC_DRAW);
      const loc = g.getAttribLocation(pr, 'p'); g.enableVertexAttribArray(loc); g.vertexAttribPointer(loc, 2, g.FLOAT, false, 0, 0);
      const tl = g.getUniformLocation(pr, 't'); const px = new Uint8Array(4);
      const run = k => { const t0 = performance.now(); for (let i = 0; i < k; i++) { g.uniform1f(tl, i * 0.1); g.drawArrays(g.TRIANGLES, 0, 3); g.readPixels(0, 0, 1, 1, g.RGBA, g.UNSIGNED_BYTE, px); } return (performance.now() - t0) / k; };
      run(3);
      return { name: String(name), msPerFrame: +run(n).toFixed(2) };
    }, frames);
    if (r.err) return { backend: angle, kind: 'error', error: r.err };
    return { backend: angle, kind: isSoftwareRenderer(r.name) ? 'software' : 'hardware', renderer: r.name, shaderBenchMs: r.msPerFrame, browser: browser.version() };
  } catch (e) {
    return { backend: angle, kind: 'error', error: String(e?.message ?? e).split('\n')[0] };
  } finally {
    unregister();
    await browser?.close().catch(() => {});
  }
}

export const command = renderCommand({
  name: 'tools/rtx/gpucheck.mjs',
  summary: '逐个 ANGLE 后端检查 WebGL 是否落在硬件 GPU 上，推荐渲染用的后端（浏览器与参数与渲染器相同）',
  usage: ['node tools/rtx/gpucheck.mjs [--backends a,b] [--angle 后端] [--bench-frames 20] [--json]'],
  options: {
    backends: { type: 'list', split: ',', arg: 'a,b', describe: '只试这些后端（默认本平台全部可用的）' },
    angle: { type: 'string', arg: '<后端>', describe: '当作渲染器会用的后端（默认 BEIMING_ANGLE，再默认平台值）' },
    'bench-frames': { type: 'integer', min: 1, max: 1000, default: 20, arg: '<n>', describe: '微基准的帧数（默认 20）' },
  },
  exitCodes: { 0: '渲染器会用的后端落在硬件 GPU 上', 2: '用法错误', 3: '渲染器会用的后端落到软件渲染或起不来', 130: '收到 SIGINT，已关掉浏览器', 143: '收到 SIGTERM，已关掉浏览器' },
  examples: ['node tools/rtx/gpucheck.mjs', 'BEIMING_ANGLE=vulkan node tools/rtx/gpucheck.mjs --json'],
}, async ({ opts, log, life }) => {
  const { angle: chosen, source } = resolveAngle(opts.angle ?? undefined);
  const valid = validAngles();
  for (const a of opts.backends) if (!valid.includes(a)) throw new RenderError('usage.angle', `后端 ${a} 在这个平台上不可用`, { hint: `可用：${valid.join(' / ')}` });
  const list = opts.backends.length ? opts.backends : [...new Set([chosen, ...(PREFER[process.platform] ?? []), ...valid])].filter(a => valid.includes(a) && (a !== 'swiftshader' || a === chosen));   // 软件后端只在它就是渲染器会用的那个时才测
  const exe = chromeExecutable();
  log.info(`浏览器：${exe || 'Playwright 自带的 chromium-headless-shell'}；启动参数 ${chromeArgs(chosen).join(' ')}；渲染器会用的后端：${chosen}（★，来自 ${source}）`);
  const results = [];
  for (const a of list) {
    const r = await probe(a, opts['bench-frames'], life);
    results.push(r);
    const label = { hardware: '硬件', software: '软件', error: '失败' }[r.kind];
    log.info(`${a === chosen ? '★' : ' '} ${a.padEnd(8)} ${label}  ${r.renderer ?? r.error}${r.shaderBenchMs !== undefined ? `  着色器微基准 ${r.shaderBenchMs} ms/帧` : ''}`);
  }
  const order = PREFER[process.platform] ?? [];
  const rank = b => { const i = order.indexOf(b); return i < 0 ? 99 : i; };
  const hardware = results.filter(r => r.kind === 'hardware').sort((x, y) => rank(x.backend) - rank(y.backend));
  const recommended = hardware[0]?.backend ?? null;
  const mine = results.find(r => r.backend === chosen);
  const data = { chosen, chosenSource: source, recommended, results, executable: exe ? 'BEIMING_CHROME' : 'chromium-headless-shell' };
  if (mine?.kind !== 'hardware') {
    throw new RenderError('env.gpu-not-hardware', `渲染器会用的 ${chosen} 后端${mine?.kind === 'software' ? '落到了软件渲染' : mine ? '起不来' : '没有测'}`, {
      hint: recommended ? `设 BEIMING_ANGLE=${recommended}（或渲染时加 --angle ${recommended}）` : '没有任何后端拿到硬件 GPU：检查显卡驱动，或用 BEIMING_CHROME 换浏览器；没有 GPU 的机器渲染时加 --gpu software-ok',
      data,
    });
  }
  log.info(`通过：${chosen} 落在硬件 GPU 上${recommended && recommended !== chosen ? `（本平台推荐 ${recommended}）` : ''}`);
  return { data };
});

if (isMain(import.meta.url)) await runCli(command);
