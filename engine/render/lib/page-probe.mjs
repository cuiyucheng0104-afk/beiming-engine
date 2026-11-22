// three.js 探针垫片：页面按 importmap 取 /node_modules/three/build/three.module.js 时，交给它一个垫片模块——
// 原样转出真模块的全部导出（同一批类，页面行为不变），只把 WebGLRenderer 换成一个子类：构造完把实例的 render 交给探针包一层
// （three 的 render 是构造函数里挂在实例上的，改原型抓不到），用来记每帧画面里贴图面片的屏幕位置（plates 检查）。
// 本地导出的同名绑定优先于 export *；真模块用 ?bmqa=real 区分，服务端照常给原文件。
export const THREE_MODULE = /^\/node_modules\/three\/build\/(three\.module(?:\.min)?\.js)$/;
export const threeShim = name => [
  `import * as T from './${name}?bmqa=real';`,
  `export * from './${name}?bmqa=real';`,
  'const QA = window.__BMQA;',
  'if (QA && QA.installThree) QA.installThree(T);',
  'class WebGLRenderer extends T.WebGLRenderer { constructor(...a) { super(...a); if (QA && QA.wrapRenderer) QA.wrapRenderer(this); } }',
  'export { WebGLRenderer };', ''].join('\n');

// 页面里的探针（在页面任何脚本之前运行）
export const PROBE = cfg => {
  if (cfg && !window.__RENDER) window.__RENDER = { fps: cfg.fps, width: cfg.width, height: cfg.height, profile: cfg.profile };
  const QA = window.__BMQA = { rec: false, hide: false, runs: [], fonts: [], ids: new WeakMap(), next: 1 };
  const alphaOf = s => {
    if (typeof s !== 'string') return 1;
    let m = /^#([0-9a-f]{8})$/i.exec(s);
    if (m) return parseInt(m[1].slice(6), 16) / 255;
    m = /rgba?\(([^)]*)\)/i.exec(s);
    if (m) { const p = m[1].split(/[\s,/]+/).filter(Boolean); if (p.length >= 4) return p[3].endsWith('%') ? parseFloat(p[3]) / 100 : parseFloat(p[3]); }
    return 1;
  };
  QA.alphaOf = alphaOf;
  const NFF = window.FontFace;
  if (NFF) {
    const Wrapped = function FontFace(family, source, desc) {
      const ff = new NFF(family, source, desc);
      let bin = null;
      if (source instanceof ArrayBuffer) bin = new Uint8Array(source.slice(0));
      else if (ArrayBuffer.isView(source)) bin = new Uint8Array(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength));
      QA.fonts.push({ family: String(family), src: typeof source === 'string' ? source : null, bin, face: ff, base: document.baseURI });
      return ff;
    };
    Wrapped.prototype = NFF.prototype;
    Object.defineProperty(window, 'FontFace', { value: Wrapped, writable: true, configurable: true });
  }
  const idOf = c => { if (!c) return 0; let id = QA.ids.get(c); if (!id) { id = QA.next++; QA.ids.set(c, id); } return id; };
  for (const Ctx of [window.CanvasRenderingContext2D, window.OffscreenCanvasRenderingContext2D].filter(Boolean)) {
    for (const name of ['fillText', 'strokeText']) {
      const orig = Ctx.prototype[name];
      Ctx.prototype[name] = function (text, x, y) {
        if (QA.rec) {
          const str = String(text);
          try {
            const t = this.getTransform(), m = this.measureText(str);
            const L = x - m.actualBoundingBoxLeft, R = x + m.actualBoundingBoxRight, T = y - m.actualBoundingBoxAscent, B = y + m.actualBoundingBoxDescent;
            const pts = [[L, T], [R, T], [L, B], [R, B]].map(([px, py]) => [t.a * px + t.c * py + t.e, t.b * px + t.d * py + t.f]);
            const cv = this.canvas, attached = !!(cv && cv.isConnected);
            let sx = 1, sy = 1, ox = 0, oy = 0;
            if (attached) { const r = cv.getBoundingClientRect(); sx = r.width / cv.width; sy = r.height / cv.height; ox = r.left; oy = r.top; }
            const xs = pts.map(p => p[0] * sx + ox), ys = pts.map(p => p[1] * sy + oy);
            let loaded = null;
            try { loaded = document.fonts.check(this.font, str); } catch { loaded = null; }
            QA.runs.push({
              op: name, text: str, font: this.font, filter: this.filter && this.filter !== 'none' ? this.filter : null,
              alpha: this.globalAlpha * alphaOf(name === 'fillText' ? this.fillStyle : this.strokeStyle),
              canvas: idOf(cv), attached, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], loaded,
            });
          } catch (e) { QA.runs.push({ op: name, text: str, font: this.font, error: String(e) }); }
        }
        if (QA.hide) return undefined;
        return orig.apply(this, arguments);
      };
    }
  }
  QA.domTexts = () => {
    const out = [];
    if (!document.body || !(document.body.innerText || '').trim()) return out;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n, k = 0;
    while ((n = w.nextNode()) && k < 400) {
      const s = n.nodeValue;
      if (!s || !s.trim()) continue;
      const el = n.parentElement;
      if (!el || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(el.tagName)) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      let op = 1;
      for (let e = el; e && e.nodeType === 1; e = e.parentElement) op *= parseFloat(getComputedStyle(e).opacity || '1');
      if (op <= 0.02) continue;
      const rg = document.createRange(); rg.selectNodeContents(n);
      const r = rg.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const svg = el instanceof SVGElement;
      out.push({ text: s.trim(), font: `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`, alpha: op * alphaOf(svg ? cs.fill : cs.color), box: [r.left, r.top, r.right, r.bottom], dom: true });
      k++;
    }
    return out;
  };
  QA.sampleTexts = async (f, t, dom = true) => {
    let texts = null, textsError = null;
    if (typeof window.TEXTS === 'function') {
      try { texts = window.TEXTS(t); if (texts && typeof texts.then === 'function') texts = await texts; } catch (e) { textsError = String((e && e.message) || e); }
      if (texts != null && !Array.isArray(texts)) { textsError = `TEXTS(t) 应返回数组，收到 ${typeof texts}`; texts = null; }
      else if (texts) texts = JSON.parse(JSON.stringify(texts));
    }
    return { f, texts, textsError, runs: QA.runs, dom: dom ? QA.domTexts() : [] };
  };
  // mode：false = 恢复；'text' = 只关文字（fillText / strokeText 不画、DOM 与 SVG 文字透明），字后面的底板、图标照常画；
  // 'layer' = 再把叠在 WebGL 画布上面的 2D 显示层整层藏掉（engine/stage/film.js 的做法），给画成路径的字（书法片名）取背景
  QA.setHidden = mode => {
    const on = !!mode;
    QA.hide = on;
    let st = document.getElementById('__bmqa_hide');
    if (on && !st) {
      st = document.createElement('style'); st.id = '__bmqa_hide';
      st.textContent = '*{color:transparent!important;text-shadow:none!important;-webkit-text-stroke:0!important;caret-color:transparent!important}svg text,svg tspan{fill:transparent!important;stroke:transparent!important}';
      document.head.appendChild(st);
    } else if (!on && st) st.remove();
    const cvs = [...document.querySelectorAll('canvas')];
    const gl = cvs.filter(c => c.__bmType === 'webgl');
    for (const c of cvs) {
      if (c.__bmType !== '2d' || !gl.length) continue;
      const z = parseInt(getComputedStyle(c).zIndex, 10) || 0;
      if (gl.some(g => (parseInt(getComputedStyle(g).zIndex, 10) || 0) < z)) c.style.visibility = mode === 'layer' ? 'hidden' : '';
    }
  };
  // ── 底板面片探针：three.js 垫片调 installThree(T)；platesRec 打开时，每次 render(scene, camera) 记下场景里可见的贴图平面 ──
  // 记录：图片地址与原尺寸、四角的裁剪空间坐标（左上、右上、左下、右下）、四角对应的贴图 uv（已含 map.matrix 或裁切面片的 rect）、
  // 不透明度、是否横向循环、裁切面片的软边参数。同一帧里同一个面片只记一次（后期会把场景渲好几遍）。
  QA.plates = []; QA.platesSeen = new Set(); QA.platesRec = false; QA.platesErr = null; QA.three = null;
  QA.installThree = T => { if (!QA.three && T && T.WebGLRenderer) { QA.three = T.REVISION || 'unknown'; QA.T = T; } };
  QA.wrapRenderer = renderer => {
    const T = QA.T;
    if (!T || !renderer || typeof renderer.render !== 'function' || renderer.__bmqa) return;
    renderer.__bmqa = true;
    const orig = renderer.render;
    const v = new T.Vector4(), pv = new T.Matrix4();
    renderer.render = function (scene, camera) {
      const capture = QA.platesRec && scene && camera && camera.isCamera;
      // 在生产页先让作品自行更新世界矩阵、渲染，再只读已经生效的矩阵；不能替作品提前执行更新钩子。
      const afterDraw = capture && cfg === null;
      const result = afterDraw ? orig.apply(this, arguments) : undefined;
      if (capture) {
        try {
          if (!afterDraw && scene.matrixWorldAutoUpdate !== false) scene.updateMatrixWorld();
          if (!afterDraw && camera.parent === null && camera.matrixWorldAutoUpdate !== false) camera.updateMatrixWorld();
          pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
          scene.traverseVisible(o => {
            if (!o.isMesh || !o.geometry || o.geometry.type !== 'PlaneGeometry' || QA.platesSeen.has(o.uuid)) return;
            const mat = Array.isArray(o.material) ? null : o.material;
            if (!mat || mat.visible === false || mat.colorWrite === false) return;
            const U = mat.uniforms || null;
            const crop = !!(U && U.rect && U.map);
            const map = crop ? U.map.value : (mat.map || (U && U.map && U.map.value) || null);
            const img = map && map.image;
            const src = img && (img.currentSrc || img.src);
            if (typeof src !== 'string' || !src || src.startsWith('data:')) return;
            const g = o.geometry.parameters || {}, w = g.width ?? 1, h = g.height ?? 1;
            const corners = [[-w / 2, h / 2, 0, 1], [w / 2, h / 2, 1, 1], [-w / 2, -h / 2, 0, 0], [w / 2, -h / 2, 1, 0]];
            const clip = corners.map(([x, y]) => { v.set(x, y, 0, 1).applyMatrix4(o.matrixWorld).applyMatrix4(pv); return [v.x, v.y, v.z, v.w]; });
            let uv;
            if (crop) {
              const r = U.rect.value, flip = !!(U.flip && U.flip.value > 0.5);
              uv = corners.map(([, , s, t]) => { const q = flip ? 1 - s : s; return [r.x + q * r.z, r.y + t * r.w]; });
            } else if (U && !mat.map) return;   // 自定义着色器，uv 怎么用不知道，不猜
            else {
              if (!afterDraw && map.matrixAutoUpdate) map.updateMatrix();
              const e = map.matrix.elements;
              uv = corners.map(([, , s, t]) => [e[0] * s + e[3] * t + e[6], e[1] * s + e[4] * t + e[7]]);
            }
            const op = (mat.opacity ?? 1) * (crop && U.opacity ? U.opacity.value : 1);
            QA.platesSeen.add(o.uuid);
            QA.plates.push({ src, iw: img.naturalWidth || img.width, ih: img.naturalHeight || img.height, flipY: map.flipY !== false,
              wrapS: map.wrapS === T.RepeatWrapping, wrapT: map.wrapT === T.RepeatWrapping, clip, uv, opacity: op, order: o.renderOrder,
              crop: crop ? { soft: U.soft ? U.soft.value : 0.55 } : null, name: o.name || '' });
          });
        } catch (e) { QA.platesErr = String((e && e.message) || e); }
      }
      return afterDraw ? result : orig.apply(this, arguments);
    };
  };

  const gc = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, opts) {
    const ctx = gc.call(this, type, opts);
    if (ctx && !this.__bmType) this.__bmType = /webgl|webgpu/i.test(type) ? 'webgl' : type === '2d' ? '2d' : String(type);
    return ctx;
  };
};

export async function fontInventory(h) {
  return h.page.evaluate(() => {
    const QA = window.__BMQA;
    const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
    const faces = QA.fonts.map(f => ({ origin: 'FontFace', family: f.family, src: f.src, base: f.base, bin: f.bin ? b64(f.bin) : null, weight: f.face.weight, style: f.face.style, unicodeRange: f.face.unicodeRange, status: f.face.status }));
    const walk = (rules, base) => {
      for (const r of rules) {
        if (r.type === CSSRule.FONT_FACE_RULE) {
          faces.push({ origin: 'css', family: r.style.getPropertyValue('font-family').trim(), src: r.style.getPropertyValue('src'), base, weight: r.style.getPropertyValue('font-weight') || '400', style: r.style.getPropertyValue('font-style') || 'normal', unicodeRange: r.style.getPropertyValue('unicode-range') || '', status: null });
        } else if (r.cssRules) walk(r.cssRules, base);
      }
    };
    const errors = [];
    for (const sh of document.styleSheets) { try { walk(sh.cssRules, sh.href || document.baseURI); } catch { errors.push(`读不到样式表 ${sh.href}（跨域）`); } }
    const set = [];
    document.fonts.forEach(ff => set.push({ family: ff.family, weight: ff.weight, style: ff.style, unicodeRange: ff.unicodeRange, status: ff.status }));
    return { faces, set, errors };
  });
}
