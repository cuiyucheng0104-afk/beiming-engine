import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as THREE from 'three-webgpu';
import { scanCardLeaks, validateCard } from '../../validate-card.mjs';
import { applyAO, create } from './three.js';

const camera = { near: 0.5, far: 500, fov: 48, aspect: 1.5 };
function fixture(width = 192, height = 128) {
  const depth = new Float32Array(width * height), color = new Float32Array(width * height * 4);
  for (let i = 0; i < depth.length; i++) {
    const x = i % width, y = Math.floor(i / width);
    depth[i] = x > width / 3 && y > height / 4 ? 8 : 8.24;
    color.set([4, 0.5, 0.25, 1], 4 * i);
  }
  return { width, height, depth, color, camera };
}

test('AO card: contract, public files and host entry', () => {
  const card = JSON.parse(readFileSync(new URL('./card.json', import.meta.url)));
  assert.deepEqual(validateCard(card), { ok: true, schemaErrors: [], violations: {}, leaks: [] });
  assert.equal(card.id, 'post.ao');
  assert.equal(card.status[0].level, 'reproduced');
  assert.ok(card.ports.order.after.includes('post.hdr-chain'));
  assert.ok(card.ports.requires.some(s => s.includes('post.hdr-chain') && s.includes('false')));
  for (const name of ['three.js', 'selftest.test.mjs', 'card.json']) {
    assert.deepEqual(scanCardLeaks(readFileSync(new URL(name, import.meta.url), 'utf8')), []);
  }
});

test('flat plane, background and far-field are unoccluded; alpha and linear HDR survive', () => {
  const f = fixture(15, 11);
  for (const z of [0, 8, 460]) {
    f.depth.fill(z);
    f.color.set([512, 4, 0.25, 0.5]);
    const out = applyAO(f);
    assert.deepEqual([out.halfWidth, out.halfHeight], [7, 5]);
    assert.deepEqual([...out.color.subarray(0, 4)], [250, 4, 0.25, 0.5]);
    for (const data of [out.raw, out.blurX, out.filtered]) {
      assert.equal(data.length, 7 * 5 * 2);
      for (let i = 0; i < data.length; i += 2) {
        assert.equal(data[i], 1);
        assert.ok(Math.abs(data[i + 1] - (z === 0 ? 0 : camera.near * (camera.far / z - 1) / (camera.far - camera.near))) < 0.00004);
      }
    }
  }
});

test('occluding lip darkens its recess, not foreground; both bilateral axes matter', () => {
  const f = fixture(), a = applyAO(f), off = applyAO({ ...f, strength: 0 });
  assert.deepEqual(off.color, f.color);
  assert.notDeepEqual(a.raw, a.blurX);
  assert.notDeepEqual(a.filtered, a.blurX);
  let dim = 0;
  for (let i = 0; i < f.depth.length; i++) {
    const r = a.color[4 * i];
    assert.ok(Number.isFinite(r) && r >= 0 && r <= 4);
    if (r < 3.8) dim++;
  }
  assert.ok(dim > 50, `darkened pixels: ${dim}`);
  assert.equal(a.color[(100 * f.width + 140) * 4], 4);
  const device = f.depth.map(z => (camera.far - camera.near * camera.far / z) / (camera.far - camera.near));
  const alt = applyAO({ ...f, depth: device, depthEncoding: 'device' });
  assert.ok(a.color.every((v, i) => Math.abs(v - alt.color[i]) < 0.005));
});

test('sample count, world-radius scale, metre bias and enable switch each reach evaluation', () => {
  const f = fixture(), baseline = applyAO(f);
  for (const variant of [{ samples: 3 }, { radius: 0.2 }, { bias: 0.2 }]) {
    assert.ok(applyAO({ ...f, ...variant }).raw.some((v, i) => v !== baseline.raw[i]));
  }
  assert.deepEqual(applyAO({ ...f, enabled: false }).color, f.color);
  for (const invalid of [{ samples: 0 }, { radius: -1 }, { bias: -1 }, { enabled: 1 }]) {
    assert.throws(() => applyAO({ ...f, ...invalid }), /AO/);
    assert.throws(() => create({ THREE }, invalid), /AO/);
  }
});

test('separate half-size GPU targets; nested passes restore the host target, including on error', () => {
  const h = create({ THREE }, { strength: 0.9 });
  const previous = new THREE.WebGLRenderTarget(8, 8), target = new THREE.WebGLRenderTarget(31, 17);
  const texture = () => new THREE.DataTexture(null, 31, 17);
  const color = texture(), depth = texture(), args = { color, depth, camera, target };
  const draws = [];
  let bound = previous;
  const renderer = { getRenderTarget: () => bound, setRenderTarget(t) { bound = t; }, render() { draws.push(bound); } };
  const { raw, blurX, filtered } = h.render(renderer, args);
  assert.deepEqual(draws, [raw, blurX, filtered, target]);
  assert.equal(new Set(draws).size, 4);
  for (const t of [raw, blurX, filtered]) {
    assert.deepEqual([t.width, t.height, t.texture.type, t.texture.magFilter], [15, 8, THREE.HalfFloatType, THREE.LinearFilter]);
  }
  assert.equal(bound, previous);
  assert.ok(h.object.isMesh && h.object.material.uniforms.tInput && h.object.material.uniforms.tDepth);
  renderer.render = () => { throw new Error('draw error'); };
  assert.throws(() => h.render(renderer, args), /draw error/);
  assert.equal(bound, previous);
  h.dispose(); previous.dispose(); target.dispose(); color.dispose(); depth.dispose();
});
