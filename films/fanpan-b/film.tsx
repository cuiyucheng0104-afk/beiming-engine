// 《沉水擂台》· B 版画面：北冥原生 · BNE。这一版从调度到每一张贴图都是自己的，不与 C 版共用任何素材或代码。
//   实体   ruin.js 用 three.js 搭好，资产桥导成 GLB：ruin.glb（受光、投影）和 ruin-glow.glb（发光件，不投影）
//   像素片 cards.js 逐像素画、bake.mjs 拼成一张图集；这里按 plan.js 的清单把几百张片拼成几张网格（按受光 / 发光分层）
//   棋子   平的像素卡片，序列帧按格切，一拍二到一拍三地跳；镜头和灯连续走
//   光     偏紫的冷暗环境 + 穿过树冠豁口的暖金斜阳（一块只投影的镂空板挡出光斑）+ 青 / 橙两色的点光
//   后期   镜头自己的景深（焦点压在盘面偏后，近处糊得重、远处略虚）→ 泛光 → 暗角与调色 → 胶片曲线
// 画法参考 cases/vendor/lemo-opuscar/styles/hd-2d/STYLE.md（MIT，LemoLab），只取方法、代码自己写。
import { AbsoluteFill, Composition, registerRoot, staticFile, useCurrentFrame } from 'raea';
import { Camera3d } from 'raea/camera';
import { Canvas3D, Model } from 'raea/3d';
import { Mesh3d, BufferMesh, Sphere } from 'raea/mesh';
import { StandardMaterial, VolumetricFog, FogVolume } from 'raea/pbr';
import { AmbientLight, DirectionalLight, PointLight, Shadows } from 'raea/light';
import { Bloom, ToneMapping, Grade, DepthOfField } from 'raea/post_process';
import { Transform, Quat } from 'raea/transform';
import { LinearRgba, Srgba } from 'raea/color';
import { Affine2 } from 'raea/math';
import { PPM, TOP, BZ, CX, GATE, UNITS, DUELS, LAMPS, SHAFTS, MOTES, SUN, sunDir, BACKDROP, PICK, FALL, colX, laneZ, unitBox, unitFrame, unitAt, flick, camAt, moteAt, staticCards, liveCards, goboCells } from './plan.js';
import film from './film.json';
import atlas from './baked/cards.json';

const OUT = film.output, W = OUT.width, H = OUT.height, FPS = OUT.fps, FRAMES = OUT.frameCount;
// 调画面只改这一组数（灯是真实单位：勒克斯 / 流明）
const LOOK = {
  sun: 11000, fill: 800, fillColor: '#8f7cf0', ambient: 360, ambientColor: '#7a5ac8', lamp: 52000,
  glow: { hi: 3.4, mid: 2.4, lo: 1.2 }, unit: .5, halo: .6,
  dof: { fStops: .11, maxBlur: 48, focusBack: 1.6 },
  bloom: { intensity: 1.5, threshold: .82 },
  fog: { density: .022, color: '#ffd9a8' }, shaft: .5,
  grade: { vignette: .52, temperature: .06, tint: .04, saturation: 1.18 },
  exposure: .95,
};
const glow = (hex: string, k: number) => LinearRgba.from(Srgba.hex(hex)).mul(k);
const pixel = (file: string) => ({ path: staticFile(file), sampler: { filter: 'nearest', mipmap: 'none' } });
type V3 = number[];
const add = (a: V3, b: V3, k = 1) => a.map((v, i) => v + b[i] * k);
const cross = (a: V3, b: V3) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3) => { const l = Math.hypot(...a) || 1; return a.map(v => v / l); };
const TILT = -.16, UPN = unit([0, .9, .44]);                           // 立着的卡片：往后仰一点；法线朝上偏前，斜阳才照得到

// —— 把一批卡片拼成一张网格 ——
type Geo = { positions: number[], normals: number[], uvs: number[], indices: number[], colors: number[] };
const geo = (): Geo => ({ positions: [], normals: [], uvs: [], indices: [], colors: [] });
// 四个角按 左上、右上、左下、右下 给；uv 是图集里的 [u0, v0, u1, v1]
function quad(g: Geo, c: V3[], uv: number[], n: V3 = UPN, a = 1) {
  const i = g.positions.length / 3;
  for (const p of c) { g.positions.push(...p); g.normals.push(...n); g.colors.push(1, 1, 1, a); }
  g.uvs.push(uv[0], uv[1], uv[2], uv[1], uv[0], uv[3], uv[2], uv[3]);
  g.indices.push(i, i + 2, i + 1, i + 1, i + 2, i + 3);
}
const rectUV = (set: { size: number[], rects: Record<string, number[]> }, name: string, flip = false) => {
  const r = set.rects[name]; if (!r) throw new Error(`图集里没有 ${name}`);
  const u0 = r[0] / set.size[0], u1 = (r[0] + r[2]) / set.size[0], v0 = r[1] / set.size[1], v1 = (r[1] + r[3]) / set.size[1];
  return { uv: flip ? [u1, v0, u0, v1] : [u0, v0, u1, v1], w: r[2] / PPM, h: r[3] / PPM };
};
type Card = { layer: string, n: string, p: V3, s: number, k: string, tilt?: number, yaw?: number, roll?: number, flip?: boolean };
function place(g: Geo, c: Card, right: V3, upv: V3) {
  const { uv, w, h } = rectUV(atlas.cards, c.n, c.flip), hw = w * c.s / 2, hh = h * c.s;
  if (c.k === 'flat') {                                                 // 躺着：中心在 p，绕竖轴转 yaw
    const cy = Math.cos(c.yaw ?? 0), sy = Math.sin(c.yaw ?? 0), ax = [cy * hw, 0, -sy * hw], az = [sy * hh / 2, 0, cy * hh / 2];
    return quad(g, [add(add(c.p, ax, -1), az, -1), add(add(c.p, ax), az, -1), add(add(c.p, ax, -1), az), add(add(c.p, ax), az)], uv, [0, 1, 0]);
  }
  if (c.k === 'face') {                                                 // 朝镜头：中心在 p，在画面里转 roll
    const cr = Math.cos(c.roll ?? 0), sr = Math.sin(c.roll ?? 0), ax = add(right.map(v => v * cr), upv, sr).map(v => v * hw), ay = add(upv.map(v => v * cr), right, -sr).map(v => v * hh / 2);
    return quad(g, [add(add(c.p, ax, -1), ay), add(add(c.p, ax), ay), add(add(c.p, ax, -1), ay, -1), add(add(c.p, ax), ay, -1)], uv);
  }
  const t = c.tilt ?? TILT, cy = Math.cos(c.yaw ?? 0), sy = Math.sin(c.yaw ?? 0);   // 立着：底边中点在 p
  let ax = [cy * hw, 0, -sy * hw], ay = [Math.sin(t) * sy * hh, Math.cos(t) * hh, Math.sin(t) * cy * hh], base = c.p;
  if (c.roll) { const cr = Math.cos(c.roll), sr = Math.sin(c.roll), mid = add(c.p, ay, .5), x2 = add(ax.map(v => v * cr), ay, sr * hw / hh), y2 = add(ay.map(v => v * cr), ax, -sr * hh / hw); ax = x2; ay = y2; base = add(mid, ay, -.5); }
  quad(g, [add(add(base, ax, -1), ay), add(add(base, ax), ay), add(base, ax, -1), add(base, ax)], uv);
}
const LAYERS = ['cast', 'lit', 'fg', 'hi', 'mid', 'lo'];
function batch(list: Card[], right: V3 = [1, 0, 0], upv: V3 = [0, 1, 0]) {
  const out: Record<string, Geo> = {}; for (const l of LAYERS) out[l] = geo();
  for (const c of list) place(out[c.layer], c, right, upv);
  return out;
}
const STATIC = batch(staticCards() as Card[]);
const GOBO = (() => { const g = geo(); for (const [x, y, z, s] of goboCells()) quad(g, [[x, y, z], [x + s, y, z], [x, y, z + s], [x + s, y, z + s]], [0, 0, 1, 1], [0, 1, 0]); return g; })();
const mesh = (g: Geo) => ({ positions: g.positions, normals: g.normals, uvs: g.uvs, indices: g.indices });

const CARDS = pixel('cards.png');
function Layer({ name, g, kind }: { name: string, g: Geo, kind: string }) {
  if (!g.indices.length) return null;
  const lit = kind === 'cast' || kind === 'lit' || kind === 'fg';
  return <Mesh3d name={name} castShadow={kind === 'cast'} shadow={kind === 'cast'}>
    <BufferMesh {...mesh(g)} />
    {lit
      ? <StandardMaterial base_color={kind === 'fg' ? '#8a7aa0' : '#ffffff'} base_color_texture={CARDS} perceptual_roughness={1} reflectance={0} alpha_mode={{ Mask: .5 }} double_sided cull_mode={null} />
      : <StandardMaterial base_color="#000000" base_color_texture={CARDS} emissive={glow('#ffffff', LOOK.glow[kind as 'hi'])} emissive_texture={CARDS} perceptual_roughness={1} reflectance={0} alpha_mode={{ Mask: .5 }} double_sided cull_mode={null} />}
  </Mesh3d>;
}

function Unit({ u, f }: { u: typeof UNITS[number], f: number }) {
  const { size, lift } = unitBox(u), x = colX(u.row), z = laneZ(u.lane), map = pixel(`u_${u.atlas}.png`), hs = size / 2;
  return <Mesh3d name={`unit-${u.id}`} transform={Transform.fromXyz(x, TOP + lift * Math.cos(TILT), z + .12 + lift * Math.sin(TILT)).withRotation(Quat.fromEuler('XYZ', TILT, 0, 0))}>
    <BufferMesh positions={[-hs, hs, 0, hs, hs, 0, -hs, -hs, 0, hs, -hs, 0]} indices={[0, 2, 1, 1, 2, 3]} normals={[...UPN, ...UPN, ...UPN, ...UPN]} uvs={[0, 0, 1, 0, 0, 1, 1, 1]} />
    <StandardMaterial base_color="#e4e4e4" base_color_texture={map} emissive={glow('#ffffff', LOOK.unit)} emissive_texture={map} perceptual_roughness={1} reflectance={0}
      uv_transform={Affine2.fromScaleAngleTranslation([1 / u.frames, 1], 0, [unitFrame(u, f) / u.frames, 0])} alpha_mode={{ Mask: .5 }} double_sided cull_mode={null} />
  </Mesh3d>;
}

// 叠加的软光：灯晕、光柱、前线的光幕、瀑布的水汽、棋子脚下的队色光。全部拼进一张网格，亮度写在顶点的透明度里
function softLight(f: number, eye: V3, right: V3, upv: V3) {
  const g = geo(), sec = f / FPS, G = atlas.glow;
  const halo = (name: string, p: V3, size: number, a: number) => { const { uv } = rectUV(G, name), ax = right.map(v => v * size / 2), ay = upv.map(v => v * size / 2); quad(g, [add(add(p, ax, -1), ay), add(add(p, ax), ay), add(add(p, ax, -1), ay, -1), add(add(p, ax), ay, -1)], uv, UPN, a * LOOK.halo); };
  const pool = (name: string, x: number, y: number, z: number, w: number, d: number, a: number) => { const { uv } = rectUV(G, name); quad(g, [[x - w, y, z - d], [x + w, y, z - d], [x - w, y, z + d], [x + w, y, z + d]], uv, [0, 1, 0], a * LOOK.halo); };
  LAMPS.forEach((l, i) => {
    const k = l.flick ? flick(i, sec) : 1, name = l.color === '#ffd98a' ? 'haloGold' : /^#(4|5)/.test(l.color) ? (l.id === 'ice' ? 'haloIce' : 'haloTeal') : 'haloFire';
    halo(name, [l.x, l.y - (l.id.startsWith('bowl') ? .12 : 0), l.z + .05], l.id.startsWith('post') ? 1.0 : l.id === 'ice' || l.id === 'ember' ? 3.2 : 1.7, (l.id.startsWith('post') ? .5 : .42) * k);
  });
  for (const u of UNITS) pool(u.team === 'own' ? 'haloTeal' : 'haloFire', colX(u.row), TOP + .008, laneZ(u.lane) + .14, .62, .46, .34);
  pool('haloGold', colX(PICK.row), TOP + .009, laneZ(PICK.lane), .7, .6, .3 + .12 * Math.sin(sec * 3.2));
  DUELS.forEach(([a, b], i) => { const A = unitAt(a), B = unitAt(b), k = .5 + .5 * Math.sin(sec * 9 + i * 2); halo(i % 2 ? 'haloFire' : 'haloIce', [(A.x + B.x) / 2, TOP + .42, A.z + .26], 1.15, .3 + .2 * k); });
  { const { uv } = rectUV(G, 'haloGold'), um = (uv[0] + uv[2]) / 2, vm = (uv[1] + uv[3]) / 2, x = CX / 2, a = .5 + .08 * Math.sin(sec * 2.1);   // 前线的光幕：贴着盘面最亮，往上淡出
    quad(g, [[x, TOP + .62, -BZ], [x, TOP + .62, BZ], [x, TOP, -BZ], [x, TOP, BZ]], [um, uv[1] + .01, um, vm], UPN, a); }
  { const { uv } = rectUV(G, 'mist'); for (let i = 0; i < 3; i++) { const w = 1.9 + i * .5, y = .22 + i * .1, z = FALL.z + .3 + i * .25, a = .34 - i * .07 + .05 * Math.sin(sec * 1.4 + i);
    quad(g, [[FALL.x - w / 2, y + .5, z], [FALL.x + w / 2, y + .5, z], [FALL.x - w / 2, y - .25, z], [FALL.x + w / 2, y - .25, z]], uv, UPN, a); } }
  { const { uv } = rectUV(G, 'shaft');                                // 光柱：顺着阳光的长片，绕自己的轴转到正对镜头
    SHAFTS.forEach(([x, z, w, k], i) => {
      const mid = add([x, 0, z], sunDir, 4.6), side = unit(cross(sunDir, add(eye, mid, -1))).map(v => v * w / 2);
      const at = (s: number, v: number) => add(add(mid, side, s), sunDir, 4.7 * v);
      quad(g, [at(-1, 1), at(1, 1), at(-1, -1), at(1, -1)], uv, UPN, LOOK.shaft * k * (1 + .12 * Math.sin(sec * .9 + i * 2)));
    }); }
  return g;
}

function Piece() {
  const f = useCurrentFrame(), sec = f / FPS, cam = camAt(f);
  const fw = unit(add(cam.look, cam.pos, -1)), right = unit(cross(fw, [0, 1, 0])), upv = cross(right, fw);
  const focus = Math.hypot(...add(cam.look, cam.pos, -1)) + LOOK.dof.focusBack;
  const live = batch(liveCards(f, cam) as Card[], right, upv), soft = softLight(f, cam.pos, right, upv);
  const sunPos = add(SUN.to, sunDir, 30), GLOW = staticFile('glow.png');
  return <AbsoluteFill style={{ background: BACKDROP }}>
    <Canvas3D layered>
      <Camera3d transform={Transform.fromXyz(...(cam.pos as [number, number, number])).lookingAt(cam.look)} projection={{ Perspective: { fov: cam.fov * Math.PI / 180, near: 2, far: 60 } }}>
        <DepthOfField focal_distance={focus} aperture_f_stops={LOOK.dof.fStops} max_circle_of_confusion_diameter={LOOK.dof.maxBlur} mode="Bokeh" />
      </Camera3d>
      <Shadows distance={48} firstCascade={16} mapSize={4096} />
      <AmbientLight brightness={LOOK.ambient} color={LOOK.ambientColor} />
      <DirectionalLight transform={Transform.fromXyz(...(sunPos as [number, number, number])).lookingAt(SUN.to)} color={SUN.color} illuminance={LOOK.sun} shadow_maps_enabled volumetric />
      <DirectionalLight transform={Transform.fromXyz(2, 8, 16).lookingAt([0, 0, 0])} color={LOOK.fillColor} illuminance={LOOK.fill} />
      {LAMPS.map((l, i) => <PointLight key={l.id} transform={Transform.fromXyz(l.x, l.y, l.z + .12)} color={l.color} intensity={LOOK.lamp * l.power * (l.flick ? flick(i, sec) : 1)} range={l.id === 'ice' || l.id === 'ember' ? 7 : 5.5} radius={.07} />)}
      <VolumetricFog ambient={0} />
      <FogVolume name="air" position={[0, 6, 2]} scale={[30, 14, 30]} density={LOOK.fog.density} color={LOOK.fog.color} scattering={1} absorption={0} anisotropy={.2} />

      {/* 同一个场景拆成的两个模型，互相穿插是有意的（allowOverlap）。发光件过资产桥后是「暗底 + 自发光」，强度在这里按曝光重新给 */}
      <Model name="ruin" src={staticFile('ruin.glb')} sampler={{ filter: 'nearest' }} allowOverlap>
        <StandardMaterial material="ruin-water" perceptual_roughness={.16} reflectance={.75} />
      </Model>
      <Model name="ruin-glow" src={staticFile('ruin-glow.glb')} shadow={false} allowOverlap>
        <StandardMaterial material="ruin-glow-bulb" emissive={glow('#ffc45a', 3.6)} />
        <StandardMaterial material="ruin-glow-eye" emissive={glow('#40ffe0', 9)} />
        <StandardMaterial material="ruin-glow-coal" emissive={glow('#ff6a20', 3)} />
        <StandardMaterial material="ruin-glow-ice" emissive={glow('#30c8e8', 1.1)} />
        <StandardMaterial material="ruin-glow-float" emissive={glow('#ffb85a', 3.2)} />
      </Model>
      {/* 树冠漏光板：只投影、不显示 */}
      <Mesh3d name="gobo" shadow="only"><BufferMesh {...mesh(GOBO)} /><StandardMaterial base_color="#000000" double_sided cull_mode={null} /></Mesh3d>

      {LAYERS.map(l => <Layer key={l} name={`set-${l}`} g={STATIC[l]} kind={l} />)}
      {LAYERS.map(l => <Layer key={l} name={`live-${l}`} g={live[l]} kind={l} />)}
      {UNITS.map(u => <Unit key={u.id} u={u} f={f} />)}
      <Mesh3d name="soft-light" castShadow={false} shadow={false}>
        <BufferMesh {...mesh(soft)} colors={soft.colors} />
        <StandardMaterial base_color="#000000" base_color_texture={GLOW} emissive={glow('#ffffff', 2.4)} emissive_texture={GLOW} alpha_mode="Add" perceptual_roughness={1} reflectance={0} double_sided cull_mode={null} />
      </Mesh3d>
      {Array.from({ length: MOTES }, (_, i) => {
        const m = moteAt(i, sec);
        return <Mesh3d key={i} name={`mote-${i}`} castShadow={false} shadow={false} transform={Transform.fromXyz(m.x, m.y, m.z)}>
          <Sphere radius={m.r} />
          <StandardMaterial base_color="#000000" emissive={glow('#ffe2a8', 1.4)} />
        </Mesh3d>;
      })}

      <Bloom intensity={LOOK.bloom.intensity} threshold={LOOK.bloom.threshold} />
      <Grade vignette={LOOK.grade.vignette} temperature={LOOK.grade.temperature} tint={LOOK.grade.tint} saturation={LOOK.grade.saturation} />
      <ToneMapping mode="aces" exposure={LOOK.exposure} />
    </Canvas3D>
  </AbsoluteFill>;
}
registerRoot(() => <Composition id="film" component={Piece} width={W} height={H} fps={FPS} durationInFrames={FRAMES} />);
