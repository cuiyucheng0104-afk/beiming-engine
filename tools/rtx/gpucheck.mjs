// 检查无头 Chrome 各 ANGLE 后端的 WebGL 落在哪块 GPU 上，并粗测一个重着色器的帧时间
// 用法：node tools/rtx/gpucheck.mjs（Windows 默认用系统 Chrome；可用 BEIMING_CHROME 指定可执行文件）
import { chromium } from 'playwright-core';
const exe = process.env.BEIMING_CHROME || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined);
for (const angle of ['default', 'd3d11', 'vulkan', 'gl']) {
  const args = [...(angle === 'default' ? [] : [`--use-angle=${angle}`]), '--enable-gpu', '--ignore-gpu-blocklist', '--force-color-profile=srgb'];
  let browser;
  try {
    browser = await chromium.launch({ executablePath: exe, args });
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
    console.log(angle.padEnd(8), JSON.stringify(r));
  } catch (e) { console.log(angle.padEnd(8), 'ERROR', e.message.split('\n')[0]); }
  finally { await browser?.close(); }
}
