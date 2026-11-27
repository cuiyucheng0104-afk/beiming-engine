// 北冥引擎 · 演示壳的界面（Shadow DOM）：状态条、进度与节拍刻度、三轨调音台、章节总览、操作说明、页内提词面板、提示。
// 只是演示壳状态（createDeckModel 的快照）的只读视图，不参与画面：所有显示都不进 render(t, input)。
//   createDeckUI(deck, audio, { theme }) → { el, update(snap, { fps }), toggleOverview(), toggleHelp(), toggleMixer(), showNotes(),
//                                          closePanels(), toast(msg), dispose() }
//   theme：{ ink, paper, cinnabar, warm, grey, fonts: { sans, serif }, stems: { <轨 id>: 显示名 }, voName }
//   调音台的键：M = 这一轨静音，S = 只听这一轨（再点取消）；总静音与导览配音是独立开关。
export function createDeckUI(deck, audio, theme = {}) {
  const T = {
    ink: '#08080A', paper: '#F4F0E6', cinnabar: '#D2452C', warm: '#FFC46B', grey: '#B9B3A6',
    fonts: { sans: '-apple-system, BlinkMacSystemFont, "Noto Sans SC", sans-serif', serif: '"Noto Serif SC", serif' },
    stems: {}, voName: '导览配音', ...theme,
  };
  const SANS = T.fonts.sans, SERIF = T.fonts.serif, MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
  const host = document.createElement('div');
  host.className = 'bne-deck-ui';
  const root = host.attachShadow({ mode: 'open' });
  const panelBg = 'color-mix(in srgb, var(--ink) 86%, transparent)';

  root.innerHTML = `<style>
  :host { all: initial; position: fixed; inset: 0; z-index: 100; pointer-events: none; color: var(--paper); font-family: ${SANS}; -webkit-font-smoothing: antialiased; }
  #box { color: var(--paper); position: absolute; inset: 0; --ink: ${T.ink}; --paper: ${T.paper}; --cinnabar: ${T.cinnabar}; --warm: ${T.warm}; --grey: ${T.grey}; }
  .mono { font-family: ${MONO}; font-variant-numeric: tabular-nums; }
  .top { position: absolute; top: 0; left: 0; right: 0; display: flex; justify-content: space-between; align-items: baseline; gap: 24px; padding: 26px 40px 0; font-size: 15px; text-shadow: 0 1px 8px var(--ink); }
  .top .left { display: flex; align-items: baseline; gap: 16px; min-width: 0; }
  .idx { color: var(--paper); font-size: 13px; letter-spacing: .08em; }
  .title { font-family: ${SERIF}; font-size: 22px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .beat { color: var(--grey); font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 40vw; }
  .right { display: flex; gap: 20px; color: var(--grey); font-size: 13px; white-space: nowrap; }
  .tier-full { color: var(--paper); } .tier-medium { color: #e8d9a8; } .tier-low { color: var(--grey); } .tier-minimal { color: var(--cinnabar); }
  .track { position: absolute; top: 0; left: 0; right: 0; height: 3px; background: color-mix(in srgb, var(--paper) 14%, transparent); }
  .track i { position: absolute; top: 0; bottom: 0; width: 1px; background: color-mix(in srgb, var(--paper) 45%, transparent); }
  .track i.ch { background: var(--cinnabar); height: 7px; }
  .fill { position: absolute; left: 0; top: 0; bottom: 0; background: var(--cinnabar); width: 0; }
  .keys { position: absolute; left: 0; right: 0; bottom: 0; display: flex; justify-content: center; flex-wrap: wrap; gap: 6px 18px; padding: 14px 24px 16px; font-size: 12.5px; color: var(--grey); opacity: .62; transition: opacity .3s; text-shadow: 0 1px 6px var(--ink); }
  .keys:hover { opacity: 1; }
  kbd { font-family: ${MONO}; font-size: 11.5px; color: var(--paper); border: 1px solid color-mix(in srgb, var(--paper) 32%, transparent); border-radius: 4px; padding: 1px 6px; margin-right: 6px; }
  .panel { position: absolute; background: ${panelBg}; border: 1px solid color-mix(in srgb, var(--paper) 14%, transparent); border-radius: 10px; backdrop-filter: blur(14px); pointer-events: auto; box-shadow: 0 18px 50px color-mix(in srgb, var(--ink) 60%, transparent); }
  .mixer { left: 40px; bottom: 62px; width: 262px; padding: 14px 16px 12px; display: none; }
  .mixer.on { display: block; }
  .mixer h3, .modal h3 { margin: 0 0 10px; font-size: 12px; font-weight: 600; letter-spacing: .12em; color: var(--paper); }
  .stem { display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: 8px; padding: 7px 0; border-top: 1px solid color-mix(in srgb, var(--paper) 9%, transparent); font-size: 14px; }
  .stem.off .nm { color: var(--grey); text-decoration: line-through; }
  .btn { font-family: ${MONO}; font-size: 12px; color: var(--paper); background: color-mix(in srgb, var(--paper) 10%, transparent); border: 1px solid color-mix(in srgb, var(--paper) 22%, transparent); border-radius: 5px; padding: 3px 9px; cursor: pointer; }
  .btn:hover { border-color: var(--paper); }
  .btn.on { background: var(--cinnabar); border-color: var(--cinnabar); color: #fff; }
  .mixer .foot { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-top: 10px; padding-top: 10px; border-top: 1px solid color-mix(in srgb, var(--paper) 14%, transparent); font-size: 13px; }
  .modal { left: 50%; top: 50%; transform: translate(-50%, -50%); max-width: min(1180px, 88vw); max-height: 84vh; overflow: auto; padding: 26px 30px; display: none; }
  .modal.on { display: block; }
  .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
  .card { text-align: left; color: var(--paper); background: color-mix(in srgb, var(--paper) 5%, transparent); border: 1px solid color-mix(in srgb, var(--paper) 12%, transparent); border-left: 3px solid transparent; border-radius: 8px; padding: 14px 14px 12px; cursor: pointer; min-height: 96px; font-family: ${SANS}; }
  .card:hover { background: color-mix(in srgb, var(--paper) 12%, transparent); }
  .card.cur { border-left-color: var(--cinnabar); background: color-mix(in srgb, var(--cinnabar) 16%, transparent); }
  .card b { display: block; font-family: ${MONO}; font-weight: 500; font-size: 12px; color: var(--paper); margin-bottom: 6px; }
  .card span { font-family: ${SERIF}; font-size: 19px; line-height: 1.3; }
  .card small { display: block; margin-top: 6px; font-size: 12px; color: var(--grey); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .help dl { display: grid; grid-template-columns: max-content 1fr; gap: 10px 22px; margin: 0; font-size: 15px; }
  .help dt { color: var(--paper); } .help dd { margin: 0; color: var(--grey); }
  .notes { right: 40px; bottom: 62px; width: 360px; padding: 14px 16px; display: none; }
  .notes.on { display: block; }
  .notes .body { font-size: 15px; line-height: 1.6; color: var(--paper); white-space: pre-wrap; max-height: 34vh; overflow: auto; }
  .toast { position: absolute; left: 50%; top: 64px; transform: translateX(-50%); padding: 8px 16px; border-radius: 999px; background: var(--cinnabar); color: #fff; font-size: 13.5px; opacity: 0; transition: opacity .25s; }
  .toast.on { opacity: 1; }
  @media (max-width: 900px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .beat { display: none; } .top { padding: 16px 20px 0; } .keys { font-size: 11.5px; gap: 4px 12px; } }
  </style>
  <div id="box">
    <div class="track"><div class="fill"></div></div>
    <div class="top">
      <div class="left"><span class="idx mono"></span><span class="title"></span><span class="beat"></span></div>
      <div class="right"><span class="stat mono"></span><span class="time mono"></span></div>
    </div>
    <div class="keys"></div>
    <div class="panel mixer"><h3>调音台 · 三轨相位锁定</h3><div class="stems"></div>
      <div class="foot"><span class="vo"></span><span class="master mono"></span></div></div>
    <div class="panel notes"><h3>演讲者备注 <span class="mono" style="color:var(--grey)">N 开独立提词窗</span></h3><div class="body"></div></div>
    <div class="panel modal overview"><h3>章节总览</h3><div class="grid"></div></div>
    <div class="panel modal help"><h3>操作说明</h3><dl>
      <dt><kbd>←</kbd><kbd>→</kbd></dt><dd>上一拍 / 下一拍（走到该拍停住）</dd>
      <dt><kbd>Shift</kbd> + <kbd>←</kbd><kbd>→</kbd></dt><dd>上一章 / 下一章</dd>
      <dt><kbd>空格</kbd></dt><dd>从当前帧往后播，到下一拍停</dd>
      <dt><kbd>A</kbd></dt><dd>自动 / 手动（自动：声卡时钟当主时钟，连续播放）</dd>
      <dt><kbd>S</kbd></dt><dd>调音台：三轨各自 Mute / Solo，总静音与导览配音独立</dd>
      <dt><kbd>V</kbd></dt><dd>导览配音开 / 关（默认关）</dd>
      <dt><kbd>M</kbd></dt><dd>总静音</dd>
      <dt><kbd>O</kbd></dt><dd>章节总览</dd>
      <dt><kbd>N</kbd></dt><dd>演讲者提词独立窗（被拦截时在页内右下角显示）</dd>
      <dt><kbd>F</kbd></dt><dd>全屏</dd>
      <dt><kbd>T</kbd></dt><dd>手动换画质档（之后不再自动降档）</dd>
      <dt><kbd>H</kbd> / <kbd>Esc</kbd></dt><dd>操作说明 / 关面板</dd>
    </dl></div>
    <div class="toast"></div>
  </div>`;

  const $ = s => root.querySelector(s);
  const el = { idx: $('.idx'), title: $('.title'), beat: $('.beat'), stat: $('.stat'), time: $('.time'), fill: $('.fill'), track: $('.track'),
    mixer: $('.mixer'), stems: $('.stems'), vo: $('.vo'), master: $('.master'), overview: $('.overview'), grid: $('.grid'), help: $('.help'),
    notes: $('.notes'), notesBody: $('.notes .body'), toast: $('.toast'), keys: $('.keys') };
  const cache = new Map();
  const put = (node, text) => { if (cache.get(node) !== text) { node.textContent = text; cache.set(node, text); } };
  const on = (node, type, fn) => node.addEventListener(type, e => { e.stopPropagation(); fn(e); });
  const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  el.keys.innerHTML = [['← →', '节拍 / 切章'], ['空格', '播放'], ['A', '自动'], ['S', '调音台'], ['V', '导览'], ['M', '静音'], ['O', '总览'], ['N', '提词'], ['F', '全屏'], ['T', '画质'], ['H', '说明']]
    .map(([k, v]) => `<span><kbd>${k}</kbd>${v}</span>`).join('');

  // ── 调音台：按音频引擎里登记的轨生成 ──
  let stemCount = -1, stemDom = [];
  function rebuildStems() {
    const list = audio?.getStemsState?.() ?? [];
    if (list.length === stemCount) return;
    stemCount = list.length;
    if (!list.length) { el.stems.replaceChildren(); return; }
    stemDom = list.map(s => {
      const row = document.createElement('div'); row.className = 'stem';
      row.innerHTML = `<div class="nm"></div>`;
      row.querySelector('.nm').textContent = T.stems[s.id] ?? s.name ?? s.id;
      const mk = (label, fn) => { const b = document.createElement('button'); b.className = 'btn'; b.textContent = label; on(b, 'click', fn); row.appendChild(b); return b; };
      return { id: s.id, row, m: mk('M', () => audio.toggleMuteStem(s.id)), s: mk('S', () => audio.toggleSoloStem(s.id)) };
    });
    el.stems.replaceChildren(...stemDom.map(s => s.row));
  }
  const voBtn = document.createElement('button'); voBtn.className = 'btn'; voBtn.textContent = T.voName;
  on(voBtn, 'click', () => audio?.setVoEnabled?.(deck.model.toggleVo()));
  el.vo.replaceChildren(voBtn);

  // ── 章节总览 / 进度刻度：结构变了才重建 ──
  let chapterSig = '', beatSig = '', curCard = null;
  function rebuildChapters(snap) {
    const sig = snap.chapters.map(c => c.id + c.name).join('|');
    if (sig === chapterSig) return;
    chapterSig = sig;
    el.grid.replaceChildren(...snap.chapters.map(c => {
      const b = document.createElement('button'); b.className = 'card'; b.dataset.id = c.id;
      b.innerHTML = `<b></b><span></span><small></small>`;
      b.querySelector('b').textContent = `${String(c.index + 1).padStart(2, '0')} · ${fmt(c.in / snap.fps)}`;
      b.querySelector('span').textContent = c.name;
      b.querySelector('small').textContent = (c.note || '').split('\n')[0].slice(0, 40);
      on(b, 'click', () => { deck.model.seekFrame(c.in); closePanels(); });
      return b;
    }));
  }
  function rebuildTicks(snap) {
    const sig = `${snap.totalBeats}:${snap.totalFrames}`;
    if (sig === beatSig) return;
    beatSig = sig;
    for (const t of el.track.querySelectorAll('i')) t.remove();
    el.track.append(...snap.beats.map(b => {
      const i = document.createElement('i'); if (snap.chapters.some(c => c.in === b.frame)) i.className = 'ch';
      i.style.left = `${(b.frame / snap.totalFrames) * 100}%`; return i;
    }));
  }

  const closePanels = () => { el.overview.classList.remove('on'); el.help.classList.remove('on'); };
  const toggleOverview = () => { const was = el.overview.classList.contains('on'); closePanels(); el.overview.classList.toggle('on', !was); };
  const toggleHelp = () => { const was = el.help.classList.contains('on'); closePanels(); el.help.classList.toggle('on', !was); };
  const toggleMixer = () => el.mixer.classList.toggle('on');

  let toastTimer = 0;
  function toast(msg) {
    el.toast.textContent = msg; el.toast.classList.add('on');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.toast.classList.remove('on'), 2600);
  }

  function update(snap, { fps = 0 } = {}) {
    put(el.idx, `${String(snap.chapterIndex + 1).padStart(2, '0')} / ${String(snap.totalChapters).padStart(2, '0')}${snap.autoMode ? ' · 自动' : ''}`);
    put(el.title, snap.chapter?.name ?? '');
    put(el.beat, snap.beat?.name ?? '');
    put(el.stat, `${fps ? fps.toFixed(1) : '—'} fps · ${snap.tier}${snap.tierLocked ? ' · 锁定' : ''}`);
    el.stat.className = `stat mono tier-${snap.tier}`;
    put(el.time, `${fmt(snap.time)} / ${fmt(snap.dur)}  F${snap.frame}`);
    el.fill.style.width = `${(snap.progress * 100).toFixed(3)}%`;
    rebuildTicks(snap); rebuildChapters(snap); rebuildStems();
    const cur = snap.chapter?.id ?? null;
    if (cur !== curCard) { curCard = cur; for (const c of el.grid.children) c.classList.toggle('cur', c.dataset.id === cur); }
    const states = audio?.getStemsState?.() ?? [];
    const anySolo = states.some(s => s.soloed);
    stemDom.forEach((d, i) => {
      const s = states[i]; if (!s) return;
      d.m.classList.toggle('on', s.muted); d.s.classList.toggle('on', s.soloed);
      d.row.classList.toggle('off', anySolo ? !(s.soloed && !s.muted) : s.muted);
    });
    voBtn.classList.toggle('on', snap.voEnabled);
    put(el.master, snap.muted ? '总静音 ON' : '总静音 off');
    put(el.notesBody, snap.note || '（本章无演讲者备注）');
  }
  const showNotes = () => el.notes.classList.toggle('on');

  // 面板里的指针事件在这里停住，不透传成壳的指针通道
  root.addEventListener('pointermove', e => e.stopPropagation());
  root.addEventListener('pointerdown', e => e.stopPropagation());
  document.body.appendChild(host);

  return {
    el: host, theme: T, notesFont: SANS, update, toggleOverview, toggleHelp, toggleMixer, showNotes, closePanels, toast,
    dispose() { host.remove(); },
  };
}
