// 检查无头 Chrome 各 ANGLE 后端的 WebGL 落在哪块 GPU 上，并粗测一个重着色器的帧时间。
// 用法：node tools/rtx/gpucheck.mjs
// 浏览器与启动参数和渲染器（engine/render/page.mjs）完全一致：默认是 Playwright 自带的 chromium-headless-shell，
// 设了 BEIMING_CHROME 才用它指定的可执行文件（例如系统 Chrome）。渲染器实际会用的后端（BEIMING_ANGLE；
// 没设时 macOS 为 metal、其它为 default）标 ★。
// 退出码：★ 后端拿到硬件 GPU 为 0；它落到软件渲染（SwiftShader / llvmpipe / WARP 即 Microsoft Basic Render
// Driver）或启动失败为 1，并列出可用的硬件后端，可以放在渲染脚本前当前置检查。
import { chromium } from 'playwright-core';
import { chromeArgs, chromeExecutable, defaultAngle, isSoftwareRenderer } from '../../engine/render/page.mjs';

const chosen = defaultAngle();
const backends = [...new Set([chosen, 'default', ...(process.platform === 'darwin' ? ['metal'] : ['d3d11']), 'vulkan', 'gl'])];
const exe = chromeExecutable();
console.log(`浏览器：${exe || 'Playwright 自带的 chromium-headless-shell'}；渲染器会用的后端：${chosen}（★）`);

const results = {};
for (const angle of backends) {
  let browser;
  try {
    browser = await chromium.launch({ executablePath: exe, args: chromeArgs(angle) });
    const page = await browser.newPage({ viewport: { width: 1920, height: 1040 } });
    await page.setContent('<canvas id=c width=1920 height=1040></canvas>');
    const r = await page.evaluate(async () => {
      const c = document.getElementById('c'), g = c.getContext('webgl2');
      if (!g) return { err: 'no webgl2' };
      const e = g.getExtension('WEBGL_debug_renderer_info');
      const name = e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : '?';
      // 重着色器：每像素 400 次噪声循环，近似 Kuwahara/体积云这类后期的负载
      const vs = `#version 300 es
in vec2 p; void main(){ gl_Position = vec4(p,0.,1.); }`;
      const fs = `#version 300 es
precision highp float; out vec4 o; uniform float t;
float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
void main(){ vec2 u = gl_FragCoord.xy/1000.; float a = 0.; for(int i=0;i<400;i++){ a += h(u + float(i)*0.013 + t); } o = vec4(vec3(a/400.),1.); }`;
      const sh = (ty, src) => { const s = g.createShader(ty); g.shaderSource(s, src); g.compileShader(s); return s; };
      const pr = g.createProgram(); g.attachShader(pr, sh(g.VERTEX_SHADER, vs)); g.attachShader(pr, sh(g.FRAGMENT_SHADER, fs)); g.linkProgram(pr); g.useProgram(pr);
      const b = g.createBuffer(); g.bindBuffer(g.ARRAY_BUFFER, b); g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1,-1,3,-1,-1,3]), g.STATIC_DRAW);
      const loc = g.getAttribLocation(pr, 'p'); g.enableVertexAttribArray(loc); g.vertexAttribPointer(loc, 2, g.FLOAT, false, 0, 0);
      const tl = g.getUniformLocation(pr, 't'); const px = new Uint8Array(4);
      const run = n => { const t0 = performance.now(); for (let i = 0; i < n; i++) { g.uniform1f(tl, i * 0.1); g.drawArrays(g.TRIANGLES, 0, 3); g.readPixels(0, 0, 1, 1, g.RGBA, g.UNSIGNED_BYTE, px); } return (performance.now() - t0) / n; };
      run(3); const ms = run(20);
      return { name, msPerFrame: +ms.toFixed(2) };
    });
    const kind = r.err ? 'error' : isSoftwareRenderer(r.name) ? 'software' : 'hardware';
    results[angle] = kind;
    console.log(`${angle === chosen ? '★' : ' '} ${angle.padEnd(8)} ${{ hardware: '硬件', software: '软件', error: '失败' }[kind]}  ${JSON.stringify(r)}`);
  } catch (e) {
    results[angle] = 'error';
    console.log(`${angle === chosen ? '★' : ' '} ${angle.padEnd(8)} 失败  ${e.message.split('\n')[0]}`);
  } finally { await browser?.close(); }
}

const hardware = backends.filter(a => results[a] === 'hardware');
if (results[chosen] === 'hardware') {
  console.log(`通过：渲染器会用的 ${chosen} 后端落在硬件 GPU 上`);
} else {
  console.error(`不通过：渲染器会用的 ${chosen} 后端${results[chosen] === 'software' ? '落到了软件渲染' : '启动失败'}。`
    + (hardware.length ? `可用的硬件后端：${hardware.join('、')}，例如设置 BEIMING_ANGLE=${hardware[0]}` : '没有任何后端拿到硬件 GPU：检查显卡驱动，或用 BEIMING_CHROME 换浏览器'));
  process.exitCode = 1;
}
