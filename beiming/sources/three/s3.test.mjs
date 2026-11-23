// S3：二维讲解舞台（two-d.js）。Canvas 2D、SVG、DOM 三种元素各自光栅化、贴到相机空间里按像素对齐的平面上，
// 宿主照常从网格顶点量 entities[].bbox2d，文字框经 meta(f).texts 交。纯函数部分不起浏览器；实渲部分起无头浏览器（起不了时跳过）：
// 探针镜头 s3-probe.shot.js 照 params 搭任意元素，样板镜头 s3-18-1.shot.js 是考题 18-1 的三场讲解。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { runInNewContext } from 'node:vm';
import { chromium } from 'playwright-core';
import { chromeArgs, chromeExecutable } from '../../../engine/render/lib/gpu.mjs';
import { resolveServed, startServer, startSource } from '../../host/page/host.mjs';
import { measureEntity } from '../../host/page/measure.js';
import { metaCheck, sourceCheck } from '../../kernel/conformance/records.mjs';
import { loadContracts } from '../../kernel/contracts/validate.mjs';
import { shotInput } from '../../kernel/eval/input.mjs';
import { verifySampledBboxes } from '../../verify/l2.mjs';
import { caps } from './caps.mjs';
import { FADE, FPS, FRAMES, INK, LEAD, PAPER, RECTS, SCENES, SIZE, TAIL } from './s3-18-1.shot.js';
import { installProxyRegistry } from './proxy-registry.js';
import { declarationReadings } from './s3-probe.shot.js';
import { checkElements, createTwoDStage, rectToPlane, STAGE } from './two-d.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const coded = (code) => (err) => { assert.equal(err.code, code, err.message); return true; };
const typed = (T, bytes) => new T(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const worst = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
// 非 MSAA 编号层按像素中心采样，整数外沿距中心 0.5 px。4 位亚像素网格上，边界量化到中心时，
// top-left 填充规则决定该像素的归属。给量化留一格（1/16 px），给浮点投影留 1e-3 px。
const OBJECT_ID_EDGE_TOLERANCE = 0.5 + 1 / 16 + 1e-3;
/** 报错时怎么写出一个值：带空槽、访问器的数组也写得出（JSON 会把空槽写成 null，访问器会被它调一遍） */
const show = (v) => inspect(v, { depth: 3, getters: false, breakLength: Infinity });

/** 起帧源跑 fn({ open, read })。open(片子, 镜头, 档位) 开会话；read(层引用) 读层文件。起不了浏览器时跳过 */
async function withSource(t, fn) {
  let source;
  try { source = await startSource(); } catch (e) { t.skip(`起不了浏览器：${String(e.message).split('\n')[0]}`); return; }
  const workspace = await mkdtemp(join(tmpdir(), 'beiming-s3-'));
  try {
    await fn({
      open: (film, id, tier = 'final') => source.open(shotInput(film, id), { lock: null, tier, workspace, filmDir: HERE }),
      read: (ref) => readFile(join(workspace, ref.file)),
    });
  } finally {
    await source.stop();
    await rm(workspace, { recursive: true, force: true });
  }
}

/** 颜色层（线性光 RGBA 浮点）换成 8 位 sRGB 的 RGB，每像素三个数 */
function toSrgb8(linear) {
  const out = new Uint8Array((linear.length / 4) * 3);
  for (let i = 0, k = 0; i < linear.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = Math.min(1, Math.max(0, linear[i + c]));
      out[k++] = Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));
    }
  }
  return out;
}
const pixel = (rgb, w, x, y) => [...rgb.subarray((y * w + x) * 3, (y * w + x) * 3 + 3)];
/** 墨迹掩膜：三个通道都暗的像素。两个镜头里只有文字用墨色，图形都用亮色 */
const inkMask = (rgb, [w, h]) => ({ width: w, height: h, data: Uint8Array.from({ length: w * h }, (_, i) => +(Math.max(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]) < 110)) });
/** 底色占比：每个通道分 16 档，和纸色落在同一格的像素占几成 */
function paperShare(rgb) {
  const want = rgbOf(PAPER).map((v) => v >> 4);
  let n = 0;
  for (let i = 0; i < rgb.length; i += 3) if (rgb[i] >> 4 === want[0] && rgb[i + 1] >> 4 === want[1] && rgb[i + 2] >> 4 === want[2]) n++;
  return n / (rgb.length / 3);
}
/** 离纸色多远：每像素三个通道差的绝对值之和，取平均 */
function offPaper(rgb) {
  const p = rgbOf(PAPER);
  let sum = 0;
  for (let i = 0; i < rgb.length; i++) sum += Math.abs(rgb[i] - p[i % 3]);
  return sum / (rgb.length / 3);
}

const contracts = await loadContracts();
/** 过契约：结构定义，加这份契约的每一条判定函数（每帧元数据和它的核对记录是 M1–M20，帧源核对记录是 F 各条） */
function assertContract(obj, what) {
  const verdict = contracts.validate(obj);
  assert.deepEqual([verdict.schemaErrors, verdict.violations], [[], {}], `${what} 没过 ${verdict.contract} 契约`);
}
const assertMeta = assertContract;
/** 没有文字识别引擎：内容对字幕稿（调用方另比），位置取墨迹。这里把每个文字框配上它附近墨迹的外接矩形当识别结果交给 L2 */
function ocrFromInk(meta, mask) {
  return meta.texts.map((t) => {
    const [x0, y0, x1, y1] = t.bbox2d.map(Math.round);
    let box = null;
    for (let y = Math.max(0, y0 - 8); y < Math.min(mask.height, y1 + 8); y++) for (let x = Math.max(0, x0 - 8); x < Math.min(mask.width, x1 + 8); x++) {
      if (mask.data[y * mask.width + x]) box = box ? [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x + 1), Math.max(box[3], y + 1)] : [x, y, x + 1, y + 1];
    }
    return { text: t.text, bbox2d: box ?? [0, 0, 0, 0] };
  });
}

// ---------- 纯函数 ----------

test('像素矩形反算成相机空间的平面：宿主的 measureEntity 量回来四边差不超过万分之一像素，整数和小数矩形都一样', () => {
  const size = [1920, 1080], { fovYDeg, nearM, farM } = STAGE;
  const f = 1 / Math.tan((fovYDeg * Math.PI) / 360);
  const proj = [f / (size[0] / size[1]), 0, 0, 0, 0, f, 0, 0, 0, 0, -(farM + nearM) / (farM - nearM), -1, 0, 0, (-2 * farM * nearM) / (farM - nearM), 0];
  const view = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const [order, rect] of [[0, [0, 0, 1920, 1080]], [1, [210, 290, 1710, 650]], [7, [100.25, 50.5, 300.75, 200.125]], [300, [1919, 1079, 1920, 1080]]]) {
    const plane = rectToPlane(rect, size, order);
    assert.equal(plane.corners.length, 4);
    const m = measureEntity(view, proj, size, plane.corners);
    assert.ok(worst(m.bbox2d, rect) <= 1e-4, `${rect} 量回来是 ${m.bbox2d}`);
    // 后登记的更靠近相机：同一块屏幕上后来的盖住先来的
    assert.ok(Math.abs(m.depth[0] - (STAGE.distanceM - order * STAGE.stepM)) < 1e-9 && m.depth[0] === m.depth[1]);
  }
});

test('元素声明不对当场报 usage.bad-argument：种类不认识、矩形不是有限的数、宽高不是正的、伸出画面、名字重复或写法不对、缺画法', () => {
  const size = [640, 360], draw = () => {};
  const ok = [{ kind: 'canvas2d', name: 'plot', rect: [0, 0, 640, 360], draw }, { kind: 'svg', name: 'mark.a', rect: [1.5, 2, 3.5, 4], svg: '<svg viewBox="0 0 1 1"></svg>' }, { kind: 'dom', html: '<p data-entity="p">x</p>' }];
  assert.equal(checkElements(size, ok).length, 3);
  const bad = [
    'none', [], [{ kind: 'webgl', name: 'a', rect: [0, 0, 1, 1] }],
    [{ kind: 'canvas2d', name: 'a', rect: [0, 0, NaN, 1], draw }], [{ kind: 'canvas2d', name: 'a', rect: [0, 0, 1], draw }], [{ kind: 'canvas2d', name: 'a', rect: [0, 0, '9', 1], draw }],
    [{ kind: 'canvas2d', name: 'a', rect: [5, 0, 5, 1], draw }], [{ kind: 'canvas2d', name: 'a', rect: [0, 9, 4, 1], draw }],
    [{ kind: 'canvas2d', name: 'a', rect: [-1, 0, 4, 1], draw }], [{ kind: 'svg', name: 'a', rect: [0, 0, 641, 1], svg: '<svg></svg>' }], [{ kind: 'svg', name: 'a', rect: [0, 0, 4, 360.5], svg: '<svg></svg>' }],
    [ok[0], { ...ok[0] }], [{ ...ok[0], name: 'has-dash' }], [{ ...ok[0], name: '' }], [{ ...ok[0], name: 'a#b' }],
    [{ kind: 'canvas2d', name: 'a', rect: [0, 0, 1, 1] }], [{ kind: 'svg', name: 'a', rect: [0, 0, 1, 1], svg: '<div></div>' }], [{ kind: 'dom', html: '  ' }],
    [{ ...ok[0], opacity: 0.5 }], [null],
  ];
  // 数组空槽、访问器（过不了 JSON，单列）：按下标逐槽查，不靠会跳过空槽的遍历
  const hole = [ok[0]];
  hole.length = 2;
  bad.push(Array(1), hole, Object.defineProperty([], 0, { get: () => ok[0], enumerable: true }));
  for (const elements of bad) assert.throws(() => checkElements(size, elements), coded('usage.bad-argument'), show(elements));
  // 搭舞台的调用自己也当场抛，不是交回一个失败的 Promise：调用处不带 await 的 try/catch 接得住。样式里的外部地址、写法不对的字体声明一样
  const font = { family: 'Probe', url: '/fonts/a.woff2' };
  const badFonts = [5, [null], Array(1), [{ ...font, family: 'A"B' }], [{ ...font, weight: '400;x' }], [{ family: 'Probe' }]].map((fonts) => ({ elements: ok, fonts }));
  for (const opts of [...bad.map((elements) => ({ elements })), { elements: ok, css: 'p{background:url(https://example.invalid/a.png)}' }, ...badFonts]) {
    assert.throws(() => createTwoDStage({ size }, opts), coded('usage.bad-argument'), show(opts));
  }
  // ctx、opts 不对也一样当场抛
  for (const [ctx, opts] of [[undefined, { elements: ok }], [{}, { elements: ok }], [{ size: [640, NaN] }, { elements: ok }], [{ size }, null]]) {
    assert.throws(() => createTwoDStage(ctx, opts), coded('usage.bad-argument'), show([ctx, opts]));
  }
});

test('声明只收直接写出来的：Proxy、访问器、数组空槽、数组上下标以外的属性，在 ctx、ctx.size、opts、elements、元素、rect、fonts 哪一层都当场报 usage.bad-argument，访问器一次都不执行', () => {
  const size = [640, 360], draw = () => {}, canvas = { kind: 'canvas2d', name: 'plot', rect: [1, 1, 20, 20], draw }, font = { family: 'Probe', url: '/fonts/a.woff2' };
  let read = 0;
  /** target 上加一个读一次记一次的访问器 */
  const getter = (target, key, value) => Object.defineProperty(target, key, { get: () => { read++; return value; }, enumerable: true });
  /** 带空槽的数组：只有 entries 里的下标有值 */
  const sparse = (length, entries) => Object.assign(Array(length), entries);
  const revoked = Proxy.revocable([canvas], {});
  revoked.revoke();
  const { rect, ...noRect } = canvas, { kind, ...noKind } = canvas;
  const badElements = {
    proxy: new Proxy([canvas], {}),
    // 调用方读到 second，舞台照描述符拿到的是 plot
    swap: new Proxy([canvas], { get: (t, k, r) => (k === '0' ? { ...canvas, name: 'second' } : Reflect.get(t, k, r)) }),
    trap: new Proxy([canvas], { getOwnPropertyDescriptor() { throw new Error('陷阱里抛的'); } }),
    revoked: revoked.proxy,
    extra: Object.assign([canvas], { more: {} }),
    // 空槽加一个多出来的属性：自有属性的个数对得上，下标对不上
    holeExtra: Object.assign(sparse(2, { 1: canvas }), { more: 1 }),
    item: [new Proxy(canvas, {})],
    itemGetter: [getter({ ...noRect }, 'rect', rect)],
    kindGetter: [getter({ ...noKind }, 'kind', kind)],
    rectHole: [{ ...canvas, rect: sparse(4, { 1: 1, 2: 20, 3: 20 }) }],
    rectProxy: [{ ...canvas, rect: new Proxy([1, 1, 20, 20], {}) }],
    rectGetter: [{ ...canvas, rect: getter([1, 1, 20], 3, 20) }],
    rectExtra: [{ ...canvas, rect: Object.assign([1, 1, 20, 20], { more: 1 }) }],
  };
  for (const [k, elements] of Object.entries(badElements)) {
    assert.throws(() => checkElements(size, elements), coded('usage.bad-argument'), k);
    assert.throws(() => createTwoDStage({ size }, { elements }), coded('usage.bad-argument'), k);
  }
  const badSize = { hole: sparse(2, { 1: 160 }), tail: sparse(2, { 0: 320 }), getter: getter([320], 1, 160), proxy: new Proxy([320, 160], {}), extra: Object.assign([320, 160], { more: 1 }), holeExtra: Object.assign(sparse(2, { 1: 160 }), { more: 1 }), long: [320, 160, 1], text: ['320', 160] };
  for (const [k, at] of Object.entries(badSize)) {
    assert.throws(() => checkElements(at, [canvas]), coded('usage.bad-argument'), `size ${k}`);
    assert.throws(() => createTwoDStage({ size: at }, { elements: [canvas] }), coded('usage.bad-argument'), `ctx.size ${k}`);
  }
  const badCalls = {
    ctxProxy: [new Proxy({ size }, {}), { elements: [canvas] }],
    ctxGetter: [getter({}, 'size', size), { elements: [canvas] }],
    optsProxy: [{ size }, new Proxy({ elements: [canvas] }, {})],
    optsGetter: [{ size }, getter({}, 'elements', [canvas])],
    // 读一次一个样的 css：查的那次和用的那次可以不是同一段
    cssObject: [{ size }, { elements: [canvas], css: { toString: () => '' } }],
    fontsProxy: [{ size }, { elements: [canvas], fonts: new Proxy([font], {}) }],
    fontProxy: [{ size }, { elements: [canvas], fonts: [new Proxy(font, {})] }],
    fontGetter: [{ size }, { elements: [canvas], fonts: [getter({ url: font.url }, 'family', 'Probe')] }],
  };
  for (const [k, [ctx, opts]] of Object.entries(badCalls)) assert.throws(() => createTwoDStage(ctx, opts), coded('usage.bad-argument'), k);
  assert.equal(read, 0, '访问器被执行了');
  // 活 Proxy 挂满 13 种 Reflect 计数转发陷阱：七个位置同步拒收，且每个位置的陷阱触发次数严格为 0；普通 ctx 的前置 diagnostic 访问器在拒收前也不得执行
  const TRAPS = ['apply', 'construct', 'defineProperty', 'deleteProperty', 'get', 'getOwnPropertyDescriptor', 'getPrototypeOf', 'has', 'isExtensible', 'ownKeys', 'preventExtensions', 'set', 'setPrototypeOf'];
  const liveProxy = (target, hit) => new Proxy(target, Object.fromEntries(TRAPS.map((k) => [k, (...a) => { hit(); return Reflect[k](...a); }])));
  const seven = {
    ctx: (hit) => [liveProxy({ size }, hit), { elements: [canvas] }],
    'ctx.size': (hit) => [{ size: liveProxy([...size], hit) }, { elements: [canvas] }],
    opts: (hit) => [{ size }, liveProxy({ elements: [canvas] }, hit)],
    elements: (hit) => [{ size }, { elements: liveProxy([canvas], hit) }],
    item: (hit) => [{ size }, { elements: [liveProxy({ ...canvas }, hit)] }],
    rect: (hit) => [{ size }, { elements: [{ ...canvas, rect: liveProxy([...rect], hit) }] }],
    fonts: (hit) => [{ size }, { elements: [canvas], fonts: liveProxy([font], hit) }],
    fontItem: (hit) => [{ size }, { elements: [canvas], fonts: [liveProxy({ ...font }, hit)] }],
    fnItem: (hit) => [{ size }, { elements: [liveProxy(() => {}, hit)] }],
  };
  for (const [where, make] of Object.entries(seven)) {
    let traps = 0;
    const [ctx, opts] = make(() => { traps++; });
    assert.throws(() => createTwoDStage(ctx, opts), coded('usage.bad-argument'), `liveProxy ${where}`);
    assert.equal(traps, 0, `liveProxy ${where} 触发了 ${traps} 次陷阱`);
  }
  let diagRead = 0;
  const diagCtx = Object.assign(Object.defineProperty({}, 'diagnostic', { enumerable: true, get: () => { diagRead++; return 1; } }), { size, THREE: {} });
  assert.throws(() => createTwoDStage(diagCtx, null), coded('usage.bad-argument'), 'plain ctx with diagnostic getter');
  assert.equal(diagRead, 0, `普通 ctx 的 diagnostic 访问器被执行了 ${diagRead} 次`);
  // 照样收的：冻结的声明、带着别的字段的元素（字段里的对象一样逐层抄，舞台不用）
  const frozen = Object.freeze([Object.freeze({ ...canvas, rect: Object.freeze([...rect]), note: 'x', more: { deep: [1] } })]);
  assert.deepEqual(checkElements(Object.freeze([...size]), frozen).map((e) => [e.name, e.rect]), [['plot', rect]]);
  // 查的和用的是抄出来的那一份：交回之后调用方再改自己那份，舞台手里的不变
  const mine = [{ ...canvas, rect: [...rect] }], [held] = checkElements(size, mine);
  mine[0].rect[0] = NaN;
  mine[0].name = 'renamed';
  assert.deepEqual([held.name, held.rect], ['plot', rect]);
});

function assertDeclarationReadings(readings, browser) {
  const arrays = ['size', 'elements', 'rect', 'fonts'];
  function check(id, reject) {
    const actual = ['kept', 'hits', 'sync', 'late'].map((key) => readings[`${id}.${key}`]);
    // Node 只运行同步校验，通过后缺少页面；在 Chromium 中合法声明必须建台并成功释放。
    assert.deepEqual(actual, [1, 0, Number(reject), Number(!browser && !reject)], `${id} 的描述符保留、访问次数、同步拒收、异步失败`);
  }
  for (const place of ['ctx', 'size', 'opts', 'elements', 'item', 'rect', 'fonts', 'font']) {
    for (const form of ['data', 'accessor', 'fixed', 'inherited']) {
      check(`${place}.${form}`, place !== 'ctx' && form !== 'inherited' && (form === 'accessor' || arrays.includes(place)));
    }
    if (place !== 'font') for (const form of ['live', 'revoked']) check(`${place}.${form}`, true);
  }
  check('ctx.accessor.badOpts', true);
}

test('登记器在初始化时报告标记冲突，不把无关全局值当作判定函数', () => {
  for (const value of ['{}', '() => false']) {
    assert.throws(() => runInNewContext(`Object.defineProperty(globalThis, Symbol.for('beiming.three.isProxy'), {value:${value}}); (${installProxyRegistry})()`), /登记标记冲突/);
  }
});

test('早期 Node 22 没有 getBuiltinModule 也不替换全局 Proxy，导入前创建的 ctx 同步拒收', () => {
  const preload = 'process.getBuiltinModule = undefined; globalThis.original = Proxy; globalThis.at = new Proxy({ size: [32, 32] }, {});';
  const check = `import assert from 'node:assert/strict';
    import { createTwoDStage } from ${JSON.stringify(new URL('./two-d.js', import.meta.url).href)};
    assert.equal(Proxy, globalThis.original);
    assert.throws(() => createTwoDStage(globalThis.at, { elements: [{ kind: 'dom', html: '<p>x</p>' }] }), {code: 'usage.bad-argument'});`;
  execFileSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, '--input-type=module', '-e', check]);
});

test('Node：33 种 stack 声明保留属性，七处活 Proxy 和已撤销 Proxy 零陷阱同步拒收', async () => {
  assertDeclarationReadings(await declarationReadings({ size: [320, 160], THREE: {} }), false);
});

// 进页面之前就要拒掉的标记：外链、会执行的属性和标签、样式里的外部地址、svg 里再声明实体。纯校验和实渲两头都用这一份
const FAR = 'https://example.invalid/a.png';
const svgWith = (inner, attrs = '') => [{ kind: 'svg', name: 'a', rect: [0, 0, 10, 10], svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" ${attrs}>${inner}</svg>` }];
const domWith = (html) => [{ kind: 'dom', html }];
const BAD_MARKUP = Object.fromEntries([
  ['image', svgWith(`<image href="${FAR}" width="1" height="1"/>`)],
  ['xlink', svgWith('<use xlink:href="//example.invalid/a.svg#p"/>')],
  ['emptyEvent', svgWith('', 'onload=""')],
  ['bareEvent', svgWith('', 'onload')],
  ['script', svgWith('<script>1</script>')],
  ['foreign', svgWith('<foreignObject width="1" height="1"><p>x</p></foreignObject>')],
  ['smil', svgWith(`<image href="#a"><set attributeName="href" to="${FAR}"/></image>`)],
  ['paint', svgWith('<rect width="1" height="1" fill="url(https://example.invalid/p.svg#g)"/>')],
  ['sheet', svgWith('<style>rect{fill:url("data:image/svg+xml,x")}</style>')],
  ['nested', svgWith('<rect data-entity="inner" x="1" y="1" width="2" height="2"/>')],
  ['onerror', domWith('<p data-entity="a"><img src="#x" onerror="1">x</p>')],
  ['src', domWith('<p data-entity="a"><img src="/beiming/x.png">x</p>')],
  ['srcset', domWith(`<p data-entity="a"><img srcset="${FAR} 1x">x</p>`)],
  // 一个属性里能写好几个地址的：整个不收，全是本文档片段的也不收（浏览器按屏幕密度挑候选，后面的候选各有各的去处）
  ['srcsetLocal', domWith('<p data-entity="a"><img src="#x" srcset="#a 1x, #b 2x">x</p>')],
  ['srcsetLater', domWith(`<p data-entity="a"><img srcset="#a 1x, ${FAR} 2x">x</p>`)],
  ['srcsetBare', domWith('<p data-entity="a"><img srcset>x</p>')],
  ['imagesrcset', domWith('<p data-entity="a" imagesrcset="#a 1x, #b 2x">x</p>')],
  ['ping', domWith('<a data-entity="a" href="#top" ping="#a #b">x</a>')],
  ['archive', domWith('<p data-entity="a" archive="#a,#b">x</p>')],
  ['attributionsrc', domWith(`<a data-entity="a" href="#top" attributionsrc="#a ${FAR}">x</a>`)],
  ['href', domWith('<a data-entity="a" href="javascript:void 0">x</a>')],
  ['formaction', domWith(`<button data-entity="a" formaction="${FAR}">x</button>`)],
  ['background', domWith(`<table data-entity="a" background="${FAR}"><tr><td>x</td></tr></table>`)],
  ['styleUrl', domWith('<p data-entity="a" style="background:url(//example.invalid/a.png)">x</p>')],
  ['fileUrl', domWith('<p data-entity="a" style="background:url( \'file:///etc/hosts\' )">x</p>')],
  ['importRule', domWith('<style>@import "https://example.invalid/a.css";</style><p data-entity="a">x</p>')],
  ['imageSet', domWith(`<p data-entity="a" style="background:image-set('${FAR}' 1x)">x</p>`)],
  ['cssEscape', domWith(`<p data-entity="a" style="background:u\\72l(${FAR})">x</p>`)],
  ['charRef', domWith(`<p data-entity="a" style="background:&#117;rl(${FAR})">x</p>`)],
  ['namedRef', domWith(`<p data-entity="a" style="background:url&lpar;${FAR})">x</p>`)],
  ...['script', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'audio', 'video', 'applet', 'template'].map((tag) => [`tag_${tag}`, domWith(`<${tag}></${tag}><p data-entity="a">x</p>`)]),
]);
// 照样收的：指本文档里片段的引用、写成 &amp; 的和号、单独的和号
const GOOD_MARKUP = [
  ...svgWith('<defs><linearGradient id="g"><stop offset="0" stop-color="#D9654B"/></linearGradient><rect id="r" width="1" height="1"/></defs><rect width="10" height="10" fill="url(#g)"/><use href="#r"/><use xlink:href="#r"/>'),
  ...domWith('<style>.on{color:#1E1B18}</style><a data-entity="b" class="on" href="#top" style="filter:url(\'#f\')">Q&amp;A、R&D、turn on</a>'),
];

test('标记进页面之前先拒掉外链、事件属性、会执行或会联网的标签、样式里的外部地址和 svg 里的嵌套实体，都报 usage.bad-argument', () => {
  assert.equal(checkElements([640, 360], GOOD_MARKUP).length, 2);
  for (const [what, elements] of Object.entries(BAD_MARKUP)) {
    assert.throws(() => checkElements([640, 360], elements), coded('usage.bad-argument'), what);
    assert.throws(() => createTwoDStage({ size: [640, 360] }, { elements }), coded('usage.bad-argument'), `搭舞台：${what}`);
  }
});

test('页面宿主只多放行 fonts/ 下的 woff2：许可文件、锁文件、跳出目录的都拿不到', () => {
  assert.match(resolveServed('/fonts/NotoSansSC-var.woff2'), /fonts[\\/]NotoSansSC-var\.woff2$/);
  for (const bad of ['/fonts/LICENSE.md', '/fonts/fonts.lock.json', '/fonts/../package.json', '/engine/x.woff2']) assert.equal(resolveServed(bad), null, bad);
});

test('裸页面直接加载舞台后登记 Proxy，导入前的声明对象仍经克隆校验', async (t) => {
  let browser;
  try { browser = await chromium.launch({ executablePath: chromeExecutable(), args: chromeArgs() }); }
  catch (err) { t.skip(`起不了浏览器：${err.message.split('\n')[0]}`); return; }
  t.after(() => browser.close());
  const server = await startServer();
  t.after(() => server.close());
  const page = await browser.newPage();
  await page.goto(server.origin);
  // 静态服务只提供模块；这个页面没有宿主的 addInitScript。
  await page.addScriptTag({ type: 'module', content: `
    import { earlyOptions } from '/beiming/sources/three/s3-proxy.probe.js';
    import { declarationReadings } from '/beiming/sources/three/s3-probe.shot.js';
    import { createTwoDStage } from '/beiming/sources/three/two-d.js';
    import * as THREE from 'three';
    const ctx = { size: [320, 160], THREE };
    window.probe = declarationReadings(ctx);
    try { createTwoDStage(ctx, earlyOptions).then(stage => stage.dispose(), () => {}); }
    catch (err) { window.earlyCode = err.code; }
  ` });
  await page.waitForFunction(() => window.probe);
  assertDeclarationReadings(await page.evaluate(() => window.probe), true);
  assert.equal(await page.evaluate(() => window.earlyCode), 'usage.bad-argument');
});

// ---------- 实渲：探针镜头 ----------

const PROBE_SIZE = [640, 360];
const CARD = '<div data-entity="card" style="position:absolute;left:60.25px;top:200px;width:300px;height:120.25px;background:#FFFFFF">'
  + '<div style="height:20px;background:#E0B050"></div><span data-text-id="card.title" style="font:700 40px/1.5 sans-serif;color:#1E1B18;margin-left:20px">AI km</span>'
  + '<span data-text-id="card.gone" style="display:none">gone</span><span data-text-id="card.clear" style="opacity:0">clear</span><span data-text-id="card.blank">  </span></div>';
// 真的弹性布局：两块按 1 比 2 分 200 像素、中间隔 20，矩形只能从排版结果里量
const PILLS = '<div style="position:absolute;left:400px;top:200px;width:200px;display:flex;gap:20px"><div data-entity="pill_a" style="flex:1;height:50px;background:#5FA8A0"></div><div data-entity="pill_b" style="flex:2;height:50px;background:#D9654B"></div></div>';
const MARK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 100"><rect width="80" height="100" fill="#D9654B"/><rect x="80" width="80" height="100" fill="#5FA8A0"/></svg>';
const PROBE = [
  // 右边在像素中心右侧 1/64 px，正好覆盖 4 位亚像素光栅化的舍入边界。
  { kind: 'canvas2d', name: 'plot', rect: [40.25, 30.5, 240.515625, 150], fill: ['#FFFFFF', '#E0B050'], label: { id: 'plot.label', text: '2026', font: '700 36px sans-serif', at: [110, 110] } },
  { kind: 'svg', name: 'mark', rect: [300, 40, 460, 140], svg: MARK },
  { kind: 'dom', html: CARD + PILLS },
  // 第 0 帧在、第 1 帧不透明度是 0、第 2 帧交了不是数的不透明度
  { kind: 'dom', html: '<div data-entity="note" style="position:absolute;left:480px;top:280px;width:140px;height:60px;line-height:60px"><b data-text-id="note.word" style="font:700 30px sans-serif;color:#1E1B18">AIM</b></div>', opacity: [1, 0, 'x'] },
];
const WANT_BOX = { plot: PROBE[0].rect, mark: PROBE[1].rect, card: [60.25, 200, 360.25, 320.25], pill_a: [400, 200, 460, 250], pill_b: [480, 200, 600, 250], note: [480, 280, 620, 340] };
const probeShot = (id, elements, more = {}) => ({ id, in: 0, out: 3, source: 'three', host: 'page', mode: 'native-code', entry: 's3-probe.shot.js', colorRef: 'display', seed: 3, params: { elements, ...more } });
const probeFilm = (shots) => ({ format: 'film/3.0', id: 's3-probe', output: { size: PROBE_SIZE, fps: '30/1', frames: 3 }, shots });

test('探针：三种元素同台，逐元素的 bbox2d 对真实像素框不超过半个像素、编号层交并比过 L2，贴图朝向和颜色对，隐藏的文字不进 texts', async (t) => {
  await withSource(t, async ({ open, read }) => {
    const session = await open(probeFilm([probeShot('stage', PROBE)]), 'stage');
    assert.deepEqual(session.manifest().entities.map((e) => e.name), ['card', 'mark', 'note', 'pill_a', 'pill_b', 'plot']);
    const r = await session.render(0, {}, ['color', 'objectId', 'depth', 'normal']);
    assertMeta(r.meta, '探针第 0 帧');
    const [w, h] = PROBE_SIZE;
    for (const e of r.meta.entities) {
      const err = worst(e.bbox2d, WANT_BOX[e.name]);
      assert.ok(err <= (['plot', 'mark'].includes(e.name) ? 1e-4 : 0.5), `${e.name} 的 bbox2d ${e.bbox2d} 对 ${WANT_BOX[e.name]}`);
    }
    const ids = typed(Uint32Array, await read(r.layers.objectId));
    const boxes = verifySampledBboxes([{ frame: 0, meta: r.meta, objectId: { width: w, height: h, data: ids } }]);
    assert.ok(boxes.ok && boxes.frames[0].entities.length === 6, JSON.stringify(boxes.failures));
    for (const e of boxes.frames[0].entities) assert.ok(worst(e.computed, e.reported) <= OBJECT_ID_EDGE_TOLERANCE, `${e.name}：编号层 ${e.computed}，元数据 ${e.reported}`);
    // 深度层：后登记的更近；法线朝相机
    const depth = typed(Float32Array, await read(r.layers.depth)), normal = typed(Float32Array, await read(r.layers.normal));
    assert.ok(depth[100 * w + 100] > depth[90 * w + 400] && depth[90 * w + 400] > depth[300 * w + 550] && depth[5 * w + 5] === 1e10);
    assert.deepEqual([...normal.subarray((100 * w + 100) * 3, (100 * w + 100) * 3 + 3)], [0, 0, 1]);

    // 颜色：贴图没有上下颠倒、没有左右镜像，不是空贴图；纸色原样
    const rgb = toSrgb8(typed(Float32Array, await read(r.layers.color)));
    const near = (x, y, hex, what) => assert.ok(worst(pixel(rgb, w, x, y), rgbOf(hex)) <= 1, `${what} (${x}, ${y}) 是 ${pixel(rgb, w, x, y)}，要 ${hex}`);
    near(5, 5, PAPER, '纸');
    near(60, 45, '#E0B050', 'canvas2d 左上角那一格'); near(220, 45, '#FFFFFF', 'canvas2d 右上'); near(60, 140, '#FFFFFF', 'canvas2d 左下');
    near(320, 90, '#D9654B', 'svg 左半'); near(440, 90, '#5FA8A0', 'svg 右半');
    near(100, 210, '#E0B050', 'dom 卡片顶上的色条'); near(300, 310, '#FFFFFF', 'dom 卡片的底'); near(430, 225, '#5FA8A0', 'dom 弹性布局第一块'); near(540, 225, '#D9654B', 'dom 弹性布局第二块');

    // 文字框：display:none、不透明度 0、空白的三段不进；交了的三段过 L2 的墨迹核对（四边 8 像素）
    assert.deepEqual(r.meta.texts.map((x) => [x.id, x.text]).sort(), [['card.title', 'AI km'], ['note.word', 'AIM'], ['plot.label', '2026']]);
    const mask = inkMask(rgb, PROBE_SIZE);
    const text = verifySampledBboxes([{ frame: 0, meta: r.meta, ocr: ocrFromInk(r.meta, mask), inkMask: mask }]);
    assert.ok(text.ok && text.frames[0].texts.length === 3, JSON.stringify(text.failures));

    // 不透明度是 0 的那一帧：元素停到画面外，不占编号层，文字不进 texts，L2 照过
    const hidden = await session.render(1, {}, ['color', 'objectId']);
    assertMeta(hidden.meta, '探针第 1 帧');
    assert.deepEqual(hidden.meta.texts.map((x) => x.id).sort(), ['card.title', 'plot.label']);
    const note = hidden.meta.entities.find((e) => e.name === 'note');
    assert.ok(note.bbox2d[0] >= w && note.pxArea === 0, `note 的 bbox2d ${note.bbox2d}`);
    const ids1 = typed(Uint32Array, await read(hidden.layers.objectId));
    assert.ok(!ids1.includes(note.id) && ids.includes(note.id));
    assert.ok(verifySampledBboxes([{ frame: 1, meta: hidden.meta, objectId: { width: w, height: h, data: ids1 } }]).ok);
    // 回头再渲第 0 帧：和第一遍逐位相同（状态不留到下一帧）
    assert.equal((await session.render(0, {}, ['color'])).meta.hash.color, r.meta.hash.color);
    // 不透明度不是 [0, 1] 里的数：这一帧报错，不拿它当 0 或 1
    await assert.rejects(session.render(2, {}, ['color']), coded('contract.bad-value'));
    await session.close();

    // 草稿档（宽高各一半）：实体的包围盒和文字框跟着这一帧的实际尺寸走，编号层照样对得上
    const draft = await open(probeFilm([probeShot('stage', PROBE)]), 'stage', 'draft');
    const half = await draft.render(0, {}, ['color', 'objectId']);
    assertMeta(half.meta, '探针第 0 帧（草稿档）');
    assert.deepEqual(half.meta.size, [w / 2, h / 2]);
    for (const e of half.meta.entities) assert.ok(worst(e.bbox2d, WANT_BOX[e.name].map((v) => v / 2)) <= 0.25, `草稿档 ${e.name} 的 bbox2d ${e.bbox2d}`);
    half.meta.texts.forEach((x, i) => assert.ok(worst(x.bbox2d, r.meta.texts[i].bbox2d.map((v) => v / 2)) <= 1e-9 && x.id === r.meta.texts[i].id, x.id));
    assert.ok(verifySampledBboxes([{ frame: 0, meta: half.meta, objectId: { width: w / 2, height: h / 2, data: typed(Uint32Array, await read(half.layers.objectId)) } }]).ok);
    await draft.close();
  });
});

const WORD = 'font:700 30px sans-serif;color:#1E1B18';
const block = (name, x, y, style, more = '') => `<div data-entity="${name}" style="position:absolute;left:${x}px;top:${y}px;width:140px;height:50px;line-height:50px;${style}"><b data-text-id="${name}.word" style="${WORD}">AIM</b>${more}</div>`;
const BLOCK = { hero: [20, 20, 160, 70], shown: [200, 20, 340, 70], veiled: [20, 100, 160, 150], caption: [400, 20, 540, 70], peek: [400, 100, 540, 150] };
const HIDE = [
  { kind: 'dom', html: block('hero', 20, 20, 'background:#D9654B;opacity:0')
    + block('shown', 200, 20, 'background:#FFFFFF', `<b data-text-id="shown.ghost" style="${WORD};visibility:hidden">AIM</b>`)
    + `<div style="visibility:hidden">${block('veiled', 20, 100, 'background:#5FA8A0')}</div>`
    + block('caption', 400, 20, '') + block('peek', 400, 100, '') },
  // 盖板：第 0 帧不透明、把 caption 整个盖住，第 1 帧半透明，第 2 帧不在；lid_b 一直在，只盖住 peek 那段字的左边
  { kind: 'canvas2d', name: 'lid', rect: [390, 10, 550, 80], fill: ['#FFFFFF', '#FFFFFF'], opacity: [1, 0.5, 0] },
  { kind: 'canvas2d', name: 'lid_b', rect: [390, 90, 430, 160], fill: ['#FFFFFF', '#FFFFFF'] },
  { kind: 'svg', name: 'grad', rect: [200, 100, 340, 150], svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 140 50"><defs><linearGradient id="g"><stop offset="0" stop-color="#D9654B"/><stop offset="1" stop-color="#D9654B"/></linearGradient></defs><rect width="140" height="50" fill="url(#g)"/></svg>' },
];
const YEAR = (id, at) => ({ id, text: '2026', font: '700 36px sans-serif', at });
const CLIP = [
  // 透明的小画布，字画到画布外面：什么都没画出来
  { kind: 'canvas2d', name: 'out', rect: [40, 40, 104, 80], label: { id: 'out.word', text: 'X', font: '700 36px sans-serif', at: [110, 60] } },
  // 字整个在裁剪区外面
  { kind: 'canvas2d', name: 'cut', rect: [140, 40, 340, 120], fill: ['#FFFFFF', '#FFFFFF'], clip: [0, 0, 20, 20], label: YEAR('cut.word', [60, 55]) },
  // 裁剪区的右边从字的中间切过去：只留下左半
  { kind: 'canvas2d', name: 'part', rect: [380, 40, 580, 120], fill: ['#FFFFFF', '#FFFFFF'], clip: [0, 0, 90, 80], label: YEAR('part.word', [60, 55]) },
  { kind: 'canvas2d', name: 'whole', rect: [380, 200, 580, 280], fill: ['#FFFFFF', '#FFFFFF'], label: YEAR('whole.word', [60, 55]) },
];
// 邻居显式写了 visibility: visible：隔离一个实体或一段文字时它的墨迹不能串进来。display: none 的实体照常装载
const SEEN = `${WORD};visibility:visible`;
const spot = (x, y, width = 140) => `position:absolute;left:${x}px;top:${y}px;width:${width}px;height:50px;line-height:50px`;
const under = (name, x, more = '', y = 20) => `<div data-entity="${name}" style="${spot(x, y)}"><b data-text-id="${name}.word" style="${SEEN}${more}">AIM</b></div>`;
const BLEED = [
  { kind: 'dom', html:
    // 叠在一起的三对：下层的字显式看得见（第三对还带 !important），上层分别是透明的、藏着的、空的
    under('low_a', 20) + `<div data-entity="top_a" style="${spot(20, 20)};opacity:0">AIM</div>`
    + under('low_b', 200) + `<div data-entity="top_b" style="${spot(200, 20)};visibility:hidden">AIM</div>`
    + under('low_c', 400, '!important;opacity:1!important') + `<div data-entity="top_c" style="${spot(400, 20)}"></div>`
    // 不是实体的外壳显式看得见、带底色，伪元素里还有一段显式看得见的字：只参与排版，不画进里面的实体
    + `<style>.shell::before{content:"AIM";position:absolute;left:80px;top:0;visibility:visible!important;${WORD}}</style>`
    + `<div class="shell" style="${spot(20, 100)};visibility:visible;background:#D9654B"><div data-entity="bare" style="height:50px"><b data-text-id="bare.word" style="${WORD}">AIM</b></div></div>`
    // 一个实体里并排两段字，第二段显式看得见；盖板（下一个元素）只盖住第一段
    + `<div data-entity="pair" style="${spot(20, 200, 300)}"><b data-text-id="pair.a" style="${WORD}">AIM</b><b data-text-id="pair.b" style="${SEEN};margin-left:80px">AIM</b></div>`
    // display: none 写在自己身上、写在祖先身上
    + `<div data-entity="none_self" style="${spot(200, 100)};display:none;background:#5FA8A0"><b data-text-id="none_self.word" style="${SEEN}">AIM</b></div>`
    + `<div style="display:none"><div data-entity="none_up" style="${spot(400, 100)};background:#5FA8A0"><b data-text-id="none_up.word" style="${SEEN}">AIM</b></div></div>` },
  { kind: 'canvas2d', name: 'cap', rect: [10, 190, 110, 260], fill: ['#FFFFFF', '#FFFFFF'] },
];
// 邻居外面套一层包装：普通的（_w）和 display: contents 的（_c）各一组，结果要一样。display: contents 的节点自己不生成盒，写在它身上的不透明度不起作用
const WRAPS = { w: '', c: 'display:contents' };
const WRAP = [
  { kind: 'dom', html:
    // 叠在一起的两对：下层套着包装、字显式看得见，上层是透明的
    Object.entries(WRAPS).map(([k, wrap], i) => `<div style="${wrap}">${under(`low_${k}`, 20 + 180 * i)}</div><div data-entity="top_${k}" style="${spot(20 + 180 * i, 20)};opacity:0">AIM</div>`).join('')
    // 不是实体的 display: contents 节点显式看得见，直接带着一段字、伪元素里还有一段：不画进叠在上面的空实体
    + `<style>.ghost::before{content:"AIM";visibility:visible!important}</style>`
    + `<div style="${spot(400, 20)}"><span class="ghost" style="display:contents;visibility:visible;${WORD}">AIM</span><div data-entity="top_g" style="position:absolute;inset:0"></div></div>`
    // 一个实体里并排两段字，第二段套着包装、显式看得见；盖板只盖住第一段
    + Object.entries(WRAPS).map(([k, wrap], i) => `<div data-entity="pair_${k}" style="${spot(20, 100 + 80 * i, 300)}"><b data-text-id="pair_${k}.a" style="${WORD}">AIM</b><span style="${wrap}"><b data-text-id="pair_${k}.b" style="${SEEN};margin-left:80px">AIM</b></span></div>`).join('')
    // 看不看得见照浏览器合成出来的算：祖先 visibility: hidden、子节点显式恢复的看得见；祖先 opacity: 0 的怎么写都看不见
    + `<div style="visibility:hidden">${under('back', 20, '', 280)}</div><div style="opacity:0">${under('faded', 200, '', 280)}</div>`
    // 不是实体的祖先自己带着字，::first-letter、::first-line 都显式看得见：不画进里面的空实体
    + `<style>.lead::first-letter,.lead::first-line{visibility:visible!important}</style><div class="lead" style="${spot(400, 280)};${WORD}">AIM<div data-entity="top_l" style="position:absolute;inset:0"></div></div>`
    // 实体是 svg 里的一个图形，裁剪路径在祖先的 <defs> 里：祖先藏起来，裁剪路径照样作数，只留左半
    + `<svg style="${spot(340, 100)}" viewBox="0 0 140 50"><defs><clipPath id="half"><rect width="70" height="50"/></clipPath></defs><rect data-entity="cut" width="140" height="50" fill="#D9654B" clip-path="url(#half)"/></svg>` },
  ...Object.keys(WRAPS).map((k, i) => ({ kind: 'canvas2d', name: `cap_${k}`, rect: [10, 90 + 80 * i, 110, 160 + 80 * i], fill: ['#FFFFFF', '#FFFFFF'] })),
];

test('探针：藏起来的、被盖住的、被裁掉的内容，颜色层、编号层、visible、texts 四处说法一致', async (t) => {
  await withSource(t, async ({ open, read }) => {
    const [w, h] = PROBE_SIZE;
    const film = probeFilm([
      { ...probeShot('hide', HIDE), roles: { hero: 'hero', mustSee: ['veiled', 'caption', 'shown'] } },
      { ...probeShot('clip', CLIP), roles: { hero: 'out', mustSee: ['part'] } },
      { ...probeShot('bleed', BLEED), roles: { hero: 'low_a', mustSee: ['low_b', 'low_c', 'top_a', 'top_b', 'top_c', 'none_self', 'none_up'] } },
      { ...probeShot('wrap', WRAP), roles: { hero: 'low_w', mustSee: ['low_c', 'top_w', 'top_c', 'top_g', 'top_l', 'back', 'faded', 'cut'] } },
    ]);
    /** 渲一帧，交回按实体名、文字 id 查的元数据，和数像素的三个函数：编号层上这个实体占几个像素、矩形里有几个墨色像素、(x, y) 是不是这个颜色 */
    async function shoot(session, f) {
      const r = await session.render(f, {}, ['color', 'objectId']);
      assertMeta(r.meta, `第 ${f} 帧`);
      const ids = typed(Uint32Array, await read(r.layers.objectId)), rgb = toSrgb8(typed(Float32Array, await read(r.layers.color))), mask = inkMask(rgb, PROBE_SIZE);
      const entity = Object.fromEntries(r.meta.entities.map((e) => [e.name, e]));
      return {
        meta: r.meta, entity, rgb, mask, ids,
        texts: r.meta.texts.map((x) => x.id).sort(),
        idPixels: (name) => ids.reduce((n, id) => n + (id === entity[name].id), 0),
        ink: ([x0, y0, x1, y1]) => { let n = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) n += mask.data[y * w + x]; return n; },
        near: (x, y, hex, what) => assert.ok(worst(pixel(rgb, w, x, y), rgbOf(hex)) <= 1, `第 ${f} 帧 ${what} (${x}, ${y}) 是 ${pixel(rgb, w, x, y)}，要 ${hex}`),
      };
    }
    /** 画面上没有它：颜色层是纸色、编号层一个像素都没有、visible 是 0、停在画面外 */
    const gone = (shot, name, box) => {
      shot.near((box[0] + box[2]) >> 1, (box[1] + box[3]) >> 1, PAPER, name);
      assert.deepEqual([shot.idPixels(name), shot.ink(box), shot.entity[name].visible, shot.entity[name].pxArea], [0, 0, 0, 0], name);
      assert.ok(shot.entity[name].bbox2d[0] >= w, `${name} 的 bbox2d ${shot.entity[name].bbox2d}`);
    };

    const hide = await open(film, 'hide');
    const f0 = await shoot(hide, 0);
    // CSS 的 opacity: 0、祖先的 visibility: hidden：实体是空的，它上面的字、自己 visibility: hidden 的字都不进 texts
    gone(f0, 'hero', BLOCK.hero);
    gone(f0, 'veiled', BLOCK.veiled);
    // 被不透明的盖板整个盖住的字幕：画面上是盖板的白，编号层和 visible 说它看不见，texts 里也没有它；只被盖住一半的照交
    f0.near(470, 45, '#FFFFFF', '盖板');
    assert.deepEqual([f0.idPixels('caption'), f0.ink(BLOCK.caption), f0.entity.caption.visible], [0, 0, 0]);
    assert.deepEqual(f0.texts, ['peek.word', 'shown.word']);
    assert.ok(f0.ink(BLOCK.peek) > 0 && f0.ink(BLOCK.shown) > 0 && f0.idPixels('shown') === 140 * 50 && f0.entity.shown.visible === 1);
    f0.near(330, 25, '#FFFFFF', 'shown 的底');
    // 指本文档里片段的引用照常能用
    f0.near(270, 125, '#D9654B', 'svg 的渐变');
    // 盖板半透明：字幕透得出来，回到 texts 里
    assert.deepEqual((await shoot(hide, 1)).texts, ['caption.word', 'peek.word', 'shown.word']);
    // 盖板不在：字幕的墨迹、编号、visible 都回来了
    const f2 = await shoot(hide, 2);
    assert.deepEqual(f2.texts, ['caption.word', 'peek.word', 'shown.word']);
    assert.ok(f2.ink(BLOCK.caption) > 0 && f2.idPixels('caption') === 140 * 50 && f2.entity.caption.visible === 1);
    gone(f2, 'hero', BLOCK.hero);
    await hide.close();

    const clip = await open(film, 'clip');
    const c0 = await shoot(clip, 0);
    // 画到画布外面的字、整个被裁掉的字：颜色层上没有墨迹，texts 里也没有；什么都没画的画布是空实体
    gone(c0, 'out', [40, 40, 104, 80]);
    assert.equal(c0.ink([0, 0, 360, h]), 0);
    assert.deepEqual(c0.texts, ['part.word', 'whole.word']);
    // 裁掉一半的字：文字框交的是留下来的墨迹，右边正好停在裁剪区的边上；没裁的那段是整个字形
    const box = Object.fromEntries(c0.meta.texts.map((x) => [x.id, x.bbox2d]));
    assert.equal(box['part.word'][2], 380 + 90);
    assert.ok(box['whole.word'][2] - box['whole.word'][0] > box['part.word'][2] - box['part.word'][0] + 20, JSON.stringify(box));
    assert.deepEqual([box['part.word'][0] - 380, box['part.word'][1] - 40, box['part.word'][3] - 40], [box['whole.word'][0] - 380, box['whole.word'][1] - 200, box['whole.word'][3] - 200]);
    const text = verifySampledBboxes([{ frame: 0, meta: c0.meta, ocr: ocrFromInk(c0.meta, c0.mask), inkMask: c0.mask }]);
    assert.ok(text.ok && text.frames[0].texts.every((x) => x.edgeErr <= 1), JSON.stringify(text.frames[0].texts));
    assert.equal(c0.entity.part.visible, 1);
    await clip.close();

    const bleed = await open(film, 'bleed');
    const b0 = await shoot(bleed, 0);
    // 上层什么都没画出来：编号层、visible 都没有它，下层那段字的墨迹不算它的；字在画面上，编号层和 visible 归下层
    for (const [low, top, x] of [['low_a', 'top_a', 20], ['low_b', 'top_b', 200], ['low_c', 'top_c', 400]]) {
      assert.deepEqual([b0.idPixels(top), b0.entity[top].visible, b0.entity[top].pxArea], [0, 0, 0], top);
      assert.ok(b0.entity[top].bbox2d[0] >= w, `${top} 的 bbox2d ${b0.entity[top].bbox2d}`);
      assert.deepEqual([b0.idPixels(low), b0.entity[low].visible, b0.ink([x, 20, x + 140, 70]) > 0], [140 * 50, 1, true], low);
    }
    // 外壳的底色和伪元素没画进里面的实体，实体自己的字照画
    b0.near(150, 105, PAPER, '外壳');
    assert.ok(b0.ink([20, 100, 95, 150]) > 0 && b0.ink([95, 100, 160, 150]) === 0);
    // 盖板底下没有墨迹，露在外面的只有第二段：texts 里只剩它，框里也只有它自己的墨迹
    assert.ok(b0.ink([10, 190, 110, 260]) === 0 && b0.ink([110, 190, 320, 260]) > 0);
    assert.deepEqual(b0.texts, ['bare.word', 'low_a.word', 'low_b.word', 'low_c.word', 'pair.b']);
    assert.ok(b0.meta.texts.find((x) => x.id === 'pair.b').bbox2d[0] >= 110);
    // display: none（自己、祖先）：照常装载出帧，是空实体，它的字不进 texts
    gone(b0, 'none_self', [200, 100, 340, 150]);
    gone(b0, 'none_up', [400, 100, 540, 150]);
    const ocr = verifySampledBboxes([{ frame: 0, meta: b0.meta, ocr: ocrFromInk(b0.meta, b0.mask), inkMask: b0.mask }]);
    assert.ok(ocr.ok && ocr.frames[0].texts.every((x) => x.edgeErr <= 1), JSON.stringify(ocr.frames[0].texts));
    await bleed.close();

    const wrap = await open(film, 'wrap');
    const w0 = await shoot(wrap, 0);
    Object.keys(WRAPS).forEach((k, i) => {
      // 套不套包装、包装生不生成盒都一样：透明的上层是空实体，编号层和 visible 归下层
      const x = 20 + 180 * i, y = 100 + 80 * i;
      assert.deepEqual([w0.idPixels(`top_${k}`), w0.entity[`top_${k}`].visible, w0.entity[`top_${k}`].pxArea], [0, 0, 0], `top_${k}`);
      assert.deepEqual([w0.idPixels(`low_${k}`), w0.entity[`low_${k}`].visible, w0.ink([x, 20, x + 140, 70]) > 0], [140 * 50, 1, true], `low_${k}`);
      // 盖板底下没有墨迹，露在外面的只有第二段：texts 里没有被盖死的第一段，第二段的框里只有它自己的墨迹
      assert.ok(w0.ink([10, y - 10, 110, y + 60]) === 0 && w0.ink([110, y - 10, 320, y + 60]) > 0, `pair_${k}`);
      assert.ok(w0.meta.texts.find((t) => t.id === `pair_${k}.b`).bbox2d[0] >= 110, `pair_${k}.b`);
    });
    gone(w0, 'top_g', [400, 20, 540, 70]);
    gone(w0, 'top_l', [400, 280, 540, 330]);
    w0.near(360, 125, '#D9654B', '裁剪路径留下的左半'); w0.near(460, 125, PAPER, '裁掉的右半');
    assert.deepEqual([w0.idPixels('cut'), w0.entity.cut.visible], [140 * 50, 1], 'cut');
    gone(w0, 'faded', [200, 280, 340, 330]);
    assert.deepEqual([w0.idPixels('back'), w0.entity.back.visible, w0.ink([20, 280, 160, 330]) > 0], [140 * 50, 1, true], 'back');
    assert.deepEqual(w0.texts, ['back.word', 'low_c.word', 'low_w.word', 'pair_c.b', 'pair_w.b']);
    const seenInk = verifySampledBboxes([{ frame: 0, meta: w0.meta, ocr: ocrFromInk(w0.meta, w0.mask), inkMask: w0.mask }]);
    assert.ok(seenInk.ok && seenInk.frames[0].texts.every((t) => t.edgeErr <= 1), JSON.stringify(seenInk.frames[0].texts));
    await wrap.close();
  });
});

test('探针：排版里查出来的错带错误码，装载当场失败', async (t) => {
  const dom = (html) => [{ kind: 'dom', html }];
  const cases = {
    dup: ['contract.bad-value', dom('<p data-entity="a">x</p><p data-entity="a">y</p>')],
    clash: ['contract.bad-value', [PROBE[1], ...dom('<p data-entity="mark">x</p>')]],
    orphan: ['contract.bad-value', dom('<p data-entity="a">x</p><span data-text-id="t">在实体外面</span>')],
    duptext: ['contract.bad-value', dom('<p data-entity="a"><i data-text-id="t">x</i><i data-text-id="t">y</i></p>')],
    empty: ['contract.bad-value', dom('<p>没有实体</p>')],
    outside: ['contract.bad-value', dom('<div data-entity="a" style="position:absolute;left:600px;top:0;width:100px;height:10px"></div>')],
    badname: ['contract.bad-value', dom('<p data-entity="has-dash">x</p>')],
    kind: ['usage.bad-argument', [{ kind: 'webgl', name: 'a', rect: [0, 0, 1, 1] }]],
    font: ['usage.bad-argument', dom('<p data-entity="a">x</p>'), { fonts: [{ family: 'Far', url: 'https://example.invalid/far.woff2' }] }],
    css: ['usage.bad-argument', dom('<p data-entity="a">x</p>'), { css: `p{background:url(${FAR})}` }],
    tail: ['usage.bad-argument', [{ ...PROBE[1], svg: `${MARK}<p>x</p>` }]],
    ...Object.fromEntries(Object.entries(BAD_MARKUP).map(([what, elements]) => [`markup_${what}`, ['usage.bad-argument', elements]])),
  };
  await withSource(t, async ({ open }) => {
    const film = probeFilm(Object.entries(cases).map(([id, [, elements, more]]) => probeShot(id, elements, more)));
    for (const [id, [code]] of Object.entries(cases)) await assert.rejects(open(film, id), (err) => { assert.equal(err.code, code, `${id}：${err.message}`); return true; }, id);
  });
});

// 文字自己的盒不作数：同一段字幕写成 display: inline 和 display: contents（自己不生成盒）各一份，别的都一样；
// 另有自己藏着而子节点显式看得见的、盒宽是 0 的、字伸出盒一百多像素的三段，和里面是两个隔开的子元素的一段（也分两种写法）。盖板第 0 帧盖住字幕，第 1 帧撤掉
const CAPTION = { inline: '', contents: 'display:contents' };
const line = (name, y, width, inner) => `<div data-entity="${name}" style="${spot(20, y, width)};${WORD}">${inner}</div>`;
const boxless = (display) => [
  { kind: 'dom', html: line('base', 20, 200, `<span data-text-id="caption" style="${display}">TEXT</span>`)
    + line('back', 100, 200, '<span data-text-id="back.word" style="visibility:hidden"><b style="visibility:visible">TEXT</b></span>')
    + line('thin', 180, 200, '<span data-text-id="thin.word" style="display:inline-block;width:0;white-space:nowrap">TEXT</span>')
    + line('wide', 260, 400, '<span data-text-id="wide.word" style="display:inline-block;width:4px;white-space:nowrap">AIM AIM AIM</span>')
    + line('mix', 310, 400, `<span data-text-id="mix.word" style="${display}"><b>AIM</b><b style="margin-left:150px">AIM</b></span>`) },
  { kind: 'canvas2d', name: 'lid', rect: [10, 10, 230, 80], fill: ['#FFFFFF', '#FFFFFF'], opacity: [1, 0] },
];

test('探针：文字自己的盒不作数（display: contents 没有盒、盒宽是 0、字伸出盒、自己藏着而子节点显式看得见），进不进 texts、框在哪都照墨迹', async (t) => {
  await withSource(t, async ({ open, read }) => {
    const film = probeFilm(Object.entries(CAPTION).map(([k, display]) => probeShot(k, boxless(display))));
    const uncovered = {};
    for (const k of Object.keys(CAPTION)) {
      const session = await open(film, k);
      for (const f of [0, 1]) {
        const r = await session.render(f, {}, ['color']);
        assertMeta(r.meta, `${k} 第 ${f} 帧`);
        const mask = inkMask(toSrgb8(typed(Float32Array, await read(r.layers.color))), PROBE_SIZE);
        let ink = 0;
        for (let y = 20; y < 70; y++) for (let x = 20; x < 220; x++) ink += mask.data[y * PROBE_SIZE[0] + x];
        // 盖住时字幕没有墨迹、不进 texts；撤盖后墨迹回来、照进。别的三段两帧都在
        assert.equal(ink > 0, f === 1, `${k} 第 ${f} 帧字幕那一块的墨迹 ${ink}`);
        assert.deepEqual(r.meta.texts.map((x) => [x.id, x.text]).sort(), [['back.word', 'TEXT'], ...(f ? [['caption', 'TEXT']] : []), ['mix.word', 'AIMAIM'], ['thin.word', 'TEXT'], ['wide.word', 'AIM AIM AIM']], `${k} 第 ${f} 帧`);
        // 框对颜色层上的墨迹：伸出盒的那段也一样，不能在盒边上截断
        const l2 = verifySampledBboxes([{ frame: f, meta: r.meta, ocr: ocrFromInk(r.meta, mask), inkMask: mask }]);
        assert.ok(l2.ok && l2.frames[0].texts.every((x) => x.edgeErr <= 1), `${k} 第 ${f} 帧：${JSON.stringify(l2.frames[0].texts)}`);
        if (f) uncovered[k] = r.meta.texts;
      }
      await session.close();
    }
    // 两种写法交的一模一样；隔开的两个子元素都在框里（框比隔开的那 150 像素宽）
    assert.deepEqual(uncovered.contents, uncovered.inline);
    const mix = uncovered.contents.find((x) => x.id === 'mix.word').bbox2d;
    assert.ok(mix[2] - mix[0] > 150 + 100, `mix.word 的框 ${mix}`);
  });
});

test('探针：过不了 JSON 的坏声明（数组空槽、访问器、Proxy、不对的 ctx 和画幅）调用当场抛，装到一半才失败的（字体取不到、实体重名）经 Promise 报；哪一种事后页面都不多一个节点、一款字体', async (t) => {
  await withSource(t, async ({ open }) => {
    const session = await open(probeFilm([probeShot('trials', [PROBE[1]], { trials: true })]), 'trials');
    const { readings } = (await session.render(0, {}, ['color'])).meta;
    assertDeclarationReadings(readings, true);
    // 每种：[调用当场抛了该抛的错误码, 交回的 Promise 带着该报的错误码失败, 事后页面多出来的节点数, 多登记的字体数, 陷阱/无关访问器触发次数]
    assert.equal(readings.earlyHits, 0, '宿主应在镜头的依赖模块执行之前登记 Proxy');
    const sync = ['early', 'slot', 'hole', 'getter', 'noCtx', 'noOpts', 'proxy', 'swap', 'trap', 'revoked', 'item', 'rectProxy', 'rectHole', 'fontsProxy', 'sizeHole', 'sizeTail', 'sizeGetter', 'sizeProxy', 'ctxProxy', 'optsProxy', 'ctxDiagNull'];
    // fine、ctxDiagOk 是对照：写对了的 Canvas 2D 声明在页面里照常装上（没抛、没失败），撤掉之后页面不多东西，diagnostic 访问器一次不碰
    const want = { ...Object.fromEntries(sync.map((k) => [k, [1, 0, 0, 0, 0]])), font: [0, 1, 0, 0, 0], dup: [0, 1, 0, 0, 0], fine: [0, 0, 0, 0, 0], ctxDiagOk: [0, 0, 0, 0, 0] };
    assert.deepEqual(Object.fromEntries(Object.keys(want).map((k) => [k, ['sync', 'late', 'nodes', 'fonts', 'traps'].map((x) => readings?.[`${k}.${x}`])])), want);
    await session.close();
  });
});

// ---------- 实渲：考题 18-1 的样板镜头 ----------

const SHOT = { id: 'explain', in: 0, out: FRAMES, source: 'three', host: 'page', mode: 'native-code', entry: 's3-18-1.shot.js', colorRef: 'display', seed: 181 };
const FILM = { format: 'film/3.0', id: 's3-18-1', output: { size: SIZE, fps: FPS, frames: FRAMES }, shots: [SHOT] };
const sceneAt = (f) => SCENES.find((s) => f >= s.in && f < s.out);
/** 这一帧画面上该有的文字，照字幕稿自己算（不问镜头代码）：这一场的固定文字，加正在显示的那块字幕 */
function copyAt(f) {
  const s = sceneAt(f), sub = s.subs.findLast((x) => f >= x.at);
  const last = s.subs.at(-1) === sub, until = last ? s.out - TAIL : s.subs[s.subs.indexOf(sub) + 1]?.at;
  return [...s.texts, ...(sub && f < until ? [sub] : [])].map((x) => [x.id, x.text]).sort();
}

test('18-1 的字幕稿：1920×1080、30 帧每秒、三场以上，开头留 9 帧、结尾留 11 帧、场间淡出 4 帧', () => {
  assert.deepEqual([SIZE, FPS, PAPER, LEAD, TAIL, FADE], [[1920, 1080], '30/1', '#F4F0E9', 9, 11, 4]);
  assert.ok(SCENES.length >= 3 && SCENES.at(-1).out === FRAMES);
  SCENES.forEach((s, i) => {
    assert.equal(s.in, i ? SCENES[i - 1].out : 0);
    assert.equal(s.subs[0].at, s.in + LEAD);
    assert.ok(s.subs.length >= 2 && s.subs.every((x, k) => x.text && (!k || x.at > s.subs[k - 1].at)) && s.subs.at(-1).at < s.out - TAIL - FADE);
    assert.ok(s.texts.length >= 3 && s.texts.every((x) => x.id && x.text));
  });
});

test('18-1：三场讲解实渲，元数据过 M1–M20、帧源过 F 各条，逐元素包围盒和文字框过 L2，底色占 75% 到 85%，场间淡出 4 帧，两遍哈希逐位相同', async (t) => {
  await withSource(t, async ({ open, read }) => {
    const [w, h] = SIZE, manifestOf = {};
    const reps = [20, 80, 130, 140], withIds = [4, 20, 29, 30, 40, 52, 80, 130, 140, 160], fade = [55, 56, 57, 58, 59, 60];
    const one = { shot: SHOT, opens: [], renders: [], queries: [], manifest: null };
    const shots = new Map();

    async function pass(label, frames) {
      const session = await open(FILM, 'explain');
      one.opens.push({ hasLock: false, hasSeed: true, usesCards: false, usesAssets: false, host: 'page', mode: 'native-code', unfitInput: [], status: 'ok' });
      one.manifest = manifestOf[label] = session.manifest();
      for (const f of frames) {
        const want = label === 'a' && withIds.includes(f) ? ['color', 'objectId'] : ['color'];
        const res = await session.render(f, {}, want);
        const rec = { call: one.renders.length, f, opts: {}, want, tier: 'final', locked: false, status: 'ok', layers: Object.keys(res.layers), metas: 1, meta: res.meta, metaBytes: Buffer.byteLength(JSON.stringify(res.meta)), layerRefs: [], fileBytes: {}, order: label === 'a' ? 'sequential' : 'shuffled' };
        const bytes = {};
        for (const [output, ref] of Object.entries(res.layers)) {
          bytes[output] = await read(ref);
          rec.fileBytes[output] = bytes[output].length;
          rec.layerRefs.push({ output, shape: ref.shape, hash: ref.hash, fileHash: `sha256:${createHash('sha256').update(bytes[output]).digest('hex')}`, fileBytes: bytes[output].length });
        }
        one.renders.push(rec);
        if (label === 'a') shots.set(f, { meta: res.meta, rgb: toSrgb8(typed(Float32Array, bytes.color)), ids: bytes.objectId && typed(Uint32Array, bytes.objectId) });
        else assert.equal(res.meta.hash.color, shots.get(f).meta.hash.color, `第 ${f} 帧两遍的颜色层哈希不同`);
      }
      await session.close();
    }
    const all = [...new Set([...withIds, ...fade])].sort((a, b) => a - b);
    await pass('a', all);
    // 第二遍：新开的会话，倒着求帧
    await pass('b', [140, 130, 80, 58, 56, 30, 20]);
    assert.deepEqual(manifestOf.a, manifestOf.b);

    // 每帧元数据：结构定义、判每帧元数据的各条、判核对记录的各条（M1–M20）；帧源核对记录过 F 各条
    for (const r of one.renders) assertMeta(r.meta, `第 ${r.f} 帧`);
    const obs = { film: FILM, caps: caps(), lock: null };
    assertContract(metaCheck(obs, one), '元数据核对记录');
    assertContract(sourceCheck(obs, one), '帧源核对记录');

    // 三种元素都在：Canvas 2D 的图、SVG 的徽标和流程图、DOM 的标题、卡片、字幕
    const names = manifestOf.a.entities.map((e) => e.name);
    for (const s of SCENES) for (const k of ['badge', 'title', 'sub_0', 'sub_1']) assert.ok(names.includes(`${s.id}_${k}`), `${s.id}_${k}`);
    assert.ok(names.includes('s2_flow') && names.includes('s3_chart') && names.filter((n) => n.includes('card')).length >= 5);

    // 编号层按 L2 交并比和光栅化外沿核验；Canvas 2D、SVG 的声明矩形另与宿主量得的浮点框直接比较。
    const sampled = withIds.map((f) => ({ frame: f, meta: shots.get(f).meta, objectId: { width: w, height: h, data: shots.get(f).ids } }));
    const boxes = verifySampledBboxes(sampled);
    assert.ok(boxes.ok && boxes.minIou >= 0.95, JSON.stringify(boxes.failures.slice(0, 3)));
    for (const row of boxes.frames) {
      const seen = row.entities.filter((e) => e.computed);
      // 这一场的元素都在画面上，别的场的都停在画面外
      const s = sceneAt(row.frame);
      assert.deepEqual(seen.map((e) => e.name.split('_')[0]).filter((p) => p !== s.id), [], `第 ${row.frame} 帧`);
      assert.ok(seen.length >= 4, `第 ${row.frame} 帧只看见 ${seen.length} 个实体`);
      for (const e of seen) {
        assert.ok(worst(e.computed, e.reported) <= OBJECT_ID_EDGE_TOLERANCE, `第 ${row.frame} 帧 ${e.name}：编号层 ${e.computed}，元数据 ${e.reported}`);
        if (RECTS[e.name]) assert.ok(worst(e.reported, RECTS[e.name]) <= 1e-4, `${e.name} 的 bbox2d ${e.reported} 对声明的 ${RECTS[e.name]}`);
      }
    }

    // 文字框：内容照字幕稿一字不差（淡出的帧也在，已经隐去的上一场、上一块字幕不在），框过 L2 的墨迹核对
    for (const f of all) assert.deepEqual(shots.get(f).meta.texts.map((x) => [x.id, x.text]).sort(), copyAt(f), `第 ${f} 帧的文字`);
    assert.equal(shots.get(4).meta.texts.some((x) => x.id.includes('sub')), false, '开头留的 9 帧里没有字幕');
    assert.equal(shots.get(52).meta.texts.some((x) => x.id.includes('sub')), false, '结尾留的 11 帧里没有字幕');
    assert.notDeepEqual(copyAt(29), copyAt(30));
    const textFrames = [...reps, 30, 160].map((f) => {
      const mask = inkMask(shots.get(f).rgb, SIZE);
      return { frame: f, meta: shots.get(f).meta, ocr: ocrFromInk(shots.get(f).meta, mask), inkMask: mask };
    });
    const texts = verifySampledBboxes(textFrames);
    assert.ok(texts.ok, JSON.stringify(texts.failures.slice(0, 3)));
    assert.ok(texts.frames.every((row) => row.texts.length >= 5 && row.texts.every((x) => x.edgeErr <= 8)));
    // 墨色就是字幕稿定的那个颜色：掩膜里最暗的像素是它
    assert.ok(worst(pixel(shots.get(20).rgb, w, ...firstInk(inkMask(shots.get(20).rgb, SIZE))), rgbOf(INK)) <= 80);

    // 底色：三场的代表帧上纸色占 75% 到 85%
    for (const f of reps) {
      const share = paperShare(shots.get(f).rgb);
      assert.ok(share >= 0.75 && share <= 0.85, `第 ${f} 帧纸色占 ${share}`);
    }
    // 淡出：第 55 帧还是满的，56 到 59 四帧一帧比一帧淡，第 60 帧是下一场
    const off = fade.map((f) => offPaper(shots.get(f).rgb));
    for (let i = 1; i < 5; i++) assert.ok(off[i] < off[i - 1] && off[i] > 0, `淡出不单调：${off}`);
    const partial = off.slice(0, 5).filter((v) => v < 0.98 * off[0] && v > 0.02 * off[0]).length;
    assert.ok(partial >= 3 && partial <= 4, `淡出占了 ${partial} 帧：${off}`);
    assert.ok(off[5] > off[4] && sceneAt(60).id === 's2');
    // Canvas 2D 的图是每帧现画的：柱子长到一半的那一帧和长满的不一样
    assert.notEqual(shots.get(130).meta.hash.color, shots.get(140).meta.hash.color);
  });
});

/** 掩膜里第一个墨迹像素的 [x, y]，取它右下方一格（避开边缘的过渡像素） */
function firstInk(mask) {
  for (let y = 1; y < mask.height - 1; y++) for (let x = 1; x < mask.width - 1; x++) {
    const at = y * mask.width + x;
    if (mask.data[at] && mask.data[at + 1] && mask.data[at - 1] && mask.data[at + mask.width] && mask.data[at - mask.width]) return [x, y];
  }
  throw new Error('画面上没有墨迹');
}
