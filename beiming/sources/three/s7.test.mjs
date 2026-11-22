// S7：three 帧源场景查询 bbox3d、anchor、belowGround 与未声明查询 contract.unsupported-query（含 next 替代办法）
import Ajv2020 from 'ajv/dist/2020.js';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fail } from '../../api/envelope.mjs';
import { startSource } from '../../host/page/host.mjs';
import * as measure from '../../host/page/measure.js';
import { shotInput } from '../../kernel/eval/input.mjs';
import { caps } from './caps.mjs';
import * as plan from './plan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACT = join(HERE, '../../kernel/contracts/source');
const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));
const near = (got, want, tol, what) => {
  assert.equal(got.length, want.length, what);
  got.forEach((v, i) => assert.ok(Math.abs(v - want[i]) <= tol, `${what}[${i}]：要 ${want[i]}，得 ${v}`));
};
const coded = (code, more = () => {}) => (err) => { assert.equal(err.code, code, err.message); more(err); return true; };
/** 错上的替代办法：每项是 { verb, why }，原样过得了 API 错误信封（beiming/api/envelope.mjs 的 fail 会滤掉不合写法的项） */
const alt = (err) => {
  assert.ok(Array.isArray(err.next) && err.next.length >= 1, 'next 必须给出替代办法');
  for (const n of err.next) assert.ok(typeof n.verb === 'string' && n.verb && typeof n.why === 'string' && n.why, JSON.stringify(n));
  assert.deepEqual(fail(err.code, err.message, { next: err.next }).next, err.next, '替代办法过信封不能丢');
};

// 地面以下、超过 50 个实体的夹具：kit 在地面以上；kit.b00 到 kit.b59 是边长 0.1 米的方块，第 i 个的底面在地面以下 0.01 × (i + 1) 米；lone 在地面以上
const CAMERA = { positionM: [0, 0, 0], lookAtM: [0, 0, -1], upDir: [0, 1, 0], yFovDeg: 40, widthPx: 640, heightPx: 360, nearM: 0.1, farM: 100 };
const box = (id, positionM, sizeM = [0.1, 0.1, 0.1]) => ({ id, shape: 'box', sizeM, positionM, emissionLinear: [0.18, 0.18, 0.18] });
const pad2 = (i) => String(i).padStart(2, '0');
const CROWD = {
  camera: CAMERA,
  backgroundLinear: [0, 0, 0],
  objects: [box('kit', [0, 1, -5]), box('lone', [1, 2, -5]), ...Array.from({ length: 60 }, (_, i) => box(`kit.b${pad2(i)}`, [(i % 10) * 0.2 - 0.9, 0.05 - 0.01 * (i + 1), -5 - Math.floor(i / 10)]))],
};
// 边界夹具：相机在世界原点。swarm 是一个实例网格，两个边长 1 米的方块实例平移到 (2, 3, −6)、(−2, −3, −6)；
// kit#eye 正好在相机平面上（投不到屏幕，但世界坐标是好的）；lone#bad 的坐标写坏了
const EDGE = { camera: CAMERA, backgroundLinear: [0, 0, 0], objects: [box('kit', [0, 1, -5]), box('lone', [1, 2, -5])] };
const EDGE_PARAMS = { spec: EDGE, instanced: { swarm: [[2, 3, -6], [-2, -3, -6]] }, anchors: { 'kit#eye': [0, 0, 0], 'lone#bad': [0, null, 0] } };
// 坐标缺项的夹具：kit#hole 是 [0, , −3]（下标 1 是空位），lone#short 是 [0, 0]（缺 Z）
const SPARSE_PARAMS = { spec: EDGE, holes: { 'kit#hole': 1 }, anchors: { 'lone#short': [0, 0] } };
const shotOf = (id, frames, params) => ({ id, in: 0, out: frames, source: 'three', host: 'page', mode: 'native-code', entry: 's7-probe.shot.js', colorRef: 'scene', seed: 7, params });
const FILM = {
  format: 'film/3.0',
  id: 's7-probe',
  output: { size: [640, 360], fps: '24/1', frames: 97 },
  shots: [shotOf('steps', 12, { scene: 'probe-plane-steps' }), shotOf('turntable', 97, { scene: 'probe-axes-turntable' }), shotOf('crowd', 2, { spec: CROWD }), shotOf('edge', 1, EDGE_PARAMS), shotOf('sparse', 1, SPARSE_PARAMS)],
};

test('S7-1 caps() 声明 bbox3d、anchor、belowGround 三种场景查询，落在登记表之内（F15）', async () => {
  const c = caps();
  assert.deepEqual(c.sceneQuery, ['bbox3d', 'anchor', 'belowGround']);
  const registry = await readJson(join(CONTRACT, 'source.json'));
  for (const kind of c.sceneQuery) assert.ok(registry.sources.three.sceneQuery.includes(kind), kind);
});

test('S7-2 校准场景实测 bbox3d / anchor / belowGround、通配符与 F9 截断、实例网格、相机平面上的锚点，且 intersect 返回 contract.unsupported-query 及 next 替代办法', async (t) => {
  let source;
  try { source = await startSource(); } catch (e) { t.skip(`起不了浏览器：${String(e.message).split('\n')[0]}`); return; }
  const workspace = await mkdtemp(join(tmpdir(), 'beiming-s7-'));
  const valid = new Ajv2020({ strict: false }).compile(await readJson(join(CONTRACT, 'schema/query-result.schema.json')));
  const opened = [];
  const open = async (id) => { const s = await source.open(shotInput(FILM, id), { lock: null, tier: 'final', workspace, filmDir: HERE }); opened.push(s); return s; };
  /** 问一次，结果必须合乎 QueryResult 的结构；交回 { 结果, 各项按 a 取 } */
  const ask = async (session, f, q) => {
    const res = await session.query(f, q);
    assert.ok(valid(res), JSON.stringify(valid.errors));
    assert.equal(res.kind, q.kind);
    for (const item of res.items) assert.equal(item.unit, 'm');
    return res;
  };
  try {
    // ---------- probe-plane-steps：四块正对相机的平面，中心都在 y = 0 ----------
    const steps = await open('steps');
    const boxRes = await ask(steps, 0, { kind: 'bbox3d', of: ['plane_1m', 'plane_10m'] });
    assert.equal(boxRes.truncated, undefined);
    assert.ok(!('truncated' in boxRes), '没截断不出现 truncated');
    // 最严重（对角线最长）的在前
    assert.deepEqual(boxRes.items.map((i) => i.a), ['plane_10m', 'plane_1m']);
    near(boxRes.items[0].at, [3.55, -0.75, -10, 6.05, 0.75, -10], 1e-6, 'plane_10m 的包围盒');
    near(boxRes.items[1].at, [-0.625, -0.075, -1, -0.375, 0.075, -1], 1e-6, 'plane_1m 的包围盒');
    near([boxRes.items[0].value, boxRes.items[1].value], [Math.hypot(2.5, 1.5), Math.hypot(0.25, 0.15)], 1e-6, '对角线长度');
    // 同一个实体写两次只答一次；和谁比（against）这三种查询不用，合乎写法就不拒
    assert.equal((await ask(steps, 0, { kind: 'bbox3d', of: ['plane_1m', 'plane_1m'], against: ['plane_2m'], tol: 0 })).items.length, 1);

    const anchorRes = await ask(steps, 0, { kind: 'anchor', of: ['plane_2m'] });
    assert.deepEqual(anchorRes.items.map((i) => i.a), ['plane_2m#center']);
    near(anchorRes.items[0].at, [-0.3, 0, -2], 1e-9, 'plane_2m#center');
    near([anchorRes.items[0].value], [Math.hypot(0.3, 2)], 1e-9, '锚点到世界原点的距离');
    assert.ok(anchorRes.items[0].at.every((v) => !Object.is(v, -0)), '-0 归一成 0');

    const all = ['plane_1m', 'plane_2m', 'plane_5m', 'plane_10m'];
    const below = await ask(steps, 0, { kind: 'belowGround', of: all });
    // 下陷最深的在前：四块平面的下沿分别在 y = −0.75、−0.375、−0.15、−0.075
    assert.deepEqual(below.items.map((i) => i.a), ['plane_10m', 'plane_5m', 'plane_2m', 'plane_1m']);
    near(below.items.map((i) => i.value), [0.75, 0.375, 0.15, 0.075], 1e-6, '下陷深度');
    near(below.items[0].at.slice(1), [-0.75, -10], 1e-6, 'plane_10m 最低顶点的 y、z');
    assert.deepEqual((await ask(steps, 0, { kind: 'belowGround', of: all, tol: 0.2 })).items.map((i) => i.a), ['plane_10m', 'plane_5m']);
    // 容差是严格小于：正好陷 0.75 米、容差 0.75 米不算
    assert.deepEqual((await ask(steps, 0, { kind: 'belowGround', of: all, tol: 0.75 })).items, []);
    // 通配一个都没配上：空结果，不报错
    assert.deepEqual(await ask(steps, 0, { kind: 'bbox3d', of: ['nothing.*'] }), { kind: 'bbox3d', items: [] });

    // 没声明的查询：报 contract.unsupported-query，next 给出替代办法
    await assert.rejects(() => steps.query(0, { kind: 'intersect', of: ['plane_1m'], against: ['plane_2m'] }), coded('contract.unsupported-query', alt));
    await assert.rejects(() => steps.query(0, { kind: 'contact', of: ['plane_1m'], against: ['plane_2m'] }), coded('contract.unsupported-query', alt));
    await assert.rejects(() => steps.query(0, { kind: 'volume', of: ['plane_1m'] }), coded('contract.unsupported-query', alt));
    // 帧号出值域（F23）：不是整数、负数、不小于镜头帧数；同时问了没声明的查询也先报帧号
    for (const f of [12, -1, 0.5, '0', null, undefined, Number.NaN]) await assert.rejects(() => steps.query(f, { kind: 'bbox3d', of: ['plane_1m'] }), coded('usage.bad-argument'), `f = ${f}`);
    await assert.rejects(() => steps.query(12, { kind: 'intersect', of: ['plane_1m'] }), coded('usage.bad-argument'));
    // 查询写得不对、问的实体场景里没有
    const of = ['plane_1m'];
    const bad = [
      null, undefined, 'bbox3d', [], new Date(), { of }, { kind: 5, of }, { kind: 'bbox3d' }, { kind: 'bbox3d', of: [] }, { kind: 'bbox3d', of: 'plane_1m' },
      { kind: 'bbox3d', of: [5] }, { kind: 'bbox3d', of: ['*'] }, { kind: 'bbox3d', of: ['plane.*.x'] }, { kind: 'bbox3d', of: ['plane-1m'] }, { kind: 'bbox3d', of: ['ghost'] },
      { kind: 'bbox3d', of, against: [] }, { kind: 'bbox3d', of, against: ['ghost'] }, { kind: 'bbox3d', of, extra: 1 },
      { kind: 'belowGround', of, tol: -1 }, { kind: 'belowGround', of, tol: null }, { kind: 'belowGround', of, tol: Number.NaN }, { kind: 'belowGround', of, tol: '1' }, { kind: 'belowGround', of, tol: Infinity },
      { kind: 'anchor', of: null }, Object.create({ kind: 'bbox3d', of }), { kind: 'bbox3d', get of() { return of; } },
    ];
    for (const q of bad) await assert.rejects(() => steps.query(0, q), coded('usage.bad-argument'), JSON.stringify(q) ?? String(q));
    // 报过错的会话照常答
    assert.equal((await ask(steps, 11, { kind: 'bbox3d', of })).items.length, 1);

    // ---------- probe-axes-turntable：转台绕 +Y 每 96 帧一圈，标记块第 0 帧在 (1, 0.05, 0) ----------
    const turn = await open('turntable');
    const marker = async (f) => (await ask(turn, f, { kind: 'bbox3d', of: ['turntable_marker'] })).items[0];
    near((await marker(0)).at, [0.925, 0, -0.075, 1.075, 0.1, 0.075], 1e-6, '第 0 帧');
    // 转了四分之一圈：中心到 (0, 0.05, −1)
    near((await marker(24)).at, [-0.075, 0, -1.075, 0.075, 0.1, -0.925], 1e-6, '第 24 帧');
    // 转了八分之一圈：方块斜着，包围盒在 X、Z 上各宽 0.15 × √2
    const c = Math.SQRT1_2, h = 0.075 * Math.SQRT2, at12 = await marker(12);
    near(at12.at, [c - h, 0, -c - h, c + h, 0.1, -c + h], 1e-6, '第 12 帧');
    near([at12.value], [Math.hypot(2 * h, 0.1, 2 * h)], 1e-6, '第 12 帧的对角线');
    // 查询在 (f, sub = 0) 求值，不留跨调用的状态：问过第 24 帧再问第 0 帧，答的还是第 0 帧
    near((await marker(0)).at, [0.925, 0, -0.075, 1.075, 0.1, 0.075], 1e-6, '回到第 0 帧');
    const spun = await ask(turn, 24, { kind: 'anchor', of: ['turntable_marker', 'axis_x'] });
    assert.deepEqual(spun.items.map((i) => i.a).sort(), ['axis_x#center', 'turntable_marker#center']);
    near(spun.items.find((i) => i.a === 'turntable_marker#center').at, [0, 0.05, -1], 1e-6, '第 24 帧的锚点');
    // 转台是高 0.05 米的圆柱，顶面在 y = 0：整个陷在地面以下 0.05 米；标记块贴着地面，容差 1 毫米之内不算
    const sunk = await ask(turn, 24, { kind: 'belowGround', of: ['turntable', 'turntable_marker', 'axis_y'], tol: 0.001 });
    assert.deepEqual(sunk.items.map((i) => i.a), ['turntable']);
    near([sunk.items[0].value, sunk.items[0].at[1]], [0.05, -0.05], 1e-6, '转台的下陷深度和最低点');
    // 问完查询再出帧，出的是它自己那一帧
    const rendered = await turn.render(0, {}, ['meta']);
    near(rendered.meta.entities.find((e) => e.name === 'turntable_marker').bbox3d, [0.925, 0, -0.075, 1.075, 0.1, 0.075], 1e-6, '查询之后的 render');

    // ---------- 地面以下、超过 50 个实体的夹具 ----------
    const crowd = await open('crowd');
    const deep = await ask(crowd, 1, { kind: 'belowGround', of: ['kit.*', 'kit', 'lone'] });
    // 60 个陷在地面以下：只留最深的 50 个（b59 到 b10），被截掉 10 个；kit.* 不含 kit 自己，kit、lone 在地面以上
    assert.equal(deep.truncated, 10);
    assert.deepEqual(deep.items.map((i) => i.a), Array.from({ length: 50 }, (_, i) => `kit.b${pad2(59 - i)}`));
    near(deep.items.map((i) => i.value), Array.from({ length: 50 }, (_, i) => 0.01 * (60 - i)), 1e-6, '下陷深度');
    // 容差把浅的滤掉以后不到 50 项：不出现 truncated
    const few = await ask(crowd, 0, { kind: 'belowGround', of: ['kit.*'], tol: 0.555 });
    assert.deepEqual([few.items.map((i) => i.a), 'truncated' in few], [['kit.b59', 'kit.b58', 'kit.b57', 'kit.b56', 'kit.b55'], false]);
    const boxes = await ask(crowd, 0, { kind: 'bbox3d', of: ['kit.*'] });
    assert.deepEqual([boxes.items.length, boxes.truncated], [50, 10]);
    assert.ok(boxes.items.every((i) => i.a.startsWith('kit.b')), 'kit.* 不含 kit 自己');
    assert.deepEqual([(await ask(crowd, 0, { kind: 'bbox3d', of: ['kit.*', 'kit', 'lone'] })).truncated, (await ask(crowd, 0, { kind: 'bbox3d', of: ['kit', 'lone'] })).items.length], [12, 2]);
    const anchors = await ask(crowd, 0, { kind: 'anchor', of: ['kit.*'] });
    assert.deepEqual([anchors.items.length, anchors.truncated], [50, 10]);
    // 离世界原点最远的在前，一路不增
    assert.ok(anchors.items.every((i, k) => k === 0 || i.value <= anchors.items[k - 1].value));
    assert.deepEqual((await ask(crowd, 0, { kind: 'anchor', of: ['kit'] })).items.map((i) => i.a), ['kit#center']);

    // ---------- 边界夹具：实例网格、相机平面上的锚点、写坏的锚点 ----------
    const edge = await open('edge');
    // 实例网格：每个实例的矩阵都算进去，不是只量原型方块
    const swarm = (await ask(edge, 0, { kind: 'bbox3d', of: ['swarm'] })).items[0];
    assert.deepEqual(swarm.at, [-2.5, -3.5, -6.5, 2.5, 3.5, -5.5]);
    const sunkSwarm = await ask(edge, 0, { kind: 'belowGround', of: ['swarm'], tol: 1 });
    assert.deepEqual(sunkSwarm.items.map((i) => [i.a, i.value, i.at[1]]), [['swarm', 3.5, -3.5]]);
    // 锚点查询交的是世界坐标，不过屏幕投影：落在相机平面上的照答
    assert.deepEqual((await ask(edge, 0, { kind: 'anchor', of: ['kit'] })).items, [{ a: 'kit#center', value: Math.hypot(1, 5), unit: 'm', at: [0, 1, -5] }, { a: 'kit#eye', value: 0, unit: 'm', at: [0, 0, 0] }]);
    // 没问到的实体上的锚点（相机平面上的、写坏的）不牵连这一次查询
    assert.deepEqual(await ask(edge, 0, { kind: 'anchor', of: ['nomatch.*'] }), { kind: 'anchor', items: [] });
    assert.deepEqual((await ask(edge, 0, { kind: 'anchor', of: ['swarm'] })).items, []);
    // 问到的实体上有写坏的锚点：带错误码报错
    await assert.rejects(() => edge.query(0, { kind: 'anchor', of: ['lone'] }), coded('contract.bad-value'));

    // ---------- 坐标缺项的锚点：带空位的 [0, , −3]、缺 Z 的 [0, 0]，从公开的会话问都带错误码 ----------
    const sparse = await open('sparse');
    await assert.rejects(() => sparse.query(0, { kind: 'anchor', of: ['kit'] }), coded('contract.bad-value', (e) => assert.match(e.message, /kit#hole/)));
    await assert.rejects(() => sparse.query(0, { kind: 'anchor', of: ['lone'] }), coded('contract.bad-value', (e) => assert.match(e.message, /lone#short/)));
    // 报过错的会话照常答；别的种类的查询不看锚点
    assert.equal((await ask(sparse, 0, { kind: 'bbox3d', of: ['kit', 'lone'] })).items.length, 2);
  } finally {
    for (const s of opened) await s.close();
    await source.stop();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('S7-3 planQuery：先判种类再判写法，通配不含前缀自己，实体名去重按字节序（不起浏览器）', () => {
  const names = ['kit', 'kit.a', 'kit.b', 'kitten', 'lone'];
  assert.deepEqual(plan.planQuery(caps(), { kind: 'belowGround', of: ['lone', 'kit.*', 'kit.a'], tol: 0.5 }, names), { kind: 'belowGround', of: ['kit.a', 'kit.b', 'lone'], tol: 0.5, q: { kind: 'belowGround', of: ['lone', 'kit.*', 'kit.a'], tol: 0.5 } });
  assert.deepEqual(plan.planQuery(caps(), { kind: 'bbox3d', of: ['kit'] }, names).of, ['kit']);
  assert.equal(plan.planQuery(caps(), { kind: 'bbox3d', of: ['kit'] }, names).tol, 0);
  // 没声明的种类先报，哪怕别的字段也不对
  assert.throws(() => plan.planQuery(caps(), { kind: 'contact', of: [], bogus: 1 }, names), coded('contract.unsupported-query', alt));
  for (const kind of ['intersect', 'contact', 'volume']) assert.throws(() => plan.planQuery(caps(), { kind, of: ['kit'] }, names), coded('contract.unsupported-query', alt), kind);
  assert.throws(() => plan.planQuery(caps(), { kind: 'bbox3d', of: ['ghost.x'] }, names), coded('usage.bad-argument'));
  assert.throws(() => plan.planFrame(4, 4), coded('usage.bad-argument'));
  // of、against 的数组只认自有的、可枚举的数据属性：索引上的取值器一次都不执行，原型上继承来的元素、多出来的键都不认
  let calls = 0;
  const getter = Object.defineProperty(['kit'], 0, { get() { calls++; return 'kit'; }, enumerable: true });
  const inherited = Object.setPrototypeOf(new Array(1), Object.assign(Object.create(Array.prototype), { 0: 'kit' }));
  const hidden = Object.defineProperty(['kit'], 0, { value: 'kit', enumerable: false });
  const extraKey = Object.assign(['kit'], { more: 1 }), symbolKey = Object.assign(['kit'], { [Symbol('s')]: 1 });
  for (const [what, list] of Object.entries({ getter, inherited, hidden, extraKey, symbolKey, sparse: [, 'kit'] })) { // eslint-disable-line no-sparse-arrays
    assert.throws(() => plan.planQuery(caps(), { kind: 'bbox3d', of: list }, names), coded('usage.bad-argument'), what);
    assert.throws(() => plan.planQuery(caps(), { kind: 'bbox3d', of: ['kit'], against: list }, names), coded('usage.bad-argument'), `against ${what}`);
  }
  assert.equal(calls, 0, '索引上的取值器不该被执行');
  // 快照和调用方的数组脱钩：之后改原数组不影响计划
  const mine = ['kit'], planned = plan.planQuery(caps(), { kind: 'bbox3d', of: mine }, names);
  mine[0] = 'lone';
  assert.deepEqual(planned.q.of, ['kit']);
  assert.equal(plan.planFrame(4, 3), 3);
});

test('S7-4 answerQuery：三种查询的算式、最严重的在前、超过 50 项截断（不起浏览器）', () => {
  const cube = (y) => [[0, y, 0], [1, y + 1, 1]];
  assert.deepEqual(measure.answerQuery('bbox3d', [['a', cube(-0)]]), { kind: 'bbox3d', items: [{ a: 'a', value: Math.sqrt(3), unit: 'm', at: [0, 0, 0, 1, 1, 1] }] });
  assert.ok(measure.answerQuery('bbox3d', [['a', cube(-0)]]).items[0].at.every((v) => !Object.is(v, -0)));
  assert.deepEqual(measure.answerQuery('anchor', [['a#p', [3, 0, -4]]]), { kind: 'anchor', items: [{ a: 'a#p', value: 5, unit: 'm', at: [3, 0, -4] }] });
  // 同样深的按名字的字节序
  assert.deepEqual(measure.answerQuery('belowGround', [['up', cube(0)], ['b', cube(-1)], ['a', cube(-1)], ['deep', cube(-2)], ['shallow', cube(-0.1)]], 0.1).items.map((i) => [i.a, i.value, i.at]), [['deep', 2, [0, -2, 0]], ['a', 1, [0, -1, 0]], ['b', 1, [0, -1, 0]]]);
  const many = measure.answerQuery('belowGround', Array.from({ length: 53 }, (_, i) => [`e${i}`, cube(-1 - i)]));
  assert.deepEqual([many.items.length, many.truncated, many.items[0].a, many.items[49].a], [50, 3, 'e52', 'e3']);
  assert.ok(!('truncated' in measure.answerQuery('belowGround', Array.from({ length: 50 }, (_, i) => [`e${i}`, cube(-1 - i)]))));
  assert.throws(() => measure.answerQuery('bbox3d', [['a', [[0, Number.NaN, 0]]]]), /有限/);
  // 一样大的按码点序（就是 UTF-8 字节序）：U+E000 在 U+10000 前面；JS 的 < 按 UTF-16 码元比会反过来
  const tied = [['e#\u{10000}', [0, 1, 0]], ['e#\uE000', [1, 0, 0]], ...Array.from({ length: 49 }, (_, i) => [`e#far${i}`, [0, 0, 2]])];
  const cut = measure.answerQuery('anchor', tied);
  assert.deepEqual([cut.items.length, cut.truncated, cut.items[49].a], [50, 1, 'e#\uE000']);
  assert.deepEqual(measure.answerQuery('anchor', [['a#\u{10000}', [1, 0, 0]], ['a#\uE000', [1, 0, 0]], ['a#z', [1, 0, 0]], ['a#', [1, 0, 0]]]).items.map((i) => i.a), ['a#', 'a#z', 'a#\uE000', 'a#\u{10000}']);
});

test('S7-5 pickAnchors：只收挂在问到的实体上的锚点，世界坐标原样交，不过屏幕投影（不起浏览器）', () => {
  const pairs = [['hero#eye', [0, 0, 0]], ['hero#hand', [1, 2, 3]], ['prop#top', [0, 1, 0]], ['other#bad', [0, Number.NaN, 0]], ['other', [0, 0, 0]], ['ghost#x', 'junk']];
  assert.deepEqual(measure.pickAnchors(pairs, ['hero', 'prop']), [['hero#eye', [0, 0, 0]], ['hero#hand', [1, 2, 3]], ['prop#top', [0, 1, 0]]]);
  assert.deepEqual(measure.pickAnchors(pairs, []), []);
  // 问到的实体上的锚点写坏了（坐标不是三个有限的数、写法不对、交了两次）：带错误码报错
  const badValue = (err) => { assert.equal(err.code, 'contract.bad-value', err.message); return true; };
  assert.throws(() => measure.pickAnchors(pairs, ['other']), badValue);
  for (const world of [[0, 0], [0, 0, Infinity], [0, '0', 0], null]) assert.throws(() => measure.pickAnchors([['hero#eye', world]], ['hero']), badValue);
  assert.throws(() => measure.pickAnchors([['hero#a#b', [0, 0, 0]]], ['hero']), badValue);
  assert.throws(() => measure.pickAnchors([['hero#eye', [0, 0, 0]], ['hero#eye', [1, 0, 0]]], ['hero']), badValue);
  // 坐标只认正好三个自有的、可枚举的数据属性：带空位的（every 会跳过空位）、索引上是取值器的、继承来的、藏起来的、多出键的都报，取值器一次都不执行
  let calls = 0;
  const getter = Object.defineProperty([0, 0, 0], 1, { get() { calls++; return 0; }, enumerable: true });
  const inherited = Object.setPrototypeOf([0, , -3], Object.assign(Object.create(Array.prototype), { 1: 0 })); // eslint-disable-line no-sparse-arrays
  const hidden = Object.defineProperty([0, 0, 0], 1, { value: 0, enumerable: false });
  const odd = { hole: [0, , -3], lastHole: [0, 0, ,], getter, inherited, hidden, extraKey: Object.assign([0, 0, 0], { more: 1 }), symbolKey: Object.assign([0, 0, 0], { [Symbol('s')]: 1 }) }; // eslint-disable-line no-sparse-arrays
  for (const [what, world] of Object.entries(odd)) {
    assert.throws(() => measure.pickAnchors([['hero#eye', world]], ['hero']), badValue, what);
    assert.equal(measure.isXyz(world), false, what);
    // 没问到的实体上的照旧不管
    assert.deepEqual(measure.pickAnchors([['other#eye', world]], ['hero']), [], what);
  }
  assert.equal(calls, 0, '索引上的取值器不该被执行');
  assert.deepEqual([measure.isXyz([0, -0, 1e300]), measure.isXyz([0, 0]), measure.isXyz([0, 0, 0, 0]), measure.isXyz(new Float32Array(3)), measure.isXyz('abc')], [true, false, false, false, false]);
  // 交回的坐标和镜头交的数组脱钩
  const mine = [1, 2, 3], [[, kept]] = measure.pickAnchors([['hero#eye', mine]], ['hero']);
  mine[0] = 9;
  assert.deepEqual(kept, [1, 2, 3]);
});
