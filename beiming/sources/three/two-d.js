// 二维讲解舞台（页面一侧，镜头代码用）：Canvas 2D、SVG、DOM 三种元素各自光栅化成贴图，贴到相机空间里按像素对齐的平面网格上。
// 每个元素一个实体：宿主照常从网格顶点量 bbox2d、bbox3d，辅助层（编号、深度、法线）照常出；文字框经 meta(f).texts 交。
// 渲染库用 ctx.THREE，这里不引入；纯函数（rectToPlane、checkElements）node 里也能用。
// SVG 和 DOM 走同一条路：排进页面里一个看不见的、和画幅同大的容器（真的浏览器排版），整层序列化成 SVG 的 foreignObject、
// 解码成图、裁到元素的矩形里画上画布。解码是异步的，所以只在 build 里做一次；逐帧能变的是不透明度，要逐帧重画的用 Canvas 2D。
// 当图片用的 SVG 文档拿不到外部资源（浏览器的规矩），字体只能照 fonts 声明内联进去；没声明字体时用的是这台机器的系统字体。

/** 舞台的相机和摆法：竖直视场角（度）、近远裁剪面（米）、第一个元素离相机多远（米）、每后一个元素靠近多少（米）、默认的纸色 */
export const STAGE = Object.freeze({ fovYDeg: 40, nearM: 1, farM: 100, distanceM: 10, stepM: 0.001, paper: '#F4F0E9' });
export const KINDS = Object.freeze(['canvas2d', 'svg', 'dom']);

const NAME = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/, TEXT_ID = /^[\w.:-]+$/, FONT_WORD = /^[\w -]+$/;
// 文字墨迹：透明度不低于这个数（0 到 255）的像素才算，抗锯齿边上的淡影不算
const INK_ALPHA = 32;
// 量文字墨迹时在排版盒外面多看这么多像素：字形可以伸出行盒
const INK_PAD = 32;
const coded = (code, message) => Object.assign(new Error(message), { code });
const show = (v) => JSON.stringify(v) ?? String(v);

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
 * opacity(f, sub) 交 [0, 1] 里的数，不写就是 1。声明不对报 usage.bad-argument。
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
      return { kind: e.kind, html: e.html, opacity: e.opacity };
    }
    checkName(e.name, taken, 'usage.bad-argument');
    checkRect(`元素 ${e.name}`, e.rect, size, 'usage.bad-argument');
    if (e.kind === 'canvas2d' && typeof e.draw !== 'function') throw bad(`元素 ${e.name}（canvas2d）缺 draw(c, tools)`);
    if (e.kind === 'svg' && !(typeof e.svg === 'string' && /^\s*<svg[\s>]/.test(e.svg))) throw bad(`元素 ${e.name}（svg）的 svg 必须是 <svg> 打头的标记`);
    return { kind: e.kind, name: e.name, rect: [...e.rect], draw: e.draw, svg: e.svg, opacity: e.opacity };
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

/** 画布上不透明度够得上墨迹的像素的外接矩形 [x0, y0, x1, y1]（画布自己的像素，外沿）；一个都没有是 null */
function inkBox(canvas) {
  const { width, height } = canvas, { data } = canvas.getContext('2d').getImageData(0, 0, width, height);
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (data[(y * width + x) * 4 + 3] < INK_ALPHA) continue;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
}

/**
 * 搭一个二维讲解舞台，交回镜头对象 { scene, camera, entities, state, meta, dispose }，build 可以直接把它交给宿主。
 * opts：elements（见 checkElements）；background 纸色（默认 STAGE.paper）；css 排版用的样式；
 * fonts [{ family, url, weight?, style? }] 要锁定的字体（woff2，本机静态服务上的地址）。
 * 排版里查出来的错（实体名重复、矩形是空的或伸出画面、文字不在任何实体里、文字 id 重复）报 contract.bad-value。
 */
export async function createTwoDStage(ctx, opts = {}) {
  const { THREE, size } = ctx, [W, H] = size;
  const items = checkElements(size, opts.elements);
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
    // 不透明度是 0 时整个停到画面右边两个画幅宽以外：不占编号层，量出来的 bbox2d 也在画面外
    mesh.userData.park = 2 * W * plane.pixelM;
    camera.add(mesh);
    entities[name] = mesh;
    disposable.push(geometry, material, map);
    return mesh;
  }
  const coverOf = (rect) => [Math.floor(rect[0]), Math.floor(rect[1]), Math.ceil(rect[2]), Math.ceil(rect[3])];
  const blank = (cover) => Object.assign(document.createElement('canvas'), { width: cover[2] - cover[0], height: cover[3] - cover[1] });

  // ---- SVG 和 DOM：排版、量矩形、逐实体光栅化 ----
  const origin = root.getBoundingClientRect(), serializer = new XMLSerializer();
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return [r.left - origin.left, r.top - origin.top, r.right - origin.left, r.bottom - origin.top]; };
  /** 这一层只让 selector 选中的节点看得见，光栅化、裁到 cover（整数像素格）里 */
  async function raster(layer, selector, cover) {
    const canvas = blank(cover), [w, h] = [canvas.width, canvas.height];
    const xml = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${cover[0]} ${cover[1]} ${w} ${h}"><foreignObject width="${W}" height="${H}">`
      + `<div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;width:${W}px;height:${H}px"><style>${css}.bm2d-layer,[data-entity]{visibility:hidden!important}${selector}{visibility:visible!important}</style>`
      + `${serializer.serializeToString(layer)}</div></foreignObject></svg>`;
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
    await img.decode().catch(() => { throw bad(`${selector} 这一层序列化出来的 SVG 解不了码（标记不是合法的 XML，或者太大）`); });
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    return canvas;
  }

  for (const item of items) {
    const group = { opacity: item.opacity, meshes: [], texts: [], on: true };
    groups.push(group);
    if (item.kind === 'canvas2d') {
      const cover = coverOf(item.rect), canvas = blank(cover);
      checkName(item.name, taken, 'contract.bad-value');
      group.meshes.push(addEntity(item.name, item.rect, canvas, cover));
      Object.assign(group, { draw: item.draw, rect: item.rect, cover, c: canvas.getContext('2d') });
      continue;
    }
    const layer = document.createElement('div');
    layer.className = 'bm2d-layer';
    layer.style.cssText = `position:absolute;left:0;top:0;width:${W}px;height:${H}px`;
    if (item.kind === 'svg') {
      const [x0, y0, x1, y1] = item.rect;
      layer.innerHTML = `<div data-entity="${item.name}" style="position:absolute;left:${x0}px;top:${y0}px;width:${x1 - x0}px;height:${y1 - y0}px">${item.svg}</div>`;
      const svg = layer.firstChild.firstElementChild;
      if (svg?.localName !== 'svg') throw coded('usage.bad-argument', `元素 ${item.name}（svg）的标记里没有 <svg>`);
      svg.setAttribute('width', '100%');
      svg.setAttribute('height', '100%');
      svg.style.display = 'block';
    } else layer.innerHTML = item.html;
    root.append(layer);

    const nodes = [...layer.querySelectorAll('[data-entity]')];
    if (!nodes.length) throw bad('一层 dom 里没有带 data-entity 的节点，画不出东西');
    for (const el of nodes) {
      const name = el.dataset.entity;
      checkName(name, taken, 'contract.bad-value');
      // svg 的矩形照声明的（排版会把小数对到 1/64 像素上），dom 的从排版结果量
      const rect = item.kind === 'svg' ? item.rect : rectOf(el);
      checkRect(`实体 ${name}`, rect, size, 'contract.bad-value');
      const cover = coverOf(rect);
      group.meshes.push(addEntity(name, rect, await raster(layer, `[data-entity="${name}"]`, cover), cover));
    }
    for (const el of layer.querySelectorAll('[data-text-id]')) {
      const id = el.dataset.textId, text = el.textContent.replace(/\s+/g, ' ').trim();
      if (!TEXT_ID.test(id) || textIds.has(id)) throw bad(`文字 id ${show(id)} 重复，或者写法不对（只能是字母、数字、下划线、点、冒号、连字符）`);
      textIds.add(id);
      if (!el.closest('[data-entity]')) throw bad(`文字 ${id} 不在任何带 data-entity 的节点里，画不出来`);
      const box = rectOf(el);
      // 空的、display:none 的（排版盒是空的）不进文字框
      if (!text || !(box[2] > box[0] && box[3] > box[1])) continue;
      const cover = [Math.max(0, Math.floor(box[0]) - INK_PAD), Math.max(0, Math.floor(box[1]) - INK_PAD), Math.min(W, Math.ceil(box[2]) + INK_PAD), Math.min(H, Math.ceil(box[3]) + INK_PAD)];
      if (!(cover[2] > cover[0] && cover[3] > cover[1])) continue;
      // 文字框取墨迹的外接矩形，不取排版盒：只让这段文字看得见、光栅化、数不透明的像素；一个都没有（透明的字）不进文字框
      const ink = inkBox(await raster(layer, `[data-text-id="${id}"]`, cover));
      if (ink) group.texts.push({ id, text, bbox2d: [cover[0] + ink[0], cover[1] + ink[1], cover[0] + ink[2], cover[1] + ink[3]] });
    }
  }

  /** Canvas 2D 元素在这个时刻重画一遍。坐标原点在元素矩形的左上角；tools.text 画一段字并记下它的文字框 */
  function redraw(group, f, sub) {
    const { c, rect, cover } = group, texts = [];
    c.reset();
    c.translate(rect[0] - cover[0], rect[1] - cover[1]);
    group.draw(c, {
      f, sub, width: rect[2] - rect[0], height: rect[3] - rect[1], rect: [...rect],
      text(id, value, x, y) {
        const text = String(value);
        if (!text.trim() || !(c.globalAlpha > 0)) return;
        if (typeof id !== 'string' || !TEXT_ID.test(id)) throw bad(`文字 id ${show(id)} 写法不对`);
        c.fillText(text, x, y);
        const m = c.measureText(text), t = c.getTransform();
        const corners = [[-m.actualBoundingBoxLeft, -m.actualBoundingBoxAscent], [m.actualBoundingBoxRight, -m.actualBoundingBoxAscent], [-m.actualBoundingBoxLeft, m.actualBoundingBoxDescent], [m.actualBoundingBoxRight, m.actualBoundingBoxDescent]]
          .map(([dx, dy]) => t.transformPoint({ x: x + dx, y: y + dy }));
        const xs = corners.map((p) => p.x + cover[0]), ys = corners.map((p) => p.y + cover[1]);
        const bbox2d = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
        if (!bbox2d.every(Number.isFinite)) throw bad(`文字 ${id} 的框算出来不是有限的数：${show([x, y])}`);
        texts.push({ id, text, bbox2d });
      },
    });
    group.texts = texts;
    group.meshes[0].material.map.needsUpdate = true;
  }

  let at = null;
  function state(f, sub) {
    for (const group of groups) {
      const opacity = group.opacity ? group.opacity(f, sub) : 1;
      if (typeof opacity !== 'number' || !(opacity >= 0 && opacity <= 1)) throw bad(`元素 ${group.meshes[0].name} 在 (${f}, ${sub}) 的不透明度必须是 [0, 1] 里的数，交的是 ${show(opacity)}`);
      group.on = opacity > 0;
      for (const mesh of group.meshes) {
        mesh.visible = group.on;
        mesh.position.x = group.on ? 0 : mesh.userData.park;
        mesh.material.opacity = opacity;
      }
      if (group.on && group.draw) redraw(group, f, sub);
    }
    at = `${f}/${sub}`;
  }

  return {
    scene, camera, entities, state,
    /** 这一帧 sub = 0 时看得见的元素上的文字框；宿主量之前渲染器已经写过这一刻，没写过就自己写一遍 */
    meta(f) {
      if (at !== `${f}/0`) state(f, 0);
      const texts = groups.filter((g) => g.on).flatMap((g) => g.texts.map((t) => ({ id: t.id, text: t.text, bbox2d: [...t.bbox2d] })));
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
