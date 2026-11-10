// 《北冥》10 秒原生例片：只写这部片子的编排。机位、站位、天空铺法、片名框在 layout.js（纯函数，tests/native 逐帧核对）；
// 片长、尺寸、素材清单、事件帧号在 film.json；通用件来自 engine/native。
// 画面做法（routes/b-native/README.md「画面工艺」）：
//   层次   二维天空底板（跟着镜头摇 / 仰移动，像在无穷远）→ 远云堤 → 天际线（等比，水岸线压在江面上）→ 江面着色器
//          → 鲲（GLB，Swim 一拍三，卡通材质 + 边缘光）→ 近景云（按镜头摆，截断边始终在画外，上下边烘了有机软边）→ 渡船与尾迹
//   时间   鲲的位置、姿态和 Swim 片段都按一拍三（heldTime）走；摄影、船、水面按 24 帧；片名在 film.json 的 title 帧起笔
//   质感   纸纹是页面层整幅叠层、一拍二换一张「纸」（不钉在屏幕上）；暗角盖住天空与三维两层；不开距离雾（canary 的预乘雾会
//          露出透明面片的矩形边），空气感由远层底板的冷色和江面远端淡出给出
//   片名   A 路的毛笔片名页面（title/）在准备阶段渲成透明逐帧 PNG，这里用 <FrameSequence> 叠上去——按笔顺写出、收笔带飞白
import { AbsoluteFill, Composition, registerRoot, staticFile, useCurrentFrame } from 'raea';
import { AmbientLight, DirectionalLight } from 'raea/light';
import { Transform } from 'raea/transform';
import { ToneMapping, Bloom, Shadows, ShaderMesh, Canvas3D } from 'raea/3d';
import {
  palette, shotAt, skyShift, headingYaw, behind, cardInView, ShotCamera, Backdrop, PlateCard, ToonBox, ToonModel, FrameSequence,
  PaperOverlay, Vignette, waterWesl, ribbonWesl,
} from '../../engine/native/index.ts';
import { layout, eventSeconds } from './layout.js';
import film from './film.json';
import data from './palette.json';
import titleSheet from './media/title.json';

const P = palette(data);
const [W, H] = film.size, FPS = film.fps, FRAMES = Math.round(film.dur * FPS);
const L = layout({ W, H, FPS, frames: FRAMES, cuts: film.shots.map(s => s.out) }, { shotAt, skyShift, headingYaw, behind, cardInView });
const EV = eventSeconds(film);

// 近岸栏杆：与阴影同色的实心卡通块（只在第一镜，给出可量的前景视差）
const railToon = { base_color: P.rail, shadow_color: P.rail, steps: 3 };

const WATER = waterWesl({ texture: 'water', span: [170, 160], origin: [.5, 30], gain: .37, lift: [.018, .022, .055], glint: { color: [.14, .08, .04], x: -26, width: 13 }, fade: [85, 200] });
const WAKE = ribbonWesl({ color: [.76, .53, .55], alpha: .45, edge: { base: .025, taper: .29 }, width: .027, tear: [91, 1.4, 137, 31] });

const KUN_RIM = { intensity: .40, width: .20, color: P.warm };
const KUN_PARTS = [
  { materials: ['kun-body-PBR', 'kun-flukes-PBR', 'kun-fin-R-PBR', 'kun-fin-L-PBR'], toon: { steps: 3, rim: KUN_RIM, outline: { width: 1.5, color: P.ink } } },
  { materials: ['kun-weed-clumps-PBR', 'kun-kelp-PBR'], toon: { steps: 3, base_color: P.weed, shadow_color: P.weedShade, rim: { intensity: .18, width: .13, color: P.warm }, outline: false } },
];

function Piece() {
  const f = useCurrentFrame(), t = f / FPS;
  const shot = shotAt(t, L.shots).index, sky = L.sky(shot), [dx, dy] = skyShift(t, L.shots, [W, H]);
  const kun = L.kun(f), ferry = L.ferry(t);
  return <AbsoluteFill style={{ background: P.sky }}>
    <Backdrop src={staticFile('sky_dawn.png')} t={t} x={sky.x + dx} y={sky.y + dy} width={sky.width} height={sky.height} />
    <Canvas3D layered>
      <ShotCamera t={t} shots={L.shots} near={.1} far={600} />
      <AmbientLight brightness={160} color={P.ambient} />
      <DirectionalLight transform={Transform.fromXyz(-30, 22, 20).lookingAt([0, 7, 0])} color={P.warm} illuminance={11500} shadow_maps_enabled />
      <ToneMapping mode="none" />
      <Shadows mapSize={2048} distance={140} firstCascade={70} cascades={2} />
      <Bloom intensity={.12} threshold={1.2} />
      {L.cards.filter(c => c.shots.includes(shot)).map(c =>
        <PlateCard key={c.name} name={c.name} src={staticFile(c.src)} t={t} position={c.position} drift={c.drift} width={c.width} rotation={c.rotation} />)}
      <ShaderMesh name="river" shape={{ primitive: 'Plane3d', half_size: [350, 350] }} wesl={WATER} textures={{ water: 'media/river.png' }} alpha="blend" position={[0, -.25, -40]} />
      <ToonModel name="kun" src={staticFile('kun.glb')} animation="Swim" time={kun.clip} loop position={kun.position} rotation={kun.rotation}
        toon={{ steps: 3, rim: KUN_RIM, outline: false }} parts={KUN_PARTS} />
      <ToonModel name="ferry" src={staticFile('ferry.glb')} position={ferry.position} rotation={[.025 * Math.sin(t * 2.2), ferry.yaw, .018 * Math.cos(t * 2)]} scale={2}
        toon={{ steps: 3, rim: { intensity: .15, width: .15, color: P.warm }, outline: { width: 1.3, color: P.ink } }} />
      <ShaderMesh name="wake" shape={{ primitive: 'Plane3d', half_size: [5, 1.8] }} wesl={WAKE} alpha="blend" position={ferry.wake} rotation={[0, ferry.yaw, 0]} />
      {shot === 0 && <>
        <ToonBox name="foreground-rail" at={[-19, 1.4, 25]} size={[12, .13, .17]} toon={railToon} />
        {[-24, -19, -14].map((x, i) => <ToonBox key={i} name={'rail-' + i} at={[x, .7, 25]} size={[.15, 1.4, .15]} toon={railToon} />)}
      </>}
    </Canvas3D>
    <PaperOverlay src={staticFile('paper.png')} f={f} width={W} height={H} opacity={.12} />
    <Vignette width={W} height={H} strength={.20} />
    <FrameSequence dir="title" sheet={titleSheet} t={t} start={EV.title} style={{ width: W, height: H }} />
  </AbsoluteFill>;
}
registerRoot(() => <Composition id="beiming-raea" component={Piece} width={W} height={H} fps={FPS} durationInFrames={FRAMES} />);
