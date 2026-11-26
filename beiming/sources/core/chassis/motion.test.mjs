// 内核出的 motion 层（core-render render-pack --passes，输出通道契约 5.6，快门角为 0）和解析值对拍：scenepack.mjs 的
// movingPack 写出已知运动的包（板平移、板旋转、相机移动），测试照场景规格自己求交、照两帧的矩阵自己投影，算出每个像素的
// motion（第 F + 1 帧的屏幕位置减第 F 帧的；最后一帧向后差分），和层里读出来的比。物体内部（离板边至少 MARGIN 米）的像素
// 两个分量都要在 TOL 像素以内。只有一帧的包 motion 全 0 在 passes.test.mjs 里查。
// 软件求交（THREERT_HWRT=0）与默认的求交（显卡开得起来硬件求交时就是硬件）各跑一遍。
// 要渲染程序与显卡：BEIMING_CHASSIS_E2E=1 时现编、渲不出来算失败；否则只用编好的那份，没有或渲不出来就跳过。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { OUT, PRESETS, buildRenderer, sourceKey } from './build.mjs';
import { IDENTITY, MOVING, movingPack, translate, writePack } from './scenepack.mjs';

const E2E = process.env.BEIMING_CHASSIS_E2E === '1';
const EXE = process.platform === 'win32' ? '.exe' : '';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-motion-'));
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));
const [W, H] = [320, 180];
const TOL = 1e-4;
const MARGIN = 0.02;

function renderer(t) {
  if (E2E) return buildRenderer().bin;
  const bin = path.join(OUT, 'bin', `core-render-${sourceKey([])}${EXE}`);
  if (fs.existsSync(bin)) return bin;
  t.skip('没有编好的渲染程序（设 BEIMING_CHASSIS_E2E=1 现编）');
  return null;
}

let n = 0;
/** 渲第 frame 帧、出层，读回 motion 与编号；渲不出来：E2E 时失败，否则返回 null */
function render(t, bin, pack, frame, mode) {
  const out = path.join(TMP, `r${n++}`);
  const env = { ...process.env };
  delete env.THREERT_MERGED;
  if (mode === 'sw') env.THREERT_HWRT = '0';
  else delete env.THREERT_HWRT;
  const r = spawnSync(bin, ['render-pack', pack, '--frame', String(frame), '-o', path.join(out, 'out.png'), '--spp', '1', '--width', String(W), '--height', String(H), '--no-denoise', '--passes', out, '--presets', PRESETS], { encoding: 'utf8', env, maxBuffer: 1 << 26 });
  if (r.status !== 0) {
    if (!E2E) { t.skip(`渲不出来（多半是没有显卡）：${r.stderr.trim().split('\n').at(-1)}`); return null; }
    assert.fail(r.stderr);
  }
  const read = (f, T) => { const b = fs.readFileSync(path.join(out, f)); return new T(b.buffer, b.byteOffset, b.byteLength / 4); };
  return { motion: read('motion.f32', Float32Array), id: read('objectId.u32', Uint32Array) };
}

// ------------------------------------------------------------------------------------------------ 双精度的几何

const f32s = m => m.map(Math.fround); // 包里存的是 32 位浮点：解析值用同样的数
/** 列主序 4×4 相乘 a × b */
const mul = (a, b) => Array.from({ length: 16 }, (_, i) => [0, 1, 2, 3].reduce((s, k) => s + a[k * 4 + (i % 4)] * b[Math.floor(i / 4) * 4 + k], 0));
const rotY = a => [Math.cos(a), 0, -Math.sin(a), 0, 0, 1, 0, 0, Math.sin(a), 0, Math.cos(a), 0, 0, 0, 0, 1];
const rotX = a => [1, 0, 0, 0, 0, Math.cos(a), Math.sin(a), 0, 0, -Math.sin(a), Math.cos(a), 0, 0, 0, 0, 1];
const point = (m, p) => [0, 1, 2].map(c => m[c] * p[0] + m[4 + c] * p[1] + m[8 + c] * p[2] + m[12 + c]);
const vec = (m, v) => [0, 1, 2].map(c => m[c] * v[0] + m[4 + c] * v[1] + m[8 + c] * v[2]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => a.map((x, i) => x - b[i]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = v => { const l = Math.hypot(...v); return v.map(x => x / l); };
/** 仿射矩阵的逆（左上 3×3 求逆，平移跟着变） */
function inverse(m) {
  const [a, b, c, d, e, f, g, h, i] = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  const r = [(e * i - f * h), -(b * i - c * h), (b * f - c * e), -(d * i - f * g), (a * i - c * g), -(a * f - c * d), (d * h - e * g), -(a * h - b * g), (a * e - b * d)].map(x => x / det);
  const inv = [r[0], r[3], r[6], 0, r[1], r[4], r[7], 0, r[2], r[5], r[8], 0, 0, 0, 0, 1];
  const t = point(inv, m.slice(12, 15));
  return [...inv.slice(0, 12), -t[0], -t[1], -t[2], 1];
}
/** 相机：基照内核（前 = M(0,0,-1)，上 = M(0,1,0)，右 = 前 × 上，再上 = 右 × 前） */
function cam(m) {
  const fwd = unit(vec(m, [0, 0, -1]));
  const right = unit(cross(fwd, unit(vec(m, [0, 1, 0]))));
  return { pos: m.slice(12, 15), fwd, right, up: cross(right, fwd), tan: Math.tan(Math.fround(MOVING.fovY) / 2), aspect: W / H };
}
const screen = (c, x) => {
  const d = sub(x, c.pos), z = dot(d, c.fwd);
  return [(dot(d, c.right) / (z * c.tan * c.aspect) + 1) * 0.5 * W, (1 - dot(d, c.up) / (z * c.tan)) * 0.5 * H];
};

/**
 * 像素 (i, j) 中心那条射线：打到哪个实体、命中点在网格自己坐标里的位置；离板边不到 MARGIN 的像素（两边都可能）返回 null。
 * objects：[{ id, half, z, m }]：网格在自己坐标里 z 平面上、半边长 half，m 是这一帧的实例矩阵。
 */
function hit(c, objects, i, j) {
  const ndc = [(i + 0.5) / W * 2 - 1, 1 - (j + 0.5) / H * 2];
  const d = [0, 1, 2].map(k => c.fwd[k] + c.right[k] * ndc[0] * c.tan * c.aspect + c.up[k] * ndc[1] * c.tan);
  let best = null;
  for (const o of objects) {
    const inv = inverse(o.m);
    const [ol, dl] = [point(inv, c.pos), vec(inv, d)];
    const t = (o.z - ol[2]) / dl[2];
    if (!(t > 0)) continue;
    const p = [ol[0] + t * dl[0], ol[1] + t * dl[1], o.z];
    const edge = o.half - Math.max(Math.abs(p[0]), Math.abs(p[1]));
    if (Math.abs(edge) < MARGIN) return null;
    if (edge > 0 && (!best || t < best.t)) best = { t, id: o.id, local: p, o };
  }
  return best;
}

/** 解析的 motion：第 F 帧的命中点在另一帧 G 的屏幕位置，减像素中心；forward 为假时取反（后一帧减前一帧） */
function analytic(spec, f, g, forward) {
  const mats = k => [{ id: 1, half: MOVING.board, z: 0, m: f32s(spec.board(k)) }, { id: 2, half: MOVING.wall, z: Math.fround(MOVING.wallAt), m: IDENTITY }];
  const [cf, cg] = [cam(f32s(spec.camera(f))), cam(f32s(spec.camera(g)))];
  const out = [];
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const h = hit(cf, mats(f), i, j);
      if (!h) continue;
      const other = mats(g).find(o => o.id === h.id).m;
      const s = screen(cg, point(other, h.local));
      const v = [s[0] - (i + 0.5), s[1] - (j + 0.5)];
      out.push({ p: j * W + i, id: h.id, motion: forward ? v : v.map(x => -x) });
    }
  }
  return out;
}

const CASES = {
  '板平移（含沿视线方向）': { board: k => translate(0.04 * k, -0.03 * k, -0.15 * k), camera: () => translate(0, 0, 3) },
  '板旋转': { board: k => mul(rotY(0.2 * k), rotX(0.1 * k)), camera: () => translate(0, 0, 3) },
  '相机移动并转动': { board: () => IDENTITY, camera: k => mul(translate(0.08 * k, 0.05 * k, 3 - 0.2 * k), rotY(0.03 * k)) },
};
const COUNT = 3;

/** 一种情形、一帧、一种求交：比出最大差。wrong 是负对照用的约定（方向取反） */
function compare(got, want, wrong = false) {
  let [max, same, moved] = [0, 0, 0];
  for (const w of want) {
    assert.equal(got.id[w.p], w.id, `像素 ${w.p} 的编号`);
    const m = wrong ? w.motion.map(x => -x) : w.motion;
    const d = Math.max(Math.abs(got.motion[w.p * 2] - m[0]), Math.abs(got.motion[w.p * 2 + 1] - m[1]));
    max = Math.max(max, d);
    if (d === 0) same++;
    if (Math.hypot(...m) > 0.01) moved++;
  }
  return { max, same, moved, n: want.length };
}

for (const mode of ['sw', 'default']) {
  for (const [name, spec] of Object.entries(CASES)) {
    test(`motion 和解析值对拍（${name}，${mode === 'sw' ? '软件求交' : '默认求交'}）：第 0、1 帧往后差分，最后一帧往前差分；物体内部在 ${TOL} 像素以内，方向取反的负对照不过`, (t) => {
      const bin = renderer(t);
      if (!bin) return;
      const dir = path.join(TMP, `pack${n++}`);
      writePack(dir, movingPack({ count: COUNT, ...spec }));
      for (const f of [0, 1, COUNT - 1]) {
        const forward = f + 1 < COUNT;
        const got = render(t, bin, dir, f, mode);
        if (!got) return;
        const want = analytic(spec, f, forward ? f + 1 : f - 1, forward);
        const r = compare(got, want);
        t.diagnostic(`第 ${f} 帧（${forward ? '往后' : '最后一帧，往前'}）：比了 ${r.n} 个像素，动了的 ${r.moved} 个，最大差 ${r.max.toExponential(3)} 像素，逐位相同 ${r.same} 个`);
        assert.ok(r.n > W * H * 0.5 && r.moved > 1000, `比的像素太少：${r.n}，动了的 ${r.moved}`);
        assert.ok(r.max <= TOL, `第 ${f} 帧最大差 ${r.max} 像素，超过 ${TOL}`);
        // 负对照：方向反过来（例如照搬 Cycles Vector 的后两个分量不取负）必须对不上
        assert.ok(compare(got, want, true).max > 0.01, '方向取反的负对照居然也对得上');
      }
    });
  }
}
