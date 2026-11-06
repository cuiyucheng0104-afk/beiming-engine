// 《豹变》D 雾山 · 共用 GLSL：哈希、值噪声、fbm、色彩空间、母题环斑 rosette()
// 全部是坐标的纯函数，没有时间读取；随时间变化的量都由 uniform 传入。
export const GLSL_NOISE = /* glsl */`
uint pcgU(uint v){ uint s = v * 747796405u + 2891336453u; uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
float hI(ivec2 p, uint seed){ return float(pcgU(uint(p.x) + pcgU(uint(p.y) + seed))) * (1.0 / 4294967295.0); }
float hI1(int x, uint seed){ return float(pcgU(uint(x) + pcgU(seed))) * (1.0 / 4294967295.0); }
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float vnoise2(vec2 p){
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3. - 2. * f);
  float a = hash12(i), b = hash12(i + vec2(1., 0.)), c = hash12(i + vec2(0., 1.)), d = hash12(i + vec2(1., 1.));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm2(vec2 p){ float s = 0., a = .5; for (int k = 0; k < 4; k++) { s += a * vnoise2(p); p = p * 2.03 + vec2(1.7, 9.2); a *= .5; } return s / .9375; }
float fbm3o(vec2 p){ float s = 0., a = .5; for (int k = 0; k < 3; k++) { s += a * vnoise2(p); p = p * 2.07 + vec2(5.3, 1.9); a *= .5; } return s / .875; }
float fbm5(vec2 p){ float s = 0., a = .5; for (int k = 0; k < 5; k++) { s += a * vnoise2(p); p = p * 2.01 + vec2(3.1, 7.7); a *= .5; } return s / .96875; }
// 返修 3：整数哈希的值噪声。hash12 是浮点哈希，输入一大（种子偏移几百以上）就会在 GPU 上出现成行的跳变
//   （编译器把 i + vec2(0, 1) 和下一格的 floor(p) 算出不同的舍入，哈希把差异放大），表现为一行行错开的横向"拉丝"。
//   这里格点坐标转成 ivec2 用 PCG 整数哈希，四个角永远一致。新写的云块用它；旧的着色器不动（随机图样不变）。
float vnoise2i(vec2 p){
  vec2 fl = floor(p); ivec2 i = ivec2(fl); vec2 f = p - fl; vec2 u = f * f * (3. - 2. * f);
  float a = hI(i, 7u), b = hI(i + ivec2(1, 0), 7u), c = hI(i + ivec2(0, 1), 7u), d = hI(i + ivec2(1, 1), 7u);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm2i(vec2 p){ float s = 0., a = .5; for (int k = 0; k < 4; k++) { s += a * vnoise2i(p); p = p * 2.03 + vec2(1.7, 9.2); a *= .5; } return s / .9375; }
vec3 srgb2lin(vec3 c){ return mix(c / 12.92, pow((c + .055) / 1.055, vec3(2.4)), step(.04045, c)); }
vec3 lin2srgb(vec3 c){ c = max(c, 0.); return mix(c * 12.92, 1.055 * pow(c, vec3(1. / 2.4)) - .055, step(.0031308, c)); }
float lumS(vec3 c){ return dot(c, vec3(.2126, .7152, .0722)); }
`;

// 母题：墨渍 → 豹斑 → 光斑 共用同一个函数（DESIGN 3.3d）
//   p：以斑心为原点、按半径 R 归一化；seed：种子；crisp 0 湿 / 1 干；ring 0 团 / 1 环；petals 缺口数；ringW 环宽；wob 轮廓起伏；aa 抗锯齿宽
//   角向噪声在单位圆 (cos a, sin a) 上取，a = ±π 处没有接缝
export const GLSL_ROSETTE = /* glsl */`
// 母题环斑（返修 1：不再是"风车"）——豹的环斑是 3–5 块不规则墨块围成的一圈断环：
//   · 缺口是直的径向切口（线宽恒定，不随半径旋转），每个缺口宽窄单独随机（0.10–0.35 rad 当量），边缘带一点毛糙
//   · 缺口位置不均分（±25% 抖动）；每一瓣的内外半径各自 ±13% 抖动，像一块块墨
//   · 约 30% 的斑有两瓣连成 C 形（少一个缺口）；约 10% 的斑有一瓣脱开成独立的小墨团
//   · 湿态（ring = 0）：一整团墨 + 外沿一道潮线（墨干时外圈更深），边比原来利，不是高斯圆盘
vec2 rosette(vec2 p, float seed, float crisp, float ring, float petals, float ringW, float wob, float aa){
  float r = length(p), a = atan(p.y, p.x);
  vec2 u = vec2(cos(a), sin(a));
  // 轮廓：低频大形（不正的圆）+ 中频碎边 + 一点点平面噪声
  float rr = r * (1. + wob * 1.5 * (vnoise2(u * 1.1 + seed * 7.1) - .5) + .12 * (vnoise2(u * 3.3 + seed * 2.3) - .5) + .08 * (vnoise2(p * 3. + seed) - .5));
  float e = mix(.18, .05, crisp) + aa;
  // 环宽沿角度变化：墨团有厚有薄
  float w = ringW * (.65 + .7 * vnoise2(u * 1.7 + seed * 5.3));
  float ro = 1., ri = 1. - w, cut = 1., det = 0., hideRing = 0.;
  if (petals > .5) {
    float N = petals;
    float a0 = hash12(vec2(seed, 1.7)) * 6.2832;
    float rel = mod(a - a0 + 62.832, 6.2832);
    float mergeK = hash12(vec2(seed, 2.9)) < .30 ? 1. + floor(hash12(vec2(seed, 3.7)) * (N - 1.) * .999) : -1.;
    float detK = hash12(vec2(seed, 4.1)) < .10 ? floor(hash12(vec2(seed, 5.3)) * N * .999) : -1.;
    float sector = 0., gPrev = 0., gNext = 6.2832;
    for (int k = 0; k < 5; k++) {
      float fk = float(k);
      if (fk >= N) break;
      if (fk == mergeK) continue;
      float gk = 6.2832 * (fk + (k == 0 ? 0. : (hash12(vec2(seed, 6.1 + fk)) - .5) * .5)) / N;
      if (gk <= rel) { sector = fk; gPrev = gk; } else gNext = min(gNext, gk);
      float dd = abs(atan(sin(rel - gk), cos(rel - gk)));
      float hw = mix(.05, .175, hash12(vec2(seed, 8.3 + fk))) * (1. + .55 * (vnoise2(vec2(r * 6., seed * 3. + fk * 7.)) - .5));
      float lin = dd < 1.5707 ? r * sin(dd) : 9.;
      cut = min(cut, smoothstep(hw - e * .45, hw + e * .45, lin));
    }
    // 每一瓣的内外半径各自抖动
    ro *= .87 + .26 * hash12(vec2(seed + sector * 13.7, 9.1));
    ri *= .87 + .26 * hash12(vec2(seed + sector * 7.3, 2.2));
    // 脱开的一瓣：缩成一枚独立的小墨团
    if (sector == detK) {
      float am = a0 + (gPrev + gNext) * .5;
      vec2 c = vec2(cos(am), sin(am)) * (ri + ro) * .5;
      float rd = .16 + .1 * hash12(vec2(seed, 7.7));
      det = 1. - smoothstep(rd - e * .6, rd + e * .6, length(p - c) * (1. + .2 * (vnoise2(p * 4. + seed) - .5)));
      hideRing = 1.;
    }
  }
  float rg = smoothstep(ri - e, ri + e, rr) * (1. - smoothstep(ro - e, ro + e, rr)) * cut * (1. - hideRing);
  rg = max(rg, det);
  float blob = 1. - smoothstep(.70 - e, 1. + e, rr);
  float tideB = smoothstep(.70, .84, rr) * (1. - smoothstep(.88, .97 + e * .5, rr));
  float wetInk = blob * .55 + tideB * .32 * (1. - crisp * .5);
  float tide = smoothstep(.86, .90, rr) * (1. - smoothstep(.92, .97, rr)) * ring;
  float ink = mix(wetInk, rg, ring) * (1. + .35 * tide);
  float heart = 1. - smoothstep(ri * .78 - .08, ri * .78 + .1, rr + .1 * (vnoise2(u * 2. + seed) - .5));
  return vec2(clamp(ink, 0., 1.), heart);
}
// 柔边光团（S6 光斑）：沿 x 拉长的椭圆，边缘羽化，轮廓有一点不正
float lightBlob(vec2 p, float seed, float soft){
  float r = length(p), a = atan(p.y, p.x);
  vec2 u = vec2(cos(a), sin(a));
  float rr = r * (1. + .22 * (vnoise2(u * 1.3 + seed * 5.1) - .5) + .1 * (vnoise2(u * 3.1 + seed) - .5));
  return 1. - smoothstep(1. - soft, 1. + soft * .2, rr);
}
// 窗光光束的遮罩（设计像素 p；和 post.js 里画光束的是同一组参数）：S6 光斑只出现在光束里
float beamMaskAt(vec2 p, float ang, vec2 O){
  vec2 dir = vec2(cos(ang), sin(ang)), nrm = vec2(-dir.y, dir.x);
  float sx = dot(p - O, nrm), sy = dot(p - O, dir), b = 0.;
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float cen = -260. + fi * 230. + 40. * sin(fi * 2.1);
    float hw = 45. + 85. * hI1(i, 5u);
    b = max(b, (1. - smoothstep(hw * .45, hw * 1.05, abs(sx - cen))) * (.6 + .4 * fbm3o(vec2(sy * .004 + fi * 3.1, sx * .002))));
  }
  return b;
}
// 每枚斑的随机朝向与拉伸（沿毛向略长）：把以斑心为原点的坐标 q 变一下再交给 rosette()
vec2 spotWarp(vec2 q, float seed){ float an = seed * 2.399; float c = cos(an), s = sin(an); q = vec2(c * q.x + s * q.y, -s * q.x + c * q.y); return q * vec2(1., 1.22); }
`;
export const GLSL = GLSL_NOISE + GLSL_ROSETTE;

// 全屏三角形的顶点着色器（后期用）
export const VS_FS = /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }`;
// 普通网格的顶点着色器（带世界坐标）
export const VS_MESH = /* glsl */`
varying vec2 vUv; varying vec3 vW; varying vec3 vNW;
void main(){
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.);
  vW = w.xyz; vNW = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
