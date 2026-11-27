// WonderX Phase 2 v4 · 第五幕（H4）：三万动态节点 GPU 驱动算力海啸
// full 档固定 30,000 实例（100% 顶点着色器驱动形态切换 + 电磁波纹 + 朱红等高能量波，零逐帧 JS 矩阵循环）
// 降档按 30,000 / 15,000 / 8,000 / 3,000 与素数步长抽样保证空间均匀覆盖。
import * as THREE from 'three';
import { createRng, clamp, smoothstep } from './shared.js';

export const ACT05_TIER_COUNTS = {
  full: 30000,
  medium: 15000,
  low: 8000,
  minimal: 3000,
};

export const ACT05_FORMATIONS = [
  { id: 0, name: '数字山海', en: 'DATA MOUNTAIN SEA' },
  { id: 1, name: '全球网络球', en: 'GLOBAL NETWORK SPHERE' },
  { id: 2, name: '精密矩阵地形', en: 'PRECISION MATRIX TERRAIN' },
];

export function createAct05Tsunami() {
  const MAX_N = ACT05_TIER_COUNTS.full; // 30,000
  const group = new THREE.Group();
  group.name = 'act05';

  // 基础微体素立方体（附带实例属性：3 套拓扑形态坐标 + 高度/随机相位）
  const baseGeo = new THREE.BoxGeometry(0.115, 0.24, 0.115);
  const instGeo = new THREE.InstancedBufferGeometry();
  instGeo.index = baseGeo.index;
  instGeo.attributes.position = baseGeo.attributes.position;
  instGeo.attributes.normal = baseGeo.attributes.normal;

  const aForm0 = new Float32Array(MAX_N * 3); // 形态 0：数字山海（主峰山脊 + 神经海洋）
  const aForm1 = new Float32Array(MAX_N * 3); // 形态 1：全球网络球（Fibonacci 球面集群 + 轨道环）
  const aForm2 = new Float32Array(MAX_N * 3); // 形态 2：精密矩阵地形（阶梯晶圆矩阵）
  const aSeed = new Float32Array(MAX_N * 3);  // x=hash, y=heightScale, z=ridgeFlag

  const rng = createRng(50505);
  const COLS = 200;
  const ROWS = 150; // 200 * 150 = 30,000

  // 互质步长 10007 打散索引（gcd(10007, 30000) == 1），确保降档抽前 N 个实例时全画面均匀覆盖
  for (let idx = 0; idx < MAX_N; idx++) {
    const p = (idx * 10007) % MAX_N;
    const c = p % COLS;
    const r = Math.floor(p / COLS);
    const u = c / (COLS - 1) - 0.5; // -0.5..0.5
    const v = r / (ROWS - 1) - 0.5; // -0.5..0.5

    // 形态 0：数字山海（对位 H4 宏大广角：双主脊 + 峡谷 + 升腾粒子）
    const x0 = u * 22.0;
    const z0 = v * 15.6;
    const ridge1 = Math.exp(-Math.pow((v + 0.14 * Math.sin(u * 6.2) - 0.04) * 5.2, 2.0)) * 3.55;
    const ridge2 = Math.exp(-Math.pow((v - 0.26 + 0.11 * Math.cos(u * 5.4)) * 6.4, 2.0)) * 2.15;
    const peak = Math.exp(-((x0 - 1.4) * (x0 - 1.4) * 0.08 + (z0 + 0.8) * (z0 + 0.8) * 0.12)) * 2.25;
    const ripple = (Math.sin(x0 * 0.95) * Math.cos(z0 * 1.15) + Math.sin((x0 + z0) * 0.52)) * 0.42;
    const y0 = -2.25 + ridge1 + ridge2 + peak + ripple;
    aForm0[idx * 3] = x0;
    aForm0[idx * 3 + 1] = y0;
    aForm0[idx * 3 + 2] = z0;

    // 形态 1：全球网络球（Fibonacci 球 + 赤道星环）
    const isRing = (p % 7 === 0);
    if (isRing) {
      const a = (p / MAX_N) * Math.PI * 2 * 37.0;
      const rad = 5.4 + (rng() - 0.5) * 1.45;
      aForm1[idx * 3] = Math.cos(a) * rad;
      aForm1[idx * 3 + 1] = (rng() - 0.5) * 0.55;
      aForm1[idx * 3 + 2] = Math.sin(a) * rad;
    } else {
      const k = p + 0.5;
      const phi = Math.acos(1 - (2 * k) / MAX_N);
      const theta = Math.PI * (1 + Math.sqrt(5)) * k;
      const rad = 3.85 + Math.sin(phi * 8.0) * Math.cos(theta * 6.0) * 0.24;
      aForm1[idx * 3] = Math.sin(phi) * Math.cos(theta) * rad;
      aForm1[idx * 3 + 1] = Math.cos(phi) * rad + 0.25;
      aForm1[idx * 3 + 2] = Math.sin(phi) * Math.sin(theta) * rad;
    }

    // 形态 2：精密矩阵地形（分级晶圆芯片集群）
    const bx = Math.floor((u + 0.5) * 10);
    const bz = Math.floor((v + 0.5) * 8);
    const blockHash = ((bx * 37 + bz * 17) % 11) / 11;
    const tierY = -2.1 + Math.floor(blockHash * 5.0) * 0.72 + (Math.abs(u) < 0.16 && Math.abs(v) < 0.16 ? 1.85 : 0.0);
    const gapX = (bx - 4.5) * 0.14;
    const gapZ = (bz - 3.5) * 0.14;
    aForm2[idx * 3] = u * 18.5 + gapX;
    aForm2[idx * 3 + 1] = tierY;
    aForm2[idx * 3 + 2] = v * 14.0 + gapZ;

    aSeed[idx * 3] = rng();
    aSeed[idx * 3 + 1] = 0.55 + Math.max(0, y0 + 1.5) * 0.42 + rng() * 0.75;
    aSeed[idx * 3 + 2] = ridge1 > 1.35 ? 1.0 : 0.0;
  }

  instGeo.setAttribute('aForm0', new THREE.InstancedBufferAttribute(aForm0, 3));
  instGeo.setAttribute('aForm1', new THREE.InstancedBufferAttribute(aForm1, 3));
  instGeo.setAttribute('aForm2', new THREE.InstancedBufferAttribute(aForm2, 3));
  instGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(aSeed, 3));
  instGeo.instanceCount = MAX_N;

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uBurst: { value: 1 },          // 0=单核压缩，1=30,000 体素全面爆散
      uWeights: { value: new THREE.Vector3(1, 0, 0) }, // 三形态插值权重
      uPointerWorld: { value: new THREE.Vector3(0, 0, 0) },
      uPointerActive: { value: 0 },
      uShock: { value: 0 },          // 点击/切换触发的朱红冲击波半径
      uWaveX: { value: -12 },        // 横扫山脊的朱红等高能量波位置
    },
    vertexShader: /* glsl */ `
      attribute vec3 aForm0;
      attribute vec3 aForm1;
      attribute vec3 aForm2;
      attribute vec3 aSeed;

      uniform float uTime;
      uniform float uBurst;
      uniform vec3 uWeights;
      uniform vec3 uPointerWorld;
      uniform float uPointerActive;
      uniform float uShock;
      uniform float uWaveX;

      varying vec3 vNormal;
      varying float vEnergy;
      varying float vHeight;
      varying float vCyan;

      void main() {
        // 三形态平滑形变（纯 GPU 顶点计算，30,000 实例零 CPU 开销）
        vec3 target = aForm0 * uWeights.x + aForm1 * uWeights.y + aForm2 * uWeights.z;

        // 实时波浪律动（保证 30,000 实例每帧全部为动态状态）
        float wave = sin(target.x * 0.58 + uTime * 2.1 + aSeed.x * 6.2831)
                   * cos(target.z * 0.52 - uTime * 1.55) * 0.34;
        target.y += wave;

        // 鼠标划过激起实时电磁波纹
        float pd = length(target.xz - uPointerWorld.xz);
        float emRipple = sin(pd * 2.3 - uTime * 7.5) * exp(-pd * 0.38) * 0.95 * uPointerActive;
        target.y += emRipple;

        // 形态切换 / 点击冲击波
        float shockRing = exp(-pow(pd - uShock * 16.0, 2.0) * 0.45) * step(0.01, uShock) * (1.0 - uShock);
        target.y += shockRing * 1.35;

        // 爆散开场：从单枚核心点 (0, 0.2, 0) 炸开成 30,000 节点
        vec3 corePos = vec3(
          sin(aSeed.x * 62.83 + uTime) * 0.55,
          0.2 + cos(aSeed.x * 41.3 - uTime) * 0.55,
          sin(aSeed.x * 29.7) * 0.55
        );
        vec3 center = mix(corePos, target, uBurst);

        // 单个微体素高度随能量脉冲拉伸
        float isoWave = exp(-pow((target.x - uWaveX) * 0.65, 2.0));
        float energy = clamp(isoWave * 0.78 + shockRing * 1.05 + abs(emRipple) * 0.65 + aSeed.z * 0.34, 0.0, 1.25);

        vec3 local = position;
        local.y *= (0.75 + aSeed.y * (0.65 + energy * 0.85)) * mix(0.35, 1.0, uBurst);
        local.xz *= mix(0.65, 1.0 + energy * 0.18, uBurst);

        vec3 worldPos = center + local;
        vNormal = normalize(normalMatrix * normal);
        vEnergy = energy;
        vHeight = clamp((target.y + 2.4) / 5.4, 0.0, 1.0);
        vCyan = fract(aSeed.x * 13.7 + uWeights.y * 0.4);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vNormal;
      varying float vEnergy;
      varying float vHeight;
      varying float vCyan;

      void main() {
        vec3 N = normalize(vNormal);
        vec3 L1 = normalize(vec3(0.45, 0.82, 0.38));
        vec3 L2 = normalize(vec3(-0.6, 0.35, 0.72));
        float d1 = max(dot(N, L1), 0.0);
        float d2 = max(dot(N, L2), 0.0);

        // 黑曜拉丝深钛基底 -> 高处过渡至冰青 / 暖金 -> 朱红等高能量波主脊
        vec3 darkTi = vec3(0.11, 0.135, 0.185);
        vec3 brightTi = vec3(0.36, 0.42, 0.52);
        vec3 cyanCol = vec3(0.28, 0.82, 0.92);
        vec3 goldCol = vec3(0.95, 0.68, 0.34);
        vec3 vermCol = vec3(0.86, 0.27, 0.17);

        vec3 base = mix(darkTi, brightTi, d1 * 0.75 + d2 * 0.25);
        vec3 accent = mix(cyanCol, goldCol, smoothstep(0.68, 0.95, vCyan));
        vec3 col = mix(base, accent, smoothstep(0.35, 0.88, vHeight) * 0.58);

        // 朱红等高能量峰线与脉冲（压稳高光峰值避免形变期大面积过曝突闪）
        float vermMask = smoothstep(0.55, 1.15, vEnergy);
        col = mix(col, vermCol * 1.22, vermMask * 0.86);
        // 顶面高光
        col += vec3(0.82, 0.92, 0.98) * pow(max(N.y, 0.0), 4.0) * 0.14;

        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });

  const mesh = new THREE.Mesh(instGeo, mat);
  mesh.frustumCulled = false;
  mesh.name = 'act05-tsunami-30k';
  group.add(mesh);

  // 底部微弱地平线校准光环
  const gridRing = new THREE.Mesh(
    new THREE.RingGeometry(8.6, 8.75, 96),
    new THREE.MeshBasicMaterial({ color: 0x4ce0f5, transparent: true, opacity: 0.22, side: THREE.DoubleSide })
  );
  gridRing.rotation.x = -Math.PI / 2;
  gridRing.position.y = -2.45;
  group.add(gridRing);

  // 平滑形态插值状态（仍完全由时间/输入确定）
  let lastTier = 'full';
  function update(progress, t, pointer, input = {}) {
    const tier = input.tier ?? 'full';
    const targetCount = ACT05_TIER_COUNTS[tier] ?? ACT05_TIER_COUNTS.full;
    if (instGeo.instanceCount !== targetCount || tier !== lastTier) {
      instGeo.instanceCount = targetCount;
      lastTier = tier;
    }

    // Beat 1 (0..0.33): 单核爆散 -> 数字山海 (0)
    // Beat 2 (0.33..0.67): 形变 -> 全球网络球 (1)
    // Beat 3 (0.67..1.0): 形变 -> 精密矩阵地形 (2) + 朱红波扫屏
    // 若用户点击按钮/按 1-3 指定了 formation，则优先展示用户所选形态
    let w0 = 1, w1 = 0, w2 = 0;
    let activeFormation = 0;
    if (typeof input.formation === 'number') {
      activeFormation = ((input.formation % 3) + 3) % 3;
      w0 = activeFormation === 0 ? 1 : 0;
      w1 = activeFormation === 1 ? 1 : 0;
      w2 = activeFormation === 2 ? 1 : 0;
    } else {
      const m01 = smoothstep(0.30, 0.46, progress);
      const m12 = smoothstep(0.64, 0.80, progress);
      w0 = 1 - m01;
      w1 = m01 * (1 - m12);
      w2 = m12;
      activeFormation = m12 > 0.5 ? 2 : (m01 > 0.5 ? 1 : 0);
    }

    const burst = input.formation != null ? 1.0 : smoothstep(0.0, 0.14, progress);
    mat.uniforms.uTime.value = t;
    mat.uniforms.uBurst.value = burst;
    mat.uniforms.uWeights.value.set(w0, w1, w2);
    mat.uniforms.uPointerWorld.value.set((pointer[0] - 0.5) * 16.0, 0, (pointer[1] - 0.5) * 11.0);
    mat.uniforms.uPointerActive.value = input.pointerActive ?? (Math.hypot(pointer[0] - 0.5, pointer[1] - 0.5) > 0.002 ? 1.0 : 0.35);
    mat.uniforms.uShock.value = clamp(input.shock ?? 0, 0, 1);
    mat.uniforms.uWaveX.value = ((t * 4.4) % 28.0) - 14.0;

    // 球体形态缓缓自转（时间轴用局部进度平滑积分，避免 w1*t 放大绝对时间导致形变期高速甩转突闪）
    const sphereSpin = typeof input.formation === 'number'
      ? (w1 * t * 0.22)
      : (smoothstep(0.30, 0.80, progress) * 2.6);
    mesh.rotation.y = sphereSpin + (pointer[0] - 0.5) * 0.28;

    const camY = 3.2 * (1 - w1 * 0.55) + (pointer[1] - 0.5) * -1.4;
    const camZ = 12.6 + w1 * 1.4;
    const camX = Math.sin(t * 0.22) * 2.2 + (pointer[0] - 0.5) * 3.2;

    return {
      cameraPos: [camX, camY, camZ],
      cameraLook: [0, 0.15, 0],
      fov: 46,
      instanceCount: targetCount,
      activeFormation,
      stageLights: { keyPos: [6, 10, 8], keyColor: 0xeaf4ff, rimColor: 0xd2452c, fillColor: 0x4ce0f5 },
    };
  }

  return {
    group,
    mesh,
    geometry: instGeo,
    material: mat,
    getInstanceCount: () => instGeo.instanceCount,
    update,
  };
}
