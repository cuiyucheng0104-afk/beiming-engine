// overlay.title 在 three 帧源里的实现：一行片名，用仓库锁定的 OFL 真字体分片（routes/c-style/fonts/，Ma Shan Zheng / BM Brush，
// 覆盖 7,015 个 ASCII 大小写/数字/标点与 GB2312 汉字）在离屏 Canvas2D 上光栅化，精确扫描非零 alpha 墨迹外框与水平游程并裁切成纹理，
// 贴到只覆盖非零 alpha 墨迹像素的正对透视相机平面网格上；纯 Node 单元测试环境下同样核对锁定字库码位并按确定性度量生成同构平面网格。
// 和宿主的约定（卡文件的 ports.requires 里也写了）：Handle.object 挂在透视相机下面，它的局部坐标就是相机空间：米，右手系，Y 向上，−Z 朝前。
// 颜色：ink 是显示空间的颜色，写进颜色层的是它解码到线性光之后的值，预乘透明度。
/* global URL, location, fetch, crypto, FontFace, document, window */

const MOTIONS = new Set(['rise', 'settle', 'fade']);
const ALPHA_MIN = 8;

function parseCodepoints(manifest) {
  const set = new Set();
  for (const chunk of manifest.chunks) {
    for (const part of chunk.codepoints.split(',')) {
      const [a, b = a] = part.split('-').map((h) => Number.parseInt(h, 16));
      for (let cp = a; cp <= b; cp++) set.add(cp);
    }
  }
  return set;
}

async function prepareFontEnv() {
  if (typeof window !== 'undefined' && typeof document !== 'undefined' && typeof FontFace !== 'undefined') {
    const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const base = new URL('/routes/c-style/fonts/', location.origin);
    if (!['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname)) {
      throw new Error('overlay.title 字体只从本机回环页面宿主装载');
    }
    const res = await fetch(new URL('fonts.json', base), { mode: 'same-origin', redirect: 'error', credentials: 'omit' });
    if (!res.ok) throw new Error('overlay.title 取不到锁定字体清单 fonts.json');
    const manifest = await res.json();
    const codepoints = parseCodepoints(manifest);
    const faces = await Promise.all(manifest.chunks.map(async (chunk) => {
      const r = await fetch(new URL(chunk.file, base), { mode: 'same-origin', redirect: 'error', credentials: 'omit' });
      if (!r.ok) throw new Error(`overlay.title 取不到锁定字体分片 ${chunk.file}`);
      const bytes = await r.arrayBuffer();
      if (bytes.byteLength !== chunk.size || hex(await crypto.subtle.digest('SHA-256', bytes)) !== chunk.sha256) {
        throw new Error(`overlay.title 字体分片 ${chunk.file} 字节或哈希与锁清单不符`);
      }
      const face = new FontFace(manifest.cssFamily, bytes, {
        weight: String(manifest.weight),
        style: manifest.style,
        unicodeRange: chunk.unicodeRange,
      });
      return face.load();
    }));
    await document.fonts.ready;
    return { browser: true, cssFamily: manifest.cssFamily, weight: manifest.weight, codepoints, faces };
  }
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const manifestPath = fileURLToPath(new URL('../../../../routes/c-style/fonts/fonts.json', import.meta.url));
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  return { browser: false, cssFamily: manifest.cssFamily, weight: manifest.weight, codepoints: parseCodepoints(manifest) };
}

const FONT_ENV = await prepareFontEnv();

/** 逐字核对锁定字体码位覆盖；缺字或全空白直接抛错，绝不静默回退系统字体 */
function checkTextCoverage(text) {
  if (typeof text !== 'string') throw new Error('overlay.title 的 text 必须是字符串');
  const chars = [...text];
  let hasInk = false;
  for (const ch of chars) {
    const cp = ch.codePointAt(0);
    if (!FONT_ENV.codepoints.has(cp)) {
      throw new Error(`overlay.title 的锁定字体字形表里没有 ${JSON.stringify(ch)}（U+${cp.toString(16).toUpperCase().padStart(4, '0')}）`);
    }
    if (ch.trim() !== '') hasInk = true;
  }
  if (!hasInk) throw new Error('overlay.title 的 text 里没有可见墨迹（没有一个亮点）');
  return chars;
}

/** 浏览器内用已装载的锁定真字体在离屏 Canvas2D 上光栅化片名，按实测非零 alpha 像素裁出紧凑纹理、宽高比与水平游程 */
function rasterizeTitle(THREE, chars, height, heightFrac) {
  const fontPx = Math.max(72, Math.min(240, Math.round(height * heightFrac * 1.25)));
  const fontSpec = `${FONT_ENV.weight} ${fontPx}px "${FONT_ENV.cssFamily}"`;
  const tracking = Math.round(fontPx * 0.22);
  const pad = fontPx;
  for (const face of FONT_ENV.faces) document.fonts.add(face);
  let stageW = 0, stageH = 0, src;
  try {
    const probe = document.createElement('canvas').getContext('2d');
    probe.font = fontSpec;
    const advances = chars.map((ch) => Math.max(1, Math.ceil(probe.measureText(ch).width)));
    const totalAdvance = advances.reduce((a, b) => a + b, 0) + Math.max(0, chars.length - 1) * tracking;
    stageW = Math.max(64, totalAdvance + pad * 2);
    stageH = Math.max(64, Math.ceil(fontPx * 2.6));
    const stage = document.createElement('canvas');
    stage.width = stageW;
    stage.height = stageH;
    const c = stage.getContext('2d', { willReadFrequently: true });
    c.font = fontSpec;
    c.textBaseline = 'alphabetic';
    c.textAlign = 'left';
    c.fillStyle = '#ffffff';
    let cursorX = pad;
    const baselineY = Math.round(fontPx * 1.45);
    for (let i = 0; i < chars.length; i++) {
      c.fillText(chars[i], cursorX, baselineY);
      cursorX += advances[i] + tracking;
    }
    src = c.getImageData(0, 0, stageW, stageH).data;
  } finally {
    for (const face of FONT_ENV.faces) document.fonts.delete(face);
  }
  let ix0 = stageW, iy0 = stageH, ix1 = 0, iy1 = 0;
  for (let y = 0; y < stageH; y++) {
    for (let x = 0; x < stageW; x++) {
      if (src[(y * stageW + x) * 4 + 3] >= ALPHA_MIN) {
        if (x < ix0) ix0 = x;
        if (y < iy0) iy0 = y;
        if (x + 1 > ix1) ix1 = x + 1;
        if (y + 1 > iy1) iy1 = y + 1;
      }
    }
  }
  if (ix1 <= ix0 || iy1 <= iy0) throw new Error('overlay.title 的 text 里没有可见墨迹（没有一个亮点）');
  const cropW = ix1 - ix0, cropH = iy1 - iy0;
  const crop = document.createElement('canvas');
  crop.width = cropW;
  crop.height = cropH;
  const cropCtx = crop.getContext('2d');
  const outImg = cropCtx.createImageData(cropW, cropH);
  const dst = outImg.data;
  const runs = [];
  for (let y = 0; y < cropH; y++) {
    let runStart = -1;
    for (let x = 0; x < cropW; x++) {
      const a = src[((iy0 + y) * stageW + (ix0 + x)) * 4 + 3];
      if (a >= ALPHA_MIN) {
        const k = (y * cropW + x) * 4;
        dst[k] = 255;
        dst[k + 1] = 255;
        dst[k + 2] = 255;
        dst[k + 3] = a;
        if (runStart < 0) runStart = x;
      } else if (runStart >= 0) {
        runs.push({ u0: runStart / cropW, u1: x / cropW, v0: 1 - (y + 1) / cropH, v1: 1 - y / cropH });
        runStart = -1;
      }
    }
    if (runStart >= 0) {
      runs.push({ u0: runStart / cropW, u1: 1, v0: 1 - (y + 1) / cropH, v1: 1 - y / cropH });
    }
  }
  cropCtx.putImageData(outImg, 0, 0);
  const texture = new THREE.CanvasTexture(crop);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return { aspect: cropW / cropH, texture, runs };
}

/** 按水平墨迹游程构建只覆盖非零 alpha 像素的平面网格（辅助层 objectId/depth 在透明背景处精确不命中） */
function buildRunGeometry(THREE, aspect, runs) {
  const n = runs.length;
  const position = new Float32Array(n * 12);
  const normal = new Float32Array(n * 12);
  const uv = new Float32Array(n * 8);
  const index = new Uint32Array(n * 6);
  for (let i = 0; i < n; i++) {
    const { u0, u1, v0, v1 } = runs[i];
    const x0 = (u0 - 0.5) * aspect, x1 = (u1 - 0.5) * aspect;
    const y0 = v0 - 0.5, y1 = v1 - 0.5;
    const p = i * 12, t = i * 8, k = i * 6, v = i * 4;
    position[p] = x0; position[p + 1] = y0; position[p + 2] = 0;
    position[p + 3] = x1; position[p + 4] = y0; position[p + 5] = 0;
    position[p + 6] = x1; position[p + 7] = y1; position[p + 8] = 0;
    position[p + 9] = x0; position[p + 10] = y1; position[p + 11] = 0;
    normal[p + 2] = 1; normal[p + 5] = 1; normal[p + 8] = 1; normal[p + 11] = 1;
    uv[t] = u0; uv[t + 1] = v0;
    uv[t + 2] = u1; uv[t + 3] = v0;
    uv[t + 4] = u1; uv[t + 5] = v1;
    uv[t + 6] = u0; uv[t + 7] = v1;
    index[k] = v; index[k + 1] = v + 1; index[k + 2] = v + 2;
    index[k + 3] = v; index[k + 4] = v + 2; index[k + 5] = v + 3;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  return geometry;
}

/** 纯 Node 无 DOM 单元测试环境的确定性排版宽高比 */
function fallbackAspect(chars) {
  const widthUnits = chars.reduce((sum, ch) => {
    const cp = ch.codePointAt(0);
    return sum + (ch === ' ' || cp === 0x3000 ? 0.35 : cp > 0xff ? 1.0 : 0.56);
  }, 0);
  return widthUnits + Math.max(0, chars.length - 1) * 0.22;
}

/**
 * ctx：镜头契约的 ctx，用到 THREE 和 size。params（卡文件里声明的七个）：
 *   text 片名；enter 入场的时刻（镜头局部帧号）；settleFrames 入场用几帧落定；ink 字的颜色（显示空间）；
 *   heightFrac 字高占画面高的比例；distance 平面离相机多远（米）；motion 入场动效 'rise'（默认）| 'settle' | 'fade'。
 * 入场：从 enter 起 settleFrames 帧里，按 1 − (1 − p)³ 缓出升位/落位与淡入；落定之后每一帧完全静止。enter 之前不画。
 */
export function create(ctx, params) {
  const { THREE } = ctx, [width, height] = ctx.size;
  const chars = checkTextCoverage(params.text);
  const motion = params.motion ?? 'rise';
  if (!MOTIONS.has(motion)) throw new Error(`overlay.title 不认识的入场动效 ${JSON.stringify(motion)}`);

  const { aspect, texture, runs } = FONT_ENV.browser
    ? rasterizeTitle(THREE, chars, height, params.heightFrac)
    : { aspect: fallbackAspect(chars), texture: null, runs: [{ u0: 0, u1: 1, v0: 0, v1: 1 }] };

  const geometry = buildRunGeometry(THREE, aspect, runs);
  const material = new THREE.MeshBasicMaterial({
    color: new THREE.Color(params.ink),
    ...(texture ? { map: texture } : {}),
    transparent: true,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'overlay.title';

  const projection = () => {
    if (!mesh.parent?.isPerspectiveCamera) throw new Error('overlay.title 的 object 必须挂在透视相机下面');
    return mesh.parent.projectionMatrix.elements;
  };
  /** t = f + sub 时刻的摆法：平面字高（米）、竖直偏移（米）、不透明度 */
  function pose(t) {
    // 离相机 distance 米处画面的高是 2 × distance ÷ 投影矩阵第 6 个数（米）；片名墨迹高占其中的 heightFrac
    const baseH = (params.heightFrac * 2 * params.distance) / projection()[5];
    const p = t < params.enter ? 0 : params.settleFrames === 0 ? 1 : Math.min(1, (t - params.enter) / params.settleFrames);
    const eased = 1 - (1 - p) ** 3;
    const scale = motion === 'settle' && p > 0 ? 0.85 + 0.15 * eased : 1;
    const liftFactor = motion === 'fade' ? 0 : motion === 'settle' ? 0.25 : 0.5;
    return { h: baseH * scale, lift: (eased - 1) * liftFactor * baseH, opacity: eased };
  }

  return {
    object: mesh,
    entities: { plane: { object: mesh, root: true } },

    apply(f, sub) {
      const s = pose(f + sub);
      mesh.visible = s.opacity > 0;
      mesh.scale.set(s.h, s.h, 1);
      mesh.position.set(0, s.lift, -params.distance);
      material.opacity = s.opacity;
    },

    /** 文字框：画幅内可见墨迹游程投到屏幕的外接框，像素，原点在左上角，y 向下。还没入场或完全在画面外的帧不交 */
    meta(f) {
      const s = pose(f);
      if (!(s.opacity > 0)) return { texts: [] };
      const proj = projection();
      const sx = (x) => ((proj[0] * x) / params.distance + 1) / 2 * width;
      const sy = (y) => (1 - (proj[5] * y) / params.distance) / 2 * height;
      const halfW = 0.5 * aspect * s.h, halfH = 0.5 * s.h;
      const fullX0 = sx(-halfW), fullY0 = sy(halfH + s.lift), fullX1 = sx(halfW), fullY1 = sy(-halfH + s.lift);
      const spanX = fullX1 - fullX0, spanY = fullY1 - fullY0;
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      for (const { u0, u1, v0, v1 } of runs) {
        const rx0 = Math.max(0, fullX0 + u0 * spanX), rx1 = Math.min(width, fullX0 + u1 * spanX);
        const ry0 = Math.max(0, fullY0 + (1 - v1) * spanY), ry1 = Math.min(height, fullY0 + (1 - v0) * spanY);
        if (rx0 < rx1 && ry0 < ry1) {
          if (rx0 < bx0) bx0 = rx0;
          if (ry0 < by0) by0 = ry0;
          if (rx1 > bx1) bx1 = rx1;
          if (ry1 > by1) by1 = ry1;
        }
      }
      if (!(bx0 < bx1 && by0 < by1)) return { texts: [] };
      return {
        texts: [{
          id: 'line',
          text: params.text,
          bbox2d: [bx0, by0, bx1, by1],
        }],
      };
    },

    dispose() {
      texture?.dispose();
      geometry.dispose();
      material.dispose();
    },
  };
}
