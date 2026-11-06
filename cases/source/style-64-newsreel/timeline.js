// The single clock of the film. 120 BPM, 4/4: beat = 0.5 s, bar = 2.0 s.
// Every visual hit is written in beats (b) and converted here; the page imports this file,
// tools/export_timeline.mjs writes timeline.json for prep.py, mix.py and cuecheck.py.
export const BPM = 120, BEAT = 60 / BPM, BAR = 4 * BEAT, FPS = 24;
const b = k => +(k * BEAT).toFixed(4);

export const DUR = b(39.5);   // 19.75 s

export const SECS = [
  { id: 'logo',  t0: b(0),  t1: b(6) },
  { id: 'paper', t0: b(6),  t1: b(12) },
  { id: 'map',   t0: b(12), t1: b(22) },
  { id: 'grid',  t0: b(22), t1: b(26) },
  { id: 'flip',  t0: b(26), t1: b(28) },
  { id: 'hold',  t0: b(28), t1: b(30) },
  { id: 'landA', t0: b(30), t1: b(32) },
  { id: 'landB', t0: b(32), t1: DUR },
];

// visual hits (seconds). Each one must land on a music cue (tools/cuecheck.py).
export const HIT = {
  beams_on: b(0),        // carbon arc snaps, searchlights on
  logo_name: b(1),       // 千里眼 lands
  logo_iris: b(5),       // iris starts closing on the globe
  paper_fly: b(6),       // iris shut, the paper spins in
  paper_slam: b(7),      // slam + jolt
  paper_punch: b(10),    // punch-in on the headline
  flip_map: b(12),       // vertical-axis flip, map edge-on
  map_title: b(12.5),
  route0: b(13),         // route leaves Dearborn
  montreal: b(14), newyork: b(15), atlanta: b(17), stlouis: b(18), stpaul: b(19),
  home: b(20),           // back in Dearborn, odometer stops
  map_push: b(21),       // map push into Dearborn
  deal0: b(22), deal1: b(23), deal2: b(24), deal3: b(24.5), deal4: b(25), deal5: b(25.5),
  dive: b(26),           // into the last cell: flip-book
  stop: b(28),           // band stops dead; picture runs on in near-silence
  land_cut: b(30),       // first sound after the silence
  roll_cut: b(32),       // the biplane rolls in
  freeze: b(34),         // freeze + jolt
  ring_done: b(35),      // grease-pencil ring closed, label lands
  da: b(37), DA: b(38),  // "da - DA!"
};
// flip-book pages: sixteenth notes from the dive to the stop
export const PAGES = Array.from({ length: 8 }, (_, i) => +(HIT.dive + i * BEAT / 4).toFixed(4));
export const DEALS = [HIT.deal0, HIT.deal1, HIT.deal2, HIT.deal3, HIT.deal4, HIT.deal5];

// archive clips: source file, in-point (s), length (s) -> assets/<id>/NNN.jpg at 24 fps
export const CLIPS = {
  takeoff: { src: 'fc-fc-1956.mp4', in: 98.0,  dur: 4.25 },   // bright biplane flagged off, runs away
  approach:{ src: 'fc-fc-1224.mp4', in: 269.40, dur: 1.25 },   // race plane No. 6 rolls in big from the right after landing
  rollin:  { src: 'fc-fc-1224.mp4', in: 158.3, dur: 1.45, g: 0.78 },   // the biplane rolls up to the camera
};
// in-clip times (seconds after the clip's in-point)
export const FLIP_SRC = Array.from({ length: 8 }, (_, i) => +(0.75 + i * 0.3).toFixed(3));   // pages
export const HOLD_SRC0 = 3.0;      // takeoff clip time shown at HIT.stop, then real time
export const APPROACH_SRC0 = 0.0;  // at HIT.land_cut (first frame of the source shot)
export const ROLL_SRC0 = 0.4;      // at HIT.roll_cut; frozen from HIT.freeze
// grid stills (source times in fc-fc-1956.mp4); the last cell is the flip-book's first page
export const STILLS = [66.5, 79.5, 84.5, 88.0, 110.5];
export const PAPER_PHOTOS = [74.5, 93.5];

// 1929 National Air Tour route (Wikipedia, after Forden 1972), lon/lat. Key stops carry a beat time.
export const ROUTE = [
  ['迪尔伯恩', -83.18, 42.32, 'route0'], ['Windsor', -83.03, 42.31], ['Toronto', -79.38, 43.65], ['Ottawa', -75.70, 45.42],
  ['蒙特利尔', -73.57, 45.50, 'montreal'], ['Portland', -70.26, 43.66], ['Springfield', -72.59, 42.10], ['纽约', -74.00, 40.71, 'newyork'],
  ['Philadelphia', -75.16, 39.95], ['Baltimore', -76.61, 39.29], ['Richmond', -77.44, 37.54], ['Winston-Salem', -80.24, 36.10],
  ['Greenville', -82.39, 34.85], ['Augusta', -81.97, 33.47], ['Jacksonville', -81.66, 30.33], ['Macon', -83.63, 32.84],
  ['Atlanta', -84.39, 33.75, 'atlanta'], ['Nashville', -86.78, 36.16], ['Cincinnati', -84.51, 39.10], ['Louisville', -85.76, 38.25],
  ['St. Louis', -90.20, 38.63, 'stlouis'], ['Springfield MO', -93.29, 37.21], ['Wichita', -97.34, 37.69], ['St. Joseph', -94.85, 39.77],
  ['Des Moines', -93.61, 41.59], ['Cedar Rapids', -91.67, 41.98], ['St. Paul', -93.09, 44.95, 'stpaul'], ['Wausau', -89.63, 44.96],
  ['Milwaukee', -87.91, 43.04], ['Moline', -90.52, 41.51], ['Chicago', -87.63, 41.88], ['Kalamazoo', -85.59, 42.29],
  ['迪尔伯恩', -83.18, 42.32, 'home'],
];
export const MILES = 5107;   // "the 5,107 mile tour" (Brownsville Herald, 5 Oct 1929, AP)
export const LABELS = { route0: '迪尔伯恩', montreal: '蒙特利尔', newyork: '纽约' };
export const TL = { BPM, BEAT, BAR, FPS, DUR, SECS, HIT, PAGES, DEALS, CLIPS, FLIP_SRC, HOLD_SRC0, APPROACH_SRC0, ROLL_SRC0, STILLS, PAPER_PHOTOS, ROUTE, MILES, LABELS };
