// three 探针适配器的页面一侧（一次性，用完即删）：照 calib-scene/0.1 规格用 WebGLRenderer 搭场景、渲、读回场景线性值。
import * as THREE from 'three';

const SUBS = 8; // 一帧取几个子帧
const ONE = new THREE.Vector3(1, 1, 1), v3 = a => new THREE.Vector3(...a), lin = a => new THREE.Color().setRGB(...a, THREE.LinearSRGBColorSpace);
const r6 = x => Math.round(x * 1e6) / 1e6, med = a => [...a].sort((x, y) => x - y)[a.length >> 1];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]), maxAbs = (a, b) => Math.max(...a.map((x, i) => Math.abs(x - b[i])));
const rd = (scene, what, expected, got, unit, diff) => ({ scene, what, expected, got, diff, unit });
const srgb8 = x => Math.round(255 * Math.min(1, Math.max(0, x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055)));
let R, gl;

export function init() {
  R = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  R.setPixelRatio(1); R.setClearColor(0x000000, 0); gl = R.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return { revision: THREE.REVISION, gpu: gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL), webgl: gl.getParameter(gl.VERSION) };
}

// 编号层和深度层共用的覆盖材质：r = 编号，g = 平面深度（米），b = 射线距离（米）。
const AUX_VS = 'varying vec3 vp; void main() { vec4 p = modelViewMatrix * vec4(position, 1.0); vp = p.xyz; gl_Position = projectionMatrix * p; }';
const AUX_FS = 'uniform float idIndex; varying vec3 vp; void main() { gl_FragColor = vec4(idIndex, -vp.z, length(vp), 1.0); }';
const GEOMETRY = { box: o => new THREE.BoxGeometry(...o.sizeM), plane: o => new THREE.PlaneGeometry(...o.sizeM),
  sphere: o => new THREE.SphereGeometry(o.radiusM, 128, 64), cylinder: o => new THREE.CylinderGeometry(o.radiusM, o.radiusM, o.heightM, 128),
};

function build(spec) {
  const c = spec.camera, scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(c.yFovDeg, c.widthPx / c.heightPx, c.nearM, c.farM);
  cam.position.fromArray(c.positionM); cam.up.copy(v3(c.upDir).normalize()); cam.lookAt(v3(c.lookAtM)); cam.updateMatrixWorld();
  const meshes = spec.objects.map(o => {
    const color = new THREE.MeshBasicMaterial({ color: lin(o.emissionLinear), side: THREE.DoubleSide });
    const aux = new THREE.ShaderMaterial({ uniforms: { idIndex: { value: o.idIndex } }, vertexShader: AUX_VS, fragmentShader: AUX_FS, side: THREE.DoubleSide });
    const m = new THREE.Mesh(GEOMETRY[o.shape](o), color);
    Object.assign(m.userData, { o, color, aux }); m.matrixAutoUpdate = false;
    return scene.add(m) && m;
  });
  return { spec, scene, cam, meshes, byId: id => meshes.find(m => m.userData.o.id === id), W: c.widthPx, H: c.heightPx, bg: lin(spec.backgroundLinear) };
}

// 时刻 t（帧 + 子帧）的世界变换：R = R运动 · R静态；spin 时 T = R运动 · (位置 − 枢轴) + 枢轴。
function pose(ctx, t) {
  for (const m of ctx.meshes) {
    const { o } = m.userData, mo = o.motion, q = new THREE.Quaternion(), p = v3(o.positionM);
    if (o.rotation) q.setFromAxisAngle(v3(o.rotation.axisDir).normalize(), o.rotation.angleRad);
    if (mo?.kind === 'spin') {
      const qm = new THREE.Quaternion().setFromAxisAngle(v3(mo.axisDir).normalize(), mo.angularVelocityRadPerFrame * t);
      q.premultiply(qm); p.sub(v3(mo.pivotM)).applyQuaternion(qm).add(v3(mo.pivotM));
    } else if (mo?.kind === 'linear') p.addScaledVector(v3(mo.velocityMPerFrame), t);
    m.matrix.compose(p, q, ONE);
  }
  ctx.scene.updateMatrixWorld(true);
}

function draw(ctx, t, pass, rt, hidden = new Set()) {
  pose(ctx, t); for (const m of ctx.meshes) { m.material = m.userData[pass]; m.visible = !hidden.has(m.userData.o.id); }
  ctx.scene.background = pass === 'aux' ? null : ctx.bg; R.setRenderTarget(rt); R.render(ctx.scene, ctx.cam);
}

const target = (w, h) => new THREE.WebGLRenderTarget(w, h, { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
function read(rt, u = 0, v = rt.height - 1, w = rt.width, h = rt.height) {
  const a = new Float32Array(w * h * 4);
  return R.readRenderTargetPixels(rt, Math.floor(u), rt.height - 1 - Math.floor(v), w, h, a), a;
}
// 读回的行从下往上；坐标 (u, v) 取它落在的整数像素 (⌊u⌋, ⌊v⌋)。
const px = (a, w, h, u, v) => { const i = ((h - 1 - Math.floor(v)) * w + Math.floor(u)) * 4; return [a[i], a[i + 1], a[i + 2]]; };
const mask = (a, test) => Float32Array.from({ length: a.length / 4 }, (_, k) => (test(a[4 * k]) ? 1 : 0));
function centroid(m, w, h) {
  let n = 0, su = 0, sv = 0;
  m.forEach((x, k) => { n += x; su += x * (k % w + 0.5); sv += x * (h - 0.5 - Math.floor(k / w)); });
  return n ? [su / n, sv / n] : null;
}
const avg = list => Float64Array.from(list[0], (_, i) => list.reduce((n, a) => n + a[i], 0) / list.length);
function diffStats(a, b) {
  const d = Float64Array.from(a, (x, i) => Math.abs(x - b[i]));
  return { max: r6(d.reduce((m, x) => Math.max(m, x), 0)), mean: r6(d.reduce((n, x) => n + x, 0) / d.length) };
}
function idBox(a, w, h, id) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (let k = 0; k < a.length / 4; k++) if (a[4 * k] === id) {
    const x = k % w, y = h - 1 - Math.floor(k / w); b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x + 1); b[3] = Math.max(b[3], y + 1);
  }
  return b;
}
const others = (ctx, id) => new Set(ctx.meshes.map(m => m.userData.o.id).filter(x => x !== id)), area = r => (r[2] - r[0]) * (r[3] - r[1]);
const iou = (a, b) => { const i = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1])); return i / (area(a) + area(b) - i); };
function projectThree(ctx, id, t, local) {
  pose(ctx, t); const p = v3(local).applyMatrix4(ctx.byId(id).matrixWorld).project(ctx.cam);
  return [(p.x + 1) / 2 * ctx.W, (1 - p.y) / 2 * ctx.H];
}

// 遮挡顺序：读这个像素最先打到谁，把它藏掉再渲，直到背景。每个物体只记第一个交点，和检查器的求交口径一致。
function peel(ctx, rt, e) {
  const hidden = new Set(), hits = [];
  for (let k = 0; k < ctx.meshes.length; k++) {
    draw(ctx, e.atFrame, 'aux', rt, hidden);
    const [idx, plane, ray] = read(rt, ...e.pixelPx, 1, 1);
    if (!idx) break;
    const id = ctx.meshes.find(m => m.userData.o.idIndex === idx).userData.o.id;
    hits.push({ objectId: id, planeDepthM: plane, rayDistanceM: ray }) && hidden.add(id);
  }
  return hits;
}
function hitReadings(ctx, rt, e, withRay) {
  const s = ctx.spec.id, got = peel(ctx, rt, e), where = `像素 (${e.pixelPx}) 第 ${e.atFrame} 帧`, order = l => l.map(h => h.objectId).join(' > ') || '背景';
  const out = [rd(s, `${where} 遮挡顺序`, order(e.hits), order(got), 'objectId', order(e.hits) === order(got) ? '一致' : '不一致')];
  e.hits.forEach((h, k) => got[k]?.objectId === h.objectId && (withRay ? ['planeDepthM', 'rayDistanceM'] : ['planeDepthM']).forEach(f => out.push(rd(s, `${where} 第 ${k + 1} 层 ${f}`, h[f], r6(got[k][f]), 'm', r6(got[k][f] - h[f])))));
  return out;
}
function pointReadings(ctx, rt, e, solo = false) {
  const s = ctx.spec.id, t = e.atFrame + e.subFrameRatio, where = `${e.objectId} 局部点 (${e.localPointM}) 在 t = ${t} 帧`;
  const g = projectThree(ctx, e.objectId, t, e.localPointM).map(r6), out = [rd(s, `${where} three 投影像素`, e.pixelPx, g, 'px', r6(dist(g, e.pixelPx)))];
  if (e.localPointM.some(x => x !== 0)) return out;
  draw(ctx, t, 'aux', rt, solo ? others(ctx, e.objectId) : new Set()); const c = centroid(mask(read(rt), x => x === ctx.byId(e.objectId).userData.o.idIndex), ctx.W, ctx.H)?.map(r6);
  return [...out, rd(s, `${where} ${solo ? '单独渲' : ''}编号层覆盖质心`, e.pixelPx, c ?? '不可见', 'px', c ? r6(dist(c, e.pixelPx)) : '不可见')];
}
function boxReadings(ctx, a, e, how = '合渲') {
  const s = ctx.spec.id, b = idBox(a, ctx.W, ctx.H, ctx.byId(e.objectId).userData.o.idIndex), want = [...e.boxMinPx, ...e.boxMaxPx], v = r6(iou(b, want));
  return [rd(s, `${e.objectId} ${how}编号层反算包围盒 [x0, y0, x1, y1]`, want, b, 'px', r6(maxAbs(b, want))),
    rd(s, `${e.objectId} ${how}编号层反算包围盒与元数据包围盒的交并比（过线 ${e.minIouRatio}）`, 1, v, 'ratio', r6(v - 1))];
}

// 画到画布上取 sRGB 8 位值：three 在着色器里做色调映射和 sRGB 编码。
function display(ctx, toneMapping) {
  R.toneMapping = toneMapping; R.setSize(ctx.W, ctx.H, false); draw(ctx, 0, 'color', null);
  const a = new Uint8Array(ctx.W * ctx.H * 4); gl.readPixels(0, 0, ctx.W, ctx.H, gl.RGBA, gl.UNSIGNED_BYTE, a);
  R.toneMapping = THREE.NoToneMapping; return a;
}

function grayChart(ctx, rt) {
  const s = ctx.spec.id, { W, H } = ctx, patches = ctx.spec.expected.filter(e => e.kind === 'patchColor'), hdr = patches.filter(e => e.objectId.startsWith('hdr-'));
  draw(ctx, 0, 'color', rt);
  const a = read(rt), bg = ctx.spec.expected.find(e => e.kind === 'pixelHits'), bgGot = px(a, W, H, ...bg.pixelPx);
  const linear = patches.map(e => { const g = px(a, W, H, ...e.pixelPx); return rd(s, `${e.objectId} 中心像素线性值`, e.valueLinear, g.map(r6), 'linear', r6(maxAbs(g, e.valueLinear))); })
    .concat(rd(s, `背景像素 (${bg.pixelPx}) 线性值`, ctx.spec.backgroundLinear, bgGot.map(r6), 'linear', r6(maxAbs(bgGot, ctx.spec.backgroundLinear))));
  const plain = display(ctx, THREE.NoToneMapping), agx = display(ctx, THREE.AgXToneMapping), at = (b, e) => px(b, W, H, ...e.pixelPx);
  const encode = e => { const want = e.valueLinear.map(srgb8), got = at(plain, e); return rd(s, `${e.objectId}（线性 ${e.valueLinear}）不整形、只做 sRGB 编码的 8 位值`, want, got, 'srgb8', maxAbs(got, want)); };
  const shown = patches.filter(e => !hdr.includes(e)).map(encode)
    .concat(patches.map(e => rd(s, `${e.objectId} 过 three 自带 AgX 后的 sRGB 8 位值`, '待 Blender 查找表', at(agx, e), 'srgb8', '待 Blender 探针')));
  const clipAt = f => hdr.find(e => f(e)[0] === 255)?.objectId ?? '没有一级被切', want = clipAt(e => e.valueLinear.map(srgb8)), got = clipAt(e => at(plain, e));
  const shaping = hdr.map(encode).concat(rd(s, '不整形时第一个被切到 255 的 HDR 级', want, got, 'objectId', want === got ? '一致' : '不一致'),
    rd(s, '过 three 自带 AgX 时第一个被切到 255 的 HDR 级', '待 Blender 直出 AgX', clipAt(e => at(agx, e)), 'objectId', '待 Blender 探针'));
  return { '颜色层的线性度': linear, '显示变换': shown, '显示变换的整形曲线': shaping };
}

function planeSteps(ctx, rt) {
  const shot = t => { draw(ctx, t, 'color', rt); return read(rt); }, single = shot(0), d = diffStats(avg(Array.from({ length: SUBS }, (_, k) => shot((k + 0.5) / SUBS))), single);
  return { '深度口径': ctx.spec.expected.flatMap(e => hitReadings(ctx, rt, e, true)),
    '子帧累积和后期的先后': [rd(ctx.spec.id, `静止场景第 0 帧 ${SUBS} 个子帧（t = (k + 0.5) / ${SUBS}，没有采样抖动）在线性光里累积，与 t = 0 单个采样的全图最大差`, 0, d.max, 'linear', d.max)] };
}

function thinGeometry(ctx, rt) {
  const s = ctx.spec.id, { W, H } = ctx;
  draw(ctx, 0, 'aux', rt); const a = read(rt), frac = mask(a, x => x !== Math.round(x)).reduce((n, x) => n + x, 0);
  const out = [rd(s, '编号层里编号不是整数的像素数（带抗锯齿混色时大于 0）', 0, frac, 'px', frac)];
  for (const e of ctx.spec.expected) {
    if (e.kind === 'projectedBox') { out.push(...boxReadings(ctx, a, e)); continue; }
    if (e.kind === 'pixelHits') { out.push(...hitReadings(ctx, rt, e, false)); continue; }
    // 投影高度内（像素中心落在杆两端投影之间的行）逐行数编号像素，取平均当宽度。
    const o = ctx.byId(e.objectId).userData.o, [vt, vb] = [1, -1].map(k => projectThree(ctx, o.id, 0, [0, k * o.heightM / 2, 0])[1]);
    const counts = [];
    for (let j = Math.ceil(vt - 0.5); j + 0.5 <= vb; j++) counts.push(mask(a.subarray((H - 1 - j) * W * 4, (H - j) * W * 4), x => x === o.idIndex).reduce((n, x) => n + x, 0));
    const w = r6(counts.reduce((n, x) => n + x, 0) / counts.length), empty = counts.filter(x => !x).length;
    out.push(rd(s, `${e.objectId} 编号层反算的投影宽度（投影高度内每行像素数的平均）`, e.widthPx, w, 'px', r6(w - e.widthPx)),
      rd(s, `${e.objectId} 投影高度内一个像素都没有的行（共 ${counts.length} 行）`, 0, empty, 'row', empty),
      rd(s, `${e.objectId} 杆中心投影的横坐标 u 和投影半宽（杆盖住 [u − 半宽, u + 半宽]）`, '无标准答案', [r6(projectThree(ctx, o.id, 0, [0, 0, 0])[0]), r6(e.widthPx / 2)], 'px', '无'));
  }
  return { '编号层的边缘': out };
}

// 转台小杆单独渲编号层的包围盒；期望（规格的八角投影，正反两种顺序）由驱动在 Node 里用检查器的变换算。
const armBox = (ctx, rt, t) => { draw(ctx, t, 'aux', rt, others(ctx, 'turntable-arm')); return rd(ctx.spec.id, `armBox ${t}`, null, idBox(read(rt), ctx.W, ctx.H, ctx.byId('turntable-arm').userData.o.idIndex), 'px', null); };
const axes = (ctx, rt) => ({ '坐标与相机': ctx.spec.expected.flatMap(e => (e.kind === 'pixelHits' ? hitReadings(ctx, rt, e, true) : pointReadings(ctx, rt, e, true))).concat([24, 48].map(t => armBox(ctx, rt, t))) });

// 最小的亮部溢出：超过 1 的部分做 9×9 盒式模糊，乘 0.5 加回。
function bloom(a, w, h, r = 4) {
  let b = a.map((x, i) => (i % 4 === 3 ? 0 : Math.max(x - 1, 0)));
  for (const [dx, dy] of [[1, 0], [0, 1]]) {
    const o = new Float64Array(b.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) for (let k = -r; k <= r; k++) {
      const xx = x + k * dx, yy = y + k * dy;
      if (xx >= 0 && xx < w && yy >= 0 && yy < h) o[(y * w + x) * 4 + c] += b[(yy * w + xx) * 4 + c] / (2 * r + 1);
    }
    b = o;
  }
  return a.map((x, i) => x + 0.5 * b[i]);
}

function movingCube(ctx, rt) {
  const s = ctx.spec.id, { W, H } = ctx, F = 24, open = ctx.spec.camera.shutterAngleDeg / 360, ex = ctx.spec.expected;
  const time = ex.filter(e => !e.sampleAt).flatMap(e => (e.kind === 'pixelHits' ? hitReadings(ctx, rt, e, false) : pointReadings(ctx, rt, e)));
  // 快门窗口 [F, F + open) 里取子帧中点；拖影相位由覆盖质心在 sub = 0 和 sub = open 两个静止位置之间插出来，抵掉轮廓偏差。
  const subs = Array.from({ length: SUBS }, (_, k) => (k + 0.5) / SUBS * open);
  const cover = t => { draw(ctx, F + t, 'aux', rt); return mask(read(rt), x => x > 0); };
  const [c0, c1, cb] = [cover(0), cover(open), avg(subs.map(cover))].map(m => centroid(m, W, H)[0]);
  const mid = ex.find(e => e.sampleAt === 'shutterMid'), phase = r6((cb - c0) / (c1 - c0) * open);
  const shutter = [rd(s, `构造读数：第 ${F} 帧 180 度快门拖影中点的子帧相位（${SUBS} 个子帧，由覆盖质心换算）`, mid.subFrameRatio, phase, 'frame', r6(phase - mid.subFrameRatio)),
    rd(s, `构造读数：第 ${F} 帧拖影覆盖质心的横坐标`, mid.pixelPx[0], r6(cb), 'px', r6(cb - mid.pixelPx[0]))];
  const colors = subs.map(t => { draw(ctx, F + t, 'color', rt); return read(rt); });
  const A = bloom(avg(colors), W, H), B = avg(colors.map(c => bloom(c, W, H))), d = diffStats(A, B);
  const hp = ex.find(e => e.objectId === 'highlight').pixelPx, ha = px(A, W, H, ...hp).map(r6), hb = px(B, W, H, ...hp).map(r6);
  return { '时间键': time, '快门相位': shutter, '子帧累积和后期的先后': [
    rd(s, `第 ${F} 帧先平均再跑后期，和逐子帧跑后期再平均：全图最大差`, 0, d.max, 'linear', d.max),
    rd(s, '同上：全图平均差', 0, d.mean, 'linear', d.mean),
    rd(s, `同上：高光像素 (${hp})，期望列是先平均再跑后期，读数列是逐子帧跑后期再平均`, ha, hb, 'linear', r6(maxAbs(hb, ha)))] };
}

function occlusion(ctx, rt) {
  const s = ctx.spec.id, ids = ctx.meshes.map(m => m.userData.o.id);
  draw(ctx, 0, 'aux', rt);
  const a = read(rt), out = ctx.spec.expected.flatMap(e => (e.kind === 'projectedBox' ? boxReadings(ctx, a, e) : hitReadings(ctx, rt, e, false)));
  for (const e of ctx.spec.expected.filter(x => x.kind === 'projectedBox')) { draw(ctx, 0, 'aux', rt, others(ctx, e.objectId)); out.push(...boxReadings(ctx, read(rt), e, '单独渲')); }
  const q = target(ctx.W / 4, ctx.H / 4);
  const count = (hidden, idx) => { draw(ctx, 0, 'aux', q, hidden); return mask(read(q), x => x === idx).reduce((n, x) => n + x, 0); };
  const timeIt = f => med(Array.from({ length: 11 }, () => { const t0 = performance.now(); f(); return performance.now() - t0; }));
  for (const id of ids) {
    const idx = ctx.byId(id).userData.o.idIndex, solo = count(others(ctx, id), idx), merged = count(new Set(), idx);
    out.push(rd(s, `${id} 四分之一分辨率编号层的可见比例（合渲像素 ${merged} ÷ 单独渲像素 ${solo}）`, '无标准答案', r6(merged / solo), 'ratio', '无'),
      rd(s, `${id} 多渲一遍四分之一分辨率编号层并读回的耗时（11 次取中位）`, '无标准答案', r6(timeIt(() => count(others(ctx, id), idx))), 'ms', '无'));
  }
  q.dispose(); return { '可见比例的成本': out };
}

const MEASURE = { 'probe-gray-chart': grayChart, 'probe-plane-steps': planeSteps, 'probe-thin-geometry': thinGeometry, 'probe-axes-turntable': axes, 'probe-moving-cube': movingCube, 'probe-occlusion': occlusion };
const hex = buf => [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, '0')).join('');
const b64 = f32 => { const u = new Uint8Array(f32.buffer); let str = ''; for (let i = 0; i < u.length; i += 0x8000) str += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(str); };

// 一个场景：冷启动出第一帧、计时、哈希颜色层、量读数、出一张 sRGB 预览图。耗时只用来填耗时那一行，不影响画面。
export async function runScene(spec) {
  const t0 = performance.now(), ctx = build(spec), rt = target(ctx.W, ctx.H), frame = spec.id === 'probe-moving-cube' ? 24 : 0;
  draw(ctx, frame, 'color', rt);
  const color = read(rt), coldMs = performance.now() - t0, timeIt = f => r6(med(Array.from({ length: 5 }, () => { const t = performance.now(); f(); return performance.now() - t; })));
  const timing = { coldMs: r6(coldMs), frameMs: timeIt(() => { draw(ctx, frame, 'color', rt); read(rt, 0, 0, 1, 1); }), readMs: timeIt(() => read(rt)) };
  const hash = hex(await crypto.subtle.digest('SHA-256', color)), rows = MEASURE[spec.id](ctx, rt);
  R.setSize(ctx.W, ctx.H, false); draw(ctx, frame, 'color', null);
  const png = R.domElement.toDataURL('image/png');
  rt.dispose(); for (const m of ctx.meshes) { m.geometry.dispose(); m.userData.color.dispose(); m.userData.aux.dispose(); }
  return { frame, hash, color: b64(color), png, timing, rows };
}
