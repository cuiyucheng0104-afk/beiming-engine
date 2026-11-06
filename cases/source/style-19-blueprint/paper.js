// 晒图纸合成器（WebGL2）：纸面在"图纸坐标"里程序化生成（任何缩放都清晰）；
// ink 画布 = 白线曝光（黑 = 纸），fx 画布 R = 投影变暗，B = 红色印章。
const VS = `#version 300 es
in vec2 p; out vec2 uv; void main(){ uv = p*.5+.5; gl_Position = vec4(p,0.,1.); }`;
const FS = `#version 300 es
precision highp float;
in vec2 uv; out vec4 o;
uniform sampler2D ink, fx;
uniform vec2 res, sheet;
uniform vec3 cam;      // cx, cy, zoom
uniform float seed;
float h21(vec2 p){ vec3 q = fract(vec3(p.xyx)*.1031 + seed*.0173); q += dot(q, q.yzx+33.33); return fract((q.x+q.y)*q.z); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.-2.*f);
  return mix(mix(h21(i),h21(i+vec2(1,0)),u.x), mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),u.x), u.y); }
float fbm(vec2 p){ float s = 0., a = .5; for(int i=0;i<5;i++){ s += a*vn(p); p = p*2.03 + 17.1; a *= .5; } return s; }
vec2 toSheet(vec2 s){ return (s - res*.5)/cam.z + cam.xy; }
vec3 paper(vec2 p){
  // 普鲁士蓝：低频起伏 + 横向涂布刷痕 + 由左上到右下轻微褪色
  float n1 = fbm(p/820.), n2 = fbm(vec2(p.x/1700., p.y/64.) + 3.), n3 = fbm(p/210. + 9.);
  vec3 dark = vec3(.082,.180,.392), light = vec3(.157,.333,.635);   // ≈ #152E64 → #2855A2
  float m = clamp(.16 + .9*(n1-.28) + .22*(n2-.5) + .13*(n3-.5) + .14*(p.y/sheet.y) - .08*(p.x/sheet.x), 0., 1.);
  vec3 c = mix(dark, light, m);
  float fib = vn(p*.6)*.5 + vn(p*1.9)*.5;
  c *= .955 + .075*fib;
  float fl = smoothstep(.93, 1., vn(vec2(p.x*.021 + p.y*.066, p.y*.88 - p.x*.31)*.35));
  c = mix(c, c*1.12 + .02, fl*.33);
  // 折痕：竖折 x=2350、横折 y=1000（亮边/暗边 + 沿折线磨白）
  float fx = p.x - 2350. - 6.*(vn(vec2(p.y*.01, 2.))-.5), fy = p.y - sheet.y*.5 - 6.*(vn(vec2(p.x*.01, 5.))-.5);
  float cx = exp(-fx*fx/18.), cy = exp(-fy*fy/18.);
  c *= 1. + .06*sign(fx)*exp(-fx*fx/260.) + .05*sign(fy)*exp(-fy*fy/260.);
  float wear = (cx + cy)*smoothstep(.45, .8, fbm(p/9.));
  c = mix(c, vec3(.52,.64,.81), clamp(wear*.55, 0., .6));
  // 边缘不规则晒白
  float e = min(min(p.x, sheet.x - p.x), min(p.y, sheet.y - p.y));
  float bl = smoothstep(90., 0., e + 70.*(fbm(p/60.)-.5));
  c = mix(c, vec3(.48,.60,.79), bl*.8);
  float cor = smoothstep(240., 0., length(min(p, sheet - p)) + 90.*(fbm(p/40.)-.5));
  c = mix(c, vec3(.56,.67,.83), cor*.5);
  float sp = smoothstep(.985, 1., vn(p/14. + 40.));
  c *= 1. - .18*sp;
  return c;
}
void main(){
  vec2 s = vec2(uv.x, 1.-uv.y)*res;
  vec2 p = toSheet(s);
  vec2 tuv = uv;
  vec4 F = texture(fx, tuv);
  vec4 Fb = textureLod(fx, tuv, 3.);
  float inside = step(0., p.x)*step(p.x, sheet.x)*step(0., p.y)*step(p.y, sheet.y);
  vec3 deskC = vec3(.050,.064,.084) * (.9 + .2*fbm(p/30.));
  vec3 col = deskC;
  vec2 sp2 = p - vec2(12., 18.);
  float shadowIn = step(0., sp2.x)*step(sp2.x, sheet.x)*step(0., sp2.y)*step(sp2.y, sheet.y);
  col *= 1. - .55*shadowIn*(1.-inside);
  if (inside > .5) {
    vec3 pc = paper(p);
    float L0 = texture(ink, tuv).r;
    float L1 = textureLod(ink, tuv, 1.6).r, L2 = textureLod(ink, tuv, 2.8).r;
    float grainK = .80 + .20*smoothstep(.2, .8, vn(p*.9 + 3.));
    float L = clamp(L0*grainK + L1*.18 + L2*.10, 0., 1.);
    vec3 lineC = vec3(.905,.940,.975);
    pc = mix(pc, lineC, L*.96);
    col = pc;
  }
  // 投影（真实物体落在纸上的影子）：线也一起变暗
  col *= 1. - .6*clamp(Fb.r*.45 + F.r*.55, 0., 1.);
  // 红章：橡皮章颗粒与缺墨
  float st = F.b;
  if (st > .001) {
    float holes = smoothstep(.12, .45, vn(p*.45 + 11.)*.6 + fbm(p/6.)*.6);
    vec3 red = vec3(.76,.22,.17);
    col = mix(col, red*(.85 + .2*fbm(p/20.)), clamp(st*holes*1.05, 0., .92));
  }
  vec2 q = uv - .5; col *= 1. - .22*dot(q, q)*2.2;
  o = vec4(col, 1.);
}`;
export function makePaper(canvas, W, H) {
  const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false });
  const sh = (t, s) => { const x = gl.createShader(t); gl.shaderSource(x, s); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)); return x; };
  const pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(pr);
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
  gl.useProgram(pr);
  const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const tex = unit => { const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); return t; };
  const tInk = tex(0), tFx = tex(1);
  const U = n => gl.getUniformLocation(pr, n);
  gl.uniform1i(U('ink'), 0); gl.uniform1i(U('fx'), 1);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  return (inkC, fxC, o) => {
    gl.viewport(0, 0, W, H);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tInk); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, inkC); gl.generateMipmap(gl.TEXTURE_2D);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, tFx); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, fxC); gl.generateMipmap(gl.TEXTURE_2D);
    gl.uniform2f(U('res'), W, H); gl.uniform2f(U('sheet'), o.sheet[0], o.sheet[1]);
    gl.uniform3f(U('cam'), o.cam.x, o.cam.y, o.cam.z); gl.uniform1f(U('seed'), o.seed ?? 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };
}
