// 北冥引擎 · 物理路径追踪确定性场景 SDK 主入口（D 路线 · 北冥光追，决定 D13）
//
// 职责：统一导出场景定义器 definePathtraceFilm、视锥贴合与屏幕投影工具（camera.js）以及防冲灰三维晶片 HUD
// 工具（hud.js）。definePathtraceFilm 强制采用纯帧号无状态求值（evaluation: "absolute"），在 QuickJS
// `threert-render serve` 模式下读取 `state.frame` 与 `state.hideTexts` 驱动每一帧场景，在 Node probe 模式下
// 暴露 `probeFilm({ film, width, height, fps })` 提取全片逐帧文字安全区包围盒与时间轴元数据。
// 本模块为纯 ESM JavaScript（配套 index.d.ts），无需 --experimental-strip-types 即可在任意 Node 22.0+ 直接导入。
//
// 导出接口：
//   definePathtraceFilm(factory)   包装作品 scene.ts 工厂函数，返回兼容 QuickJS GameDefinition 与 Node probeFilm 的描述体
//   以及 camera.js 与 hud.js 的全部公共函数与常量。
//
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine

import { frameSeed } from './camera.js';

export {
  MAX_WAFER_THICKNESS_M,
  frameSeed,
  placeInCameraFrustum,
  projectBoxToPixels,
} from './camera.js';

export {
  HUD_FONT_STACK,
  HUD_LIVE_ATLAS_SHADER,
  HUD_LIVE_ATLAS_WGSL,
  HUD_WAFER_SHADER,
  WAFER_HUD_WGSL,
  createLiveAtlasHudMaterial,
  createWaferHudMaterial,
  enforceWaferThickness,
} from './hud.js';

function resolveBootSpec(override) {
  const boot = globalThis.__BEIMING_FILM_BOOT__ ?? {};

  const film = override?.film ?? boot.film ?? {};
  const out = film.output ?? {};
  const size = Array.isArray(film.size) ? film.size : undefined;

  const width = Math.max(1, Math.trunc(override?.width ?? boot.width ?? out.width ?? size?.[0] ?? 1920));
  const height = Math.max(1, Math.trunc(override?.height ?? boot.height ?? out.height ?? size?.[1] ?? 1080));
  const fps = Math.max(1, Math.trunc(override?.fps ?? boot.fps ?? out.fps ?? film.fps ?? 24));
  const rawFrameCount = out.frameCount
    ?? (typeof film.dur === 'number' && film.dur > 0 ? Math.round(film.dur * fps) : undefined)
    ?? (Array.isArray(film.shots) && film.shots.length ? film.shots[film.shots.length - 1].out : undefined)
    ?? fps;
  const frameCount = Math.max(1, Math.trunc(rawFrameCount));
  const seed = Number.isFinite(film.pathtrace?.seed) ? Math.trunc(film.pathtrace.seed) : 2026;
  const preset = typeof film.pathtrace?.preset === 'string' && film.pathtrace.preset
    ? film.pathtrace.preset
    : 'cinematic';

  const rawShots = Array.isArray(film.shots) && film.shots.length
    ? film.shots
    : [{ id: 'S01', in: 0, out: frameCount }];
  const shots = rawShots.map((s, idx) => {
    const sIn = Math.max(0, Math.trunc(s.in));
    const sOut = Math.max(sIn + 1, Math.trunc(s.out));
    return {
      id: String(s.id || `S${String(idx + 1).padStart(2, '0')}`),
      in: sIn,
      out: sOut,
      index: idx,
      length: sOut - sIn,
    };
  });

  return { width, height, fps, frameCount, seed, preset, shots, film };
}

function findShotAt(shots, frame) {
  let lo = 0;
  let hi = shots.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = shots[mid];
    if (frame < s.in) hi = mid - 1;
    else if (frame >= s.out) lo = mid + 1;
    else return s;
  }
  return frame < shots[0].in ? shots[0] : shots[shots.length - 1];
}

function makeFrameContext(meta, rawFrame, hideTexts) {
  const clamped = Math.min(meta.frameCount - 1, Math.max(0, Math.round(rawFrame)));
  const shotInfo = findShotAt(meta.shots, clamped);
  const localFrame = clamped - shotInfo.in;
  return {
    frame: clamped,
    t: clamped / meta.fps,
    fps: meta.fps,
    width: meta.width,
    height: meta.height,
    frameCount: meta.frameCount,
    shot: shotInfo.id,
    shotInfo,
    localFrame,
    localT: localFrame / meta.fps,
    shotProgress: localFrame / Math.max(1, shotInfo.length),
    hideTexts,
    seed: frameSeed(meta.seed, clamped),
  };
}

function normalizeTextItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = String(raw.text ?? '');
  if (!text.trim()) return null;
  if (!Array.isArray(raw.box) || raw.box.length !== 4 || !raw.box.every(Number.isFinite)) {
    throw new TypeError(`textsAt 条目「${text}」的 box 必须是 4 个有限数字 [x, y, w, h]`);
  }
  const box = [
    +Number(raw.box[0]).toFixed(3),
    +Number(raw.box[1]).toFixed(3),
    +Number(raw.box[2]).toFixed(3),
    +Number(raw.box[3]).toFixed(3),
  ];
  const alpha = Number.isFinite(raw.alpha) ? Math.min(1, Math.max(0, Number(raw.alpha))) : 1;
  const font = typeof raw.font === 'string' && raw.font.trim() ? raw.font.trim() : null;
  const id = raw.id != null && String(raw.id).trim() ? String(raw.id).trim() : text;
  return { id, text, box, alpha, font };
}

/**
 * 定义一部确定性物理路径追踪短片（evaluation: "absolute"）。
 * 导出值既可直接作为 QuickJS `threert-render serve` 的 GameDefinition 运行，
 * 也可在 Node 阶段调用 `.probeFilm({ film, width, height, fps })` 提取全片逐帧文字包围盒。
 */
export function definePathtraceFilm(factory) {
  if (typeof factory !== 'function') {
    throw new TypeError('definePathtraceFilm: 参数必须是工厂函数 ({ width, height, fps, film }) => { scene, camera, renderFrame, textsAt? }');
  }

  let activeMeta = null;
  let activeInstance = null;

  const createInstance = override => {
    const meta = resolveBootSpec(override);
    const instance = factory({
      width: meta.width,
      height: meta.height,
      fps: meta.fps,
      frameCount: meta.frameCount,
      seed: meta.seed,
      film: meta.film,
    });
    if (!instance || !instance.scene || !instance.camera || typeof instance.renderFrame !== 'function') {
      throw new TypeError('definePathtraceFilm: factory 必须返回 { scene, camera, renderFrame(frame, ctx), textsAt?(frame, ctx) }');
    }
    return { meta, instance };
  };

  const bootMeta = resolveBootSpec();

  const definition = {
    __beimingPathtraceFilm: true,
    evaluation: 'absolute',
    seed: bootMeta.seed,
    state: { frame: 0, hideTexts: false },
    handlers: {
      set(tx, payload) {
        if (payload && typeof payload.frame === 'number' && Number.isFinite(payload.frame)) {
          tx.set('frame', Math.trunc(payload.frame));
        }
        if (payload && typeof payload.hideTexts === 'boolean') {
          tx.set('hideTexts', payload.hideTexts);
        }
      },
    },
    setup(setupCtx) {
      const built = createInstance();
      if (setupCtx && typeof setupCtx.seed === 'number' && Number.isFinite(setupCtx.seed)) {
        built.meta.seed = Math.trunc(setupCtx.seed);
      }
      activeMeta = built.meta;
      activeInstance = built.instance;
      const ctx0 = makeFrameContext(activeMeta, 0, false);
      activeInstance.renderFrame(0, ctx0);
      return {
        scene: activeInstance.scene,
        camera: activeInstance.camera,
        options: {
          name: String(activeMeta.film.id || setupCtx?.roomId || 'beiming-pathtrace'),
          preset: activeMeta.preset,
          width: activeMeta.width,
          height: activeMeta.height,
          ...(activeInstance.options ?? {}),
        },
      };
    },
    frame(f) {
      if (!activeMeta || !activeInstance) return;
      const hasExplicitFrame = typeof f.state?.frame === 'number' && Number.isFinite(f.state.frame);
      const rawFrame = hasExplicitFrame ? f.state.frame : Math.round((f.time || 0) * activeMeta.fps);
      const hideTexts = Boolean(f.state?.hideTexts);
      const ctx = makeFrameContext(activeMeta, rawFrame, hideTexts);
      activeInstance.renderFrame(ctx.frame, ctx);
    },
    createInstance,
    probeFilm(override) {
      const { meta, instance } = createInstance(override);
      const frames = [];
      const trackMap = new Map();

      for (let f = 0; f < meta.frameCount; f++) {
        const ctx = makeFrameContext(meta, f, false);
        instance.renderFrame(f, ctx);
        const rawItems = typeof instance.textsAt === 'function' ? (instance.textsAt(f, ctx) ?? []) : [];
        const items = rawItems
          .map(normalizeTextItem)
          .filter(x => x !== null && x.alpha > 0);

        frames.push({
          frame: f,
          t: +(f / meta.fps).toFixed(6),
          shot: ctx.shot,
          items,
        });

        for (const it of items) {
          const key = `${it.id}\u0000${it.text}`;
          const cur = trackMap.get(key);
          if (!cur) {
            trackMap.set(key, {
              id: it.id,
              text: it.text,
              firstFrame: f,
              lastFrame: f,
              frameCount: 1,
              peakFrame: f,
              peakAlpha: it.alpha,
              peakBox: it.box,
              font: it.font,
            });
          } else {
            cur.lastFrame = f;
            cur.frameCount += 1;
            if (it.alpha > cur.peakAlpha) {
              cur.peakAlpha = it.alpha;
              cur.peakFrame = f;
              cur.peakBox = it.box;
            }
            if (!cur.font && it.font) cur.font = it.font;
          }
        }
      }

      return {
        evaluation: 'absolute',
        width: meta.width,
        height: meta.height,
        fps: meta.fps,
        frameCount: meta.frameCount,
        seed: meta.seed,
        frames,
        summary: [...trackMap.values()],
      };
    },
  };

  return definition;
}
