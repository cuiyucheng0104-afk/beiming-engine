// 《齿轮熔炉》· 小件：一张张像素片（工具、表、阀、灯、铁锭、火、蒸汽、电弧、铁链、标牌、前景剪影……），全用 metal.js 的板金法画。
// parts() 返回 { 名字: canvas }，arena.js 把它们拼成一张图集、按名字取。softs() 是给叠加层用的软边图（光晕、光柱、烟尘）。
// 受光的片（工具、架子、桶）描一圈暗边；发光的片（火、灯芯、电弧、表盘的青光）不描边，直接给亮度。每米 48 像素。
import { Sheet, jit, cloud, turb, soft } from './metal.js';
import { gear } from './plates.js';

const sh = (w, h, fn) => { const s = new Sheet(w, h); fn(s); return s; };
const mk = (w, h, fn, rim = true) => { const s = sh(w, h, fn); if (rim) s.rim(); return s.bake(); };
// 字符画用的色键：大写是亮的一级，小写是暗的一级
const K = { H: ['steel', .92], h: ['steel', .62], s: ['steel', .38], d: ['iron', .2], I: ['iron', .55], i: ['iron', .36], B: ['brass', .88], b: ['brass', .58], q: ['brass', .3], C: ['copper', .78], c: ['copper', .5], o: ['copper', .28],
  W: ['wood', .74], w: ['wood', .5], v: ['wood', .28], K: ['coal', .34], k: ['coal', .1], R: ['red', .78], r: ['red', .5], T: ['teal', .86], t: ['teal', .5], Y: ['hazard', .86], y: ['hazard', .58], E: ['enamel', .94], e: ['enamel', .66],
  F: ['fire', .96], f: ['fire', .62], u: ['rust', .46], G: ['glass', .82], g: ['glass', .5], p: ['patina', .52], X: ['hide', .74], x: ['hide', .48], n: ['water', .5], N: ['water', .8] };
const art = (rows, rim = true, pad = rim ? 1 : 0) => mk(Math.max(...rows.map(r => r.length)) + pad * 2, rows.length + pad * 2, s => s.glyph(pad, pad, rows, K), rim);
const dith = (x, y) => (((x + 2 * y) % 5) + .5) / 5;

export function parts() {
  const P = {};

  // —— 散在地上的工具和零碎（平放）——
  P.wrench = art(['.hh................hh.', 'hH..hhhhhhhhhhhhhhhH.h', 'hs..sssssssssssssshs.h', '.ss................ss.']);
  P.pliers = art(['hh............', '.hhs.....rrrr.', '...hhhs.rRRRrr', '....shhs......', '..sss.hh.rrrr.', 'ss.....srRRRrr']);
  P.hammer = art(['.hhhh.............', 'hHHHhwwwwwwwwwwwww', 'hhhhsWWWWWWWWWWwwv', '.ssss.............']);
  P.bolts = art(['.bb.....hh...', 'bBkb...hHkh..', '.bb..bb.hh.hh', '....bBkb..hHk', '.....bb....hh']);
  P.chainCoil = mk(20, 11, s => { for (let k = 0; k < 5; k++) s.ring(5 + k * 2.4, 5 + (k % 2 ? 1 : -1) * 1.2, 2, 4, 'iron', .4 + k * .03); });
  P.coalBits = mk(22, 11, s => { for (let k = 0; k < 9; k++) s.disc(3 + jit(k, 1, 4) * 16, 3 + jit(k, 2, 4) * 5, 1.2 + jit(k, 3, 4) * 1.6, 'coal', .32, .3); });
  P.oilStain = mk(34, 20, s => s.each((x, y) => { const d = Math.hypot((x - 17) / 16, (y - 10) / 9) + (cloud(x / 5, y / 5, 3) - .5) * .7; return d < .8 ? ['coal', .1 + (d < .4 ? .1 * cloud(x / 3, y / 3, 8) : 0)] : null; }), false);
  P.scrap = mk(36, 20, s => { s.panel(3, 10, 16, 8, 'rust', .4, { edge: .14, rivet: -1 }); s.bar(8, 16, 30, 6, 2, 'iron', .4); s.ring(26, 12, 3, 6, 'iron', .42); s.bar(2, 17, 20, 3, 1.2, 'steel', .5); s.panel(18, 12, 12, 7, 'iron', .32, { edge: .14 }); s.ring(10, 8, 2, 4.5, 'brass', .5); });
  P.rails = mk(34, 12, s => { for (let k = 0; k < 5; k++) s.bar(2, 2 + k * 2, 31, 2 + k * 2, 1, 'steel', .44 + (k % 2) * .08); }, true);
  P.cog8 = gear(8, { ink: 'brass', seed: 3 }); P.cog10 = gear(10, { ink: 'iron', seed: 5 }); P.cog14 = gear(14, { ink: 'copper', seed: 7 }); P.cog20 = gear(20, { ink: 'iron', seed: 9 });
  P.drain = mk(28, 28, s => { s.panel(0, 0, 28, 28, 'iron', .3, { edge: .16, rivet: -1 }); s.each((x, y) => x > 4 && x < 23 && y > 4 && y < 23 ? (x % 4 < 2 ? ['fire', .34 + .3 * cloud(x / 4, y / 4, 6)] : ['iron', .22]) : null); }, false);
  P.hazTape = mk(48, 8, s => s.each((x, y) => (x + y) % 12 < 6 ? ['hazard', .5 - y * .02] : ['coal', .16]), false);

  // —— 立着的小件 ——
  P.bucket = art(['..dddddddd..', '.d........d.', 'd..........d', 'IIIIIIIIIIii', 'iKkKkkKkkKkd', '.IHIiiiiidd.', '.IHIiiiiidd.', '.bBbbbbbbqq.', '..IHiiiidd..', '..IHiiiidd..', '..bBbbbbqq..', '...Iiiidd...']);
  P.oilcan = art(['........bb....', '.......b..b...', '..bb..b....bb.', '.bBBbb......b.', '.bBbbbb.......', 'bBBbbbbq......', 'bBbbbbbq......', 'bBbbbbqq......', 'bbbbbqqq......', '.qqqqqq.......']);
  P.shovel = mk(11, 38, s => { s.bar(5, 3, 5, 26, 1, 'wood', .52); s.rect(2, 1, 7, 2, 'wood', .66); s.each((x, y) => y >= 25 && y < 36 && Math.abs(x - 5) <= (y < 33 ? 4 : 36 - y) ? ['steel', .56 - Math.abs(x - 4) * .05 - (y - 25) * .012] : null); });
  P.tongs = mk(11, 36, s => { s.bar(3, 2, 6, 24, .8, 'iron', .46); s.bar(8, 2, 5, 24, .8, 'iron', .38); s.bar(6, 24, 2, 33, .9, 'iron', .46); s.bar(5, 24, 9, 33, .9, 'iron', .38); s.disc(5.5, 24, 1.5, 'brass', .6); });
  P.sledge = mk(16, 34, s => { s.bar(8, 2, 8, 26, 1.1, 'wood', .54); s.panel(2, 24, 13, 8, 'steel', .5, { edge: .2 }); s.rect(2, 27, 13, 1, 'steel', .3); });
  P.sack = mk(22, 18, s => { s.each((x, y) => { const d = Math.hypot((x - 11) / 10, (y - 11) / 7.5); return d < 1 ? ['hide', .44 + .2 * (1 - d) - (x - 11) * .012 - (y - 11) * .02 + ((x + y * 2) % 5 === 0 ? -.06 : 0)] : null; }); s.rect(7, 1, 8, 4, 'coal', (i, j) => .16 + jit(i, j, 2) * .3); s.rect(6, 4, 10, 1, 'wood', .7); });
  P.anvil = mk(34, 28, s => { s.panel(9, 17, 17, 10, 'wood', .42, { edge: .14 }); for (let x = 12; x < 26; x += 4) s.rect(x, 18, 1, 8, 'wood', .28); s.rect(9, 20, 17, 1, 'iron', .4);
    s.glyph(2, 3, ['....hHHHHHHHHHHHHHHHHHHHHHh...', 'hhhhHhhhhhhhhhhhhhhhhhhhhhhhh.', '.sshhhhhhhhhhhhhhhhhhhhhhhhhs.', '....ssshhhhhhhhhhhhhhsss......', '.........shhhhhhhss...........', '.........shHhhhhhs............', '.........shHhhhhhs............', '........sshHhhhhhss...........', '......sshhhhhhhhhhhss.........', '......ddddddddddddddd.........', '..............................', '..............................', '..............................', '..............................'], K); });
  P.toolrack = mk(50, 46, s => { s.panel(1, 1, 48, 30, 'wood', .4, { edge: .14 }); for (let y = 8; y < 30; y += 8) s.rect(2, y, 46, 1, 'wood', .24); s.rect(4, 31, 3, 14, 'wood', .36); s.rect(43, 31, 3, 14, 'wood', .36); s.rect(1, 4, 48, 2, 'iron', .46);
    s.bar(8, 7, 8, 24, 1, 'steel', .56); s.ring(8, 26, 1, 3.2, 'steel', .56); s.ring(8, 7, 1, 2.6, 'steel', .5);                    // 扳手
    s.bar(15, 6, 15, 22, 1, 'wood', .6); s.panel(12, 6, 7, 5, 'steel', .5, { edge: .2 });                                               // 锤
    s.bar(22, 6, 24, 26, .8, 'iron', .5); s.bar(26, 6, 24, 26, .8, 'iron', .4);                                                        // 钳
    s.ring(33, 12, 2, 5.5, 'brass', .56); s.bar(33, 6, 33, 8, .6, 'iron', .4);                                                         // 一个小齿圈
    s.bar(41, 6, 41, 25, 1.2, 'iron', .44); s.rect(39, 24, 5, 4, 'red', .56);                                                          // 大号螺丝刀
    for (let k = 0; k < 4; k++) s.ring(31 + k * 1.5, 22 + (k % 2) * 2, 1, 2.4, 'iron', .42); });                                       // 一截链
  P.bench = mk(58, 34, s => { s.panel(1, 12, 56, 5, 'wood', .52, { edge: .16 }); s.rect(4, 17, 3, 16, 'iron', .34); s.rect(51, 17, 3, 16, 'iron', .34); s.panel(7, 25, 44, 3, 'wood', .36, { edge: .1 }); s.panel(28, 17, 16, 7, 'wood', .42, { edge: .12 }); s.disc(36, 20, 1.2, 'brass', .7);
    s.glyph(5, 4, ['.hHh....', '.hhs....', 'hHhhhhhs', 'hhhs.sss', '.ss.....', 'dddd....', 'hhhhs...', '.ss.....'], K);                // 台钳
    s.rect(20, 9, 14, 3, 'water', (i, j) => .5 + (i % 4 === 0 ? .3 : 0)); s.rect(20, 8, 14, 1, 'enamel', .8);                            // 一张蓝图
    s.glyph(40, 3, ['..gg..', '..gG..', '.gGGg.', '.gGgg.', '.gGgg.', '.gGgg.', '.gGgg.', '.gggg.', '.bbbb.'], K);                     // 一只瓶
    s.bar(10, 21, 22, 21, 1, 'steel', .5); s.ring(12, 29, 1, 2.6, 'brass', .5); s.ring(18, 30, 1, 2, 'iron', .46); });
  P.wheelbarrow = mk(40, 24, s => { s.each((x, y) => y >= 4 && y < 14 && x >= 6 + (y - 4) * .5 && x < 34 - (y - 4) * .3 ? ['iron', .42 - (y - 4) * .02 + (y === 4 ? .2 : 0)] : null); s.rect(8, 2, 22, 3, 'coal', (i, j) => .14 + jit(i, j, 3) * .32);
    s.bar(30, 9, 38, 5, .9, 'wood', .56); s.ring(11, 18, 1.5, 5, 'iron', .4); s.disc(11, 18, 1.4, 'brass', .6); s.bar(26, 14, 28, 22, .8, 'iron', .36); s.wear('rust', .66, 5, 4, -.05); });
  P.grindstone = mk(30, 30, s => { s.bar(5, 28, 12, 13, 1.2, 'wood', .46); s.bar(25, 28, 18, 13, 1.2, 'wood', .4); s.rect(3, 27, 24, 2, 'wood', .36); s.disc(15, 12, 10, 'stone', .56, .3); s.ring(15, 12, 9, 10.5, 'stone', .36, .2); s.disc(15, 12, 2.2, 'iron', .5); s.bar(15, 12, 24, 9, .7, 'iron', .5); s.disc(24, 9, 1.2, 'wood', .7); });
  P.boltBox = mk(22, 14, s => { s.panel(1, 4, 20, 9, 'wood', .46, { edge: .16 }); s.rect(1, 8, 20, 1, 'wood', .26); for (let k = 0; k < 10; k++) s.disc(3 + jit(k, 1, 9) * 15, 3 + jit(k, 2, 9) * 2.4, 1.4, k % 3 ? 'brass' : 'steel', .56, .4); });
  P.spool = mk(26, 24, s => { s.rect(6, 5, 14, 15, 'copper', (i, j) => [.74, .5, .3][j % 3]); s.panel(2, 1, 22, 4, 'wood', .56, { edge: .16 }); s.panel(2, 20, 22, 3, 'wood', .44, { edge: .14 }); });
  P.pipeStack = mk(34, 22, s => { for (const [x, y] of [[6, 16], [17, 16], [28, 16], [11.5, 8], [22.5, 8]]) { s.ring(x, y, 2.4, 5.4, 'iron', .46, .22); s.disc(x, y, 2.4, 'coal', .08, 0); } });
  P.ladder = mk(18, 96, s => { for (const x of [2, 15]) s.rect(x, 0, 2, 96, 'iron', (i, j) => i ? .28 : .5); for (let y = 4; y < 96; y += 8) { s.rect(4, y, 11, 1, 'iron', .56); s.rect(4, y + 1, 11, 1, 'iron', .26); } });
  P.whistle = art(['..bb..', '.bBBb.', '.bBbq.', '..bq..', '.bBbq.', '.bBbq.', '.bBbq.', '.bbqq.', '..bq..', '..bq..']);
  P.vent = art(['.IIIIII.', 'IHIiiiid', 'IkkkkkKd', 'IkkkkkKd', '.iddddd.']);

  // —— 表、阀、闸、配电箱、牌子 ——
  P.gaugeRim = mk(19, 19, s => { s.ring(9, 9, 6, 8.6, 'brass', .6, .26); s.rect(8, 17, 3, 2, 'brass', .4); });
  P.dialW = mk(13, 13, s => { s.disc(6, 6, 6.4, 'enamel', .78, .1); for (let k = 0; k < 9; k++) { const a = Math.PI * (.9 + k * .15); s.dot(6 + Math.cos(a) * 5, 6 + Math.sin(a) * 5, 'coal', .1); } s.dot(8, 9, 'red', .6).dot(9, 9, 'red', .6); }, false);
  P.dialT = mk(13, 13, s => { s.disc(6, 6, 6.4, 'teal', .6, .16); for (let k = 0; k < 9; k++) { const a = Math.PI * (.9 + k * .15); s.dot(6 + Math.cos(a) * 5, 6 + Math.sin(a) * 5, 'teal', 1); } }, false);
  P.dialR = mk(13, 13, s => { s.disc(6, 6, 6.4, 'fire', .46, .16); for (let k = 0; k < 9; k++) { const a = Math.PI * (.9 + k * .15); s.dot(6 + Math.cos(a) * 5, 6 + Math.sin(a) * 5, 'fire', 1); } }, false);
  P.needle = mk(3, 9, s => { s.rect(1, 0, 1, 7, 'coal', .04); s.rect(0, 6, 3, 3, 'red', .5); }, false);
  P.needleW = mk(3, 9, s => { s.rect(1, 0, 1, 7, 'enamel', 1); s.rect(0, 6, 3, 3, 'brass', .9); }, false);
  const wheel = ink => mk(17, 17, s => { s.ring(8, 8, 5.4, 7.6, ink, .56, .26); for (let k = 0; k < 4; k++) { const a = k * Math.PI / 2 + .5; s.bar(8, 8, 8 + Math.cos(a) * 6, 8 + Math.sin(a) * 6, .7, ink, .46); } s.disc(8, 8, 2, 'brass', .62, .3); });
  P.valve = wheel('red'); P.valveB = wheel('brass'); P.valveT = wheel('teal');
  P.lever = art(['..RR....', '..RR....', '...h....', '...h....', '....h...', '....h...', '..IhII..', '.IIIIid.', '.IHiidd.', '.Iiiidd.', '.iddddd.']);
  P.fusebox = mk(24, 32, s => { s.panel(1, 1, 22, 26, 'iron', .36, { edge: .16, rivet: -1 }); s.rect(4, 4, 16, 5, 'hazard', (i, j) => (i + j) % 6 < 3 ? .56 : -1); s.each((x, y) => y >= 4 && y < 9 && x >= 4 && x < 20 && (x - 4 + y - 4) % 6 >= 3 ? ['coal', .14] : null);
    for (let k = 0; k < 3; k++) { s.rect(5 + k * 5, 12, 3, 6, 'coal', .1); s.rect(5 + k * 5, k === 1 ? 15 : 12, 3, 3, 'brass', .66); } s.rect(4, 21, 16, 3, 'coal', .08); s.bar(8, 27, 8, 31, .8, 'copper', .5); s.bar(15, 27, 16, 31, .8, 'copper', .42); });
  P.ledT = mk(3, 3, s => s.rect(0, 0, 3, 3, 'teal', (i, j) => i === 1 && j === 1 ? 1 : .72), false);
  P.ledR = mk(3, 3, s => s.rect(0, 0, 3, 3, 'red', (i, j) => i === 1 && j === 1 ? .95 : .62), false);
  P.ledA = mk(3, 3, s => s.rect(0, 0, 3, 3, 'fire', (i, j) => i === 1 && j === 1 ? 1 : .7), false);
  P.signHaz = mk(17, 16, s => s.each((x, y) => { const hw = (y + 1) * .56; return Math.abs(x - 8) > hw ? null : Math.abs(x - 8) > hw - 2 || y > 12 ? ['coal', .12] : (x === 8 && y > 4 && y < 10) || (x === 8 && y === 11) ? ['coal', .1] : ['hazard', .62]; }));
  P.signBolt = mk(16, 20, s => { s.panel(1, 1, 14, 18, 'soot', .3, { edge: .2, rivet: -1, pad: 2 }); s.glyph(4, 4, ['....TT', '...TT.', '..TT..', '.TTTTT', '...TT.', '..TT..', '.TT...', 'TT....'].map(r => r), K); });
  P.signFlame = mk(16, 20, s => { s.panel(1, 1, 14, 18, 'soot', .3, { edge: .2, rivet: -1, pad: 2 }); s.glyph(4, 4, ['...R....', '..RR....', '..RRR.R.', '.RRFRRR.', '.RFFRRR.', 'RRFFFRR.', 'RRFFFRR.', '.RRFRR..'], K); });
  P.plate07 = mk(22, 12, s => { s.panel(1, 1, 20, 10, 'enamel', .6, { edge: .14 }); s.glyph(4, 3, ['kkk.kkk', 'k.k...k', 'k.k..k.', 'k.k.k..', 'kkk.k..'], K); s.rivet(2, 2, .2).rivet(18, 2, .2); });
  P.clock = mk(22, 22, s => { s.ring(10.5, 10.5, 7.5, 10.4, 'brass', .6, .28); s.disc(10.5, 10.5, 7.6, 'enamel', .8, .1); for (let k = 0; k < 12; k++) s.dot(10.5 + Math.cos(k * .5236) * 6, 10.5 + Math.sin(k * .5236) * 6, 'coal', .1); s.line(10.5, 10.5, 10.5, 5, 'coal', .08); s.line(10.5, 10.5, 14, 12, 'coal', .08); });
  P.blueprint = mk(28, 22, s => { s.panel(1, 1, 26, 20, 'water', .42, { edge: .12 }); s.ring(10, 11, 4, 5.4, 'enamel', .9, 0); s.ring(19, 9, 2, 3.2, 'enamel', .9, 0); for (let x = 4; x < 25; x += 2) s.dot(x, 17, 'enamel', .8); s.line(4, 4, 12, 4, 'enamel', .8); s.rivet(2, 2, .3).rivet(24, 2, .3); });
  P.stencil = mk(26, 12, s => s.glyph(0, 0, ['EEE.EEE..E..EEE', 'E...E.E.E.E.E..', 'EE..E.E.EEE.EE.', 'E...E.E.E.E.E..', 'E...EEE.E.E.EEE'].map(r => r.replace(/E/g, 'e')), K), false);
  P.porthole = mk(22, 22, s => { s.ring(10.5, 10.5, 7, 10.4, 'brass', .58, .28); for (let k = 0; k < 8; k++) s.rivet(10 + Math.cos(k * .785) * 8.6, 10 + Math.sin(k * .785) * 8.6, .3); });
  P.portGlowT = mk(15, 15, s => s.disc(7, 7, 7.4, 'teal', .66, .3).each((x, y) => (x + y) % 7 === 0 && Math.hypot(x - 7, y - 7) < 6 ? ['teal', 1] : null), false);

  // —— 灯 ——
  P.lampBody = mk(14, 24, s => { s.bar(7, 0, 7, 4, .6, 'iron', .4); s.glyph(2, 4, ['...bBbb...', '..bBBbbq..', '.bBbbbbqq.', '.b......q.', '.b......q.', '.b......q.', '.b......q.', '.b......q.', '.b......q.', '.b......q.', '.bBbbbbqq.', '..bbbbqq..', '...bqq....'], K); });
  P.lampFire = mk(6, 7, s => s.each((x, y) => ['fire', .7 + .3 * Math.sin((x + .5) / 6 * 3.14) - Math.abs(y - 4) * .06]), false);
  P.cageLamp = mk(12, 14, s => { s.rect(3, 0, 6, 3, 'iron', .4); s.each((x, y) => y >= 3 && Math.hypot(x - 5.5, y - 7.5) < 5 ? (x % 3 === 0 || y === 7 ? ['iron', .3] : null) : null); });
  P.bulb = mk(8, 8, s => s.disc(3.5, 3.5, 3.9, 'fire', .86, .2), false);
  P.bulbT = mk(6, 6, s => s.disc(2.5, 2.5, 2.9, 'teal', .86, .2), false);
  P.bulbR = mk(6, 6, s => s.disc(2.5, 2.5, 2.9, 'red', .74, .2), false);
  P.beaconBase = art(['.IIIIII.', 'IHiiiidd', 'bBbbbbqq']);
  for (let f = 0; f < 4; f++) P['beacon' + f] = mk(10, 9, s => s.each((x, y) => { const d = Math.hypot((x - 4.5) / 5, (y - 8) / 8.5); if (d > 1) return null; const beam = Math.abs(x - [1.5, 4.5, 7.5, 4.5][f]) < (f === 3 ? .6 : 1.6); return ['fire', (f === 3 ? .5 : .56) + (beam ? .44 : 0) - (x - 4.5) * .02]; }), false);
  for (let f = 0; f < 4; f++) P['beaconR' + f] = mk(10, 9, s => s.each((x, y) => { const d = Math.hypot((x - 4.5) / 5, (y - 8) / 8.5); if (d > 1) return null; const beam = Math.abs(x - [1.5, 4.5, 7.5, 4.5][f]) < (f === 3 ? .6 : 1.6); return ['red', (f === 3 ? .46 : .52) + (beam ? .42 : 0)]; }), false);
  // 城堡前、台沿上的队伍色地标：一块发暗光的斜纹牌
  const pad = ink => mk(30, 40, s => { s.each((x, y) => { const e = x < 2 || y < 2 || x > 27 || y > 37; return e ? [ink, .6] : (x + y) % 10 < 4 ? [ink, .38] : null; }); for (let i = 0; i < 9; i++) for (let j = -i; j <= i; j++) if (Math.abs(j) > i - 3) s.dot(ink === 'teal' ? 19 - i + 2 : 10 + i - 2, 20 + j, ink, .8); }, false);
  P.padT = pad('teal'); P.padR = pad('red');

  // —— 铁锭、模子、铁水 ——
  const ingot = (ink, v, glow) => sh(20, 10, s => { s.each((x, y) => { const top = y < 4, a = top ? 3 - y * .6 : 1, b = top ? 16 + y * .6 : 19; return x >= a && x <= b && y < 9 ? [ink, v + (top ? .2 : y === 4 ? .08 : -.06) - (x > 14 ? .08 : 0) + (glow ? .12 * cloud(x / 3, y / 2, 5) : 0)] : null; }); if (!glow) { s.dot(6, 6, ink, v - .2).dot(7, 6, ink, v - .2).dot(9, 6, ink, v - .2); } });
  const cold = ingot('steel', .46, false);
  P.ingotHot = ingot('fire', .62, true).bake(); P.ingotWarm = sh(20, 10, s => { s.paste(ingot('rust', .5, true), 0, 0); s.each((x, y) => s.has(x, y) && (x + y) % 4 === 0 ? ['fire', .5] : null); }).bake(); P.ingotCold = sh(20, 10, s => s.paste(cold, 0, 0)).rim().bake();
  P.ingotStack = mk(46, 26, s => { for (const [x, y] of [[1, 15], [14, 15], [27, 15], [7, 8], [20, 8], [14, 1]]) s.paste(cold, x, y); s.wear('rust', .7, 5, 3, -.04); });
  P.mould = mk(30, 12, s => { s.panel(0, 3, 30, 9, 'iron', .3, { edge: .16 }); s.rect(3, 1, 24, 4, 'soot', .2); });
  P.mouldGlow = mk(22, 3, s => s.each((x, y) => ['fire', .66 + .3 * cloud(x / 3, y, 2)]), false);
  for (let f = 0; f < 4; f++) P['pour' + f] = mk(6, 48, s => s.each((x, y) => { const w = 1.4 + .9 * Math.sin((y + f * 3) * .5) ** 2 + y * .012; return Math.abs(x - 2.5) < w ? ['fire', .78 + .22 * Math.sin((y - f * 4) * .8) - Math.abs(x - 2.5) * .1] : null; }), false);
  for (let f = 0; f < 2; f++) P['splash' + f] = mk(18, 9, s => s.each((x, y) => { const a = Math.atan2(8 - y, x - 9), d = Math.hypot(x - 9, 8 - y), ray = Math.abs(Math.sin(a * 5 + f * 1.3)) > .7; return d < 3 || (ray && d > 3 + f && d < 6 + f * 2) ? ['fire', 1 - d * .06] : null; }), false);
  P.spark = mk(2, 2, s => s.rect(0, 0, 2, 2, 'fire', 1), false);
  P.mote = mk(2, 2, s => s.rect(0, 0, 2, 2, 'enamel', 1), false);

  // —— 火：四帧，噪声往上滚，循环 ——
  const tongue = (w, h, f, seed) => mk(w, h, s => s.each((x, y) => { const u = (x + .5) / w * 2 - 1, v = 1 - (y + .5) / h, n = turb(x / 5, (y + f * h / 4) / (h / 4), seed, 0, 4), sway = (n - .5) * .7 * v, wv = (1 - v) ** .65 * .92 * (.62 + .6 * n); if (Math.abs(u + sway) > wv) return null; return ['fire', 1.05 - v * 1.05 + (n - .5) * .5 - Math.abs(u + sway) / wv * .28]; }), false);
  for (let f = 0; f < 4; f++) P['flame' + f] = tongue(20, 26, f, 11);
  const bed = (w, h, f, seed) => mk(w, h, s => s.each((x, y) => { const v = 1 - (y + .5) / h, n = turb(x / 6, (y + f * h / 4) / (h / 4), seed, 0, 4), top = .28 + .7 * n * (.6 + .4 * Math.sin(x * .5 + f * 1.6 + n * 4)); if (v > top) return null; return ['fire', 1.06 - v / top * .82 + (n - .5) * .3]; }), false);
  for (let f = 0; f < 4; f++) P['bed' + f] = bed(64, 30, f, 23);
  P.coals = mk(64, 10, s => s.each((x, y) => { const n = cloud(x / 3, y / 2.5, 7); return y > 2 + 3 * cloud(x / 5, 0, 9) ? (n > .5 ? ['fire', .5 + n * .5] : ['rust', .2 + n * .4]) : null; }), false);
  // 炉口深处的一面火光：四周暗红，中间和下面黄白，带一道道耐火砖的缝
  P.hearth = mk(80, 54, s => s.each((x, y) => { const u = (x - 40) / 40, v = y / 54; return ['fire', .34 + .5 * v + .26 * (1 - u * u) - (y % 9 === 0 || (x + (Math.floor(y / 9) & 1) * 8) % 16 === 0 ? .16 : 0) + (cloud(x / 7, y / 7, 3) - .5) * .2]; }), false);
  P.hearthR = mk(48, 44, s => s.each((x, y) => { const u = (x - 24) / 24, v = y / 44; return ['red', .46 + .34 * v + .2 * (1 - u * u) + (cloud(x / 6, y / 6, 5) - .5) * .24 + (v > .7 ? .14 : 0)]; }), false);

  // —— 蒸汽：四帧由浓到淡（越淡孔越多），不用半透明 ——
  for (let k = 0; k < 4; k++) P['puff' + k] = mk(26, 26, s => s.each((x, y) => { let m = 0; for (const [cx, cy, r] of [[10, 15, 8], [16, 12, 8], [13, 9, 6.5], [18, 17, 5.5], [7, 11, 4.5]]) m = Math.max(m, 1 - Math.hypot(x - cx, y - cy) / r); m += (cloud(x / 4, y / 4, 31 + k) - .5) * .5; if (m < [.08, .16, .3, .46][k] + (k ? dith(x, y) * [0, .22, .4, .6][k] : 0)) return null; return ['steam', .5 + m * .3 - (y - 13) * .022 - (x - 13) * .008]; }), false);
  // —— 电弧：四帧，每帧一道折线加一条岔 ——
  for (let f = 0; f < 4; f++) P['arc' + f] = mk(34, 40, s => { const bolt = (x, y, tx, ty, seed, n) => { for (let k = 0; k < n; k++) { const t = (k + 1) / n, nx = x + (tx - x) / (n - k) + (jit(k, seed, f * 7 + 3) - .5) * 9, ny = y + (ty - y) / (n - k); s.line(x, y, nx, ny, 'teal', 1); s.line(x + 1, y, nx + 1, ny, 'teal', .7); x = nx; y = ny; if (k === 2 && seed < 50) bolt(x, y, x + (jit(f, 5, seed) - .5) * 26, y - 12, seed + 50, 3); } }; bolt(17, 39, 6 + jit(f, 1, 2) * 22, 2, f * 3 + 1, 6); }, false);
  for (let f = 0; f < 2; f++) P['zap' + f] = mk(14, 10, s => { let x = 0, y = 5; for (let k = 0; k < 5; k++) { const nx = x + 3, ny = 2 + jit(k, f, 71) * 6; s.line(x, y, nx, ny, 'teal', 1); x = nx; y = ny; } }, false);
  P.glint = mk(5, 5, s => { s.rect(2, 0, 1, 5, 'enamel', 1); s.rect(0, 2, 5, 1, 'enamel', 1); }, false);

  // —— 铁链、吊钩、滑轮、铁水包 ——
  P.link = mk(6, 12, s => { s.ring(2.5, 3, 1, 2.6, 'iron', .5, .24); s.ring(2.5, 4.5, 1, 2.6, 'iron', .5, .24); s.rect(2, 7, 2, 5, 'iron', (i, j) => i ? .3 : .56); }, false);
  P.hook = mk(18, 24, s => { s.panel(5, 0, 8, 7, 'iron', .4, { edge: .18 }); s.disc(9, 3, 1.4, 'brass', .64); s.ring(9, 15, 4, 7, 'steel', .5, .26); s.each((x, y) => x < 9 && y < 14 && y > 7 ? 0 : null); s.bar(9, 6, 9, 9, 1.4, 'steel', .5); });
  P.pulley = mk(18, 18, s => { s.ring(8.5, 8.5, 4, 8, 'iron', .46, .24); s.disc(8.5, 8.5, 4, 'brass', .56, .26); s.disc(8.5, 8.5, 1.3, 'coal', .1, 0); });
  P.ladle = mk(30, 28, s => { s.each((x, y) => { if (y < 6 || y > 25) return null; const hw = 13 - (y - 6) * .2; return Math.abs(x - 14.5) < hw ? ['iron', .4 - (x - 10) * .014 + (y === 6 ? .2 : 0) + (y === 14 || y === 20 ? .1 : y === 15 || y === 21 ? -.1 : 0)] : null; }); s.rect(1, 9, 3, 3, 'steel', .6); s.rect(26, 9, 3, 3, 'steel', .4); for (let x = 5; x < 26; x += 5) s.rivet(x, 16, .24); s.wear('rust', .66, 5, 2, -.04); });
  P.ladleGlow = mk(24, 5, s => s.each((x, y) => Math.abs(x - 11.5) < 12 - Math.abs(y - 2) * 1.6 ? ['fire', .72 + .28 * cloud(x / 3, y, 4)] : null), false);
  P.yoke = mk(34, 30, s => { s.bar(3, 28, 3, 6, 1.4, 'iron', .42); s.bar(30, 28, 30, 6, 1.4, 'iron', .36); s.bar(3, 6, 16.5, 1, 1.4, 'iron', .44); s.bar(30, 6, 16.5, 1, 1.4, 'iron', .38); s.disc(16.5, 2, 2, 'brass', .6); });

  // —— 风箱：皮腔一道道褶，上下两块木板，前面一个黄铜嘴 ——
  P.bellows = mk(48, 30, s => { s.each((x, y) => { const k = (x - 6) / 34; if (k < 0 || k > 1) return null; const hh = 4 + 9 * (1 - k * .75); return Math.abs(y - 15) < hh ? ['hide', .46 + ((x % 5) < 2 ? .16 : -.08) - (y - 15) * .014] : null; }); s.panel(4, 1, 34, 4, 'wood', .56, { edge: .16 }); s.panel(4, 25, 34, 4, 'wood', .4, { edge: .14 }); s.bar(38, 15, 46, 15, 2, 'brass', .56); s.rect(1, 12, 5, 6, 'iron', .4); for (let x = 8; x < 36; x += 6) s.rivet(x, 2, .26); });

  // —— 两座城堡正面的大件 ——
  // 高炉炉门：拱形的铁框，里面是一根根炉栅，栅缝是空的（后面另垫一面火光）
  P.door = mk(62, 58, s => { s.each((x, y) => { const cx = 30.5, r = 29, inR = 21, top = 30, out = y >= top ? Math.abs(x - cx) < r : Math.hypot(x - cx, y - top) < r, inn = y >= top ? Math.abs(x - cx) < inR && y < 52 : Math.hypot(x - cx, y - top) < inR; if (!out) return null; if (!inn) return ['iron', .4 - (x - cx) * .004 - (y - 20) * .003]; return (x - 10) % 7 < 2 ? ['soot', x % 7 === 3 ? .5 : .3] : y % 16 === 15 ? ['soot', .4] : null; });
    for (let k = 0; k < 9; k++) { const a = Math.PI * (1 + k / 8); s.rivet(30 + Math.cos(a) * 25, 30 + Math.sin(a) * 25, .3); } for (let y = 34; y < 54; y += 7) { s.rivet(4, y, .3); s.rivet(55, y, .3); }
    s.panel(25, 0, 12, 8, 'brass', .56, { edge: .2 }); s.rect(2, 53, 58, 4, 'iron', (i, j) => j ? .28 : .5); s.wear('rust', .7, 6, 8, -.05); });
  P.slot = mk(24, 12, s => { s.panel(0, 0, 24, 12, 'iron', .36, { edge: .18 }); s.each((x, y) => x > 2 && x < 21 && y > 2 && y < 9 ? (x % 4 === 0 ? ['soot', .3] : 0) : null); }, false);
  P.slotGlowR = mk(20, 8, s => s.each((x, y) => ['red', .6 + .3 * cloud(x / 3, y / 2, 3) + y * .02]), false);
  P.slotGlowT = mk(20, 8, s => s.each((x, y) => ['teal', .56 + .34 * cloud(x / 3, y / 2, 3)]), false);

  // —— 活塞机的三样活动件：连杆（两头黄铜轴瓦）、十字头、活塞杆 ——
  P.conrod = mk(8, 42, s => { s.bar(3.5, 3, 3.5, 38, 1.6, 'steel', .5); s.ring(3.5, 3.5, 1, 3.4, 'brass', .6, .26); s.ring(3.5, 37.5, 1, 3.4, 'brass', .6, .26); });
  P.xhead = mk(18, 11, s => { s.panel(1, 1, 16, 9, 'iron', .46, { edge: .2 }); s.disc(8.5, 5.5, 2.4, 'brass', .64, .3); s.rect(1, 4, 2, 3, 'steel', .7); s.rect(15, 4, 2, 3, 'steel', .5); });
  P.prod = mk(4, 46, s => s.rect(0, 0, 4, 46, 'steel', (i, j) => [.5, .86, .6, .32][i]), false);
  // —— 杠杆锤的锤臂：木梁，一头包铁的锤头，另一头是配重 ——
  P.trip = mk(56, 16, s => { s.panel(6, 5, 46, 5, 'wood', .5, { edge: .16 }); s.panel(0, 2, 11, 13, 'steel', .5, { edge: .2 }); s.rect(0, 13, 11, 2, 'steel', .3); s.panel(46, 3, 9, 9, 'iron', .36, { edge: .18 }); s.disc(30, 7.5, 2, 'brass', .62, .3); s.rect(20, 5, 2, 5, 'iron', .44); });
  // —— 贴着镜头的前景剪影（画的时候压成暗色）——
  P.fgRail = mk(120, 84, s => { s.bar(0, 6, 120, 6, 4, 'iron', .5); s.bar(0, 38, 120, 38, 2.6, 'iron', .4); for (const x of [16, 76]) { s.bar(x, 2, x, 84, 3.6, 'iron', .42); s.disc(x, 5, 6, 'brass', .5); } s.bar(16, 38, 76, 84, 2, 'iron', .36); s.panel(0, 72, 120, 12, 'hazard', .4, { edge: .14 }); s.each((x, y) => y > 73 && y < 83 && (x + y) % 18 < 9 ? ['coal', .16] : null); }, false);
  P.fgPipe = mk(170, 70, s => { s.bar(0, 20, 170, 20, 15, 'iron', .42, .3); for (const x of [34, 110]) { s.panel(x, 1, 10, 38, 'iron', .46, { edge: .2 }); for (let y = 4; y < 36; y += 7) s.rivet(x + 4, y, .3); } s.bar(70, 20, 70, 70, 8, 'copper', .44, .3); s.panel(60, 44, 20, 7, 'brass', .5, { edge: .2 }); s.ring(140, 46, 6, 11, 'red', .5, .26); s.bar(140, 30, 140, 40, 2, 'iron', .4); s.wear('rust', .66, 9, 5, -.05); }, false);
  P.fgTruss = mk(160, 60, s => { s.panel(0, 0, 160, 10, 'iron', .4, { edge: .16, rivet: 12 }); s.panel(0, 50, 160, 10, 'iron', .36, { edge: .16, rivet: 12 }); for (let k = 0; k < 4; k++) { s.bar(k * 40, 10, k * 40 + 20, 50, 2.4, 'iron', .4); s.bar(k * 40 + 20, 50, k * 40 + 40, 10, 2.4, 'iron', .36); s.panel(k * 40 - 3, 8, 7, 44, 'iron', .34, { edge: .14 }); } }, false);
  P.fgGear = gear(30, { ink: 'iron', seed: 41 });
  return P;
}

// 软边图：全是白的，颜色和亮度由顶点色给
export function softs() {
  return {
    halo: soft(48, 48, (u, v) => { const d = Math.hypot(u - .5, v - .5) * 2; return d >= 1 ? 0 : (1 - d) ** 2.2; }),
    shaft: soft(32, 64, (u, v) => Math.sin(Math.min(1, u) * Math.PI) ** 1.5 * (.25 + .75 * (1 - v)) * Math.min(1, v * 8) * Math.min(1, (1 - v) * 3)),
    haze: soft(64, 32, (u, v) => { const d = Math.hypot((u - .5) * 2, (v - .5) * 2); return d >= 1 ? 0 : (1 - d) ** 1.5 * (.7 + .3 * cloud(u * 6, v * 4, 9)); }),
    pool: soft(48, 24, (u, v) => { const d = Math.hypot((u - .5) * 2, (v - .5) * 2); return d >= 1 ? 0 : (1 - d * d) ** 1.4; }),
  };
}
