// 北冥引擎 · 原生层 · 资产桥（浏览器端）：把 engine/form/bend.js 的脊柱弯曲波（原本在 GPU 顶点着色器里）换成 glTF 骨骼。
// 任何用 pitchWave / pitchYawWave / frameWave 弯曲的长条生物都能用：沿 x 轴放一串站点骨骼，每帧按 wave.bend(x, t) 摆姿态。
//
//   spineRig(root, stations, { prefix, scale })  在 root 下建共同根骨 `<prefix>-rig` + 站点骨 `<prefix>-spine-NN`（源坐标 x × scale）
//                                                → { rig, bones, skeleton }（已 calculateInverses）
//   poseSpine(bones, stations, wave, t, scale)   第 i 根骨：位置 (x, dy, 0)·scale，绕 Z 转 th；[dy, th] = wave.bend(stations[i], t)
//   配套：geometry.mjs 的 stationWeights 给顶点分配相邻两根站点骨的权重。
import * as T from 'three';

const Z = new T.Vector3(0, 0, 1);

export function spineRig(root, stations, { prefix, scale }) {
  const rig=new T.Bone();rig.name=`${prefix}-rig`;root.add(rig);
  const bones=stations.map((x,i)=>{const b=new T.Bone();b.name=`${prefix}-spine-${String(i).padStart(2,'0')}`;b.position.x=x*scale;rig.add(b);return b;});
  root.updateMatrixWorld(true);
  const skeleton=new T.Skeleton([rig,...bones]);skeleton.calculateInverses();
  return {rig,bones,skeleton};
}

export function poseSpine(bones, stations, wave, t, scale) {
  for(let i=0;i<bones.length;i++) {const [dy,th]=wave.bend(stations[i],t);bones[i].position.set(stations[i]*scale,dy*scale,0);bones[i].quaternion.setFromAxisAngle(Z,th);}
}
