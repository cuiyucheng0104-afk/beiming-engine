// Local only; one browser, a handful of static frames. No remote renderer.
// node tools/test_peng/run.mjs [--render] [--view world] [--time 471] [--poses]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { createPeng, createFeatherSwarm } from '../../src/peng.js';
import { featherGeometry } from '../../src/peng-feathers.js';
import { TOON_SHARED, TOON_PRESETS } from '../../src/toon.js';
import { openFilm, closeServer } from '../../engine/render/page.mjs';

const out = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2), take = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const counts = p => { let triangles = 0, meshes = 0; p.group.traverse(m => { if (m.isMesh) { triangles += m.geometry.index.count / 3 * (m.isInstancedMesh ? m.count : 1); meshes++; } }); return { triangles, meshes }; };
function poseSignature(model) {
  model.group.updateMatrixWorld(true); const s = [];
  model.group.traverse(m => { s.push(...m.matrixWorld.elements); if (m.isInstancedMesh) s.push(...m.instanceMatrix.array, ...(m.instanceColor?.array ?? [])); }); return s;
}
const p = createPeng(), report = { lod1: counts(p), nominalWingspan: p.wingspan, length: p.length, checks: [] };
assert.equal(p.wingspan, 600); assert.ok(report.lod1.triangles < 500000);
const low = createPeng({ lod: 0.25 }); report.lod025 = counts(low);
assert.ok(report.lod025.triangles < report.lod1.triangles * 0.65);
for (const bird of [p, low]) {
  bird.setPose(0, { spread: 1, flap: 0, flight: 0 });
  const b = new THREE.Box3().setFromObject(bird.group); assert.ok(Math.abs(b.max.z - b.min.z - 600) < 0.01);
  bird.group.position.set(30, 50, -90); bird.group.rotation.set(0.28, Math.PI - 0.4, -0.08);
  bird.setPose(12.25, { spread: 0.87 }); const first = poseSignature(bird);
  bird.setPose(30); bird.setPose(0); bird.setPose(12.25, { spread: 0.87 });
  assert.deepEqual(poseSignature(bird), first);
  assert.deepEqual(bird.group.position.toArray(), [30, 50, -90]);
  bird.setPose(1); const a = poseSignature(bird); bird.setPose(1.001); assert.deepEqual(a, poseSignature(bird));
  for (const mesh of bird.outlineMeshes) {
    assert.ok(mesh.castShadow && mesh.receiveShadow && mesh.userData.outline);
    assert.equal(mesh.material.userData.toon.uInkTime, TOON_SHARED.uInkTime);
    assert.equal(mesh.material.userData.toon.uStep1.value, TOON_PRESETS.kun.step1);
    assert.equal(mesh.material.userData.toon.uStep2.value, TOON_PRESETS.kun.step2);
  }
}
report.checks.push('600-unit neutral wingspan at two LODs', 'stateless seek / caller transform preserved', '24 fps pose sampling', 'original TOON_SHARED / three-band thresholds');
const g = featherGeometry(), edges = new Map();
for (let i = 0; i < g.index.count; i += 3) for (let j = 0; j < 3; j++) {
  const a = g.index.array[i + j], b = g.index.array[i + (j + 1) % 3], key = [Math.min(a, b), Math.max(a, b)].join(':'); edges.set(key, (edges.get(key) ?? 0) + 1);
}
assert.ok([...edges.values()].every(n => n === 2)); report.checks.push('closed feather: every mesh edge has exactly two incident faces');
for (const spread of [0, 0.5, 1]) for (const flap of [0, 1]) for (const flight of [0, 1]) {
  p.setPose(3.25, { spread, flap, flight }); assert.ok(poseSignature(p).every(Number.isFinite));
}
report.checks.push('spread / flap / flight endpoint combinations');
// Finite transforms, light frustum containment and frame-to-frame coherence
// throughout the 35-second segment. CPU only, not a 840-frame render.
const light = new THREE.DirectionalLight(); light.position.set(200, 500, 250);
const scene = new THREE.Scene(); scene.add(p.group, light, light.target);
let maxStep = 0, prev = null;
const corner = new THREE.Vector3();
for (let f = 0; f <= 840; f++) {
  const t = f / 24; p.setPose(t, { spread: 0.2 + 0.8 * Math.min(1, t / 7), flap: 1, flight: 1 });
  p.group.updateMatrixWorld(true);
  const point = p.group.getObjectByName('peng-primary-pivot-1-10').getWorldPosition(new THREE.Vector3());
  if (prev) maxStep = Math.max(maxStep, point.distanceTo(prev)); prev = point;
  assert.ok(poseSignature(p).every(Number.isFinite));
  if (f % 120 === 0) {
    p.fitShadow(light, { size: 1024 }); light.shadow.updateMatrices(light);
    const b = new THREE.Box3().setFromObject(p.group), c = light.shadow.camera;
    for (let k = 0; k < 8; k++) {
      corner.set(k & 1 ? b.min.x : b.max.x, k & 2 ? b.min.y : b.max.y, k & 4 ? b.min.z : b.max.z).project(c);
      assert.ok(Math.max(Math.abs(corner.x), Math.abs(corner.y), Math.abs(corner.z)) <= 1.001);
    }
  }
}
report.maxWristStepPerFrame = maxStep;
assert.ok(maxStep < 12); report.checks.push('841 finite poses / bounded adjacent-frame motion', 'shadow frustum contains transformed model');
const s1 = createFeatherSwarm({ seed: 17 }), s2 = createFeatherSwarm({ seed: 17 }), s3 = createFeatherSwarm({ seed: 18 });
for (const s of [s1, s2, s3]) s.setPose(7, { amount: 0.8, burst: 0.6 });
assert.deepEqual(poseSignature(s1), poseSignature(s2)); assert.notDeepEqual(poseSignature(s1), poseSignature(s3));
const sig = poseSignature(s1); s1.setPose(19); s1.setPose(0); s1.setPose(7, { amount: 0.8, burst: 0.6 }); assert.deepEqual(poseSignature(s1), sig);
s1.setPose(7, { amount: 0 }); assert.equal(s1.group.visible, false);
assert.equal(createFeatherSwarm({ count: 0 }).group.visible, false);
report.checks.push('seeded swarm / deterministic reverse seek / zero count & amount');

if (args.includes('--render')) {
  let browser;
  try {
    const session = await openFilm(path.resolve(out, '../..'), { w: 1440, h: 900, query: 'test=peng-film&view=world&t=471' });
    browser = session.browser; const page = session.page;
    report.gpu = session.gpu; report.renders = []; const errors = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    const only = take('--view', null), time = Number(take('--time', 471));
    for (const view of only ? [only] : ['world', 'hero', 'wide', 'head', 'feather', 'underside', 'swarm']) {
      await page.evaluate(({ time, view }) => window.pengLab.render(time, view), { time, view });
      const file = path.join(out, `peng-${view}.png`); await page.screenshot({ path: file });
      report.renders.push(file); console.log(file);
    }
    if (args.includes('--poses')) for (const [name, t, spread] of [['furled', 1.25, 0], ['upstroke', 1.375, 1], ['downstroke', 4.125, 1]]) {
      await page.evaluate(({ t, spread }) => {
        const { peng, scene, camera, look } = window.pengLab;
        window.pengLab.render(455 + t, 'wide');
        peng.setPose(t, { spread, flap: 1, flight: 1 });
        peng.fitShadow(scene.children.find(x => x.isDirectionalLight), { size: 2048 });
        camera.position.set(520, 290, 230); camera.lookAt(-28, 0, 0); camera.updateMatrixWorld();
        look.render(scene, camera, { t, outline: { width: 1.8, near: 0, far: 1600, wobble: 0.35 }, kuwahara: false, bloom: false, grade: false, paper: false, vignette: 0.08 });
      }, { t, spread });
      const file = path.join(out, `peng-${name}.png`); await page.screenshot({ path: file }); report.renders.push(file); console.log(file);
    }
    const programs = await page.evaluate(() => window.pengLab.renderer.info.programs.map(p => ({ name: p.name, runnable: p.diagnostics?.runnable !== false })));
    assert.ok(programs.every(p => p.runnable)); assert.deepEqual(errors, []);
    report.checks.push('actual WebGL + shadow + screen-space outlines; shader programs runnable');
    report.programs = programs.length;
  } finally { await browser?.close(); await closeServer(); }
}
report.availableImages = fs.readdirSync(out).filter(f => /^peng-.*\.png$/.test(f)).map(f => path.join(out, f));
fs.writeFileSync(path.join(out, 'peng-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
