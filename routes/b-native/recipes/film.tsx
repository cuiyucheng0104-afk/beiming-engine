// 画面配方样张（北冥原生 · BNE）：同一个道具（模版的浮标灯）在四种配方下各一秒，`--at 12,36,60,84` 就是四张样张。
// 配方说明（灯光、色板、材质、后期顺序）在 routes/b-native/README.md「画面工艺」的配方表；这里是可直接改、可直接渲的实现。
//   0–1 秒  Toon 三渲二      暖主光 + 冷环境光；steps 3 + 暖边缘光 + 墨色描边；灯单独保留自发光；页面层灯晕 → 纸纹 → 暗角
//   1–2 秒  PBR 风格化       三点光（暖主光、冷补光、背后轮廓光）；按材质名给粗糙度 / 金属度 / 清漆（颜色仍是模型的）；AgX → gradePass → 暗角
//   2–3 秒  绘画卡片合成     天空底板 + 前后云卡夹住主体（cardInView 按屏幕框摆，截断边在画外、上下边烘软边）→ 纸纹 → 暗角
//   3–4 秒  水墨线描         顶光平光；steps 2、按材质名给纸色 / 淡墨 / 一条朱砂、2.8 px 墨线；灯关掉自发光；纸纹加重、不加暗角
// 四个镜头的道具各用不同的 name：运行时按名字跨帧沿用实体，同名时换了材质覆盖也不生效（2026-11-10 实测）。
// 渲样张：node engine/native/prepare.mjs routes/b-native/recipes && node engine/render/native.mjs routes/b-native/recipes --at 12,36,60,84
import { AbsoluteFill, Composition, registerRoot, staticFile, useCurrentFrame } from 'raea';
import { AmbientLight, DirectionalLight } from 'raea/light';
import { Transform } from 'raea/transform';
import { ToneMapping, FramePass, Canvas3D, Model } from 'raea/3d';
import { StandardMaterial } from 'raea/pbr';
import {
  palette, shotAt, project, cardInView, ShotCamera, Backdrop, PlateCard, ToonModel, PaperOverlay, Vignette, Glow, gradePass,
} from '../../../engine/native/index.ts';
import { lampAt } from '../template/motion.js';
import film from './film.json';
import data from './palette.json';

const P = palette(data);
const [W, H] = film.size, FPS = film.fps, DUR = film.dur, K = H / 1080;
const CLIP = film.native.models[0].clip.duration;
const SHOTS = [
  { until: 1, eye: [[-2.6, 1.55, 7.2], [-2.3, 1.5, 6.6]], at: [-1.1, .95, 0], fov: 32, ease: 'ss' },
  { until: 2, eye: [[3.0, 1.7, 5.0], [2.7, 1.6, 4.5]], at: [.55, .8, 0], fov: 30, ease: 'ss' },
  { until: 3, eye: [[-1.6, 1.25, 9.6], [-1.3, 1.2, 8.8]], at: [-.2, .9, 0], fov: 30, ease: 'ss' },
  { until: 4, eye: [[-.9, 1.05, 6.6], [-.8, 1.05, 6.0]], at: [-.75, .85, 0], fov: 30, ease: 'ss' },
];
const NAMES = ['配方 1 · Toon 三渲二', '配方 2 · PBR 风格化', '配方 3 · 绘画卡片合成', '配方 4 · 水墨线描'];
const startOf = i => (i ? SHOTS[i - 1].until : 0);
const camAt = i => shotAt(startOf(i), SHOTS);
// 配方 3 的两张云卡：按第三镜起点的屏幕框摆（左卡截断的左边、右卡截断的右边都在画外）
const CLOUD_L = cardInView({ cam: camAt(2), left: -0.38, cy: 0.78, width: 0.78, depth: 6 }, [W, H]);
const CLOUD_R = cardInView({ cam: camAt(2), left: 0.58, cy: 0.62, width: 0.9, depth: 14 }, [W, H]);
const GRADE = gradePass({ exposure: 1.02, warmth: .18, saturation: .9, lift: .015, gamma: 1.0, gain: 1.0 });
const SKY_H = H * 1.12, SKY_W = SKY_H * 3548 / 1774;
// 水墨线描：全局卡通覆盖只换明暗处理、不换各材质自己的颜色，所以按材质名逐个给色——纸色的形、淡墨的柱与罩、一条朱砂带；
// 灯关掉自发光（emissive 黑），不让它在纸上「亮」
const inkLine = { width: 2.8 * K, color: P.inkLine };
const INK_PARTS = [
  { materials: ['prop-body', 'prop-lamp'], toon: { steps: 2, base_color: P.inkBase, shadow_color: P.inkShade, emissive: '#000000', outline: inkLine } },
  { materials: ['prop-post', 'prop-cap', 'prop-vane'], toon: { steps: 2, base_color: P.inkWash, shadow_color: P.inkLine, outline: inkLine } },
  { materials: ['prop-band'], toon: { steps: 2, base_color: P.inkAccent, shadow_color: P.inkAccent, outline: inkLine } },
];

function Piece() {
  const f = useCurrentFrame(), t = f / FPS, cam = shotAt(t, SHOTS), shot = cam.index;
  const lamp = project(lampAt(t % CLIP, CLIP), cam, [W, H]);
  const lampR = .13 * (H / 2) / Math.tan(cam.fov * Math.PI / 360) / lamp.depth;
  const local = t - startOf(shot);
  const toonPainted = { steps: 3, shadow_color: P.toonShade, rim: { intensity: .45, width: .22, color: P.toonRim }, outline: { width: 1.6 * K, color: P.ink } };
  const lampPart = { materials: ['prop-lamp'], toon: { steps: 2, base_color: P.lamp, shadow_color: P.lamp, emissive: P.lamp, outline: false } };
  const backdrop = shot === 1
    ? <div style={{ position: 'absolute', left: 0, top: 0, width: W, height: H, background: `linear-gradient(180deg, ${P.pbrTop} 0%, ${P.pbrBottom} 100%)` }} />
    : shot === 3
      ? <div style={{ position: 'absolute', left: 0, top: 0, width: W, height: H, backgroundColor: P.inkPaper }} />
      : <Backdrop src={staticFile('sky.png')} t={local} x={(W - SKY_W) / 2} y={-40 * K} width={SKY_W} height={SKY_H} drift={[-8 * K, 0]} />;
  return <AbsoluteFill style={{ background: shot === 3 ? P.inkPaper : P.toonSky }}>
    {backdrop}
    <Canvas3D layered>
      <ShotCamera t={t} shots={SHOTS} near={.05} far={200} />
      {shot === 1 ? <>
        <AmbientLight brightness={90} color={P.pbrAmbient} />
        <DirectionalLight transform={Transform.fromXyz(-4, 4, 5).lookingAt([0, .8, 0])} color={P.pbrKey} illuminance={9000} shadow_maps_enabled />
        <DirectionalLight transform={Transform.fromXyz(5, 1.5, 3).lookingAt([0, .8, 0])} color={P.pbrFill} illuminance={2200} />
        <DirectionalLight transform={Transform.fromXyz(1, 3, -5).lookingAt([0, .8, 0])} color={P.pbrRim} illuminance={7000} />
        <ToneMapping mode="agx" />
        <FramePass wesl={GRADE} />
      </> : shot === 3 ? <>
        <AmbientLight brightness={420} color={P.inkPaper} />
        <DirectionalLight transform={Transform.fromXyz(0, 6, 1).lookingAt([0, 0, 0])} color={P.inkPaper} illuminance={4000} />
        <ToneMapping mode="none" />
      </> : <>
        <AmbientLight brightness={190} color={P.toonAmbient} />
        <DirectionalLight transform={Transform.fromXyz(-6, 3.2, 4).lookingAt([0, .8, 0])} color={P.toonKey} illuminance={9500} shadow_maps_enabled />
        <ToneMapping mode="none" />
      </>}
      {shot === 0 && <PlateCard name="mist-back" src={staticFile('mist.png')} t={local} position={[-1, .25, -6]} drift={[-.1, 0, 0]} width={34} />}
      {shot === 2 && <>
        <PlateCard name="mist-back" src={staticFile('mist.png')} t={local} position={[0, -.2, -12]} drift={[-.12, 0, 0]} width={46} />
        <PlateCard name="cloud-right" src={staticFile('cloud_b.png')} t={local} position={CLOUD_R.position} rotation={CLOUD_R.rotation} width={CLOUD_R.width} drift={[.25, 0, 0]} />
      </>}
      {shot === 1
        ? <Model name="prop-pbr" src={staticFile('prop.glb')} animation="Idle" time={t % CLIP} loop position={[0, 0, 0]}>
            {/* PBR 风格化：按材质名给「做工」——漆面半光、红带清漆、金属灯柱与灯罩；颜色仍是模型自己的 */}
            <StandardMaterial material="prop-body" perceptual_roughness={.42} />
            <StandardMaterial material="prop-band" perceptual_roughness={.28} clearcoat={.6} />
            <StandardMaterial material="prop-post" perceptual_roughness={.32} metallic={.75} />
            <StandardMaterial material="prop-cap" perceptual_roughness={.3} metallic={.7} />
          </Model>
        : shot === 3
          ? <ToonModel name="prop-ink" src={staticFile('prop.glb')} animation="Idle" time={t % CLIP} loop position={[0, 0, 0]} parts={INK_PARTS} />
          : <ToonModel name={shot === 0 ? 'prop-toon' : 'prop-cards'} src={staticFile('prop.glb')} animation="Idle" time={t % CLIP} loop position={[0, 0, 0]} toon={toonPainted} parts={[lampPart]} />}
      {shot === 0 && <PlateCard name="mist-front" src={staticFile('mist.png')} t={local} position={[.4, -.55, 1.6]} drift={[.12, 0, 0]} width={16} />}
      {shot === 2 && <PlateCard name="cloud-left" src={staticFile('cloud_a.png')} t={local} position={CLOUD_L.position} rotation={CLOUD_L.rotation} width={CLOUD_L.width} drift={[-.2, 0, 0]} />}
    </Canvas3D>
    {shot !== 3 && <Glow x={lamp.x} y={lamp.y} radius={lampR * (shot === 1 ? 4 : 6)} color={P.glow} strength={shot === 1 ? .55 : .9} core={.2} />}
    {shot !== 1 && <PaperOverlay src={staticFile('paper.png')} f={f} width={W} height={H} opacity={shot === 3 ? .22 : .13} />}
    {shot !== 3 && <Vignette width={W} height={H} strength={shot === 1 ? .32 : .22} />}
    {/* 样张标签：左上安全区里（左 ≥ 5% 画宽、上 ≥ 120/1080 画高），不压主体 */}
    <div style={{ position: 'absolute', left: Math.round(.06 * W), top: Math.round(.12 * H), fontSize: 34 * K, letterSpacing: 3 * K,
      color: shot === 3 ? P.inkLine : P.caption, textShadow: shot === 3 ? 'none' : `0 ${2 * K}px ${10 * K}px rgba(20,16,48,0.7)` }}>{NAMES[shot]}</div>
  </AbsoluteFill>;
}
registerRoot(() => <Composition id="recipes" component={Piece} width={W} height={H} fps={FPS} durationInFrames={Math.round(DUR * FPS)} />);
