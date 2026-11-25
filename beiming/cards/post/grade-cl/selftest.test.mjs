// post.grade-cl 自测：径向色差、线性曝光、ACES 拟合、冷暖分离色调、暗角、闪光/淡入淡出、抖动，以及 comp.mjs 与 three.js 通道一致性。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three-webgpu';
import { scanCardLeaks, validateCard } from '../../validate-card.mjs';
import {
  acesFit,
  create as createComp,
  evaluate as evaluateComp,
  gradePixel,
} from './comp.mjs';
import {
  create as createThree,
  FRAGMENT_SHADER,
  VERTEX_SHADER,
} from './three.js';

const HERE = dirname(fileURLToPath(import.meta.url));

test('post.grade-cl：card.json 通过 validateCard 与 scanCardLeaks', () => {
  const raw = readFileSync(join(HERE, 'card.json'), 'utf8');
  assert.deepEqual(scanCardLeaks(raw), []);
  const card = JSON.parse(raw);
  assert.deepEqual(validateCard(card), { ok: true, schemaErrors: [], violations: {}, leaks: [] });
  assert.equal(card.id, 'post.grade-cl');
  assert.equal(card.kind, 'post');
  assert.deepEqual(card.livesIn, ['source:three', 'comp']);
});

test('post.grade-cl：ACES 拟合满足零点单调有界且高压亮部压缩不溢出', () => {
  const z = acesFit([0, 0, 0]);
  const mid = acesFit([0.18, 0.18, 0.18]);
  const hi = acesFit([1.0, 1.0, 1.0]);
  const hdr = acesFit([12.0, 12.0, 12.0]);
  for (let c = 0; c < 3; c++) {
    assert.ok(z[c] >= 0 && z[c] < 1e-4, `黑点偏差: ${z[c]}`);
    assert.ok(mid[c] > z[c] && hi[c] > mid[c] && hdr[c] > hi[c], 'ACES 拟合须严格单调递增');
    assert.ok(hdr[c] <= 1.0 && hdr[c] > 0.9, `高动态压缩有界: ${hdr[c]}`);
  }
});

test('post.grade-cl：分离色调使暗部偏冷、亮部偏暖，暗角使四角暗于中心，fade=0 全黑', () => {
  const dark = gradePixel([0.02, 0.02, 0.02], { grain: 0, vignette: 0, exposure: 1, fade: 1 });
  assert.ok(dark[2] > dark[0], `阴影应偏冷蓝: R=${dark[0]} B=${dark[2]}`);

  const bright = gradePixel([2.5, 2.5, 2.5], { grain: 0, vignette: 0, exposure: 1, fade: 1 });
  assert.ok(bright[0] > bright[2], `高光应偏暖琥珀: R=${bright[0]} B=${bright[2]}`);

  const w = 16, h = 16;
  const hdr = new Float32Array(w * h * 4);
  for (let i = 0; i < hdr.length; i += 4) {
    hdr[i] = 0.5; hdr[i + 1] = 0.5; hdr[i + 2] = 0.5; hdr[i + 3] = 1;
  }
  const out = evaluateComp({ color: hdr }, { grain: 0, vignette: 0.42, exposure: 1, fade: 1 }, [w, h]);
  const centerIdx = (8 * w + 8) * 4;
  const cornerIdx = 0;
  assert.ok(out[centerIdx] > out[cornerIdx] + 10, `暗角应使四角显著暗于中心: center=${out[centerIdx]} corner=${out[cornerIdx]}`);

  const black = evaluateComp({ color: hdr }, { grain: 0.018, vignette: 0.42, exposure: 1, fade: 0 }, [w, h]);
  let maxVal = 0;
  for (let i = 0; i < black.length; i += 4) maxVal = Math.max(maxVal, black[i], black[i + 1], black[i + 2]);
  assert.equal(maxVal, 0, 'fade=0 应输出纯黑');
});

test('post.grade-cl：径向色差分离边缘高对比条纹、Bloom/Shaft/Flash 叠加与三角/哈希抖动工作正常', () => {
  const w = 128, h = 64;
  const hdr = new Float32Array(w * h * 4);
  const bloom = new Float32Array(w * h * 4);
  const shaft = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const edge = x >= 112 ? 2.0 : 0.05;
      hdr[idx] = edge; hdr[idx + 1] = edge; hdr[idx + 2] = edge; hdr[idx + 3] = 1;
      bloom[idx] = 0.8; bloom[idx + 1] = 0.4; bloom[idx + 2] = 0.1; bloom[idx + 3] = 1;
      shaft[idx] = 0.5; shaft[idx + 1] = 0; shaft[idx + 2] = 0; shaft[idx + 3] = 1;
    }
  }
  const caOut = evaluateComp({ color: hdr }, { grain: 0, vignette: 0, caBase: 0.04, shake: 0.5, shadowTint: [0, 0, 0], highlightTint: [0, 0, 0] }, [w, h]);
  // 在四角高对比边界 x=111..112 处，红蓝采样坐标错开，产生可测色差
  let maxRB = 0;
  for (let i = 0; i < caOut.length; i += 4) {
    maxRB = Math.max(maxRB, Math.abs(caOut[i] - caOut[i + 2]));
  }
  assert.ok(maxRB > 15, `边缘应出现可测径向色差: max|R-B|=${maxRB}`);

  const baseOut = evaluateComp({ color: hdr }, { grain: 0, vignette: 0, bloom: 0, flash: 0 }, [w, h]);
  const compOut = evaluateComp(
    { color: hdr, bloom, shaft },
    { grain: 0, vignette: 0, bloom: 0.15, flash: 0.8, shaftColor: [1.0, 0.66, 0.38] },
    [w, h],
  );
  // 暗区 (x=16, y=32) 加入 bloom + flash + shaft 后显著变亮
  const darkIdx = (32 * w + 16) * 4;
  assert.ok(compOut[darkIdx] > baseOut[darkIdx] + 20, `Bloom+Flash+Shaft 应抬升暗部: ${baseOut[darkIdx]} -> ${compOut[darkIdx]}`);

  // 8-bit 三角抖动模式与哈希模式均具确定性
  const triA = evaluateComp({ color: hdr }, { ditherMode: 'triangular', grain: 0.018, time: 1.25 }, [w, h]);
  const triB = evaluateComp({ color: hdr }, { ditherMode: 'triangular', grain: 0.018, time: 1.25 }, [w, h]);
  assert.deepEqual(triA, triB);

  // comp.mjs 的 create 句柄接口可用
  const handle = createComp({}, { grain: 0, vignette: 0.42 });
  handle.apply(10, 0);
  const viaHandle = handle.object.grade({ color: hdr }, [w, h]);
  assert.equal(viaHandle.length, w * h * 4);
  handle.dispose();
});

test('post.grade-cl：three.js 构造全屏 ShaderMaterial 通道、统一参数与着色器符号完整', () => {
  const handle = createThree({ THREE, size: [1920, 1080] }, { exposure: 1.15, bloom: 0.08, vignette: 0.42, fade: 0.9 });
  assert.ok(handle.object.isMesh);
  const { material } = handle.object;
  assert.ok(material.isShaderMaterial);
  assert.equal(material.depthTest, false);
  assert.equal(material.depthWrite, false);
  assert.equal(material.uniforms.uExp.value, 1.15);
  assert.equal(material.uniforms.uBloom.value, 0.08);
  assert.equal(material.uniforms.uVignette.value, 0.42);
  assert.equal(material.uniforms.uFade.value, 0.9);
  assert.match(VERTEX_SHADER, /vUv/);
  assert.match(FRAGMENT_SHADER, /RRTAndODTFit/);
  assert.match(FRAGMENT_SHADER, /aces\(/);
  handle.setState({ exposure: 1.35, flash: 0.5, fade: 0.75 });
  assert.equal(material.uniforms.uExp.value, 1.35);
  assert.equal(material.uniforms.uFlash.value, 0.5);
  assert.equal(material.uniforms.uFade.value, 0.75);
  handle.dispose();
});
