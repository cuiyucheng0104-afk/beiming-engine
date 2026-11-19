// three 探针适配器的驱动（一次性，用完即删）：起本地静态服务和无头、静音的浏览器，六个场景各渲两遍，写探针表 three 一列。
// three@0.187.0 和 playwright-core 装在仓库外的 out/probe/three/，不进仓库依赖。
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path'; import { fileURLToPath } from 'node:url'; import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { PROBE_ROWS, CALIB_DIR, objectTransform, project, axisAngle } from '../../check.mjs';

const HERE = dirname(fileURLToPath(import.meta.url)), REPO = join(HERE, '../../../..');
// 在哪台机器上跑由环境变量说：BEIMING_PROBE_MACHINE（默认 mac，别的机器另写一份读数表）、BEIMING_PROBE_CHROME（浏览器可执行文件）、BEIMING_ANGLE（显卡后端）
const MACHINE = process.env.BEIMING_PROBE_MACHINE || 'mac', ANGLE = process.env.BEIMING_ANGLE;
const OUT = join(REPO, 'out/probe/three'), TABLE = join(REPO, `beiming/calib/table/three${MACHINE === 'mac' ? '' : '.' + MACHINE}.json`);
const { chromium } = createRequire(join(OUT, 'package.json'))('playwright-core');
const VERSION = JSON.parse(readFileSync(join(OUT, 'node_modules/three/package.json'), 'utf8')).version;
assert.equal(VERSION, '0.187.0', 'three 版本必须锁 0.187.0');
const PAGE = `<!doctype html><meta charset="utf-8"><script type="importmap">{"imports":{"three":"/three/three.module.js"}}</script>
<script type="module">import * as probe from '/probe.js'; window.probe = probe; window.ready = true;</script>`;

function serve() {
  const server = createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(PAGE); }
    const file = url === '/probe.js' ? join(HERE, 'probe.js') : url.startsWith('/three/') && !url.includes('..') ? join(OUT, 'node_modules/three/build', url.slice(7)) : null;
    try { const body = readFileSync(file); res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(body); } catch { res.writeHead(404); res.end(); }
  });
  return new Promise(ok => server.listen(0, '127.0.0.1', () => ok(server)));
}

// 一遍：新起一个浏览器，六个场景依次渲。浏览器静音；显卡后端用机器上默认的那个（Mac 上是 ANGLE Metal）。
async function run(n, port, scenes) {
  const t0 = performance.now(), browser = await chromium.launch({ headless: true, executablePath: process.env.BEIMING_PROBE_CHROME || undefined, args: ['--mute-audio', '--enable-gpu', '--ignore-gpu-blocklist', ...(ANGLE ? [`--use-angle=${ANGLE}`] : [])] });
  const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${port}/`); await page.waitForFunction(() => window.ready);
  const info = await page.evaluate(() => window.probe.init()), startMs = performance.now() - t0, results = {};
  for (const { name, scene } of scenes) {
    const r = await page.evaluate(s => window.probe.runScene(s), scene), dir = join(OUT, name); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `run-${n}.png`), Buffer.from(r.png.split(',')[1], 'base64')); writeFileSync(join(dir, `run-${n}-color.f32`), Buffer.from(r.color, 'base64'));
    writeFileSync(join(dir, `run-${n}-readings.json`), JSON.stringify({ frame: r.frame, hash: r.hash, timing: r.timing, rows: r.rows }, null, 1));
    results[name] = r; }
  return await browser.close(), { info, startMs, results };
}

// 两遍颜色层不逐位相同时才算：转成 sRGB 8 位后的峰值信噪比，和差 5 级以上的通道采样占比。
function compare(b64a, b64b) {
  const f = s => new Float32Array(new Uint8Array(Buffer.from(s, 'base64')).buffer);
  const a = f(b64a), b = f(b64b), e8 = x => Math.round(255 * Math.min(1, Math.max(0, x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055)));
  let se = 0, over = 0, n = 0;
  for (let i = 0; i < a.length; i++) if (i % 4 !== 3) { const d = e8(a[i]) - e8(b[i]); se += d * d; over += Math.abs(d) > 5; n++; }
  return { psnr: se ? Math.round(10 * Math.log10(255 ** 2 / (se / n)) * 1e3) / 1e3 : '8 位下无差', over: over / n };
}

// 转台小杆的八角投影包围盒：正顺序用检查器的 R运动 · R静态，反顺序 R静态 · R运动，T 两种相同。
const r6 = x => Math.round(x * 1e6) / 1e6, maxAbs = (a, b) => r6(Math.max(...a.map((x, i) => Math.abs(x - b[i])))), dot = (r, p) => r[0] * p[0] + r[1] * p[1] + r[2] * p[2];
function armBox(s, t, reverse) {
  const o = s.objects.find(x => x.id === 'turntable-arm'), m = o.motion, { R, T } = objectTransform(o, t), rm = axisAngle(m.axisDir, m.angularVelocityRadPerFrame * t);
  const M = reverse ? axisAngle(o.rotation.axisDir, o.rotation.angleRad).map(r => [0, 1, 2].map(j => dot(r, rm.map(q => q[j])))) : R;
  const px = Array.from({ length: 8 }, (_, k) => project(s.camera, M.map((r, i) => dot(r, o.sizeM.map((L, a) => ((k >> a) & 1 ? 0.5 : -0.5) * L)) + T[i])));
  return [0, 1, 0, 1].map((i, j) => r6((j < 2 ? Math.min : Math.max)(...px.map(q => q[i]))));
}

const NOTE = {
  '颜色层的线性度': 'FloatType 渲染目标加 readRenderTargetPixels，MeshBasicMaterial 的颜色按场景线性写入；渲到渲染目标时 three 不做色调映射和 sRGB 编码，读回就是场景线性值，含大于 1 的 HDR 级。差是三个通道里绝对差的最大值。',
  '显示变换': '对照要用 Blender 色彩配置烘的 AgX Medium High Contrast 查找表，P5 拿不到，所以记 blocked。已量的两样留作对照：不过色调映射、只做 sRGB 编码时 three 画布输出和标准 sRGB 公式逐级比的 8 位差；three 自带 AgXToneMapping 的 8 位输出（three 的 AgX 不是 Blender 的 Medium High Contrast 版本，不能当答案）。',
  '深度口径': '深度层用覆盖材质自己写：g 通道写观察空间的 −z（平面深度），b 通道写到相机的距离（射线距离），两种都能交；没读 three 原生的深度缓冲（那是非线性的 NDC 深度，要另做线性化）。读的是坐标落在的整数像素的中心，标准答案是连续坐标那一点，所以射线距离有不到一个像素的位移差。',
  '编号层的边缘': '编号层渲到 FloatType、samples = 0 的渲染目标，不开抗锯齿，编号都是整数、没有混色。细于一个像素的杆按像素中心是否落在三角形里取舍：它是整条消失还是 1 像素宽，取决于它落在像素中心之间的哪里。这次 rod-thin 整条消失，中心和半宽见「杆中心投影的横坐标 u 和投影半宽」那条读数（u = 221.091 像素、半宽 0.33 像素，盖住 [220.76, 221.42]，两侧像素中心 220.5、221.5 都不在里面）。包围盒由合渲的编号层反算（带遮挡），和不计遮挡的元数据包围盒比交并比。',
  '坐标与相机': () => `three 本身就是 Y 向上、相机看 −Z，PerspectiveCamera 的 fov 是竖直全视场角，和规格同口径，不用换轴。物体世界变换用四元数 q运动 · q静态（premultiply），即先静态旋转再运动旋转。「three 投影像素」是 three 的 matrixWorld 加 Vector3.project 算出来的，没经过光栅化和读回，只证明 three 的矩阵数学和检查器一致。从渲染读回的是两种：局部原点的点用单独渲（藏掉其他物体）的编号层覆盖质心，方块的质心会被看得见的侧面拉偏，不等于中心点的投影；转台标记第 24 帧合渲时被 axis-x 挡住下半截，所以改成单独渲再取质心。四元数顺序由 turntable-arm 单独渲的编号层包围盒判：对规格算的八角投影包围盒，第 24 帧正顺序（R运动 · R静态）最大差 ${GAP[24][0]} 像素、反顺序（R静态 · R运动）最大差 ${GAP[24][1]} 像素；第 48 帧正顺序 ${GAP[48][0]}、反顺序 ${GAP[48][1]}，两种顺序在第 48 帧的包围盒相同，分不出，只有第 24 帧能分。`,
  '时间键': '时刻 t = 帧 + sub 直接代入运动公式，sub 取 0 和 0.5 都按规格投影。辅助层（编号、深度）在这个适配器里固定取 sub = 0 的单个采样渲，不做累积（构造决定，不是实测）。',
  '快门相位': 'three 一侧的快门窗口由宿主构造：[f, f + 快门角 ÷ 360)，不是渲染器行为；读数只证明适配器照这个窗口取了子帧（第 24 帧在 [24, 24.5) 里取 8 个子帧中点）。three 没有原生运动模糊。构造读数的相位由覆盖质心在 sub = 0 和 sub = 0.5 两个静止位置之间线性插值换算，它不收敛到 0.25（复核时子帧加到 256 个仍约 0.262），原因是方块偏离画面中心时露出侧面，覆盖质心在两个静止位置之间不是线性的。',
  '子帧累积和后期的先后': '后期用一个最小的亮部溢出：超过 1 的部分做 9×9 盒式模糊，乘 0.5 加回。比较「先平均再跑后期」和「逐子帧跑后期再平均」。另附静止场景各子帧时刻不同（t = (k + 0.5) / 8）时累积与单个采样的差：没有抖动，只证明不同子帧时刻下静止场景逐位相同。',
  '显示变换的整形曲线': '这一行的主体「过对数整形再查三维查找表、和 Blender 直出的 AgX 逐级比色差」要 Blender 的查找表和直出值，P5 拿不到，所以和「显示变换」一样记 blocked。只量了一半，留作读数：不过色调映射直接 sRGB 编码时，线性值到 1 就被切到 255，以及第一个被切的 HDR 级；three 自带 AgX 的切顶级也记下，但不是答案。',
  '可见比例的成本': '可见比例 = 合渲时编号层里这个实体的像素数 ÷ 单独渲（藏掉其他实体）时的像素数，都在 160×90 的四分之一分辨率编号层上数。包围盒交并比合渲、单独渲各算一遍：合渲时被挡掉一大块的 cube-far 只有 0.72，过不了 0.95，单独渲是 0.98；契约要写明用哪一种。耗时是单独渲一遍四分之一分辨率编号层并整张读回的毫秒数，Mac 读数，待 5090 补跑。',
  '确定性': '每遍新起一个浏览器，六个场景各渲一次，两遍比颜色层浮点数据的 SHA-256；另比两遍除耗时以外的读数是否逐项相同。Mac 读数，待 5090 补跑。',
  '耗时': '启动 = 起浏览器、开页面、建 WebGLRenderer；冷启动 = 建场景到第一帧读回完成（第一个场景含着色器编译，后面的场景复用已编译的着色器）；单帧 = 渲一帧加 1 像素读回同步，5 次取中位；读回 = 整张浮点颜色层读回，5 次取中位。页面没开跨源隔离，performance.now 的分辨率约 0.1 毫秒，亚毫秒的读数只到这个精度。Mac 读数，待 5090 补跑。',
};

// 探针表目录 table/ 也以 probe- 开头，会被检查器的 loadScenes 当成场景；这里先只留有 scene.json 的目录（见汇报的变更单）。
// 探针表只管这六个场景；后来加的辅助层取样场景归最小出帧链路量，不进这张表
const TABLE_SCENES = ['probe-axes-turntable', 'probe-gray-chart', 'probe-moving-cube', 'probe-occlusion', 'probe-plane-steps', 'probe-thin-geometry'];
const scenes = readdirSync(CALIB_DIR).filter(n => TABLE_SCENES.includes(n) && existsSync(join(CALIB_DIR, n, 'scene.json'))).sort()
  .map(name => ({ name, scene: JSON.parse(readFileSync(join(CALIB_DIR, name, 'scene.json'), 'utf8')) }));
assert.equal(scenes.length, 6);
const server = await serve(), runs = [];
for (const n of [1, 2]) runs.push(await run(n, server.address().port, scenes));
server.close();

const rows = Object.fromEntries(PROBE_ROWS.map(k => [k, []]));
for (const { name } of scenes) for (const [k, list] of Object.entries(runs[0].results[name].rows)) rows[k].push(...list);
for (const { name } of scenes) {
  const [a, b] = runs.map(r => r.results[name]), same = a.hash === b.hash;
  rows['确定性'].push({ scene: name, what: `第 ${a.frame} 帧颜色层两遍的 SHA-256 是否逐位相同（${a.hash.slice(0, 16)}…）`, expected: '相同', got: same ? '相同' : '不同', diff: same ? '无' : '见下一条', unit: 'sha256' });
  if (!same) { const c = compare(a.color, b.color); rows['确定性'].push({ scene: name, what: '两遍颜色层转 sRGB 8 位后的峰值信噪比 / 差 5 级以上的通道采样占比', expected: '逐位相同', got: [c.psnr, c.over], diff: '—', unit: 'dB / ratio' }); }
  const noMs = r => JSON.stringify(Object.values(r.rows).flat().filter(x => x.unit !== 'ms')), sameRows = noMs(a) === noMs(b);
  rows['确定性'].push({ scene: name, what: '两遍除耗时以外的读数是否逐项相同', expected: '相同', got: sameRows ? '相同' : '不同', diff: sameRows ? '无' : '不同', unit: 'reading' });
  runs.forEach((r, i) => [['coldMs', '冷启动（建场景到第一帧读回完成）'], ['frameMs', '单帧（渲一帧加 1 像素读回同步，5 次中位）'], ['readMs', '整张浮点颜色层读回（5 次中位）']].forEach(([k, what]) =>
    rows['耗时'].push({ scene: name, what: `第 ${i + 1} 遍 ${what}，${MACHINE} 读数`, expected: '无标准答案', got: r.results[name].timing[k], diff: '无', unit: 'ms' })));
}
runs.forEach((r, i) => rows['耗时'].push({ scene: '全部', what: `第 ${i + 1} 遍 启动（起浏览器、开页面、建渲染器），渲染器串 ${r.info.gpu}，${r.info.webgl}，${MACHINE} 读数`, expected: '无标准答案', got: Math.round(r.startMs * 1e3) / 1e3, diff: '无', unit: 'ms' }));

// 转台小杆：页面交回的单独渲包围盒，在这里补上规格算的期望和正反两种顺序的差。
const AXES = scenes.find(x => x.name === 'probe-axes-turntable').scene, GAP = {}, STATUS = { '显示变换': 'blocked', '显示变换的整形曲线': 'blocked', '快门相位': 'not-applicable' };
assert.deepEqual(armBox(AXES, 0, false), armBox(AXES, 0, true), '第 0 帧运动旋转是单位阵，正反顺序应当相同');
for (const x of rows['坐标与相机'].filter(x => x.what.startsWith('armBox '))) {
  const t = +x.what.slice(7), [fw, rv] = [false, true].map(r => armBox(AXES, t, r)); GAP[t] = [maxAbs(x.got, fw), maxAbs(x.got, rv)];
  Object.assign(x, { what: `turntable-arm 第 ${t} 帧单独渲编号层包围盒 [x0, y0, x1, y1]，对规格正顺序 R运动 · R静态 的八角投影包围盒（过线 1 像素；反顺序的包围盒 [${rv}]，和渲染最大差 ${GAP[t][1]}）`, expected: fw, diff: GAP[t][0] });
}
const table = { format: 'probe-column/0.1', source: 'three', version: VERSION, machine: MACHINE,
  rows: PROBE_ROWS.map(row => ({ row, status: STATUS[row] ?? 'measured', readings: rows[row], note: MACHINE !== 'mac' ? '这台机器的读数。各行怎么量的说明见同目录不带机器名的那一份（Mac），说明里的数字是 Mac 的，本文件以自己的读数为准。' : typeof NOTE[row] === 'function' ? NOTE[row]() : NOTE[row] })) };
// 自检：恰好 12 行，每行有读数，每个读数六个字段齐全，数值都是有限数。
assert.equal(table.rows.length, 12); assert.ok(table.rows.every(r => r.readings.length > 0), '有的行没有读数');
for (const x of table.rows.flatMap(r => r.readings)) assert.deepEqual(Object.keys(x).sort(), ['diff', 'expected', 'got', 'scene', 'unit', 'what']),
  assert.ok([x.expected, x.got, x.diff].flat().every(v => typeof v !== 'number' || Number.isFinite(v)), `${x.what} 有非有限数`);
mkdirSync(dirname(TABLE), { recursive: true }); writeFileSync(TABLE, JSON.stringify(table, null, 2) + '\n');
console.log(`写出 ${table.rows.length} 行：${table.rows.map(r => `${r.row}=${r.status}(${r.readings.length})`).join('，')}`);
