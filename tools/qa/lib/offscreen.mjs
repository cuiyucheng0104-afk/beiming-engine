// 北冥 QA · 离屏检查台：在 Node + Dawn 里直接加载作品目录的 offscreen.mjs，不启动无头浏览器，
// 提供与 lib/page.mjs 同构的 5 个接口（openOffscreen、sampleFramesOffscreen、fontInventoryOffscreen、screenshotSetOffscreen、samplePlatesOffscreen），
// 供 checks/texts.mjs 与 checks/plates.mjs 复用全部阈值、禁则、cmap 缺字、WCAG 对比度与面片密度判定逻辑。
import fs from 'node:fs';
import path from 'node:path';
import { QaError, EXIT, onCleanup } from './cli-kit.mjs';
import { encodePng } from '../../plates/png.mjs';

export function hasOffscreenEntry(dir) {
  return Boolean(dir && fs.existsSync(path.join(dir, 'offscreen.mjs')));
}

function wrapThreeRenderer(THREE, renderer, state) {
  if (!THREE || !renderer || typeof renderer.render !== 'function' || renderer.__bmqaOffscreen) return;
  renderer.__bmqaOffscreen = true;
  const orig = renderer.render;
  const v = new THREE.Vector4(), pv = new THREE.Matrix4();
  renderer.render = function (scene, camera, ...rest) {
    if (state.platesRec && scene && camera && camera.isCamera) {
      try {
        if (scene.matrixWorldAutoUpdate !== false) scene.updateMatrixWorld();
        if (camera.parent === null && camera.matrixWorldAutoUpdate !== false) camera.updateMatrixWorld();
        pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        scene.traverseVisible(o => {
          if (!o.isMesh || !o.geometry || o.geometry.type !== 'PlaneGeometry' || state.platesSeen.has(o.uuid)) return;
          const mat = Array.isArray(o.material) ? null : o.material;
          if (!mat || mat.visible === false || mat.colorWrite === false) return;
          const cropData = mat.userData?.crop || null;
          const map = cropData?.map || mat.map || null;
          const plateFile = map?.userData?.plateFile || null;
          const img = map?.image;
          if (!plateFile || !img || !(img.width > 0 && img.height > 0)) return;
          const g = o.geometry.parameters || {}, w = g.width ?? 1, h = g.height ?? 1;
          const corners = [[-w / 2, h / 2, 0, 1], [w / 2, h / 2, 1, 1], [-w / 2, -h / 2, 0, 0], [w / 2, -h / 2, 1, 0]];
          const clip = corners.map(([x, y]) => { v.set(x, y, 0, 1).applyMatrix4(o.matrixWorld).applyMatrix4(pv); return [v.x, v.y, v.z, v.w]; });
          let uv;
          if (cropData && cropData.rect?.value) {
            const r = cropData.rect.value;
            const flip = !!(cropData.flip && cropData.flip.value > 0.5);
            uv = corners.map(([, , s, t]) => { const q = flip ? 1 - s : s; return [r.x + q * r.z, r.y + t * r.w]; });
          } else {
            if (map.matrixAutoUpdate) map.updateMatrix();
            const e = map.matrix.elements;
            uv = corners.map(([, , s, t]) => [e[0] * s + e[3] * t + e[6], e[1] * s + e[4] * t + e[7]]);
          }
          const op = (mat.opacity ?? 1) * (cropData?.opacity ? cropData.opacity.value : 1);
          state.platesSeen.add(o.uuid);
          state.plates.push({
            file: plateFile,
            src: plateFile,
            iw: img.naturalWidth || img.width,
            ih: img.naturalHeight || img.height,
            flipY: map.flipY !== false,
            wrapS: map.wrapS === THREE.RepeatWrapping,
            wrapT: map.wrapT === THREE.RepeatWrapping,
            clip,
            uv,
            opacity: op,
            order: o.renderOrder,
            crop: cropData ? { soft: cropData.soft ? cropData.soft.value : 0.55 } : null,
            name: o.name || '',
          });
        });
      } catch (e) {
        state.platesErr = String((e && e.message) || e);
      }
    }
    return orig.call(this, scene, camera, ...rest);
  };
}

export async function openOffscreen({ root, pageDir, width, height, fps, film = null, shimThree = false }) {
  const relDir = path.relative(root, pageDir);
  if (relDir.startsWith('..') || path.isAbsolute(relDir)) {
    throw new QaError('usage.bad-value', `作品目录 ${pageDir} 不在仓库 ${root} 之内`, { exitCode: EXIT.USAGE });
  }
  const entry = path.join(pageDir, 'offscreen.mjs');
  if (!fs.existsSync(entry)) {
    throw new QaError('usage.bad-value', `${pageDir} 里没有 offscreen.mjs`, { exitCode: EXIT.USAGE });
  }

  let loadGpu, createHost, listRegisteredFonts, clearRegisteredFonts;
  try {
    ({ loadGpu } = await import('../../../engine/offscreen/load.mjs'));
    ({ createHost } = await import('../../../engine/offscreen/host.mjs'));
    ({ listRegisteredFonts, clearRegisteredFonts } = await import('../../../engine/offscreen/canvas.mjs'));
  } catch (e) {
    throw new QaError('env.offscreen', `无法加载离屏检查模块：${e.message}`, { exitCode: EXIT.ENV });
  }

  let host = null;
  const close = async () => {
    globalThis.__BMQA_OFFSCREEN = null;
    if (host) { const h = host; host = null; try { h.dispose(); } catch { /* 已销毁 */ } }
  };
  const unhook = onCleanup(close);

  try {
    let gpu;
    try {
      gpu = await loadGpu();
      host = await createHost({ gpu, width, height, fps });
    } catch (e) {
      throw new QaError('env.offscreen', `离屏宿主不可用：${e.message}`, {
        hint: e.hint || '在仓库根目录运行 npm install --include=optional --ignore-scripts 并确认 WebGPU 驱动可用',
        exitCode: EXIT.ENV,
      });
    }
    const state = { plates: [], platesSeen: new Set(), platesRec: false, platesErr: null };
    if (shimThree) wrapThreeRenderer(gpu.THREE, host.renderer, state);

    let work;
    try {
      clearRegisteredFonts();
      work = await host.load(entry);
    } catch (e) {
      if (String(e?.code || '').startsWith('env.')) {
        throw new QaError('env.offscreen', `离屏依赖不可用：${e.message}`, { hint: e.hint, exitCode: EXIT.ENV });
      }
      throw new QaError('offscreen.load', `offscreen.mjs 构建失败：${e.message}`, { exitCode: EXIT.RUNTIME });
    }

    const adapterInfo = host.device.adapterInfo ?? {};
    const gpuDesc = `Dawn WebGPU (${[adapterInfo.vendor, adapterInfo.architecture, adapterInfo.description].filter(Boolean).join(' ') || 'unknown'})`;
    const dur = work.dur ?? work.__module?.DUR ?? (film?.frameCount ? film.frameCount / fps : null);
    if (!(typeof dur === 'number' && Number.isFinite(dur) && dur > 0)) {
      throw new QaError('offscreen.contract', 'offscreen.mjs 未提供 dur 且缺少作品描述 frameCount', { exitCode: EXIT.GATE });
    }

    return {
      offscreen: true,
      host,
      work,
      state,
      listRegisteredFonts,
      width,
      height,
      fps,
      origin: 'offscreen://local',
      externalRequests: [],
      pageErrors: [],
      consoleErrors: [],
      three: shimThree ? (gpu.THREE.REVISION || 'r187') : null,
      platesErr: null,
      info: {
        dur,
        hasRender: true,
        hasTexts: typeof work.texts === 'function',
        gpu: gpuDesc,
        viewport: [width, height],
      },
      close: async () => { unhook(); await close(); },
    };
  } catch (e) {
    unhook();
    await close();
    throw e;
  }
}

export async function sampleFramesOffscreen(h, frames) {
  const out = [];
  const qa = { rec: false, hide: false, runs: [] };
  globalThis.__BMQA_OFFSCREEN = qa;
  try {
    for (const f of frames) {
      qa.runs = [];
      qa.rec = true;
      try {
        h.host.stepFrame(h.work, f);
      } catch (e) {
        qa.rec = false;
        throw new QaError('offscreen.render', `offscreen render(${f}) 抛错：${e.message}`, { exitCode: EXIT.RUNTIME });
      }
      qa.rec = false;
      let texts = null, textsError = null;
      if (typeof h.work.texts === 'function') {
        try {
          texts = h.work.texts(f);
          if (texts && typeof texts.then === 'function') texts = await texts;
        } catch (e) {
          textsError = String((e && e.message) || e);
        }
        if (texts != null && !Array.isArray(texts)) {
          textsError = `texts(f) 应返回数组，收到 ${typeof texts}`;
          texts = null;
        } else if (texts) {
          texts = JSON.parse(JSON.stringify(texts));
        }
      }
      out.push({ f, texts, textsError, runs: [...qa.runs], dom: [] });
    }
  } finally {
    globalThis.__BMQA_OFFSCREEN = null;
  }
  return out;
}

export async function fontInventoryOffscreen(h) {
  const list = h.listRegisteredFonts ? h.listRegisteredFonts() : [];
  const faces = [];
  const set = [];
  const errors = [];
  for (const item of list) {
    let bin = null;
    try { bin = fs.readFileSync(item.file).toString('base64'); }
    catch (e) { errors.push(`读不到已注册字体文件 ${item.file}：${e.message}`); }
    faces.push({
      origin: 'offscreen',
      family: item.family,
      src: item.file,
      base: null,
      bin,
      weight: item.weight || '400',
      style: item.style || 'normal',
      unicodeRange: item.unicodeRange || '',
      status: 'loaded',
    });
    set.push({
      family: item.family,
      weight: item.weight || '400',
      style: item.style || 'normal',
      unicodeRange: item.unicodeRange || '',
      status: 'loaded',
    });
  }
  return { faces, set, errors };
}

export async function screenshotSetOffscreen(h, f) {
  const shot = async mode => {
    globalThis.__BMQA_OFFSCREEN = { rec: false, hide: mode, runs: [] };
    const px = await h.host.renderFrame(h.work, f);
    const opaque = Uint8Array.from(px);
    for (let i = 3; i < opaque.length; i += 4) opaque[i] = 255;
    return encodePng({ width: h.width, height: h.height, data: opaque, channels: 4 });
  };
  try {
    return { on: await shot(false), text: await shot('text'), layer: await shot('layer') };
  } finally {
    globalThis.__BMQA_OFFSCREEN = null;
  }
}

export async function samplePlatesOffscreen(h, frames) {
  const out = [];
  for (const f of frames) {
    h.state.plates = [];
    h.state.platesSeen = new Set();
    h.state.platesRec = true;
    try {
      h.host.stepFrame(h.work, f);
    } catch (e) {
      h.state.platesRec = false;
      throw new QaError('offscreen.render', `offscreen render(${f}) 抛错：${e.message}`, { exitCode: EXIT.RUNTIME });
    }
    h.state.platesRec = false;
    out.push({ f, plates: [...h.state.plates] });
  }
  h.platesErr = h.state.platesErr;
  return out;
}
