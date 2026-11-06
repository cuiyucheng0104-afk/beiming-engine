// 宣纸合成器（WebGL2）。
// 图层（都是 1920×1080 的 2D 画布，已按镜头变换画好）：
//   mount 绫绢装裱（普通 alpha）｜img IP 原图（普通 alpha，只在显影遮罩里出现）｜wet 湿墨（渗化 + 积墨）｜dry 干墨（纸纹咬边）
//   col 朱红印与朱字（印泥颗粒）｜over 空中的墨滴（普通 alpha）
// 纸：共用材质 宣纸.png（镜像平铺，锚定在世界坐标上，三段同一张纸），开场用 宣纸_逆光.png 做背光微距。
// 墨滴晕开与画芯显影在着色器里按世界坐标解析计算（扩散前缘 ∝ √t、指状边缘、潮线积墨），不是透明度渐变。
const VS = `#version 300 es
in vec2 p; void main(){ gl_Position = vec4(p,0,1); }`;
const FS = `#version 300 es
precision highp float; out vec4 o;
uniform sampler2D tMount, tImg, tWet, tDry, tCol, tOver, tPaper, tBack;
uniform vec2 res;
uniform vec3 cam;            // 世界坐标 = cam.xy + fc / cam.z
uniform vec2 light;          // x: 背光强度  y: 正面光强度
uniform vec3 gain;           // 纸色校正（把材质均值校到 #F2EBDD）
uniform float bleed, rimK, vig, imgPaper;
uniform vec4 fan;            // 扇心 x,y（世界）, 半径, 开关
uniform vec4 bloom;          // 墨晕前缘半径, 显影前缘半径, 墨量, 潮线淡出
uniform vec4 devR[3];        // 立轴画芯（世界）x0,y0,x1,y1
uniform vec4 devF[3];        // 前缘 y（世界）, 开关, 潮线强度, 种子
float h21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
  return mix(mix(h21(i), h21(i+vec2(1,0)), f.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y); }
float fbm(vec2 p){ float a = 0., w = .5; for(int i=0;i<5;i++){ a += w*vn(p); p = p*2.03 + 17.1; w *= .5; } return a; }
float fiber(vec2 p, float ang){ float c = cos(ang), s = sin(ang); vec2 q = vec2(c*p.x + s*p.y, -s*p.x + c*p.y);
  return smoothstep(.72, .95, vn(vec2(q.x*.03, q.y*.8))); }
const vec3 PAPER = vec3(.949, .922, .867);   // #F2EBDD
// 纸纹横向平铺：两份错开半个周期的采样交叉混合，看不出接缝
vec3 tileTex(sampler2D T, vec2 uv){
  float a = fract(uv.x), k = smoothstep(.06, .2, min(a, 1. - a));
  vec3 A = textureGrad(T, vec2(a, uv.y), dFdx(uv), dFdy(uv)).rgb;
  vec3 Bc = textureGrad(T, vec2(fract(uv.x + .5), uv.y - .15), dFdx(uv), dFdy(uv)).rgb;
  return mix(Bc, A, k);
}
vec3 paperAt(vec2 w){
  vec2 uv = w / vec2(3328., 1856.) + vec2(.5, .21);
  vec3 f = tileTex(tPaper, uv) * gain;
  vec3 b = tileTex(tBack, w * 3. / vec2(3328., 1856.) + vec2(.137, -.33));
  vec3 back = pow(b / vec3(.867, .84, .786), vec3(1.7)) * vec3(.99, .93, .80) * .93;   // 背光透纸：纤维更清楚、偏暖
  return f * light.y + back * light.x;
}
float fibAt(vec2 w){
  vec3 b = tileTex(tBack, w * 3. / vec2(3328., 1856.) + vec2(.137, -.33));
  return clamp((.80 - dot(b, vec3(.333))) / .14, 0., 1.);
}
const vec2 PD[12] = vec2[](vec2(-.326,-.406), vec2(-.840,-.074), vec2(-.696,.457), vec2(-.203,.621), vec2(.962,-.195), vec2(.473,-.480),
  vec2(.519,.767), vec2(.185,-.893), vec2(.507,.064), vec2(.896,.412), vec2(-.322,-.933), vec2(-.792,-.598));
// 墨滴晕开 + 画芯显影（团扇）
// 微距阶段扇面里只有墨和空白绢面；画芯只在"显影"清水推开墨的地方露出（fanCleared），不随墨晕出现。
// 墨晕与显影共用一套带种子的前缘：角向噪声（任何尺度下都是不规则的水口）+ 世界坐标噪声 + 纤维拖拽 + 毛边。
float fanCleared = 1., fanWet = 1.;
float angN(vec2 d, float seed){
  float a = atan(d.y, d.x); vec2 u = vec2(cos(a), sin(a));
  return fbm(u * 2.2 + seed) * .72 + fbm(u * 5.5 + seed * 1.7) * .28;      // 0..1，沿圆周连续
}
float fanInk(vec2 w){
  fanCleared = 1.; fanWet = 1.;
  if (fan.w < .5) return 0.;
  vec2 d = w - fan.xy; float r = length(d), Rf = fan.z;
  if (r > Rf * 1.08) return 0.;
  float clip = 1. - smoothstep(Rf - 1., Rf + 1.2, r);          // 绫边挡住了水和墨
  float fib = fibAt(w);                                          // 纤维把水往前拖
  float n = fbm(w*.035)*.55 + fbm(w*.12 + 7.)*.25;
  float hair = vn(w*.8)*.6 + vn(w*2.1)*.4;
  float R = bloom.x;
  // 小半径时角向噪声占主导（指状、不圆），扩到扇缘时淡出，保证最后正好铺满扇面
  float aw = 1. - smoothstep(Rf*.15, Rf*.95, R);
  float af = 1. + (angN(d - vec2(9., -6.), 3.1) - .5) * .7 * aw;
  // 水晕前缘（浅）与墨心前缘（深）：都按扩散规律长，边缘有指状突出和沿纤维的毛边
  float dnW = r*af*(.80 + .36*n) - fib*R*.12 - hair*R*.035;
  float dnI = r*af*(.84 + .44*n) - fib*R*.05 - hair*R*.02;
  float water = R > .5 ? 1. - smoothstep(R*.9, R, dnW) : 0.;
  float inkc = R > .5 ? 1. - smoothstep(R*.56, R*.74, dnI) : 0.;
  float tideW = R > .5 ? exp(-pow((dnW - R*.93)/(R*.03 + 1.), 2.)) : 0.;
  float tideI = R > .5 ? exp(-pow((dnI - R*.70)/(R*.025 + 1.), 2.)) : 0.;
  float core = exp(-r/(Rf*.16));
  float gran = .86 + .28*vn(w*.9) * vn(w*.31 + 4.);
  float dens = water*.16 + inkc*(.58 + .32*core)*gran + tideW*.16*water + tideI*.22;
  // 显影：清水从一个偏心的不规则水口洇开，把墨推成一圈潮线；前缘同样是角向噪声 + 纤维拖拽 + 毛边，开口不是正圆
  float D = bloom.y;
  vec2 dc = d - vec2(-14., 10.);                                 // 水口略偏离墨心
  float rc = length(dc);
  float awD = 1. - smoothstep(Rf*.2, Rf*.9, D);
  float afD = 1. + (angN(dc, 11.7) - .5) * 1.1 * awD + (vn(dc*.09 + 5.) - .5) * .5 * awD;
  float dd = rc * afD * (.84 + .24*fbm(w*.022 + 3.)) - fib*D*.10 - hair*min(D, 60.)*.06;
  float cl = D > .5 ? 1. - smoothstep(D*.78, D, dd) : 0.;
  float tide = D > .5 ? exp(-pow((dd - D*.93)/(D*.035 + 1.6), 2.)) * (1. - bloom.w) : 0.;
  fanWet = r > Rf + 1.2 ? 1. : water * clip;
  fanCleared = r > Rf + 1.2 ? 1. : cl * clip;
  return (dens * (1. - cl) + tide * .27 * (1. - cl * .5)) * clip * bloom.z;
}
// 立轴画芯自上而下的墨晕显影
float devMask = 1.;
float scrollInk(vec2 w){
  float ink = 0.; devMask = 1.;
  for (int i = 0; i < 3; i++) {
    if (devF[i].y < .5) continue;
    vec4 R = devR[i];
    if (w.x < R.x || w.x > R.z || w.y < R.y || w.y > R.w) continue;
    float s = devF[i].w;
    float off = (fbm(vec2(w.x*.012 + s, 1.3)) - .5) * 70. + (fbm(vec2(w.x*.06 + s*2., 4.1)) - .5) * 26.;
    float y = w.y + off;
    float f = devF[i].x;
    devMask = 1. - smoothstep(f - 10., f + 4., y);
    float band = exp(-pow((f - 6. - y)/16., 2.)) * devF[i].z;
    float damp = exp(-max(0., y - f)/26.) * step(f, y) * .10 * devF[i].z;
    float edgeFade = smoothstep(0., 3., min(min(w.x - R.x, R.z - w.x), min(w.y - R.y, R.w - w.y)));
    ink += (band * .5 + damp) * edgeFade;
  }
  return ink;
}
float inkD(vec2 fc, vec2 w){
  float Rb = bleed * cam.z;
  vec2 disp = vec2(fbm(w*.03), fbm(w*.03 + 31.)) - .5;
  vec2 feather = vec2(vn(w*.6), vn(w*.6 + 7.)) - .5;
  vec2 q = fc + disp * Rb * 1.1 + feather * Rb * .35;
  float a = 0., b = 0.;
  for (int i = 0; i < 12; i++) {
    a += texture(tWet, (q + PD[i] * Rb * .5) / res).a;
    b += texture(tWet, (q + PD[i] * Rb * 1.35) / res).a;
  }
  a /= 12.; b /= 12.;
  float s0 = texture(tWet, q / res).a;
  float edge = max(0., a - b);
  float g1 = vn(w*.9), g2 = fbm(w*.15);
  float wet = mix(s0, a, .72) * (.86 + .22*g2) + edge * rimK * (.8 + .5*g1) + b * .10;
  vec2 j = vec2(vn(w*1.9), vn(w*1.9 + 5.)) - .5;
  float dry = texture(tDry, (fc + j * 1.4 * min(cam.z, 2.)) / res).a;
  float tooth = smoothstep(.62, .9, vn(w*1.4 + 3.)) * .4;
  dry *= 1. - tooth * (1. - dry*.55);
  return clamp(1. - (1. - clamp(wet,0.,1.)) * (1. - clamp(dry,0.,1.)), 0., 1.);
}
vec3 inkCol(float D){ return mix(vec3(.50,.52,.55), vec3(.072,.066,.06), smoothstep(.0, .85, D)); }
void main(){
  vec2 fc = gl_FragCoord.xy; fc.y = res.y - fc.y;
  vec2 uvS = fc / res;
  vec2 w = cam.xy + fc / cam.z;
  vec3 pc = paperAt(w);
  vec3 pv = pc / max(PAPER * max(light.y, .001), vec3(.001));   // 纸纹相对起伏
  vec3 c = pc;
  float fi = fanInk(w);
  float si = scrollInk(w);
  // 绫绢装裱（团扇绢面只在水洇到的地方露出；背光时绢面也被透光染暖）
  vec4 M = texture(tMount, uvS);
  vec3 lk = vec3(light.y) + light.x * vec3(.92, .84, .70);
  c = mix(c, M.rgb * lk * mix(vec3(1.), clamp(pv, .8, 1.2), .25), M.a * fanWet);
  // IP 原图：只做遮罩显影，像素不改（纸纹叠加 ≤ imgPaper）
  vec4 I = texture(tImg, uvS);
  float ia = I.a * fanCleared * devMask;
  c = mix(c, I.rgb * mix(vec3(1.), clamp(pv, .85, 1.15), imgPaper), ia);
  // 墨
  float D = inkD(fc, w);
  D = 1. - (1. - D) * (1. - clamp(fi, 0., 1.)) * (1. - clamp(si, 0., 1.));
  c *= mix(vec3(1.), inkCol(D), clamp(D*1.05, 0., 1.));
  // 朱红：印泥颗粒不匀
  vec4 C = texture(tCol, uvS);
  float sp = smoothstep(.2, .5, vn(w*1.6 + 11.)) * .22 + .78;
  float sp2 = smoothstep(.55, .75, vn(w*4.3 + 2.)) * .35;
  c = mix(c, C.rgb * mix(vec3(1.), clamp(pv, .85, 1.15), .5) * (1. - sp2*.25), C.a * sp);
  // 空中的墨滴
  vec4 O = texture(tOver, uvS);
  c = mix(c, O.rgb, O.a);
  vec2 uv = uvS - .5;
  c *= 1. - vig * dot(uv*vec2(1.,.9), uv*vec2(1.,.9)) * 1.2;
  o = vec4(clamp(c, 0., 1.), 1.);
}`;

export function makeComp(canvas, paperImg, backImg) {
  const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false });
  if (!gl) throw new Error('no webgl2');
  const sh = (t, s) => { const x = gl.createShader(t); gl.shaderSource(x, s); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)); return x; };
  const pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(pr);
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
  gl.useProgram(pr);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const U = n => gl.getUniformLocation(pr, n);
  const names = ['tMount', 'tImg', 'tWet', 'tDry', 'tCol', 'tOver', 'tPaper', 'tBack'];
  const tex = names.map((n, i) => {
    const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, t);
    const big = i >= 6;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, big ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const wr = big ? gl.MIRRORED_REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wr); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wr);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    gl.uniform1i(U(n), i); return t;
  });
  const upBig = (i, im) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, tex[i]); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im); gl.generateMipmap(gl.TEXTURE_2D); };
  upBig(6, paperImg); upBig(7, backImg);
  const up = (i, cv) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, tex[i]); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv); };
  const W = canvas.width, H = canvas.height;
  return function composite(Ls, o) {
    gl.viewport(0, 0, W, H);
    up(0, Ls.mount); up(1, Ls.img); up(2, Ls.wet); up(3, Ls.dry); up(4, Ls.col); up(5, Ls.over);
    gl.uniform2f(U('res'), W, H);
    gl.uniform3f(U('cam'), o.cam[0], o.cam[1], o.cam[2]);
    gl.uniform2f(U('light'), o.light[0], o.light[1]);
    gl.uniform3f(U('gain'), 1.011, 1.002, .983);
    gl.uniform1f(U('bleed'), o.bleed ?? 4.5); gl.uniform1f(U('rimK'), o.rim ?? .85);
    gl.uniform1f(U('vig'), o.vig ?? .16); gl.uniform1f(U('imgPaper'), .10);
    gl.uniform4fv(U('fan'), o.fan || [0, 0, 1, 0]);
    gl.uniform4fv(U('bloom'), o.bloom || [0, 0, 0, 0]);
    const dr = new Float32Array(12), df = new Float32Array(12);
    (o.dev || []).slice(0, 3).forEach((d, i) => { dr.set(d.rect, i * 4); df.set([d.front, 1, d.band, d.seed], i * 4); });
    gl.uniform4fv(U('devR'), dr); gl.uniform4fv(U('devF'), df);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
}

export function layers(W = 1920, H = 1080) {
  const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
  const L = { mount: mk(), img: mk(), wet: mk(), dry: mk(), col: mk(), over: mk(), W, H };
  L.c = {}; for (const k of ['mount', 'img', 'wet', 'dry', 'col', 'over']) L.c[k] = L[k].getContext('2d');
  L.ink = { wet: L.c.wet, dry: L.c.dry, col: L.c.col };
  L.clear = () => { for (const k in L.c) { const c = L.c[k]; c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = 1; c.globalCompositeOperation = 'source-over'; c.clearRect(0, 0, W, H); } };
  L.xf = (z, ox, oy) => { for (const k in L.c) L.c[k].setTransform(z, 0, 0, z, ox, oy); };
  return L;
}
