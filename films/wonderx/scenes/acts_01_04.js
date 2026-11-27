// WonderX Phase 2 v4 · 第一至第四幕 3D 场景（A01 激光剖屏、A02 破框尖塔、A03 六层精密爆炸拆解、A04 光学棱镜与焦散）
import * as THREE from 'three';
import {
  PALETTE,
  createRng,
  clamp,
  lerp,
  smoothstep,
  easeOutCubic,
  easeInOutCubic,
} from './shared.js';

// ── 第一幕：白底 PPT 被 8 模态 GLSL 滤镜扫屏 + 朱红激光斜向剖开（对位 H1） ──
function buildAct01(brushedTex) {
  const group = new THREE.Group();
  group.name = 'act01';

  // 背后隐藏的黑曜数据尖塔矩阵（激光剖开裂缝后直接露出真三维世界）
  const behind = new THREE.Group();
  const rng = createRng(10101);
  const metalMat = new THREE.MeshStandardMaterial({
    color: 0x202736,
    metalness: 0.88,
    roughness: 0.28,
    roughnessMap: brushedTex,
  });
  const cyanEmissive = new THREE.MeshStandardMaterial({
    color: 0x0d2a38,
    emissive: 0x4ce0f5,
    emissiveIntensity: 1.65,
    metalness: 0.3,
    roughness: 0.25,
  });
  const vermMat = new THREE.MeshStandardMaterial({
    color: 0x2b0c09,
    emissive: 0xd2452c,
    emissiveIntensity: 2.2,
    metalness: 0.2,
    roughness: 0.2,
  });
  for (let i = 0; i < 36; i++) {
    const col = (i % 9) - 4;
    const row = Math.floor(i / 9) - 1.5;
    const h = 1.6 + rng() * 5.8;
    const w = 0.28 + rng() * 0.24;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), metalMat);
    mesh.position.set(col * 0.92 + (rng() - 0.5) * 0.16, h * 0.5 - 2.6, -2.2 - row * 1.15);
    behind.add(mesh);
    if (i % 3 === 0) {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(w * 0.22, h * 0.88, w * 1.04), i % 9 === 0 ? vermMat : cyanEmissive);
      strip.position.copy(mesh.position);
      behind.add(strip);
    }
  }
  group.add(behind);

  // 程序化 2D 白底传统商务 PPT 画布贴图（供 8 模态 GLSL 滤镜接管 + 激光斜切）
  const pptCanvas = document.createElement('canvas');
  pptCanvas.width = 1280;
  pptCanvas.height = 720;
  const pctx = pptCanvas.getContext('2d');
  const pptTex = new THREE.CanvasTexture(pptCanvas);
  pptTex.colorSpace = THREE.SRGBColorSpace;
  pptTex.minFilter = THREE.LinearFilter;
  pptTex.magFilter = THREE.LinearFilter;

  function drawSlideCanvas(progress, hijack, delProg, typedChars, t) {
    pctx.fillStyle = '#F5F6F8';
    pctx.fillRect(0, 0, 1280, 720);
    // 顶部灰蓝条
    pctx.fillStyle = '#E4E8EE';
    pctx.fillRect(0, 0, 1280, 58);
    pctx.fillStyle = '#6B7485';
    pctx.font = '400 18px "WX Text", sans-serif';
    pctx.fillText('2027 年度核心产品战略规划 · 内部汇报稿', 44, 36);
    const secStr = `${String(Math.floor(t / 60)).padStart(2, '0')}:${(t % 60).toFixed(1).padStart(4, '0')}`;
    pctx.fillStyle = hijack > 0.02 ? '#D2452C' : '#6B7485';
    pctx.font = '600 15px "WX Sans", "WX Text", sans-serif';
    pctx.fillText(hijack > 0.02 ? `OVERRIDE  ${secStr}` : `LIVE DECK  ${secStr}`, 884, 35);
    pctx.fillStyle = '#6B7485';
    pctx.font = '400 18px "WX Text", sans-serif';
    pctx.fillText('CONFIDENTIAL', 1104, 36);

    // 叙事审计扫描带（开场 ~10s 持续扫描传统 PPT，接管阶段加速锁定；循环卷绕保持总亮度恒定、无闪无冻）
    pctx.save();
    pctx.beginPath();
    pctx.rect(0, 58, 1280, 622);
    pctx.clip();
    const scanSpan = 622;
    const scanSpeed = hijack > 0.02 ? 235 : 190;
    const scanOffset = (t * scanSpeed) % scanSpan;
    const bandH = 44;
    for (const shift of [0, -scanSpan]) {
      const sy = 58 + scanOffset + shift;
      const g = pctx.createLinearGradient(0, sy - bandH, 0, sy + 4);
      g.addColorStop(0, 'rgba(210, 69, 44, 0)');
      g.addColorStop(0.75, hijack > 0.02 ? 'rgba(210, 69, 44, 0.19)' : 'rgba(210, 69, 44, 0.14)');
      g.addColorStop(1, hijack > 0.02 ? 'rgba(210, 69, 44, 0.78)' : 'rgba(210, 69, 44, 0.56)');
      pctx.fillStyle = g;
      pctx.fillRect(0, sy - bandH, 1280, bandH + 4);
      pctx.fillStyle = hijack > 0.02 ? '#D2452C' : 'rgba(210, 69, 44, 0.78)';
      pctx.fillRect(0, sy, 1280, 2.5);
    }
    pctx.restore();

    // 主标题区（第 1 拍光标待机审计，第 2 拍被朱红选框锁死并改写）
    const origTitle = '季度业务增长与平台架构规划汇报';
    const newTitle = '这页 PPT，配不上你的产品。';
    const titleText = hijack < 0.05
      ? origTitle
      : (hijack < 0.42
        ? origTitle.slice(0, Math.max(0, Math.floor(origTitle.length * (1 - (hijack - 0.05) / 0.37))))
        : newTitle.slice(0, Math.min(newTitle.length, Math.floor(typedChars))));

    if (hijack > 0.02) {
      const pulse = 0.75 + 0.25 * Math.sin(t * 9.0);
      pctx.strokeStyle = `rgba(210, 69, 44, ${pulse.toFixed(3)})`;
      pctx.lineWidth = 4;
      pctx.strokeRect(42, 86, 860, 82);
      pctx.fillStyle = '#D2452C';
      pctx.fillRect(42, 62, 170, 24);
      pctx.fillStyle = '#FFFFFF';
      pctx.font = '700 13px "WX Sans", "WX Text", sans-serif';
      pctx.fillText('LOCKED · HIJACK', 52, 79);
    }
    pctx.fillStyle = hijack >= 0.42 ? '#D2452C' : '#1E2430';
    pctx.font = '700 46px "WX Serif", "WX Text", sans-serif';
    const showCaret = hijack > 0.04 ? (hijack < 0.96 || Math.sin(t * 8.0) > 0) : (Math.sin(t * 5.2) > 0);
    pctx.fillText(titleText + (showCaret ? '▎' : ''), 56, 144);

    // 5 条枯燥要点（第 1 拍演讲光标逐行审计高亮；第 2 拍平滑逐条划红删除）
    const bullets = [
      '• 持续深化多部门协同机制，稳步推进季度关键指标落地',
      '• 聚焦核心技术架构迭代升级，全面赋能生态业务高质量发展',
      '• 优化跨端资源配置效率，进一步巩固既有市场领先优势',
      '• 构建端到端闭环治理体系，保障核心系统高可用平稳运行',
      '• 探索新一代智能化应用场景，打造差异化长期增长飞轮',
    ];
    if (hijack <= 0.02) {
      const focusIdx = clamp((progress / 0.32) * 5.0, 0, 4.99);
      const focusY = 216 + focusIdx * 58;
      pctx.fillStyle = 'rgba(130, 146, 174, 0.14)';
      pctx.fillRect(44, focusY, 720, 38);
      pctx.fillStyle = '#D2452C';
      pctx.fillRect(44, focusY, 4, 38);
    }
    pctx.font = '400 22px "WX Text", "WX Sans", sans-serif';
    bullets.forEach((line, idx) => {
      const y = 242 + idx * 58;
      const strikeFrac = clamp(delProg - idx, 0, 1);
      const struck = strikeFrac > 0.01;
      pctx.fillStyle = strikeFrac > 0.5 ? '#AAB2C0' : '#3C4556';
      pctx.fillText(line, 60, y);
      if (struck) {
        pctx.strokeStyle = '#D2452C';
        pctx.lineWidth = 3;
        pctx.beginPath();
        pctx.moveTo(54, y - 8);
        pctx.lineTo(54 + 688 * strikeFrac, y - 8);
        pctx.stroke();
      }
    });

    // 右侧扁平灰柱图 + 实时基准探针（柱图保持死板灰调，仅探针线平滑扫描准备升维）
    pctx.fillStyle = '#FFFFFF';
    pctx.strokeStyle = '#D2D8E2';
    pctx.lineWidth = 2;
    pctx.fillRect(806, 206, 424, 386);
    pctx.strokeRect(806, 206, 424, 386);
    pctx.fillStyle = '#5B6475';
    pctx.font = '600 18px "WX Text", "WX Sans", sans-serif';
    pctx.fillText('传统季度指标（静态柱图）', 834, 246);
    const bars = [0.26, 0.34, 0.41, 0.49, 0.56, 0.64];
    const probeX = 834 + ((t * 92) % 368);
    bars.forEach((b, i) => {
      const bx = 842 + i * 60;
      const bh = Math.round(b * 260);
      const underProbe = Math.abs(probeX - (bx + 19)) < 26;
      pctx.fillStyle = underProbe ? '#9AA5B8' : (i === 5 ? '#7E8796' : '#B7C0CE');
      pctx.fillRect(bx, 540 - bh, 38, bh);
      pctx.fillStyle = '#737D8F';
      pctx.font = '500 14px "WX Sans", "WX Text", sans-serif';
      pctx.fillText(`Q${i + 1}`, bx + 8, 566);
    });
    pctx.strokeStyle = hijack > 0.02 ? 'rgba(210, 69, 44, 0.65)' : 'rgba(110, 126, 152, 0.55)';
    pctx.lineWidth = 1.5;
    pctx.beginPath();
    pctx.moveTo(probeX, 266);
    pctx.lineTo(probeX, 548);
    pctx.stroke();

    // 底部接管进度条与页码（贯穿第 1-2 拍平滑推进至 100%，自然衔接第 3 拍 GLSL 扫屏）
    const armPct = clamp(progress / 0.65, 0, 1);
    pctx.fillStyle = '#DCE2EB';
    pctx.fillRect(56, 666, 686, 6);
    pctx.fillStyle = hijack > 0.02 ? '#D2452C' : '#7E8A9E';
    pctx.fillRect(56, 666, Math.round(686 * armPct), 6);
    pctx.fillStyle = hijack > 0.02 ? '#D2452C' : '#6B7485';
    pctx.font = '600 13px "WX Sans", "WX Text", sans-serif';
    pctx.fillText(
      hijack > 0.02
        ? `BEIMING ENGINE OVERRIDE  ·  ${Math.round(armPct * 100)}%`
        : `STATIC DECK AUDIT  ·  ${Math.round(armPct * 100)}%`,
      56,
      654
    );

    // 页底传统页码
    pctx.fillStyle = '#8B95A5';
    pctx.font = '500 16px "WX Sans", "WX Text", sans-serif';
    pctx.fillText('SLIDE 1 / 48', 1126, 686);
    pptTex.needsUpdate = true;
  }
  drawSlideCanvas(0, 0, 0, 0, 0);

  // 8 模态 GLSL 滤镜 + 朱红斜切剖屏材质（零外部图，单着色器平滑扫过 8 种科技滤镜）
  const planeMat = new THREE.ShaderMaterial({
    transparent: true,
    side: THREE.DoubleSide,
    uniforms: {
      uTex: { value: pptTex },
      uTime: { value: 0 },
      uFilterPhase: { value: 0 }, // 0=原白页，0..8 连续扫过 8 种科技滤镜
      uCut: { value: 0 },         // 0..1 朱红激光斜向剖屏并拉开裂缝
      uPointer: { value: new THREE.Vector2(0.5, 0.5) },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uTex;
      uniform float uTime;
      uniform float uFilterPhase;
      uniform float uCut;
      uniform vec2 uPointer;
      varying vec2 vUv;

      float hash21(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }

      vec3 evalFilterMode(int mode, vec2 uv, vec3 base, float luma, float edgeVal, float diag) {
        if (mode < 0) return base;
        if (mode == 0) {
          // 1. 深普鲁士蓝 CAD 蓝图
          float grid = step(0.95, fract(uv.x * 28.0)) + step(0.95, fract(uv.y * 16.0));
          return mix(vec3(0.043, 0.137, 0.275), vec3(0.30, 0.88, 0.96), clamp(edgeVal * 1.4 + grid * 0.22 + (1.0 - luma) * 0.55, 0.0, 1.0));
        } else if (mode == 1) {
          // 2. 精密线框拓扑
          float tri = abs(fract((uv.x + uv.y) * 18.0) - 0.5);
          float wf = smoothstep(0.46, 0.49, tri);
          return vec3(0.04, 0.06, 0.09) + vec3(0.30, 0.88, 0.96) * (edgeVal * 1.3 + wf * 0.28);
        } else if (mode == 2) {
          // 3. 冰青 LiDAR 点云
          vec2 cell = fract(uv * vec2(110.0, 62.0)) - 0.5;
          float dotM = smoothstep(0.32, 0.16, length(cell));
          return vec3(0.02, 0.05, 0.08) + vec3(0.30, 0.88, 0.96) * dotM * (0.25 + (1.0 - luma) * 1.2);
        } else if (mode == 3) {
          // 4. 红外热力矩阵
          float h = clamp(1.0 - luma + edgeVal * 0.5, 0.0, 1.0);
          return mix(vec3(0.06, 0.08, 0.22), mix(vec3(0.824, 0.271, 0.173), vec3(1.0, 0.72, 0.36), h), smoothstep(0.15, 0.9, h));
        } else if (mode == 4) {
          // 5. 光学色散折射（压稳亮部避免与前后暗态反差过激）
          float r = texture2D(uTex, uv + vec2(0.008, 0.002)).r;
          float g = texture2D(uTex, uv).g;
          float b = texture2D(uTex, uv - vec2(0.008, 0.002)).b;
          return vec3(r, g, b) * vec3(0.58, 0.66, 0.80);
        } else if (mode == 5) {
          // 6. 黑曜暗场反相金属
          return mix(vec3(0.045, 0.052, 0.070), vec3(0.88, 0.92, 0.97), clamp((1.0 - luma) * 1.15 + edgeVal * 0.5, 0.0, 1.0));
        } else if (mode == 6) {
          // 7. 晶格碎裂偏移（连续相位位移，消除离散跳格）
          vec2 blk = floor(uv * vec2(16.0, 9.0));
          float rnd = hash21(blk + 1.3);
          float drift = sin(uTime * 3.0 + blk.y * 1.7 + rnd * 6.2831);
          vec2 suv = clamp(uv + vec2(drift * 0.022, (hash21(blk + 3.1) - 0.5) * 0.014), 0.0, 1.0);
          return mix(texture2D(uTex, suv).rgb, vec3(0.06, 0.08, 0.11), 0.58) + vec3(0.824, 0.271, 0.173) * step(0.84, rnd) * 0.36;
        }
        // 8. 激光校准暗场锁死
        float scan = smoothstep(0.025, 0.0, abs(diag));
        vec3 fx = mix(base * 0.86, vec3(0.06, 0.07, 0.10), smoothstep(-0.02, 0.02, diag));
        fx += vec3(0.824, 0.271, 0.173) * scan * 1.6;
        return fx;
      }

      void main() {
        // 对角激光线：从左下偏中斜切至右上，与 H1 构图一致
        float diag = (vUv.x - 0.52) * 0.88 - (vUv.y - 0.46) * 0.54;
        float side = diag >= 0.0 ? 1.0 : -1.0;

        // 激光拉开裂缝的错位与裂隙透明度（从 uCut=0.08 处连续归零起拉，避免单帧跳缝）
        float gap = max(0.0, uCut - 0.08) * 0.26;
        if (gap > 0.0005 && abs(diag) < gap) {
          // 激光核心光焰 + 炽热朱红边缘
          float edge = abs(abs(diag) - gap);
          float glow = exp(-edge * 68.0) * smoothstep(0.08, 0.25, uCut);
          if (glow < 0.04) discard;
          vec3 laserCol = mix(vec3(0.824, 0.271, 0.173), vec3(1.0, 0.86, 0.72), exp(-edge * 160.0));
          gl_FragColor = vec4(laserCol * 1.45, clamp(glow * 1.5, 0.0, 1.0));
          return;
        }

        // 左右两片随剖开错动
        vec2 uv = vUv;
        if (gap > 0.0005) {
          uv += vec2(0.88, -0.54) * (-side * gap * 0.65);
        }
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;

        vec3 base = texture2D(uTex, uv).rgb;
        float luma = dot(base, vec3(0.299, 0.587, 0.114));
        // Sobel 风格边缘近似
        vec2 px = vec2(1.0 / 1280.0, 1.0 / 720.0);
        float lx = dot(texture2D(uTex, uv + vec2(px.x * 2.0, 0.0)).rgb, vec3(0.333));
        float ly = dot(texture2D(uTex, uv + vec2(0.0, px.y * 2.0)).rgb, vec3(0.333));
        float edgeVal = clamp(length(vec2(luma - lx, luma - ly)) * 7.5, 0.0, 1.0);

        vec3 col = base;
        if (uFilterPhase > 0.0) {
          // C0 连续横扫：每一模态边界左端从 prev 平滑扫至 curr，零单帧整屏跳变
          float band = clamp(uFilterPhase, 0.0, 8.0);
          int curr = int(floor(min(band, 7.999)));
          float sweepX = band >= 7.999 ? 1.0 : fract(band);
          int prev = curr - 1;
          float wipePos = mix(-0.22, 1.22, sweepX);
          float coord = uv.x + 0.05 * sin(uv.y * 5.0);
          float wMask = smoothstep(wipePos - 0.16, wipePos + 0.16, coord);
          vec3 prevCol = evalFilterMode(prev, uv, base, luma, edgeVal, diag);
          vec3 currCol = evalFilterMode(curr, uv, base, luma, edgeVal, diag);
          col = mix(currCol, prevCol, wMask);
          float front = exp(-abs(coord - wipePos) * 34.0) * sin(sweepX * 3.14159265);
          col += vec3(0.95, 0.34, 0.20) * front * 0.52;
        }

        // 激光剖屏前的预热切线与剖屏后的热熔朱红边缘
        float seamDist = abs(diag) - gap;
        float laserBeam = exp(-abs(seamDist) * 85.0) * smoothstep(0.0, 0.12, uCut);
        col += vec3(0.96, 0.34, 0.20) * laserBeam * 1.65;
        // 右半侧微微暗化，凸显左白 PPT vs 右黑曜暗场（呼应 H1）
        if (side > 0.0 && uCut > 0.02) {
          col = mix(col, vec3(0.045, 0.055, 0.078), smoothstep(0.05, 0.55, uCut) * 0.85);
        }

        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const slidePlane = new THREE.Mesh(new THREE.PlaneGeometry(7.2, 4.05), planeMat);
  slidePlane.position.set(0, 0.25, 1.2);
  group.add(slidePlane);

  // 实体朱红激光束 + 切口粒子火花
  const laserGeo = new THREE.CylinderGeometry(0.018, 0.018, 9.2, 12);
  const laserMesh = new THREE.Mesh(laserGeo, new THREE.MeshBasicMaterial({ color: 0xff5a36 }));
  laserMesh.position.set(0.12, 0.2, 1.26);
  laserMesh.rotation.z = -0.96;
  laserMesh.visible = false;
  group.add(laserMesh);

  let lastSig = '';
  function update(progress, t, pointer) {
    // Beat 1 (0..0.33): 传统白底 PPT 实时审计扫描；Beat 2 (0.33..0.66): 朱红锁定改写 + 逐行划删 + 接管蓄能；Beat 3 (0.64..1.0): 8 模态平滑 GLSL 扫屏 + 激光斜切剖开
    const hijack = smoothstep(0.32, 0.56, progress);
    const delProg = progress < 0.39 ? 0 : clamp((progress - 0.39) / 0.24) * 5.0;
    const typed = hijack < 0.42 ? 0 : Math.ceil(clamp((hijack - 0.42) / 0.52) * 14);
    const sig = `${Math.round(t * 24)}:${Math.round(progress * 1000)}`;
    if (sig !== lastSig) {
      drawSlideCanvas(progress, hijack, delProg, typed, t);
      lastSig = sig;
    }

    const filterPhase = progress < 0.64 ? 0 : clamp((progress - 0.64) / 0.26) * 8.0;
    const cut = smoothstep(0.76, 0.99, progress);
    planeMat.uniforms.uTime.value = t;
    planeMat.uniforms.uFilterPhase.value = filterPhase;
    planeMat.uniforms.uCut.value = cut;
    planeMat.uniforms.uPointer.value.set(pointer[0], pointer[1]);

    // 剖屏前轻微推镜与透视呼吸，剖屏后板面后退旋转露出深邃三维世界
    const prePush = smoothstep(0.0, 0.64, progress);
    slidePlane.position.z = lerp(1.2, 0.4 + cut * 0.9, cut);
    slidePlane.rotation.y = (pointer[0] - 0.5) * 0.08 * (0.2 + cut) + Math.sin(t * 0.42) * 0.012 * (1 - cut);
    slidePlane.rotation.x = (pointer[1] - 0.5) * -0.05 * (0.2 + cut);

    laserMesh.visible = cut > 0.02 && cut < 0.94;
    laserMesh.scale.set(1 + Math.sin(t * 42) * 0.25, smoothstep(0.02, 0.22, cut), 1);

    behind.position.z = lerp(-1.5, 0.2, cut);
    behind.rotation.y = (pointer[0] - 0.5) * 0.14;

    return {
      cameraPos: [lerp(0, (pointer[0] - 0.5) * 0.9, cut), lerp(0.2, 0.35 + (pointer[1] - 0.5) * -0.4, cut), lerp(lerp(8.35, 7.9, prePush), 6.2, cut)],
      cameraLook: [0, 0.2, 0],
      fov: lerp(39, 44, cut),
      stageLights: { keyPos: [4.5, 5.5, 6.5], keyColor: 0xeef5ff, rimColor: 0xd2452c, fillColor: 0x4ce0f5 },
    };
  }
  function markDirty() {
    lastSig = '';
    pptTex.needsUpdate = true;
  }
  return { group, update, markDirty };
}

// ── 第二幕：破框——二维图表拔地升华为 3D 钛金属数据摩天柱 + 顶穿悬浮 16:9 线框（对位 H1） ──
function buildAct02(brushedTex, gridTex) {
  const group = new THREE.Group();
  group.name = 'act02';

  // 黑曜反射网格地面
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(46, 46),
    new THREE.MeshStandardMaterial({
      color: 0x10141e,
      map: gridTex,
      metalness: 0.72,
      roughness: 0.32,
    })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -2.2;
  group.add(floor);

  // 悬浮 16:9 原幻灯片“天花板”线框（增长光轨直接顶穿它！）
  const frameGroup = new THREE.Group();
  const frameEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(8.8, 0.07, 4.95));
  const frameLine = new THREE.LineSegments(
    frameEdges,
    new THREE.LineBasicMaterial({ color: 0xf2f4f8, transparent: true, opacity: 0.72 })
  );
  frameGroup.add(frameLine);
  const frameGlass = new THREE.Mesh(
    new THREE.PlaneGeometry(8.8, 4.95),
    new THREE.MeshBasicMaterial({ color: 0x4ce0f5, transparent: true, opacity: 0.055, side: THREE.DoubleSide })
  );
  frameGlass.rotation.x = -Math.PI / 2;
  frameGroup.add(frameGlass);
  // 角标 L 形校准线
  const cornerMat = new THREE.MeshBasicMaterial({ color: 0xd2452c });
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const c1 = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.09, 0.06), cornerMat);
      c1.position.set(sx * 4.2, 0.02, sz * 2.45);
      const c2 = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.09, 0.42), cornerMat);
      c2.position.set(sx * 4.38, 0.02, sz * 2.27);
      frameGroup.add(c1, c2);
    }
  }
  frameGroup.position.set(0, 1.35, 0);
  group.add(frameGroup);

  // 64 座程序化拉丝钛金属 3D 数据摩天柱（InstancedMesh）+ 内发光灯条
  const COUNT = 64;
  const rng = createRng(20202);
  const towerGeo = new THREE.BoxGeometry(0.46, 1.0, 0.46);
  towerGeo.translate(0, 0.5, 0);
  const towerMat = new THREE.MeshStandardMaterial({
    color: 0x3b4558,
    metalness: 0.88,
    roughness: 0.24,
    roughnessMap: brushedTex,
  });
  const towers = new THREE.InstancedMesh(towerGeo, towerMat, COUNT);
  const glowGeo = new THREE.BoxGeometry(0.08, 0.94, 0.49);
  glowGeo.translate(0, 0.5, 0);
  const glowMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const glows = new THREE.InstancedMesh(glowGeo, glowMat, COUNT);

  const specs = [];
  const cCyan = new THREE.Color(PALETTE.iceCyan);
  const cWarm = new THREE.Color(PALETTE.warmTungsten);
  const cVerm = new THREE.Color(PALETTE.vermilion);
  for (let i = 0; i < COUNT; i++) {
    const gx = (i % 8) - 3.5;
    const gz = Math.floor(i / 8) - 3.5;
    const diagBoost = clamp((gx + 3.5) / 7 * 0.65 + (3.5 - gz) / 7 * 0.35, 0, 1);
    const maxH = 0.85 + Math.pow(diagBoost, 1.7) * 6.8 + rng() * 1.45;
    const sx = 0.72 + rng() * 0.6;
    const sz = 0.72 + rng() * 0.6;
    const delay = clamp(0.04 + (1 - diagBoost) * 0.25 + rng() * 0.12, 0, 0.65);
    specs.push({ x: gx * 1.02 + (rng() - 0.5) * 0.14, z: gz * 0.88 + (rng() - 0.5) * 0.12, maxH, sx, sz, delay });
    const col = maxH > 5.8 ? cVerm : (i % 3 === 0 ? cWarm : cCyan);
    glows.setColorAt(i, col);
  }
  glows.instanceColor.needsUpdate = true;
  group.add(towers, glows);

  // 朱红指数级增长光轨样条（直接顶穿 16:9 线框天花板刺向穹顶）
  const curvePts = [
    new THREE.Vector3(-4.2, -1.7, 2.2),
    new THREE.Vector3(-2.1, -0.7, 1.1),
    new THREE.Vector3(-0.3, 0.65, 0.2),
    new THREE.Vector3(1.5, 2.55, -0.7),
    new THREE.Vector3(3.1, 5.2, -1.5),
    new THREE.Vector3(4.3, 8.1, -2.1),
  ];
  const curve = new THREE.CatmullRomCurve3(curvePts);
  const ribbonGeo = new THREE.TubeGeometry(curve, 96, 0.085, 10, false);
  const ribbonMat = new THREE.MeshStandardMaterial({
    color: 0xd2452c,
    emissive: 0xff4b2b,
    emissiveIntensity: 2.2,
    metalness: 0.2,
    roughness: 0.25,
  });
  const ribbon = new THREE.Mesh(ribbonGeo, ribbonMat);
  group.add(ribbon);

  // 光轨顶端能量核
  const tipNode = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.26, 1),
    new THREE.MeshBasicMaterial({ color: 0xff7a5c })
  );
  group.add(tipNode);

  const dummy = new THREE.Object3D();
  function update(progress, t, pointer) {
    // Beat 1 (0..0.33): 2D 灰柱拉高成 3D 钛金属摩天柱
    // Beat 2 (0.33..0.67): 朱红光轨暴涨顶穿 16:9 悬浮线框
    // Beat 3 (0.67..1.0): 大摇臂低机位仰视 + 退远俯瞰原幻灯片缩成邮票
    const rise = easeOutCubic(clamp(0.24 + progress / 0.56));
    const surge = easeInOutCubic(clamp((progress - 0.26) / 0.42));
    const crane = easeInOutCubic(clamp((progress - 0.62) / 0.36));

    for (let i = 0; i < COUNT; i++) {
      const s = specs[i];
      const local = easeOutCubic(clamp((rise - s.delay * 0.45) / 0.58));
      const wave = 1 + Math.sin(t * 2.1 + s.x * 0.7 + s.z * 0.5) * 0.045;
      const h = Math.max(0.18, lerp(0.22, s.maxH * wave, local));
      dummy.position.set(s.x, -2.2, s.z);
      dummy.scale.set(s.sx, h, s.sz);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      towers.setMatrixAt(i, dummy.matrix);
      glows.setMatrixAt(i, dummy.matrix);
    }
    towers.instanceMatrix.needsUpdate = true;
    glows.instanceMatrix.needsUpdate = true;

    // 线框被顶穿时轻微震颤后相对缩小
    const frameScale = lerp(1.0, 0.42, crane);
    frameGroup.scale.setScalar(frameScale);
    frameGroup.position.y = lerp(1.35, -0.55, crane) + Math.sin(t * 3.0) * 0.03;
    frameGroup.rotation.z = lerp(0, -0.06, surge) + (pointer[0] - 0.5) * 0.05;

    // 光轨沿曲线推进
    const drawCount = Math.floor(ribbonGeo.index.count * clamp(0.08 + surge * 0.92, 0.05, 1));
    ribbonGeo.setDrawRange(0, drawCount);
    const tipPt = curve.getPoint(clamp(0.08 + surge * 0.92, 0.05, 1));
    tipNode.position.copy(tipPt);
    tipNode.rotation.set(t * 1.4, t * 2.1, 0);

    const px = (pointer[0] - 0.5) * 2.4;
    const py = (pointer[1] - 0.5) * -1.1;
    const camX = lerp(-4.8, 3.6, crane) + px;
    const camY = lerp(0.55, 5.4, crane) + py;
    const camZ = lerp(9.4, 11.8, crane);
    return {
      cameraPos: [camX, camY, camZ],
      cameraLook: [0.4, lerp(1.3, 1.8, surge), -0.4],
      fov: lerp(42, 46, crane),
      stageLights: { keyPos: [5, 9, 6], keyColor: 0xe6f2ff, rimColor: 0xd2452c, fillColor: 0x4ce0f5 },
    };
  }
  return { group, update };
}

// ── 第三幕：解剖——原创 AI 光学算力核 6 层同轴精密爆炸拆解 + 实时 3D→2D CAD 锚点（对位 H2） ──
function buildAct03(brushedTex, gridTex) {
  const group = new THREE.Group();
  group.name = 'act03';

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(36, 36),
    new THREE.MeshStandardMaterial({ color: 0x0b0e15, map: gridTex, metalness: 0.7, roughness: 0.38 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -3.1;
  group.add(floor);

  const rig = new THREE.Group();
  rig.rotation.z = -0.24; // 经典 14° 斜轴爆炸拆解角度（呼应 H2）
  group.add(rig);

  const titaniumMat = new THREE.MeshStandardMaterial({
    color: 0x262d3b,
    metalness: 0.92,
    roughness: 0.24,
    roughnessMap: brushedTex,
  });
  const titaniumLightMat = new THREE.MeshStandardMaterial({
    color: 0x626f86,
    metalness: 0.9,
    roughness: 0.22,
    roughnessMap: brushedTex,
  });
  const copperMat = new THREE.MeshStandardMaterial({
    color: 0xb97a46,
    metalness: 0.9,
    roughness: 0.26,
  });
  const sapphireMat = new THREE.MeshPhysicalMaterial({
    color: 0x7beeff,
    emissive: 0x104c63,
    emissiveIntensity: 0.55,
    metalness: 0.08,
    roughness: 0.06,
    transmission: 0.65,
    transparent: true,
    opacity: 0.84,
    ior: 1.76,
    thickness: 0.4,
  });
  const vermCoreMat = new THREE.MeshStandardMaterial({
    color: 0x3b0f0a,
    emissive: 0xd2452c,
    emissiveIntensity: 2.3,
    metalness: 0.35,
    roughness: 0.2,
  });
  const cyanCoreMat = new THREE.MeshStandardMaterial({
    color: 0x0a2e3c,
    emissive: 0x4ce0f5,
    emissiveIntensity: 1.85,
    metalness: 0.3,
    roughness: 0.2,
  });

  // 6 层沿主轴 (X) 精密爆炸拆解组件
  const layers = [];
  const makeLayer = (id, label, spec, baseX, explodeX) => {
    const g = new THREE.Group();
    rig.add(g);
    const anchor = new THREE.Object3D();
    g.add(anchor);
    layers.push({ id, label, spec, g, anchor, baseX, explodeX });
    return { g, anchor };
  };

  // Layer 0: 阳极氧化暗钛前保护环壳
  {
    const { g, anchor } = makeLayer('L1', '阳极氧化暗钛外壳', 'Ø 148.0 mm · Ti-6Al-4V', 1.05, 3.65);
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(1.55, 1.62, 0.42, 48, 1, true), titaniumMat);
    ring.rotation.z = Math.PI / 2;
    g.add(ring);
    const bezel = new THREE.Mesh(new THREE.TorusGeometry(1.56, 0.11, 16, 48), titaniumLightMat);
    bezel.rotation.y = Math.PI / 2;
    bezel.position.x = 0.2;
    g.add(bezel);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.22, 8), titaniumLightMat);
      bolt.rotation.z = Math.PI / 2;
      bolt.position.set(0.24, Math.cos(a) * 1.44, Math.sin(a) * 1.44);
      g.add(bolt);
    }
    anchor.position.set(0.15, 1.56, 0.25);
  }

  // Layer 1: 多片蓝宝石光学透镜组
  {
    const { g, anchor } = makeLayer('L2', '多层蓝宝石透镜组', 'n = 1.76 · AR 420–680nm', 0.62, 2.25);
    const lens1 = new THREE.Mesh(new THREE.SphereGeometry(1.24, 36, 20, 0, Math.PI * 2, 0, 0.72), sapphireMat);
    lens1.rotation.z = -Math.PI / 2;
    lens1.scale.set(1, 0.34, 1);
    lens1.position.x = 0.08;
    const lensRing = new THREE.Mesh(new THREE.TorusGeometry(1.18, 0.06, 12, 48), titaniumLightMat);
    lensRing.rotation.y = Math.PI / 2;
    const innerRing = new THREE.Mesh(new THREE.TorusGeometry(0.76, 0.025, 10, 40), cyanCoreMat);
    innerRing.rotation.y = Math.PI / 2;
    innerRing.position.x = -0.14;
    g.add(lens1, lensRing, innerRing);
    anchor.position.set(0, -1.24, 0.2);
  }

  // Layer 2: 光子波导晶格阵列
  {
    const { g, anchor } = makeLayer('L3', '光子波导晶格阵列', '64-CH · 1.6 TB/s', 0.22, 0.85);
    const frame = new THREE.Mesh(new THREE.CylinderGeometry(1.28, 1.28, 0.12, 6), titaniumMat);
    frame.rotation.z = Math.PI / 2;
    g.add(frame);
    for (let r = -2; r <= 2; r++) {
      for (let c = -2; c <= 2; c++) {
        if (r * r + c * c > 5) continue;
        const bar = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.14, 0.14), (r + c) % 2 === 0 ? cyanCoreMat : titaniumLightMat);
        bar.position.set(0.04, r * 0.34, c * 0.34);
        g.add(bar);
      }
    }
    anchor.position.set(0, 1.28, -0.15);
  }

  // Layer 3: 朱红 + 冰青神经光子芯片核（视觉焦点）
  {
    const { g, anchor } = makeLayer('L4', '神经光子算力芯片核', '4.8 PFLOPS · 4nm Photonic', -0.18, -0.55);
    const substrate = new THREE.Mesh(new THREE.BoxGeometry(0.22, 1.92, 1.92), titaniumMat);
    const die = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.96, 0.96), vermCoreMat);
    die.position.x = 0.04;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.76, 0.032, 10, 4), cyanCoreMat);
    ring.rotation.y = Math.PI / 2;
    ring.rotation.x = Math.PI / 4;
    ring.position.x = 0.15;
    g.add(substrate, die, ring);
    // 周边 24 根微引脚
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const pin = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.04, 0.24), copperMat);
      pin.position.set(0.05, Math.cos(a) * 1.12, Math.sin(a) * 1.12);
      pin.rotation.x = -a;
      g.add(pin);
    }
    anchor.position.set(0.12, -1.18, 0.45);
  }

  // Layer 4: 放射状均热板与散热鳍片群
  {
    const { g, anchor } = makeLayer('L5', '36 片微通道散热鳍片', '185W TDP · Vapor Chamber', -0.62, -2.05);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.54, 0.54, 0.42, 24), copperMat);
    hub.rotation.z = Math.PI / 2;
    g.add(hub);
    for (let i = 0; i < 36; i++) {
      const a = (i / 36) * Math.PI * 2;
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.025, 0.88), i % 6 === 0 ? copperMat : titaniumLightMat);
      fin.position.set(0, Math.cos(a) * 0.96, Math.sin(a) * 0.96);
      fin.rotation.x = -a;
      g.add(fin);
    }
    anchor.position.set(0, 1.38, 0.1);
  }

  // Layer 5: 后部电源母线与光纤背板底座
  {
    const { g, anchor } = makeLayer('L6', '光纤互连背板与电源母线', '48V Direct · Lock-Bus', -1.06, -3.55);
    const back = new THREE.Mesh(new THREE.CylinderGeometry(1.48, 1.32, 0.46, 36), titaniumMat);
    back.rotation.z = Math.PI / 2;
    const portRing = new THREE.Mesh(new THREE.TorusGeometry(1.12, 0.05, 10, 36), vermCoreMat);
    portRing.rotation.y = Math.PI / 2;
    portRing.position.x = 0.22;
    g.add(back, portRing);
    anchor.position.set(-0.15, -1.42, -0.2);
  }

  // 同轴激光校准中心杆
  const axisRod = new THREE.Mesh(
    new THREE.CylinderGeometry(0.016, 0.016, 8.2, 10),
    new THREE.MeshBasicMaterial({ color: 0x4ce0f5, transparent: true, opacity: 0.42 })
  );
  axisRod.rotation.z = Math.PI / 2;
  rig.add(axisRod);

  const projected = [];
  const tmpV = new THREE.Vector3();

  function update(progress, t, pointer, input, camera) {
    // 若用户手动拖滑杆则采用 input.explode (0..1)，否则按 3 拍时间轴自动展开
    const autoExplode = progress < 0.24
      ? easeInOutCubic(progress / 0.24) * 0.18
      : easeInOutCubic(clamp((progress - 0.24) / 0.38)) * 0.82 + 0.18;
    const explode = input.explode != null ? clamp(input.explode, 0, 1) : autoExplode;
    const dive = easeInOutCubic(clamp((progress - 0.68) / 0.30));

    // 自由环绕偏移
    rig.rotation.y = Math.sin(t * 0.35) * 0.16 + (pointer[0] - 0.5) * 0.95;
    rig.rotation.x = (pointer[1] - 0.5) * 0.36;

    layers.forEach((L, idx) => {
      const hover = Math.sin(t * 1.8 + idx * 0.9) * 0.035 * explode;
      L.g.position.x = lerp(L.baseX, L.explodeX, explode) + hover;
      if (idx === 1 || idx === 4) {
        L.g.rotation.x = t * (idx === 1 ? 0.25 : -0.18) * (0.2 + explode);
      }
    });
    axisRod.scale.y = clamp(0.28 + explode * 0.92, 0.2, 1.2);
    axisRod.material.opacity = 0.12 + explode * 0.48;

    const camPos = [
      lerp(0.2, 1.45, dive) + (pointer[0] - 0.5) * 0.8,
      lerp(1.05, 0.32, dive) + (pointer[1] - 0.5) * -0.5,
      lerp(8.4, 3.85, dive),
    ];
    const camLook = [lerp(0, 0.45, dive), lerp(0.05, -0.05, dive), 0];

    // 计算 6 个 CAD 引线的实时 3D→2D 屏幕投影坐标（在 camera 更新后也会再刷一次）
    rig.updateMatrixWorld(true);
    projected.length = 0;
    if (camera) {
      camera.position.set(camPos[0], camPos[1], camPos[2]);
      camera.lookAt(camLook[0], camLook[1], camLook[2]);
      camera.fov = lerp(40, 34, dive);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);
      layers.forEach((L, idx) => {
        L.anchor.getWorldPosition(tmpV);
        tmpV.project(camera);
        projected.push({
          id: L.id,
          label: L.label,
          spec: L.spec,
          sx: (tmpV.x * 0.5 + 0.5) * 1920,
          sy: (-tmpV.y * 0.5 + 0.5) * 1080,
          side: idx % 2 === 0 ? 'top' : 'bottom',
          explode,
        });
      });
    }

    return {
      cameraPos: camPos,
      cameraLook: camLook,
      fov: lerp(40, 34, dive),
      cadAnchors: projected,
      explodeValue: explode,
      stageLights: { keyPos: [5, 6, 7], keyColor: 0xf0f6ff, rimColor: 0x4ce0f5, fillColor: 0xffb85c },
    };
  }
  return { group, update };
}

// ── 第四幕：棱光——高精度水晶棱镜物理色散 + 解析流体焦散地面 + 体积光锥（对位 H3） ──
function buildAct04() {
  const group = new THREE.Group();
  group.name = 'act04';

  // 镜面黑曜焦散地面（纯 GLSL 解析焦散，实时随入射角偏移）
  const causticMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uAngle: { value: 0 },
      uIntensity: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vWorldXZ;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldXZ = wp.xz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uAngle;
      uniform float uIntensity;
      varying vec2 vWorldXZ;

      float causticPattern(vec2 p, float t) {
        vec2 q = p * 1.45;
        float v = 0.0;
        for (int i = 0; i < 3; i++) {
          float fi = float(i) + 1.0;
          q += vec2(sin(q.y * 1.6 + t * 0.9 * fi), cos(q.x * 1.4 - t * 0.75 * fi)) * 0.42;
          v += abs(sin(q.x + q.y)) / fi;
        }
        return pow(clamp(1.18 - v * 0.72, 0.0, 1.0), 3.2);
      }

      void main() {
        vec2 p = vWorldXZ;
        float dist = length(p);
        vec3 base = mix(vec3(0.032, 0.038, 0.052), vec3(0.014, 0.016, 0.022), smoothstep(0.5, 11.0, dist));
        // 细腻校准网格反光
        float gx = smoothstep(0.97, 1.0, abs(cos(p.x * 3.14159)));
        float gz = smoothstep(0.97, 1.0, abs(cos(p.y * 3.14159)));
        base += vec3(0.09, 0.12, 0.16) * (gx + gz) * exp(-dist * 0.22) * 0.35;

        // 色散三波段焦散扇区（冰青 460nm、暖金 580nm、朱红 650nm）随入射角偏转
        vec2 fanOrigin = vec2(0.15, 0.0);
        vec2 d = p - fanOrigin;
        float rad = length(d);
        float ang = atan(d.y, d.x) - uAngle * 0.55;
        float forward = smoothstep(-0.35, 0.35, d.x) * exp(-rad * 0.19) * smoothstep(0.25, 1.4, rad);

        float cCyan = causticPattern(p + vec2(0.0, uAngle * 0.8), uTime) * exp(-pow((ang - 0.24) * 4.4, 2.0));
        float cGold = causticPattern(p + vec2(0.4, uAngle * 0.5), uTime * 1.07) * exp(-pow((ang - 0.02) * 4.8, 2.0));
        float cVerm = causticPattern(p + vec2(0.8, uAngle * 0.2), uTime * 0.93) * exp(-pow((ang + 0.22) * 4.4, 2.0));

        vec3 caustics =
          vec3(0.30, 0.88, 0.96) * cCyan * 1.45 +
          vec3(1.00, 0.72, 0.36) * cGold * 1.35 +
          vec3(0.88, 0.28, 0.18) * cVerm * 1.55;

        // 棱镜正下方暗场聚光晕
        float pool = exp(-rad * rad * 0.32) * 0.28;
        vec3 col = base + vec3(0.24, 0.38, 0.50) * pool + caustics * forward * uIntensity * 1.95;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(36, 36), causticMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -1.95;
  group.add(floor);

  // 高精度三角水晶切面棱镜（色散 Fresnel GLSL 材质）
  const prismGeo = new THREE.CylinderGeometry(1.48, 1.48, 2.35, 3, 1);
  const prismMat = new THREE.ShaderMaterial({
    transparent: true,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uSweep: { value: 0 },
      uLightDir: { value: new THREE.Vector3(-0.85, 0.25, 0.45).normalize() },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorldNormal;
      varying vec3 vWorldPos;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uSweep;
      uniform vec3 uLightDir;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPos;
      void main() {
        vec3 N = normalize(vWorldNormal);
        vec3 V = normalize(cameraPosition - vWorldPos);
        float ndv = abs(dot(N, V));
        float fresnel = pow(1.0 - ndv, 2.6);
        vec3 H = normalize(uLightDir + V);
        float spec = pow(max(dot(N, H), 0.0), 64.0);

        // 内部色散折射虹彩（冰青 -> 暖金 -> 朱红）
        float disp = clamp(dot(reflect(-V, N), uLightDir) * 0.5 + 0.5, 0.0, 1.0);
        vec3 specBand = mix(
          vec3(0.30, 0.88, 0.96),
          mix(vec3(1.0, 0.72, 0.36), vec3(0.86, 0.28, 0.18), smoothstep(0.45, 0.95, disp)),
          smoothstep(0.1, 0.85, disp)
        );

        // 扫光轮廓线
        float rimSweep = exp(-pow((vWorldPos.y - (uSweep * 3.4 - 1.7)) * 4.5, 2.0));
        vec3 col = vec3(0.08, 0.12, 0.18) * 0.55
          + specBand * (0.28 + fresnel * 1.25)
          + vec3(0.95, 0.98, 1.0) * (spec * 1.6 + rimSweep * 0.85);
        float alpha = clamp(0.34 + fresnel * 0.62 + spec * 0.4, 0.0, 0.96);
        gl_FragColor = vec4(col, alpha);
      }
    `,
  });
  const prism = new THREE.Mesh(prismGeo, prismMat);
  prism.position.set(0, 0.05, 0);
  const prismEdge = new THREE.LineSegments(
    new THREE.EdgesGeometry(prismGeo),
    new THREE.LineBasicMaterial({ color: 0xdaf6ff, transparent: true, opacity: 0.78 })
  );
  prism.add(prismEdge);
  // 精密暗钛悬浮底座环
  const plinth = new THREE.Mesh(
    new THREE.TorusGeometry(1.42, 0.045, 14, 60),
    new THREE.MeshStandardMaterial({ color: 0x3b4454, metalness: 0.92, roughness: 0.22 })
  );
  plinth.rotation.x = Math.PI / 2;
  plinth.position.y = -1.65;
  group.add(prism, plinth);

  // 入射准直白光束（左侧射入）
  const beamMat = (color, opacity) => new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const inBeamPivot = new THREE.Group();
  inBeamPivot.position.set(-0.35, 0.1, 0);
  const inBeam = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.11, 7.6, 16, 1, true), beamMat(0xf4f8ff, 0.68));
  inBeam.rotation.z = Math.PI / 2;
  inBeam.position.x = -3.8;
  inBeamPivot.add(inBeam);
  group.add(inBeamPivot);

  // 出射 5 道色散体积光锥（冰青 / 天蓝 / 暖金 / 琥珀 / 朱红）
  const outFan = new THREE.Group();
  outFan.position.set(0.32, 0.05, 0);
  const rays = [
    { color: 0x4ce0f5, angY: 0.34, angZ: -0.11, r1: 0.06, r2: 0.56 },
    { color: 0x8ef3ff, angY: 0.18, angZ: -0.09, r1: 0.05, r2: 0.42 },
    { color: 0xffb85c, angY: 0.01, angZ: -0.08, r1: 0.06, r2: 0.48 },
    { color: 0xff7b42, angY: -0.16, angZ: -0.09, r1: 0.05, r2: 0.44 },
    { color: 0xd2452c, angY: -0.32, angZ: -0.11, r1: 0.06, r2: 0.58 },
  ];
  const rayMeshes = rays.map(r => {
    const piv = new THREE.Group();
    piv.rotation.set(0, r.angY, r.angZ);
    const cone = new THREE.Mesh(
      new THREE.CylinderGeometry(r.r2, r.r1, 8.8, 18, 1, true),
      beamMat(r.color, 0.42)
    );
    cone.rotation.z = -Math.PI / 2;
    cone.position.x = 4.4;
    piv.add(cone);
    outFan.add(piv);
    return { piv, cone, baseY: r.angY };
  });
  group.add(outFan);

  function update(progress, t, pointer) {
    // Beat 1 (0..0.33): 扫光勾勒纯黑舞台水晶棱镜轮廓
    // Beat 2 (0.33..0.67): 准直白光射入色散为光谱束 + 焦散铺开
    // Beat 3 (0.67..1.0): 完整光学大片舞台，鼠标实时偏转入射角与色散焦散
    const beamOn = lerp(0.32, 1.0, easeOutCubic(clamp(progress / 0.42)));
    const dispOn = lerp(0.30, 1.0, easeOutCubic(clamp((progress - 0.04) / 0.46)));
    const mouseAngle = (pointer[0] - 0.5) * 0.72 + Math.sin(t * 0.55) * 0.12;
    const mousePitch = (pointer[1] - 0.5) * 0.28;

    prism.rotation.y = 0.88 + t * 0.28 + mouseAngle * 0.38;
    prism.rotation.z = 0.08 + Math.sin(t * 0.8) * 0.03;
    prism.position.y = 0.05 + Math.sin(t * 1.4) * 0.09;
    prismMat.uniforms.uTime.value = t;
    prismMat.uniforms.uSweep.value = (t * 0.45) % 1.0;
    prismMat.uniforms.uLightDir.value.set(-0.85, 0.22 + mousePitch, 0.42 + mouseAngle * 0.5).normalize();

    inBeamPivot.rotation.set(0, mouseAngle * 0.45, mousePitch * 0.45 + 0.14);
    inBeam.scale.set(1, Math.max(0.01, beamOn), 1);
    inBeam.material.opacity = 0.84 * beamOn;

    outFan.rotation.set(0, -mouseAngle * 0.68, -mousePitch * 0.35);
    rayMeshes.forEach((rm, idx) => {
      const local = easeOutCubic(clamp((dispOn - idx * 0.04) / 0.68));
      rm.cone.scale.set(1, Math.max(0.01, local), 1);
      rm.cone.material.opacity = 0.58 * local;
      rm.piv.rotation.y = rm.baseY * (1.0 + Math.abs(mouseAngle) * 0.35);
    });

    causticMat.uniforms.uTime.value = t;
    causticMat.uniforms.uAngle.value = mouseAngle;
    causticMat.uniforms.uIntensity.value = dispOn;

    return {
      cameraPos: [0.35 + (pointer[0] - 0.5) * 1.4, 1.45 + (pointer[1] - 0.5) * -0.65, 7.8],
      cameraLook: [0.45, -0.15, 0],
      fov: 40,
      stageLights: { keyPos: [-5, 6, 5], keyColor: 0xffffff, rimColor: 0x4ce0f5, fillColor: 0xffb85c },
    };
  }
  return { group, update };
}

export function createActs01to04(brushedTex, gridTex) {
  return {
    A01: buildAct01(brushedTex),
    A02: buildAct02(brushedTex, gridTex),
    A03: buildAct03(brushedTex, gridTex),
    A04: buildAct04(),
  };
}
