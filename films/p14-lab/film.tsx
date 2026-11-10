import { AbsoluteFill, Composition, registerRoot, staticFile, useCurrentFrame } from 'raea';
import { AmbientLight, DirectionalLight } from 'raea/light';
import { Transform } from 'raea/transform';
import { ToneMapping, Canvas3D, ImagePlane } from 'raea/3d';
import { ShotCamera, ToonModel } from '../../engine/native/index.ts';

function Piece() {
  const f = useCurrentFrame(), t = f / 24;
  const mode = f % 4;
  return <AbsoluteFill style={{ background: '#8E86C9' }}>
    <img src={staticFile('backdrop.png')} style={{ position: 'absolute', left: 0, top: 0, width: 960, height: 540 }} />
    <Canvas3D layered>
      <ShotCamera t={t} shots={[{ until: 1, eye: [0, 1.2, 8], at: [0, 1, 0], fov: 40 }]} />
      <AmbientLight brightness={180} />
      <DirectionalLight transform={Transform.fromXyz(-4, 6, 5).lookingAt([0, 1, 0])} illuminance={9000} />
      <ToneMapping mode="none" />
      <ImagePlane name="cloud" src={staticFile('clouds_front_a.png')} width={9} position={[-2.5, 1, -6]} shadow={false} />
      <ToonModel name="prop" src={staticFile('prop.glb')} animation="Idle" time={t % 3} loop position={[1.5, 0, 0]} toon={{ steps: 3, outline: { width: 1.2, color: '#232647' } }} />
    </Canvas3D>
    {mode === 1 && <img src={staticFile('paper.png')} style={{ position: 'absolute', left: -40, top: -30, width: 1100, height: 620, opacity: 0.9, mixBlendMode: 'multiply' }} />}
    {mode === 2 && <div style={{ position: 'absolute', left: 0, top: 0, width: 960, height: 540, background: 'radial-gradient(ellipse at center, rgba(0,0,0,0) 40%, rgba(20,10,40,0.6) 100%)' }} />}
    {mode === 3 && <div style={{ position: 'absolute', left: 300, top: 100, width: 200, height: 120, overflow: 'hidden', background: '#ff000040' }}>
      <img src={staticFile('paper.png')} style={{ position: 'absolute', left: -100, top: -100, width: 600, height: 400 }} /></div>}
    <div style={{ position: 'absolute', left: 40, top: 380, fontSize: 64, color: '#FFF6EC', letterSpacing: 8, filter: mode === 0 ? 'blur(6px)' : 'none', textShadow: '0 0 18px rgba(255,200,150,0.9)' }}>测试</div>
  </AbsoluteFill>;
}
registerRoot(() => <Composition id="film" component={Piece} width={960} height={540} fps={24} durationInFrames={24} />);
