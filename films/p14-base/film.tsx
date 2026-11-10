// 浮标：北冥原生 · BNE 的最小作品。只写编排；通用件来自 engine/native，素材由 film.json 声明、prepare 放进 media/。
// 画面：一张绘画底板（二维视差）+ 一层雾面片（三维视差）+ 程序化浮标灯（GLB，Idle 动作，卡通材质）+ 一段字幕。
import { AbsoluteFill, Composition, registerRoot, staticFile, useCurrentFrame } from 'raea';
import { AmbientLight, DirectionalLight } from 'raea/light';
import { Transform } from 'raea/transform';
import { ToneMapping, FramePass, Canvas3D } from 'raea/3d';
import { palette, ShotCamera, Backdrop, PlateCard, ToonModel, Caption, gradePass, paperPass } from '../../engine/native/index.ts';
import film from './film.json';
import data from './palette.json';

const P = palette(data);
const [W, H] = film.size, FPS = film.fps, DUR = film.dur;
const SHOTS = [{ until: DUR, eye: [[-1.2, 1.7, 6.4], [.4, 1.3, 4.6]], at: [0, .85, 0], fov: 34, ease: 'ss' }];
const GRADE = gradePass({ warmth: .25, saturation: 1.05 });
const CLIP = film.native.models[0].clip.duration;   // Idle 动作一圈的秒数
const PAPER = paperPass({ size: [W, H], grain: .015, vignette: .14 });
// 底板按画面高度铺满（原图 3512×1448），再每秒向左漂 6 像素
const PLATE_H = H + 60, PLATE_W = Math.round(PLATE_H * 3512 / 1448);

function Piece() {
  const f = useCurrentFrame(), t = f / FPS;
  return <AbsoluteFill style={{ background: P.sky }}>
    <Backdrop src={staticFile('backdrop.png')} t={t} x={(W - PLATE_W) / 2} y={-30} width={PLATE_W} height={PLATE_H} drift={[-6, 0]} />
    <Canvas3D layered>
      <ShotCamera t={t} shots={SHOTS} near={.05} far={200} />
      <AmbientLight brightness={180} color={P.ambient} />
      <DirectionalLight transform={Transform.fromXyz(-4, 6, 5).lookingAt([0, 1, 0])} color={P.key} illuminance={9000} shadow_maps_enabled />
      <ToneMapping mode="none" />
      <FramePass wesl={GRADE} />
      <FramePass wesl={PAPER} />
      <PlateCard name="mist" src={staticFile('mist.png')} t={t} position={[0, .2, -5]} drift={[-.12, 0, 0]} width={22} />
      <ToonModel name="prop" src={staticFile('prop.glb')} animation="Idle" time={t % CLIP} loop position={[0, 0, 0]}
        toon={{ steps: 3, rim: { intensity: .35, width: .2, color: P.rim }, outline: { width: 1.2, color: P.ink } }} />
    </Canvas3D>
    <Caption text="浮标" t={t} from={.5} until={DUR - .15} fadeIn={.4} fadeOut={.3} style={{ color: P.caption, fontSize: 56 }} />
  </AbsoluteFill>;
}
registerRoot(() => <Composition id="film" component={Piece} width={W} height={H} fps={FPS} durationInFrames={Math.round(DUR * FPS)} />);
