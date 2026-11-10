// 云海浮标：北冥原生 · BNE 的最小作品。只写编排；通用件来自 engine/native，素材由 film.json 声明、prepare 放进 media/。
// 画面做法（routes/directing 的规范落到这一部片里，见 routes/b-native/README.md「画面工艺」）：
//   构图   主体（浮标灯）在右三分线，片名在左上的天空里：安全区内、不压主体、背后够暗（对比 ≥ 3:1）。机位与版式在 layout.js，
//          node --test tests/native 会用投影核对。
//   层次   二维天空底板 → 远层云海（三维面片，向左漂）→ 浮标（GLB，Idle 起伏，卡通材质 + 描边 + 边缘光）
//          → 近层云海压住浮标底座（向右漂）：前后层夹住主体，视差方向相反，空气感靠画出来的雾，不开距离雾。
//          云海是横向四方连续图，两端是硬切口：film.json 给它烘了有机软边，摆位也让两端始终在画外。
//   质感   纸纹与暗角是页面层整幅叠层（不是只盖三维的 FramePass），纸纹一拍二换一张「纸」，不钉在屏幕上。
//   时间   片名逐字落定；第一个字落定的帧号写在 film.json 的 events（id = "title"），声音脚本读同一个帧号放玻璃铃。
import { AbsoluteFill, Composition, registerRoot, staticFile, useCurrentFrame } from 'raea';
import { AmbientLight, DirectionalLight } from 'raea/light';
import { Transform } from 'raea/transform';
import { ToneMapping, Canvas3D } from 'raea/3d';
import { palette, ShotCamera, Backdrop, PlateCard, ToonModel, TitleReveal, PaperOverlay, Vignette } from '../../engine/native/index.ts';
import { layout } from './layout.js';
import film from './film.json';
import data from './palette.json';

const P = palette(data);
const [W, H] = film.size, FPS = film.fps, DUR = film.dur;
const L = layout({ W, H, DUR });
const CLIP = film.native.models[0].clip.duration;                       // Idle 动作一圈的秒数
const LAND = film.events.find(e => e.id === 'title').frame / FPS;      // 第一个字落定（与玻璃铃同一时刻）
const TITLE = '云海浮标', T = L.title([...TITLE].length);
const [BACK, FRONT] = L.mists;
const Mist = ({ m, t }: { m: typeof BACK, t: number }) => <PlateCard name={m.name} src={staticFile('mist.png')} t={t} position={m.position} drift={m.drift} width={m.width} />;

function Piece() {
  const f = useCurrentFrame(), t = f / FPS;
  return <AbsoluteFill style={{ background: P.sky }}>
    <Backdrop src={staticFile('backdrop.png')} t={t} x={L.backdrop.x} y={L.backdrop.y} width={L.backdrop.width} height={L.backdrop.height} drift={L.backdrop.drift} />
    <Canvas3D layered>
      <ShotCamera t={t} shots={L.shots} near={.05} far={200} />
      <AmbientLight brightness={190} color={P.ambient} />
      <DirectionalLight transform={Transform.fromXyz(-6, 3.2, 4).lookingAt([0, .8, 0])} color={P.key} illuminance={9500} shadow_maps_enabled />
      <ToneMapping mode="none" />
      <Mist m={BACK} t={t} />
      <ToonModel name="prop" src={staticFile('prop.glb')} animation="Idle" time={t % CLIP} loop position={[0, 0, 0]}
        toon={{ steps: 3, shadow_color: P.shade, rim: { intensity: .45, width: .22, color: P.rim }, outline: { width: 1.6, color: P.ink } }} />
      <Mist m={FRONT} t={t} />
    </Canvas3D>
    <PaperOverlay src={staticFile('paper.png')} f={f} width={W} height={H} opacity={.13} />
    <Vignette width={W} height={H} strength={.24} />
    <TitleReveal text={TITLE} t={t} at={LAND - .35} rule={{ width: T.box[2] - T.left - T.letterSpacing, color: P.caption }}
      style={{ left: T.left, top: T.top, fontSize: T.size, letterSpacing: T.letterSpacing, color: P.caption, fontWeight: 500 }} />
  </AbsoluteFill>;
}
registerRoot(() => <Composition id="film" component={Piece} width={W} height={H} fps={FPS} durationInFrames={Math.round(DUR * FPS)} />);
