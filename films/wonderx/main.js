// WonderX Phase 2 v4 · 十幕离线交互三维演示主入口（WebGL2 + Three.js 0.170.0）
// 零纸雕、零旧纸纹（paper: false）、实时 3D 渲染、原生 2D HUD、三轨相位锁定配乐、
// 6 条 MIT 程序化拟音、可选 AI 中文导览（默认关闭）、完整离线许可弹窗与 H4/H5b 真机基准探针。
import * as THREE from 'three';
import { pageTiming } from '../../engine/production/timeline.js';
import { createLook } from '../../engine/look/index.js';
import { DARK_STAGE } from '../../engine/look/stage.js';
import { loadFilmFonts } from '../../engine/style/fonts.js';
import { loadStyle, resolveLook, setStyleJsonLoader } from '../../engine/style/index.js';
import { createDeck, createDeckModel, TIER_CONFIGS } from '../../engine/stage/deck.js';
import { createDeckAudio } from '../../engine/stage/deck-audio.js';
import { createDeckUI } from '../../engine/stage/deck-ui.js';
import { PALETTE, createBrushedMetalTexture, createGridFloorTexture, clamp } from './scenes/shared.js';
import { createActs01to04 } from './scenes/acts_01_04.js';
import { createAct05Tsunami, ACT05_FORMATIONS, ACT05_TIER_COUNTS } from './scenes/act05_tsunami.js';
import { createActs06to10, ACT07_STYLES } from './scenes/acts_06_10.js';
import { drawHud } from './hud.js';

function decodeBase64ToArrayBuffer(dataUri) {
  const idx = dataUri.indexOf(',');
  const b64 = idx >= 0 ? dataUri.slice(idx + 1) : dataUri;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function decodeAudioSilently(arrayBuffer, fallbackCtx) {
  // 优先用 OfflineAudioContext 静默解码，绝不提前唤醒硬件 AudioContext（严格保冷静音）
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (OfflineCtx) {
    try {
      const off = new OfflineCtx(2, 1, 48000);
      return await off.decodeAudioData(arrayBuffer.slice(0));
    } catch {}
  }
  if (fallbackCtx) return await fallbackCtx.decodeAudioData(arrayBuffer.slice(0));
  return null;
}

async function boot() {
  const embedded = window.__WX_ASSETS;
  const asset = p => (embedded && embedded[p]) ? embedded[p] : new URL(p, document.baseURI).href;
  const film = embedded?.film ?? await (await fetch(asset('film.json'))).json();
  if (embedded) setStyleJsonLoader(name => embedded.styles[name]);

  const timing = pageTiming(film);
  const style = await loadStyle(film.style);
  const fonts = await loadFilmFonts(
    new URL('fonts/', document.baseURI),
    embedded ? { manifest: embedded.manifest, resolve: name => asset(`fonts/${name}`) } : {}
  );
  for (const text of film.texts) fonts.assert(text.font, text.text, text.id);

  const stage = document.querySelector('#stage');
  const overlay = document.querySelector('#label');
  const statusEl = document.querySelector('#status');
  const actBar = document.querySelector('#act-bar');
  const glassWrap = document.querySelector('#glass-wrap');
  const glassCard = document.querySelector('#glass-card');
  const licModal = document.querySelector('#license-modal');
  const licBody = document.querySelector('#license-body');

  const renderer = new THREE.WebGLRenderer({
    canvas: stage,
    antialias: false,
    alpha: false,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  renderer.shadowMap.enabled = false;

  // 主 3D 场景与舞台灯光（黑曜暗场 + 冷白主光 + 冰青轮缘 + 朱红/暖金补光）
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PALETTE.obsidian);
  scene.fog = new THREE.FogExp2(PALETTE.obsidian, 0.022);
  const camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.1, 160);

  const ambLight = new THREE.AmbientLight(0x9fb5d8, 0.55);
  const keyLight = new THREE.DirectionalLight(0xeef5ff, 2.2);
  keyLight.position.set(5, 8, 6);
  const rimLight = new THREE.PointLight(0x4ce0f5, 34, 28, 1.6);
  rimLight.position.set(-6, 3.5, 4);
  const fillLight = new THREE.PointLight(0xd2452c, 24, 26, 1.6);
  fillLight.position.set(6, -1.5, 5);
  scene.add(ambLight, keyLight, rimLight, fillLight);

  // 构建 10 幕纯程序化 3D 世界（零纸雕、零旧纸纹、零外部图片依赖）
  const brushedTex = createBrushedMetalTexture(20261127);
  const gridTex = createGridFloorTexture();
  const acts0104 = createActs01to04(brushedTex, gridTex);
  const act05 = createAct05Tsunami();
  const acts0610 = createActs06to10(brushedTex, gridTex);
  const scenes = { ...acts0104, A05: act05, ...acts0610 };
  for (const act of Object.values(scenes)) {
    act.group.visible = false;
    scene.add(act.group);
  }

  const preset = resolveLook(style, 'wide');
  const ctx2d = overlay.getContext('2d');
  const model = createDeckModel({ shots: film.shots, events: film.events, fps: timing.fps, dur: timing.DUR });
  const shotSpec = new Map(film.shots.map(s => [s.id, s]));
  const copy = new Map(film.texts.map(x => [x.id, x]));

  const bench = new URLSearchParams(location.search).has('bench');
  const interactive = !bench && !window.__RENDER;

  // 各幕交互覆盖态（仅互动态或显式 input 生效，保证 window.render(t, input) 严格确定性）
  const uiState = {
    explode: null,
    formation: null,
    shock: 0,
    styleIndex: null,
    quad: null,
    scrub: null,
    camLock: false,
    split: 0.5,
    lastPointer: [0.5, 0.5],
    lastActId: '',
  };

  let look = null;
  let lastTier = null;
  let lastW = 0;
  let lastH = 0;
  let rows = [];
  let lost = false;

  function size(tier) {
    const root = stage.parentElement;
    const cfg = TIER_CONFIGS[tier] ?? TIER_CONFIGS.full;
    const w = window.__RENDER?.width ?? Math.max(2, Math.min(1920, Math.round(root.clientWidth || 1920)));
    const h = window.__RENDER?.height ?? Math.round(w * 9 / 16);
    if (tier === lastTier && w === lastW && h === lastH) return;
    const rw = Math.max(2, Math.round(w * cfg.renderScale));
    const rh = Math.max(2, Math.round(h * cfg.renderScale));
    renderer.setSize(rw, rh, false);
    if (!look || TIER_CONFIGS[lastTier]?.msaa !== cfg.msaa) {
      look?.dispose();
      // WonderX 全程 outline:false，不需要 2x 墨线超采样缓冲（4K 下可省 600MB+ 显存）
      look = createLook(renderer, rw, rh, { ss: 1, msaa: cfg.msaa, defaults: preset.defaults, fps: timing.fps });
    } else {
      look.setSize(rw, rh);
    }
    overlay.width = w;
    overlay.height = h;
    lastTier = tier;
    lastW = w;
    lastH = h;
  }

  // Act 07 2×2 四宇宙同屏视口渲染（同一份 BufferGeometry + 4 套 GLSL）
  function renderAct07Quad() {
    const buf = new THREE.Vector2();
    renderer.getDrawingBufferSize(buf);
    const rw = buf.x;
    const rh = buf.y;
    const hw = Math.floor(rw / 2);
    const hh = Math.floor(rh / 2);

    const cells = [
      { idx: 0, x: 0, y: hh, w: hw, h: rh - hh },
      { idx: 1, x: hw, y: hh, w: rw - hw, h: rh - hh },
      { idx: 2, x: 0, y: 0, w: hw, h: hh },
      { idx: 3, x: hw, y: 0, w: rw - hw, h: hh },
    ];
    renderer.setRenderTarget(null);
    renderer.setScissorTest(true);
    camera.aspect = (hw / Math.max(1, hh));
    camera.updateProjectionMatrix();

    for (const c of cells) {
      renderer.setViewport(c.x, c.y, c.w, c.h);
      renderer.setScissor(c.x, c.y, c.w, c.h);
      renderer.setClearColor(ACT07_STYLES[c.idx].bg, 1);
      renderer.clear(true, true, true);
      acts0610.A07.quadMesh.material = acts0610.A07.materials[c.idx];
      renderer.render(acts0610.A07.quadScene, camera);
    }
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, rw, rh);
    camera.aspect = 16 / 9;
    camera.updateProjectionMatrix();
  }

  let lastSceneState = null;

  function render(t, input = {}) {
    if (lost) return;
    const tier = input.tier ?? 'full';
    const cfg = TIER_CONFIGS[tier] ?? TIER_CONFIGS.full;
    size(tier);

    const { shot: id, localFrame } = timing.at(t);
    const shot = shotSpec.get(id) ?? film.shots[0];
    const progress = clamp(localFrame / Math.max(1, shot.out - shot.in), 0, 1);
    const pointer = input.pointer ?? [0.5, 0.5];
    uiState.lastPointer = pointer;

    const merged = {
      tier,
      explode: input.explode !== undefined ? input.explode : (interactive ? uiState.explode : null),
      formation: input.formation !== undefined ? input.formation : (interactive ? uiState.formation : null),
      shock: input.shock !== undefined ? input.shock : (interactive ? uiState.shock : 0),
      styleIndex: input.styleIndex !== undefined ? input.styleIndex : (interactive ? uiState.styleIndex : null),
      quad: input.quad !== undefined ? input.quad : (interactive ? uiState.quad : null),
      scrub: input.scrub !== undefined ? input.scrub : (interactive ? uiState.scrub : null),
      camLock: input.camLock !== undefined ? input.camLock : (interactive ? uiState.camLock : false),
    };
    const split = input.split !== undefined ? clamp(input.split, 0, 1) : (interactive ? uiState.split : 0.5);

    for (const [k, act] of Object.entries(scenes)) {
      act.group.visible = (k === id);
    }

    const activeAct = scenes[id];
    const st = activeAct.update(progress, t, pointer, merged, camera);
    lastSceneState = st;

    camera.position.set(st.cameraPos[0], st.cameraPos[1], st.cameraPos[2]);
    camera.fov = st.fov ?? 42;
    camera.aspect = 16 / 9;
    camera.updateProjectionMatrix();
    camera.lookAt(st.cameraLook[0], st.cameraLook[1], st.cameraLook[2]);
    camera.updateMatrixWorld(true);

    if (st.stageLights) {
      keyLight.position.set(...st.stageLights.keyPos);
      keyLight.color.setHex(st.stageLights.keyColor);
      rimLight.color.setHex(st.stageLights.rimColor);
      fillLight.color.setHex(st.stageLights.fillColor);
    }

    if (id === 'A07' && st.quadMode) {
      renderAct07Quad();
    } else {
      const bgHex = (id === 'A07' && st.bgHex != null) ? st.bgHex : 0x07080b;
      scene.background.setHex(bgHex);
      if (scene.fog) scene.fog.color.setHex(bgHex);
      // 严禁旧纸纹与油画糊边：paper: false, kuwahara: false, outline: false
      const params = {
        ...preset.params,
        ...DARK_STAGE,
        t,
        fog: false,
        outline: false,
        kuwahara: false,
        paper: false,
        grain: 0.006,
        bloom: cfg.bloom ? { ...DARK_STAGE.bloom, threshold: 0.72, strength: 0.32, radius: 0.36 } : false,
      };
      look.render(scene, camera, params);
    }

    drawHud(ctx2d, overlay, {
      id,
      progress,
      t,
      copy,
      sceneState: st,
      split,
      tier,
      interactive,
      pointer,
      rows,
    });

    if (interactive) {
      syncInteractiveOverlays(id, progress, pointer, st);
    }
  }

  // ── 音频与 6 条 MIT 程序化拟音（冷静音安全 + 可选 AI 导览默认关） ──
  const audio = createDeckAudio();
  const sfxBuffers = new Map();
  let sfxCtx = null;
  let audioManifest = null;
  let audioPrepared = false;

  function unlockAudioOnGesture() {
    const c = audio.ensureContext();
    if (c) sfxCtx = c;
  }

  function triggerSfx(id, gainScale = 0.72) {
    if (!interactive) return;
    if (model.getSnapshot().muted) return;
    const ctx = sfxCtx;
    if (!ctx || ctx.state !== 'running') return;
    const buf = sfxBuffers.get(id);
    if (!buf) return;
    try {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      g.gain.value = gainScale;
      src.connect(g);
      g.connect(ctx.destination);
      src.start();
    } catch {}
  }

  async function prepareAudio() {
    if (audioPrepared) return { stems: audio.getStemsState().length, sfx: sfxBuffers.size };
    audioPrepared = true;
    try {
      if (embedded?.audioManifest) {
        audioManifest = embedded.audioManifest;
      } else {
        const res = await fetch(asset('audio/manifest.json'));
        if (res.ok) audioManifest = await res.json();
      }
      if (!audioManifest?.assets?.length) return { stems: 0, sfx: 0 };

      const voList = [];
      for (const item of audioManifest.assets) {
        let ab = null;
        if (embedded && embedded[item.key]) {
          ab = decodeBase64ToArrayBuffer(embedded[item.key]);
        } else {
          const url = asset(`audio/${item.file}`);
          const resp = await fetch(url);
          if (resp.ok) ab = await resp.arrayBuffer();
        }
        if (!ab) continue;
        const buf = await decodeAudioSilently(ab, audio.ctx);
        if (!buf) continue;
        if (item.kind === 'audio_stem') {
          audio.setStem(item.id, { name: item.name, buffer: buf, volume: item.id === 'pad' ? 0.86 : 0.92 });
        } else if (item.kind === 'audio_sfx') {
          sfxBuffers.set(item.id, buf);
        } else if (item.kind === 'audio_vo_ai') {
          voList.push({ at: item.at, buffer: buf, id: item.id, text: item.text });
        }
      }
      if (voList.length) audio.setVoCues(voList);
      // 以状态机为唯一真相源：默认 voEnabled=false，但若用户在异步解码完成前已按 V/M，绝不覆写
      const snapNow = model.getSnapshot();
      audio.setVoEnabled(snapNow.voEnabled);
      audio.setMasterMute(snapNow.muted);
      return { stems: audio.getStemsState().length, sfx: sfxBuffers.size, vo: voList.length };
    } catch (err) {
      console.warn('[WonderX] 音频解码跳过：', err?.message ?? err);
      return { stems: 0, sfx: 0, vo: 0 };
    }
  }

  // ── 演示壳与 UI ──
  const ui = createDeckUI({ model }, audio, {
    ink: PALETTE.obsidian,
    paper: PALETTE.porcelain,
    cinnabar: PALETTE.vermilion,
    warm: PALETTE.warmTungsten,
    grey: PALETTE.titaniumLight,
    fonts: { sans: '"WX Sans", "WX Text", sans-serif', serif: '"WX Serif", "WX Display", serif' },
    stems: { pad: '和声声场', pulse: '脉冲节律', lead: '主奏光束' },
    voName: '导览配音（AI 合成 · 默认关）',
  });
  const deck = createDeck({ root: stage.parentElement, model, audio, ui, onRender: render });
  if (!interactive) {
    ui.el.style.display = 'none';
    actBar.style.display = 'none';
    glassWrap.style.display = 'none';
  } else {
    // 顶部进度条点击直达定位（不改共享 deck-ui.js）
    const scrubHit = document.createElement('div');
    scrubHit.setAttribute('aria-label', '点击定位时间轴');
    scrubHit.style.cssText = 'position:fixed;top:0;left:0;right:0;height:14px;z-index:150;cursor:pointer;';
    scrubHit.addEventListener('pointerdown', e => {
      e.stopPropagation();
      unlockAudioOnGesture();
      const u = clamp(e.clientX / Math.max(1, window.innerWidth), 0, 1);
      const totalFrames = film.output?.frameCount ?? Math.round(timing.dur * timing.fps);
      model.seekFrame(Math.round(u * totalFrames));
    });
    document.body.appendChild(scrubHit);
  }

  // ── 各幕专属交互控件栏 + Act 10 12° 光学玻璃倾斜卡 + 开源许可与溯源弹窗 ──
  let barActId = '';
  let barVoOn = false;
  let shockDecayRaf = 0;

  function fireAct05Shock() {
    uiState.shock = 0.02;
    triggerSfx('sfx_quantum_surge', 0.65);
    const step = () => {
      uiState.shock = Math.min(1, uiState.shock + 0.04);
      if (uiState.shock < 1) {
        shockDecayRaf = requestAnimationFrame(step);
      } else {
        uiState.shock = 0;
        shockDecayRaf = 0;
      }
    };
    if (!shockDecayRaf) shockDecayRaf = requestAnimationFrame(step);
  }

  function buildActBar(id, st) {
    if (!interactive) return;
    barActId = id;
    const voOn = model.getSnapshot().voEnabled;
    barVoOn = voOn;
    let extra = '';
    if (id === 'A03') {
      const pct = Math.round(((uiState.explode ?? st?.explodeValue ?? 0.65) * 100));
      extra = `
        <label class="wx-ctl">爆炸拆解 <input id="ctl-explode" type="range" min="0" max="100" value="${pct}"><span id="ctl-explode-v">${pct}%</span></label>
        <button class="wx-btn" data-act="explode-reset">自动时间轴</button>
      `;
    } else if (id === 'A05') {
      const fIdx = uiState.formation ?? st?.activeFormation ?? 0;
      extra = ACT05_FORMATIONS.map(f =>
        `<button class="wx-btn ${fIdx === f.id ? 'on' : ''}" data-form="${f.id}">${f.name}</button>`
      ).join('') + `<button class="wx-btn accent" data-act="shock">电磁脉冲</button>`;
    } else if (id === 'A07') {
      const sIdx = uiState.styleIndex ?? st?.styleIndex ?? 0;
      const qOn = uiState.quad ?? st?.quadMode ?? false;
      extra = ACT07_STYLES.map(s =>
        `<button class="wx-btn ${!qOn && sIdx === s.id ? 'on' : ''}" data-style="${s.id}">${s.id + 1}. ${s.name}</button>`
      ).join('') + `<button class="wx-btn accent ${qOn ? 'on' : ''}" data-act="quad">2×2 四格矩阵 (G)</button>`;
    } else if (id === 'A08') {
      const pct = Math.round(((uiState.scrub ?? st?.scrubValue ?? 0.5) * 100));
      extra = `
        <label class="wx-ctl">时间轴预览 <input id="ctl-scrub" type="range" min="0" max="100" value="${pct}"><span id="ctl-scrub-v">${pct}%</span></label>
        <button class="wx-btn ${uiState.camLock ? 'on' : ''}" data-act="camlock">${uiState.camLock ? '已锁定电影机位' : '自由交互机位 / 锁定电影'}</button>
      `;
    } else if (id === 'A09') {
      const pct = Math.round(model.getSnapshot().splitRatio * 100);
      extra = `
        <label class="wx-ctl">朱红分屏 <input id="ctl-split" type="range" min="0" max="100" value="${pct}"><span id="ctl-split-v">${pct}%</span></label>
        <button class="wx-btn" data-split="0">0%</button>
        <button class="wx-btn" data-split="0.5">50%</button>
        <button class="wx-btn" data-split="1">100%</button>
      `;
    }

    actBar.innerHTML = `
      ${extra}
      <span class="wx-sep"></span>
      <button class="wx-btn ${voOn ? 'on' : ''}" data-act="toggle-vo" title="可选中文导览配音（VoxCPM2 AI 合成，默认关闭）">AI 导览：${voOn ? '开' : '关'} (V)</button>
      <button class="wx-btn" data-act="open-license" title="查看开源许可、CC0 采样与 AI 内容声明">许可与溯源 (L)</button>
    `;
  }

  function syncInteractiveOverlays(id, progress, pointer, st) {
    if (id !== uiState.lastActId) {
      uiState.lastActId = id;
      if (id === 'A02') triggerSfx('sfx_laser_cut', 0.65);
      else if (id === 'A03') triggerSfx('sfx_mech_explode', 0.6);
      else if (id === 'A04') triggerSfx('sfx_prism_chime', 0.65);
      else if (id === 'A05') triggerSfx('sfx_quantum_surge', 0.6);
      else if (id === 'A06') triggerSfx('sfx_portal_whoosh', 0.65);
      buildActBar(id, st);
    } else if (barActId !== id || barVoOn !== model.getSnapshot().voEnabled) {
      buildActBar(id, st);
    }

    const showGlass = id === 'A10' && progress >= 0.66;
    glassWrap.style.display = showGlass ? 'flex' : 'none';
    if (showGlass) {
      const rx = clamp((0.5 - pointer[1]) * 24, -12, 12);
      const ry = clamp((pointer[0] - 0.5) * 24, -12, 12);
      glassCard.style.transform = `perspective(1200px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)`;
    }
  }

  actBar.addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    e.stopPropagation();
    unlockAudioOnGesture();
    if (btn.dataset.form != null) {
      uiState.formation = Number(btn.dataset.form);
      fireAct05Shock();
      buildActBar('A05', lastSceneState);
    } else if (btn.dataset.act === 'shock') {
      fireAct05Shock();
    } else if (btn.dataset.act === 'explode-reset') {
      uiState.explode = null;
      buildActBar('A03', lastSceneState);
    } else if (btn.dataset.style != null) {
      uiState.quad = false;
      uiState.styleIndex = Number(btn.dataset.style);
      triggerSfx('sfx_shader_snap', 0.72);
      const snap = model.getSnapshot();
      render(snap.time, { tier: snap.tier, pointer: uiState.lastPointer, split: snap.splitRatio });
      buildActBar('A07', lastSceneState);
    } else if (btn.dataset.act === 'quad') {
      uiState.quad = !(uiState.quad ?? lastSceneState?.quadMode ?? false);
      triggerSfx('sfx_shader_snap', 0.72);
      const snap = model.getSnapshot();
      render(snap.time, { tier: snap.tier, pointer: uiState.lastPointer, split: snap.splitRatio });
      buildActBar('A07', lastSceneState);
    } else if (btn.dataset.act === 'camlock') {
      uiState.camLock = !uiState.camLock;
      triggerSfx('sfx_shader_snap', 0.55);
      buildActBar('A08', lastSceneState);
    } else if (btn.dataset.split != null) {
      uiState.split = clamp(Number(btn.dataset.split), 0, 1);
      model.setSplit(uiState.split);
      buildActBar('A09', lastSceneState);
    } else if (btn.dataset.act === 'toggle-vo') {
      unlockAudioOnGesture();
      const on = model.toggleVo();
      audio.setVoEnabled(on);
      ui.toast(on ? '已开启导览配音（VoxCPM2 AI 合成）' : '已关闭导览配音');
      buildActBar(uiState.lastActId || 'A01', lastSceneState);
    } else if (btn.dataset.act === 'open-license') {
      openLicenseModal();
    }
    btn.blur?.();
  });

  actBar.addEventListener('input', e => {
    const tEl = e.target;
    e.stopPropagation();
    if (tEl.id === 'ctl-explode') {
      uiState.explode = Number(tEl.value) / 100;
      const v = actBar.querySelector('#ctl-explode-v');
      if (v) v.textContent = `${tEl.value}%`;
    } else if (tEl.id === 'ctl-scrub') {
      uiState.scrub = Number(tEl.value) / 100;
      const v = actBar.querySelector('#ctl-scrub-v');
      if (v) v.textContent = `${tEl.value}%`;
    } else if (tEl.id === 'ctl-split') {
      uiState.split = Number(tEl.value) / 100;
      model.setSplit(uiState.split);
      const v = actBar.querySelector('#ctl-split-v');
      if (v) v.textContent = `${tEl.value}%`;
    }
  });

  let draggingSplit = false;
  let stageClick = null;
  const isDeckModalOpen = () => !!ui?.el?.shadowRoot?.querySelector('.modal.on');

  stage.parentElement.addEventListener('pointerdown', e => {
    if (!interactive) return;
    if (e.target.closest('#act-bar, #license-modal, #glass-card, .bne-deck-ui, button, input, a, label')) return;
    if (licModal.style.display === 'flex' || isDeckModalOpen()) return;
    unlockAudioOnGesture();
    const snap = model.getSnapshot();
    const curId = film.shots[snap.chapterIndex]?.id;
    if (curId === 'A09') {
      stageClick = null;
      const rect = stage.getBoundingClientRect();
      const u = clamp((e.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
      draggingSplit = true;
      uiState.split = u;
      model.setSplit(u);
      buildActBar('A09', lastSceneState);
    } else {
      if (curId === 'A05') fireAct05Shock();
      stageClick = (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey)
        ? { id: e.pointerId, x: e.clientX, y: e.clientY }
        : null;
    }
  });
  window.addEventListener('pointermove', e => {
    if (!draggingSplit) return;
    const rect = stage.getBoundingClientRect();
    uiState.split = clamp((e.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    model.setSplit(uiState.split);
    const sl = actBar.querySelector('#ctl-split');
    const sv = actBar.querySelector('#ctl-split-v');
    if (sl) sl.value = String(Math.round(uiState.split * 100));
    if (sv) sv.textContent = `${Math.round(uiState.split * 100)}%`;
  });
  window.addEventListener('pointerup', e => {
    draggingSplit = false;
    if (!stageClick || e.pointerId !== stageClick.id) return;
    const dist = Math.hypot(e.clientX - stageClick.x, e.clientY - stageClick.y);
    stageClick = null;
    if (!interactive || dist > 6) return;
    if (licModal.style.display === 'flex' || isDeckModalOpen()) return;
    if (e.target?.closest?.('#act-bar, #license-modal, #glass-card, .bne-deck-ui, button, input, a, label')) return;
    if (!model.getSnapshot().autoMode) model.nextBeat();
  });
  window.addEventListener('pointercancel', () => { draggingSplit = false; stageClick = null; });

  glassCard?.addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    e.stopPropagation();
    if (btn.dataset.g === 'replay') {
      model.seekFrame(0);
    } else if (btn.dataset.g === 'overview') {
      ui.toggleOverview();
    } else if (btn.dataset.g === 'license') {
      openLicenseModal();
    }
    btn.blur?.();
  });

  let licenseLoaded = false;
  async function openLicenseModal() {
    licModal.style.display = 'flex';
    if (licenseLoaded) return;
    licenseLoaded = true;
    try {
      const prov = embedded?.provenance ?? await (await fetch(asset('provenance.json'))).json();
      const licList = Array.isArray(embedded?.licenses) ? embedded.licenses : [];
      const itemsHtml = (prov.items ?? []).map(it =>
        `<div class="lic-row"><b>${it.name}</b> <span class="lic-tag">${it.license}</span><div class="lic-sub">${it.source} · ${it.notes}</div></div>`
      ).join('');
      const rawLicHtml = licList.length
        ? `<details><summary>展开随包附带的 ${licList.length} 份完整 MIT / OFL-1.1 / CC0-1.0 / Apache-2.0 许可全文</summary>${
            licList.map(item => `<h4>${item.name}</h4><pre>${String(item.text).replace(/</g, '&lt;')}</pre>`).join('')
          }</details>`
        : '<p class="lic-sub">开发模式查看；单文件离线打包后将随包内嵌完整 LICENSE 原文。</p>';
      licBody.innerHTML = `
        <p class="lic-lead">${prov.summary ?? ''}</p>
        <div class="lic-aigc"><strong>AI 生成内容声明（AIGC）：</strong>${prov.aigcDisclosure ?? ''}</div>
        <div class="lic-list">${itemsHtml}</div>
        ${rawLicHtml}
      `;
    } catch (err) {
      licBody.textContent = `无法读取溯源清单：${err.message}`;
    }
  }
  licModal?.querySelector('.lic-close')?.addEventListener('click', () => { licModal.style.display = 'none'; });
  licModal?.addEventListener('click', e => { if (e.target === licModal) licModal.style.display = 'none'; });

  if (interactive) {
    window.addEventListener('keydown', e => {
      if ((licModal.style.display === 'flex' || isDeckModalOpen()) && e.key === ' ') {
        e.stopImmediatePropagation();
      }
    }, true);
    window.addEventListener('keydown', e => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      unlockAudioOnGesture();
      if (e.key === 'Escape' && licModal.style.display === 'flex') {
        licModal.style.display = 'none';
        return;
      }
      if (/^[0-9]$/.test(e.key)) {
        const idx = e.key === '0' ? 9 : Number(e.key) - 1;
        if (film.shots[idx]) {
          model.seekFrame(film.shots[idx].in);
          ui.toast(`跳转至第 ${String(idx + 1).padStart(2, '0')} 幕：${film.shots[idx].name}`);
        }
        return;
      }
      const k = e.key.toLowerCase();
      if (k === 'l') {
        if (licModal.style.display === 'flex') licModal.style.display = 'none';
        else openLicenseModal();
        return;
      }
      if (k === 'v') {
        buildActBar(uiState.lastActId || 'A01', lastSceneState);
        return;
      }
      const curId = film.shots[model.getSnapshot().chapterIndex]?.id;
      if (curId === 'A07') {
        const qwer = { q: 0, w: 1, e: 2, r: 3 };
        if (k in qwer) {
          uiState.quad = false;
          uiState.styleIndex = qwer[k];
          triggerSfx('sfx_shader_snap', 0.72);
          const snap = model.getSnapshot();
          render(snap.time, { tier: snap.tier, pointer: uiState.lastPointer, split: snap.splitRatio });
          buildActBar('A07', lastSceneState);
        } else if (k === 'g') {
          uiState.quad = !(uiState.quad ?? lastSceneState?.quadMode ?? false);
          triggerSfx('sfx_shader_snap', 0.72);
          const snap = model.getSnapshot();
          render(snap.time, { tier: snap.tier, pointer: uiState.lastPointer, split: snap.splitRatio });
          buildActBar('A07', lastSceneState);
        }
      }
    });
  }

  stage.addEventListener('webglcontextlost', e => {
    e.preventDefault();
    lost = true;
    deck.stop();
    statusEl.textContent = 'WebGL 上下文恢复中…';
  });
  stage.addEventListener('webglcontextrestored', () => {
    look?.dispose();
    look = null;
    lastTier = null;
    lost = false;
    brushedTex.needsUpdate = true;
    gridTex.needsUpdate = true;
    acts0104.A01.markDirty();
    render(model.getSnapshot().time);
    statusEl.textContent = '';
    if (interactive) deck.start();
  });

  Object.assign(window, {
    render,
    TIMELINE: timing,
    DUR: timing.DUR,
    FPS: timing.fps,
    TEXTS: t => { render(t); return rows; },
  });

  if (bench) {
    const gl = renderer.getContext();
    const dbgExt = gl.getExtension('WEBGL_debug_renderer_info');
    const gpuInfo = {
      vendor: dbgExt ? gl.getParameter(dbgExt.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      renderer: dbgExt ? gl.getParameter(dbgExt.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      version: gl.getParameter(gl.VERSION),
    };

    window.__BENCH = {
      model,
      renderer,
      scene,
      camera,
      scenes,
      deck,
      audio,
      gpuInfo,
      tierCounts: ACT05_TIER_COUNTS,
      prepareAudio,
      setInteractive(patch = {}) {
        Object.assign(uiState, patch);
      },
      getState() {
        const buf = new THREE.Vector2();
        renderer.getDrawingBufferSize(buf);
        return {
          gpuInfo,
          drawingBuffer: [buf.x, buf.y],
          canvasSize: [stage.width, stage.height],
          overlaySize: [overlay.width, overlay.height],
          act05InstanceCount: act05.getInstanceCount(),
          snapshot: model.getSnapshot(),
          rowsCount: rows.length,
        };
      },

      async measureH4({ tier = 'full', warmup = 24, frames = 120, formation = 0 } = {}) {
        const a05Start = timing.shots.find(s => s.id === 'A05').t0 + 4.0;
        for (let i = 0; i < warmup; i++) {
          render(a05Start + i / 60, { tier, formation, pointer: [0.5 + Math.sin(i * 0.1) * 0.2, 0.5] });
          await new Promise(r => requestAnimationFrame(r));
        }
        gl.finish();
        const times = [];
        const t0All = performance.now(); // determinism-ok: bench timing only
        let prev = t0All;
        for (let i = 0; i < frames; i++) {
          render(a05Start + (warmup + i) / 60, { tier, formation, pointer: [0.5 + Math.sin(i * 0.12) * 0.25, 0.5] });
          await new Promise(r => requestAnimationFrame(r));
          const now = performance.now(); // determinism-ok: bench timing only
          times.push(now - prev);
          prev = now;
        }
        gl.finish();
        const totalMs = performance.now() - t0All; // determinism-ok: bench timing only
        const sorted = [...times].sort((a, b) => a - b);
        const buf = new THREE.Vector2();
        renderer.getDrawingBufferSize(buf);
        return {
          tier,
          instanceCount: act05.getInstanceCount(),
          downgradeTierCounts: ACT05_TIER_COUNTS,
          drawingBuffer: [buf.x, buf.y],
          gpuInfo,
          warmupFrames: warmup,
          measuredFrames: frames,
          totalMs: Number(totalMs.toFixed(2)),
          fps: Number((frames / (totalMs / 1000)).toFixed(2)),
          frameMsP50: Number(sorted[Math.floor(sorted.length * 0.5)].toFixed(3)),
          frameMsP95: Number(sorted[Math.floor(sorted.length * 0.95)].toFixed(3)),
          frameMsMax: Number(sorted[sorted.length - 1].toFixed(3)),
        };
      },

      measureH5bCoverage(width = 1280, height = 720, tSample = 198.0) {
        const rt = new THREE.WebGLRenderTarget(width, height, {
          minFilter: THREE.NearestFilter,
          magFilter: THREE.NearestFilter,
          format: THREE.RGBAFormat,
          type: THREE.UnsignedByteType,
          depthBuffer: true,
        });
        const cam = new THREE.PerspectiveCamera(40, width / height, 0.1, 100);
        cam.position.set(0, 0.45, 6.4);
        cam.lookAt(0, 0.12, 0);
        cam.updateProjectionMatrix();
        cam.updateMatrixWorld(true);

        acts0610.A07.syncPose(tSample, [0.5, 0.5]);
        const masks = [];
        const covered = [];
        const raw = new Uint8Array(width * height * 4);

        const prevTarget = renderer.getRenderTarget();
        const prevClearAlpha = renderer.getClearAlpha();
        const prevClearColor = new THREE.Color();
        renderer.getClearColor(prevClearColor);

        for (let i = 0; i < 4; i++) {
          renderer.setRenderTarget(rt);
          renderer.setClearColor(0x000000, 0);
          renderer.clear(true, true, true);
          acts0610.A07.quadMesh.material = acts0610.A07.materials[i];
          renderer.render(acts0610.A07.quadScene, cam);
          renderer.readRenderTargetPixels(rt, 0, 0, width, height, raw);
          const mask = new Uint8Array(width * height);
          let cnt = 0;
          for (let p = 0; p < width * height; p++) {
            const on = raw[p * 4 + 3] > 0 ? 1 : 0;
            mask[p] = on;
            cnt += on;
          }
          masks.push(mask);
          covered.push(cnt);
        }

        renderer.setRenderTarget(prevTarget);
        renderer.setClearColor(prevClearColor, prevClearAlpha);
        rt.dispose();

        const pairs = {};
        let maxDiff = 0;
        for (let i = 0; i < 4; i++) {
          for (let j = i + 1; j < 4; j++) {
            let diff = 0;
            const a = masks[i];
            const b = masks[j];
            for (let p = 0; p < a.length; p++) {
              if (a[p] !== b[p]) diff++;
            }
            pairs[`${ACT07_STYLES[i].key}_vs_${ACT07_STYLES[j].key}`] = diff;
            if (diff > maxDiff) maxDiff = diff;
          }
        }
        return {
          width,
          height,
          totalPixels: width * height,
          tSample,
          coveredPixelsPerStyle: ACT07_STYLES.map((s, idx) => ({ style: s.key, coveredPixels: covered[idx] })),
          pairwiseDiffPixels: pairs,
          maxDiffPixels: maxDiff,
          pixelExactZeroDiff: maxDiff === 0 && covered.every(c => c > 1000),
        };
      },

      async measureH5bSwitchLatency({ trials = 24, tier = 'full' } = {}) {
        const a07t = timing.shots.find(s => s.id === 'A07').t0 + 4.0;
        const coldFirstMs = [];
        for (let s = 0; s < 4; s++) {
          const t0 = performance.now(); // determinism-ok: bench timing only
          render(a07t + s * 0.05, { tier, quad: false, styleIndex: s });
          gl.finish();
          const tGpuDone = performance.now(); // determinism-ok: bench timing only
          await new Promise(r => requestAnimationFrame(r));
          const tRaf1 = performance.now(); // determinism-ok: bench timing only
          coldFirstMs.push({
            style: ACT07_STYLES[s].key,
            gpuFinishProxyMs: Number((tGpuDone - t0).toFixed(3)),
            raf1ProxyMs: Number((tRaf1 - t0).toFixed(3)),
          });
        }

        const gpuRenderMs = [];
        const raf1ProxyMs = [];
        for (let i = 0; i < trials; i++) {
          const nextStyle = (i + 1) % 4;
          const tIn = performance.now(); // determinism-ok: bench timing only
          render(a07t + 1.0 + i * 0.04, { tier, quad: false, styleIndex: nextStyle });
          gl.finish();
          const tGpuDone = performance.now(); // determinism-ok: bench timing only
          await new Promise(r => requestAnimationFrame(r));
          const tRaf1 = performance.now(); // determinism-ok: bench timing only
          gpuRenderMs.push(Number((tGpuDone - tIn).toFixed(3)));
          raf1ProxyMs.push(Number((tRaf1 - tIn).toFixed(3)));
        }
        const stat = arr => {
          const s = [...arr].sort((a, b) => a - b);
          const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
          return {
            min: s[0],
            p50: s[Math.floor(s.length * 0.5)],
            mean: Number(mean.toFixed(3)),
            p95: s[Math.floor(s.length * 0.95)],
            max: s[s.length - 1],
          };
        };
        const buf = new THREE.Vector2();
        renderer.getDrawingBufferSize(buf);
        return {
          tier,
          drawingBuffer: [buf.x, buf.y],
          gpuInfo,
          targetMs: 16.0,
          physicalPresentationStatus: 'pending_compositor_presentation_feedback',
          measurementNote: 'gpuFinishProxyMs (gl.finish) and raf1ProxyMs (next requestAnimationFrame) are proxy timings only; 16 ms physical display presentation is unmeasured here.',
          coldFirstSwitchProxy: coldFirstMs,
          warmGpuSwitchOnlyMs: stat(gpuRenderMs),
          warmRaf1ProxyMs: stat(raf1ProxyMs),
          rawWarmGpuMs: gpuRenderMs,
          rawWarmRaf1ProxyMs: raf1ProxyMs,
        };
      },

      get rows() { return rows; },
      get restored() { return !lost; },
      get audioIsCold() { return !sfxCtx && !audio.isPlaying(); },
    };
  }

  render(0);
  statusEl.textContent = '';
  window.READY = true;
  if (interactive) {
    deck.start();
    prepareAudio().catch(err => ui.toast(`音频未就绪：${err.message}`));
  }
}

boot().catch(err => {
  const el = document.querySelector('#status');
  if (el) el.textContent = `启动失败：${err.message}`;
  console.error(err);
});
