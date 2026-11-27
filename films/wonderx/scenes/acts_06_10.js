// WonderX Phase 2 v4 · 第六至第十幕 3D 场景
// A06 穿镜一镜到底（H5a）· A07 单一几何四套 GLSL 秒换画风与 2×2 矩阵（H5b，0.0 px 绝对配准）
// A08 代码即影片导演工作台背景 · A09 一刀分屏 3D 右世界（H6）· A10 终章时间长河与呼吸点阵
import * as THREE from 'three';
import {
  PALETTE,
  H6_PLATFORM_DATA,
  createRng,
  clamp,
  lerp,
  smoothstep,
  easeInOutCubic,
  mergeGeometriesClean,
} from './shared.js';

// ── 第六幕：穿镜——高空 LiDAR 地形 -> 俯冲发光光学门框走廊 -> 急停微距核心传感器（对位 H5a） ──
function buildAct06(brushedTex) {
  const group = new THREE.Group();
  group.name = 'act06';

  // 1. 宏大 LiDAR 激光雷达测绘地形（纯 GLSL 等高线 + 朱红扫描波 + 冰青高程点阵）
  const terrainGeo = new THREE.PlaneGeometry(56, 78, 128, 160);
  terrainGeo.rotateX(-Math.PI / 2);
  const posAttr = terrainGeo.attributes.position;
  for (let i = 0; i < posAttr.count; i++) {
    const x = posAttr.getX(i);
    const z = posAttr.getZ(i);
    // 中央峡谷留出高速俯冲通道，两侧高耸数字城市山脊
    const canyon = smoothstep(2.6, 11.5, Math.abs(x));
    const ridge = (Math.sin(x * 0.34) * Math.cos(z * 0.22) + Math.sin(x * 0.72 + z * 0.35) * 0.5) * 3.4;
    const blocks = Math.floor((Math.sin(x * 0.55) * Math.cos(z * 0.48) + 1.0) * 3.0) * 0.55;
    posAttr.setY(i, -4.6 + canyon * (3.2 + Math.abs(ridge) + blocks));
  }
  terrainGeo.computeVertexNormals();

  const terrainMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uScanZ: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorldPos;
      varying vec3 vNormal;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uScanZ;
      varying vec3 vWorldPos;
      varying vec3 vNormal;
      void main() {
        vec3 p = vWorldPos;
        float gx = smoothstep(0.93, 1.0, abs(cos(p.x * 2.2)));
        float gz = smoothstep(0.93, 1.0, abs(cos(p.z * 2.2)));
        float contour = smoothstep(0.90, 0.99, abs(sin(p.y * 4.5)));
        float scan = exp(-abs(p.z - uScanZ) * 0.65);

        vec3 base = vec3(0.025, 0.042, 0.068);
        vec3 cyan = vec3(0.30, 0.88, 0.96);
        vec3 verm = vec3(0.88, 0.28, 0.18);

        float distFade = exp(-length(p.xz - vec2(0.0, uScanZ)) * 0.032);
        vec3 col = base
          + cyan * (max(gx, gz) * 0.42 + contour * 0.68) * (0.35 + distFade * 0.85)
          + verm * scan * (0.55 + contour * 1.1);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const terrain = new THREE.Mesh(terrainGeo, terrainMat);
  terrain.position.z = -14;
  group.add(terrain);

  // 2. 14 道悬浮发光光学门框隧道走廊（沿 Z 轴纵深排布，对位 H5a 速度穿镜感）
  const portalMatTi = new THREE.MeshStandardMaterial({
    color: 0x252d3c,
    metalness: 0.9,
    roughness: 0.25,
    roughnessMap: brushedTex,
  });
  const portalCyan = new THREE.MeshBasicMaterial({ color: 0x4ce0f5 });
  const portalVerm = new THREE.MeshBasicMaterial({ color: 0xd2452c });
  const portals = [];
  for (let i = 0; i < 14; i++) {
    const pg = new THREE.Group();
    const z = 8 - i * 3.1;
    const w = lerp(5.4, 2.1, i / 13);
    const h = w * 0.62;
    const thick = 0.09;
    const topBar = new THREE.Mesh(new THREE.BoxGeometry(w, thick, thick * 1.6), portalMatTi);
    topBar.position.y = h / 2;
    const botBar = topBar.clone();
    botBar.position.y = -h / 2;
    const lBar = new THREE.Mesh(new THREE.BoxGeometry(thick, h, thick * 1.6), portalMatTi);
    lBar.position.x = -w / 2;
    const rBar = lBar.clone();
    rBar.position.x = w / 2;

    const innerEdge = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(w - 0.12, h - 0.12, 0.02)),
      i % 4 === 3 ? portalVerm : portalCyan
    );
    pg.add(topBar, botBar, lBar, rBar, innerEdge);
    pg.position.set(Math.sin(i * 0.35) * 0.32, 0.15 + Math.cos(i * 0.4) * 0.16, z);
    pg.rotation.z = Math.sin(i * 0.5) * 0.05;
    group.add(pg);
    portals.push(pg);
  }

  // 3. 隧道尽头微距锁死的单枚核心传感器（急停微距特写）
  const sensor = new THREE.Group();
  sensor.position.set(0, 0.1, -35.8);
  const sBody = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.15, 0.38, 32), portalMatTi);
  sBody.rotation.x = Math.PI / 2;
  const sRing1 = new THREE.Mesh(new THREE.TorusGeometry(0.84, 0.032, 12, 48), portalCyan);
  sRing1.position.z = 0.22;
  const sRing2 = new THREE.Mesh(new THREE.TorusGeometry(0.52, 0.025, 12, 40), portalVerm);
  sRing2.position.z = 0.26;
  const sLens = new THREE.Mesh(
    new THREE.SphereGeometry(0.38, 28, 18),
    new THREE.MeshStandardMaterial({ color: 0x0a1c28, emissive: 0x4ce0f5, emissiveIntensity: 1.25, metalness: 0.9, roughness: 0.08 })
  );
  sLens.scale.set(1, 1, 0.38);
  sLens.position.z = 0.24;
  sensor.add(sBody, sRing1, sRing2, sLens);
  group.add(sensor);

  // 样条穿梭机位路径
  const camCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 8.2, 22.0),   // Beat 1: 高空 LiDAR 全息俯瞰
    new THREE.Vector3(0.4, 2.2, 10.5), // 进入第一道光学门框
    new THREE.Vector3(-0.3, 0.3, -6.0),// Beat 2: 隧道高速俯冲穿行
    new THREE.Vector3(0.15, 0.15, -24.0),
    new THREE.Vector3(0.0, 0.12, -32.9),// Beat 3: 急停微距锁死核心传感器
  ]);
  const lookCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, -1.5, -2.0),
    new THREE.Vector3(0, 0.1, -12.0),
    new THREE.Vector3(0, 0.1, -26.0),
    new THREE.Vector3(0, 0.1, -35.8),
    new THREE.Vector3(0, 0.1, -35.8),
  ]);

  function update(progress, t, pointer) {
    const u = easeInOutCubic(clamp(progress, 0, 1));
    const cp = camCurve.getPoint(u);
    const lp = lookCurve.getPoint(u);
    const px = (pointer[0] - 0.5) * lerp(1.6, 0.32, u);
    const py = (pointer[1] - 0.5) * -lerp(0.9, 0.22, u);

    terrainMat.uniforms.uTime.value = t;
    terrainMat.uniforms.uScanZ.value = lerp(12, -36, (t * 0.22 + progress) % 1.0);

    portals.forEach((pg, i) => {
      pg.rotation.z = Math.sin(t * 0.7 + i * 0.45) * 0.06;
    });
    sRing1.rotation.z = t * 0.85;
    sRing2.rotation.z = -t * 1.35;

    return {
      cameraPos: [cp.x + px, cp.y + py, cp.z],
      cameraLook: [lp.x, lp.y, lp.z],
      fov: lerp(54, 34, smoothstep(0.65, 1.0, u)),
      stageLights: { keyPos: [4, 7, -18], keyColor: 0xeef6ff, rimColor: 0x4ce0f5, fillColor: 0xd2452c },
    };
  }
  return { group, update };
}

// ── 第七幕（H5b）：单一 BufferGeometry + 4 套纯 GLSL ShaderMaterial 秒换视觉宇宙 + 2×2 四格同屏 ──
// 严格保证：4 套着色器共享逐字节完全一致的 invariant 顶点变换，且零 discard、全输出 alpha=1.0，
// 因此在同相机/同矩阵/同分辨率下的原始前景覆盖掩码（coverage mask）逐像素差严格为 0.0 px！
export const ACT07_STYLES = [
  { id: 0, key: 'obsidian', name: '暗色科技发布', en: 'DARK KEYNOTE', bg: 0x07080b },
  { id: 1, key: 'blueprint', name: '深普鲁士蓝 CAD', en: 'CAD BLUEPRINT', bg: 0x0b2346 },
  { id: 2, key: 'lidar', name: '冰青 LiDAR 点云', en: 'LIDAR HOLOGRAM', bg: 0x040b12 },
  { id: 3, key: 'cel', name: '北冥三渲二墨线', en: 'BEIMING CEL-INK', bg: 0x14171f },
];

const H5B_SHARED_VERTEX_SHADER = /* glsl */ `
  invariant gl_Position;
  attribute float aPartId;
  varying vec3 vNormal;
  varying vec3 vViewPos;
  varying vec3 vWorldPos;
  varying vec3 vLocalPos;
  varying float vPartId;

  void main() {
    vLocalPos = position;
    vPartId = aPartId;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vViewPos = -mv.xyz;
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * mv;
  }
`;

function buildH5bMaterials() {
  const sharedUniforms = () => ({
    uTime: { value: 0 },
  });

  // 0. 暗色科技发布（拉丝黑曜钛 + 冰青 Fresnel + 暖金主光 + 朱红内核）
  const matObsidian = new THREE.ShaderMaterial({
    uniforms: sharedUniforms(),
    vertexShader: H5B_SHARED_VERTEX_SHADER,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec3 vNormal;
      varying vec3 vViewPos;
      varying vec3 vWorldPos;
      varying vec3 vLocalPos;
      varying float vPartId;
      void main() {
        vec3 N = normalize(vNormal);
        vec3 V = normalize(vViewPos);
        vec3 L1 = normalize(vec3(0.55, 0.72, 0.42));
        vec3 L2 = normalize(vec3(-0.72, 0.24, 0.65));
        float d1 = max(dot(N, L1), 0.0);
        float d2 = max(dot(N, L2), 0.0);
        float spec = pow(max(dot(N, normalize(L1 + V)), 0.0), 48.0);
        float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
        // 微米级拉丝纹理
        float brush = sin(vLocalPos.y * 85.0 + vLocalPos.x * 12.0) * 0.04;

        vec3 base = vec3(0.11, 0.135, 0.175) + brush;
        if (vPartId > 1.5 && vPartId < 2.5) base = vec3(0.24, 0.28, 0.35) + brush;
        vec3 col = base * (0.34 + d1 * 0.85)
          + vec3(1.0, 0.76, 0.46) * (spec * 0.95 + d1 * 0.14)
          + vec3(0.30, 0.88, 0.96) * (fres * 0.92 + d2 * 0.22);
        if (vPartId > 2.5) {
          float pulse = 0.85 + 0.15 * sin(uTime * 3.5);
          col = mix(col, vec3(0.92, 0.30, 0.19) * 1.35 * pulse, 0.88);
        }
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });

  // 1. 深普鲁士蓝 CAD 蓝图（等高技术网格 + 精密白/青工程线）
  const matBlueprint = new THREE.ShaderMaterial({
    uniforms: sharedUniforms(),
    vertexShader: H5B_SHARED_VERTEX_SHADER,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec3 vNormal;
      varying vec3 vViewPos;
      varying vec3 vWorldPos;
      varying vec3 vLocalPos;
      varying float vPartId;
      void main() {
        vec3 N = normalize(vNormal);
        vec3 V = normalize(vViewPos);
        float edge = pow(1.0 - max(dot(N, V), 0.0), 2.2);
        float gx = smoothstep(0.92, 0.99, abs(cos(vLocalPos.x * 16.0)));
        float gy = smoothstep(0.92, 0.99, abs(cos(vLocalPos.y * 16.0)));
        float gz = smoothstep(0.92, 0.99, abs(cos(vLocalPos.z * 16.0)));
        float grid = max(max(gx, gy), gz);
        float shade = 0.45 + 0.55 * max(dot(N, normalize(vec3(0.4, 0.8, 0.5))), 0.0);

        vec3 prussian = vec3(0.055, 0.175, 0.355) * shade;
        vec3 inkWhite = vec3(0.86, 0.96, 1.0);
        vec3 cyanLine = vec3(0.30, 0.88, 0.96);
        vec3 col = prussian + cyanLine * grid * 0.45 + inkWhite * smoothstep(0.28, 0.72, edge) * 0.95;
        if (vPartId > 2.5) {
          col = mix(col, vec3(1.0, 0.45, 0.32), 0.55);
        }
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });

  // 2. 冰青 LiDAR 全息点云（严格零 discard：深蓝黑不透明基底 + 高密度立体量子点阵与高程扫描环）
  const matLidar = new THREE.ShaderMaterial({
    uniforms: sharedUniforms(),
    vertexShader: H5B_SHARED_VERTEX_SHADER,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec3 vNormal;
      varying vec3 vViewPos;
      varying vec3 vWorldPos;
      varying vec3 vLocalPos;
      varying float vPartId;
      void main() {
        vec3 N = normalize(vNormal);
        vec3 V = normalize(vViewPos);
        float fres = pow(1.0 - max(dot(N, V), 0.0), 2.4);

        vec3 cell = fract(vLocalPos * 14.0) - 0.5;
        float dotPulse = smoothstep(0.32, 0.12, length(cell));
        float scanY = sin(uTime * 1.6) * 1.9;
        float scanRing = exp(-abs(vLocalPos.y - scanY) * 7.5);

        vec3 base = vec3(0.024, 0.075, 0.118);
        vec3 cyan = vec3(0.30, 0.90, 0.98);
        vec3 verm = vec3(0.92, 0.32, 0.20);

        vec3 col = base
          + cyan * (dotPulse * 0.95 + fres * 0.78)
          + mix(cyan, verm, step(2.5, vPartId)) * scanRing * 1.15;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });

  // 3. 北冥招牌硬朗三渲二墨线（三档阶梯明暗 + 内嵌深墨轮廓边缘 + 朱砂高光）
  const matCel = new THREE.ShaderMaterial({
    uniforms: sharedUniforms(),
    vertexShader: H5B_SHARED_VERTEX_SHADER,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec3 vNormal;
      varying vec3 vViewPos;
      varying vec3 vWorldPos;
      varying vec3 vLocalPos;
      varying float vPartId;
      void main() {
        vec3 N = normalize(vNormal);
        vec3 V = normalize(vViewPos);
        vec3 L = normalize(vec3(0.58, 0.74, 0.34));
        float ndl = dot(N, L) * 0.5 + 0.5;
        // 招牌三档硬朗卡通明暗阶梯
        float band = ndl > 0.74 ? 1.0 : (ndl > 0.44 ? 0.62 : 0.28);
        float ndv = max(dot(N, V), 0.0);
        float inkRim = smoothstep(0.30, 0.18, ndv);

        vec3 porcelain = vec3(0.92, 0.94, 0.96);
        vec3 slate = vec3(0.32, 0.38, 0.48);
        vec3 verm = vec3(0.84, 0.27, 0.17);
        vec3 base = vPartId > 2.5 ? verm : (vPartId > 1.5 ? porcelain : slate);

        vec3 shaded = base * band;
        if (ndl > 0.90 && vPartId < 2.5) shaded = mix(shaded, vec3(1.0, 0.98, 0.94), 0.45);
        // 硬朗深墨勾边
        vec3 col = mix(shaded, vec3(0.035, 0.042, 0.058), inkRim);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });

  return [matObsidian, matBlueprint, matLidar, matCel];
}

function buildPhotonicSculptureGeometry() {
  // 原创精密科幻陀螺算力雕塑（Photonic Gyro-Monolith）：中央八角塔核 + 3 组同轴机环 + 12 散热翼 + 精密底座
  const items = [];
  const M = (px, py, pz, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) => {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz));
    m.compose(new THREE.Vector3(px, py, pz), q, new THREE.Vector3(sx, sy, sz));
    return m;
  };

  // partId = 1: 主体深钛基座与支柱
  items.push({ geo: new THREE.CylinderGeometry(1.18, 1.46, 0.34, 8), matrix: M(0, -1.68, 0), partId: 1 });
  items.push({ geo: new THREE.CylinderGeometry(0.56, 0.78, 2.75, 8), matrix: M(0, -0.1, 0), partId: 1 });
  items.push({ geo: new THREE.ConeGeometry(0.56, 0.85, 8), matrix: M(0, 1.7, 0), partId: 1 });

  // partId = 2: 外层精密陀螺机环与 12 片放射翼板
  items.push({ geo: new THREE.TorusGeometry(1.48, 0.11, 16, 48), matrix: M(0, 0.05, 0, Math.PI / 2, 0, 0), partId: 2 });
  items.push({ geo: new THREE.TorusGeometry(1.32, 0.08, 14, 44), matrix: M(0, 0.05, 0, 0.58, 0.35, 0.25), partId: 2 });
  items.push({ geo: new THREE.TorusGeometry(1.16, 0.075, 14, 44), matrix: M(0, 0.05, 0, -0.62, -0.4, 0.42), partId: 2 });
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    items.push({
      geo: new THREE.BoxGeometry(0.11, 1.38, 0.46),
      matrix: M(Math.cos(a) * 0.94, -0.25, Math.sin(a) * 0.94, 0, -a, 0.18),
      partId: 2,
    });
  }

  // partId = 3: 发光朱红核心晶柱与尖顶探针
  items.push({ geo: new THREE.OctahedronGeometry(0.46, 0), matrix: M(0, 0.08, 0), partId: 3 });
  items.push({ geo: new THREE.TorusGeometry(0.84, 0.045, 10, 32), matrix: M(0, 0.65, 0, Math.PI / 2, 0, 0), partId: 3 });
  items.push({ geo: new THREE.TorusGeometry(0.84, 0.045, 10, 32), matrix: M(0, -0.58, 0, Math.PI / 2, 0, 0), partId: 3 });
  items.push({ geo: new THREE.CylinderGeometry(0.05, 0.12, 0.65, 8), matrix: M(0, 2.28, 0), partId: 3 });

  return mergeGeometriesClean(items);
}

function buildAct07() {
  const group = new THREE.Group();
  group.name = 'act07';

  const heroGeo = buildPhotonicSculptureGeometry();
  const materials = buildH5bMaterials();
  const heroMesh = new THREE.Mesh(heroGeo, materials[0]);
  heroMesh.name = 'h5b-hero-sculpture';
  group.add(heroMesh);

  // 独立子场景（用于 2×2 四格同步视口渲染以及 H5b 零误差覆盖掩码测试）
  const quadScene = new THREE.Scene();
  const quadMesh = new THREE.Mesh(heroGeo, materials[0]);
  quadScene.add(quadMesh);

  function syncPose(t, pointer) {
    const ry = t * 0.55 + (pointer[0] - 0.5) * 0.85;
    const rx = Math.sin(t * 0.4) * 0.12 + (pointer[1] - 0.5) * 0.38;
    heroMesh.rotation.set(rx, ry, 0);
    quadMesh.rotation.set(rx, ry, 0);
    heroMesh.updateMatrixWorld(true);
    quadMesh.updateMatrixWorld(true);
    for (const m of materials) m.uniforms.uTime.value = t;
  }

  function update(progress, t, pointer, input = {}) {
    // Beat 1 (0..0.33): 暗色科技发布 -> 蓝图
    // Beat 2 (0.33..0.67): 2×2 四宇宙同屏矩阵（对位 H5b）
    // Beat 3 (0.67..1.0): 朱红激光扫描波自动切 4 种宇宙
    const autoQuad = progress >= 0.32 && progress < 0.68;
    const quadMode = typeof input.quad === 'boolean' ? input.quad : autoQuad;
    let styleIndex = 0;
    if (typeof input.styleIndex === 'number') {
      styleIndex = ((input.styleIndex % 4) + 4) % 4;
    } else if (progress < 0.22) {
      styleIndex = 0;
    } else if (progress < 0.32) {
      styleIndex = 1;
    } else {
      styleIndex = Math.floor(clamp((progress - 0.68) / 0.32) * 4) % 4;
    }

    syncPose(t, pointer);
    heroMesh.material = materials[styleIndex];

    return {
      cameraPos: [0, 0.45, 6.4],
      cameraLook: [0, 0.12, 0],
      fov: 40,
      quadMode,
      styleIndex,
      bgHex: ACT07_STYLES[styleIndex].bg,
      stageLights: { keyPos: [4, 6, 6], keyColor: 0xffffff, rimColor: 0x4ce0f5, fillColor: 0xd2452c },
    };
  }

  return { group, heroGeo, heroMesh, quadScene, quadMesh, materials, syncPose, update };
}

// ── 第八幕：代码即影片——暗黑北冥导演工作台 3D 主视口（支持自由机位 ↔ 锁定电影成片机位） ──
function buildAct08(brushedTex, gridTex) {
  const group = new THREE.Group();
  group.name = 'act08';

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(34, 34),
    new THREE.MeshStandardMaterial({ color: 0x0b0e15, map: gridTex, metalness: 0.72, roughness: 0.32 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -2.1;
  group.add(floor);

  // 舞台中央双端同源标志物：精密黑曜电影摄影机晶核 + 三重轨道环
  const core = new THREE.Group();
  const tiMat = new THREE.MeshStandardMaterial({ color: 0x2c3445, metalness: 0.9, roughness: 0.22, roughnessMap: brushedTex });
  const cyanMat = new THREE.MeshBasicMaterial({ color: 0x4ce0f5 });
  const vermMat = new THREE.MeshBasicMaterial({ color: 0xd2452c });

  const monolith = new THREE.Mesh(new THREE.OctahedronGeometry(1.18, 1), tiMat);
  const wire = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.OctahedronGeometry(1.22, 1)), cyanMat);
  const ring1 = new THREE.Mesh(new THREE.TorusGeometry(1.95, 0.032, 12, 64), cyanMat);
  const ring2 = new THREE.Mesh(new THREE.TorusGeometry(2.35, 0.026, 12, 72), vermMat);
  const ring3 = new THREE.Mesh(new THREE.TorusGeometry(2.75, 0.02, 10, 80), tiMat);
  core.add(monolith, wire, ring1, ring2, ring3);
  core.position.set(0, 0.25, 0);
  group.add(core);

  // 3D 关键帧电影轨道样条（可视化相机运动轨迹）
  const trackPts = [];
  for (let i = 0; i <= 24; i++) {
    const a = (i / 24) * Math.PI * 1.4 - Math.PI * 0.7;
    trackPts.push(new THREE.Vector3(Math.sin(a) * 5.2, 0.9 + Math.cos(a * 2.0) * 0.65, Math.cos(a) * 5.2));
  }
  const trackLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(trackPts),
    new THREE.LineBasicMaterial({ color: 0xffb85c, transparent: true, opacity: 0.65 })
  );
  group.add(trackLine);

  function update(progress, t, pointer, input = {}) {
    const scrub = input.scrub != null ? clamp(input.scrub, 0, 1) : progress;
    const locked = Boolean(input.camLock);
    const phase = scrub * Math.PI * 2;

    monolith.rotation.set(phase * 0.6, phase * 1.2, 0);
    wire.rotation.copy(monolith.rotation);
    ring1.rotation.set(0.6 + phase * 0.5, phase * 0.8, 0);
    ring2.rotation.set(-0.5, phase * -0.9, 0.4 + phase * 0.3);
    ring3.rotation.set(Math.PI / 2, 0, phase * 0.4);

    // 自由交互机位受鼠标控制；锁定电影机位严格沿预设关键帧轨道走
    const camAng = locked ? lerp(-0.68, 0.68, scrub) : lerp(-0.35, 0.35, scrub) + (pointer[0] - 0.5) * 1.25;
    const camY = locked ? 1.2 + Math.sin(scrub * Math.PI) * 0.9 : 1.35 + (pointer[1] - 0.5) * -1.4;
    const rad = locked ? 7.2 : 7.8;

    return {
      cameraPos: [Math.sin(camAng) * rad, camY, Math.cos(camAng) * rad],
      cameraLook: [0, 0.15, 0],
      fov: locked ? 38 : 42,
      scrubValue: scrub,
      camLock: locked,
      stageLights: { keyPos: [5, 7, 6], keyColor: 0xf4f8ff, rimColor: 0xffb85c, fillColor: 0x4ce0f5 },
    };
  }
  return { group, update };
}

// ── 第九幕（H6）：一刀见高下——右半屏北冥 3D 爆炸硬件 + 发光数据光河（与左半屏白底 PPT 共享 7 组指标） ──
function buildAct09(brushedTex, gridTex) {
  const group = new THREE.Group();
  group.name = 'act09';

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 40),
    new THREE.MeshStandardMaterial({ color: 0x0a0d14, map: gridTex, metalness: 0.78, roughness: 0.28 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -2.35;
  group.add(floor);

  // 右侧主视觉：悬浮拆解光学算力核（偏右构图，左半屏留给传统白底 PPT 对比，对位 H6）
  const hw = new THREE.Group();
  hw.position.set(1.65, 0.35, 0);
  const tiMat = new THREE.MeshStandardMaterial({ color: 0x2a3344, metalness: 0.92, roughness: 0.22, roughnessMap: brushedTex });
  const cyanMat = new THREE.MeshStandardMaterial({ color: 0x0e3345, emissive: 0x4ce0f5, emissiveIntensity: 1.9, metalness: 0.2, roughness: 0.2 });
  const vermMat = new THREE.MeshStandardMaterial({ color: 0x3b100b, emissive: 0xd2452c, emissiveIntensity: 2.3, metalness: 0.25, roughness: 0.2 });
  const goldMat = new THREE.MeshStandardMaterial({ color: 0x3d280f, emissive: 0xffb85c, emissiveIntensity: 1.5, metalness: 0.4, roughness: 0.25 });

  const plates = [
    new THREE.Mesh(new THREE.CylinderGeometry(1.42, 1.48, 0.18, 32), tiMat),
    new THREE.Mesh(new THREE.TorusGeometry(1.26, 0.06, 14, 48), cyanMat),
    new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.22, 1.25), vermMat),
    new THREE.Mesh(new THREE.CylinderGeometry(1.18, 1.18, 0.14, 6), goldMat),
    new THREE.Mesh(new THREE.CylinderGeometry(1.52, 1.38, 0.22, 32), tiMat),
  ];
  plates.forEach(p => hw.add(p));
  group.add(hw);

  // 4 条对应 H6_PLATFORM_DATA.breakdown（42% / 28% / 19% / 11%）的 3D 发光数据光河柱阵
  const bars = [];
  H6_PLATFORM_DATA.breakdown.forEach((item, idx) => {
    const col = new THREE.Color(item.color);
    const barH = (item.pct / 42) * 3.1;
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(0.42, barH, 0.42),
      new THREE.MeshStandardMaterial({ color: col.clone().multiplyScalar(0.35), emissive: col, emissiveIntensity: 1.4, metalness: 0.6, roughness: 0.22 })
    );
    m.position.set(0.55 + idx * 0.85, -2.35 + barH * 0.5, 2.35);
    group.add(m);
    bars.push({ m, barH });
  });

  // 数据光河粒子带
  const riverPts = [];
  for (let i = 0; i < 64; i++) {
    const u = i / 63;
    riverPts.push(new THREE.Vector3(lerp(-1.2, 5.2, u), -1.65 + Math.sin(u * 6.5) * 0.28, lerp(3.4, -2.6, u)));
  }
  const riverTube = new THREE.Mesh(
    new THREE.TubeGeometry(new THREE.CatmullRomCurve3(riverPts), 72, 0.045, 8, false),
    cyanMat
  );
  group.add(riverTube);

  function update(progress, t, pointer) {
    hw.rotation.y = t * 0.42 + (pointer[0] - 0.5) * 0.45;
    hw.rotation.z = -0.18 + Math.sin(t * 0.8) * 0.05;
    plates.forEach((p, idx) => {
      const spread = 0.58 + Math.sin(t * 1.4 + idx) * 0.05;
      p.position.y = (idx - 2) * spread;
    });
    bars.forEach((b, idx) => {
      const pulse = 1 + Math.sin(t * 2.2 + idx * 0.9) * 0.06;
      b.m.scale.y = pulse;
      b.m.position.y = -2.35 + b.barH * pulse * 0.5;
    });
    return {
      cameraPos: [0.4 + (pointer[0] - 0.5) * 0.8, 1.05 + (pointer[1] - 0.5) * -0.4, 8.6],
      cameraLook: [0.95, -0.1, 0.4],
      fov: 42,
      stageLights: { keyPos: [5, 7, 6], keyColor: 0xeff6ff, rimColor: 0xd2452c, fillColor: 0x4ce0f5 },
    };
  }
  return { group, update };
}

// ── 第十幕：终章——三维时间长河微缩地标回掠 -> 品牌落版 -> 背后呼吸运转的三维点阵（配 12° 光学玻璃斜透） ──
function buildAct10() {
  const group = new THREE.Group();
  group.name = 'act10';

  // 1. 沿时间长河排布的 Act 02–09 八座微缩全息地标
  const landmarks = new THREE.Group();
  const cyanWire = new THREE.LineBasicMaterial({ color: 0x4ce0f5, transparent: true, opacity: 0.72 });
  const vermWire = new THREE.LineBasicMaterial({ color: 0xd2452c, transparent: true, opacity: 0.88 });
  const shapes = [
    new THREE.BoxGeometry(0.55, 1.35, 0.55),
    new THREE.CylinderGeometry(0.55, 0.55, 1.1, 12),
    new THREE.CylinderGeometry(0.65, 0.65, 1.0, 3),
    new THREE.IcosahedronGeometry(0.62, 1),
    new THREE.TorusGeometry(0.58, 0.12, 10, 24),
    new THREE.OctahedronGeometry(0.65, 0),
    new THREE.BoxGeometry(1.05, 0.68, 0.45),
    new THREE.ConeGeometry(0.58, 1.15, 6),
  ];
  const landmarkItems = shapes.map((geo, idx) => {
    const seg = new THREE.LineSegments(new THREE.EdgesGeometry(geo), idx % 3 === 0 ? vermWire : cyanWire);
    seg.position.set((idx % 2 === 0 ? -1 : 1) * 1.95, Math.sin(idx * 1.1) * 0.35, -idx * 3.1);
    landmarks.add(seg);
    return seg;
  });
  group.add(landmarks);

  // 2. 终章背后呼吸运转的北冥三维引擎点阵（3,600 个实时呼吸量子点，穿透 12° 倾斜玻璃板可见）
  const PCOUNT = 3600;
  const rng = createRng(101010);
  const pPos = new Float32Array(PCOUNT * 3);
  const pCol = new Float32Array(PCOUNT * 3);
  const c1 = new THREE.Color(PALETTE.iceCyan);
  const c2 = new THREE.Color(PALETTE.warmTungsten);
  const c3 = new THREE.Color(PALETTE.vermilion);
  for (let i = 0; i < PCOUNT; i++) {
    const gx = (i % 60) - 30;
    const gz = Math.floor(i / 60) - 30;
    pPos[i * 3] = gx * 0.42;
    pPos[i * 3 + 1] = -1.6 + Math.sin(gx * 0.28) * Math.cos(gz * 0.28) * 1.1;
    pPos[i * 3 + 2] = gz * 0.42 - 6.0;
    const r = rng();
    const c = r > 0.90 ? c3 : (r > 0.68 ? c2 : c1);
    pCol[i * 3] = c.r;
    pCol[i * 3 + 1] = c.g;
    pCol[i * 3 + 2] = c.b;
  }
  const latticeGeo = new THREE.BufferGeometry();
  latticeGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  latticeGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
  const latticeMat = new THREE.PointsMaterial({
    size: 0.085,
    vertexColors: true,
    transparent: true,
    opacity: 0.85,
  });
  const lattice = new THREE.Points(latticeGeo, latticeMat);
  group.add(lattice);

  function update(progress, t, pointer) {
    // Beat 1 (0..0.34): 高速回掠 Act 02–09 微缩全息地标
    // Beat 2 (0.34..0.67): 收束至极简品牌落版（告别静态幻灯片 · 万物有戏 × 北冥引擎）
    // Beat 3 (0.67..1.0): 平静回到「有任何问题吗？」+ 12° 光学玻璃倾斜透出背后呼吸三维点阵
    const fly = easeInOutCubic(clamp(progress / 0.36));
    const settle = smoothstep(0.32, 0.56, progress);
    landmarks.visible = settle < 0.96;
    landmarkItems.forEach((seg, idx) => {
      seg.rotation.set(t * 0.45 + idx, t * 0.72, 0);
    });

    // 点阵轻微呼吸起伏
    lattice.rotation.y = t * 0.07 + (pointer[0] - 0.5) * 0.24;
    lattice.rotation.x = 0.22 + (pointer[1] - 0.5) * -0.18;
    lattice.position.y = Math.sin(t * 0.9) * 0.14;

    const camZ = lerp(4.2, -21.5, fly);
    const finalZ = lerp(camZ, 5.2, settle);
    return {
      cameraPos: [(pointer[0] - 0.5) * 1.4, lerp(0.8, 1.3, settle) + (pointer[1] - 0.5) * -0.6, finalZ],
      cameraLook: [0, 0, finalZ - 7.5],
      fov: lerp(48, 42, settle),
      stageLights: { keyPos: [4, 6, 8], keyColor: 0xeef5ff, rimColor: 0x4ce0f5, fillColor: 0xd2452c },
    };
  }
  return { group, update };
}

export function createActs06to10(brushedTex, gridTex) {
  return {
    A06: buildAct06(brushedTex),
    A07: buildAct07(),
    A08: buildAct08(brushedTex, gridTex),
    A09: buildAct09(brushedTex, gridTex),
    A10: buildAct10(),
  };
}
