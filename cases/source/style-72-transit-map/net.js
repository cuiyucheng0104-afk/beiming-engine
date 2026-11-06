// 《十年》 TEN YEARS — a fictional network: one person's decade drawn as a metro schematic (eight directions only).
// Units: G = 1 grid step = 100 world units; x grows east, y grows south.
// Route items: 'ID' = the station's point; ['ID', dx, dy] = that station, offset for this line; [x, y] = a bend.
// Stations: [x, y, native, second, tier] — tier 1 hub (label at every zoom), 2 interchange, 3 named stop.
(function () {
const G = 100;
const ST = {
  // ---- 1 号线 · 自己 (2016)
  BY:  [2.0, 11.0, '毕业', 'Graduation', 1],
  CZW: [3.4, 11.0, '出租屋', 'First Flat', 1],
  ZBC: [4.25, 10.15, '早班车', 'Early Bus', 3],
  DYF: [5.1, 9.3, '第一份工', 'First Job', 3],
  JB:  [6.2, 9.3, '加班', 'Late Nights', 3],
  XY:  [7.3, 9.3, '相遇', 'Met You', 1],
  SZ:  [8.5, 9.3, '升职', 'Promotion', 3],
  JBN: [10.3, 9.3, '江边', 'Riverside', 3],
  // ---- 2 号线 · 你 (2018)
  SD:  [7.3, 4.2, '书店', 'Bookshop', 3],
  KFG: [7.3, 5.4, '咖啡馆', 'Café', 3],
  YT:  [7.3, 6.6, '雨天', 'Rainy Day', 2],
  DYY: [7.3, 7.9, '电影院', 'Cinema', 3],
  TJ:  [7.3, 10.5, '同居', 'Moving In', 3],
  HL:  [8.15, 11.35, '婚礼', 'Wedding', 1],
  NM:  [8.15, 12.55, '南门', 'South Gate', 2],
  // ---- 3 号线 · 远方 (2021)
  GB:  [9.45, 11.35, '告别', 'Farewell', 3],
  XC:  [13.4, 11.35, '新城', 'New City', 3],
  XJ:  [14.95, 9.8, '新家', 'New Home', 1],
  // ---- 环线 · 家 (2026)
  FMJ: [3.4, 8.6, '父母家', "Parents'", 3],
  LY:  [12.9, 6.6, '老友', 'Old Friends', 3],
  XQ:  [5.6, 12.55, '小区', 'Our Block', 3],
  HZ:  [12.9, 12.55, '孩子', 'Our Kid', 3],
};

// invented network: hues spaced around the wheel at similar weight; red (the oldest line) is the story's accent
const LINES = [
  { id: '1', color: '#E3002B', route: ['BY', 'CZW', 'ZBC', 'DYF', 'JB', 'XY', 'SZ', 'JBN'] },
  { id: '2', color: '#0A6CB4', route: ['SD', 'KFG', 'YT', 'DYY', 'XY', 'TJ', 'HL', 'NM'] },
  { id: '3', color: '#00975A', route: ['HL', 'GB', 'XC', 'XJ'] },
  // the ring: out of 出租屋 northwards, across the river on a bridge, through 新家 and back along the south
  { id: 'R', color: '#7E3F98', bullet: '环', loop: true, bridge: true, route: [
    'CZW', 'FMJ', [3.4, 7.6], [4.4, 6.6], 'YT', 'LY', [14.0, 6.6], [15.15, 7.75], ['XJ', 0.2, 0], [15.15, 11.6], [14.2, 12.55],
    'HZ', 'NM', 'XQ', [4.25, 12.55], [3.4, 11.7], 'CZW'] },
];

// 那条江: one river held to the eight directions, crossing the sheet north to south
const RIVER = [[12.3, 1.0], [12.3, 5.0], [11.3, 6.0], [11.3, 13.6], [12.3, 14.6], [12.3, 17.0]];

function pt(it) {
  if (typeof it === 'string') { const s = ST[it]; if (!s) throw new Error('no station ' + it); return [s[0], s[1]]; }
  if (typeof it[0] === 'string') { const s = ST[it[0]]; if (!s) throw new Error('no station ' + it[0]); return [s[0] + it[1], s[1] + it[2]]; }
  return [it[0], it[1]];
}
const sid = it => typeof it === 'string' ? it : (typeof it[0] === 'string' ? it[0] : null);
// between two points that are not on one of the 8 directions, insert a bend (straight first, or diagonal first after '/')
function expand(route) {
  const out = [], ids = []; let diagFirst = false;
  for (const it of route) {
    if (it === '/') { diagFirst = true; continue; }
    const p = pt(it);
    if (out.length) {
      const a = out[out.length - 1], dx = p[0] - a[0], dy = p[1] - a[1], ax = Math.abs(dx), ay = Math.abs(dy);
      if (ax > 1e-6 && ay > 1e-6 && Math.abs(ax - ay) > 1e-6) {
        const d = Math.min(ax, ay), sx = Math.sign(dx), sy = Math.sign(dy);
        out.push(diagFirst ? [a[0] + sx * d, a[1] + sy * d] : [p[0] - sx * d, p[1] - sy * d]); ids.push(null);
      }
    }
    out.push(p); ids.push(sid(it)); diagFirst = false;
  }
  return { pts: out, ids };
}
// validate: every segment of every route is at 0 / 45 / 90 degrees
for (const L of LINES) { const p = expand(L.route).pts; for (let i = 1; i < p.length; i++) { const dx = Math.abs(p[i][0] - p[i - 1][0]), dy = Math.abs(p[i][1] - p[i - 1][1]);
  if (dx > 1e-6 && dy > 1e-6 && Math.abs(dx - dy) > 1e-6) throw new Error('off-grid segment on line ' + L.id + ' at ' + i); } }
const WATER = [{ id: 'river', line: RIVER, outer: 1.05, inner: 1.0, tunnel: true }];
const LINKS = [];
window.NET = { G, ST, LINES, WATER, LINKS, pt, sid, expand };
})();
