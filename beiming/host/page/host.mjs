// 页面宿主（node 一侧）：three 帧源对上层的接口就在这里。起本机静态服务和无头、静音的浏览器；
// open 开一个新页面装载镜头，render 让页面出一帧、把读回的各层写成层文件、交回元数据和层引用。页面一侧在 runtime.js。
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { chromeArgs, chromeExecutable } from '../../../engine/render/lib/gpu.mjs';
import { hashCardContents, validateCard } from '../../cards/index.mjs';
import { caps } from '../../sources/three/caps.mjs';
import { planFrame, planOpen, planQuery, planRender, SourceError } from '../../sources/three/plan.mjs';
import { installProxyRegistry } from '../../sources/three/proxy-registry.js';
import { coverage2x, HALF_FLOATS } from '../../sources/three/source.js';
import { writeExr } from '../../verify/exr/exr.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// 页面只拿得到这两处：本系统的代码，和 0.187.0 的 three；另外只读放行仓库锁定的字体子集（fonts/ 下的 woff2，许可和锁文件拿不到）
const SERVED = ['beiming/', 'node_modules/three-webgpu/build/'];
const FONTS = 'fonts/';
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.woff2': 'font/woff2' };
// 带错误码的错在页面里换成普通对象再过来：错误码过不了页面和 node 之间的序列化
const PAGE = `<!doctype html><meta charset="utf-8">
<script type="importmap">{ "imports": { "three": "/node_modules/three-webgpu/build/three.module.js" } }</script>
<script type="module">
import { openSession } from '/beiming/host/page/runtime.js';
window.__open = async (cfg) => {
  try {
    window.__session = await openSession(cfg);
    return { ok: true, manifest: window.__session.manifest() };
  } catch (e) {
    if (!e.code) throw e;
    return { ok: false, code: e.code, message: e.message, load: e.load };
  }
};
</script>`;
const ENV_KEYS = ['lock', 'tier', 'workspace', 'filmDir'];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pad = (n, width) => String(n).padStart(width, '0');
const rel = (abs) => relative(REPO, abs).split(sep).join('/');
// 字节拷成对齐的数组：Buffer 可能落在共用池里，起点不一定对齐到 4 字节
const typed = (T, bytes) => new T(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
/** 交错的数组里每 k 个数取第 at 个，排成一个通道；给了 lut 就拿取到的数查表（半浮点的位型换成数） */
function plane(data, k, at, lut) {
  const out = new (lut ? Float32Array : data.constructor)(data.length / k);
  for (let i = 0; i < out.length; i++) out[i] = lut ? lut[data[i * k + at]] : data[i * k + at];
  return out;
}

/**
 * 地址里的路径换成仓库里的文件，交回它的真实路径；不在放行目录里的、想跳出去的、文件不存在的返回 null。
 * 符号链接照它指到的真实文件再判一遍：真实路径必须还在那个放行目录（也取真实路径）下面、扩展名不变，链接跳出目录的拿不到。
 * repo 是仓库根，只有测试会换。
 */
export function resolveServed(urlPath, repo = REPO) {
  let path;
  try { path = decodeURIComponent(urlPath.split('?')[0]).replace(/^\/+/, ''); } catch { return null; }
  const abs = resolve(repo, path);
  const at = relative(repo, abs).split(sep).join('/'), ext = extname(abs);
  const dir = (MIME[ext] && SERVED.find((d) => at.startsWith(d))) || (ext === '.woff2' && at.startsWith(FONTS) && FONTS);
  if (!dir) return null;
  try {
    const real = realpathSync.native(abs);
    return real.startsWith(realpathSync.native(resolve(repo, dir)) + sep) && extname(real) === ext ? real : null;
  } catch { return null; }
}

/** 起本机静态服务（只绑 127.0.0.1）。repo 是仓库根，只有测试会换 */
export async function startServer(repo = REPO) {
  const server = createServer(async (req, res) => {
    if (req.url === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
    const file = resolveServed(req.url, repo);
    const body = file && await readFile(file).catch(() => null);
    if (!body) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': MIME[extname(file)], 'cache-control': 'no-store' }).end(body);
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((ok) => server.close(ok)) };
}

/**
 * 读进提供给帧源的卡。dirs 是卡目录，相对 beiming/（例如 cards/two-d/overlay-title）。每张卡的卡文件先过校验（泄露门禁、结构、CF 各条），
 * 再照锁文件的算法算内容哈希：卡目录全部文件按路径排序，各自的 SHA-256 连同路径再算一次。返回 { 卡名: { card, sha256 } }。
 */
export async function loadCards(dirs) {
  const library = {};
  for (const dir of dirs) {
    const abs = resolve(REPO, 'beiming', dir);
    if (!rel(abs).startsWith('beiming/')) throw new SourceError('usage.bad-argument', `卡目录 ${dir} 不在 beiming/ 里`);
    const names = (await readdir(abs, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => relative(abs, join(e.parentPath, e.name)).split(sep).join('/'));
    const hashes = {};
    for (const name of names) hashes[name] = sha256(await readFile(join(abs, name)));
    const card = JSON.parse(await readFile(join(abs, 'card.json'), 'utf8')), verdict = validateCard(card);
    if (!verdict.ok) throw new Error(`卡目录 ${dir} 的卡文件没过校验：${JSON.stringify({ schemaErrors: verdict.schemaErrors, violations: verdict.violations, leaks: verdict.leaks })}`);
    if (library[card.id]) throw new Error(`卡 ${card.id} 提供了两份`);
    library[card.id] = { card, sha256: hashCardContents(hashes) };
  }
  return library;
}

/**
 * 起一个 three 帧源：一个浏览器进程。交回 { caps, open, stop }：caps 和 open 是帧源接口，stop 关掉这个进程（起、停进程不属于帧源接口）。
 * cards 是提供给这个帧源的卡目录（见 loadCards）；提供了卡，能力声明里才有「卡加数据」模式，镜头用的卡才装得了。
 * 浏览器起不来就抛错。open 得到的会话有 manifest、render、query、close；每个会话一个新页面，互不共用任何页面里的状态。
 */
export async function startSource({ cards = [] } = {}) {
  const library = await loadCards(cards);
  const CAPS = caps(library);
  const server = await startServer();
  // 浏览器起不来时要把刚起的本地服务关掉，不然进程退不出去
  const browser = await chromium.launch({ headless: true, executablePath: chromeExecutable(), args: [...chromeArgs(), '--mute-audio'] })
    .catch(async (e) => { await server.close(); throw e; });

  async function open(liveInput, liveEnv) {
    // lock 必须写出来，哪怕是 null：忘了传当场报错
    const missing = ENV_KEYS.filter((k) => liveEnv?.[k] === undefined);
    if (missing.length) throw new SourceError('usage.bad-argument', `env 缺 ${missing.join('、')}`);
    // 会话只认打开时拍下的这一份：调用方之后再改原对象，这边的预检、页面里的会话、层文件目录都不跟着变
    const input = structuredClone(liveInput), env = structuredClone(Object.fromEntries(ENV_KEYS.map((k) => [k, liveEnv[k]])));
    const locked = planOpen(CAPS, input, env, library);
    // shortcut: 入口文件经本机静态服务进页面，片子描述所在的目录必须在放行的目录里；要装别处的片子时给静态服务加一个挂载点
    const filmDir = rel(resolve(env.filmDir));
    if (!SERVED.some((dir) => `${filmDir}/`.startsWith(dir))) throw new SourceError('usage.bad-argument', 'env.filmDir 不在页面宿主放行的目录里');

    const page = await browser.newPage();
    let manifest;
    try {
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.addInitScript(installProxyRegistry);
      await page.goto(`${server.origin}/`);
      await page.waitForFunction(() => window.__open, null, { timeout: 30000 }).catch(() => { throw new Error(`页面运行时没装起来：${errors.join('；') || '超时'}`); });
      const opened = await page.evaluate((cfg) => window.__open(cfg), { input, env: { lock: env.lock, tier: env.tier }, filmBase: `${server.origin}/${filmDir}/`, cards: library });
      // 固定装载脚本半路失败时，它到那时为止记的账跟着错一起交回（load）
      if (!opened.ok) throw Object.assign(new SourceError(opened.code, opened.message), opened.load ? { load: opened.load } : {});
      manifest = opened.manifest;
    } catch (e) {
      await page.close();
      throw e;
    }

    let renders = 0, closed = false;
    return {
      manifest: () => structuredClone(manifest),

      /** 渲一帧：各层写到 env.workspace 下面的 r<这个会话第几次成功的 render>-f<帧号>/<通道名>.<类型>，交回元数据和层引用 */
      async render(f, opts, want) {
        // 进页面之前先在这边判一遍：Date、Map 这类实例过序列化会变成 {}，显式 null 也不能被吞成没写。
        // 进页面的是判过的那份纯数据快照，不是调用方的原对象：原型上的值、不可枚举的键过序列化会丢，两边要读到同一份
        const { renderOpts } = planRender(CAPS, input.shot, input.output.size, env.tier, opts, want, locked);
        const res = await page.evaluate(([frame, o, w]) => window.__session.render(frame, o, w), [f, renderOpts, want]);
        if (!res.ok) throw new SourceError(res.code, res.message);
        const dir = `r${pad(renders++, 3)}-f${pad(f, 4)}`, layers = {}, channels = {};
        const save = async (file, bytes) => { await writeFile(join(env.workspace, file), bytes); return { file, hash: `sha256:${sha256(bytes)}` }; };
        for (const [name, l] of Object.entries(res.layers)) {
          const bytes = Buffer.from(l.base64, 'base64');
          await mkdir(join(env.workspace, dir), { recursive: true });
          const { file, hash } = await save(`${dir}/${name}.${l.type}`, bytes);
          layers[name] = { file, shape: [l.size[1], l.size[0], l.components.length], components: l.components, hash };
          // EXR 里辅助层的通道照输出通道契约的名字（depth.Z、objectId.id、normal.X…），数就是层文件里的；颜色另取半浮点读回的
          if (res.extra && name !== 'color') {
            const data = typed(l.type === 'u32' ? Uint32Array : Float32Array, bytes);
            l.components.forEach((c, at) => { channels[`${name}.${c}`] = plane(data, l.components.length, at); });
          }
        }
        if (!res.extra) return { meta: res.meta, layers };

        // 场景参考通路：页面送出来的半浮点成片解成数，连同这一帧的辅助层落成一个线性的 EXR（32 位浮点通道，不压缩）
        const [w, h] = res.layers.color.size, half = typed(Uint16Array, Buffer.from(res.extra.rgba16f, 'base64'));
        ['R', 'G', 'B', 'A'].forEach((c, at) => { channels[`color.${c}`] = plane(half, 4, at, HALF_FLOATS); });
        let objectId2x;
        if (res.extra.objectId2x) {
          const bytes = Buffer.from(res.extra.objectId2x, 'base64');
          objectId2x = { ...await save(`${dir}/objectId2x.u32`, bytes), shape: [2 * h, 2 * w, 1], components: ['id'] };
          channels['objectId2x.coverage'] = coverage2x(channels['objectId.id'], typed(Uint32Array, bytes), [w, h]);
        }
        const exr = { ...await save(`${dir}/frame.exr`, writeExr({ width: w, height: h, channels })), channels: Object.keys(channels).sort() };
        return { meta: res.meta, layers, exr, ...(objectId2x && { objectId2x }) };
      },

      /**
       * 场景查询，在 (f, sub = 0) 上答（帧源接口契约 3.7）：bbox3d、anchor、belowGround，算式见 measure.js 的 answerQuery。
       * 先判帧号，再判查询：没声明的种类报 contract.unsupported-query，错上的 next 是替代办法。进页面的是判过的纯数据快照
       */
      async query(f, q) {
        planFrame(manifest.frames, f);
        const res = await page.evaluate(([frame, snap]) => window.__session.query(frame, snap), [f, planQuery(CAPS, q, manifest.entities.map((e) => e.name)).q]);
        if (!res.ok) throw new SourceError(res.code, res.message, res.next);
        return res.result;
      },

      async close() {
        if (closed) return;
        closed = true;
        await page.close();
      },
    };
  }

  return { caps: () => caps(library), open, stop: async () => { await browser.close(); await server.close(); } };
}
