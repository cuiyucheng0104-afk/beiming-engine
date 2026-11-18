// 卡通材质对拍用的场景：THREE 与材质族工厂由调用方传入（GLSL 参考页用 r170 + engine/shade/toon.js，TSL 夹具用 r187 + engine/offscreen/tsl/toon.js），
// 两边建出同一个场景、同一份材质参数。覆盖：显式三档色 / 乘法色调、交界线噪声、两层边缘光（含 rimCore 亮芯与撕边）、补光、天空冷光、墨色、
// 背光面与掠射角；斑块表面层（锈斑带斑心、藻斑、小斑点）；材质钩子 fragmentBase / fragmentAlbedo（顶点属性、墨线时钟、fwidth），
// GLSL 字符串与 TSL 函数写在同一份 opts 里，两边各取自己那份（TSL 为 null 时是 GLSL 侧）。layers 由调用方给各自版本的 patchLayer()。环境光两边都不该进卡通合成。opts.shadow = true 时主光投影、地面接影（TSL 侧另由夹具挂 useR170Shadow）。
export function toonScene({ THREE, kind, shared, W, H, shadow = false, tsl = null, wide = false, noLights = false, mutate = null, TSL = null, layers = [] }) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x6a6f9a);
  const camera = new THREE.PerspectiveCamera(30, W / H, 0.5, 200);
  camera.position.set(0, 3.2, 14); camera.lookAt(0, 0.6, 0);
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(6, 9, 4); sun.castShadow = shadow;
  if (shadow) { sun.shadow.mapSize.set(1024, 1024); Object.assign(sun.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, near: 1, far: 40 }); sun.shadow.bias = -0.0005; }
  if (!noLights) scene.add(sun, new THREE.AmbientLight(0xffffff, 0.8));
  const a = kind({ name: 'tA', shared, firstId: 1 }), b = kind({ name: 'tB', shared, firstId: 50, rimCore: true, skyStepUniform: true });
  // mutate：反例用，只在 TSL 侧传，改所有材质的同名参数（noCore = 去掉边缘光亮芯）
  const { noCore = false, ...mut } = mutate || {};
  const common = { edgeNoise: 0.05, edgeNoiseScale: 0.6, inkColor: '#2A2D52', ...(wide ? { shadowLo: 0, shadowHi: 1 } : {}) };
  const mats = {
    ball: a.make({ ...common, color: '#7D78B8', shade1: '#454A80', shade2: '#2C2F58', rimColor: '#F2A0A6', rimAmt: 0.6, rimLitColor: '#FFD3B0', rimLitAmt: 0.8, rimLitPower: 0.5,
      fillColor: '#B98AA6', fillAmt: 0.5, skyAmt: 0.3 }),
    knot: a.make({ ...common, color: '#6E7BA8', shade1Tint: [0.6, 0.62, 0.85], shade2Tint: [0.34, 0.36, 0.6], step1: 0.6, feather1: 0.05, rimAmt: 0.4, fillAmt: 0.3, fillFlat: 0.2 }),
    box: b.make({ ...common, color: '#E9DCC9', shade1: '#9A8FA8', shade2: '#5F5394', rimColor: '#F2A0A6', rimColor2: noCore ? null : '#FFF4EA', rimAmt: 0.9, rimBreak: 0.3, rimLitAmt: 0.7,
      rimLitColor2: noCore ? null : '#FFC46B', skyStep: 0.2, skyAmt: 0.5 }),
    ground: a.make({ color: '#8E7CC3', shade1: '#5F5394', shade2: '#343D69', fillAmt: 0, rimAmt: 0, edgeNoise: 0, ...(wide ? { shadowLo: 0, shadowHi: 1 } : {}) }),
  };
  const c = kind({ name: 'tC', shared, firstId: 80, layers });
  const trunk = new THREE.Color('#3A2F4E');
  const hooks = {
    uniforms: { uTrunk: { value: trunk } },
    vertexPars: 'attribute float aPart;\nvarying float vPart;\n', vertexBegin: 'vPart = aPart;',
    fragmentPars: 'varying float vPart;\nuniform vec3 uTrunk;\n',
    fragmentBase: 'diffuseColor.rgb = mix( uTrunk, diffuseColor.rgb, step( 0.5, vPart ) );',
    fragmentAlbedo: `{ float f = vToonObj.y * 3.0 + toonNoise( vToonObj * 0.8 + uInkTime * 0.37 ) * 0.4;
      float dd = fract( f + 0.5 ) - 0.5, fw = max( fwidth( f ), 1e-4 );
      toonInk = max( toonInk, ( 1.0 - smoothstep( 0.08 - fw, 0.08 + fw, abs( dd ) ) ) * 0.7 ); }`,
    tsl: TSL && {
      uniforms: { uTrunk: TSL.uniform(trunk) },
      fragmentBase: k => k.diffuse.assign(TSL.mix(k.u.uTrunk, k.diffuse, TSL.step(0.5, TSL.attribute('aPart', 'float')))),
      fragmentAlbedo: k => {
        const { fract, abs, max, fwidth, smoothstep, float } = TSL;
        const f = k.obj.y.mul(3).add(k.noise.noise(k.obj.mul(0.8).add(k.u.uInkTime.mul(0.37))).mul(0.4));
        const dd = fract(f.add(0.5)).sub(0.5), fw = max(fwidth(f), 1e-4);
        k.ink.assign(max(k.ink, float(1).sub(smoothstep(float(0.08).sub(fw), float(0.08).add(fw), abs(dd))).mul(0.7)));
      },
    },
  };
  const patch = { rustColor: '#5F5394', rustAmt: 0.5, rustThr: 0.05, patchScale: 0.9, algaeColor: '#5E8A5A', algaeAmt: 0.4, spotAmt: 0.5, spotScale: 3, dabAmt: 0.3 };
  mats.pillar = c.make({ ...common, ...hooks, ...patch, color: '#7D78B8', shade1: '#454A80', shade2: '#2C2F58', rimAmt: 0.4, fillAmt: 0.3 });
  mats.rock = c.make({ ...common, ...patch, color: '#A79AD6', shade1: '#6F6AAB', shade2: '#454A80', rimLitAmt: 0.5 });
  for (const [k, v] of Object.entries(mut)) {   // 改所有带这个参数的材质；一个都没有就是写错了参数名
    const us = Object.values(mats).map(m => m.userData.toon[`u${k[0].toUpperCase()}${k.slice(1)}`]).filter(Boolean);
    if (!us.length) throw new Error(`mutate：没有参数 ${k}`);
    for (const u of us) u.value = v;
  }
  const pg = new THREE.CylinderGeometry(0.45, 0.6, 3.2, 24, 12), py = pg.attributes.position;
  pg.setAttribute('aPart', new THREE.Float32BufferAttribute(Array.from({ length: py.count }, (_, i) => (py.getY(i) > -0.6 ? 1 : 0)), 1));
  const add = (geo, mat, kd, pos, rot = [0, 0, 0]) => { const m = kd.bind(new THREE.Mesh(geo, mat), mat); m.position.set(...pos); m.rotation.set(...rot); scene.add(m); return m; };
  add(new THREE.SphereGeometry(1.3, 48, 24), mats.ball, a, [-3.2, 1.3, 0]);
  add(new THREE.TorusKnotGeometry(0.9, 0.3, 160, 24), mats.knot, a, [0, 1.4, -0.5], [0.4, 0.3, 0]);
  add(new THREE.BoxGeometry(2, 2, 2, 8, 8, 8), mats.box, b, [3.2, 1, 0.3], [0.2, 0.7, 0]);
  add(new THREE.PlaneGeometry(30, 30), mats.ground, a, [0, 0, 0], [-Math.PI / 2, 0, 0]);
  add(pg, mats.pillar, c, [-1.2, 1.6, 2.2], [0, 0, 0.12]);
  add(new THREE.DodecahedronGeometry(0.9, 1), mats.rock, c, [1.4, 0.6, 2.4], [0.3, 0.5, 0]);
  tsl?.(sun);
  return { scene, camera, sun, mats };
}

// M4 T3 进阶能力对拍场景：muralLayer 壁画风化（含钩子改 muralP / muralK）、InstancedMesh（实例色 + 逐实例噪声偏移）、
// rest: true（CPU 形变网格固定纹理坐标）、fragmentNormal（微面闪光法线扰动 + overlay）、vertexBegin（顶点弯曲形变）、translucent 半透明面。
export function toonAdvancedScene({ THREE, kind, shared, W, H, TSL = null, mural = null, mutate = null }) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x525882);
  const camera = new THREE.PerspectiveCamera(32, W / H, 0.5, 200);
  camera.position.set(0, 2.6, 13); camera.lookAt(0, 0.5, 0);
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(5, 8, 5);
  scene.add(sun);

  const km = kind({ name: 'tMural', shared, firstId: 1, layers: mural ? [mural] : [] });
  const kp = kind({ name: 'tPlain', shared, firstId: 40 });
  const mut = mutate || {};

  // 1) muralLayer + rest: true（顶点已做正弦弯曲，但 aRest 保持未弯曲坐标）
  const muralMat = km.make({
    color: '#3E7A9C', shade1: '#284E6E', shade2: '#1B334C', rest: true,
    muralAmt: mut.muralAmt ?? 0.85, muralScale: 1.4, muralGround: '#E6D3AC', stainTint: [0.58, 0.5, 0.6],
    fadeAmt: 0.45, fleckAmt: 0.6, chipAmt: 0.65, stainAmt: 0.5, dotAmt: 0.5,
    fragmentBase: 'toonMuralP = vToonObj * 1.2 + vec3(0.3, 0.0, 0.0);\ntoonMuralK = step(-0.5, vToonObj.y);',
    tsl: TSL && {
      fragmentBase: c => {
        c.muralP.assign(c.obj.mul(1.2).add(TSL.vec3(0.3, 0, 0)));
        c.muralK.assign(TSL.step(-0.5, c.obj.y));
      },
    },
  });
  const restGeo = new THREE.CylinderGeometry(0.75, 0.85, 2.8, 32, 16);
  const posAttr = restGeo.attributes.position;
  const restArr = new Float32Array(posAttr.array);   // 形变前的静止坐标
  restGeo.setAttribute('aRest', new THREE.BufferAttribute(restArr, 3));
  for (let i = 0; i < posAttr.count; i++) {
    const y = posAttr.getY(i);
    posAttr.setX(i, posAttr.getX(i) + (mut.ignoreRest ? 0 : 0.45 * Math.sin(y * 1.4)));
  }
  posAttr.needsUpdate = true;
  restGeo.computeVertexNormals();
  const muralMesh = km.bind(new THREE.Mesh(restGeo, muralMat), muralMat);
  muralMesh.position.set(-3.4, 0.8, 0);
  scene.add(muralMesh);

  // 2) InstancedMesh（3 个实例，各自带 instanceColor，且依赖 gl_InstanceID / instanceIndex 的噪声偏移）
  const instMat = kp.make({
    color: '#ffffff', shade1Tint: [0.6, 0.64, 0.84], shade2Tint: [0.35, 0.38, 0.62],
    edgeNoise: 0.14, edgeNoiseScale: 1.5, rimColor: '#FFD3B0', rimAmt: 0.75,
  });
  const instGeo = new THREE.SphereGeometry(0.78, 32, 20);
  const inst = kp.bind(new THREE.InstancedMesh(instGeo, instMat, 3), instMat);
  const colors = ['#E2683C', '#76BE9E', '#EBC57A'];
  for (let i = 0; i < 3; i++) {
    const m = new THREE.Matrix4().makeTranslation(-0.9 + i * 1.15, 0.3 + i * 0.45, -0.4 + i * 0.35);
    inst.setMatrixAt(i, m);
    inst.setColorAt(i, new THREE.Color(mut.noInstColor ? '#ffffff' : colors[i]));
  }
  inst.instanceMatrix.needsUpdate = true;
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  scene.add(inst);

  // 3) fragmentNormal + vertexBegin 钩子（波浪形变面片 + 微面法线偏转与亮金叠色）
  const glintColor = new THREE.Color('#FFE484');
  const hookMat = kp.make({
    color: '#2C5C9C', shade1: '#1F3F78', shade2: '#16294F', rimColor: '#F2A0A6', rimAmt: 0.6,
    uniforms: { uGlint: { value: glintColor } },
    vertexBegin: 'transformed.z += sin( position.y * 2.2 ) * 0.25;',
    vertexNormal: 'objectNormal = normalize( objectNormal + vec3( 0.0, -cos( position.y * 2.2 ) * 0.55, 0.0 ) );',
    fragmentPars: 'uniform vec3 uGlint;\n',
    fragmentNormal: mut.noFragNormal ? '' : `{
      normal = normalize( normal + vec3( 0.35, 0.2, 0.0 ) );
      float spec = smoothstep( 0.72, 0.96, dot( normal, normalize( normalize( vViewPosition ) + directionalLights[0].direction ) ) );
      toonOverlay = vec4( uGlint, spec * 0.85 );
    }`,
    tsl: TSL && {
      uniforms: { uGlint: TSL.uniform(glintColor) },
      vertexBegin: v => { v.pos.z.addAssign(TSL.sin(v.pos.y.mul(2.2)).mul(mut.noVertexHook ? 0 : 0.25)); },
      vertexNormal: v => { v.normal.assign(TSL.normalize(v.normal.add(TSL.vec3(0, TSL.cos(v.pos.y.mul(2.2)).mul(-0.55), 0)))); },
      fragmentNormal: mut.noFragNormal ? undefined : c => {
        const { normalize, vec3, vec4, smoothstep, dot } = TSL;
        c.normal.assign(normalize(c.normal.add(vec3(0.35, 0.2, 0))));
        const spec = smoothstep(0.72, 0.96, dot(c.normal, normalize(c.viewDir.add(c.lightDir))));
        c.overlay.assign(vec4(c.u.uGlint, spec.mul(0.85)));
      },
    },
  });
  const wing = kp.bind(new THREE.Mesh(new THREE.BoxGeometry(1.5, 2.4, 0.35, 8, 24, 4), hookMat), hookMat);
  wing.position.set(3.2, 0.9, 0.2); wing.rotation.set(0.15, -0.35, 0.1);
  scene.add(wing);

  // 4) translucent 半透明薄翼（盖在实例化球前面一部分）
  const veilMat = kp.make({
    color: '#A79AD6', shade1: '#6F6AAB', shade2: '#454A80',
    translucent: true, opacity: mut.veilOpacity ?? 0.52, side: THREE.DoubleSide, rimColor: '#FFF4EA', rimAmt: 0.7,
  });
  const veil = kp.bind(new THREE.Mesh(new THREE.PlaneGeometry(2.1, 1.5), veilMat), veilMat, { castShadow: false, outline: false });
  veil.position.set(0.2, 0.4, 2.2); veil.rotation.set(-0.1, 0.2, 0.05);
  scene.add(veil);

  return { scene, camera, sun };
}
