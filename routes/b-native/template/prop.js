// {{TITLE}} · 程序化道具：一盏浮标灯。准备阶段由 engine/native/bridge/export.mjs 在浏览器里调用 createProp(args)，
// 逐帧调用返回值的 pose(t) 采样出 Idle 动作，导出成 media/prop.glb。换道具就改这个文件（或在 film.json 里指向别的模块）。
//   createProp({ colors, period }) → { group, length, pose(t) }
//     colors  { body, band, cap, lamp }（十六进制）；lamp 用 MeshBasicMaterial + HDR 倍数，导出时变成自发光
//             材质名 body / band / post / lamp / cap / vane → GLB 里是 prop-body … prop-lamp
//     period  一次起伏的秒数；动作首尾相接，原生端按 period 循环播放
// 造型用 engine/form 的件（dome 半球），动作只改子节点的位置 / 旋转——根节点由原生场景摆放，不记动作；
// 动作公式在 motion.js（纯函数，film.tsx 也用它）。
import * as THREE from 'three';
import { dome } from '../../engine/form/props.js';
import { idle, LAMP_HEIGHT } from './motion.js';

export function createProp({ colors = { body: '#E8D9C4', band: '#C8463C', cap: '#2A2D52', lamp: '#FFD9A0' }, period = 3 } = {}) {
  // 材质起名：导出后叫 prop-<名字>，film.tsx 可以按名字单独覆盖（例如让灯保持自发光）
  const std = (c, name) => Object.assign(new THREE.MeshStandardMaterial({ color: c, roughness: .8, metalness: 0 }), { name });
  const group = new THREE.Group(); group.name = 'prop';
  const float = new THREE.Group(); float.name = 'prop-float'; group.add(float);

  // 浮体：车削出的圆肚，底部收窄（单位：米，总高约 1.6）
  const profile = [[0, -.35], [.32, -.3], [.46, -.1], [.48, .1], [.4, .3], [.16, .42], [0, .44]].map(([x, y]) => new THREE.Vector2(x, y));
  const body = new THREE.Mesh(new THREE.LatheGeometry(profile, 40), std(colors.body, 'body')); body.name = 'prop-body'; float.add(body);
  const band = new THREE.Mesh(new THREE.TorusGeometry(.47, .045, 12, 48), std(colors.band, 'band')); band.name = 'prop-band'; band.rotation.x = Math.PI / 2; float.add(band);
  const post = new THREE.Mesh(new THREE.CylinderGeometry(.05, .07, .7, 16), std(colors.cap, 'post')); post.name = 'prop-post'; post.position.y = .75; float.add(post);
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(.13, 24, 16), new THREE.MeshBasicMaterial({ name: 'lamp', color: new THREE.Color(colors.lamp).multiplyScalar(2.2) }));
  lamp.name = 'prop-lamp'; lamp.position.y = LAMP_HEIGHT; float.add(lamp);
  const cap = new THREE.Mesh(dome(24, 10, [.2, .14, .2]), std(colors.cap, 'cap')); cap.name = 'prop-cap'; cap.position.y = 1.25; float.add(cap);
  // 绕灯转的小风标：单独一个节点，演示子节点自己的循环动作
  const vane = new THREE.Group(); vane.name = 'prop-vane'; vane.position.y = 1.42; float.add(vane);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(.32, .1, .015), std(colors.band, 'vane')); fin.name = 'prop-vane-fin'; fin.position.x = .16; vane.add(fin);

  // 动作公式在 motion.js（film.tsx 用同一个函数给灯贴页面层光晕）
  const pose = t => {
    const m = idle(t, period);
    float.position.y = m.floatY;
    float.rotation.set(m.rotX, 0, m.rotZ);
    vane.rotation.y = m.vaneY;
  };
  pose(0);
  return { group, length: 1.6, pose };
}
