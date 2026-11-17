// 北冥引擎 · 离屏出片 · 空气透视雾（TSL）：engine/look/fog.js 的对应。
// 按深度重建视空间与世界坐标，雾量随真实距离和世界高度变化（越低越浓），墨线边缘检测也共用同一套雾量公式做远雾淡出。
//
//   fogUniforms({ THREE, TSL }) → uniform 节点表（uFogA、uFogB、uFogLow、uFogHigh、uProjInv、uCamWorld）
//   setFog(THREE, u, fog, camera, fallbackColor)   填 uniform；fog 为空 = 关（只更新相机矩阵）
//   fogNodes(TSL, u) → { viewPosAt(uvTop, depth), fogAmount(dist, worldY), fogColor(dirW) }
//   createFog({ THREE, TSL, renderer }, { width, height }) → { render(src, depthTex, fog, camera, target, fallbackColor), dispose() }
//
// fog 参数：{ color, colorHigh, density = .02, start = 0, max = 1, baseHeight = 0, falloff = 0, cutoff = 1e9, sky = 0 }
import { linVec } from './color.js';
import { createFullscreen } from './pass.js';

export function fogUniforms({ THREE, TSL }) {
  const { uniform } = TSL;
  return {
    uFogA: uniform(new THREE.Vector4()),       // x 密度, y 起始距离, z 最大浓度, w 开关
    uFogB: uniform(new THREE.Vector4()),       // x 基准高度, y 高度衰减(0=不按高度), z 截止距离, w 天空(清屏处)浓度
    uFogLow: uniform(new THREE.Vector3()),     // 低处雾色（线性）
    uFogHigh: uniform(new THREE.Vector3()),    // 高处雾色（线性）
    uProjInv: uniform(new THREE.Matrix4()),
    uCamWorld: uniform(new THREE.Matrix4()),
  };
}

export function setFog(THREE, u, fog, camera, fallbackColor = '#ffffff') {
  if (THREE.WebGPUCoordinateSystem !== undefined && camera.coordinateSystem !== THREE.WebGPUCoordinateSystem) {
    camera.coordinateSystem = THREE.WebGPUCoordinateSystem;
    camera.updateProjectionMatrix();
  }
  u.uProjInv.value.copy(camera.projectionMatrixInverse);
  u.uCamWorld.value.copy(camera.matrixWorld);
  if (!fog) { u.uFogA.value.set(0, 0, 0, 0); return; }
  u.uFogA.value.set(fog.density ?? 0.02, fog.start ?? 0, fog.max ?? 1, 1);
  u.uFogB.value.set(fog.baseHeight ?? 0, fog.falloff ?? 0, fog.cutoff ?? 1e9, fog.sky ?? 0);
  linVec(THREE, fog.color ?? fallbackColor, u.uFogLow.value);
  linVec(THREE, fog.colorHigh ?? fog.color ?? fallbackColor, u.uFogHigh.value);
}

export function fogNodes(TSL, u) {
  const { float, vec4, exp, max, mix, smoothstep, select } = TSL;
  // uvTop 是左上角原点的 [0,1] 坐标，WebGPU 裁剪空间 y 向上为正、z 为 [0,1]
  const viewPosAt = (uvTop, d) => {
    const clip = vec4(uvTop.x.mul(2).sub(1), float(1).sub(uvTop.y).mul(2).sub(1), d, 1);
    const v = u.uProjInv.mul(clip);
    return v.xyz.div(v.w);
  };
  const fogAmount = (dist, worldY) => {
    const dens = select(
      u.uFogB.y.greaterThan(0),
      u.uFogA.x.mul(exp(max(worldY.sub(u.uFogB.x), 0).negate().div(u.uFogB.y))),
      u.uFogA.x,
    );
    const f = float(1).sub(exp(dens.negate().mul(max(dist.sub(u.uFogA.y), 0)))).mul(u.uFogA.z);
    return select(u.uFogA.w.lessThan(0.5).or(dist.greaterThan(u.uFogB.z)), float(0), f);
  };
  const fogColor = dirW => mix(u.uFogLow, u.uFogHigh, smoothstep(-0.05, 0.35, dirW.y));
  return { viewPosAt, fogAmount, fogColor };
}

export function createFog({ THREE, TSL, renderer }, { width: W, height: H }) {
  const { Fn, vec2, vec4, ivec2, texture, screenCoordinate, min, mix, normalize, length, select } = TSL;
  const fx = createFullscreen({ THREE, renderer });
  const dummy = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); dummy.needsUpdate = true;
  const dummyDepth = new THREE.DepthTexture(1, 1, THREE.FloatType);
  const tColor = texture(dummy), tDepth = texture(dummyDepth);
  const u = fogUniforms({ THREE, TSL });
  const { viewPosAt, fogAmount, fogColor } = fogNodes(TSL, u);

  const mat = fx.material(Fn(() => {
    const p = ivec2(screenCoordinate.xy);
    const uvTop = screenCoordinate.xy.div(vec2(W, H));
    const col = tColor.load(p).rgb;
    const d = tDepth.load(p).x;
    const vp = viewPosAt(uvTop, min(d, 0.9999999));
    const wp = u.uCamWorld.mul(vec4(vp, 1)).xyz;
    const dirW = normalize(u.uCamWorld.mul(vec4(vp, 0)).xyz);
    const f = select(d.greaterThanEqual(0.9999999), u.uFogB.w.mul(u.uFogA.z), fogAmount(length(vp), wp.y));
    return vec4(mix(col, fogColor(dirW), f), 1);
  })());

  return {
    render(src, depthTex, fog, camera, target, fallbackColor) {
      tColor.value = src; tDepth.value = depthTex;
      setFog(THREE, u, fog, camera, fallbackColor);
      fx.draw(mat, target);
    },
    dispose() { mat.dispose(); dummy.dispose(); dummyDepth.dispose(); },
  };
}
