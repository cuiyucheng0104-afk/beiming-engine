// 北冥引擎 · GPU 帧合成、时间超采样运动模糊与 BT.709 YUV420p 直出（video / shots / still 共用）。
// 借鉴开源项目 Leonxlnx/shanshui 的「GPU 着色器直转 YUV420 喂 FFmpeg + 帧内多子帧运动模糊」工程思路，纯自研干净室实现。
//
//   rgbToBt709Yuv420(rgba, w, h)         Node 端精确参考实现：RGBA8 顶行优先 → 有限范围 BT.709 yuv420p 平面字节流（1.5 × w × h 字节）
//   bt709Yuv420ToRgb(yuv, w, h)          Node 端逆变换参考实现：有限范围 BT.709 yuv420p → RGB24（单测核对色度与灰阶）
//   rawYuvInputArgs(w, h, fps)           FFmpeg 裸 yuv420p 管道输入参数（带 tv / bt709 四项色彩标记）
//   captureGpuFrame(film, t, opts)       在页面内跑 render(t)（samples > 1 时在线性光下累积子帧运动模糊），并在 WebGL2 中直接
//                                        输出 yuv420p 裸流或 png/jpeg Buffer；默认 samples=1 且非 yuv420 时外层仍走原 capture 路径
import { RenderError } from './errors.mjs';

const clampByte = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Node 端精确参考实现：RGBA8（顶行优先，每像素 4 字节，sRGB 0–255）→ 有限范围 BT.709 yuv420p 平面 Buffer。
 * 公式与 ITU-R BT.709-6 Studio Swing 一致：
 *   Y  = round(16  + 219 * (0.2126 R + 0.7152 G + 0.0722 B))        ∈ [16, 235]
 *   Cb = round(128 + 224 * (-0.114572106 R - 0.385427894 G + 0.5 B)) ∈ [16, 240]（2×2 邻域均值）
 *   Cr = round(128 + 224 * (0.5 R - 0.454152908 G - 0.045847092 B))  ∈ [16, 240]（2×2 邻域均值）
 */
export function rgbToBt709Yuv420(rgba, w, h) {
  if (w % 2 || h % 2) throw new RangeError(`yuv420p 要求宽高为偶数（收到 ${w}x${h}）`);
  const ySize = w * h, uvW = w >> 1, uvH = h >> 1, uvSize = uvW * uvH;
  const out = Buffer.allocUnsafe(ySize + uvSize * 2);
  const inv255 = 1 / 255;
  for (let y = 0; y < h; y++) {
    const rowOff = y * w;
    for (let x = 0; x < w; x++) {
      const k = (rowOff + x) * 4;
      const r = rgba[k] * inv255, g = rgba[k + 1] * inv255, b = rgba[k + 2] * inv255;
      const yy = Math.floor(16 + 219 * (0.2126 * r + 0.7152 * g + 0.0722 * b) + 0.5);
      out[rowOff + x] = clampByte(yy, 16, 235);
    }
  }
  const uBase = ySize, vBase = ySize + uvSize;
  const inv1020 = 1 / (255 * 4);
  for (let uy = 0; uy < uvH; uy++) {
    const y0 = uy * 2, y1 = y0 + 1;
    for (let ux = 0; ux < uvW; ux++) {
      const x0 = ux * 2, x1 = x0 + 1;
      const k00 = (y0 * w + x0) * 4, k10 = (y0 * w + x1) * 4;
      const k01 = (y1 * w + x0) * 4, k11 = (y1 * w + x1) * 4;
      const r = (rgba[k00] + rgba[k10] + rgba[k01] + rgba[k11]) * inv1020;
      const g = (rgba[k00 + 1] + rgba[k10 + 1] + rgba[k01 + 1] + rgba[k11 + 1]) * inv1020;
      const b = (rgba[k00 + 2] + rgba[k10 + 2] + rgba[k01 + 2] + rgba[k11 + 2]) * inv1020;
      const cb = Math.floor(128 + 224 * (-0.114572106 * r - 0.385427894 * g + 0.5 * b) + 0.5);
      const cr = Math.floor(128 + 224 * (0.5 * r - 0.454152908 * g - 0.045847092 * b) + 0.5);
      const idx = uy * uvW + ux;
      out[uBase + idx] = clampByte(cb, 16, 240);
      out[vBase + idx] = clampByte(cr, 16, 240);
    }
  }
  return out;
}

/** Node 端逆变换（最近邻色度上采样，供单测核对色彩矩阵与范围） */
export function bt709Yuv420ToRgb(yuv, w, h) {
  const ySize = w * h, uvW = w >> 1, uvSize = uvW * (h >> 1);
  const out = Buffer.allocUnsafe(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const Y = (yuv[y * w + x] - 16) / 219;
      const cIdx = (y >> 1) * uvW + (x >> 1);
      const Cb = (yuv[ySize + cIdx] - 128) / 224;
      const Cr = (yuv[ySize + uvSize + cIdx] - 128) / 224;
      const r = Y + 1.5748 * Cr;
      const g = Y - 0.187324273 * Cb - 0.468124273 * Cr;
      const b = Y + 1.8556 * Cb;
      const k = (y * w + x) * 3;
      out[k] = clampByte(Math.round(r * 255), 0, 255);
      out[k + 1] = clampByte(Math.round(g * 255), 0, 255);
      out[k + 2] = clampByte(Math.round(b * 255), 0, 255);
    }
  }
  return out;
}

/** FFmpeg 从 stdin 接收裸有限范围 BT.709 yuv420p 的输入参数 */
export function rawYuvInputArgs(w, h, fps) {
  return [
    '-f', 'rawvideo', '-pix_fmt', 'yuv420p',
    '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-s', `${w}x${h}`, '-framerate', String(fps), '-i', '-',
  ];
}

// 母版和顺序 QA 探针走相同的子帧时刻，片尾的快门不能越过片长。
export function exposureTimes(t, samples, shutter, fps, dur) {
  const count = Math.max(1, samples | 0);
  if (count === 1) return [t];
  const maxT = Number.isFinite(dur) && dur > 0 ? Math.max(0, dur - 1e-6) : Infinity;
  return Array.from({ length: count }, (_, s) => Math.min(maxT, t + (s / count) * (shutter / fps)));
}

// 注入页面的惰性单例渲染合成与色彩转换代码（完全在浏览器沙盒内运行，不触发任何网络请求）
async function browserCaptureStep(arg) {
  const { times, format, quality, settle, w, h } = arg;
  const state = (window.__BEIMING_GPU_CAPTURE ??= (() => {
    const glCanvas = document.createElement('canvas');
    glCanvas.width = 16;
    glCanvas.height = 16;
    const gl = glCanvas.getContext('webgl2', {
      alpha: false, depth: false, stencil: false, antialias: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('浏览器不支持 WebGL2，无法执行 GPU 帧合成');
    const floatExt = Boolean(gl.getExtension('EXT_color_buffer_float'));

    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s);
        gl.deleteShader(s);
        throw new Error(`GPU 帧合成着色器编译失败：${log}`);
      }
      return s;
    };
    const link = (vsSrc, fsSrc) => {
      const p = gl.createProgram();
      const vs = compile(gl.VERTEX_SHADER, vsSrc);
      const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
      gl.attachShader(p, vs);
      gl.attachShader(p, fs);
      gl.linkProgram(p);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(p);
        gl.deleteProgram(p);
        throw new Error(`GPU 帧合成程序链接失败：${log}`);
      }
      return p;
    };

    const FULL_VS = `#version 300 es
      const vec2 POS[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
      void main() { gl_Position = vec4(POS[gl_VertexID], 0.0, 1.0); }`;

    // 把页面里一个可见 <canvas> 按其屏幕矩形 [x0, y0, x1, y1]（左上角为 (0,0)）画进顶行在 y=0 的 FBO
    const LAYER_VS = `#version 300 es
      uniform vec4 uRect;
      uniform vec2 uView;
      out vec2 vUv;
      const vec2 UV[6] = vec2[6](
        vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(0.0, 1.0),
        vec2(0.0, 1.0), vec2(1.0, 0.0), vec2(1.0, 1.0)
      );
      void main() {
        vec2 uv = UV[gl_VertexID];
        vUv = uv;
        vec2 px = mix(uRect.xy, uRect.zw, uv);
        vec2 ndc = (px / uView) * 2.0 - 1.0;
        gl_Position = vec4(ndc, 0.0, 1.0);
      }`;
    const LAYER_FS = `#version 300 es
      precision highp float;
      uniform sampler2D uTex;
      uniform float uOpacity;
      in vec2 vUv;
      out vec4 fragColor;
      void main() {
        vec4 c = texture(uTex, vUv);
        fragColor = c * uOpacity;
      }`;

    // sRGB → 线性光累积（子帧权重 uWeight）
    const ACCUM_FS = `#version 300 es
      precision highp float;
      uniform sampler2D uSub;
      uniform float uWeight;
      out vec4 fragColor;
      vec3 srgbToLinear(vec3 c) {
        bvec3 lo = lessThanEqual(c, vec3(0.04045));
        vec3 a = c / 12.92;
        vec3 b = pow((c + 0.055) / 1.055, vec3(2.4));
        return mix(b, a, lo);
      }
      void main() {
        ivec2 p = ivec2(gl_FragCoord.xy);
        vec3 c = texelFetch(uSub, p, 0).rgb;
        fragColor = vec4(srgbToLinear(c) * uWeight, uWeight);
      }`;

    // 线性光 → sRGB
    const RESOLVE_FS = `#version 300 es
      precision highp float;
      uniform sampler2D uAccum;
      out vec4 fragColor;
      vec3 linearToSrgb(vec3 c) {
        c = clamp(c, 0.0, 1.0);
        bvec3 lo = lessThanEqual(c, vec3(0.0031308));
        vec3 a = c * 12.92;
        vec3 b = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
        return mix(b, a, lo);
      }
      void main() {
        ivec2 p = ivec2(gl_FragCoord.xy);
        vec3 lin = texelFetch(uAccum, p, 0).rgb;
        fragColor = vec4(linearToSrgb(lin), 1.0);
      }`;

    // 打包 BT.709 有限范围 Y 平面：每输出 RGBA8 像素写 4 个相邻水平像素的 Y
    const Y_PACK_FS = `#version 300 es
      precision highp float;
      uniform sampler2D uSrc;
      uniform int uWidth;
      out vec4 fragColor;
      float rgbToY(vec3 c) {
        float y = 16.0 + 219.0 * dot(c, vec3(0.2126, 0.7152, 0.0722));
        return clamp(floor(y + 0.5), 16.0, 235.0) / 255.0;
      }
      vec3 pick(int x, int y) {
        return texelFetch(uSrc, ivec2(min(x, uWidth - 1), y), 0).rgb;
      }
      void main() {
        int x0 = int(gl_FragCoord.x) * 4;
        int y = int(gl_FragCoord.y);
        fragColor = vec4(
          rgbToY(pick(x0, y)),
          rgbToY(pick(x0 + 1, y)),
          rgbToY(pick(x0 + 2, y)),
          rgbToY(pick(x0 + 3, y))
        );
      }`;

    // 打包 BT.709 有限范围 Cb / Cr 平面：上半高 [0, H/2) 写 Cb，下半高 [H/2, H) 写 Cr，每像素写 4 个 2×2 块
    const UV_PACK_FS = `#version 300 es
      precision highp float;
      uniform sampler2D uSrc;
      uniform int uWidth;
      uniform int uHalfH;
      out vec4 fragColor;
      vec3 box2x2(int bx, int by) {
        int x0 = min(bx * 2, uWidth - 1);
        int x1 = min(bx * 2 + 1, uWidth - 1);
        int y0 = by * 2;
        int y1 = by * 2 + 1;
        return 0.25 * (
          texelFetch(uSrc, ivec2(x0, y0), 0).rgb +
          texelFetch(uSrc, ivec2(x1, y0), 0).rgb +
          texelFetch(uSrc, ivec2(x0, y1), 0).rgb +
          texelFetch(uSrc, ivec2(x1, y1), 0).rgb
        );
      }
      float toCb(vec3 c) {
        float v = 128.0 + 224.0 * dot(c, vec3(-0.114572106, -0.385427894, 0.5));
        return clamp(floor(v + 0.5), 16.0, 240.0) / 255.0;
      }
      float toCr(vec3 c) {
        float v = 128.0 + 224.0 * dot(c, vec3(0.5, -0.454152908, -0.045847092));
        return clamp(floor(v + 0.5), 16.0, 240.0) / 255.0;
      }
      void main() {
        int bx0 = int(gl_FragCoord.x) * 4;
        int row = int(gl_FragCoord.y);
        if (row < uHalfH) {
          fragColor = vec4(
            toCb(box2x2(bx0, row)),
            toCb(box2x2(bx0 + 1, row)),
            toCb(box2x2(bx0 + 2, row)),
            toCb(box2x2(bx0 + 3, row))
          );
        } else {
          int ry = row - uHalfH;
          fragColor = vec4(
            toCr(box2x2(bx0, ry)),
            toCr(box2x2(bx0 + 1, ry)),
            toCr(box2x2(bx0 + 2, ry)),
            toCr(box2x2(bx0 + 3, ry))
          );
        }
      }`;

    const vao = gl.createVertexArray();
    const layerProg = link(LAYER_VS, LAYER_FS);
    const accumProg = link(FULL_VS, ACCUM_FS);
    const resolveProg = link(FULL_VS, RESOLVE_FS);
    const yProg = link(FULL_VS, Y_PACK_FS);
    const uvProg = link(FULL_VS, UV_PACK_FS);

    const layerTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, layerTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const makeFbo = (fw, fh, internalFormat, formatEnum, typeEnum) => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, fw, fh, 0, formatEnum, typeEnum, null);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { tex, fbo, w: fw, h: fh };
    };

    const killFbo = o => {
      if (!o) return;
      gl.deleteFramebuffer(o.fbo);
      gl.deleteTexture(o.tex);
    };

    return {
      gl, vao, floatExt, layerTex,
      layerProg, accumProg, resolveProg, yProg, uvProg,
      uRect: gl.getUniformLocation(layerProg, 'uRect'),
      uView: gl.getUniformLocation(layerProg, 'uView'),
      uLayerTex: gl.getUniformLocation(layerProg, 'uTex'),
      uOpacity: gl.getUniformLocation(layerProg, 'uOpacity'),
      uSub: gl.getUniformLocation(accumProg, 'uSub'),
      uWeight: gl.getUniformLocation(accumProg, 'uWeight'),
      uAccum: gl.getUniformLocation(resolveProg, 'uAccum'),
      uYSrc: gl.getUniformLocation(yProg, 'uSrc'),
      uYWidth: gl.getUniformLocation(yProg, 'uWidth'),
      uUvSrc: gl.getUniformLocation(uvProg, 'uSrc'),
      uUvWidth: gl.getUniformLocation(uvProg, 'uWidth'),
      uUvHalfH: gl.getUniformLocation(uvProg, 'uHalfH'),
      makeFbo, killFbo,
      curW: 0, curH: 0, padW: 0,
      sub: null, accum: null, resolved: null, yFbo: null, uvFbo: null,
      yuvOut: null, yScratch: null, uvScratch: null, rgbaScratch: null, encCanvas: null, encCtx: null,
    };
  })());

  const { gl } = state;
  if (state.curW !== w || state.curH !== h) {
    state.killFbo(state.sub);
    state.killFbo(state.accum);
    state.killFbo(state.resolved);
    state.killFbo(state.yFbo);
    state.killFbo(state.uvFbo);
    const padW = (w + 7) & ~7;
    state.curW = w;
    state.curH = h;
    state.padW = padW;
    state.sub = state.makeFbo(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    state.accum = state.floatExt
      ? state.makeFbo(w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT)
      : state.makeFbo(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    state.resolved = state.makeFbo(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    state.yFbo = state.makeFbo(padW >> 2, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    state.uvFbo = state.makeFbo(padW >> 3, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    state.yuvOut = new Uint8Array((w * h * 3) >> 1);
    state.yScratch = padW === w ? null : new Uint8Array(padW * h);
    state.uvScratch = padW === w ? null : new Uint8Array((padW >> 1) * h);
    state.rgbaScratch = new Uint8Array(w * h * 4);
  }

  const parseBg = () => {
    for (const el of [document.body, document.documentElement]) {
      if (!el) continue;
      const bg = getComputedStyle(el).backgroundColor || '';
      const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)/.exec(bg);
      if (m) {
        const a = m[4] === undefined ? 1 : Number(m[4]);
        if (a > 0) return [(Number(m[1]) / 255) * a, (Number(m[2]) / 255) * a, (Number(m[3]) / 255) * a];
      }
    }
    return [0, 0, 0];
  };

  const compositeDomCanvases = () => {
    const [br, bg, bb] = parseBg();
    gl.bindFramebuffer(gl.FRAMEBUFFER, state.sub.fbo);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);
    gl.clearColor(br, bg, bb, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const canvases = document.querySelectorAll('canvas');
    gl.useProgram(state.layerProg);
    gl.bindVertexArray(state.vao);
    gl.uniform2f(state.uView, w, h);
    gl.uniform1i(state.uLayerTex, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, state.layerTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    for (let i = 0; i < canvases.length; i++) {
      const c = canvases[i];
      if (!c.width || !c.height) continue;
      const cs = getComputedStyle(c);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const op = Number(cs.opacity ?? 1);
      if (!(op > 0)) continue;
      const rect = c.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) continue;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, c);
      gl.uniform4f(state.uRect, rect.left, rect.top, rect.right, rect.bottom);
      gl.uniform1f(state.uOpacity, op);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.disable(gl.BLEND);
  };

  const count = times.length;
  if (count > 1 && arg.phase !== 'remaining') {
    gl.bindFramebuffer(gl.FRAMEBUFFER, state.accum.fbo);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  const end = arg.phase === 'first' ? 1 : count;
  for (let s = arg.phase === 'remaining' ? 1 : 0; s < end; s++) {
    await window.render(times[s]);
    if (settle === 'raf2') await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    compositeDomCanvases();
    if (count > 1) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, state.accum.fbo);
      gl.viewport(0, 0, w, h);
      gl.useProgram(state.accumProg);
      gl.bindVertexArray(state.vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, state.sub.tex);
      gl.uniform1i(state.uSub, 0);
      gl.enable(gl.BLEND);
      if (state.floatExt) {
        gl.uniform1f(state.uWeight, 1 / count);
        gl.blendFunc(gl.ONE, gl.ONE);
      } else {
        gl.uniform1f(state.uWeight, 1);
        gl.blendColor(0, 0, 0, 1 / (s + 1));
        gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.disable(gl.BLEND);
    }
  }

  if (arg.phase === 'first') return;
  let srgbTex = state.sub.tex;
  let srgbFbo = state.sub.fbo;
  if (count > 1) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, state.resolved.fbo);
    gl.viewport(0, 0, w, h);
    gl.useProgram(state.resolveProg);
    gl.bindVertexArray(state.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, state.accum.tex);
    gl.uniform1i(state.uAccum, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    srgbTex = state.resolved.tex;
    srgbFbo = state.resolved.fbo;
  }

  const toBase64 = bytes => {
    if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
    const parts = [];
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + step)));
    }
    return btoa(parts.join(''));
  };

  const faults = window.__BEIMING_FAULTS ? window.__BEIMING_FAULTS.length : 0;
  if (format === 'yuv420') {
    const padW = state.padW;
    // 1) Y 平面
    gl.bindFramebuffer(gl.FRAMEBUFFER, state.yFbo.fbo);
    gl.viewport(0, 0, padW >> 2, h);
    gl.useProgram(state.yProg);
    gl.bindVertexArray(state.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srgbTex);
    gl.uniform1i(state.uYSrc, 0);
    gl.uniform1i(state.uYWidth, w);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    const yBytes = w * h;
    if (padW === w) {
      gl.readPixels(0, 0, padW >> 2, h, gl.RGBA, gl.UNSIGNED_BYTE, state.yuvOut.subarray(0, yBytes));
    } else {
      gl.readPixels(0, 0, padW >> 2, h, gl.RGBA, gl.UNSIGNED_BYTE, state.yScratch);
      for (let y = 0; y < h; y++) state.yuvOut.set(state.yScratch.subarray(y * padW, y * padW + w), y * w);
    }

    // 2) Cb + Cr 平面（单次 readPixels 连续读出）
    gl.bindFramebuffer(gl.FRAMEBUFFER, state.uvFbo.fbo);
    gl.viewport(0, 0, padW >> 3, h);
    gl.useProgram(state.uvProg);
    gl.bindVertexArray(state.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srgbTex);
    gl.uniform1i(state.uUvSrc, 0);
    gl.uniform1i(state.uUvWidth, w);
    gl.uniform1i(state.uUvHalfH, h >> 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (padW === w) {
      gl.readPixels(0, 0, padW >> 3, h, gl.RGBA, gl.UNSIGNED_BYTE, state.yuvOut.subarray(yBytes));
    } else {
      gl.readPixels(0, 0, padW >> 3, h, gl.RGBA, gl.UNSIGNED_BYTE, state.uvScratch);
      const srcStride = padW >> 1, dstStride = w >> 1;
      for (let r = 0; r < h; r++) state.yuvOut.set(state.uvScratch.subarray(r * srcStride, r * srcStride + dstStride), yBytes + r * dstStride);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { faults, b64: toBase64(state.yuvOut) };
  }

  // samples > 1 且输出 PNG / JPEG：从 resolvedFbo 读回顶行优先 RGBA8 并编码
  gl.bindFramebuffer(gl.FRAMEBUFFER, srgbFbo);
  gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, state.rgbaScratch);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (!state.encCanvas || state.encCanvas.width !== w || state.encCanvas.height !== h) {
    state.encCanvas = document.createElement('canvas');
    state.encCanvas.width = w;
    state.encCanvas.height = h;
    state.encCtx = state.encCanvas.getContext('2d');
  }
  state.encCtx.putImageData(new ImageData(new Uint8ClampedArray(state.rgbaScratch.buffer), w, h), 0, 0);
  const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const dataUrl = state.encCanvas.toDataURL(mime, format === 'jpeg' ? quality / 100 : undefined);
  return { faults, b64: dataUrl.slice(dataUrl.indexOf(',') + 1) };
}

/**
 * 在页面内执行 render(t)（含可选时间超采样 samples > 1）并直接在 GPU 侧转换/截出字节流。
 * 超时、render 抛错、上下文丢失与 page.mjs 的 renderFrame 保持完全相同的错误码与退出码。
 */
export async function captureGpuFrame(film, t, {
  w, h, format = 'yuv420', quality = 95, samples = 1, shutter = 0.5, fps = 24, dur = Infinity,
  timeoutMs = 60000, settle = 'none', where = `t=${t}`, signal, afterFirstSample,
} = {}) {
  film.check();
  if (signal?.aborted) throw signal.reason;
  const limit = timeoutMs * Math.max(1, samples);
  let timer, onAbort;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new RenderError('timeout.frame', `${where}：render(t) 超过 ${limit / 1000} 秒没有返回`, {
      hint: '页面卡死（死循环、等永远不来的 Promise）：单独渲这一帧排查；重帧确实慢就调大 --frame-timeout（或 BEIMING_FRAME_TIMEOUT）',
    })), limit);
    if (signal) {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  let res;
  try {
    // 注意：绝不把长生命周期永不决议的 film.failed 直接放进每帧 Promise.race，
    // 否则 V8 会在 film.failed 的内部反应链上永久挂载每帧 4.15MB 的 PromiseResult 造成 20GB 内存泄漏。
    const args = { times: exposureTimes(t, samples, shutter, fps, dur), format, quality, settle, w, h };
    // 第一子帧对应时间轴的整数帧；在继续曝光前采文字和投影，保留 GPU 已累积的颜色。
    if (samples > 1 && afterFirstSample) {
      await Promise.race([film.page.evaluate(browserCaptureStep, { ...args, phase: 'first' }), guard]);
      await Promise.race([afterFirstSample(), guard]);
      args.phase = 'remaining';
    }
    res = await Promise.race([film.page.evaluate(browserCaptureStep, args), guard]);
  } catch (e) {
    if (e instanceof RenderError || signal?.aborted) throw signal?.aborted ? signal.reason : e;
    film.check();
    const msg = String(e?.message ?? e).replace(/^page\.evaluate:\s*/, '').split('\n')[0];
    throw new RenderError('failure.render-throw', `${where}render 出错：${msg}`, {
      hint: '页面的 render(t) 抛了异常：用 node engine/render/still.mjs <目录> --frame <帧号> 单独复现',
    });
  } finally {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
  const b64 = res.b64;
  res.b64 = null;
  if (res.faults > 0) {
    throw new RenderError('failure.context-lost', `${where}：WebGL 上下文丢失`, {
      hint: '显存不够、驱动重置（Windows TDR）或页面调用了 loseContext：减少 --workers 或尺寸，查共享 GPU 上的其他任务',
    });
  }
  film.check();
  return Buffer.from(b64, 'base64');
}
