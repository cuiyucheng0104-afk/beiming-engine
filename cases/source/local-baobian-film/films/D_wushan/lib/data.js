// 《豹变》D 雾山 · 资产清单 → 片中要用的量（姿态框、梯度映射阈值、关键点、眼孔、天际线……）
// 全部来自 assets/manifest.json（资产角色量好的数），单位：原图像素（y 向下）。
export async function loadManifest() {
  const man = await (await fetch('./assets/manifest.json')).json();
  const by = Object.fromEntries(man.map(e => [e.id, e]));
  const rectOf = b => [b.px[0], b.px[1], b.px[2] - b.px[0], b.px[3] - b.px[1]];
  const ell = e => e ? [e.center_px[0], e.center_px[1], e.r_px[0] * 1.15, e.r_px[1] * 1.15] : null;
  const M = {};
  // 返修 4：躯干胶囊（环斑区）——颈根 → 尾根，半径取脊线到腹线的平均距离 × 0.62
  const torsoOf = k => {
    if (!k.neck_root || !k.tail_root || !k.spine || !k.belly_line) return null;
    const A = k.neck_root.px, B = k.tail_root.px, sp = k.spine.px || k.spine, bl = k.belly_line.px || k.belly_line;
    const mid = (P) => P.reduce((s, q) => [s[0] + q[0] / P.length, s[1] + q[1] / P.length], [0, 0]);
    const ms = mid(sp), mb = mid(bl), r = Math.hypot(ms[0] - mb[0], ms[1] - mb[1]) * .62;
    const a = [A[0] + (B[0] - A[0]) * .12, A[1] + (B[1] - A[1]) * .12], b = [B[0] + (A[0] - B[0]) * .06, B[1] + (A[1] - B[1]) * .06];
    const c = [(ms[0] + mb[0]) / 2, (ms[1] + mb[1]) / 2], ab = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const sh = [c[0] - ab[0], c[1] - ab[1]];      // 胶囊轴挪到脊线与腹线的中间
    return { a: [a[0] + sh[0], a[1] + sh[1]], b: [b[0] + sh[0], b[1] + sh[1]], r };
  };
  const leoPoses = entry => {
    const out = {};
    for (const p of entry.poses) {
      const k = p.keypoints;
      out[p.name] = {
        rect: rectOf(p.bbox), thr: p.tones.thresholds_Y, cell: p.spot_unit_px,
        neck_root: k.neck_root.px, head_center: k.head_center.px, ear_l: (k.ear_l || k.ear).px, ear_r: (k.ear_r || k.ear).px,
        tail_root: k.tail_root.px, tail_tip: k.tail_tip.px, belly: k.belly.px,
        eye: k.eye ? ell(k.eye) : null, ex0: ell(k.muzzle), ex1: null,
        torso: torsoOf(k),
      };
    }
    return out;
  };
  M.leoSitPoses = leoPoses(by.A01);
  M.leoLeapPoses = leoPoses(by.A02);
  {
    const e = by.A03, k = e.keypoints;
    M.leoHead = { rect: [0, 0, e.尺寸[0], e.尺寸[1]], thr: [e.tones.thresholds_Y[0], .34, e.tones.thresholds_Y[2]], cell: 150,   // 返修 4：影档收窄（颊上那块软灰不再映成整块暗石板色）
     
      eye: [k.eye.center_px[0], k.eye.center_px[1], k.eye.r_px[0], k.eye.r_px[1]], eyeTilt: k.eye.tilt_deg * Math.PI / 180,
      ex0: ell(k.muzzle), ex1: null, cornea: e.cornea_px, iris: k.iris_center.px, irisR: e.iris_r.px, pupil: k.pupil.center_px, pupilR: k.pupil.r_px,
      head_center: k.head_center.px, neck_root: k.neck_root.px, ear: k.ear.px, nose: k.nose.px };
  }
  M.luKeys = by.A05.keypoints && Object.fromEntries(Object.entries(by.A05.keypoints).map(([n, v]) => [n, v.px]));
  {
    const e = by.A06;
    M.desk = { lensEdge: e.lens_edge_px, rim: e.lens_rim_polyline.px, keys: Object.fromEntries(Object.entries(e.keypoints).map(([n, v]) => [n, v.px])) };
  }
  M.handsDesk = by.A07.poses.map(p => ({ rect: rectOf(p.bbox), keys: Object.fromEntries(Object.entries(p.keypoints).filter(([, v]) => v && v.px).map(([n, v]) => [n, v.px])) }));
  M.handsSide = by.A08.poses.map(p => ({ rect: rectOf(p.bbox), keys: Object.fromEntries(Object.entries(p.keypoints).filter(([, v]) => v && v.px).map(([n, v]) => [n, v.px])) }));
  M.vendor = Object.fromEntries(Object.entries(by.A09.keypoints).map(([n, v]) => [n, v.px]));
  M.mask = { holes: by.A10.eye_holes, hang: by.A10.keypoints.hang_point.px, rim: by.A10.keypoints.lower_rim_center.px };
  M.pano = { notch: by.A12.v_notch.px, skyline: by.A12.skyline.every_16px, sky: by.A12.sky_color };
  M.market = { glow: by.A13.vanishing_glow.px };
  M.book = by.R01.pages;
  M.deer = by.R02.deer.map(d => ({ rect: [d.bbox.px[0], d.bbox.px[1], d.bbox.px[2] - d.bbox.px[0], d.bbox.px[3] - d.bbox.px[1]], waist: d.waist_y_px }));
  M.deskTop = by.A11.objects;
  // 返修 4（w3）：手绘卡片的锚点（原图像素，y 向下），原样交给各镜头
  M.env = {};
  for (const id of ['A16', 'A17', 'A18', 'A19', 'A20', 'A21', 'A22', 'A23', 'A24']) M.env[id] = by[id] ? by[id].anchors : null;
  M.leoBack = by.A15 ? { keys: Object.fromEntries(Object.entries(by.A15.keypoints || {}).map(([n, v]) => [n, v.px || v])), spine: by.A15.spine, pxcm: by.A15.px_per_cm, tones: by.A15.tones } : null;
  M.raw = by;
  return M;
}
