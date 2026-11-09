// 《北冥》10 秒原生例片：只写这部片子的编排（镜头、站位、时间、色板取名）。
// 通用件来自 engine/native（镜头、面片视差、卡通材质、片名、后期、水面与尾迹着色器、确定性数学）。
import { AbsoluteFill, Composition, registerRoot, staticFile, useCurrentFrame } from 'raea';
import { AmbientLight, DirectionalLight } from 'raea/light';
import { Transform } from 'raea/transform';
import { ToneMapping, Bloom, Shadows, FramePass, ShaderMesh, Canvas3D } from 'raea/3d';
import {
  clamp, lerp, heldTime, palette, ShotCamera, Backdrop, PlateCard, drift,
  ToonBox, ToonModel, FontFace, TitleCard, paperPass, waterWesl, ribbonWesl,
} from '../../engine/native/index.ts';
import data from './palette.json';
import { TITLE_FONT } from './title-font.ts';

const P = palette(data);
const W = 1920, H = 1040, FPS = 24;

// 三个镜头：渡船建立尺度 → 鲲眼近景 → 拉开收片名（3.5 秒 / 6 秒切）
const SHOTS = [
  { until: 3.5, eye: [[-11, 4, 38], [-6, 5, 31]], at: [1, 7.4, -1], fov: 40 },
  { until: 6, eye: [[17, 12.2, 10], [19, 13.1, 7.8]], at: [10.8, 12.3, -1], fov: 34 },
  { until: 10, eye: [[26, 17, 29], [30, 21, 35]], at: [3, 10, -1], fov: 42 },
];

// 近岸栏杆：与阴影同色的实心卡通块
const railToon = { base_color: P.rail, shadow_color: P.rail, steps: 3 };

const WATER = waterWesl({ texture: 'water', span: [170, 160], origin: [.5, 30], gain: .37, lift: [.018, .022, .055], glint: { color: [.14, .08, .04], x: -26, width: 13 }, fade: [85, 200] });
const WAKE = ribbonWesl({ color: [.76, .53, .55], alpha: .45, edge: { base: .025, taper: .29 }, width: .027, tear: [91, 1.4, 137, 31] });
const PAPER = paperPass({ size: [W, H], grain: .018, vignette: .12 });

const KUN_RIM = { intensity: .40, width: .20, color: P.warm };
const KUN_PARTS = [
  { materials: ['kun-body-PBR', 'kun-flukes-PBR', 'kun-fin-R-PBR', 'kun-fin-L-PBR'], toon: { steps: 3, rim: { intensity: .40, width: .2, color: P.warm }, outline: { width: 1.5, color: P.ink } } },
  { materials: ['kun-weed-clumps-PBR', 'kun-kelp-PBR'], toon: { steps: 3, base_color: P.weed, shadow_color: P.weedShade, rim: { intensity: .18, width: .13, color: P.warm }, outline: false } },
];

function Piece() {
  const f = useCurrentFrame(), t = f / FPS, q = heldTime(f, 3, FPS);   // 鲲一拍三
  const kun: number[] = [-2 + t * .8, 13 + Math.sin(q * .7) * .45, -2];
  const ferry = drift([-3, .1, 11], [.5, 0, -.65], t);
  return <AbsoluteFill style={{ background: P.sky }}>
    <FontFace family="Beiming" src={TITLE_FONT} />
    <Backdrop src={staticFile('sky_dawn.png')} t={t} x={-60} y={-20} width={2040} height={1105} drift={[-2, 0]} />
    <Canvas3D layered>
      <ShotCamera t={t} shots={SHOTS} near={.1} far={600} />
      <AmbientLight brightness={160} color={P.ambient} />
      <DirectionalLight transform={Transform.fromXyz(-30, 22, 20).lookingAt([0, 7, 0])} color={P.warm} illuminance={11500} shadow_maps_enabled />
      <ToneMapping mode="none" />
      <Shadows mapSize={2048} distance={140} firstCascade={70} cascades={2} />
      {/* 透明面片上不开距离雾：canary 的预乘雾会露出面片矩形边缘 */}
      <Bloom intensity={.12} threshold={1.2} />
      <FramePass wesl={PAPER} />
      <PlateCard name="cloud-bank" src={staticFile('clouds_back.png')} t={t} position={[-28, 32, -140]} drift={[.1, 0, 0]} width={150} />
      <PlateCard name="skyline" src={staticFile('skyline_pudong.png')} t={t} position={[-10, 8, -100]} width={180} height={30} />
      <ShaderMesh name="river" shape={{ primitive: 'Plane3d', half_size: [350, 350] }} wesl={WATER} textures={{ water: 'media/river.png' }} alpha="blend" position={[0, -.25, -40]} />
      <ToonModel name="kun" src={staticFile('kun.glb')} animation="Swim" time={(q + 2) % 10} loop position={kun} rotation={[-.08, -.18, lerp(-.05, .10, clamp((t - 6) / 4))]}
        toon={{ steps: 3, rim: KUN_RIM, outline: false }} parts={KUN_PARTS} />
      <PlateCard name="left-cloud" src={staticFile('clouds_front_a.png')} t={t} position={[-34, 8, -25]} drift={[-.6, 0, 0]} width={57} />
      <PlateCard name="right-cloud" src={staticFile('clouds_front_b.png')} t={t} position={[38, 7, -31]} drift={[.9, 0, 0]} width={63} />
      <ToonModel name="ferry" src={staticFile('ferry.glb')} position={ferry} rotation={[.025 * Math.sin(t * 2.2), -.45, .018 * Math.cos(t * 2)]} scale={2}
        toon={{ steps: 3, rim: { intensity: .15, width: .15, color: P.warm }, outline: { width: 1.3, color: P.ink } }} />
      <ShaderMesh name="wake" shape={{ primitive: 'Plane3d', half_size: [5, 1.8] }} wesl={WAKE} alpha="blend" position={drift([-7.3, -.23, 8.9], [.5, 0, -.65], t)} rotation={[0, -.45, 0]} />
      {/* 近岸栏杆只在第一镜：可量的前景视差，不是整幅缩放 */}
      {t < 3.5 && <>
        <ToonBox name="foreground-rail" at={[-19, 1.4, 25]} size={[12, .13, .17]} toon={railToon} />
        {[-24, -19, -14].map((x, i) => <ToonBox key={i} name={'rail-' + i} at={[x, .7, 25]} size={[.15, 1.4, .15]} toon={railToon} />)}
      </>}
    </Canvas3D>
    <TitleCard text="北冥" t={t} at={8.1} fade={.5} style={{ left: 120, top: 152, color: P.title, fontFamily: 'Beiming', fontSize: 132, letterSpacing: 20 }} />
  </AbsoluteFill>;
}
registerRoot(() => <Composition id="beiming-raea" component={Piece} width={W} height={H} fps={FPS} durationInFrames={240} />);
