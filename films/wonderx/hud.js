// WonderX Phase 2 v4 · 原生 1920×1080 2D 导演 HUD 层
// 覆盖 10 幕信息排版、页码彩蛋（SLIDE 1 / 48 -> 01 / 10 -> SLIDE 10 / 10）、
// Act 03 实时 3D→2D CAD 引线、Act 05 30k 实例遥测、Act 06 尺度标尺与微距准星、
// Act 07 四画风徽章与 2×2 矩阵分隔、Act 08 北冥导演工作台与中文排版、
// Act 09 左右同源 7 项数据一刀分屏（H6）、Act 10 品牌落版与视频态 12° 玻璃卡。
import { PALETTE, H6_PLATFORM_DATA, clamp, smoothstep } from './scenes/shared.js';
import { ACT05_FORMATIONS } from './scenes/act05_tsunami.js';
import { ACT07_STYLES } from './scenes/acts_06_10.js';

const ACT_GAGS = {
  A01: 'HIJACKED · 8-FX GLSL',
  A02: 'DIM: 2D → 3D',
  A03: 'PARTS: 428 LIVE',
  A04: 'OPTICS: 420–680nm',
  A05: 'NODES: 30,000 GPU',
  A06: 'SCALE: 10⁶→10⁻³m',
  A07: 'STYLES: 66+ ENGINE',
  A08: 'OUT: HTML + 4K MP4',
  A09: 'LIVE SPLIT 0–100%',
  A10: 'SLIDE 10 / 10',
};

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function drawHud(ctx, overlay, state) {
  const {
    id, progress, t, copy, sceneState, split = 0.5, tier = 'full',
    interactive = true, pointer = [0.5, 0.5], rows,
  } = state;

  const scaleX = overlay.width / 1920;
  const scaleY = overlay.height / 1080;
  ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
  ctx.clearRect(0, 0, 1920, 1080);
  rows.length = 0;

  function write(text, x, y, px, font, color = PALETTE.porcelain, weight = 400, tag = 'hud', align = 'left') {
    const resolvedFont = font === 'WX Display' ? 'WX Serif' : (font === 'WX Sans' ? 'WX Text' : font);
    ctx.font = `${weight} ${px}px "${resolvedFont}", "WX Text", sans-serif`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.fillText(text, x, y);
    const w = ctx.measureText(text).width;
    const x0 = align === 'center' ? x - w / 2 : (align === 'right' ? x - w : x);
    const box = [x0 * scaleX, (y - px) * scaleY, w * scaleX, px * 1.24 * scaleY];
    rows.push({ id: tag, text, font: resolvedFont, box, x0: box[0], y0: box[1], x1: box[0] + box[2], y1: box[1] + box[3], alpha: 1 });
    ctx.textAlign = 'left';
    return w;
  }

  function writeMono(text, x, y, px, color = PALETTE.titaniumLight, weight = 600, align = 'left', tag = null) {
    const fam = px >= 28 ? '"WX Display", "WX Sans", ui-monospace, monospace' : '"WX Sans", ui-monospace, "SF Mono", Menlo, monospace';
    ctx.font = `${weight} ${px}px ${fam}`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.fillText(text, x, y);
    if (tag) {
      const w = ctx.measureText(text).width;
      const x0 = align === 'center' ? x - w / 2 : (align === 'right' ? x - w : x);
      const box = [x0 * scaleX, (y - px) * scaleY, w * scaleX, px * 1.24 * scaleY];
      rows.push({ id: tag, text, font: 'WX Sans', box, x0: box[0], y0: box[1], x1: box[0] + box[2], y1: box[1] + box[3], alpha: 1 });
    }
    ctx.textAlign = 'left';
  }

  // ── 特殊全屏构图幕：Act 09（H6 一刀分屏） ──
  if (id === 'A09') {
    drawAct09Split(ctx, split, write, writeMono);
    drawPageCounter(ctx, id, progress, writeMono, true);
    return;
  }

  // ── 特殊全屏构图幕：Act 07（H5b 2×2 四宇宙矩阵 / 单宇宙扫描波） ──
  if (id === 'A07') {
    drawAct07Hud(ctx, progress, sceneState, copy, write, writeMono);
    drawPageCounter(ctx, id, progress, writeMono, false);
    return;
  }

  // ── 特殊全屏构图幕：Act 08（北冥导演工作台视口） ──
  if (id === 'A08') {
    drawAct08Workbench(ctx, progress, sceneState, copy, write, writeMono);
    drawPageCounter(ctx, id, progress, writeMono, false);
    return;
  }

  // ── 特殊全屏构图幕：Act 10（终章时间长河 -> 品牌落版 -> 12° 玻璃回眸） ──
  if (id === 'A10') {
    drawAct10Finale(ctx, progress, t, pointer, interactive, copy, write, writeMono);
    drawPageCounter(ctx, id, progress, writeMono, false);
    return;
  }

  // ── Act 03（H2）：6 条实时 3D→2D 投影 CAD 工程引线 ──
  if (id === 'A03' && sceneState?.cadAnchors?.length) {
    drawAct03Cad(ctx, sceneState.cadAnchors, sceneState.explodeValue ?? 0, write, writeMono);
  }

  // ── Act 05（H4）：30,000 实例实时遥测徽章 + 当前拓扑形态 ──
  if (id === 'A05') {
    const count = sceneState?.instanceCount ?? 30000;
    const fIdx = sceneState?.activeFormation ?? 0;
    const fObj = ACT05_FORMATIONS[fIdx] ?? ACT05_FORMATIONS[0];
    roundRect(ctx, 1460, 84, 380, 108, 10);
    ctx.fillStyle = 'rgba(7, 8, 11, 0.72)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(76, 224, 245, 0.35)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    writeMono('LIVE GPU INSTANCED MESH', 1484, 114, 13, PALETTE.iceCyan, 700);
    writeMono(`${count.toLocaleString('en-US')} NODES · ${tier.toUpperCase()}`, 1484, 146, 22, PALETTE.porcelain, 700);
    write(`当前形态：${fObj.name}`, 1484, 176, 17, 'WX Sans', PALETTE.warmTungsten, 500, 'act05-form');
  }

  // ── Act 06（H5a）：尺度标尺 + Beat 3 微距锁死核心传感器准星 ──
  if (id === 'A06') {
    const scalePow = 6 - progress * 9; // 10^6m -> 10^-3m
    roundRect(ctx, 1510, 84, 330, 82, 10);
    ctx.fillStyle = 'rgba(7, 8, 11, 0.72)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(76, 224, 245, 0.35)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    writeMono('CONTINUOUS OPTICAL DIVE', 1532, 112, 13, PALETTE.iceCyan, 700);
    writeMono(`SCALE  10^(${scalePow.toFixed(1)}) m`, 1532, 146, 22, PALETTE.porcelain, 700);

    const lock = smoothstep(0.68, 0.92, progress);
    if (lock > 0.04) {
      ctx.save();
      ctx.globalAlpha = lock * 0.88;
      ctx.strokeStyle = PALETTE.vermilion;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(960, 540, 128 - lock * 22, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = PALETTE.iceCyan;
      ctx.beginPath();
      ctx.moveTo(812, 540); ctx.lineTo(868, 540);
      ctx.moveTo(1052, 540); ctx.lineTo(1108, 540);
      ctx.moveTo(960, 392); ctx.lineTo(960, 448);
      ctx.moveTo(960, 632); ctx.lineTo(960, 688);
      ctx.stroke();
      writeMono('TARGET LOCKED · PHOTONIC SENSOR 4nm', 960, 718, 15, PALETTE.iceCyan, 700, 'center');
      ctx.restore();
    }
  }

  // ── 通用大厂暗场标题区块（Act 01 Beat 1-2 保持纯白 PPT 不叠字，Beat 3 起切入高对比暗场标题） ──
  const showTitleBlock = !(id === 'A01' && progress < 0.68);
  if (showTitleBlock) {
    const isTopLeft = id === 'A04'; // H3 棱光：左上留足干净标题负空间
    const x = 86;
    const baseY = isTopLeft ? 156 : 756;

    if (!isTopLeft) {
      const scrim = ctx.createLinearGradient(0, 660, 0, 1080);
      scrim.addColorStop(0, 'rgba(7, 8, 11, 0)');
      scrim.addColorStop(0.55, 'rgba(7, 8, 11, 0.68)');
      scrim.addColorStop(1, 'rgba(7, 8, 11, 0.88)');
      ctx.fillStyle = scrim;
      ctx.fillRect(0, 660, 1920, 420);
    }

    ctx.save();
    ctx.shadowColor = 'rgba(4, 6, 10, 0.92)';
    ctx.shadowBlur = 16;
    ctx.fillStyle = PALETTE.vermilion;
    ctx.fillRect(x, baseY - 30, 42, 4);
    writeMono(`WONDERX × BEIMING ENGINE  ·  ACT ${id.slice(1)}`, x + 54, baseY - 22, 16, PALETTE.iceCyan, 700);

    const tRow = copy.get(`${id}-title`);
    const qRow = copy.get(`${id}-quote`);
    if (tRow) write(tRow.text, x, baseY + 52, 56, tRow.font, PALETTE.porcelain, 700, tRow.id);
    if (qRow) write(qRow.text, x, baseY + 100, 24, qRow.font, '#D2D9E6', 400, qRow.id);
    ctx.restore();
  }

  drawPageCounter(ctx, id, progress, writeMono, false);
}

// ── Act 03 CAD 引线标注（对位 H2 极细白线工程标注） ──
function drawAct03Cad(ctx, anchors, explode, write, writeMono) {
  const vis = smoothstep(0.10, 0.32, explode);
  if (vis < 0.02) return;
  ctx.save();
  ctx.globalAlpha = vis;
  anchors.forEach((a, idx) => {
    const sx = clamp(a.sx, 140, 1780);
    const sy = clamp(a.sy, 140, 920);
    const isTop = a.side === 'top';
    const ex = clamp(sx + (idx < 3 ? 68 : -68), 160, 1760);
    const ey = isTop ? Math.max(115, sy - 115 - (idx % 2) * 32) : Math.min(720, sy + 105 + (idx % 2) * 28);
    const dir = ex >= sx ? 1 : -1;

    ctx.strokeStyle = idx === 3 ? PALETTE.vermilion : 'rgba(242, 244, 248, 0.72)';
    ctx.lineWidth = idx === 3 ? 2 : 1.25;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(ex, ey);
    ctx.lineTo(ex + dir * 188, ey);
    ctx.stroke();

    ctx.fillStyle = idx === 3 ? PALETTE.vermilion : PALETTE.iceCyan;
    ctx.beginPath();
    ctx.arc(sx, sy, 4.5, 0, Math.PI * 2);
    ctx.fill();

    const tx = dir > 0 ? ex + 10 : ex - 186;
    write(a.label, tx, ey - 10, 18, 'WX Sans', PALETTE.porcelain, 600, `cad-${a.id}`);
    writeMono(a.spec, tx, ey + 17, 13, idx === 3 ? '#FF8B73' : PALETTE.titaniumLight, 600);
  });
  ctx.restore();
}

// ── Act 07 四宇宙画风 HUD（对位 H5b 4px 十字分隔 + 四角徽章 + 0.0px 同源配准） ──
function drawAct07Hud(ctx, progress, sceneState, copy, write, writeMono) {
  const quad = Boolean(sceneState?.quadMode);
  const styleIdx = sceneState?.styleIndex ?? 0;

  if (quad) {
    // 4px 十字分隔线
    ctx.fillStyle = '#07080B';
    ctx.fillRect(958, 0, 4, 1080);
    ctx.fillRect(0, 538, 1920, 4);
    ctx.fillStyle = PALETTE.vermilion;
    ctx.fillRect(944, 538, 32, 4);
    ctx.fillRect(958, 524, 4, 32);

    const cells = [
      { x: 40, y: 78, style: ACT07_STYLES[0], badge: '01' },
      { x: 1000, y: 78, style: ACT07_STYLES[1], badge: '02' },
      { x: 40, y: 586, style: ACT07_STYLES[2], badge: '03' },
      { x: 1000, y: 586, style: ACT07_STYLES[3], badge: '04' },
    ];
    cells.forEach(c => {
      roundRect(ctx, c.x, c.y, 286, 62, 8);
      ctx.fillStyle = 'rgba(7, 8, 11, 0.72)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(242, 244, 248, 0.24)';
      ctx.lineWidth = 1;
      ctx.stroke();
      writeMono(`${c.badge} · ${c.style.en}`, c.x + 16, c.y + 24, 12, PALETTE.iceCyan, 700);
      write(c.style.name, c.x + 16, c.y + 50, 20, 'WX Sans', PALETTE.porcelain, 600, `h5b-${c.badge}`);
    });

    // 底部中央 0.0 px 配准标识（位于控制栏上方，不重叠）
    roundRect(ctx, 646, 876, 628, 48, 24);
    ctx.fillStyle = 'rgba(7, 8, 11, 0.86)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(210, 69, 44, 0.78)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    write('单一几何体 × 四套 GLSL 实时热切 · 轮廓配准 0.0 px', 960, 908, 21, 'WX Sans', PALETTE.porcelain, 600, 'h5b-banner', 'center');
  } else {
    const st = ACT07_STYLES[styleIdx] ?? ACT07_STYLES[0];
    // Beat 3 激光扫描线动画
    if (progress >= 0.68) {
      const sweepX = (((progress - 0.68) / 0.32) * 4 % 1) * 1920;
      const grad = ctx.createLinearGradient(sweepX - 70, 0, sweepX + 10, 0);
      grad.addColorStop(0, 'rgba(210, 69, 44, 0)');
      grad.addColorStop(0.85, 'rgba(210, 69, 44, 0.35)');
      grad.addColorStop(1, 'rgba(255, 110, 74, 0.95)');
      ctx.fillStyle = grad;
      ctx.fillRect(sweepX - 70, 0, 80, 1080);
    }
    const scrim = ctx.createLinearGradient(0, 670, 0, 1080);
    scrim.addColorStop(0, 'rgba(7, 8, 11, 0)');
    scrim.addColorStop(0.6, 'rgba(7, 8, 11, 0.72)');
    scrim.addColorStop(1, 'rgba(7, 8, 11, 0.88)');
    ctx.fillStyle = scrim;
    ctx.fillRect(0, 670, 1920, 410);
    const x = 86;
    ctx.save();
    ctx.shadowColor = 'rgba(4, 6, 10, 0.92)';
    ctx.shadowBlur = 16;
    ctx.fillStyle = PALETTE.vermilion;
    ctx.fillRect(x, 730, 42, 4);
    writeMono(`ACT 07  ·  ACTIVE SHADER: ${st.en}`, x + 54, 738, 16, PALETTE.iceCyan, 700);
    const tRow = copy.get('A07-title');
    const qRow = copy.get('A07-quote');
    if (tRow) write(tRow.text, x, 810, 56, tRow.font, PALETTE.porcelain, 700, tRow.id);
    if (qRow) write(qRow.text, x, 858, 24, qRow.font, '#D2D9E6', 400, qRow.id);
    ctx.restore();
  }
}

// ── Act 08 北冥导演工作台 HUD（左侧现场单文件 HTML · 右侧同源 4K MP4 · 底部电影时间轴与波形） ──
function drawAct08Workbench(ctx, progress, sceneState, copy, write, writeMono) {
  const scrub = sceneState?.scrubValue ?? progress;
  const locked = Boolean(sceneState?.camLock);

  // 中央暗黑导演视口框（3D 画面就在里面实时运转）
  ctx.strokeStyle = 'rgba(76, 224, 245, 0.35)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(430, 104, 1060, 596);
  // 视口安全框与录制红点
  ctx.fillStyle = locked ? PALETTE.vermilion : PALETTE.iceCyan;
  ctx.beginPath(); ctx.arc(458, 134, 6, 0, Math.PI * 2); ctx.fill();
  writeMono(
    locked ? 'LOCKED CINEMA CAM · 24 FPS · BT.709 4K' : 'LIVE INTERACTIVE VIEWPORT · 60 FPS WEBGL2',
    476, 140, 14, locked ? '#FF8B73' : PALETTE.iceCyan, 700
  );
  writeMono(`TC 00:03:${String(Math.floor(48 + scrub * 30)).padStart(2, '0')}:${String(Math.floor((scrub * 720) % 24)).padStart(2, '0')}`, 1468, 140, 14, PALETTE.titaniumLight, 600, 'right');

  // 左面板：现场交互控场
  roundRect(ctx, 56, 120, 344, 564, 12);
  ctx.fillStyle = 'rgba(10, 13, 20, 0.84)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(76, 224, 245, 0.38)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  writeMono('OUTPUT A · INTERACTIVE', 82, 162, 13, PALETTE.iceCyan, 700);
  write('现场交互控场', 82, 212, 34, 'WX Display', PALETTE.porcelain, 700, 'a08-left-title');
  const leftItems = [
    ['单文件离线打包', '零外链双击即开，不依赖云端'],
    ['实时响应观众', '指针、滑杆、画风热切零等待'],
    ['四档自适应', '独显满档 30k，集显自动稳帧'],
    ['三轨相位锁定', 'Web Audio 主时钟零漂移配乐'],
  ];
  leftItems.forEach(([k, v], i) => {
    const y = 278 + i * 96;
    ctx.fillStyle = 'rgba(76, 224, 245, 0.14)';
    ctx.fillRect(82, y - 22, 4, 54);
    write(k, 100, y, 22, 'WX Sans', PALETTE.porcelain, 600, `a08-l-${i}`);
    write(v, 100, y + 30, 17, 'WX Text', PALETTE.titaniumLight, 400, `a08-ld-${i}`);
  });

  // 右面板：同源直出 4K 成片
  roundRect(ctx, 1520, 120, 344, 564, 12);
  ctx.fillStyle = 'rgba(10, 13, 20, 0.84)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(210, 69, 44, 0.52)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  writeMono('OUTPUT B · BROADCAST 4K', 1546, 162, 13, PALETTE.vermilion, 700);
  write('同源直出 4K 成片', 1546, 212, 34, 'WX Display', PALETTE.porcelain, 700, 'a08-right-title');
  const rightItems = [
    ['严格确定性时钟', 'window.render(t) 逐帧可复现'],
    ['广播级色彩标准', 'BT.709 管线 · 1080p / 4K 直出'],
    ['帧级声画同步', '原声分轨与拟音无损混音导出'],
    ['中文专业排版', 'clreq 标点避头尾与字距精调'],
  ];
  rightItems.forEach(([k, v], i) => {
    const y = 278 + i * 96;
    ctx.fillStyle = 'rgba(210, 69, 44, 0.55)';
    ctx.fillRect(1546, y - 22, 4, 54);
    write(k, 1564, y, 22, 'WX Sans', PALETTE.porcelain, 600, `a08-r-${i}`);
    write(v, 1564, y + 30, 17, 'WX Text', PALETTE.titaniumLight, 400, `a08-rd-${i}`);
  });

  // 中央中文排版落版宣言（clreq 节奏）
  const tRow = copy.get('A08-title');
  if (tRow) {
    ctx.save();
    ctx.shadowColor = 'rgba(4, 6, 10, 0.92)';
    ctx.shadowBlur = 18;
    write(tRow.text, 960, 658, 48, tRow.font, PALETTE.porcelain, 700, tRow.id, 'center');
    ctx.restore();
  }

  // 底部电影时间轴面板（关键帧曲线 + 29 拍刻度 + 确定性音频波形，底部留出控制栏空隙）
  roundRect(ctx, 56, 718, 1808, 198, 12);
  ctx.fillStyle = 'rgba(10, 13, 20, 0.88)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(138, 148, 166, 0.28)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  writeMono('BEIMING TIMELINE · 10 ACTS / 29 BEATS · CAMERA SPLINE & AUDIO WAVEFORM', 84, 746, 13, PALETTE.titaniumLight, 600);
  // 29 拍刻度
  for (let i = 0; i < 29; i++) {
    const tx = 84 + (i / 28) * 1752;
    ctx.strokeStyle = i % 3 === 0 ? 'rgba(210, 69, 44, 0.8)' : 'rgba(138, 148, 166, 0.35)';
    ctx.lineWidth = i % 3 === 0 ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(tx, 760);
    ctx.lineTo(tx, i % 3 === 0 ? 782 : 772);
    ctx.stroke();
  }
  // 关键帧贝塞尔曲线
  ctx.strokeStyle = PALETTE.iceCyan;
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  for (let i = 0; i <= 80; i++) {
    const u = i / 80;
    const x = 84 + u * 1752;
    const y = 820 + Math.sin(u * Math.PI * 3.5) * 22 * Math.cos(u * Math.PI * 1.2);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  // 确定性声画波形条
  for (let i = 0; i < 140; i++) {
    const u = i / 139;
    const x = 84 + u * 1752;
    const amp = 6 + Math.abs(Math.sin(i * 0.73) * Math.cos(i * 0.29)) * 26;
    ctx.fillStyle = u <= scrub ? 'rgba(255, 184, 92, 0.82)' : 'rgba(138, 148, 166, 0.28)';
    ctx.fillRect(x, 878 - amp * 0.5, 6, amp);
  }
  // 朱红时间游标
  const headX = 84 + scrub * 1752;
  ctx.strokeStyle = PALETTE.vermilion;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(headX, 756);
  ctx.lineTo(headX, 906);
  ctx.stroke();
  ctx.fillStyle = PALETTE.vermilion;
  ctx.beginPath();
  ctx.arc(headX, 760, 7, 0, Math.PI * 2);
  ctx.fill();
}

// ── Act 09（H6）：一刀见高下——左传统白底密字 PPT vs 右北冥 3D 实时太空级 HUD（严格 1:1 共享 7 组数据） ──
function drawAct09Split(ctx, split, write, writeMono) {
  const splitX = clamp(split, 0, 1) * 1920;

  // ── 左半屏：传统白底窒息 PPT（严格 clip 到 0..splitX） ──
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, splitX, 1080);
  ctx.clip();
  ctx.fillStyle = '#F3F5F8';
  ctx.fillRect(0, 0, 1920, 1080);
  // 顶部留出深色演示壳顶栏空位（清出 26..56 CSS px 顶栏），传统幻灯片顶条从 y=92 开始
  ctx.fillStyle = '#10131A';
  ctx.fillRect(0, 0, 1920, 92);
  ctx.fillStyle = '#E1E6EE';
  ctx.fillRect(0, 92, 1920, 48);
  write('传统幻灯片 · 静态汇报模板（2027 内部评审版）', 58, 123, 19, 'WX Sans', '#5E6778', 600, 'h6-l-hdr');

  // 标题 + 同源 3 个 KPI
  write(H6_PLATFORM_DATA.title, 58, 196, 38, 'WX Display', '#1D2330', 700, 'h6-l-title');
  H6_PLATFORM_DATA.kpis.forEach((k, i) => {
    const x = 58 + i * 282;
    ctx.fillStyle = '#FFFFFF';
    ctx.strokeStyle = '#CFD6E2';
    ctx.lineWidth = 2;
    ctx.fillRect(x, 222, 264, 118);
    ctx.strokeRect(x, 222, 264, 118);
    write(k.label, x + 20, 254, 17, 'WX Sans', '#667084', 500, `h6-lk-${i}`);
    writeMono(k.value, x + 20, 298, 34, '#1E2533', 700, 'left', `h6-lv-${i}`);
    write(k.sub, x + 20, 326, 15, 'WX Text', '#838D9F', 400, `h6-ls-${i}`);
  });

  // 死板扁平饼图（42% / 28% / 19% / 11%）
  const cx = 224, cy = 502, r = 112;
  const flatColors = ['#6D7687', '#949EAE', '#B5BECB', '#D3DAE4'];
  let a0 = -Math.PI / 2;
  H6_PLATFORM_DATA.breakdown.forEach((b, i) => {
    const a1 = a0 + (b.pct / 100) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, a0, a1);
    ctx.closePath();
    ctx.fillStyle = flatColors[i];
    ctx.fill();
    ctx.strokeStyle = '#F3F5F8';
    ctx.lineWidth = 3;
    ctx.stroke();
    a0 = a1;
  });
  // 图例
  H6_PLATFORM_DATA.breakdown.forEach((b, i) => {
    const ly = 434 + i * 42;
    ctx.fillStyle = flatColors[i];
    ctx.fillRect(394, ly - 16, 18, 18);
    write(`${b.name}  ${b.pct}%`, 424, ly, 19, 'WX Sans', '#3D4656', 500, `h6-lp-${i}`);
  });

  // 密密麻麻传统表格
  const ty = 656;
  ctx.fillStyle = '#DDE3EC';
  ctx.fillRect(58, ty, 826, 38);
  ['核心模块', '算力占比', '实测算力', '互连带宽'].forEach((h, i) => {
    write(h, 76 + i * 204, ty + 26, 17, 'WX Sans', '#262E3D', 700, `h6-th-${i}`);
  });
  H6_PLATFORM_DATA.tableRows.forEach((row, rIdx) => {
    const ry = ty + 38 + rIdx * 42;
    ctx.fillStyle = rIdx % 2 === 0 ? '#FFFFFF' : '#F8FAFC';
    ctx.fillRect(58, ry, 826, 42);
    ctx.strokeStyle = '#DCE2EB';
    ctx.strokeRect(58, ry, 826, 42);
    row.forEach((cell, cIdx) => {
      write(cell, 76 + cIdx * 204, ry + 28, 17, 'WX Text', '#3C4557', 400, `h6-td-${rIdx}-${cIdx}`);
    });
  });
  write('示例数据 · 仅用于演示对比（传统扁平版）', 58, 902, 14, 'WX Text', '#8A94A6', 400, 'h6-l-foot');
  ctx.restore();

  // ── 右半屏：北冥引擎暗场 3D 太空级 HUD 浮层（严格 clip 到 splitX..1920，完全同源 7 项数据） ──
  ctx.save();
  ctx.beginPath();
  ctx.rect(splitX, 0, 1920 - splitX, 1080);
  ctx.clip();

  writeMono('BEIMING LIVE 3D ENGINE · SAME DATASET', 1846, 108, 14, PALETTE.iceCyan, 700, 'right');
  write(H6_PLATFORM_DATA.title, 1846, 158, 36, 'WX Display', PALETTE.porcelain, 700, 'h6-r-title', 'right');

  // 3 枚右侧悬浮暗玻璃 KPI 遥测卡
  H6_PLATFORM_DATA.kpis.forEach((k, i) => {
    const y = 200 + i * 126;
    roundRect(ctx, 1476, y, 370, 110, 12);
    ctx.fillStyle = 'rgba(10, 13, 20, 0.82)';
    ctx.fill();
    ctx.strokeStyle = i === 0 ? 'rgba(210, 69, 44, 0.72)' : 'rgba(76, 224, 245, 0.42)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    write(k.label, 1502, y + 32, 17, 'WX Sans', '#B8C4D8', 500, `h6-rk-${i}`);
    writeMono(k.value, 1502, y + 74, 35, i === 0 ? '#FF6B4D' : PALETTE.iceCyan, 700, 'left', `h6-rv-${i}`);
    write(k.sub, 1502, y + 98, 14, 'WX Text', PALETTE.titaniumLight, 400, `h6-rs-${i}`);
  });

  // 底部同源 4 项占比条（42% / 28% / 19% / 11%，底部留出控制栏空隙）
  roundRect(ctx, 1072, 698, 774, 198, 12);
  ctx.fillStyle = 'rgba(10, 13, 20, 0.84)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(138, 148, 166, 0.34)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  writeMono('LIVE TELEMETRY BREAKDOWN · 1:1 ALIGNED WITH LEFT SLIDE', 1098, 728, 13, PALETTE.titaniumLight, 600);
  H6_PLATFORM_DATA.breakdown.forEach((b, i) => {
    const y = 764 + i * 32;
    write(b.name, 1098, y, 17, 'WX Sans', PALETTE.porcelain, 500, `h6-rb-${i}`);
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(1276, y - 13, 420, 13);
    ctx.fillStyle = b.color;
    ctx.fillRect(1276, y - 13, 420 * (b.pct / 50), 13);
    writeMono(`${b.pct}%`, 1820, y, 17, b.color, 700, 'right', `h6-rp-${i}`);
  });
  write('示例数据 · 左右 7 项指标 100% 同源', 1846, 922, 14, 'WX Text', PALETTE.titaniumLight, 400, 'h6-r-foot', 'right');
  ctx.restore();

  // ── 中央发光朱红激光垂直分屏线 + 精密圆环手柄 ──
  const glow = ctx.createLinearGradient(splitX - 24, 0, splitX + 24, 0);
  glow.addColorStop(0, 'rgba(210, 69, 44, 0)');
  glow.addColorStop(0.5, 'rgba(210, 69, 44, 0.55)');
  glow.addColorStop(1, 'rgba(210, 69, 44, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(splitX - 24, 0, 48, 1080);

  ctx.fillStyle = PALETTE.vermilion;
  ctx.fillRect(splitX - 2.5, 0, 5, 1080);

  // 圆环拖拽手柄
  ctx.save();
  ctx.fillStyle = '#0B0D13';
  ctx.strokeStyle = PALETTE.vermilion;
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  ctx.arc(splitX, 540, 32, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  writeMono('◀ ▶', splitX, 546, 15, PALETTE.porcelain, 700, 'center');
  roundRect(ctx, splitX - 42, 584, 84, 28, 14);
  ctx.fillStyle = 'rgba(11, 13, 19, 0.88)';
  ctx.fill();
  writeMono(`${Math.round(clamp(split, 0, 1) * 100)}%`, splitX, 603, 14, PALETTE.porcelain, 700, 'center');
  ctx.restore();
}

// ── Act 10 终章 HUD（Beat 1 时间长河 · Beat 2 品牌落版 · Beat 3 玻璃回眸） ──
function drawAct10Finale(ctx, progress, t, pointer, interactive, copy, write, writeMono) {
  if (progress < 0.34) {
    // Beat 1: 时间长河回掠
    const alpha = smoothstep(0.02, 0.14, progress) * (1 - smoothstep(0.28, 0.34, progress));
    ctx.save();
    ctx.globalAlpha = alpha;
    writeMono('REWIND · ACTS 02 — 09', 960, 488, 18, PALETTE.iceCyan, 700, 'center');
    write('十幕同源三维宇宙', 960, 560, 68, 'WX Display', PALETTE.porcelain, 700, 'a10-b1', 'center');
    ctx.restore();
    return;
  }

  if (progress < 0.68) {
    // Beat 2: 极简黑曜/纯白品牌落版 + 3 组真实能力支柱
    const alpha = smoothstep(0.34, 0.44, progress) * (1 - smoothstep(0.62, 0.68, progress));
    ctx.save();
    ctx.globalAlpha = alpha;
    writeMono('WONDERX  ×  BEIMING ENGINE', 960, 326, 20, PALETTE.iceCyan, 700, 'center');
    write('告别静态幻灯片', 960, 434, 86, 'WX Display', PALETTE.porcelain, 700, 'a10-b2-t', 'center');
    write('下一场演示，交给北冥。', 960, 508, 34, 'WX Sans', '#C5CFE0', 400, 'a10-b2-s', 'center');

    const pillars = [
      { k: '单文件离线直开', v: 'ZERO-CDN HTML', d: '零外链 · 双击即演 · 全程 60 FPS 交互' },
      { k: 'GPU 规模渲染', v: '30,000 INSTANCES', d: '四档自动降级 · 0.0 px 四画风同源配准' },
      { k: '一份代码双端出片', v: 'HTML + 4K MP4', d: '台上实时控场 · 会后确定性直出 4K 成片' },
    ];
    pillars.forEach((p, i) => {
      const x = 236 + i * 504;
      roundRect(ctx, x, 594, 440, 174, 14);
      ctx.fillStyle = 'rgba(10, 13, 20, 0.78)';
      ctx.fill();
      ctx.strokeStyle = i === 1 ? 'rgba(210, 69, 44, 0.65)' : 'rgba(76, 224, 245, 0.35)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      writeMono(p.v, x + 28, 636, 15, i === 1 ? '#FF6B4D' : PALETTE.iceCyan, 700);
      write(p.k, x + 28, 686, 28, 'WX Sans', PALETTE.porcelain, 700, `a10-p-${i}`);
      write(p.d, x + 28, 730, 17, 'WX Text', PALETTE.titaniumLight, 400, `a10-pd-${i}`);
    });
    ctx.restore();
    return;
  }

  // Beat 3: 交互态由 DOM/CSS 12° 光学玻璃板承接；无头视频导出/bench 态同时绘制到 2D 画布确保画面完整
  if (!interactive) {
    const tilt = (pointer[0] - 0.5) * 18;
    ctx.save();
    ctx.translate(960, 520);
    ctx.transform(1, tilt * 0.004, -tilt * 0.006, 1, 0, 0);
    roundRect(ctx, -430, -210, 860, 420, 22);
    ctx.fillStyle = 'rgba(242, 244, 248, 0.88)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(76, 224, 245, 0.55)';
    ctx.lineWidth = 2;
    ctx.stroke();
    write('有任何问题吗？', 0, -10, 74, 'WX Display', '#0D1017', 700, 'a10-q', 'center');
    write('万物有戏 × 北冥引擎 · 实时三维点阵正在背后呼吸运转', 0, 66, 24, 'WX Sans', '#4A5466', 500, 'a10-qs', 'center');
    ctx.restore();
  }
}

// ── 页码彩蛋（SLIDE 1 / 48 -> 01 / 10 HIJACKED -> ACT 02..09 / 10 -> SLIDE 10 / 10） ──
function drawPageCounter(ctx, id, progress, writeMono, lightLeft) {
  let label = '';
  let sub = ACT_GAGS[id] ?? '';
  let accent = PALETTE.iceCyan;

  if (id === 'A01') {
    if (progress < 0.66) {
      label = 'SLIDE 1 / 48';
      sub = 'STATIC DECK';
      accent = '#737D8F';
    } else {
      label = '01 / 10';
      sub = 'HIJACKED · LIVE 3D';
      accent = PALETTE.vermilion;
    }
  } else if (id === 'A10' && progress >= 0.66) {
    label = 'SLIDE 10 / 10';
    sub = 'GLASS TILT 12°';
    accent = PALETTE.porcelain;
  } else {
    label = `ACT ${id.slice(1)} / 10`;
    accent = id === 'A09' ? PALETTE.vermilion : PALETTE.iceCyan;
  }

  roundRect(ctx, 1598, 958, 256, 56, 8);
  ctx.fillStyle = (id === 'A01' && progress < 0.66) ? 'rgba(232, 236, 242, 0.9)' : 'rgba(7, 8, 11, 0.78)';
  ctx.fill();
  ctx.strokeStyle = lightLeft ? 'rgba(210, 69, 44, 0.5)' : 'rgba(138, 148, 166, 0.34)';
  ctx.lineWidth = 1.25;
  ctx.stroke();

  writeMono(label, 1834, 983, 17, (id === 'A01' && progress < 0.66) ? '#252D3A' : PALETTE.porcelain, 700, 'right', 'page-counter');
  writeMono(sub, 1834, 1004, 11.5, accent, 700, 'right', 'page-counter-sub');
}
