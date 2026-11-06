// 画面层（WebGL2）：图版（plate）贴图 + 深度视差推镜 + 水墨过渡，最后一道印刷/镜片后期把 2D 叠层合上去。
// 坐标约定（全片统一，见 ARCH.md §3）：
//   屏幕坐标：1920×1080 像素，原点左上。
//   图坐标：原图 1920×1080 像素（刻线贴图是 2× 的 3840×2160，但一律按 1× 图坐标写）。
//   相机 cam = { cx, cy, zoom, sx, sy, push, depth }：
//     cx,cy  屏幕中心对准的图坐标（默认 960,540）；zoom 1 = 整图正好铺满；
//     sx,sy  深度=1 处的屏幕视差位移（像素；近景最大约 58px = 画宽 3%）；
//     push   深度=1 处额外放大比例（推镜时近景比远景放大得快）；depth 深度强度倍数（默认 1）。
//   投影：screen = (I − C)·s(w) + shift·w + 屏幕中心，s(w) = zoom·(1 + push·w)·(1 + ha·bump(I))，w = depth·D(I)（ha 默认 0，见 normCam）。
//   着色器做反向迭代（3 次）求每个屏幕像素对应的图坐标，刻线是贴图里的，所以线条锚在画面上随推镜走。
import { hash } from '/core/lib.js';

export const W = 1920, H = 1080;
export const INK = [22 / 255, 23 / 255, 27 / 255], PAPER = [237 / 255, 229 / 255, 205 / 255];

const VS = `#version 300 es
in vec2 aP; out vec2 vUv;
void main(){ vUv = aP*0.5+0.5; gl_Position = vec4(aP,0.,1.); }`;

// —— 图版着色器 ——
const FS_PLATE = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uTex, uDepth;
uniform vec2 uC; uniform float uZoom, uPush, uDepthAmt; uniform vec2 uShift;
uniform vec4 uBump;   // 局部隆起（S18 新增，向后兼容）：xy 中心(图坐标) z 半径 w 强度；w=0 时完全不起作用
uniform float uAlpha; uniform int uSS; uniform float uLod;
uniform vec4 uBlob;   // x 墨块混合(0=原图 1=墨块) y 墨块取样 lod z 阈值 w 软边
uniform vec4 uMask;   // x 进度(<-5 关闭) y 噪声尺度 z 软边 w 种子
uniform vec4 uMask2;  // x 反向 y 径向偏置 z,w 偏置中心(图坐标 0..1)
uniform float uRim;   // 遮罩边缘墨晕强度
uniform vec3 uInk, uPaper;
uniform vec4 uTone;   // x 亮度乘 y 去饱和(0..1) z 墨色压暗 w 保留
float h21(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }
float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),f.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x), f.y); }
float fbm(vec2 p){ float a=.5, s=0.; for(int k=0;k<5;k++){ s+=a*vn(p); p=p*2.03+17.1; a*=.5; } return s; }
vec2 toImg(vec2 Q){
  vec2 I = uC + Q/uZoom;
  for(int k=0;k<3;k++){
    float D = texture(uDepth, clamp(I/vec2(1920.,1080.),0.,1.)).r;
    float w = uDepthAmt * D;
    float s = uZoom*(1.+uPush*w);
    if(uBump.w != 0.){ vec2 b = (I-uBump.xy)/uBump.z; s *= 1. + uBump.w*exp(-dot(b,b))*(1.-smoothstep(.62,.82,D)); }
    I = uC + (Q - uShift*w)/s;
  }
  return I;
}
vec4 sampleAt(vec2 I){
  vec2 uv = clamp(I/vec2(1920.,1080.), vec2(0.0002), vec2(0.9998));
  vec3 c = textureLod(uTex, uv, uLod).rgb;
  if(uBlob.x > 0.){
    // 墨块取样：在 lod-1 上取 9 点圆形平均，避免低层 mipmap 的方块感
    float R = exp2(uBlob.y)*.9;
    vec3 b = textureLod(uTex, uv, uBlob.y-1.).rgb;
    for(int k=0;k<8;k++){ float an = float(k)*.785398 + .3; b += textureLod(uTex, clamp((I+R*vec2(cos(an),sin(an)))/vec2(1920.,1080.),0.,1.), uBlob.y-1.).rgb; }
    b /= 9.;
    float L = dot(b, vec3(.3,.59,.11));
    float n = fbm(I/90.+uMask.w)*.12 - .06;
    float ink = smoothstep(uBlob.z-uBlob.w, uBlob.z+uBlob.w, 1.-L+n);
    // 墨块模式：墨处上墨、其余透明（露出下层的纸）
    vec4 blob = vec4(mix(uPaper,uInk,ink), ink);
    return mix(vec4(c,1.), blob, uBlob.x);
  }
  return vec4(c,1.);
}
void main(){
  vec2 P = vec2(gl_FragCoord.x, 1080.-gl_FragCoord.y);
  vec4 acc = vec4(0.); vec2 Ic = vec2(0.);
  if(uSS==2){
    for(int j=0;j<2;j++) for(int i=0;i<2;i++){
      vec2 I = toImg(P + vec2(float(i)-.5, float(j)-.5)*.5 - vec2(960.,540.));
      acc += sampleAt(I); Ic += I;
    }
    acc *= .25; Ic *= .25;
  } else { Ic = toImg(P - vec2(960.,540.)); acc = sampleAt(Ic); }
  vec3 col = acc.rgb; float a = acc.a;
  // 色调：亮度、去饱和、墨压暗（闪回水墨图用来压成墨与宣纸的调子）
  float L = dot(col, vec3(.3,.59,.11));
  col = mix(col, vec3(L), uTone.y) * uTone.x;
  col = mix(col, uInk, uTone.z*(1.-L));
  // 溶解遮罩：噪声锚在图坐标上（墨跟着画走），可加径向偏置让边缘先化
  if(uMask.x > -5.){
    vec2 u = Ic/vec2(1920.,1080.);
    float n = fbm(Ic/uMask.y + uMask.w*7.31);
    n = n*.9 + .1*h21(floor(Ic/3.)+uMask.w);         // 一点颗粒，像纸吃墨
    n += uMask2.y * (length((u-uMask2.zw)*vec2(1.78,1.)) - .45);
    float v = smoothstep(uMask.x-uMask.z, uMask.x+uMask.z, n);
    if(uMask2.x > .5) v = 1.-v;
    float rim = 1.-abs(v*2.-1.);
    col = mix(col, uInk, rim*uRim*a);
    a *= v;
  }
  a *= uAlpha;
  o = vec4(col*a, a);   // 预乘
}`;

// —— 终合成：印刷呼吸 + 纸纹 + 失焦 + 镜片干扰 + 2D 叠层 ——
const FS_FINAL = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uScene, uPaper, uOver, uPrev;
uniform float uT, uBlur, uGlitch, uPrint, uPaperAmt, uVig, uOverBlur;
uniform vec3 uInk;
float h21(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }
float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),f.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x), f.y); }
void main(){
  vec2 uv = vec2(vUv.x, 1.-vUv.y);           // 屏幕坐标（上为 0）
  float tq = floor(uT*12.)/12.;              // 印刷呼吸按 12 Hz 步进
  vec2 g = vec2(0.);
  if(uGlitch > 0.){                          // 镜片干扰：行错位 + 错色 + 扫描线
    float row = floor(uv.y*1080./6.);
    float k = step(1.-uGlitch*.35, h21(vec2(row, floor(uT*30.))));
    g.x = (h21(vec2(row*3.1, floor(uT*30.)))-.5)*.06*k*uGlitch;
  }
  float ca = uGlitch*.006;
  vec3 c;
  c.r = textureLod(uScene, vec2(uv.x+g.x+ca, 1.-uv.y), uBlur).r;
  c.g = textureLod(uScene, vec2(uv.x+g.x, 1.-uv.y), uBlur).g;
  c.b = textureLod(uScene, vec2(uv.x+g.x-ca, 1.-uv.y), uBlur).b;
  // 纸纹（屏幕空间，与 printfx.py 同法：0.9 + 0.1·纸纹/均值）
  vec3 pt = texture(uPaper, uv).rgb; float pl = dot(pt, vec3(.333));
  c *= mix(1., .9 + .1*pl/.82, uPaperAmt);
  // 墨色里的斑驳 + 12Hz 轻微明暗呼吸
  float L = dot(c, vec3(.3,.59,.11));
  float mot = vn(uv*vec2(260.,146.) + tq*11.3)*vn(uv*vec2(37.,21.) - tq*3.1);
  c += uPrint*(1.-smoothstep(.1,.35,L))*(mot-.25)*.06;
  c *= 1. + uPrint*(h21(vec2(tq,1.7))-.5)*.025;
  // 轻暗角
  vec2 d = (uv-.5)*vec2(1.,.75); c *= 1. - uVig*smoothstep(.25,.75,length(d));
  // 2D 叠层（雨、镜片、界面、字幕），已预乘
  vec4 ov = texture(uOver, vec2(uv.x+g.x, uv.y));
  if(uGlitch > 0.){ ov.r = texture(uOver, vec2(uv.x+g.x+ca*1.5, uv.y)).r; ov.b = texture(uOver, vec2(uv.x+g.x-ca*1.5, uv.y)).b; }
  c = c*(1.-ov.a) + ov.rgb;
  if(uGlitch > 0.) c *= 1. - uGlitch*.18*step(.5, fract(uv.y*1080./3.));
  o = vec4(clamp(c,0.,1.), 1.);
}`;

export function createGL(canvas) {
  const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true, premultipliedAlpha: false });
  if (!gl) throw new Error('需要 WebGL2');
  const mk = (src, type) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const prog = fs => { const p = gl.createProgram(); gl.attachShader(p, mk(VS, gl.VERTEX_SHADER)); gl.attachShader(p, mk(fs, gl.FRAGMENT_SHADER)); gl.bindAttribLocation(p, 0, 'aP'); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p)); const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const nm = gl.getActiveUniform(p, i).name; u[nm] = gl.getUniformLocation(p, nm); } return { p, u }; };
  const plate = prog(FS_PLATE), fin = prog(FS_FINAL);
  const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  // 场景帧缓冲（带 mipmap，给失焦用）
  const sceneTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, sceneTex);
  gl.texStorage2D(gl.TEXTURE_2D, 6, gl.RGBA8, W, H);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, sceneTex, 0);
  const overTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, overTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  function upload(bmp, mip = true) {
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (mip) gl.generateMipmap(gl.TEXTURE_2D);
    return t;
  }
  function beginScene(clear) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.viewport(0, 0, W, H);
    gl.clearColor(clear[0], clear[1], clear[2], 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }
  function drawPlate(tex, depth, o) {
    const u = plate.u; gl.useProgram(plate.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(u.uTex, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, depth); gl.uniform1i(u.uDepth, 1);
    const c = o.cam;
    gl.uniform2f(u.uC, c.cx, c.cy); gl.uniform1f(u.uZoom, c.zoom); gl.uniform1f(u.uPush, c.push); gl.uniform1f(u.uDepthAmt, c.depth);
    gl.uniform2f(u.uShift, c.sx, c.sy); gl.uniform4f(u.uBump, c.hx, c.hy, c.hr, c.ha); gl.uniform1f(u.uAlpha, o.alpha); gl.uniform1i(u.uSS, o.ss); gl.uniform1f(u.uLod, o.lod);
    const b = o.blob; gl.uniform4f(u.uBlob, b ? b.mix ?? 1 : 0, b ? b.lod ?? 5 : 0, b ? b.th ?? .6 : 0, b ? b.soft ?? .06 : 0);
    const m = o.mask; gl.uniform4f(u.uMask, m ? m.p : -9, m ? m.scale ?? 160 : 1, m ? m.soft ?? .05 : 0, m ? m.seed ?? 1 : 0);
    gl.uniform4f(u.uMask2, m && m.invert ? 1 : 0, m ? m.radial ?? 0 : 0, m && m.center ? m.center[0] / W : .5, m && m.center ? m.center[1] / H : .5);
    gl.uniform1f(u.uRim, m ? m.rim ?? 0 : 0);
    gl.uniform3fv(u.uInk, INK); gl.uniform3fv(u.uPaper, PAPER);
    const t = o.tone || {}; gl.uniform4f(u.uTone, t.gain ?? 1, t.desat ?? 0, t.inkDark ?? 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  function finish(paperTex, overCanvas, post, t) {
    gl.bindTexture(gl.TEXTURE_2D, sceneTex); gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindTexture(gl.TEXTURE_2D, overTex); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, overCanvas); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H); gl.disable(gl.BLEND);
    const u = fin.u; gl.useProgram(fin.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, sceneTex); gl.uniform1i(u.uScene, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, paperTex); gl.uniform1i(u.uPaper, 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, overTex); gl.uniform1i(u.uOver, 2);
    gl.uniform1f(u.uT, t); gl.uniform1f(u.uBlur, post.blur); gl.uniform1f(u.uGlitch, post.glitch); gl.uniform1f(u.uPrint, post.print);
    gl.uniform1f(u.uPaperAmt, post.paper); gl.uniform1f(u.uVig, post.vig); gl.uniform3fv(u.uInk, INK);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  return { gl, upload, beginScene, drawPlate, finish };
}

// —— 世界↔屏幕（CPU 端，同一套公式；任何跟着画面走的界面元素都用它） ——
export function normCam(c = {}) {
  // hx,hy,hr,ha：局部隆起（S18 新增）。图坐标 (hx,hy) 附近半径 hr 内额外放大 ha（高斯衰减，近景深度 >0.62 处渐不受影响），
  // 用来让龙头单独"逼近"；ha 默认 0 = 与原来逐像素一致
  return { cx: c.cx ?? 960, cy: c.cy ?? 540, zoom: c.zoom ?? 1, sx: c.sx ?? 0, sy: c.sy ?? 0, push: c.push ?? 0, depth: c.depth ?? 1,
    hx: c.hx ?? 960, hy: c.hy ?? 540, hr: c.hr ?? 300, ha: c.ha ?? 0 };
}
export function camLerp(a, b, k) {
  a = normCam(a); b = normCam(b); const o = {};
  for (const key in a) o[key] = a[key] + (b[key] - a[key]) * k;
  // zoom 按对数插值，推镜速度均匀
  o.zoom = Math.exp(Math.log(a.zoom) + (Math.log(b.zoom) - Math.log(a.zoom)) * k);
  return o;
}
export { hash };
