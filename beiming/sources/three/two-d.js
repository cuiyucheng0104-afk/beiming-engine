// 二维讲解舞台（页面一侧，镜头代码用）：Canvas 2D、SVG、DOM 三种元素各自光栅化成贴图，贴到相机空间里按像素对齐的平面网格上。
// 每个元素一个实体：宿主照常从网格顶点量 bbox2d、bbox3d，辅助层（编号、深度、法线）照常出；文字框经 meta(f).texts 交。
// 渲染库用 ctx.THREE，这里不引入；纯函数（rectToPlane、checkElements）node 里也能用。
// SVG 和 DOM 走同一条路：排进页面里一个看不见的、和画幅同大的容器（真的浏览器排版），整层序列化成 SVG 的 foreignObject、
// 解码成图、裁到元素的矩形里画上画布。解码是异步的，所以只在 build 里做一次；逐帧能变的是不透明度，要逐帧重画的用 Canvas 2D。
// 当图片用的 SVG 文档拿不到外部资源（浏览器的规矩），字体只能照 fonts 声明内联进去；没声明字体时用的是这台机器的系统字体。
// 排版是在活动的页面里做的，那里拿得到外部资源、也会执行脚本，所以标记和样式进页面之前先过 checkMarkup、checkCss：外链、事件属性、会执行的标签一律拒收。

/** 舞台的相机和摆法：竖直视场角（度）、近远裁剪面（米）、第一个元素离相机多远（米）、每后一个元素靠近多少（米）、默认的纸色 */
export const STAGE = Object.freeze({ fovYDeg: 40, nearM: 1, farM: 100, distanceM: 10, stepM: 0.001, paper: '#F4F0E9' });
export const KINDS = Object.freeze(['canvas2d', 'svg', 'dom']);

const NAME = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/, TEXT_ID = /^[\w.:-]+$/, FONT_WORD = /^[\w -]+$/;
// 文字墨迹：透明度不低于这个数（0 到 255）的像素才算，抗锯齿边上的淡影不算
const INK_ALPHA = 32;
// 量文字墨迹时在排版盒外面多看这么多像素：字形可以伸出行盒
const INK_PAD = 32;
// 自己从不画出来、只给别处引用的 SVG 节点：隔离一个节点时不动它们（<symbol> 上的样式会跟着 <use> 进到用它的地方）
const UNPAINTED = ['defs', 'symbol', 'clippath', 'mask', 'pattern', 'marker', 'lineargradient', 'radialgradient', 'filter', 'style', 'title', 'desc', 'metadata'];
const coded = (code, message) => Object.assign(new Error(message), { code });
const show = (v) => JSON.stringify(v) ?? String(v);

// ---- 标记和样式的拒收表 ----
// 不收的标签：会执行、会联网、会带进另一份文档的，和按时间走的 SMIL 动画（它还能把引用改成外部地址）；parsererror 是解析失败留下的
const BAD_TAGS = ['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'foreignobject', 'link', 'meta', 'base', 'audio', 'video', 'template', 'portal', 'fencedframe', 'parsererror', 'animate', 'set', 'animatemotion', 'animatetransform'];
// 值是地址的属性：只收指本文档里片段的（# 打头）
const URL_ATTRS = ['href', 'src', 'action', 'formaction', 'background', 'poster', 'data'];
// 一个属性里能写好几个地址的：整个不收，值是什么都一样（浏览器挑哪个候选要看屏幕密度，逐个去判就得和它的解析一模一样）
const MULTI_ATTRS = ['srcset', 'imagesrcset', 'ping', 'archive', 'attributionsrc'];
const isMulti = (name) => MULTI_ATTRS.includes(name.toLowerCase().split(':').pop());
// 样式里不收的写法。反斜杠转义能把 url 拼出来（u\72l），所以整个不收
const CSS_BAD = [[/url\((?!\s*["']?\s*#)/i, 'url(…) 只能指本文档里的片段（url(#名字)）'], [/@import/i, '不收 @import'], [/image-set\(/i, '不收 image-set(…)'], [/\\/, '不收反斜杠转义']];
// 不看上下文的整段扫描（node 里只有这一步）：宁可错拒。文字内容里出现这些写法也拒
const TEXT_BAD = [
  [new RegExp(`<\\/?(?:[\\w-]+:)?(?:${BAD_TAGS.join('|')})(?![\\w-])`, 'i'), `不收这些标签：${BAD_TAGS.join('、')}`],
  [/(?:^|[\s"'/])on[\w:-]*\s*=/i, '不收 on 打头的事件属性'],
  [new RegExp(`(?:^|[\\s"'/:])(?:${URL_ATTRS.join('|')})\\s*=(?!\\s*["']?\\s*#)`, 'i'), `${URL_ATTRS.join('、')} 只能指本文档里的片段（# 打头）`],
  [new RegExp(`(?:^|[\\s"'/:])(?:${MULTI_ATTRS.join('|')})\\s*=`, 'i'), `不收 ${MULTI_ATTRS.join('、')}（一个属性里能写好几个地址）`],
  // 字符引用解出来可以是上面任何一种写法
  [/&#|&(?!(?:amp|lt|gt|quot|apos|nbsp);)[a-z0-9]+;/i, '字符引用只收 &amp; &lt; &gt; &quot; &apos; &nbsp;，别的字直接写'],
  ...CSS_BAD,
];
const refuse = (what, why, hit) => coded('usage.bad-argument', `${what}：${why}${hit ? `（${show(String(hit).slice(0, 40))}）` : ''}`);

/** 样式进页面之前：外部地址、@import、image-set、反斜杠转义都报 usage.bad-argument */
export function checkCss(what, css) {
  for (const [re, why] of CSS_BAD) if (re.test(css)) throw refuse(what, why, css.match(re)[0]);
}

/**
 * 标记（svg、html）进页面之前先过这一关，不过的报 usage.bad-argument。两步：整段扫一遍（TEXT_BAD，加逐个标签看属性名）；
 * 有 DOMParser 的地方（页面里）再落成一份惰性文档逐个节点查。惰性文档不取资源、不执行脚本，舞台挂进页面的就是这份查过的节点，不把原文再解析一遍。
 * svg 为真时是 kind: 'svg' 的标记：只能是一个 <svg>，里面不能再有 data-entity（一张图就是一个实体）。交回惰性文档，node 里交 null。
 */
function checkMarkup(what, markup, svg = false) {
  for (const [re, why] of TEXT_BAD) if (re.test(markup)) throw refuse(what, why, markup.match(re)[0]);
  // 没写值的属性（<svg onload>、<img srcset>）上面扫不到：逐个标签把属性名过一遍
  for (const [, attrs] of markup.matchAll(/<[a-z][^\s/>]*((?:"[^"]*"|'[^']*'|[^>"'])*)/gi)) {
    for (const [, name] of attrs.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]*))?/g)) {
      if (/^on/i.test(name)) throw refuse(what, '不收 on 打头的事件属性', name);
      if (isMulti(name)) throw refuse(what, `不收 ${MULTI_ATTRS.join('、')}`, name);
    }
  }
  if (svg && /data-entity/i.test(markup)) throw refuse(what, 'svg 元素整张图是一个实体，里面不能再写 data-entity；要逐个图形当实体就把 <svg> 写进 dom 元素');
  if (typeof DOMParser === 'undefined') return null;

  const doc = new DOMParser().parseFromString(markup, 'text/html');
  for (const el of doc.querySelectorAll('*')) {
    const tag = el.localName.toLowerCase();
    if (BAD_TAGS.includes(tag)) throw refuse(what, `不收 <${tag}>`);
    if (tag === 'style') checkCss(what, el.textContent);
    for (const { name, value } of el.attributes) {
      const key = name.toLowerCase();
      if (key.startsWith('on')) throw refuse(what, '不收 on 打头的事件属性', name);
      if (isMulti(key)) throw refuse(what, `不收 ${MULTI_ATTRS.join('、')}`, name);
      if (URL_ATTRS.includes(key.split(':').pop()) && !value.trim().startsWith('#')) throw refuse(what, `${name} 只能指本文档里的片段（# 打头）`, value);
      // 样式属性和 SVG 的呈现属性（fill、filter、mask…）都当样式解析
      checkCss(what, value);
    }
  }
  if (svg) {
    const [root, ...rest] = [...doc.head.children, ...doc.body.children];
    if (root?.localName !== 'svg' || rest.length) throw refuse(what, '标记必须正好是一个 <svg>');
    if (doc.querySelector('[data-entity]')) throw refuse(what, 'svg 元素里面不能再写 data-entity');
  }
  return doc;
}

/**
 * 像素矩形 [x0, y0, x1, y1]（原点在左上角，y 向下）反算成正对相机的平面：相机在原点朝 −Z、竖直视场角 STAGE.fovYDeg。
 * order 是第几个元素（从 0 起），越大越靠近相机。交回 { distance 米, pixelM 这个距离上一个像素多少米, corners 四个角的相机空间坐标：左上、右上、左下、右下 }。
 */
export function rectToPlane([x0, y0, x1, y1], [width, height], order = 0) {
  const distance = STAGE.distanceM - order * STAGE.stepM;
  const pixelM = (2 * distance * Math.tan((STAGE.fovYDeg * Math.PI) / 360)) / height;
  const at = (x, y) => [(x - width / 2) * pixelM, (height / 2 - y) * pixelM, -distance];
  return { distance, pixelM, corners: [at(x0, y0), at(x1, y0), at(x0, y1), at(x1, y1)] };
}

/** 矩形必须是四个有限的数、宽高是正的、整个在画面里；不是就报 code */
function checkRect(what, rect, [width, height], code) {
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every((v) => typeof v === 'number' && Number.isFinite(v))) throw coded(code, `${what} 的矩形必须是 [x0, y0, x1, y1] 四个有限的数（像素），给的是 ${show(rect)}`);
  if (!(rect[0] < rect[2] && rect[1] < rect[3])) throw coded(code, `${what} 的矩形宽高必须是正的，给的是 ${show(rect)}`);
  if (rect[0] < 0 || rect[1] < 0 || rect[2] > width || rect[3] > height) throw coded(code, `${what} 的矩形 ${show(rect)} 伸出了画面 ${width}×${height}`);
}
function checkName(name, taken, code) {
  if (typeof name !== 'string' || !NAME.test(name)) throw coded(code, `实体名 ${show(name)} 写法不对：一段或多段用点连接，每段只含 ASCII 字母、数字、下划线`);
  if (taken.has(name)) throw coded(code, `实体名 ${name} 重复`);
  taken.add(name);
}

/**
 * 核对元素声明，交回抄好的一份。size 是画幅 [宽, 高]。每项：
 *   { kind: 'canvas2d', name, rect, draw(c, tools), opacity? }   每个时刻调一次 draw 重画
 *   { kind: 'svg', name, rect, svg: '<svg …>…</svg>', opacity? }  整张图是一个实体，拉满 rect
 *   { kind: 'dom', html, opacity? }                              一层排版，里面每个带 data-entity 的节点是一个实体，矩形从排版结果量
 * opacity(f, sub) 交 [0, 1] 里的数，不写就是 1。声明不对报 usage.bad-argument；svg、html 还要过 checkMarkup（查过的惰性文档抄在 doc 里，node 里是 null）。
 */
export function checkElements(size, elements) {
  const bad = (message) => coded('usage.bad-argument', message);
  if (!Array.isArray(elements) || !elements.length) throw bad('elements 必须是不空的数组');
  const taken = new Set();
  return elements.map((e, i) => {
    if (!e || !KINDS.includes(e.kind)) throw bad(`第 ${i} 个元素的种类 ${show(e?.kind)} 不认识，只有 ${KINDS.join('、')}`);
    if (e.opacity !== undefined && typeof e.opacity !== 'function') throw bad(`第 ${i} 个元素的 opacity 必须是函数 (f, sub) => [0, 1] 里的数`);
    if (e.kind === 'dom') {
      if (typeof e.html !== 'string' || !e.html.trim()) throw bad(`第 ${i} 个元素（dom）缺 html`);
      return { kind: e.kind, html: e.html, opacity: e.opacity, doc: checkMarkup(`第 ${i} 个元素（dom）的 html`, e.html) };
    }
    checkName(e.name, taken, 'usage.bad-argument');
    checkRect(`元素 ${e.name}`, e.rect, size, 'usage.bad-argument');
    if (e.kind === 'canvas2d' && typeof e.draw !== 'function') throw bad(`元素 ${e.name}（canvas2d）缺 draw(c, tools)`);
    if (e.kind === 'svg' && !(typeof e.svg === 'string' && /^\s*<svg[\s>]/.test(e.svg))) throw bad(`元素 ${e.name}（svg）的 svg 必须是 <svg> 打头的标记`);
    return { kind: e.kind, name: e.name, rect: [...e.rect], draw: e.draw, svg: e.svg, opacity: e.opacity, doc: e.kind === 'svg' ? checkMarkup(`元素 ${e.name}（svg）的标记`, e.svg, true) : null };
  });
}

function base64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** 照声明取字体：登记给页面（排版、Canvas 2D 用），再内联成 @font-face 的样式（光栅化用的 SVG 文档用）。只从本机静态服务取 */
async function loadFonts(fonts) {
  const faces = [];
  let css = '';
  for (const { family, url, weight = 'normal', style = 'normal' } of fonts) {
    if (![family, weight, style].every((v) => typeof v === 'string' && FONT_WORD.test(v)) || typeof url !== 'string') throw coded('usage.bad-argument', `字体声明 ${show({ family, url, weight, style })} 写法不对`);
    const at = new URL(url, location.href);
    if (at.origin !== location.origin) throw coded('usage.bad-argument', `字体 ${family} 只能从本机静态服务取，不能是 ${at.origin}`);
    const res = await fetch(at);
    if (!res.ok) throw coded('usage.bad-argument', `字体 ${family} 取不到：${at.pathname}（${res.status}）`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const face = await new FontFace(family, bytes, { weight, style }).load();
    document.fonts.add(face);
    faces.push(face);
    css += `@font-face{font-family:"${family}";src:url(data:font/woff2;base64,${base64(bytes)});font-weight:${weight};font-style:${style}}`;
  }
  return { faces, css };
}

/** 二维上下文里一块像素（默认整张画布）的透明度通道，逐像素一个 0 到 255 的数 */
function alphaOf(c, x = 0, y = 0, w = c.canvas.width, h = c.canvas.height) {
  const { data } = c.getImageData(x, y, w, h), out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = data[i * 4 + 3];
  return out;
}

/** 宽 width、高 height 的一块像素里 isInk(第几个像素) 说算墨迹的那些：外接矩形 box [x0, y0, x1, y1]（这块像素自己的坐标，外沿）和逐像素的掩膜 mask；一个都没有是 null */
function inkOf(width, height, isInk) {
  const mask = new Uint8Array(width * height);
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!isInk(y * width + x)) continue;
    mask[y * width + x] = 1;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : { box: [x0, y0, x1 + 1, y1 + 1], mask };
}

/**
 * 搭一个二维讲解舞台，交回镜头对象 { scene, camera, entities, state, meta, dispose }，build 可以直接把它交给宿主。
 * opts：elements（见 checkElements）；background 纸色（默认 STAGE.paper）；css 排版用的样式；
 * fonts [{ family, url, weight?, style? }] 要锁定的字体（woff2，本机静态服务上的地址）。
 * 排版里查出来的错（实体名重复、矩形伸出画面、文字不在任何实体里、文字 id 重复）报 contract.bad-value。
 * 画面上看不见的东西不交：画出来一个像素都没有的、排版出来没有面积的（display: none）实体是空实体（不画、停到画面外、不占编号层）；藏起来的、没有墨迹的、
 * 墨迹被登记在后的不透明实体整个盖住的文字不进 texts。
 */
export async function createTwoDStage(ctx, opts = {}) {
  const { THREE, size } = ctx, [W, H] = size;
  const items = checkElements(size, opts.elements);
  checkCss('css', String(opts.css ?? ''));
  const bad = (message) => coded('contract.bad-value', message);
  const fonts = await loadFonts(opts.fonts ?? []);
  // 样式进 XML 文档之前把 & 和 < 转掉
  const css = fonts.css + String(opts.css ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;');

  const root = document.createElement('div');
  root.style.cssText = `position:fixed;left:0;top:0;width:${W}px;height:${H}px;overflow:hidden;opacity:0;pointer-events:none`;
  const sheet = document.createElement('style');
  sheet.textContent = opts.css ?? '';
  root.append(sheet);
  document.body.append(root);

  const scene = new THREE.Scene(), entities = {}, disposable = [], groups = [], taken = new Set(), textIds = new Set();
  scene.background = new THREE.Color(opts.background ?? STAGE.paper);
  const camera = new THREE.PerspectiveCamera(STAGE.fovYDeg, W / H, STAGE.nearM, STAGE.farM);
  scene.add(camera);

  /** 一个实体：rect 是它的屏幕矩形（可以带小数），画布盖住 rect 外接的整数像素格，贴图坐标只取 rect 那一块：按 1:1 出帧时一个像素正好对一个纹素 */
  function addEntity(name, rect, canvas, cover) {
    const order = Object.keys(entities).length, plane = rectToPlane(rect, size, order);
    const u = (x) => (x - cover[0]) / (cover[2] - cover[0]), v = (y) => 1 - (y - cover[1]) / (cover[3] - cover[1]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(plane.corners.flat(), 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([u(rect[0]), v(rect[1]), u(rect[2]), v(rect[1]), u(rect[0]), v(rect[3]), u(rect[2]), v(rect[3])], 2));
    geometry.setIndex([0, 2, 1, 2, 3, 1]);
    const map = new THREE.CanvasTexture(canvas);
    map.colorSpace = THREE.SRGBColorSpace;
    map.minFilter = map.magFilter = THREE.LinearFilter;
    map.generateMipmaps = false;
    const material = new THREE.MeshBasicMaterial({ map, transparent: true, toneMapped: false });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    // 不画的时候（不透明度是 0、空实体）整个停到画面右边两个画幅宽以外：不占编号层，量出来的 bbox2d 也在画面外。
    // alpha 是画布这一刻的透明度通道（见 alphaOf），empty 是它一个像素都没有
    Object.assign(mesh.userData, { park: 2 * W * plane.pixelM, order, cover, alpha: null, empty: false });
    camera.add(mesh);
    entities[name] = mesh;
    disposable.push(geometry, material, map);
    return mesh;
  }
  /** 画布重画之后：重取透明度通道，一个像素都没有就是空实体 */
  function inked(mesh) {
    mesh.userData.alpha = alphaOf(mesh.material.map.image.getContext('2d'));
    mesh.userData.empty = !mesh.userData.alpha.some((a) => a);
    return mesh;
  }
  const coverOf = (rect) => [Math.floor(rect[0]), Math.floor(rect[1]), Math.ceil(rect[2]), Math.ceil(rect[3])];
  const blank = (cover) => Object.assign(document.createElement('canvas'), { width: cover[2] - cover[0], height: cover[3] - cover[1] });
  const NO_BOX = [0, 0, 1, 1];

  // ---- SVG 和 DOM：排版、量矩形、逐实体光栅化 ----
  const origin = root.getBoundingClientRect(), serializer = new XMLSerializer();
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return [r.left - origin.left, r.top - origin.top, r.right - origin.left, r.bottom - origin.top]; };
  // 抄一份出来改样式的地方：惰性文档，不取资源、不执行脚本
  const inert = document.implementation.createHTMLDocument('');
  const force = (node, prop, value) => node.style.setProperty(prop, value, 'important');
  /**
   * 这一层只画 el 这一个节点（what 是报错时怎么称呼它），光栅化、裁到 cover（整数像素格）里。改的是抄出来的一份，页面里排着版的那份不动：
   * - el 的祖先藏起来（visibility: hidden）：自己的底色、边框、文字不画，排版、裁剪、不透明度照旧作用在 el 上；
   * - 祖先链上每一层的其余子节点、el 里面的别的实体，不透明度写成 0。visibility 藏不住它们：子孙显式写 visibility: visible 照样画出来；
   *   祖先的不透明度是 0 时整棵子树合成出来就是空的，子孙怎么写都画不出一个像素，排版也不变；
   * - el 本来看得见才翻成看得见；本来就被样式藏着的（自己或祖先 visibility: hidden）不翻，画出来是什么和浏览器里一样。
   * 都写成带 !important 的行内样式，样式表盖不过；祖先的伪元素够不着行内样式，放进最先声明的一层（带 !important 时先声明的层赢）。
   * shortcut: el 用 <use> 引用的图形要是自己直接和 el 的祖先链并排（不在 <defs>、<symbol> 里），会跟着一起隐去；碰到了把它挪进 <defs>。
   */
  async function raster(layer, el, cover, what) {
    const canvas = blank(cover), [w, h] = [canvas.width, canvas.height];
    const shown = getComputedStyle(el).visibility === 'visible', path = [];
    for (let n = el; n !== layer; n = n.parentElement) path.unshift([...n.parentElement.children].indexOf(n));
    const copy = inert.importNode(layer, true);
    let node = copy;
    for (const index of path) {
      force(node, 'visibility', 'hidden');
      node.setAttribute('data-bm2d-spine', '');
      [...node.children].forEach((child, i) => { if (i !== index && !UNPAINTED.includes(child.localName.toLowerCase())) force(child, 'opacity', '0'); });
      node = node.children[index];
    }
    if (shown) force(node, 'visibility', 'visible');
    for (const inner of node.querySelectorAll('[data-entity]')) force(inner, 'opacity', '0');
    const xml = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${cover[0]} ${cover[1]} ${w} ${h}"><foreignObject width="${W}" height="${H}">`
      + `<div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;width:${W}px;height:${H}px"><style>@layer bm2d{[data-bm2d-spine]::before,[data-bm2d-spine]::after,[data-bm2d-spine]::marker{visibility:hidden!important}}${css}</style>`
      + `${serializer.serializeToString(copy)}</div></foreignObject></svg>`;
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
    await img.decode().catch(() => { throw bad(`${what} 这一层序列化出来的 SVG 解不了码（标记不是合法的 XML，或者太大）`); });
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    return canvas;
  }

  for (const item of items) {
    const group = { opacity: item.opacity, meshes: [], texts: [], on: true };
    groups.push(group);
    if (item.kind === 'canvas2d') {
      const cover = coverOf(item.rect), canvas = blank(cover);
      checkName(item.name, taken, 'contract.bad-value');
      // 每次重画都要读回像素（量文字的墨迹、判是不是空的），画布放在内存里
      Object.assign(group, { draw: item.draw, rect: item.rect, cover, c: canvas.getContext('2d', { willReadFrequently: true }) });
      group.meshes.push(addEntity(item.name, item.rect, canvas, cover));
      continue;
    }
    const layer = document.createElement('div');
    layer.style.cssText = `position:absolute;left:0;top:0;width:${W}px;height:${H}px`;
    // 挂进页面的是 checkMarkup 查过的那份惰性文档里的节点，不拿原文再解析一遍
    if (item.kind === 'svg') {
      const [x0, y0, x1, y1] = item.rect, box = document.createElement('div'), svg = item.doc.querySelector('svg');
      box.dataset.entity = item.name;
      box.style.cssText = `position:absolute;left:${x0}px;top:${y0}px;width:${x1 - x0}px;height:${y1 - y0}px`;
      svg.setAttribute('width', '100%');
      svg.setAttribute('height', '100%');
      svg.style.display = 'block';
      box.append(svg);
      layer.append(box);
    } else layer.append(...item.doc.head.childNodes, ...item.doc.body.childNodes);
    root.append(layer);

    const nodes = [...layer.querySelectorAll('[data-entity]')];
    if (!nodes.length) throw bad('一层 dom 里没有带 data-entity 的节点，画不出东西');
    for (const el of nodes) {
      const name = el.dataset.entity;
      checkName(name, taken, 'contract.bad-value');
      // svg 的矩形照声明的（排版会把小数对到 1/64 像素上），dom 的从排版结果量
      const rect = item.kind === 'svg' ? item.rect : rectOf(el);
      // 排出来没有面积的（自己或祖先 display: none、宽或高是 0）不是写错了，是这个实体不在画面上：空实体，占一个像素的位置、一直停在画面外
      if (!(rect[2] > rect[0] && rect[3] > rect[1])) {
        group.meshes.push(addEntity(name, NO_BOX, blank(NO_BOX), NO_BOX));
        entities[name].userData.empty = true;
        continue;
      }
      checkRect(`实体 ${name}`, rect, size, 'contract.bad-value');
      const cover = coverOf(rect);
      // 画出来一个像素都没有的（不透明度是 0、被藏起来的、没有底色也没有内容的）是空实体
      group.meshes.push(inked(addEntity(name, rect, await raster(layer, el, cover, `实体 ${name}`), cover)));
    }
    for (const el of layer.querySelectorAll('[data-text-id]')) {
      const id = el.dataset.textId, text = el.textContent.replace(/\s+/g, ' ').trim();
      if (!TEXT_ID.test(id) || textIds.has(id)) throw bad(`文字 id ${show(id)} 重复，或者写法不对（只能是字母、数字、下划线、点、冒号、连字符）`);
      textIds.add(id);
      const owner = el.closest('[data-entity]');
      if (!owner) throw bad(`文字 ${id} 不在任何带 data-entity 的节点里，画不出来`);
      // 这段字画在离它最近的那个实体的贴图上：只看落在那张画布里的墨迹，伸出去的画不出来
      const mesh = entities[owner.dataset.entity], within = mesh.userData.cover, box = rectOf(el);
      // 空的、display:none 的（排版盒是空的）、被样式藏起来的、所属实体什么都没画出来的不进文字框
      if (!text || mesh.userData.empty || !(box[2] > box[0] && box[3] > box[1]) || getComputedStyle(el).visibility !== 'visible') continue;
      const cover = [Math.max(within[0], Math.floor(box[0]) - INK_PAD), Math.max(within[1], Math.floor(box[1]) - INK_PAD), Math.min(within[2], Math.ceil(box[2]) + INK_PAD), Math.min(within[3], Math.ceil(box[3]) + INK_PAD)];
      if (!(cover[2] > cover[0] && cover[3] > cover[1])) continue;
      // 文字框取墨迹的外接矩形，不取排版盒：只画这段文字、光栅化、数不透明的像素；一个都没有（透明的字）不进文字框
      const width = cover[2] - cover[0], alpha = alphaOf((await raster(layer, el, cover, `文字 ${id}`)).getContext('2d'));
      const ink = inkOf(width, cover[3] - cover[1], (i) => alpha[i] >= INK_ALPHA);
      if (ink) group.texts.push({ id, text, bbox2d: [cover[0] + ink.box[0], cover[1] + ink.box[1], cover[0] + ink.box[2], cover[1] + ink.box[3]], mesh, at: [cover[0], cover[1]], width, mask: ink.mask });
    }
  }

  /**
   * Canvas 2D 元素在这个时刻重画一遍。坐标原点在元素矩形的左上角；tools.text 画一段字并记下它的文字框。
   * 文字框取这一笔真的落在画布上的墨迹：画之前、画之后各读一遍字形盒那一块的像素，变了的才算（有一个通道差到 INK_ALPHA）。
   * 所以画到画布外面的、被裁剪区整个裁掉的、和底色分不出来的字不进文字框；裁掉一部分的交留下来的那部分。
   */
  function redraw(group, f, sub) {
    const { c, rect, cover } = group, mesh = group.meshes[0], texts = [];
    c.reset();
    c.translate(rect[0] - cover[0], rect[1] - cover[1]);
    group.draw(c, {
      f, sub, width: rect[2] - rect[0], height: rect[3] - rect[1], rect: [...rect],
      text(id, value, x, y) {
        const text = String(value);
        if (!text.trim() || !(c.globalAlpha > 0)) return;
        if (typeof id !== 'string' || !TEXT_ID.test(id)) throw bad(`文字 id ${show(id)} 写法不对`);
        const m = c.measureText(text), t = c.getTransform();
        const corners = [[-m.actualBoundingBoxLeft, -m.actualBoundingBoxAscent], [m.actualBoundingBoxRight, -m.actualBoundingBoxAscent], [-m.actualBoundingBoxLeft, m.actualBoundingBoxDescent], [m.actualBoundingBoxRight, m.actualBoundingBoxDescent]]
          .map(([dx, dy]) => t.transformPoint({ x: x + dx, y: y + dy }));
        const xs = corners.map((p) => p.x), ys = corners.map((p) => p.y);
        if (![...xs, ...ys].every(Number.isFinite)) throw bad(`文字 ${id} 的框算出来不是有限的数：${show([x, y])}`);
        // 字形盒过当前变换，外面多看 2 像素（抗锯齿），裁到画布里
        const x0 = Math.max(0, Math.floor(Math.min(...xs)) - 2), y0 = Math.max(0, Math.floor(Math.min(...ys)) - 2);
        const w = Math.min(c.canvas.width, Math.ceil(Math.max(...xs)) + 2) - x0, h = Math.min(c.canvas.height, Math.ceil(Math.max(...ys)) + 2) - y0;
        if (!(w > 0 && h > 0)) { c.fillText(text, x, y); return; }
        const before = c.getImageData(x0, y0, w, h).data;
        c.fillText(text, x, y);
        const after = c.getImageData(x0, y0, w, h).data;
        const ink = inkOf(w, h, (i) => [0, 1, 2, 3].some((k) => Math.abs(after[i * 4 + k] - before[i * 4 + k]) >= INK_ALPHA));
        if (ink) texts.push({ id, text, bbox2d: [cover[0] + x0 + ink.box[0], cover[1] + y0 + ink.box[1], cover[0] + x0 + ink.box[2], cover[1] + y0 + ink.box[3]], mesh, at: [cover[0] + x0, cover[1] + y0], width: w, mask: ink.mask });
      },
    });
    group.texts = texts;
    inked(mesh).material.map.needsUpdate = true;
  }

  /**
   * 这段字这一刻有没有露出来的墨迹。盖得住它的只有登记在它所属实体之后（更靠近相机）、这一刻画着、整组不透明的实体里完全不透明的像素；
   * 半透明的盖不住。墨迹全被盖住的不算露出来。
   * shortcut: 只看实体之间的遮挡；同一个实体里画在字上面的东西（同一层 DOM 里叠在上面的节点、Canvas 2D 里后画的图形）看不出来，要查就得逐段文字多光栅化一遍。
   */
  function seen(t) {
    if (!t.mesh.visible) return false;
    const [x0, y0, x1, y1] = t.bbox2d;
    const upper = Object.values(entities).filter((m) => m.userData.order > t.mesh.userData.order && m.visible && m.material.opacity >= 0.999)
      .map((m) => m.userData).filter(({ cover }) => cover[0] < x1 && cover[2] > x0 && cover[1] < y1 && cover[3] > y0);
    if (!upper.length) return true;
    return t.mask.some((ink, i) => {
      if (!ink) return false;
      const x = t.at[0] + (i % t.width), y = t.at[1] + Math.floor(i / t.width);
      return !upper.some(({ cover: [cx0, cy0, cx1, cy1], alpha }) => x >= cx0 && x < cx1 && y >= cy0 && y < cy1 && alpha[(y - cy0) * (cx1 - cx0) + (x - cx0)] === 255);
    });
  }

  let at = null;
  function state(f, sub) {
    for (const group of groups) {
      const opacity = group.opacity ? group.opacity(f, sub) : 1;
      if (typeof opacity !== 'number' || !(opacity >= 0 && opacity <= 1)) throw bad(`元素 ${group.meshes[0].name} 在 (${f}, ${sub}) 的不透明度必须是 [0, 1] 里的数，交的是 ${show(opacity)}`);
      group.on = opacity > 0;
      if (group.on && group.draw) redraw(group, f, sub);
      for (const mesh of group.meshes) {
        mesh.visible = group.on && !mesh.userData.empty;
        mesh.position.x = mesh.visible ? 0 : mesh.userData.park;
        mesh.material.opacity = opacity;
      }
    }
    at = `${f}/${sub}`;
  }

  return {
    scene, camera, entities, state,
    /** 这一帧 sub = 0 时看得见的元素上露出来的文字框（见 seen）；宿主量之前渲染器已经写过这一刻，没写过就自己写一遍 */
    meta(f) {
      if (at !== `${f}/0`) state(f, 0);
      const texts = groups.filter((g) => g.on).flatMap((g) => g.texts.filter(seen).map((t) => ({ id: t.id, text: t.text, bbox2d: [...t.bbox2d] })));
      const twice = texts.find((t, i) => texts.findIndex((x) => x.id === t.id) !== i);
      if (twice) throw bad(`文字 id ${twice.id} 在这一帧交了两次`);
      return { texts };
    },
    dispose() {
      root.remove();
      for (const face of fonts.faces) document.fonts.delete(face);
      for (const x of disposable) x.dispose();
    },
  };
}
