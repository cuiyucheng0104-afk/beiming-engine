// 《豹变》A 水墨 · GLSL 公共片段：整数哈希噪声、墨阶查表、雾、母型 R（墨渍 / 湿斑 / 豹斑 / 光斑）
// 全部是坐标的纯函数，没有时间读取以外的状态；屏幕空间噪声一律按 q = gl_FragCoord.xy / K 取，4K 与 1080 一致。

export const NOISE = /* glsl */`
uint pcgh(uint v){ uint s = v * 747796405u + 2891336453u; uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
float h21(ivec2 p, uint seed){ return float(pcgh(uint(p.x) + pcgh(uint(p.y) + seed))) * (1.0 / 4294967295.0); }
float h31(ivec3 p, uint seed){ return float(pcgh(uint(p.x) + pcgh(uint(p.y) + pcgh(uint(p.z) + seed)))) * (1.0 / 4294967295.0); }
float hS(float s, float k){ return float(pcgh(uint(int(s) * 131 + int(k) * 7 + 1013))) * (1.0 / 4294967295.0); }
// 值噪声，返回 [0,1)
float vn2(vec2 x, uint seed){
  vec2 i = floor(x), f = fract(x); ivec2 ii = ivec2(i);
  vec2 u = f * f * f * (f * (f * 6. - 15.) + 10.);
  float a = h21(ii, seed), b = h21(ii + ivec2(1, 0), seed), c = h21(ii + ivec2(0, 1), seed), d = h21(ii + ivec2(1, 1), seed);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float vn3(vec3 x, uint seed){
  vec3 i = floor(x), f = fract(x); ivec3 ii = ivec3(i);
  vec3 u = f * f * (3. - 2. * f);
  float a = h31(ii, seed), b = h31(ii + ivec3(1,0,0), seed), c = h31(ii + ivec3(0,1,0), seed), d = h31(ii + ivec3(1,1,0), seed);
  float e = h31(ii + ivec3(0,0,1), seed), f2 = h31(ii + ivec3(1,0,1), seed), g = h31(ii + ivec3(0,1,1), seed), h = h31(ii + ivec3(1,1,1), seed);
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, f2, u.x), mix(g, h, u.x), u.y), u.z);
}
// fbm，返回约 [-1,1]
float fbm2(vec2 p, uint s){ float a = 0., m = .5; for (int i = 0; i < 4; i++) { a += m * (vn2(p, s + uint(i) * 101u) * 2. - 1.); p = p * 2.03 + vec2(17.1, 9.3); m *= .5; } return a / .9375; }
float fbm3(vec3 p, uint s){ float a = 0., m = .5; for (int i = 0; i < 4; i++) { a += m * (vn3(p, s + uint(i) * 101u) * 2. - 1.); p = p * 2.03 + vec3(17.1, 9.3, 4.7); m *= .5; } return a / .9375; }
float ridged2(vec2 p, uint s){ float a = 0., m = .5; for (int i = 0; i < 3; i++) { float n = 1. - abs(vn2(p, s + uint(i) * 57u) * 2. - 1.); a += m * n * n; p *= 2.1; m *= .5; } return a / .875; }
float ridged3(vec3 p, uint s){ float a = 0., m = .5; for (int i = 0; i < 3; i++) { float n = 1. - abs(vn3(p, s + uint(i) * 57u) * 2. - 1.); a += m * n * n; p *= 2.1; m *= .5; } return a / .875; }
float lum(vec3 c){ return dot(c, vec3(.2126, .7152, .0722)); }
`;

// 墨阶：uPal[0..5] = 纸 清 淡 重 浓 焦（显示空间 sRGB）
export const PALETTE = /* glsl */`
uniform vec3 uPal[6];
uniform float uK;
uniform float uT;
vec3 rampS(float D){                 // 连续墨阶（精灵、底板用）
  D = clamp(D, 0., 1.) * 5.;
  vec3 c = uPal[0];
  c = mix(c, uPal[1], clamp(D, 0., 1.));
  c = mix(c, uPal[2], clamp(D - 1., 0., 1.));
  c = mix(c, uPal[3], clamp(D - 2., 0., 1.));
  c = mix(c, uPal[4], clamp(D - 3., 0., 1.));
  c = mix(c, uPal[5], clamp(D - 4., 0., 1.));
  return c;
}
vec3 rampQ(float D, float w){        // 分阶墨色（3D 水墨材质）：阈值 0.18/0.36/0.54/0.72/0.88，羽化 w
  vec3 c = uPal[0];
  c = mix(c, uPal[1], smoothstep(.18 - w, .18 + w, D));
  c = mix(c, uPal[2], smoothstep(.36 - w, .36 + w, D));
  c = mix(c, uPal[3], smoothstep(.54 - w, .54 + w, D));
  c = mix(c, uPal[4], smoothstep(.72 - w, .72 + w, D));
  c = mix(c, uPal[5], smoothstep(.88 - w, .88 + w, D));
  return c;
}
float inkD(vec3 c){                  // 由颜色反推墨浓（0 = 纸，1 = 焦）
  float lp = lum(uPal[0]), lj = lum(uPal[5]);
  return clamp((lp - lum(c)) / max(lp - lj, 1e-3), 0., 1.);
}
`;

export const FOG = /* glsl */`
uniform vec4 uFogA; uniform vec4 uFogB;
float fogAmt(float dist, float wy){
  if (uFogA.w < .5) return 0.;
  float dens = uFogA.x;
  if (uFogB.y > 0.) dens *= exp(-max(wy - uFogB.x, 0.) / uFogB.y);
  return (1. - exp(-dens * max(dist - uFogA.y, 0.))) * uFogA.z;
}
`;

// 花椰菜边：两级域扭曲 fbm（大瓣 40–80K + 细纤维 2–4K），返回设计像素位移；墨晕、显山、眼孔墨晕共用
export const CAULI = /* glsl */`
float cauliN(vec2 q, float bigAmp, float fineAmp, uint s){
  vec2 w = vec2(fbm2(q / 70., s), fbm2(q / 70. + 5.2, s + 7u)) * 45.;
  float big = fbm2((q + w) / 55., s + 13u) * bigAmp;
  float fine = (fbm2(q / 3., s + 17u) * .45 + fbm2(q / 9., s + 19u) * .55) * fineAmp;
  return big + fine;
}
`;

// 母型 R：rosette(p, R, seed, mode, prog)
//   p 斑心为原点的坐标（任意像素单位），R 定形后的环外半径（同单位）
//   mode 0 墨渍 stain；1 湿斑 wet；2 晕开→收紧的豹斑（2.3 = 落点带溅墨）；3 光斑环；4 小实斑（头、腿、尾）
//   prog 生命期进度：bloom→ring 时 0..1（≥1 定形）；其余模式当"出现程度"
//   返回 vec4(墨覆盖 0..1, 斑心遮罩 0..1, 溅点 0..1, 外圈淡墨晕 0..1)
//   合成一律减色叠墨：D' = 1 − (1 − D底)·(1 − 0.9·墨)，晕再叠一层（湿毛、湿纸上才有）
export const ROSETTE = /* glsl */`
float rsBlob(float r, float ph, float th, float rc, float a, float b, float nz){
  float dp = ph - th; dp = dp - 6.2831853 * floor((dp + 3.1415927) / 6.2831853);
  float u = dp * rc / a, v = (r - rc) / b;
  float e = sqrt(u * u + v * v) + nz;
  float cov = 1. - smoothstep(1. - .22, 1. + .10, e);
  float dens = mix(.75, 1., smoothstep(.30, .92, e));        // 块心 0.75、外沿 1.0（水渍边：墨干时往边上走）
  return cov * dens;
}
float rsGlyph(vec2 p, float R, float s, out float centre, out float outer){
  float n = 4. + step(hS(s, 0.), .6) + step(hS(s, 1.), .3);
  float th0 = 6.2831853 * hS(s, 7.);
  float r = length(p), ph = atan(p.y, p.x);
  float nz = (vn2(p / (.20 * R) + s * 3.7, uint(s) + 5u) - .5) * .50 + (vn2(p / (.08 * R) + s, uint(s) + 9u) - .5) * .22;   // 块形扰动约 ±0.25b
  float g1 = floor(hS(s, 3.) * n), g2 = hS(s, 4.) < .5 ? mod(g1 + 2., n) : -1.;
  float tot = 0.;
  for (int i = 0; i < 6; i++) { if (float(i) >= n) break; tot += (float(i) == g1 || float(i) == g2) ? 1.6 : 1.; }
  float acc = 0., cov = 0., rc = .62 * R;
  for (int i = 0; i < 6; i++) {
    if (float(i) >= n) break;
    float fi = float(i);
    float th = th0 + 6.2831853 * (acc + .5 + .34 * (hS(s, 10. + fi) - .5)) / tot;   // 块的位置不等距
    acc += (fi == g1 || fi == g2) ? 1.6 : 1.;
    if (fi > 2. && hS(s, 60. + fi) < .14) continue;                              // 偶尔少一块：断得更随意
    float a = .42 * R * (.60 + .80 * hS(s, 20. + fi)) * (6. / (n + 1.5)) * .82;     // 块与块大小差 ±40%，允许粘连
    float b = .20 * R * (.62 + .76 * hS(s, 30. + fi));
    float rci = rc * (.86 + .26 * hS(s, 40. + fi));
    cov = max(cov, rsBlob(r, ph, th, rci, a, b, nz));
  }
  centre = 1. - smoothstep(.30 * R, .50 * R, r + nz * .2 * R);
  outer = r - .86 * R + nz * .15 * R;
  return cov;
}
// 溅点：长短不一的泼墨点，椭圆，一端朝落点拖尾
float rsSplash(vec2 p, float R, float s){
  float k = 4. + floor(hS(s, 40.) * 4.), c = 0.;
  for (int i = 0; i < 9; i++) {
    if (float(i) >= k) break;
    float fi = float(i);
    float ang = 6.2831853 * (fi + .8 * hS(s, 50. + fi)) / k, dist = R * (1.05 + 1.0 * hS(s, 60. + fi) * hS(s, 61. + fi));
    float rr = R * (.035 + .065 * hS(s, 70. + fi) * hS(s, 71. + fi));
    vec2 dir = vec2(cos(ang), sin(ang));
    vec2 q = p - dist * dir;
    float u = dot(q, dir), v = dot(q, vec2(-dir.y, dir.x));
    float el = 1.4 + 1.0 * hS(s, 80. + fi);
    float nz = (vn2(q / (rr * .8) + fi * 7.1, uint(s) + 77u) - .5) * .35;
    float body = 1. - smoothstep(.75, 1.1, length(vec2(u / (rr * el), v / rr)) + nz);
    float tl = rr * (3.5 * hS(s, 90. + fi) * hS(s, 91. + fi));
    float tw = rr * .55 * clamp(1. + u / tl, 0., 1.);
    float tail = step(-tl, u) * step(u, 0.) * (1. - smoothstep(tw * .5, tw + .4, abs(v)));
    c = max(c, max(body, tail * .8));
  }
  return c;
}
vec4 rosette(vec2 p, float R, float s, float mode, float prog){
  if (mode < .5) {                                   // 墨渍：指肚上一块淡心浓边的抹痕 + 2–3 道顺指纹的细断纹
    vec2 q = vec2(p.x, p.y * 1.3);
    float nz = (vn2(q / (.30 * R) + s, uint(s) + 3u) - .5) * .30 * R + (vn2(q / (.10 * R) + s * 2., uint(s) + 4u) - .5) * .10 * R;
    float r = length(q) + nz;
    float body = 1. - smoothstep(.78 * R, .98 * R, r);
    float ink = body * (.30 + .62 * smoothstep(.40 * R, .86 * R, r));
    float rr = length(q * vec2(1., 1.15) - vec2(.12 * R, .06 * R));
    float ring = abs(fract(rr / (.21 * R) + .5) - .5) * .21 * R;
    float ang = atan(q.y, q.x);
    float brk = step(.40, vn2(vec2(ang * 2.2, floor(rr / (.21 * R))) + s, uint(s) + 6u));
    float lines = (1. - smoothstep(.022 * R, .055 * R, ring)) * brk * (1. - smoothstep(.66 * R, .78 * R, rr)) * step(.14 * R, rr);
    ink = max(ink, .85 * lines * body);
    vec2 sm = p - vec2(.70 * R, .30 * R);
    float smear = (1. - smoothstep(0., 1., abs(sm.y) / (.18 * R) + max(abs(sm.x) - .35 * R, 0.) / (.35 * R))) * .38 * (.6 + .4 * vn2(p / (.15 * R), uint(s)));
    return vec4(max(ink, smear) * clamp(prog, 0., 1.), 0., 0., 0.);
  }
  if (mode < 1.5) {                                  // 湿斑：没干的墨圈（心浅环深，边软）+ 下方雨淋痕
    float nz = (vn2(p / (.35 * R) + s, uint(s) + 3u) - .5) * .45 * R;
    float r = length(p) + nz;
    float body = 1. - smoothstep(.70 * R, 1.15 * R, r);
    float ringD = mix(.38, .86, smoothstep(.15 * R, .62 * R, r));
    float st = (1. - smoothstep(.12 * R, .40 * R, abs(p.x + .1 * p.y))) * smoothstep(1.7 * R, .3 * R, p.y) * step(0., p.y) * .45;
    float halo = .22 * (1. - smoothstep(.9 * R, 1.6 * R, r));
    float pr = clamp(prog, 0., 1.);
    return vec4(max(body * ringD, st) * pr, 0., 0., halo * pr);
  }
  if (mode < 2.8) {                                  // 晕开→收紧：湿墨先洇开（心浓边淡、前沿深），再收成断环
    // 返修 w3（v3-04）：mode 2.6 = S5 尾迹墨点的"轻"版：晕开峰值 1.15R（原 1.40R）、峰值墨浓 0.6、不带一圈放射溅点（溅点由调用方只画在运动后侧、几帧内淡掉）
    bool gentle = mode > 2.5;
    float pk = gentle ? 1.15 : 1.40;
    float sp = (prog > 0. && mode > 2.15 && !gentle) ? rsSplash(p, R, s) * smoothstep(0., .03, prog) : 0.;
    if (prog <= 0.) return vec4(0.);
    float r = length(p);
    float nzA = (vn2(p / (.20 * R) + s * 1.3, uint(s) + 21u) - .5), nzB = (vn2(p / (.07 * R) + s, uint(s) + 22u) - .5);
    if (prog < .5) {
      float u = prog / .5;
      float Rd = pk * R * (1. - pow(1. - u, 3.));
      float cauli = (.10 + .22 * u) * R * nzA + .08 * R * nzB * u;
      float rr = r + cauli;
      float disc = 1. - smoothstep(Rd - .22 * R, Rd + .05 * R, rr);
      float dens0 = gentle ? .60 : mode > 2.15 ? .95 : .50;
      float dens = dens0 * mix(1., .30, pow(smoothstep(0., Rd + 1e-3, rr), .8) * u);       // 心浓边淡：湿墨往外走越来越淡
      float front = smoothstep(.25, .45, u) * exp(-pow((rr - Rd + .10 * R) / (.10 * R), 2.)) * .42;
      float halo = .24 * u * (1. - smoothstep(Rd, Rd + .35 * R, rr));
      return vec4(clamp(disc * (dens + front), 0., 1.), 0., sp, halo);
    }
    float k = clamp((prog - .5) / .5, 0., 1.); k = k * k * k * (k * (k * 6. - 15.) + 10.);
    float sc = mix(pk, 1.0, k);
    float centre, outer;
    float g = rsGlyph(p / sc, R, s, centre, outer);
    float cauli = .32 * R * nzA * (1. - k) + .08 * R * nzB * (1. - k);
    float rr = r + cauli;
    float disc = (1. - smoothstep(sc * R - .1 * R, sc * R + .05 * R, rr)) * mix(.42, .14, k) * (1. - smoothstep(.55 * R, .8 * R, r) * k);
    float ink = max(mix(disc, g, k), disc);
    ink = max(ink, .20 * centre * k);
    float halo = .26 * (1. - smoothstep(-.04 * R, .55 * R, outer * sc));             // 湿毛上的淡墨洇晕，往外慢慢淡掉
    return vec4(clamp(ink, 0., 1.), centre * k, sp, halo);
  }
  if (mode < 3.5) {                                  // 光斑环（S6 指尖那一圈）：环为淡墨块，心为光
    float centre, outer;
    float g = rsGlyph(p, R, s, centre, outer);
    return vec4(g, centre, 0., 0.) * clamp(prog, 0., 1.);
  }
  float nz = (vn2(p / (.3 * R) + s, uint(s) + 31u) - .5) * .45 * R;   // 小实斑
  float r = length(p) + nz;
  float body = 1. - smoothstep(.55 * R, 1.0 * R, r);
  float pr = clamp(prog, 0., 1.);
  return vec4(body * mix(.82, 1., smoothstep(.2 * R, .8 * R, r)) * pr, 0., 0., .20 * (1. - smoothstep(.8 * R, 1.45 * R, r)) * pr);
}
`;

export const VS_FS = /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }`;
