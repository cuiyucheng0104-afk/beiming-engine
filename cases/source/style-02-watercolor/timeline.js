// 唯一时间源：速度表 + 拍点。页面（render/EV）、配乐（mix.py）、核对脚本（cuecheck.py）都读这里。
// 浏览器里是 window.TL；tools/tl2json.mjs 把它导出成 timeline.json 给 Python。
(function (g) {
  const FPS = 60, DUR = 19.0;
  const SECS = [
    { id: 'A', name: '滴落', t: 0.0, bpm: 80, beats: 4 },
    { id: 'B', name: '成鱼', t: 3.0, bpm: 80, beats: 8 },
    { id: 'C', name: '四季', t: 9.0, bpm: 120, beats: 8 },
    { id: 'D', name: '屏息', t: 13.0, bpm: 120, beats: 2 },
    { id: 'E', name: '跃起与雾', t: 14.0, bpm: 80, beats: 6 },
  ];
  const S = Object.fromEntries(SECS.map(s => [s.id, s]));
  const at = (id, beat) => +(S[id].t + beat * 60 / S[id].bpm).toFixed(6);
  // 视觉关键事件 ↔ 音乐拍点（段, 拍）
  const HIT = {
    drop: ['A', 1], note1: ['A', 2],
    head: ['B', 0], eye: ['B', 1], flick1: ['B', 2],
    leaf1: ['B', 3], leaf2: ['B', 4], leaf3: ['B', 5], leaf4: ['B', 6], note2: ['B', 5], gear: ['B', 6],
    spring: ['C', 0], spring2: ['C', 1], summer: ['C', 2], summer2: ['C', 3],
    autumn: ['C', 4], autumn2: ['C', 5], winter: ['C', 6], winter2: ['C', 7],
    dive: ['D', 0], hush: ['D', 0.5],
    leap: ['E', 0], burst: ['E', 1], bloom: ['E', 2], mist: ['E', 3], seal: ['E', 4],
  };
  const T = Object.fromEntries(Object.entries(HIT).map(([k, [id, b]]) => [k, at(id, b)]));
  // 摆尾时刻：B2 起每 0.75 s，B6（7.5 s，三连音换挡）起每 0.5 s，到 D0 为止
  const FLICKS = [];
  for (let b = 2; b < 6; b++) FLICKS.push(at('B', b));
  for (let x = at('B', 6); x < T.dive - 1e-6; x += 0.5) FLICKS.push(+x.toFixed(6));
  // 结尾水珠落回（E 段 1/3 拍 = 0.25 s 网格，都是整数帧）
  const DROPS = [15.0, 15.25, 15.5, 15.75, 16.0];
  const TL = { FPS, DUR, SECS, HIT, T, at, FLICKS, DROPS };
  if (typeof module !== 'undefined' && module.exports) module.exports = TL; else g.TL = TL;
})(typeof window !== 'undefined' ? window : globalThis);
