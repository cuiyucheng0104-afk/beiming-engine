// 《林间擂台》· B 版画面：北冥原生 · BNE。和 C 版是同一个场面（layout.js / diorama.js / px.js 是 films/fanpan-c 的原样拷贝），
// 差别只在这里：场景经资产桥导成 GLB，由原生运行时用真实单位的灯、级联阴影、体积光、镜头景深来渲染。
// 画法参考 cases/vendor/lemo-opuscar/styles/hd-2d/STYLE.md（MIT，LemoLab），只取方法、代码自己写：
//   场景   像素贴图的微缩模型，贴图一律最近邻采样；会投影的件（arena.glb）和不投影的件（arena-soft.glb）分两个模型
//   角色   平的像素卡片（自己给顶点：法线朝上偏前，背后的斜阳才照得到），贴图按帧切格，角色逐帧跳、镜头和灯连续走
//   光     冷而暗的环境光 + 穿过树冠缝的暖色斜阳（有影子）+ 一盏盏暖色点光；空气里一层很薄的体积雾，光柱是三片顺着阳光的软片
//   后期   镜头景深（光圈开得极大，俯拍时近处和远处一起糊，等于移轴）→ 泛光 → 暗角与调色 → 胶片曲线
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
import { UNITS, LAMPS, SUN, BACKDROP, TOP, MOTES, LX, GATE_X, tileX, tileZ, spriteBox, spriteFrame, flicker, cameraAt, moteAt } from './layout.js';
import film from './film.json';

const OUT = film.output, W = OUT.width, H = OUT.height, FPS = OUT.fps, FRAMES = OUT.frameCount;
// 调画面只改这一组数（光用原生运行时的真实单位：勒克斯 / 流明）
const LOOK = {
  sun: 11000, fill: 1500, ambient: 760, ambientColor: '#5f8fa8', lamp: 170000,
  dof: { fStops: .16, maxBlur: 38 },
  bloom: { intensity: 1.8, threshold: .8 },
  fog: { density: .03 }, shaft: .6,
  grade: { vignette: .5, temperature: .05, saturation: 1.08 },
  exposure: 1.5,
};
const glow = (hex: string, k: number) => LinearRgba.from(Srgba.hex(hex)).mul(k);
const pixel = (file: string) => ({ path: staticFile(file), sampler: { filter: 'nearest', mipmap: 'none' } });
// 一张朝 +z 的面片；(nx, ny, nz) 是统一给四个顶点的法线。uv 的 v = 0 在图的上沿
const quad = (w: number, h: number, n = [0, 0, 1]) => ({
  positions: [-w / 2, h / 2, 0, w / 2, h / 2, 0, -w / 2, -h / 2, 0, w / 2, -h / 2, 0],
  indices: [0, 2, 1, 1, 2, 3], normals: [...n, ...n, ...n, ...n], uvs: [0, 0, 1, 0, 0, 1, 1, 1],
});
const UP = (() => { const l = Math.hypot(.82, .57); return [0, .82 / l, .57 / l]; })();
const SUN_DIR = (() => { const d = SUN.from.map((v, i) => v - SUN.to[i]), l = Math.hypot(...d); return d.map(v => v / l); })();
const SUN_POS = SUN.to.map((v, i) => v + SUN_DIR[i] * 30);
// 光柱：顺着阳光方向的三片软片（位置和 C 版一致），每帧绕自己的轴转到正对镜头
const SHAFTS = [[-.7, .1, 2.2, 1], [2.7, -1.2, 1.3, .7], [-3.6, 2.2, 1.1, .6]];
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function shaft([x, z, w]: number[], eye: number[]) {
  const mid = [x + SUN_DIR[0] * 4.4, SUN_DIR[1] * 4.4, z + SUN_DIR[2] * 4.4];
  let side = cross(SUN_DIR, eye.map((v, i) => v - mid[i])); const l = Math.hypot(...side); side = side.map(v => v / l * w / 2);
  const at = (u: number, v: number) => mid.map((m, i) => m + side[i] * u + SUN_DIR[i] * 4.5 * v);
  return { positions: [...at(-1, 1), ...at(1, 1), ...at(-1, -1), ...at(1, -1)], indices: [0, 2, 1, 1, 2, 3], uvs: [0, 0, 1, 0, 0, 1, 1, 1] };
}
const TILT = -.16;                                                     // 卡片往后仰一点，和 C 版一致

function Unit({ u, f }: { u: typeof UNITS[number], f: number }) {
  const { size, lift } = spriteBox(u), team = u.team === 'own' ? 'teal' : 'red', s = u.team === 'own' ? -1 : 1;
  const x = tileX(u.row), z = tileZ(u.lane), map = pixel(`${u.atlas}_idle.png`);
  return <>
    <Mesh3d name={`unit-${u.id}`} transform={Transform.fromXyz(x, TOP + lift * Math.cos(TILT), z + .12 + lift * Math.sin(TILT)).withRotation(Quat.fromEuler('XYZ', TILT, 0, 0))}>
      <BufferMesh {...quad(size, size, UP)} />
      <StandardMaterial base_color="#d8d8d8" base_color_texture={map} emissive={glow('#ffffff', .3)} emissive_texture={map} perceptual_roughness={1} reflectance={0}
        uv_transform={Affine2.fromScaleAngleTranslation([1 / u.frames, 1], 0, [spriteFrame(u, f) / u.frames, 0])} alpha_mode={{ Mask: .5 }} double_sided cull_mode={null} />
    </Mesh3d>
    <Mesh3d name={`ring-${u.id}`} shadow={false} transform={Transform.fromXyz(x, TOP + .006, z + .14).withRotation(Quat.fromEuler('XYZ', -Math.PI / 2, 0, 0))}>
      <BufferMesh {...quad(.85, .45)} />
      <StandardMaterial base_color="#000000" base_color_texture={pixel(`ring-${team}.png`)} emissive={glow('#ffffff', 5)} emissive_texture={pixel(`ring-${team}.png`)} alpha_mode="Blend" perceptual_roughness={1} reflectance={0} />
    </Mesh3d>
    <Mesh3d name={`badge-${u.id}`} shadow={false} transform={Transform.fromXyz(x + s * LX * .33, TOP + .2, z + .44).withRotation(Quat.fromEuler('XYZ', -.3, 0, 0))}>
      <BufferMesh {...quad(.34, .34)} />
      <StandardMaterial base_color="#000000" base_color_texture={pixel(`badge-${team}-${u.str}.png`)} emissive={glow('#ffffff', 4)} emissive_texture={pixel(`badge-${team}-${u.str}.png`)} alpha_mode={{ Mask: .5 }} perceptual_roughness={1} reflectance={0} />
    </Mesh3d>
  </>;
}

function Piece() {
  const f = useCurrentFrame(), sec = f / FPS, cam = cameraAt(f);
  const focus = Math.hypot(...cam.look.map((v, i) => v - cam.pos[i]));
  return <AbsoluteFill style={{ background: BACKDROP }}>
    <Canvas3D layered>
      <Camera3d transform={Transform.fromXyz(...cam.pos).lookingAt(cam.look)} projection={{ Perspective: { fov: cam.fov * Math.PI / 180, near: 2, far: 60 } }}>
        <DepthOfField focal_distance={focus} aperture_f_stops={LOOK.dof.fStops} max_circle_of_confusion_diameter={LOOK.dof.maxBlur} mode="Bokeh" />
      </Camera3d>
      <Shadows distance={45} firstCascade={14} mapSize={4096} />
      <AmbientLight brightness={LOOK.ambient} color={LOOK.ambientColor} />
      <DirectionalLight transform={Transform.fromXyz(...SUN_POS).lookingAt(SUN.to)} color={SUN.color} illuminance={LOOK.sun} shadow_maps_enabled volumetric />
      <DirectionalLight transform={Transform.fromXyz(0, 9, 16).lookingAt([0, 0, 0])} color="#9fb6d6" illuminance={LOOK.fill} />
      {LAMPS.map((l, i) => {
        const k = l.kind === 'team' || l.kind === 'window' ? 1 : flicker(i, sec);
        const x = l.x + (l.kind === 'lantern' && !l.id.startsWith('stone') && l.id !== 'foreground' ? .3 : 0), y = l.y + (l.kind === 'brazier' ? .35 : 0), z = l.z + (l.kind === 'window' ? .5 : 0);
        return <PointLight key={l.id} transform={Transform.fromXyz(x, y, z)} color={l.color} intensity={LOOK.lamp * l.power * k} range={l.kind === 'team' ? 5 : 9} radius={.08} shadow_maps_enabled={Boolean(l.shadow)} />;
      })}
      <VolumetricFog ambient={0} />
      <FogVolume name="air" position={[0, 7, 4]} scale={[30, 16, 34]} density={LOOK.fog.density} color="#ffe2b8" scattering={1} absorption={0} anisotropy={.15} />

      {/* 两个模型本来就是同一个场景拆开的，互相穿插是有意的（allowOverlap）。
          发光件在 three 里是不受光的纯色，过资产桥后成了「暗底 + 自发光」：强度按这边的曝光重新给，颜色才不会冲成白块 */}
      <Model name="arena" src={staticFile('arena.glb')} sampler={{ filter: 'nearest' }} allowOverlap />
      <Model name="arena-soft" src={staticFile('arena-soft.glb')} sampler={{ filter: 'nearest' }} shadow={false} allowOverlap>
        <StandardMaterial material="arena-glow-fire" emissive={glow('#ff7a22', 10)} />
        <StandardMaterial material="arena-glow-fire-core" emissive={glow('#ffc46a', 18)} />
        <StandardMaterial material="arena-glow-lamp" emissive={glow('#ff9d45', 13)} />
        <StandardMaterial material="arena-glow-line" emissive={glow('#ffdc96', 5)} />
      </Model>
      {/* 城门血量牌：过桥后贴图材质成了一片白，这里各盖一张不受光的像素牌（和 diorama.js 里牌子的位置、仰角一致，贴在牌面前 7 毫米）。
          圈、战力牌、血量牌都是「黑底 + 贴图自发光」：不受光的材质在这里不吃曝光，会发灰 */}
      {(['own', 'foe'] as const).map(side => { const s = side === 'own' ? -1 : 1, off = .032;
        return <Mesh3d key={side} name={`plaque-${side}`} shadow={false} transform={Transform.fromXyz(s * GATE_X + s * .08, 3.2 + off * Math.sin(.3), .2 + off * Math.cos(.3)).withRotation(Quat.fromEuler('XYZ', -.3, 0, 0))}>
          <BufferMesh {...quad(1, .5)} />
          <StandardMaterial base_color="#000000" emissive={glow('#ffffff', 4.5)} emissive_texture={pixel(`plaque-${side}.png`)} perceptual_roughness={1} reflectance={0} />
        </Mesh3d>; })}
      {UNITS.map(u => <Unit key={u.id} u={u} f={f} />)}
      {SHAFTS.map((sh, i) => <Mesh3d key={i} name={`shaft-${i}`} shadow={false}>
        <BufferMesh {...shaft(sh, cam.pos)} />
        <StandardMaterial base_color={Srgba.hex(SUN.color).with_alpha(LOOK.shaft * sh[3] * (1 + .12 * Math.sin(sec * .9 + i * 2)))} base_color_texture={staticFile('shaft.png')} alpha_mode="Blend" unlit double_sided cull_mode={null} />
      </Mesh3d>)}
      {Array.from({ length: MOTES }, (_, i) => {
        const m = moteAt(i, sec);
        return <Mesh3d key={i} name={`mote-${i}`} shadow={false} transform={Transform.fromXyz(m.x, m.y, m.z)}>
          <Sphere radius={m.fire ? .022 : .014} />
          <StandardMaterial base_color="#000000" emissive={m.fire ? glow('#fff08a', 5 * m.glow) : glow('#e8d0a0', 1.1 * m.glow)} />
        </Mesh3d>;
      })}

      <Bloom intensity={LOOK.bloom.intensity} threshold={LOOK.bloom.threshold} />
      <Grade vignette={LOOK.grade.vignette} temperature={LOOK.grade.temperature} saturation={LOOK.grade.saturation} />
      <ToneMapping mode="aces" exposure={LOOK.exposure} />
    </Canvas3D>
  </AbsoluteFill>;
}
registerRoot(() => <Composition id="film" component={Piece} width={W} height={H} fps={FPS} durationInFrames={FRAMES} />);
