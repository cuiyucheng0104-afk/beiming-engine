// 界面：状态 → HTML。桌面坐标 1920×1080（世界坐标 = 屏幕坐标，相机只做缩放平移）。
// 所有可站立的元素都带 data-a，主程序每帧量 DOM 取锚点。
export const LAY = {
  todo: { x: 230, y: 96, w: 580, h: 800 },
  card: { w: 480, h: 80 },
  set: { x: 1210, y: 430, w: 520, h: 318 },
  toast: { x: 1386, y: 236, w: 500, h: 100 },
};
const ROWS = [
  { id: 'r0', text: '回邮件', done: true, tag: '周一' },
  { id: 'r1', text: '订会议室', done: true, tag: '周二' },
  { id: 'slot', text: '写周报', done: false, tag: '今天 18:00' },
  { id: 'r3', text: '交报销', done: true, tag: '周三' },
];
const CHECK = `<svg viewBox="0 0 24 24" width="22" height="22"><path d="M5 12.5l4.6 4.5L19 7.5" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export function cardHTML(st, style = '', attrs = '') {
  // st: {done, alive, lifted}
  const done = st.done;
  return `<div class="card${done ? ' done' : ''}${st.lifted ? ' lifted' : ''}${st.alive ? ' alive' : ''}" ${attrs} style="${style}">
    <div class="cb${done ? ' on' : ''}" data-a="face">${done ? CHECK : ''}</div>
    <div class="ct">写周报</div><div class="tag hot">今天 18:00</div></div>`;
}

function todoWin(S) {
  const L = LAY.todo, done = S.allDone;
  const rows = ROWS.map((r, i) => {
    if (r.id === 'slot') return `<div class="slot${S.slotEmpty ? ' empty' : ''}" data-a="slot"></div>`;
    return `<div class="card done" data-a="${r.id}"><div class="cb on">${CHECK}</div><div class="ct">${r.text}</div><div class="tag">${r.tag}</div></div>`;
  }).join('');
  const n = done ? 4 : 3;
  return `<div class="win todo" style="left:${L.x}px;top:${L.y}px;width:${L.w}px;height:${L.h}px">
    <div class="tbar" data-a="todotb"><div class="lights"><i></i><i></i><i></i></div><div class="wtitle" data-a="title"><span class="appic sm"></span>逃跑的周报</div><div class="tbr">⋯</div></div>
    <div class="todo-b">
      <div class="h1">本周</div><div class="sub">周三 · ${done ? '全部完成' : '还剩 1 项'}</div>
      <div class="list">${rows}</div>
      <div class="prog"><div class="bar"><i style="width:${n * 25}%"></i></div><span>${n} / 4 已完成</span></div>
      <div class="newrow"><span class="plus">＋</span>新建待办</div>
    </div></div>`;
}

function setWin(S) {
  const L = LAY.set, on = S.toggle;   // toggle 0..1
  return `<div class="win set" style="left:${L.x + S.setDx}px;top:${L.y + S.setDy}px;width:${L.w}px;height:${L.h}px">
    <div class="tbar" data-a="settb"><div class="lights"><i></i><i></i><i></i></div><div class="wtitle">外观</div></div>
    <div class="set-b">
      <div class="srow"><span>深色模式</span><div class="tog" data-a="toggle" style="--k:${on}"><i></i></div></div>
      <div class="srow"><span>强调色</span><div class="sw"><i style="background:#3B6FF5"></i><i style="background:#8A5CF6"></i><i style="background:#E5484D"></i><i style="background:#30A46C"></i></div></div>
      <div class="srow"><span>列表密度</span><div class="segc"><b>舒适</b><span>紧凑</span></div></div>
    </div></div>`;
}

function toast(S) {
  if (S.toastX === null) return '';
  const L = LAY.toast;
  return `<div class="toast" data-a="toast" style="left:${L.x + S.toastX}px;top:${L.y}px;width:${L.w}px;height:${L.h}px">
    <span class="appic"></span><div class="tt"><div class="tn"><b>清单</b><span>现在</span></div><div class="tm">提醒 · 写周报</div><div class="tb">今天 18:00 截止</div></div></div>`;
}

function dock(S) {
  const b = S.trash || { sx: 1, sy: 1, lid: 0 };
  return `<div class="dock">
    <div class="di"><span class="ico ic-todo"></span></div>
    <div class="di"><span class="ico ic-cal"><b>周三</b><i>30</i></span></div>
    <div class="di"><span class="ico ic-note"></span></div>
    <div class="di"><span class="ico ic-set"></span></div>
    <div class="dsep"></div>
    <div class="di trashw" data-a="trash"><svg class="trash" viewBox="0 0 84 84" width="84" height="84" style="transform:scale(${b.sx},${b.sy})">
      <defs><linearGradient id="tg${S.layer}" x1="0" x2="1"><stop offset="0" stop-color="var(--bin1)"/><stop offset=".5" stop-color="var(--bin2)"/><stop offset="1" stop-color="var(--bin1)"/></linearGradient></defs>
      <path d="M18 24 L66 24 L61 78 Q60 82 56 82 L28 82 Q24 82 23 78 Z" fill="url(#tg${S.layer})" stroke="var(--binS)" stroke-width="1.5"/>
      ${[30, 38, 46, 54].map(x => `<path d="M${x} 30 L${x + (x - 42) * .08} 76" stroke="var(--binS)" stroke-width="1.6" opacity=".55"/>`).join('')}
      <g transform="translate(42 22) rotate(${-b.lid * 28}) translate(${-42 + b.lid * -6} ${-22 - b.lid * 8})"><rect x="14" y="16" width="56" height="8" rx="3" fill="var(--bin2)" stroke="var(--binS)" stroke-width="1.5"/></g>
    </svg></div></div>`;
}

export function desk(S) {
  return `<div class="wall"></div>
  <div class="menubar"><b>清单</b><span>文件</span><span>编辑</span><span>显示</span><span>窗口</span><span>帮助</span><span class="r">周三 17:42</span></div>
  ${setWin(S)}${todoWin(S)}${toast(S)}${dock(S)}`;
}
