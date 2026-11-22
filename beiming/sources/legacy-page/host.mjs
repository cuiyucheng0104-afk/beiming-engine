// legacy-page 帧源对上层的接口：open(input, env) 交回会话 { manifest, render, query, close }（帧源接口契约 3.2）。
// 旧页面按页面约定 v1 出画面：window.render(t) 画到时刻 t，window.TEXTS(t) 报文字框。这里截 8 位 sRGB 图，
// 按 IEC 61966-2-1 精确解码成线性 f32 颜色层（显示参考），元数据只交文字框和来源信息，camera、entities 写 null（limited 档）。
// 页面怎么开由驱动管：默认用 engine/render/page.mjs 开无头浏览器（pageDriver），测试和别的宿主可以注入 options.driver：
//   driver.open({ dir, size: [w, h], fps, frameCount }) → { render(t) → RGBA 字节（w·h·4）, texts(t) → TEXTS 原样, gpu?, close() }
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { renderingOf } from '../../kernel/eval/input.mjs';
import { shutterSubs } from '../../kernel/eval/time.mjs';
import { caps, THREE_VERSION, VERSION } from './caps.mjs';

export class SourceError extends Error {
  constructor(code, message, next) {
    super(message);
    this.code = code;
    if (next) this.next = next;
  }
}

const CAPS = caps();
const bad = (message) => new SourceError('usage.bad-argument', message);
const used = (v) => (Array.isArray(v) ? v.length > 0 : v !== null && typeof v === 'object' && Object.keys(v).length > 0);
const sha = (buf) => `sha256:${createHash('sha256').update(buf).digest('hex')}`;

// sRGB 8 位到线性：IEC 61966-2-1 的分段传递函数，双精度算完再落成 f32
export const SRGB_TO_LINEAR = Float32Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

/** 和基线清单（tools/baseline/lib/png.mjs）同一种像素哈希：sha256("RGB8 <宽>x<高>\n" + RGB 字节) */
export function pixelHash(rgba, [w, h]) {
  const rgb = Buffer.alloc(w * h * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) { rgb[j] = rgba[i]; rgb[j + 1] = rgba[i + 1]; rgb[j + 2] = rgba[i + 2]; }
  return sha(Buffer.concat([Buffer.from(`RGB8 ${w}x${h}\n`), rgb]));
}

const fpsValue = (fps) => {
  const m = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(String(fps));
  if (!m) throw bad(`output.fps 必须写成「分子/分母」，给的是 ${fps}`);
  return Number(m[1]) / Number(m[2]);
};

/** 默认驱动：无头浏览器开页面约定 v1 的页面。只在真要出帧时才引入浏览器那一套 */
export const pageDriver = {
  async open({ dir, size: [w, h], fps, frameCount }) {
    const { openFilm, renderFrame } = await import('../../../engine/render/page.mjs');
    const { decodePNG } = await import('../../../tools/baseline/lib/png.mjs');
    const film = await openFilm(dir, { w, h, render: { fps, frameCount } });
    return {
      gpu: film.gpu,
      async render(t) {
        await renderFrame(film, t);
        const img = decodePNG(await film.capture('png'));
        if (img.width !== w || img.height !== h) throw new SourceError('failure.render', `截图是 ${img.width}x${img.height}，要的是 ${w}x${h}`);
        const rgba = new Uint8Array(w * h * 4);
        for (let i = 0, j = 0; j < img.rgb.length; i += 4, j += 3) { rgba[i] = img.rgb[j]; rgba[i + 1] = img.rgb[j + 1]; rgba[i + 2] = img.rgb[j + 2]; rgba[i + 3] = 255; }
        return rgba;
      },
      texts: (t) => film.page.evaluate((tt) => (typeof globalThis.TEXTS === 'function' ? globalThis.TEXTS(tt) : []), t),
      close: () => film.close(),
    };
  },
};

/** TEXTS(t) 的 { text, box: [x, y, w, h], alpha } 换成元数据的 { id?, text, bbox2d: [x0, y0, x1, y1] }；透明度是 0 的不在画面上 */
function textsOf(raw) {
  if (!Array.isArray(raw)) throw new SourceError('failure.render', `window.TEXTS(t) 必须返回数组，收到 ${typeof raw}`);
  return raw.filter((x) => typeof x?.text === 'string' && x.text !== '' && x.alpha !== 0 && Array.isArray(x.box) && x.box.length === 4)
    .map(({ id, text, box: [x, y, w, h] }) => ({ ...(typeof id === 'string' && id ? { id } : {}), text, bbox2d: [x, y, x + Math.max(0, w), y + Math.max(0, h)] }));
}

/** 显示参考的统计：亮度按 Rec.709 系数在线性值上算，百分位取下取整的名次 */
function statsOf(color) {
  const n = color.length / 4, luma = new Float64Array(n);
  let high = 0, low = 0;
  for (let i = 0; i < n; i++) {
    const r = color[i * 4], g = color[i * 4 + 1], b = color[i * 4 + 2];
    luma[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (r >= 1 || g >= 1 || b >= 1) high++;
    if (r <= 0 && g <= 0 && b <= 0) low++;
  }
  luma.sort();
  const at = (q) => Math.max(0, luma[Math.floor(q * (n - 1))]);
  return { luma: { p1: at(0.01), p50: at(0.5), p99: at(0.99) }, clipHigh: high / n, clipLow: low / n, noise: null, tris: null };
}

export async function open(input, env, { driver = pageDriver } = {}) {
  if (!input || typeof input !== 'object' || !input.shot || !input.output) throw bad('镜头输入必须有 film、output、shot');
  if (!env || typeof env !== 'object') throw bad('env 必须是对象');
  const missing = ['lock', 'tier', 'workspace', 'filmDir'].filter((k) => !(k in env));
  if (missing.length) throw bad(`env 缺 ${missing.join('、')}`);
  const { shot } = input, { source, host, mode, entry } = renderingOf(shot);
  if (source !== CAPS.id) throw bad(`出这个镜头的帧源是 ${source}，不是 ${CAPS.id}`);
  if (!['draft', 'final'].includes(env.tier)) throw bad(`档位只能是 draft、final，给的是 ${env.tier}`);
  if (!CAPS.hosts.includes(host) || !CAPS.modes.includes(mode)) throw new SourceError('contract.unsupported-mode', `${CAPS.id} 帧源不支持宿主 ${host} 加作者模式 ${mode}`, `改用宿主 ${CAPS.hosts.join('、')}、作者模式 ${CAPS.modes.join('、')}`);
  const cards = used(shot.cards), overlays = used(input.overlays), assets = used(shot.assets) || used(input.assets);
  const { lock } = env;
  if (lock === null) {
    if (!Number.isInteger(shot.seed)) throw new SourceError('env.lock-required', `没有锁文件，镜头 ${shot.id} 又没写 seed`);
    if (cards || overlays || assets) throw new SourceError('env.lock-required', `没有锁文件，镜头 ${shot.id} 却用了${cards ? '卡' : overlays ? '叠加层' : '资产'}`);
  }
  // 旧页面自己画全部画面：卡、叠加层、资产一样都装不进去，不少装照常出
  if (cards || overlays || assets) throw new SourceError('contract.unsupported-input', `${CAPS.id} 帧源装不了${cards ? '卡' : overlays ? '叠加层' : '资产'}`, '旧页面作品只出页面自己画的；要卡或叠加层改用 three 帧源');
  const colorRef = shot.colorRef ?? 'display';
  if (colorRef !== 'display') throw new SourceError('contract.unsupported-input', `旧页面只交显示参考的颜色层，镜头声明的 colorRef 是 ${colorRef}`, '镜头条目写 colorRef: display');
  if (!entry || path.basename(entry) !== 'index.html') throw new SourceError('contract.unsupported-input', `旧页面的入口必须是 index.html，给的是 ${entry}`);

  let seed = shot.seed, lockedSamples;
  if (lock !== null) {
    if (lock.film !== undefined && lock.film !== input.film) throw bad(`锁文件是片子 ${lock.film} 的，不是 ${input.film}`);
    const locked = lock.sources?.[CAPS.id]?.version, three = lock.sources?.three?.version;
    if (locked !== VERSION) throw new SourceError('contract.unsupported-input', `锁文件锁的 ${CAPS.id} 版本是 ${locked}，当前帧源是 ${VERSION}`);
    if (three !== undefined && three !== THREE_VERSION) throw new SourceError('contract.unsupported-input', `锁文件锁的 three 是 ${three}，旧页面作品用的是 ${THREE_VERSION}`);
    seed = lock.seeds?.[shot.id];
    lockedSamples = lock.shots?.[shot.id]?.shutterSamples;
    if (!Number.isInteger(seed) || !Number.isInteger(lockedSamples)) throw bad(`锁文件里没有镜头 ${shot.id} 的种子或子帧采样数`);
  }
  if (!Number.isInteger(shot.in) || !Number.isInteger(shot.out) || shot.out <= shot.in) throw bad(`镜头 ${shot.id} 的 in、out 必须是整数并且 out 大于 in`);

  const fps = fpsValue(input.output.fps);
  const preset = shot.tiers?.[env.tier] ?? {};
  const scale = preset.scale ?? CAPS[env.tier].scale;
  const size = input.output.size.map((n) => Math.max(1, Math.round(n * scale)));
  const page = await driver.open({ dir: path.dirname(path.resolve(env.filmDir, entry)), size, fps, frameCount: shot.out });
  const manifest = { frames: shot.out - shot.in, entities: [] };
  const eventsAt = (frame) => (input.events?.events ?? []).filter((e) => e.frame === frame).map((e) => ({ id: e.id, frame: e.frame }));
  let closed = false;

  return {
    manifest: () => ({ frames: manifest.frames, entities: [] }),

    async render(f, opts = {}, want) {
      if (closed) throw bad('会话已经关了');
      if (!Number.isInteger(f) || f < 0 || f >= manifest.frames) throw bad(`镜头局部帧号必须在 [0, ${manifest.frames})，给的是 ${f}`);
      if (!Array.isArray(want) || want.some((n) => typeof n !== 'string') || new Set(want).size !== want.length) throw bad('want 必须是不重复的输出名数组');
      const undeclared = want.filter((n) => !Object.hasOwn(CAPS.outputs, n) || CAPS.outputs[n] === false);
      if (undeclared.length) throw new SourceError('contract.unsupported-output', `${CAPS.id} 帧源交不出：${undeclared.join('、')}`, '旧页面只交 color 和 meta；要辅助层改用 three 帧源');

      const angleDeg = opts.shutter?.angleDeg ?? shot.shutter?.angleDeg ?? 0;
      if (!(angleDeg >= 0 && angleDeg <= 360)) throw bad(`快门角必须在 [0, 360] 度，给的是 ${angleDeg}`);
      const subN = opts.shutter?.samples ?? lockedSamples ?? shot.shutter?.samples ?? (angleDeg === 0 ? 1 : CAPS.motionBlur.samples);
      if (!Number.isInteger(subN) || subN < 1) throw bad(`子帧采样数必须是不小于 1 的整数，给的是 ${subN}`);
      if (angleDeg === 0 && subN > 1) throw new SourceError('contract.shutter-conflict', `快门角是 0，子帧采样数却是 ${subN}`);
      const pixelSamples = opts.samples ?? preset.samples ?? CAPS[env.tier].samples;
      if (!Number.isInteger(pixelSamples) || pixelSamples < 1) throw bad(`每像素采样数必须是不小于 1 的整数，给的是 ${pixelSamples}`);
      if (opts.scale !== undefined && !(opts.scale > 0 && opts.scale <= 1)) throw bad(`scale 必须在 (0, 1]，给的是 ${opts.scale}`);
      if (pixelSamples !== 1) throw new SourceError('contract.unsupported-option', `页面截图每像素只有 1 个样本，要的是 ${pixelSamples}`);
      // 页面在 open 时按档位的尺寸开好，会话里不改画幅
      if (opts.scale !== undefined && opts.scale !== scale) throw new SourceError('contract.unsupported-option', `这个会话按 scale ${scale} 开的页面，要的是 ${opts.scale}`, '换档位或缩放就重新 open');

      const frame = shot.in + f;
      const timing = { stateMs: 0, renderMs: 0, readbackMs: 0 };
      const layers = {};
      let colorHash = null, stats = null, ext;
      if (want.includes('color')) {
        const subs = shutterSubs(angleDeg, subN), n = size[0] * size[1] * 4;
        const sum = new Float64Array(n);
        let first;
        for (const sub of subs) {
          const start = performance.now();
          const rgba = await page.render((frame + sub) / fps);
          timing.renderMs += performance.now() - start;
          if (rgba.length !== n) throw new SourceError('failure.render', `页面交回 ${rgba.length} 字节，要的是 ${n}`);
          first ??= rgba;
          for (let i = 0; i < n; i++) sum[i] += (i & 3) === 3 ? rgba[i] / 255 : SRGB_TO_LINEAR[rgba[i]];
        }
        const color = Float32Array.from(sum, (v) => v / subs.length);
        const bytes = Buffer.from(color.buffer, color.byteOffset, color.byteLength);
        const file = `${shot.id}/${String(f).padStart(6, '0')}/color.f32`;
        fs.mkdirSync(path.join(env.workspace, path.dirname(file)), { recursive: true });
        fs.writeFileSync(path.join(env.workspace, file), bytes);
        colorHash = sha(bytes);
        layers.color = { file, shape: [size[1], size[0], 4], components: ['R', 'G', 'B', 'A'], hash: colorHash };
        stats = statsOf(color);
        // 只取一个子帧时截图就是成片，附上和基线清单同口径的像素哈希，供 verifyBaselineHashes 对账
        if (subs.length === 1) ext = { 'legacy-page.pixelSha256': pixelHash(first, size) };
      }
      const textStart = performance.now();
      const texts = textsOf(await page.texts(frame / fps));
      timing.stateMs += performance.now() - textStart;

      const meta = {
        format: 'meta/0.1',
        film: input.film,
        shot: shot.id,
        frame,
        shotFrame: f,
        seed,
        fps: input.output.fps,
        size,
        colorRef,
        units: { meter: 1, up: 'Y', hand: 'right' },
        camera: null,
        entities: null,
        lights: [],
        events: eventsAt(frame),
        texts,
        stats,
        source: { id: shot.source, renderer: CAPS.id, host, version: VERSION, tier: env.tier, ...(page.gpu ? { gpu: String(page.gpu) } : {}), samples: pixelSamples },
        timing,
        origin: { host: ['camera', 'entities', 'lights', 'stats', 'source', 'timing'], shot: ['texts'], kernel: ['events'] },
        hash: { color: colorHash },
        ...(ext ? { ext } : {}),
      };
      return { meta, layers };
    },

    async query(f, q) {
      if (closed) throw bad('会话已经关了');
      if (!Number.isInteger(f) || f < 0 || f >= manifest.frames) throw bad(`镜头局部帧号必须在 [0, ${manifest.frames})，给的是 ${f}`);
      throw new SourceError('contract.unsupported-query', `${CAPS.id} 帧源不答场景查询（问的是 ${q?.kind}）`, '旧页面没有场景可问；要查询改用 three、blender 或 core 帧源出这个镜头');
    },

    async close() {
      if (closed) return;
      closed = true;
      await page.close();
    },
  };
}
