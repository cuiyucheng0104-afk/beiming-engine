// All inputs are scene-linear, with the first row at the lower edge (WebGL UV).
// Visibility and its bilateral depth guide share a half-resolution RG pair.
const saturate = x => Math.min(1, Math.max(0, x));
const hermite = t => { t = saturate(t); return t * t * (3 - 2 * t); };
const f32 = Math.fround;
const half = Math.f16round ?? (x => {
  if (x === 0) return x;
  const q = 2 ** Math.max(-24, Math.floor(Math.log2(Math.abs(x))) - 10);
  const v = x / q, a = Math.floor(v), r = v - a;
  return (r === 0.5 ? a + (a & 1) : Math.round(v)) * q;
});
const sizeHalf = n => Math.max(2, Math.floor(n / 2));
const bands = [0.30, 0.22, 0.10, 0.03];

function projection(camera, width, height) {
  const { near, far } = camera;
  const m = camera.projectionMatrix?.elements ?? camera.projectionMatrix;
  const y = m ? 1 / m[5] : Math.tan(camera.fov * Math.PI / 360);
  const x = m ? 1 / m[0] : y * (camera.aspect ?? width / height);
  if (![near, far, x, y].every(Number.isFinite) || !(near > 0 && far > near && x > 0 && y > 0) || camera.isOrthographicCamera) {
    throw new RangeError('AO requires a finite perspective projection and 0 < near < far');
  }
  return { near, far, x, y };
}
function controls({ enabled = true, radius = 1, bias = 0.03, samples = 12 }) {
  if (typeof enabled !== 'boolean' || !Number.isFinite(radius) || radius < 0.01 || radius > 10 ||
      !Number.isFinite(bias) || bias < 0 || bias > 2 || !Number.isInteger(samples) || samples < 1 || samples > 32) {
    throw new RangeError('Invalid AO enabled, radius, bias or samples');
  }
  return { enabled, radius, bias, samples };
}
function check(strength, encoding, w, h) {
  if (!(Number.isFinite(strength) && strength >= 0 && strength <= 1)) throw new RangeError('AO strength must be in [0,1]');
  if (!['linear-meters', 'device'].includes(encoding)) throw new RangeError('Unknown AO depth encoding');
  if (![w, h].every(n => Number.isInteger(n) && n > 0)) throw new RangeError('AO requires positive integer dimensions');
}

// Bilinear clamp-to-edge in pixel-centre coordinates. The depth input itself is
// nearest sampled; only the half-resolution visibility/guide use interpolation.
function bilinear(data, w, h, x, y, channel) {
  x = Math.max(0, Math.min(w - 1, x)); y = Math.max(0, Math.min(h - 1, y));
  const i = Math.floor(x), j = Math.floor(y), a = (j * w + i) * 2 + channel;
  const dx = i + 1 < w ? 2 : 0, dy = j + 1 < h ? w * 2 : 0;
  const fx = x - i, fy = y - j;
  const low = data[a] + (data[a + dx] - data[a]) * fx;
  const high = data[a + dy] + (data[a + dx + dy] - data[a + dy]) * fx;
  return low + (high - low) * fy;
}
function blur(input, w, h, dx, dy) {
  const out = new Float32Array(input.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = 2 * (y * w + x), guide = input[i + 1];
    let total = bands[0], sum = total * input[i];
    for (let j = -3; j <= 3; j++) {
      if (j === 0) continue;
      const u = x + 1.35 * j * dx, v = y + 1.35 * j * dy;
      if (Math.abs(guide - bilinear(input, w, h, u, v, 1)) > guide * 0.035 + 1e-7) continue;
      const weight = bands[Math.abs(j)];
      sum += weight * bilinear(input, w, h, u, v, 0); total += weight;
    }
    out[i] = half(sum / total); out[i + 1] = guide;
  }
  return out;
}

/** CPU replay. Color: RGBA, depth: R; middle layers: RG. All arrays are float. */
export function applyAO(args) {
  const { width, height, color, depth, camera, depthEncoding = 'linear-meters', strength = 0.9 } = args;
  const { enabled, radius: scale, bias, samples } = controls(args);
  check(strength, depthEncoding, width, height);
  if (depth.length !== width * height || color.length !== depth.length * 4) throw new RangeError('AO layer sizes disagree');
  const { near, far, x: ipx, y: ipy } = projection(camera, width, height);
  const w = sizeHalf(width), h = sizeHalf(height), raw = new Float32Array(2 * w * h);
  const meter = depthEncoding === 'linear-meters';
  const idx = (u, v) => Math.min(height - 1, Math.max(0, Math.floor(v * height))) * width + Math.min(width - 1, Math.max(0, Math.floor(u * width)));
  const meters = d => meter ? (d > 0 ? d : far) : near * far / (far - d * (far - near));
  const at = (u, v) => meters(depth[idx(u, v)]);
  const fract = x => x - Math.floor(x);
  const tau = 2 * Math.PI;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = (x + 0.5) / w, v = (y + 0.5) / h, i = (y * w + x) * 2;
    const d = depth[idx(u, v)], z = meters(d);
    const guide = meter ? saturate(near * (far / z - 1) / (far - near)) : 1 - d;
    if (guide <= 1e-5) { raw[i] = 1; continue; }
    raw[i + 1] = half(guide);
    const sx = (u * 2 - 1) * ipx, sy = (v * 2 - 1) * ipy;
    const east = at(u + 1 / w, v), west = at(u - 1 / w, v);
    const north = at(u, v + 1 / h), south = at(u, v - 1 / h);
    const ex = Math.abs(east - z) < Math.abs(west - z), ny = Math.abs(north - z) < Math.abs(south - z);
    const zx = ex ? east : west, zy = ny ? north : south;
    const dzx = ex ? zx - z : z - zx, dzy = ny ? zy - z : z - zy;
    const xx = sx * dzx + 2 * ipx * zx / w, xy = sy * dzx, xz = -dzx;
    const yx = sx * dzy, yy = sy * dzy + 2 * ipy * zy / h, yz = -dzy;
    const nx = xy * yz - xz * yy, nn = xz * yx - xx * yz, nz = xx * yy - xy * yx;
    const len = Math.hypot(nx, nn, nz);
    const radius = scale * Math.max(0.5, Math.min(5, z * 0.035)), r2 = radius * radius;
    const noise = fract(f32(52.9829189 * fract(f32(f32((x + 0.5) * 0.06711056) + f32((y + 0.5) * 0.00583715)))));
    let occ = 0;
    for (let j = 0; j < samples; j++) {
      const t = (j + 0.5) / samples, angle = tau * (noise + t * 3.7);
      const step = radius * Math.sqrt(t) / (2 * z);
      const du = Math.cos(angle) * step / ipx, dv = Math.sin(angle) * step / ipy;
      const sample = at(u + du, v + dv), delta = sample - z;
      const vx = sx * delta + 2 * du * ipx * sample, vy = sy * delta + 2 * dv * ipy * sample;
      const dist2 = vx * vx + vy * vy + delta * delta;
      const lift = (vx * nx + vy * nn - delta * nz) / len - z * 0.0004 - bias;
      occ += Math.max(0, lift) / (dist2 + 0.02) * hermite((2.5 - dist2 / r2) / 1.9);
    }
    raw[i] = half(1 - saturate(occ * radius * 1.5 / samples) * (1 - hermite((z - 180) / 240)));
  }
  const blurX = blur(raw, w, h, 1, 0), filtered = blur(blurX, w, h, 0, 1);
  const out = new Float32Array(color.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = 4 * (y * width + x);
    const visibility = bilinear(filtered, w, h, (x + 0.5) * w / width - 0.5, (y + 0.5) * h / height - 0.5, 0);
    const gain = 1 + strength * (visibility - 1);
    for (let c = 0; c < 3; c++) out[i + c] = enabled ? Math.min(250, color[i + c] * gain) : color[i + c];
    out[i + 3] = color[i + 3];
  }
  return { color: out, raw, blurX, filtered, width, height, halfWidth: w, halfHeight: h };
}

const vertexShader = `varying vec2 uv0;
void main(){ uv0 = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0., 1.); }`;
const rawShader = `varying vec2 uv0;
uniform sampler2D depthMap;
uniform vec2 clipPlanes, invProj, pixel;
uniform bool device; uniform float radiusScale, bias; uniform int samples;
vec2 readDepth(vec2 uv){
  float d = texture2D(depthMap, uv).r, n = clipPlanes.x, f = clipPlanes.y;
  if(device) return vec2(n*f / (f - (f-n)*d), 1.-d);
  float z = d > 0. ? d : f;
  return vec2(z, clamp(n*(f/z-1.)/(f-n), 0., 1.));
}
vec3 surface(vec2 uv){float z = readDepth(uv).x; return vec3((2.*uv-1.)*invProj*z, -z);}
vec3 tangent(vec3 p, vec2 offset){
  vec3 a=surface(uv0+offset)-p, b=p-surface(uv0-offset);
  return abs(a.z)<abs(b.z)?a:b;
}
void main(){
  vec2 center=readDepth(uv0);
  if(center.y<=0.00001){gl_FragColor=vec4(1.,0.,0.,1.); return;}
  vec3 p=surface(uv0), n=normalize(cross(tangent(p,vec2(pixel.x,0.)),tangent(p,vec2(0.,pixel.y))));
  float radius=radiusScale*clamp(0.035*center.x,0.5,5.), rr=radius*radius;
  float rot=6.2831853*fract(52.9829189*fract(dot(gl_FragCoord.xy,vec2(0.06711056,0.00583715))));
  float blocked=0.;
  for(int j=0;j<samples;j++){
    float t=(float(j)+0.5)/float(samples), angle=rot+t*6.2831853*3.7;
    vec2 offset=vec2(cos(angle),sin(angle))*sqrt(t)*(0.5*radius/center.x)/invProj;
    vec3 delta=surface(uv0+offset)-p; float dd=dot(delta,delta);
    float lift=max(0., dot(delta,n)-0.0004*center.x-bias);
    blocked+=lift/(dd+0.02)*(1.-smoothstep(0.6*rr,2.5*rr,dd));
  }
  float amount=clamp(blocked*radius*1.5/float(samples),0.,1.)*(1.-smoothstep(180.,420.,center.x));
  gl_FragColor=vec4(1.-amount,center.y,0.,1.);
}`;
const blurShader = `varying vec2 uv0; uniform sampler2D field; uniform vec2 stepUV;
void main(){
  vec2 c=texture2D(field,uv0).rg;
  float sum=c.r*0.30, weight=0.30;
  for(int j=1;j<=3;j++){
    float spatial=j==1?0.22:(j==2?0.10:0.03);
    for(int side=-1;side<=1;side+=2){
      vec2 s=texture2D(field,uv0+stepUV*float(j*side)*1.35).rg;
      float w=spatial*step(abs(s.g-c.g),0.035*c.g+1e-7);
      sum+=w*s.r; weight+=w;
    }
  }
  gl_FragColor=vec4(sum/weight,c.g,0.,1.);
}`;
const composeShader = `varying vec2 uv0; uniform sampler2D tInput, field; uniform float strength; uniform bool enabled;
void main(){ vec4 src=texture2D(tInput,uv0); float ao=texture2D(field,uv0).r;
  gl_FragColor=enabled ? vec4(min(vec3(250.),src.rgb*mix(1.,ao,strength)),src.a) : src;
}`;

/** Page card and standalone GPU replay. The caller owns all input/output textures. */
export function create(ctx, params = {}) {
  const { THREE } = ctx;
  const { enabled, radius, bias, samples } = controls(params);
  const { strength = 0.9, nearM = 0.1, farM = 100, fovYDeg = 40 } = params;
  check(strength, 'linear-meters', 1, 1);
  const material = (fragmentShader, values) => new THREE.ShaderMaterial({ vertexShader, fragmentShader,
    uniforms: Object.fromEntries(Object.entries(values).map(([k, value]) => [k, { value }])),
    depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false });
  const v2 = () => new THREE.Vector2();
  const sample = material(rawShader, { depthMap: null, clipPlanes: v2(), invProj: v2(), pixel: v2(), device: false, radiusScale: radius, bias, samples });
  const smooth = material(blurShader, { field: null, stepUV: v2() });
  const finish = material(composeShader, { tInput: null, tDepth: null, field: null, strength, enabled });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1,-1,0, 3,-1,0, -1,3,0], 3));
  const quad = new THREE.Mesh(geometry, sample), object = new THREE.Mesh(geometry, finish);
  object.name = 'post.ao'; quad.frustumCulled = object.frustumCulled = false;
  const screen = new THREE.Camera();
  const rt = () => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
  const raw = rt(), blurX = rt(), filtered = rt();

  function passes(renderer, { color, depth, camera, target, depthEncoding = 'linear-meters' }, compose) {
    if (!target?.isWebGLRenderTarget || !depth?.isTexture || !color?.isTexture) throw new TypeError('AO needs full-resolution color, depth and output target');
    const { width, height } = target;
    for (const t of [color, depth]) {
      if (t.image?.width !== width || t.image?.height !== height || t === target.texture) throw new RangeError('AO input and separate output must match in size');
    }
    check(strength, depthEncoding, width, height);
    const proj = projection(camera, width, height), w = sizeHalf(width), h = sizeHalf(height);
    for (const layer of [raw, blurX, filtered]) layer.setSize(w, h);
    const u = sample.uniforms;
    u.depthMap.value = depth; u.clipPlanes.value.set(proj.near, proj.far); u.invProj.value.set(proj.x, proj.y);
    u.pixel.value.set(1 / w, 1 / h); u.device.value = depthEncoding === 'device';
    const before = renderer.getRenderTarget(), face = renderer.getActiveCubeFace?.(), level = renderer.getActiveMipmapLevel?.();
    function draw(mat, dest) { quad.material = mat; renderer.setRenderTarget(dest); renderer.render(quad, screen); }
    try {
      draw(sample, raw);
      smooth.uniforms.field.value = raw.texture; smooth.uniforms.stepUV.value.set(1 / w, 0); draw(smooth, blurX);
      smooth.uniforms.field.value = blurX.texture; smooth.uniforms.stepUV.value.set(0, 1 / h); draw(smooth, filtered);
      finish.uniforms.field.value = filtered.texture; finish.uniforms.tInput.value = color;
      if (compose) draw(finish, target);
    } finally { renderer.setRenderTarget(before, face, level); }
    return { raw, blurX, filtered };
  }
  // The host supplies one mesh slot, a metre-depth texture, and a screen camera.
  // Never use that screen camera to reconstruct the perspective scene.
  object.onBeforeRender = renderer => passes(renderer, {
    color: finish.uniforms.tInput.value, depth: finish.uniforms.tDepth.value, target: renderer.getRenderTarget(),
    camera: ctx.tracks?.camera ?? ctx.camera ?? { near: nearM, far: farM, fov: fovYDeg },
  }, false);
  return { object, render: (renderer, args) => passes(renderer, args, true),
    dispose() { for (const resource of [raw, blurX, filtered, sample, smooth, finish, geometry]) resource.dispose(); } };
}
