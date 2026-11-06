// 宣纸合成器（WebGL2）：base = 已画好的彩色画面（纸/墙/红纸/布/图），wet/dry = 墨的两层（只用 alpha）。
// 湿墨层：带噪声位移的盘形采样 → 洇；小半径与大半径之差 → 边缘积墨；干墨层：纸纤维抖动 + 纸齿咬边。
// 墨按"不透明度乘到纸上"上色（墨分五色由 alpha 决定），不是盖一层灰。最后：压印微推、暗角、暖色。
const VS = `#version 300 es
in vec2 p; void main(){ gl_Position = vec4(p,0,1); }`;
const FS = `#version 300 es
precision highp float; out vec4 o;
uniform sampler2D base, wet, dry;
uniform vec2 res; uniform float camx; uniform float zoom; uniform vec2 zc; uniform float vig, warm, bleed, rim;
float h21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
  return mix(mix(h21(i), h21(i+vec2(1,0)), f.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y); }
float fbm(vec2 p){ float a = 0., w = .5; for(int i=0;i<4;i++){ a += w*vn(p); p = p*2.03 + 17.1; w *= .5; } return a; }
const vec2 PD[12] = vec2[](vec2(-.326,-.406), vec2(-.840,-.074), vec2(-.696,.457), vec2(-.203,.621), vec2(.962,-.195), vec2(.473,-.480),
  vec2(.519,.767), vec2(.185,-.893), vec2(.507,.064), vec2(.896,.412), vec2(-.322,-.933), vec2(-.792,-.598));
vec2 T(vec2 fc){ return vec2(fc.x, res.y - fc.y) / res; }   // 2D canvas 是 y 向下
void main(){
  vec2 fc = gl_FragCoord.xy;
  fc = zc + (fc - zc) / zoom;                       // 压印时的微推
  vec2 w = vec2(fc.x + camx, res.y - fc.y);         // 世界锚定的噪声坐标
  vec3 B = texture(base, T(fc)).rgb;
  // 湿墨：洇 + 积墨
  vec2 disp = vec2(fbm(w*.012), fbm(w*.012 + 31.)) - .5;
  vec2 fe = vec2(vn(w*.21), vn(w*.21 + 7.)) - .5;
  vec2 q = fc + disp * bleed * 1.1 + fe * bleed * .35;
  float a = 0., b2 = 0.;
  for (int i = 0; i < 12; i++) {
    a  += texture(wet, T(q + PD[i] * bleed * .5)).a;
    b2 += texture(wet, T(q + PD[i] * bleed * 1.4)).a;
  }
  a /= 12.; b2 /= 12.;
  float s0 = texture(wet, T(q)).a;
  float edge = max(0., a - b2);
  float g1 = vn(w*.35), g2 = fbm(w*.06);
  float wetD = mix(s0, a, .7) * (.86 + .22*g2) + edge * rim * (.8 + .5*g1) + b2 * .08;
  // 干墨：纤维抖动 + 纸齿
  vec2 j = vec2(vn(w*.7), vn(w*.7 + 5.)) - .5;
  float dryD = texture(dry, T(fc + j * 1.4)).a;
  float tooth = smoothstep(.62, .9, vn(w*.55 + 3.)) * .4;
  dryD *= 1. - tooth * (1. - dryD*.5);
  float D = clamp(1. - (1. - clamp(wetD,0.,1.)) * (1. - clamp(dryD,0.,1.)), 0., 1.);
  vec3 ink = mix(vec3(.50,.53,.56), vec3(.070,.064,.060), smoothstep(.0, .85, D));
  vec3 c = B * mix(vec3(1.), ink, clamp(D*1.05, 0., 1.));
  vec2 uv = gl_FragCoord.xy / res - .5;
  c *= 1. - vig * dot(uv*vec2(1.,.9), uv*vec2(1.,.9)) * 1.2;
  c = mix(c, c * vec3(1.02, .995, .955), warm);
  o = vec4(clamp(c, 0., 1.), 1.);
}`;

export function makeComp(canvas) {
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
  const tex = ['base', 'wet', 'dry'].map((n, i) => {
    const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(U(n), i); return t;
  });
  const up = (i, cv) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, tex[i]); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv); };
  const W = canvas.width, H = canvas.height;
  return function composite(base, wet, dry, o = {}) {
    gl.viewport(0, 0, W, H);
    up(0, base); up(1, wet); up(2, dry);
    gl.uniform2f(U('res'), W, H);
    gl.uniform1f(U('camx'), o.camx ?? 0);
    gl.uniform1f(U('zoom'), o.zoom ?? 1);
    gl.uniform2f(U('zc'), (o.zc ?? [W / 2, H / 2])[0], H - (o.zc ?? [W / 2, H / 2])[1]);
    gl.uniform1f(U('vig'), o.vig ?? .16); gl.uniform1f(U('warm'), o.warm ?? .35);
    gl.uniform1f(U('bleed'), o.bleed ?? 5); gl.uniform1f(U('rim'), o.rim ?? .8);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
}
