// B 路线画面版式核对（逐帧投影，不启动 GPU）：模版 routes/b-native/template 与例片 examples/raea。
// 判据来自 routes/directing（VISUAL-DESIGN 安全区与读字、craft/two-five-d.md §2.1 截断边硬规矩、§5 露边与比例）：
//   · 片名 / 字幕在安全区里（左右各 ≥ 5% 画宽，上下各 ≥ 120/1080 画高），与主体的屏幕框不重叠；
//   · 绘画卡片被画幅截断的竖边（左 / 右）每一帧都在画外；上 / 下截断边若进画，film.json 必须给这条边烘了有机软边；
//     竖边确实要在画内结束的（远景云堤），film.json 必须给它烘「圆形收边」（宽 ≥ 0.15、round ≥ 0.5，QA-B-001 的修法）；
//   · 页面层天空底板每一帧都盖满画面，且按原图等比（不拉伸）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as V from '../../engine/native/view.js';
import { layout as templateLayout } from '../../routes/b-native/template/layout.js';
import { layout as exampleLayout, titleBox, ASPECT } from '../../examples/raea/layout.js';

const json = p => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const safe = (W, H) => ({ x0: 0.05 * W, x1: 0.95 * W, y0: (120 / 1080) * H, y1: H - (120 / 1080) * H });
const inside = (b, s) => b[0] >= s.x0 && b[2] <= s.x1 && b[1] >= s.y0 && b[3] <= s.y1;
const edgeOf = (film, file) => (film.native.images.find(i => i.to === file) || {}).edge || {};
const SIDES = ['left', 'right', 'top', 'bottom'];

// 每部作品在自己的画幅比例下、1× 与 2× 两种分辨率都要成立：2D 版式按 H 缩放，不写死像素
for (const [W, H] of [[1920, 1080], [3840, 2160]]) {
  test(`模版 ${W}×${H}：片名在安全区、不压主体；云海两端每一帧都在画外`, () => {
    const film = json('../../routes/b-native/template/film.json');
    const L = templateLayout({ W, H, DUR: film.dur });
    const frames = Math.round(film.dur * film.fps), S = safe(W, H);
    for (const n of [2, 4, 6]) {
      const T = L.title(n);
      assert.ok(inside(T.box, S), `${n} 个字的片名框 ${T.box.map(Math.round)} 出了安全区`);
      for (let f = 0; f < frames; f++) {
        const cam = V.shotAt(f / film.fps, L.shots);
        const sub = V.screenBox(L.subject.map(p => V.project(p, cam, [W, H])));
        assert.equal(V.overlap(sub, T.box), 0, `第 ${f} 帧 ${n} 个字的片名压到主体`);
      }
    }
    for (const m of L.mists) for (let f = 0; f < frames; f++) {
      const t = f / film.fps, cam = V.shotAt(t, L.shots);
      const e = V.cardOnScreen({ ...m, position: m.position.map((x, i) => x + t * (m.drift[i] || 0)) }, cam, [W, H]);
      for (const side of ['left', 'right']) assert.equal(V.edgeVisible(e[side], [W, H]), false, `第 ${f} 帧 ${m.name} 的${side}端进画`);
    }
    const sky = L.backdrop;
    assert.ok(Math.abs(sky.width / sky.height - 3548 / 1774) < 0.01, '天空底板要等比');
    for (const t of [0, film.dur]) assert.ok(sky.x + t * sky.drift[0] <= 0 && sky.x + t * sky.drift[0] + sky.width >= W && sky.y <= 0 && sky.y + sky.height >= H, `${t} 秒时天空没盖满`);
  });

}

for (const [W, H] of [[1920, 1040], [3840, 2080]]) {
  test(`例片 ${W}×${H}：截断竖边在画外、上下截断边有软边、天空盖满且等比、片名在安全区且不压鲲`, () => {
    const film = json('../../examples/raea/film.json');
    const FPS = film.fps, frames = Math.round(film.dur * FPS);
    const L = exampleLayout({ W, H, FPS, frames, cuts: film.shots.map(s => s.out) }, V), S = safe(W, H);
    for (let f = 0; f < frames; f++) {
      const t = f / FPS, cam = V.shotAt(t, L.shots);
      for (const c of L.cards.filter(c => c.shots.includes(cam.index))) {
        const pos = c.position.map((x, i) => x + t * ((c.drift || [])[i] || 0));
        const e = V.cardOnScreen({ ...c, position: pos }, cam, [W, H]);
        const soft = edgeOf(film, c.src);
        for (const side of c.cut) {
          if (!V.edgeVisible(e[side], [W, H])) continue;
          const rounded = soft[side] >= 0.15 && (soft.round ?? 0) >= 0.5;
          assert.ok(rounded || side === 'top' || side === 'bottom', `第 ${f} 帧 ${c.name} 的截断${side}边进画（竖边要在画外，或在 film.json 烘圆形收边）`);
          assert.ok(soft[side] > 0, `第 ${f} 帧 ${c.name} 的截断${side}边进画，但 film.json 没给 ${c.src} 的 ${side} 烘软边`);
        }
        for (const side of SIDES) if (soft[side] > 0) assert.ok(c.cut.includes(side), `${c.src} 的 ${side} 不是截断边却烘了软边（会吃掉画好的云边）`);
      }
      const sky = L.sky(cam.index), [dx, dy] = V.skyShift(t, L.shots, [W, H]);
      assert.ok(sky.x + dx <= 0 && sky.x + dx + sky.width >= W && sky.y + dy <= 0 && sky.y + dy + sky.height >= H, `第 ${f} 帧天空没盖满`);
    }
    const sky = L.sky(0);
    assert.ok(Math.abs(sky.width / sky.height - ASPECT.sky_dawn) < 0.01, '天空底板要等比');
    const sk = L.cards.find(c => c.name === 'skyline');
    assert.ok(sk.height === undefined && Math.abs(sk.aspect - ASPECT.skyline_pudong) < 1e-9, '天际线按原图比例（不压扁）');
    const T = titleBox({ W, H }, L.title);
    assert.ok(inside(T.box, S), `片名框 ${T.box.map(Math.round)} 出了安全区`);
    const start = Math.floor(film.events.find(e => e.id === 'title').frame);
    for (let f = start; f < frames; f++) {
      const cam = V.shotAt(f / FPS, L.shots), k = L.kun(f);
      // 鲲的包围盒（回读报告：长 ≈ 29.6、高 ≈ 9.2、宽 ≈ 16.9 米），取 8 个角的投影框——比真实轮廓保守
      const pts = [];
      for (const x of [-14.8, 14.8]) for (const y of [-4.6, 4.6]) for (const z of [-8.5, 8.5]) pts.push(V.project([k.position[0] + x, k.position[1] + y, k.position[2] + z], cam, [W, H]));
      assert.equal(V.overlap(V.screenBox(pts), T.box), 0, `第 ${f} 帧片名压到鲲的包围框`);
    }
  });
}

test('例片：镜头表只在 film.json 一处，版式的切点读它，与默认机位表一致', () => {
  const film = json('../../examples/raea/film.json'), frames = Math.round(film.dur * film.fps);
  assert.deepEqual(film.shots.map(s => [s.in, s.out]), [[0, 84], [84, 144], [144, frames]]);
  for (let i = 1; i < film.shots.length; i++) assert.equal(film.shots[i].in, film.shots[i - 1].out, '镜头首尾相接');
  const L = exampleLayout({ W: 1920, H: 1040, FPS: film.fps, frames, cuts: film.shots.map(s => s.out) }, V);
  assert.deepEqual(L.shots.map(s => s.until * film.fps), film.shots.map(s => s.out));
  assert.throws(() => exampleLayout({ W: 1920, H: 1040, FPS: 24, frames, cuts: [84, 80, 240] }, V), /递增/);
  for (const e of film.events) assert.ok(film.shots.some(s => s.id === e.shot && e.frame >= s.in && e.frame < s.out), `事件 ${e.id} 落在它写的镜头 ${e.shot} 里`);
});

test('例片：事件帧号在片长内；缓起的声音标 sync: soft；声音脚本与片名页面读同一份 film.json', () => {
  const film = json('../../examples/raea/film.json'), frames = Math.round(film.dur * film.fps);
  for (const e of film.events) assert.ok(Number.isInteger(e.frame) && e.frame >= 0 && e.frame < frames, e.id);
  assert.deepEqual(film.events.filter(e => e.sync === 'soft').map(e => e.id), ['horn', 'kun-call', 'chord'], '船笛、鲲鸣、和弦是缓起的声音，QA 的声画同步只给软项');
  const sound = readFileSync(new URL('../../examples/raea/tools/sound.py', import.meta.url), 'utf8');
  for (const id of ['horn', 'kun-call', 'blink', 'chord', 'title']) assert.ok(sound.includes(`EV['${id}']`), `sound.py 没用事件 ${id}`);
  // 眨眼铃对上眼睑完全闭合：Swim 片段 6.625 秒，一拍三，片段时间 = (q + 2) mod 10
  const L = exampleLayout({ W: 1920, H: 1040, FPS: film.fps, frames }, V);
  assert.equal(L.kun(film.events.find(e => e.id === 'blink').frame).clip, 6.625);
});

test('例片：鲲整个按一拍三走（位置、姿态、片段时间同一个时钟，审查 R07）', () => {
  const film = json('../../examples/raea/film.json');
  const L = exampleLayout({ W: 1920, H: 1040, FPS: film.fps, frames: 240 }, V);
  for (let f = 0; f < 240; f += 3) {
    const a = L.kun(f);
    for (const g of [f + 1, f + 2]) assert.deepEqual(L.kun(g), a, `第 ${g} 帧应与第 ${f} 帧相同`);
  }
});
