// 《一步翻盘》对战盘 · 七套场景的替身棋盘：把游戏里交给场景的那几样东西（20 块格子、两条前线、两座城堡的空组、
// 环境光和主光、镜头、后期链）按游戏的数原样搭一遍，场景模块（arenas/<文件夹>/arena.js）就能不经过游戏、直接在北冥的渲染器里出图。
// 这里没有规则、没有手牌、没有界面：棋子是摆好的十个（只播待机帧），血量牌和战力牌是画上去的。
// 数字的出处：游戏仓库 board3d.js（提交 b71ea4d）。那边改了镜头、格子或后期，这里要跟着改，否则出图和游戏里对不上。
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// 七套场景，按 film.json 镜头表的顺序（第 n 个镜头出第 n 套）。key 是游戏地址里 ?arena= 后面的名字，dir 是 arenas/ 下的文件夹
export const SCENES = [
  { key: 'c', dir: 'c-zhai', title: '林间寨擂' },
  { key: 'b', dir: 'b-shui', title: '沉水擂台' },
  { key: 'harvest', dir: 'mai-chang', title: '丰收麦场' },
  { key: 'sea', dir: 'shan-gong', title: '珊瑚龙宫' },
  { key: 'forge', dir: 'lu-fang', title: '齿轮熔炉' },
  { key: 'sky', dir: 'yun-dao', title: '云上浮岛' },
  { key: 'chapel', dir: 'sheng-tang', title: '彩窗圣堂' },
];
const CLOCK0 = 10;                                       // 场景的钟从第 10 秒起算：慢的循环（熔炉倒铁水 7 秒一轮）不会都停在起点

// —— 棋盘规格（桌面版式；手机横屏那一套 LX 1.5 / LZ 1.4 / HPY 1.75 这里不出）——
const ROWS = 5, COLS = 4, SHORT = false, LX = 1, LZ = 1.2, HPY = 2.2;
const tileX = r => (r - (ROWS - 1) / 2) * LX;            // 第 0 行贴着本方城堡（左）
const tileZ = c => (c - (COLS - 1) / 2) * LZ;            // 第 0 路最远，最后一路最靠镜头
const HALF = ROWS * LX / 2, DEPTH = COLS * LZ;
const TEAM = [0x00c098, 0xf84850], RIM = ['#00c098', '#f84850'], INK = '#080818';
const FOV = 22, PITCH = 25 * Math.PI / 180, LOOK = new THREE.Vector3(0, .95, -.1), TAN = 2 * Math.tan(FOV * Math.PI / 360);
const VIEW_H = 720, HAND = 136;                          // 游戏窗口按 720 高算；底下 136 是手牌探进来的高度，取景要让开它

// —— 摆好的十个棋子：游戏 assets/units 的 CC0 待机序列帧（敌方已整条左右翻转）。cell 一帧边长、feet 脚底在帧里的 y、frames 帧数、scale 游戏里的倍率 ——
// 摆法：每一行最多两个、不在相邻的两条路上，前面的不挡后面的
const UNITS = [
  { file: 'f1_ranged', side: 0, r: 0, c: 0, str: 2, cell: 80, feet: 64, frames: 10, scale: 1.35 },
  { file: 'f1_silverguardsquire', side: 0, r: 0, c: 3, str: 1, cell: 80, feet: 64, frames: 10, scale: 1.6 },
  { file: 'f1_tank', side: 0, r: 1, c: 2, str: 3, cell: 80, feet: 64, frames: 11, scale: 1.55 },
  { file: 'f1_ironcliffeguardian', side: 0, r: 2, c: 1, str: 5, cell: 80, feet: 64, frames: 18, scale: 1.25 },
  { file: 'f1_azuritelion', side: 0, r: 2, c: 3, str: 4, cell: 80, feet: 65, frames: 14, scale: 1.6 },
  { file: 'f4_crawler', side: 1, r: 1, c: 0, str: 2, cell: 80, feet: 64, frames: 12, scale: 1.6 },
  { file: 'f4_juggernaut', side: 1, r: 3, c: 1, str: 6, cell: 80, feet: 65, frames: 12, scale: 1.3 },
  { file: 'f4_darkspine', side: 1, r: 3, c: 3, str: 4, cell: 80, feet: 64, frames: 12, scale: 1.55 },
  { file: 'f4_nightsorrow', side: 1, r: 4, c: 0, str: 3, cell: 80, feet: 64, frames: 12, scale: 1.6 },
  { file: 'f4_gloomchaser', side: 1, r: 4, c: 2, str: 2, cell: 80, feet: 64, frames: 12, scale: 1.6 },
];
const HP = [10, 6];
const PX = 1 / 64, SPRITE_FPS = 10;                      // 棋子一个像素多少米；待机帧每秒 10 张

// —— 牌子上的字：3 × 5 的点阵数字和一颗心，硬边，不用字体 ——
const DIGITS = ['111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001', '111100111001111', '111100111101111', '111001010010010', '111101111101111', '111101111001111'];
const HEART = ['.##.##.', '#######', '#######', '.#####.', '..###..', '...#...'];
function plaque(text, rim, heart) {                      // 切角的墨底牌子，一圈队伍色的边
  const cv = document.createElement('canvas'); cv.width = 160; cv.height = 96; const g = cv.getContext('2d');
  const R = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
  R(16, 8, 128, 80, rim); R(8, 16, 144, 64, rim); R(24, 16, 112, 64, INK); R(16, 24, 128, 48, INK);
  const k = heart ? 8 : 10, gap = k, dw = text.length * 3 * k + (text.length - 1) * gap, hw = heart ? 7 * 5 + 10 : 0;
  let x = Math.round(80 - (dw + hw) / 2);
  if (heart) { HEART.forEach((row, j) => [...row].forEach((ch, i) => { if (ch === '#') R(x + i * 5, 33 + j * 5, 5, 5, '#f06878'); })); x += hw; }
  for (const ch of text) { const d = DIGITS[+ch]; for (let j = 0; j < 5; j++) for (let i = 0; i < 3; i++) if (d[j * 3 + i] === '1') R(x + i * k, 48 - 2.5 * k + j * k, k, k, '#ece4d0'); x += 3 * k + gap; }
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.magFilter = THREE.NearestFilter; return t;
}
function badge(text, rim, size, heart = false) {         // 始终朝向镜头、画在最上面的小牌子
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: plaque(text, rim, heart), depthTest: false })); s.scale.set(size * 160 / 96, size, 1); s.renderOrder = 10; return s;
}

const loadImage = url => new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error(`读不到 ${url}`)); i.src = url; });
let sheets = null;                                       // 十条序列帧只载一次，换场景时各自克隆贴图
async function loadSheets() {
  if (sheets) return sheets; const out = {};
  await Promise.all(UNITS.map(async u => { out[u.file] = await loadImage(`units/${u.file}_idle.png`); }));
  return sheets = out;
}

const VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }';
const TILT = { uniforms: { tDiffuse: { value: null }, dir: { value: new THREE.Vector2() }, focus: { value: .47 }, band: { value: .28 }, amt: { value: 1 } }, vertexShader: VERT,
  fragmentShader: `uniform sampler2D tDiffuse; uniform vec2 dir; uniform float focus, band, amt; varying vec2 vUv;
    void main(){ float d = smoothstep(band, band + .25, abs(vUv.y - focus)) * amt; vec4 c = vec4(0.); float w = 0.;
      for (int i = -5; i <= 5; i++) { float k = exp(-float(i * i) / 10.); c += texture2D(tDiffuse, vUv + dir * d * float(i)) * k; w += k; }
      gl_FragColor = c / w; }` };
const VIGNETTE = { uniforms: { tDiffuse: { value: null } }, vertexShader: VERT,
  fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv;
    void main(){ vec3 c = texture2D(tDiffuse, vUv).rgb; vec2 q = vUv - .5; c *= 1. - pow(dot(q, q), 1.2) * 1.5; gl_FragColor = vec4(c, 1.); }` };
const GRADE = () => ({ uniforms: { tDiffuse: { value: null }, sat: { value: 1 }, con: { value: 1 }, knee: { value: .8 }, gain: { value: new THREE.Color(1, 1, 1) }, lift: { value: new THREE.Color(0, 0, 0) }, edge: { value: new THREE.Color(0, 0, 0) } }, vertexShader: VERT,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float sat, con, knee; uniform vec3 gain, lift, edge; varying vec2 vUv;
    void main(){ vec3 c = texture2D(tDiffuse, vUv).rgb * gain; c += lift * (1. - min(c, 1.)); float l = dot(c, vec3(.2126, .7152, .0722)); c = max(mix(vec3(l), c, sat), 0.);
      c = max((c - .18) * con + .18, 0.); vec2 q = vUv - .5; c += edge * pow(dot(q, q), 1.2); vec3 o = max(c - knee, 0.); c = min(c, knee) + o / (1. + o / (1. - knee)); gl_FragColor = vec4(c, 1.); }` });

let renderer = null, W = 1920, H = 1080, world = null, building = null, timing = null;
export function setup(canvas, pageTiming) {                // pageTiming：engine/production/timeline.js 读出来的 film.json 时间（镜头切点只在那里改）
  timing = pageTiming; if (timing.shots.length !== SCENES.length) throw new Error(`film.json 有 ${timing.shots.length} 个镜头，场景有 ${SCENES.length} 套，要一一对应`);
  W = window.__RENDER?.width ?? window.innerWidth; H = window.__RENDER?.height ?? window.innerHeight;
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  renderer.toneMapping = THREE.NoToneMapping; renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setPixelRatio(H / VIEW_H); renderer.setSize(VIEW_H * W / H, VIEW_H, false);   // 和游戏一样按「720 高的窗口 × 像素比」算，移轴的步长才对得上
  return loadSheets();
}

// 搭一套场景的全部东西。游戏里这些是常驻的、场景只搭一次；这里一套场景一个独立的世界，切镜头时整个换掉
async function makeWorld(scn) {
  const mod = await import(`./arenas/${scn.dir}/arena.js`), img = await loadSheets();
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x05050f);
  const camera = new THREE.PerspectiveCamera(FOV, 1, 1, 200);
  const amb = new THREE.AmbientLight(0xd8e0ff, 2.35), sun = new THREE.DirectionalLight(0xf0f6ff, 1.5);
  sun.position.set(-6, 12, 6); sun.castShadow = true; sun.shadow.mapSize.setScalar(2048); sun.shadow.radius = 2;
  Object.assign(sun.shadow.camera, { left: -9, right: 9, top: 7, bottom: -7, near: 1, far: 34 }); sun.shadow.bias = -.001; sun.shadow.normalBias = .02;
  scene.add(amb, sun);

  // 格子：20 块薄盒子。只有顶面铺贴图，四个侧面都取贴图左上角那颗像素
  const tileGeo = new THREE.BoxGeometry(LX - .03, .06, LZ - .05), tiles = [];
  { const uv = tileGeo.attributes.uv; for (let i = 0; i < uv.count; i++) if (i < 8 || i > 11) uv.setXY(i, .5 / 64, 1 - .5 / 64); }
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const t = new THREE.Mesh(tileGeo, new THREE.MeshLambertMaterial({ color: 0x30446a })); t.position.set(tileX(r), .03, tileZ(c)); t.receiveShadow = true; t.userData = { c, r, base: .03 }; scene.add(t); tiles.push(t);
  }
  // 前线：两条队伍色的细条，一明一暗地呼吸
  const lines = [[TEAM[0], tileX(0) + LX / 2], [TEAM[1], tileX(ROWS - 1) - LX / 2]].map(([color, x]) => { const m = new THREE.Mesh(new THREE.BoxGeometry(.05, .02, DEPTH - .1), new THREE.MeshBasicMaterial({ color, transparent: true })); m.position.set(x, .075, 0); scene.add(m); return m; });
  // 城堡：两个空的组，各挂一块血量牌。场景把自己的门搭进组里
  const castles = [-1, 1].map((side, i) => { const g = new THREE.Group(); g.position.x = side * (HALF + 1.3); scene.add(g); const label = badge(String(HP[i]), RIM[i], .42, true); label.position.set(0, HPY, .2); g.add(label); return g; });

  // 棋子：不吃光的像素立牌（永远是贴图原色），脚下一个队伍色的圈和一块战力牌
  const ringGeo = new THREE.RingGeometry(.3, .36, 28), blobGeo = new THREE.CircleGeometry(.3, 20), units = [];
  for (const u of UNITS) {
    const tex = new THREE.Texture(img[u.file]); tex.magFilter = tex.minFilter = THREE.NearestFilter; tex.generateMipmaps = false; tex.colorSpace = THREE.SRGBColorSpace; tex.repeat.set(1 / u.frames, 1); tex.needsUpdate = true;
    const grp = new THREE.Group(), w = u.cell * PX * u.scale; grp.position.set(tileX(u.r), .065, tileZ(u.c));
    const blob = new THREE.Mesh(blobGeo, new THREE.MeshBasicMaterial({ color: 0x04040c, transparent: true, opacity: .45, depthWrite: false })); blob.rotation.x = -Math.PI / 2; blob.scale.set(1, .62, 1); grp.add(blob);
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: TEAM[u.side], transparent: true, opacity: .95, depthWrite: false })); ring.rotation.x = -Math.PI / 2; ring.position.y = .004; ring.scale.set(1.15, .8, 1); grp.add(ring);
    const spr = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).translate(0, u.feet / u.cell - .5, 0), new THREE.MeshBasicMaterial({ map: tex, alphaTest: .5, side: THREE.DoubleSide }));
    spr.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: tex, alphaTest: .5 }); spr.castShadow = true; spr.scale.set(w, w, 1); grp.add(spr);
    const power = badge(String(u.str), RIM[u.side], .24); power.position.set(.34, .1, .32); grp.add(power);
    scene.add(grp); units.push({ u, tex, spr });
  }

  // 后期：泛光 → 移轴（横、竖各一遍）→ 暗角 → 调色（默认关，场景自己开）→ 输出
  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4 }));
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(4, 4), .22, .5, .9); composer.addPass(bloom);
  const tiltH = new ShaderPass(TILT), tiltV = new ShaderPass(TILT); composer.addPass(tiltH); composer.addPass(tiltV);
  composer.addPass(new ShaderPass(VIGNETTE));
  const grade = new ShaderPass(GRADE()); grade.enabled = false; composer.addPass(grade);
  composer.addPass(new OutputPass());

  // 取景：照游戏的算法。先退到两座城堡左右都在画面里，再看竖向（塔尖到最下面一路的底边要装进手牌以上那一截），最后把画面上移到盘的前沿刚好露出手牌
  const w = VIEW_H * W / H, h = VIEW_H, v3 = new THREE.Vector3();
  composer.setPixelRatio(H / VIEW_H); composer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
  let dist = Math.max((ROWS * LX + 5.8) / camera.aspect, 6.2) / TAN;
  const place = () => { camera.position.set(LOOK.x, LOOK.y + dist * Math.sin(PITCH), LOOK.z + dist * Math.cos(PITCH)); camera.lookAt(LOOK); camera.updateMatrixWorld(true); };
  const row = p => { place(); camera.matrixWorldInverse.copy(camera.matrixWorld).invert(); return (1 - v3.copy(p).project(camera).y) / 2 * h; };
  const TOP = new THREE.Vector3(0, 3.2, -DEPTH / 2 + .35), FOOT = new THREE.Vector3(0, .07, tileZ(COLS - 1) + LZ / 2);
  const room = h - HAND - 6, span = row(FOOT) - row(TOP); if (span > room) dist = Math.max(dist, Math.min(dist * span / room, h / (40 * TAN)));
  const up = Math.max(0, Math.round(row(FOOT) - (h - HAND))); if (up) camera.setViewOffset(w, h, 0, up, w, h);
  tiltH.uniforms.dir.value.set(1.3 / w, 0); tiltV.uniforms.dir.value.set(0, 1.3 / h); place();

  const arena = mod.build({ THREE, scene, camera, renderer, amb, sun, tiles, lines, castles, post: { bloom, tiltH, tiltV, grade }, low: false, calm: false, team: TEAM,
    grid: { ROWS, COLS, LX, LZ, HALF, DEPTH, HPY, SHORT, tileX, tileZ } });
  return { scn, scene, camera, sun, composer, arena, units, lines };
}
function scrap(wd) {                                     // 换场景时把上一套的显存还回去
  const seen = new Set(), drop = o => { if (o && o.dispose && !seen.has(o)) { seen.add(o); o.dispose(); } };
  wd.scene.traverse(o => { drop(o.geometry); for (const m of [].concat(o.material || [], o.customDepthMaterial || [])) { for (const k in m) if (m[k] && m[k].isTexture) drop(m[k]); drop(m); } });
  if (wd.sun.shadow.map) wd.sun.shadow.map.dispose(); wd.composer.dispose(); renderer.renderLists.dispose();
}

const LOCK = SCENES.findIndex(s => s.key === new URLSearchParams(location.search).get('arena'));   // 地址带 ?arena=<名字>：整段只出这一套（出单张、调某一套时用）
export const sceneAt = t => LOCK >= 0 ? LOCK : timing.at(t).index;
async function ensure(i) {
  if (world && world.scn === SCENES[i]) return world;
  if (building) await building;                          // 上一次还没搭完就等它，免得两套同时搭
  if (world && world.scn === SCENES[i]) return world;
  if (world) { scrap(world); world = null; }
  building = makeWorld(SCENES[i]).then(wd => { world = wd; building = null; return wd; });
  return building;
}
export async function render(t) {
  const wd = await ensure(sceneAt(t)), clock = t + CLOCK0;
  for (const { u, tex, spr } of wd.units) { tex.offset.x = (Math.floor(clock * SPRITE_FPS + u.c * 3 + u.r * 5) % u.frames) / u.frames; spr.quaternion.copy(wd.camera.quaternion); }
  wd.lines.forEach((m, i) => { m.material.opacity = .6 + Math.sin(clock * 2.4 + i * 2) * .3; });
  wd.arena.tick(clock, 1 / timing.fps);
  wd.composer.render();
}
