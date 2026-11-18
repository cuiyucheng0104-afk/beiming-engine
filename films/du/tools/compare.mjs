// 渡 · A 路线（GLSL，无头 Chrome 的 WebGL）对离屏出片（TSL，Node + Dawn）逐帧对拍：同一个 scene.mjs、同一组后期参数、同一张天空底板与纸纹。
// 两边都 msaa 0、ss 2（两边多重采样的采样位置与解析不保证相同，逐字节对拍不带它）；不走 film 出片链（那边的帧图是 JPG，有损）。
//   node films/du/tools/compare.mjs [--frames 12,40,66,90] [--size 1920x1080] [--out <目录>]   给了 --out 就把两边的帧写成 PNG
// 每帧过 M1 质量门（engine/offscreen/diff.mjs：PSNR ≥ 50 dB、差 5 级以上的像素 ≤ 0.1%）。退出码：0 全部通过 · 4 有帧不过 · 3 缺 GPU 或浏览器。
import { mkdirSync, writeFileSync } from 'node:fs';
import { URL, fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadGpu } from '../../../engine/offscreen/load.mjs';
import { createHost } from '../../../engine/offscreen/host.mjs';
import { diffRgba, meetsGate } from '../../../engine/offscreen/diff.mjs';
import { encodePng } from '../../../tools/plates/png.mjs';
import { startReference, PAGE_B64 } from '../../../tests/offscreen/glsl-reference.mjs';

const { values: a } = parseArgs({ options: { frames: { type: 'string', default: '12,40,66,90' }, size: { type: 'string', default: '1920x1080' }, out: { type: 'string' } } });
const frames = a.frames.split(',').map(Number), [W, H] = a.size.split('x').map(Number);
const WORK = fileURLToPath(new URL('../offscreen.mjs', import.meta.url));

const REF_PAGE = `
import * as THREE from 'three';
import { createLook } from '/engine/look/index.js';
import { loadStyle, parseLookPreset, resolveLook } from '/engine/style/index.js';
import { buildScene } from '/films/du/scene.mjs';
${PAGE_B64}
const { W, H, f } = window.__ARGS;
const FILM = await (await fetch('/films/du/film.json')).json(), shot = FILM.shots[0];
const style = await loadStyle(FILM.style);
const r = resolveLook(style, parseLookPreset(shot.lookPreset).preset, shot.lookOverrides || {}, { strict: true });
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(1); renderer.setSize(W, H);
const look = createLook(renderer, W, H, { ss: 2, msaa: 0, refHeight: r.refHeight, fps: 24, defaults: r.defaults, paperUrl: '/' + style.lookDefaults.paper.asset });
await look.ready;
const sky = await new THREE.TextureLoader().loadAsync('/assets/plates/sky_dawn.png');   // 与 shots/s1.js 同一种读法
sky.colorSpace = THREE.SRGBColorSpace; sky.generateMipmaps = false; sky.minFilter = sky.magFilter = THREE.LinearFilter;
const { scene, camera, update } = buildScene({ THREE, W, H, sky });
const target = new THREE.WebGLRenderTarget(W, H, { type: THREE.UnsignedByteType, depthBuffer: false });
update(f);
look.render(scene, camera, { t: f / 24, ...r.params, target });
const raw = new Uint8Array(W * H * 4), out = new Uint8Array(W * H * 4);
renderer.readRenderTargetPixels(target, 0, 0, W, H, raw);
for (let y = 0; y < H; y++) out.set(raw.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);   // 自下而上 → 自上而下
window.RESULT = { b64: b64(out) };
`;
const opaque = px => { const o = Uint8Array.from(px); for (let i = 3; i < o.length; i += 4) o[i] = 255; return o; };

let ref, host;
try {
  const gpu = await loadGpu();
  globalThis.__DU_MSAA = 0;
  host = await createHost({ gpu, width: W, height: H, fps: 24 });
  ref = await startReference();
} catch (e) {
  if (String(e.code).startsWith('env.')) { console.error(`对拍不可用：${e.message}`); process.exit(3); }
  throw e;
}
let bad = 0;
try {
  const work = await host.load(WORK);
  if (a.out) mkdirSync(a.out, { recursive: true });
  for (const f of frames) {
    const g = opaque(await ref.render(REF_PAGE, { W, H, f }, { timeout: 120000 }));
    const t = opaque(await host.renderFrame(work, f));
    const d = diffRgba(t, g, { width: W, height: H }), gate = meetsGate(d);
    if (!gate.ok) bad++;
    console.log(`帧 ${String(f).padStart(3)}  PSNR ${d.psnr.toFixed(2)} dB  最大差 ${d.maxDelta}  大差像素 ${d.bigPixels}  ${gate.ok ? '通过' : `不过：${gate.reasons?.join('；') ?? ''}`}`);
    if (a.out) for (const [k, px] of [['glsl', g], ['tsl', t]]) writeFileSync(`${a.out}/${k}-${f}.png`, encodePng({ width: W, height: H, data: px }));
  }
} finally { host.dispose(); await ref.close(); }
process.exit(bad ? 4 : 0);
