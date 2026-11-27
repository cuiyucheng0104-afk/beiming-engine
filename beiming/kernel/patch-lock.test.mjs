import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { loadContracts } from './contracts/validate.mjs';
import { parseRequestText, applyFilmWrite, getFilmRev } from './patch-apply.mjs';
import { generateLock, serializeLock } from './lock-gen.mjs';
import { explainParam } from './explain.mjs';

const { validate } = await loadContracts();
const fixture = name => JSON.parse(readFileSync(new URL(`./contracts/examples/${name}/film.json`, import.meta.url), 'utf8'));
const films = ['film-min', 'film-hard-surface', 'hard-surface', 'toon', 'lab'];
const set = (path, value) => ({ op: 'set', path, value });
const remove = path => ({ op: 'remove', path });
const rename = (path, to) => ({ op: 'rename', path, to });
const add = (path, value) => ({ op: 'add', path, value });
const patch = (...ops) => ({ format: 'patch/0.1', rev: 7, ops });
const write = (film, body, options) => applyFilmWrite(film, body, { rev: 7, ...options });
function rejects(body, step, code, index, film = fixture('film-min')) {
  const before = structuredClone(film);
  const r = write(film, body);
  assert.equal(r.ok, false);
  assert.deepEqual([r.step, r.code, r.opIndex], [step, code, index]);
  assert.deepEqual(film, before);
}
const arg = 'usage.bad-argument', unknown = 'contract.unknown-key', bad = 'contract.bad-value';
const pathError = 'contract.bad-path', impossible = 'contract.patch-not-applicable';
for (const name of films) test(`样例 ${name} 原子接受`, () => {
  const film = fixture(name), before = structuredClone(film);
  const r = write(film, patch(set('title', '新标题')));
  assert.deepEqual(r, { ok: true, rev: 8, film: { ...before, title: '新标题' } });
  assert.deepEqual(film, before);
});
for (const [name, body, step, code, i] of [
  ['非法字节先于修订号', Buffer.from([0xff]), 1, arg],
  ['残缺 JSON', '{', 1, arg], ['顶层数组', '[]', 1, arg], ['缺少修订号', {}, 1, arg],
  ['代理码元', '"\ud800"', 1, arg],
  ['转义孤立高代理值', String.raw`{"format":"patch/0.1","rev":7,"ops":[{"op":"set","path":"title","value":"\uD800"}]}`, 1, arg],
  ['转义孤立低代理键', String.raw`{"format":"patch/0.1","rev":7,"ops":[{"op":"set","path":"title","value":{"\uDC00":1}}]}`, 1, arg],
  ['转义代理与过期同在仍报文本错', String.raw`{"format":"patch/0.1","rev":6,"ops":[{"op":"set","path":"title","value":"\uD800"}]}`, 1, arg],
  ['超大整数修订号', '{"rev":9007199254740993}', 1, arg],
  ['安全整数上界外修订号', '{"rev":9007199254740992}', 1, arg],
  ['精确小数按双精度舍入成合法修订号后进第3步', '{"rev":7.00000000000000001}', 3, arg],
  ['小数下溢按双精度当零并报冲突', '{"rev":1e-800}', 1, 'busy.rev-conflict'],
  ['值内重复键先于过期', '{"rev":8,"ops":[{"value":{"k":1,"\\u006b":2}}]}', 1, arg],
  ['过期先于只读', { ...patch(remove('id')), rev: 6 }, 1, 'busy.rev-conflict'],
  ['只读先于封套', { ...patch(remove('exam')), format: '错' }, 2, 'contract.immutable-key', 0],
  ['多操作只读按顺序', patch(remove('predicates'), remove('id')), 2, 'auth.base-readonly', 0],
  ['改名同时触及两处只读', patch(rename('predicates', 'exam')), 2, 'contract.immutable-key', 0],
  ['从根改名至断言', patch(rename('title', 'predicates')), 2, 'auth.base-readonly', 0],
  ['从断言同层改名至 base', patch(rename('predicates/extra', 'base')), 2, 'auth.base-readonly', 0],
  ['无效路径跳过只读', patch(rename('/title', 'id')), 4, pathError, 0],
  ['未知操作字段压过早先结构错误', patch(null, { ...remove('title'), extra: true }), 3, unknown, 1],
  ['未知顶层键', { ...patch(), ext: {} }, 3, unknown], ['空操作列表', patch(), 3, arg],
  ['非数组操作', { ...patch(), ops: {} }, 3, arg], ['缺少值', patch({ op: 'set', path: 'title' }), 3, arg, 0],
  ['操作多带值', patch({ ...remove('title'), value: 2 }), 3, arg, 0],
  ['非字符串路径', patch(remove({ x: 1 })), 3, arg, 0], ['改名目标不合法', patch(rename('title', 'a/b')), 3, arg, 0],
  ['操作名取原型方法', patch({ op: 'toString', path: 'title' }), 3, arg, 0],
  ['数值无穷先于路径', '{"format":"patch/0.1","rev":7,"ops":[{"op":"set","path":"/","value":1e400}]}', 3, arg, 0],
  ['后项结构先于前项路径', patch(remove('/'), { op: 'set' }), 3, arg, 1],
  ['整条路径先于逐段', patch(set('typo//a', 1)), 4, pathError, 0],
  ['数字下标', patch(remove('shots/0')), 4, pathError, 0], ['叶子后续段', patch(remove('title/x')), 4, pathError, 0],
  ['普通数组后续段', patch(remove('output/size/0')), 4, pathError, 0],
  ['前段未知先于后段', patch(remove('oops/0')), 4, unknown, 0],
  ['后项路径先于前项不可作用', patch(remove('missing'), set('oops', 1)), 4, unknown, 1],
  ['后项不可作用先于值域且回滚', patch(set('title', 42), remove('missing')), 5, impossible, 1],
  ['改名冲突', patch(rename('title', 'format')), 5, impossible, 0],
  ['已有标识不能添加', patch(add('shots', { id: 's01' })), 5, impossible, 0],
  ['替换条目标识不一致', patch(set('shots/s01', { id: 1 })), 5, impossible, 0],
  ['非字符串标识交结构判', patch(add('shots', { id: 1 })), 6, bad],
  ['数字实例名按名字查找', patch(remove('shots/s01/cards/0')), 5, impossible, 0],
  ['普通数组不能添加', patch(add('output/size', { id: 'x' })), 5, impossible, 0],
  ['未知值键先于片子值域', patch(set('title', 1), set('style/finish', { wrong: 1 })), 6, unknown],
  ['错类型内部不算未知键', patch(set('style/finish/grain', { wrong: 1 })), 6, bad],
  ['镜头不连续', patch(set('shots/s02/in', 179)), 6, bad], ['删必填键', patch(remove('output')), 6, bad],
  ['不合最简帧率', patch(set('output/fps', '60/2')), 6, bad],
  ['登记帧源宿主不符', patch(set('shots/s02/host', 'none')), 6, bad],
  ['追加谓词带分号', patch(set('predicates/extra', ['a;b'])), 6, bad],
]) test(name, () => rejects(body, step, code, i));

test('UTF-8 字节上限包含边界', () => {
  const text = '{"值":1}', n = Buffer.byteLength(text);
  assert.equal(parseRequestText(text, { maxBytes: n }).ok, true);
  assert.equal(parseRequestText(Buffer.from(text), { maxBytes: n - 1 }).step, 1);
});
test('嵌套上限包含最外层', () => {
  const text = n => '{"value":' + '['.repeat(n) + '0' + ']'.repeat(n) + '}';
  assert.equal(parseRequestText(text(127)).ok, true);
  assert.equal(parseRequestText(text(128)).step, 1);
});
test('冲突返回最新修订号', () => assert.equal(write(fixture('lab'), { rev: 8 }).latestRev, 7));
test('服务器可以写最低谓词', () => assert.equal(write(fixture('lab'), patch(set('predicates/base', [])), { by: 'server' }).ok, true));
test('操作按书写顺序作用', () => {
  const r = write(fixture('film-min'), patch(set('style/finish/x', 0)));
  assert.equal(r.step, 4);
  const ok = write(fixture('film-min'), patch(rename('style/finish/grain', 'old'), rename('style/finish/old', 'grain')));
  assert.equal(ok.film.style.finish.grain, 0.04);
});
test('存量未知键原位同值豁免，整层带回仍保留', () => {
  const f = fixture('film-min'); f.style.finish.older = { a: 0, b: 1 };
  const r = write(f, patch(set('style/finish', { grain: 0.5, older: { b: 1, a: 0 } })));
  assert.deepEqual(r.film.style.finish.older, f.style.finish.older);
});
test('改动存量未知键拒绝', () => {
  const f = fixture('film-min'); f.style.finish.old = 2;
  rejects(patch(set('style/finish', { old: 3 })), 6, unknown, undefined, f);
});
test('存量值先按双精度读数再比相等', () => {
  const f = fixture('film-min'); f.style.finish.old = 2 ** 53; f.style.finish.legacy = 0.1;
  const raw = (old, legacy) => `{"format":"patch/0.1","rev":7,"ops":[{"op":"set","path":"style/finish","value":{"old":${old},"legacy":${legacy}}}]}`;
  assert.equal(write(f, raw('9007199254740992', '0.1')).ok, true);
  // 9007199254740993 读出来就是 2 的 53 次方，0.10000000000000001 读出来就是 0.1：和存着的值相等，原位保留
  assert.equal(write(f, raw('9007199254740993', '0.10000000000000001')).ok, true);
  assert.equal(write(f, raw('9.007199254740992e15', '1e-1')).ok, true);
  assert.equal(write(f, raw('9007199254740994', '0.1')).code, unknown);
  assert.equal(write(f, raw('9007199254740992', '0.1000000000000001')).code, unknown);
});
test('存量键随标识寻址，数组次序不参与匹配', () => {
  const f = fixture('film-min'), cards = f.shots[0].cards; cards[0].old = 3;
  assert.equal(write(f, patch(set('shots/s01/cards', cards.toReversed()))).ok, true);
  rejects(patch(set('shots/s01/cards', [{ ...cards[0], as: 'other' }])), 6, unknown, undefined, f);
});
test('不可寻址的数组要求整份相等', () => {
  const f = fixture('film-min'), d = f.shots[1].deliberate; d[0].old = 2;
  assert.equal(write(f, patch(set('title', 'ok'))).ok, true);
  rejects(patch(set('shots/s02/deliberate', [{ ...d[0], why: '改动' }])), 6, unknown, undefined, f);
});
test('重复标识不能寻址，替换整个数组可修复', () => {
  const f = fixture('film-min'), cards = f.shots[0].cards; cards.push({ ...cards[0], old: 2 });
  rejects(patch(remove('shots/s01/cards/cam')), 5, impossible, 0, f);
  assert.equal(write(f, patch(set('shots/s01/cards', [cards.at(-1)]))).ok, true);
});
test('类型错误位置下的键不能取得旧值豁免', () => {
  const f = fixture('film-min'); f.shots = { s01: { old: 3 } };
  rejects(patch(set('shots', [{ ...fixture('film-min').shots[0], old: 3 }])), 6, unknown, undefined, f);
});
test('普通对象键不能充当镜头条目标识', () => {
  const f = fixture('film-min'); f.shots = { s01: { cards: [{ as: 'cam' }] } };
  rejects(patch(remove('shots/s01/cards/cam')), 5, impossible, 0, f);
});
test('原型同名键只能作为自有数据写入和查找', () => {
  const f = fixture('film-min'), base = 'shots/s01/cards/cam/params/';
  rejects(patch(set(base + '__proto__/x', 1)), 5, impossible, 0, f);
  const r = write(f, patch(set(base + '__proto__', { x: 1 }), rename(base + '__proto__', 'constructor'), set(base + 'toString', null)));
  const params = r.film.shots[0].cards[0].params;
  assert.deepEqual(params.constructor, { x: 1 }); assert.equal(Object.hasOwn(params, 'toString'), true);
  assert.equal(Object.hasOwn(Object.prototype, 'x'), false);
});

const sha = v => createHash('sha256').update(v).digest('hex');
function catalog(film, issuer) {
  const ctx = { issuer, rev: 7, contracts: '1.0.0', machine: { class: 'test', driver: 'cpu' }, cards: {},
    sources: {}, tools: { data: { host: 'kernel-eval', version: '1.2.3' } }, assets: {}, view: { [film.style.view.scene]: '查找表字节' }, templates: {} };
  const names = new Set(['time.timeline', 'time.events', 'time.seeded', 'comp.display', 'comp.finish', 'deliver.encode', 'audio.master', 'two-d.overlay']);
  for (const s of film.shots) {
    for (const p of [s, s.renderer].filter(Boolean)) ctx.sources[p.source] = {
      version: p.source === 'three' ? '0.187.0' : '1.0.0', host: p.host, image: 'sha256:' + sha('镜像'), motionBlur: { samples: 8 } };
    for (const c of s.cards ?? []) names.add(c.use.split('@')[0]);
  }
  for (const name of names) ctx.cards[name] = { version: '1.2.3', files: { b: '乙', a: '甲' }, impl: ['data'],
    status: [{ level: 'read', host: 'kernel-eval', source: '1.2.3', gpu: 'none' }] };
  for (const owner of [film, ...film.shots]) for (const ref of Object.values(owner.assets ?? {})) ctx.assets[ref] = Buffer.from(ref);
  for (const ref of film.predicates.base) ctx.templates[ref.replace(/^template:/, '').split('@')[0]] = '1.0.0';
  return ctx;
}
for (const name of films) for (const issuer of ['local', 'server']) test(`${name} ${issuer} 锁校验与字节复现`, () => {
  const f = fixture(name), ctx = catalog(f, issuer), lock = generateLock(f, ctx);
  const r = validate({ format: 'lock-check/0.1', lock, film: f });
  assert.deepEqual(r.schemaErrors, []); assert.deepEqual(r.violations, {});
  assert.equal(serializeLock(lock), serializeLock(generateLock(f, ctx)));
  assert.equal(Object.hasOwn(lock, 'rev'), issuer === 'server');
  for (const source of Object.values(lock.sources)) assert.equal(Object.hasOwn(source, 'image'), issuer === 'server');
  assert.equal(lock.cards['time.seeded'].sha256, sha(`a\n${sha('甲')}\nb\n${sha('乙')}\n`));
  assert.equal(lock.view[f.style.view.scene], 'sha256:' + sha('查找表字节'));
  for (const [k, v] of Object.entries(lock.assets)) assert.equal(v, 'sha256:' + sha(ctx.assets[k]));
});
test('种子按大端字节序派生', () => {
  const f = fixture('lab'); f.seed = 7800; delete f.shots[0].seed;
  const c = catalog(f, 'local'); assert.equal(generateLock(f, c).seeds.s01, 2013376959);
  delete f.seed; f.id = 'toon-demo'; assert.equal(generateLock(f, c).seeds.film, 899845905);
});
test('本机工具版本不符时拒签', () => {
  const f = fixture('lab'), c = catalog(f, 'local'); c.tools.data.version = '0.0.1';
  assert.throws(() => generateLock(f, c), /验证记录/);
});
test('缺资产或模板版本不符时拒签', () => {
  const f = fixture('lab'), c = catalog(f, 'server');
  c.templates.floor = '2.0.0'; assert.throws(() => generateLock(f, c), /templates/);
  c.assets = {}; assert.throws(() => generateLock(f, c), /缺少/);
});
test('快门角非零且采样无来源时拒签', () => {
  const f = fixture('film-min'), c = catalog(f, 'local'); delete c.sources.blender.motionBlur;
  assert.throws(() => generateLock(f, c), /samples/);
});
test('确定性序列化忽略对象插入顺序', () => assert.equal(serializeLock({ b: { d: 2, c: 3 }, a: [2, 1] }), '{"a":[2,1],"b":{"c":3,"d":2}}'));
const param = 'shots/s02/cards/title/params/text';
function explainErrors(ex) {
  const v = validate(JSON.parse(JSON.stringify(ex)), 'film', 'explain.schema.json');
  return [...v.schemaErrors, ...Object.values(v.violations).flat()];
}
function context() {
  return { cardDefault: { [param]: { from: '卡', value: '默认' } }, templateOrToken: { [param]: { from: '模板', value: '模板' } },
    jobOverride: { [param]: { from: '作业', value: false } }, coupling: { [param]: ['镜头曝光'] } };
}
for (const winner of ['jobOverride', 'film', 'templateOrToken', 'cardDefault']) test(`覆盖层 ${winner} 胜出`, () => {
  const f = fixture('film-min'), c = context();
  if (winner !== 'jobOverride') delete c.jobOverride;
  if (['templateOrToken', 'cardDefault'].includes(winner)) delete f.shots[1].cards[0].params.text;
  if (winner === 'cardDefault') delete c.templateOrToken;
  const ex = explainParam(f, param, c);
  assert.equal(ex.winnerLayer, winner); assert.deepEqual(ex.value, ex.layers.filter(l => Object.hasOwn(l, 'value')).at(-1).value);
  assert.deepEqual(ex.affects, { shots: ['s02'], frameRange: [180, 300] }); assert.deepEqual(ex.coupling, ['镜头曝光']);
  // 判的是直接交回的对象原样写出去的那份，不是手工挑出来的字段
  assert.deepEqual(explainErrors(ex), []);
});
test('令牌由片子调色表解析', () => {
  const f = fixture('film-min'), c = context(); delete f.shots[1].cards[0].params.text; delete c.jobOverride;
  c.templateOrToken[param] = { token: 'accent', from: '令牌' }; assert.equal(explainParam(f, param, c).value, f.style.tokens.accent);
});
test('全片参数影响所有镜头', () => assert.deepEqual(explainParam(fixture('film-min'), 'style/finish/grain').affects, { shots: ['s01', 's02'], frameRange: [0, 300] }));
test('解释器不沿原型链读取或接受数字下标', () => {
  const f = fixture('film-min'); assert.throws(() => explainParam(f, 'constructor'), /没有 constructor 这个键/);
  assert.throws(() => explainParam(f, 'shots/0'), /数组路径/);
});
test('返回片子可直接续写，落盘没有修订号且数据独立', () => {
  const f = fixture('lab');
  const first = write(f, patch(set('title', '第一次')));
  assert.equal(first.film.rev, 8);
  assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(first.film)), 'rev'), false);
  const second = applyFilmWrite(first.film, { ...patch(set('title', '第二次')), rev: 8 });
  assert.equal(second.film.rev, 9);
  second.film.output.size[0]++;
  assert.deepEqual(first.film.output.size, f.output.size);
});
const rawSet = (path, number, rev = 7) => `{"format":"patch/0.1","rev":${rev},"ops":[{"op":"set","path":"${path}","value":${number}}]}`;
test('数先按双精度读数，再判是不是整数、在不在值域', () => {
  const f = fixture('film-min');
  assert.equal(write(f, rawSet('style/finish/grain', '1.00000000000000001')).film.style.finish.grain, 1);
  assert.equal(write(f, rawSet('seed', '42.000000000000000001')).film.seed, 42);
  assert.equal(write(f, rawSet('output/frames', '300.00000000000000001')).film.output.frames, 300);
  assert.equal(write(f, rawSet('output/frames', '3e2')).film.output.frames, 300);
  assert.equal(write(f, rawSet('seed', '42.5')).code, bad);
  assert.equal(write(f, rawSet('seed', '4294967295')).ok, true);
  assert.equal(write(f, rawSet('seed', '4294967296')).code, bad);
});
test('修订号按双精度读数，整数上限是 9007199254740991', () => {
  const f = fixture('film-min'), title = (rev, current) => applyFilmWrite(f, rawSet('title', '"甲"', rev), { rev: current });
  assert.deepEqual([title('7.00000000000000001', 7).ok, title('7.00000000000000001', 7).rev], [true, 8]);
  const stale = title('7.00000000000000001', 8);
  assert.deepEqual([stale.step, stale.code, stale.latestRev], [1, 'busy.rev-conflict', 8]);
  assert.deepEqual([title('1e-400', 0).ok, title('1e-400', 0).rev], [true, 1]);
  assert.deepEqual([title('7.0', 7).ok, title('0.7e1', 7).ok, title('-0', 0).ok], [true, true, true]);
  for (const out of ['9007199254740992', '9007199254740993', '1e400', '-1', '7.5', '"7"', 'null']) {
    assert.deepEqual([title(out, 7).step, title(out, 7).code], [1, arg], out);
  }
  const top = title('9007199254740991', 7);
  assert.deepEqual([top.step, top.code, top.latestRev], [1, 'busy.rev-conflict', 7]);
  assert.equal(title('9007199254740990', 9007199254740990).rev, 9007199254740991);
  assert.equal(title('9007199254740991', 9007199254740991).ok, false);
});
test('交付通道只认七个固定通道、八个光路通道和分灯组写法', () => {
  const f = fixture('lab'), layers = (list, options) => write(f, patch(set('delivery/layers', list)), options);
  const fixed = ['color', 'depth', 'objectId', 'normal', 'motion', 'denoiseAlbedo', 'denoiseNormal'];
  assert.equal(layers(['depth']).ok, true);
  assert.equal(layers([...fixed, 'lightgroup:key', 'lightgroup:0-rim']).ok, true);
  assert.equal(layers(['lightgroup:key']).ok, true);
  assert.equal(layers(['color', 'diffuseDirect', 'glossyIndirect', 'transmissionDirect', 'emission', 'environment']).ok, true);
  // 调用方给的资料登记不了别的名字
  const beauty = layers(['beauty'], { passNames: ['beauty'] });
  assert.deepEqual([beauty.step, beauty.code, beauty.at], [6, bad, 'delivery/layers']);
  assert.match(beauty.diagnostics[0].hint, /第 1 项.*lightgroup:<名>/);
  for (const name of ['wrong', 'Depth', 'diffuseDirekt', 'lightgroup:', 'lightgroup:-key', 'lightgroup:Key', 'lightgroup:a b', 'color ']) {
    assert.deepEqual([layers(['color', name]).step, layers(['color', name]).code], [6, bad], name);
  }
  assert.equal(layers(['depth', 'depth']).code, bad);
});
test('诊断按未知键定位并建议相近键', () => {
  const r = write(fixture('lab'), patch(set('style/view/scen', 'x')));
  assert.equal(r.diagnostics[0].at, 'style/view/scen'); assert.match(r.diagnostics[0].hint, /scene/);
});
test('添加后按新标识修改和删除', () => {
  const f = fixture('film-min');
  const r = write(f, patch(add('events', { id: 'new', frame: 1 }), set('events/new/frame', 2), remove('events/new')));
  assert.deepEqual(r.film.events, f.events);
});
test('结果嵌套超过上限时拒绝，深层旧扩展原样保留', () => {
  const f = fixture('film-min'); let value = 0;
  for (let i = 0; i < 123; i++) value = { x: value };
  rejects(patch(set('shots/s01/cards/cam/params/x', value)), 6, bad, undefined, f);
  for (let i = 0; i < 200; i++) value = { x: value };
  f.old = value; const r = write(f, patch(set('title', '保留'))); assert.deepEqual(r.film.old, value);
});
test('无效标识下的未知键优先于标识值域', () => {
  const f = fixture('film-min'); f.shots[0].cards[0].as = 'tracks'; f.shots[0].cards[0].old = true;
  rejects(patch(set('title', 'x')), 6, unknown, undefined, f);
});
test('大文本在 16 MiB 边界接受，多一个字节拒绝', () => {
  const text = '{"v":"' + 'a'.repeat(16 * 1024 * 1024 - 8) + '"}';
  assert.equal(parseRequestText(text).ok, true); assert.equal(parseRequestText(text + ' ').step, 1);
});
test('作业临时值不能赋给契约外路径', () => {
  const f = fixture('film-min');
  assert.throws(() => explainParam(f, 'typo', { jobOverride: { typo: { value: 3 } } }), /没有 typo 这个键/);
});

// 以下是独立复核给出的反例，逐条照复核报告的编号收进来。
const u = String.raw;
test('复核 1：转义写出的孤立代理码元在第 1 步拒，成对的放行', () => {
  const f = fixture('film-min');
  const body = (value, rev = 7) => `{"format":"patch/0.1","rev":${rev},"ops":[{"op":"set","path":"title","value":${value}}]}`;
  for (const text of [body(u`"\uD800"`), body(u`"\uD800"`, 6), body(u`"\uDC00\uD800"`), body(u`"a\uD83Db"`), body(u`{"\uDC00":1}`)]) {
    const r = write(f, text);
    assert.deepEqual([r.step, r.code], [1, arg], text);
    assert.deepEqual([parseRequestText(text).step, parseRequestText(text).code], [1, arg], text);
  }
  assert.equal(parseRequestText(u`{"\uDC00":1}`).code, arg);
  // 对象形式的请求体里带着孤立代理码元，同样在第 1 步拒
  assert.equal(write(f, patch(set('title', '\ud800'))).step, 1);
  assert.equal(write(f, body(u`"🐋"`)).film.title, '🐋');
  assert.equal(write(f, body('"🐋"')).film.title, '🐋');
  // 转义的是反斜杠本身，后面跟的只是六个普通字符
  assert.equal(write(f, body(u`"\\uD800"`)).film.title, u`\uD800`);
});
test('复核 2：旧键的值换一种十进制写法原位带回，仍算原值', () => {
  const f = fixture('film-min'); f.style.finish.legacy = 0.1;
  const r = write(f, rawSet('style/finish', '{"grain":0.04,"vignette":0.2,"legacy":0.10000000000000001}'));
  assert.equal(r.ok, true); assert.equal(r.film.style.finish.legacy, 0.1);
});

const firstAt = r => [r.step, r.code, r.at, r.diagnostics[0].at];
test('复核 3：第 6 步几处值域违反，先报书写在前的操作写出的那一处', () => {
  const f = fixture('film-min'), a = set('shots/s01/out', -1), b = set('output/frames', 0);
  assert.deepEqual(firstAt(write(f, patch(a, b))), [6, bad, 'shots/s01/out', 'shots/s01/out']);
  assert.match(write(f, patch(a, b)).message, /^shots\/s01\/out/);
  assert.deepEqual(firstAt(write(f, patch(b, a))), [6, bad, 'output/frames', 'output/frames']);
  assert.match(write(f, patch(b, a)).message, /^output\/frames/);
  // 三个操作，结构定义的遍历顺序正好和书写顺序相反
  const c = set('delivery/master', 'Bad Name');
  assert.equal(write(f, patch(c, b, a)).at, 'delivery/master');
  assert.equal(write(f, patch(a, c, b)).at, 'shots/s01/out');
});
test('复核 3：先写坏、后改好的不算，算最后把它写坏的那个操作', () => {
  const f = fixture('film-min');
  const r = write(f, patch(set('output/frames', 0), set('output/frames', 300), set('style/finish/grain', 2), set('output/frames', 0)));
  assert.equal(r.at, 'style/finish/grain');
  assert.equal(write(f, patch(set('style/finish/grain', 2), set('style/finish/grain', 0.5))).ok, true);
});
test('复核 3：判定函数管的违反和结构违反一起按书写顺序排', () => {
  const f = fixture('film-min'), gap = set('shots/s02/in', 179), frames = set('output/frames', 0);
  assert.match(write(f, patch(gap, frames)).message, /^D1：镜头 s02 的 in 是 179/);
  assert.equal(write(f, patch(frames, gap)).at, 'output/frames');
  assert.equal(write(f, patch(set('output/fps', '60/2'), frames)).at, 'output/fps');
  assert.equal(write(f, patch(frames, set('output/fps', '60/2'))).at, 'output/frames');
});
test('复核 3：作用之前就有的违反排在操作写出的违反后面', () => {
  const f = fixture('film-min'); f.output.frames = 0;
  assert.equal(write(f, patch(set('title', '无关'))).at, 'output/frames');
  assert.equal(write(f, patch(set('title', '无关'), set('style/finish/grain', 2))).at, 'style/finish/grain');
});
test('复核 3：没定义的键有几个写几条，按书写顺序排，压过值域违反', () => {
  const f = fixture('film-min');
  const finish = set('style/finish', { grian: 0.1 }), view = set('style/view', { scene: 'agx-mhc', display: 'srgb', lut: 'x' });
  for (const [ops, want] of [[[finish, view], ['style/finish/grian', 'style/view/lut']], [[view, finish], ['style/view/lut', 'style/finish/grian']]]) {
    const r = write(f, patch(set('output/frames', 0), ...ops));
    assert.deepEqual([r.step, r.code, r.at], [6, unknown, want[0]]);
    assert.deepEqual(r.diagnostics.map(d => d.at), want);
    assert.match(r.diagnostics.find(d => d.at === 'style/finish/grian').hint, /grian.*grain/);
  }
});

test('复核 4：补丁里多带的键，提示写出它和最接近的键，不带 at', () => {
  const r = write(fixture('film-min'), patch({ op: 'set', path: 'title', vale: 'x' }));
  assert.deepEqual([r.step, r.code, r.opIndex], [3, unknown, 0]);
  assert.equal(r.diagnostics.length, 1);
  assert.match(r.diagnostics[0].hint, /vale.*value/); assert.match(r.message, /vale.*value/);
  assert.equal(Object.hasOwn(r.diagnostics[0], 'at'), false);
  const two = write(fixture('film-min'), { ...patch(set('title', 'x'), { ...remove('title'), applicability: 'machine' }), ext: {} });
  assert.deepEqual([two.code, two.opIndex, two.diagnostics.length], [unknown, undefined, 2]);
  assert.match(two.diagnostics[1].hint, /下标 1.*applicability/);
});
test('复核 4：不能寻址到项的数组里的未知键，at 写数组，提示说第几项', () => {
  const f = fixture('film-min'), d = f.shots[1].deliberate[0];
  const r = write(f, patch(set('shots/s02/deliberate', [{ ...d, out: 250 }, { ...d, in: 250, x: 1 }])));
  assert.deepEqual([r.step, r.code, r.at], [6, unknown, 'shots/s02/deliberate']);
  assert.deepEqual(r.diagnostics.map(x => x.at), ['shots/s02/deliberate']);
  assert.match(r.diagnostics[0].hint, /第 2 项.*未知键 x/);
  // 项里写错的标量同样落在数组上、说第几项
  const scalar = write(f, patch(set('shots/s02/deliberate', [{ ...d, kind: 'pause' }])));
  assert.deepEqual([scalar.code, scalar.at], [bad, 'shots/s02/deliberate']);
  assert.match(scalar.diagnostics[0].hint, /第 1 项.*freeze/);
});
test('复核 4：没有合法标识的条目里的未知键，at 写数组，提示说第几项', () => {
  const f = fixture('film-min');
  const r = write(f, patch(add('events', { id: 'Bad Id', frame: 1, extra: true })));
  assert.deepEqual([r.code, r.at], [unknown, 'events']);
  assert.match(r.diagnostics[0].hint, /第 2 项.*extra/);
});
test('复核 4：类型不对的位置报值域，at 写这个位置', () => {
  const f = fixture('film-min');
  for (const [path, value] of [['style/finish/grain', { wrong: 1 }], ['style/tokens/accent', { r: 1 }], ['shots/s01/assets/kit', { ref: 1 }], ['events', { title: {} }], ['shots/s01/cards/cam/use', ['x']]]) {
    const r = write(f, patch(set(path, value)));
    assert.deepEqual([r.step, r.code, r.at, r.diagnostics[0].at], [6, bad, path, path], path);
    assert.match(r.diagnostics[0].hint, /类型应是|写法应合/);
  }
  const gone = write(f, patch(remove('output')));
  assert.deepEqual([gone.code, gone.at], [bad, 'output']); assert.match(gone.diagnostics[0].hint, /缺必填键 output/);
});
test('复核 4：写不成路径的键名，at 写它所在的对象，提示写出键名', () => {
  const f = fixture('film-min');
  const r = write(f, patch(set('style/finish', { 'a/b': 1 })));
  assert.deepEqual([r.code, r.at], [unknown, 'style/finish']); assert.match(r.diagnostics[0].hint, /"a\/b"/);
  const free = write(f, patch(set('shots/s01/cards/cam/params', { 'a b': 1 })));
  assert.deepEqual([free.code, free.at], [bad, 'shots/s01/cards/cam/params']); assert.match(free.diagnostics[0].hint, /"a b"/);
});
test('复核 4：第 4 步的未知键诊断带 at 和相近的键', () => {
  const r = write(fixture('lab'), patch(set('style/view/scen', 'x')));
  assert.deepEqual([r.step, r.code, r.at, r.diagnostics[0].at], [4, unknown, 'style/view/scen', 'style/view/scen']);
  assert.match(r.diagnostics[0].hint, /scen.*scene/);
});

test('复核 6：存着的同名键 rev 是数据，修订号另记，两边互不冒充', () => {
  const f = fixture('film-min'); f.rev = 92;
  const before = structuredClone(f);
  const first = write(f, patch(set('title', '第一次')));
  assert.deepEqual([first.ok, first.rev, first.film.rev, getFilmRev(first.film)], [true, 8, 92, 8]);
  assert.equal(JSON.parse(JSON.stringify(first.film)).rev, 92);
  assert.deepEqual(f, before);
  // 拿结果接着写：修订号读的是记下的 8，不是数据里的 92
  const second = applyFilmWrite(first.film, { ...patch(set('title', '第二次')), rev: 8 });
  assert.deepEqual([second.ok, second.rev, second.film.rev, getFilmRev(second.film)], [true, 9, 92, 9]);
  const stale = applyFilmWrite(second.film, { ...patch(set('title', '过期')), rev: 92 });
  assert.deepEqual([stale.step, stale.code, stale.latestRev], [1, 'busy.rev-conflict', 9]);
  assert.match(explainParam(second.film, 'title').layers[0].from, /^rev 9，/);
  // 改它的值照未知键拒；删掉它以后，结果上才挂不可枚举的修订号
  assert.equal(write(f, patch(set('style/finish/grain', 0.1), rename('rev', 'revision'))).code, unknown);
  const dropped = applyFilmWrite(second.film, { ...patch(remove('rev')), rev: 9 });
  assert.deepEqual([dropped.rev, dropped.film.rev, Object.keys(dropped.film).includes('rev')], [10, 10, false]);
  // 上一次结果上挂着的修订号不是片子描述的键：删不到，也不进下一次的结果
  assert.deepEqual([applyFilmWrite(dropped.film, { ...patch(remove('rev')), rev: 10 }).step], [5]);
  // 没给存储修订号时，数据里的 rev 不当修订号用
  const loose = applyFilmWrite(f, { ...patch(set('title', '乙')), rev: 92 });
  assert.deepEqual([loose.ok, loose.step, loose.code], [false, 1, arg]);
});

const coreFilm = host => { const f = fixture('lab'); f.shots[0].renderer = { source: 'core', host, mode: 'cards-data' }; return f; };
function coreCatalog(f, issuer) {
  const c = catalog(f, issuer); c.sources.core.scenePacks = { s01: '场景包字节' }; return c;
}
const reread = lock => validate(JSON.parse(serializeLock(lock)));
for (const issuer of ['server', 'local']) {
  test(`复核 7：${issuer} 锁缺自有必填字段时拒签，交回的和写出去的都过校验`, () => {
    const f = fixture('lab');
    const machine = catalog(f, issuer); machine.machine = Object.assign(Object.create({ driver: 'cpu' }), { class: 'review' });
    assert.throws(() => generateLock(f, machine), /driver/);
    const gpu = catalog(f, issuer);
    gpu.cards['time.seeded'].status = [Object.assign(Object.create({ gpu: 'none' }), { level: 'read', host: 'kernel-eval', source: '1.2.3' })];
    assert.throws(() => generateLock(f, gpu), /gpu/);
    for (const [key, drop] of [['version', c => c.sources['ext.lab']], ['host', c => c.sources['ext.lab']], ['impl', c => c.cards['comp.display']],
      ['files', c => c.cards['comp.display']], ['level', c => c.cards['comp.display'].status[0]], ['contracts', c => c], ['issuer', c => c]]) {
      const c = catalog(f, issuer), target = drop(c), value = target[key];
      delete target[key]; Object.setPrototypeOf(target, { [key]: value });
      assert.throws(() => generateLock(f, c), new RegExp(key), key);
    }
    const lock = generateLock(f, catalog(f, issuer));
    for (const r of [validate(lock), reread(lock), validate({ format: 'lock-check/0.1', lock, film: f })]) {
      assert.deepEqual([r.schemaErrors, r.violations], [[], {}]);
    }
    assert.deepEqual(JSON.parse(serializeLock(lock)), lock);
  });
  test(`复核 7：${issuer} 锁的 verified 只取四个字段，卡文件验证状态里别的字段不进锁`, () => {
    const f = fixture('lab'), c = catalog(f, issuer);
    for (const card of Object.values(c.cards)) Object.assign(card.status[0], { date: '2026-11-20', parityReport: 'sha256:' + sha('对拍') });
    c.machine.note = '不进锁';
    const lock = generateLock(f, c);
    assert.deepEqual(Object.keys(lock.cards['time.seeded'].verified), ['gpu', 'host', 'level', 'source']);
    assert.deepEqual(lock.machine, { class: 'test', driver: 'cpu' });
  });
  test(`复核 8：${issuer} 锁的计数和修订号出了整数值域时拒签`, () => {
    const min = fixture('film-min');
    for (const samples of [2 ** 53, Infinity, 0, 1.5, '8', NaN]) {
      const c = catalog(min, issuer); c.sources.blender.motionBlur.samples = samples;
      assert.throws(() => generateLock(min, c), /shutterSamples/, String(samples));
      const written = fixture('film-min'); written.shots[0].shutter.samples = samples;
      assert.throws(() => generateLock(written, catalog(written, issuer)), /shutterSamples/, String(samples));
    }
    const top = catalog(min, issuer); top.sources.blender.motionBlur.samples = 9007199254740991;
    assert.equal(generateLock(min, top).shots.s01.shutterSamples, 9007199254740991);
    for (const seed of [4294967296, -1, 0.5, Infinity]) {
      const seeded = fixture('film-min'); seeded.seed = seed;
      assert.throws(() => generateLock(seeded, catalog(seeded, issuer)), /seed/, String(seed));
    }
    for (const rev of [2 ** 53, Infinity, -1, 7.5, '7', NaN]) {
      const c = catalog(min, issuer); c.rev = rev;
      if (issuer === 'server') assert.throws(() => generateLock(min, c), /rev/, String(rev));
      else assert.equal(Object.hasOwn(generateLock(min, c), 'rev'), false);
    }
    const last = catalog(min, issuer); last.rev = 9007199254740991;
    assert.equal(generateLock(min, last).rev, issuer === 'server' ? 9007199254740991 : undefined);
  });
  test(`复核 9：${issuer} 锁的 core 帧源只按离屏宿主签`, () => {
    const page = coreFilm('headless-page');
    assert.deepEqual(validate(page).violations, {});
    assert.throws(() => generateLock(page, coreCatalog(page, issuer)), /core.*offscreen/);
    const off = coreFilm('offscreen'), lock = generateLock(off, coreCatalog(off, issuer));
    assert.equal(lock.sources.core.host, 'offscreen');
    assert.equal(lock.sources.core.scenePacks.s01, 'sha256:' + sha('场景包字节'));
    // 片子描述和资源目录两处写的宿主不同，或者 three 的版本不是锁定的那一个，同样不签
    const mixed = coreCatalog(off, issuer); mixed.sources.core.host = 'headless-page';
    assert.throws(() => generateLock(off, mixed), /宿主/);
    const three = fixture('toon'), old = catalog(three, issuer); old.sources.three.version = '0.186.0';
    assert.throws(() => generateLock(three, old), /0\.187\.0/);
  });
  test(`复核 10：${issuer} 锁的求值核验证记录只认 kernel-eval`, () => {
    const f = fixture('lab'), c = catalog(f, issuer);
    c.tools.data.host = 'review-other';
    for (const card of Object.values(c.cards)) card.status[0].host = 'review-other';
    assert.throws(() => generateLock(f, c), /kernel-eval/);
    // 另有烘焙落点、验证记录对的是烘焙工具时可以签；求值核的名字照旧不能错
    const baked = catalog(f, issuer); baked.tools.bake = { host: 'baker', version: '2.0.0' };
    for (const card of Object.values(baked.cards)) { card.impl = ['data', 'bake']; card.status = [{ level: 'read', host: 'baker', source: '2.0.0', gpu: 'none' }]; }
    assert.equal(generateLock(f, baked).cards['time.seeded'].verified.host, 'baker');
    baked.tools.data.host = 'review-other';
    assert.throws(() => generateLock(f, baked), /kernel-eval/);
  });
}

test('复核 11：叠加层只影响它展开出来的帧', () => {
  assert.deepEqual(explainParam(fixture('toon'), 'overlays/name/text').affects, { shots: ['s01'], frameRange: [54, 96] });
  assert.deepEqual(explainParam(fixture('hard-surface'), 'overlays/callout/anchor').affects, { shots: ['s01'], frameRange: [156, 178] });
  const f = fixture('film-min');
  f.events.push({ id: 'late', frame: 'event(title) + 8' });
  f.overlays = [{ id: 'tag', shot: 's02', anchor: 'screen', pos: [0.5, 0.5], text: '字', in: 'event(late) - 2', out: 'cut(180) + 100' }];
  assert.deepEqual(validate(f).violations, {});
  assert.deepEqual(explainParam(f, 'overlays/tag/text').affects, { shots: ['s02'], frameRange: [198, 280] });
});
test('复核 11：显示变换按镜头的 colorRef 分流', () => {
  const f = fixture('film-min');
  assert.deepEqual(explainParam(f, 'style/view/scene').affects, { shots: ['s01'], frameRange: [0, 180] });
  assert.deepEqual(explainParam(f, 'style/view/display').affects, { shots: ['s02'], frameRange: [180, 300] });
  assert.deepEqual(explainParam(f, 'style/finish/grain').affects, { shots: ['s01', 's02'], frameRange: [0, 300] });
  // 一个场景参考镜头都没有时，Explain 写不出空的帧区间，照实报出来
  assert.throws(() => explainParam(fixture('lab'), 'style/view/scene'), /不影响任何镜头.*colorRef 是 scene/);
});
test('复核 11：事件、转场、旁白、色彩脚本各自落到的镜头和帧', () => {
  const f = fixture('film-min');
  f.assets = { vo: 'asset:vo-open@1' };
  f.audio.narration = [{ id: 'vo-open', at: 'event(title) + 3', asset: 'vo' }];
  f.style.colorScript = { s01: { key: ['#101216'], tol: 10 } };
  assert.deepEqual(validate(f).violations, {});
  assert.deepEqual(explainParam(f, 'events/title/audio').affects, { shots: ['s02'], frameRange: [180, 300] });
  assert.deepEqual(explainParam(f, 'transitions/cut-180/type').affects, { shots: ['s01', 's02'], frameRange: [0, 300] });
  assert.deepEqual(explainParam(f, 'audio/narration/vo-open/asset').affects, { shots: ['s02'], frameRange: [195, 300] });
  assert.deepEqual(explainParam(f, 'style/colorScript/s01/tol').affects, { shots: ['s01'], frameRange: [0, 180] });
  assert.deepEqual(explainParam(f, 'shots/s01/shutter/angleDeg').affects, { shots: ['s01'], frameRange: [0, 180] });
});
test('复核 12：走到标量就停，不读字符串和数组自带的属性', () => {
  const f = fixture('film-min'), text = 'shots/s02/cards/title/params/text';
  assert.equal(explainParam(f, text).value, 'RTX 5090');
  for (const tail of ['length', '0', 'at', 'constructor', '__proto__']) assert.throws(() => explainParam(f, `${text}/${tail}`), /标量/, tail);
  for (const path of ['shots/s01/cards/cam/params/keys/0', 'shots/s01/cards/cam/params/keys/length', 'output/size/0', 'output/size/length']) {
    assert.throws(() => explainParam(f, path), TypeError, path);
  }
  // 同一位置往下写子键的补丁，在第 5 步不可作用
  rejects(patch(set(`${text}/length`, 9)), 5, impossible, 0, f);
  f.shots[1].cards[0].params.text = { length: 3 };
  assert.equal(explainParam(f, `${text}/length`).value, 3);
});
test('复核 13：直接交回的 Explain 原样写出去就合结构定义，胜出层照样读得到', () => {
  for (const [name, path] of [['toon', 'shots/s01/params/bands'], ['film-min', 'audio/loudness'], ['hard-surface', 'shots/s01/cards/fit/params/margin']]) {
    const ex = explainParam(fixture(name), path);
    assert.deepEqual(explainErrors(ex), [], path);
    assert.equal(ex.winnerLayer, 'film');
    assert.deepEqual(Object.keys(ex), ['path', 'value', 'unit', 'layers', 'coupling', 'affects']);
    assert.equal(JSON.stringify(ex).includes('winnerLayer'), false);
    assert.equal(Object.hasOwn({ ...ex }, 'winnerLayer'), false);
  }
});
test('复核 14：契约定了单位的字段照契约回单位', () => {
  const f = fixture('film-min');
  f.style.colorScript = { s01: { key: ['#101216'], tol: 10 } };
  f.shots[0].handles = { head: 0, tail: 2 };
  for (const [path, unit] of [['output/frames', '帧'], ['audio/loudness', 'LUFS'], ['audio/truePeak', 'dBTP'], ['output/size', '像素'],
    ['output/fps', '帧每秒'], ['timeline/bpm', '拍每分钟'], ['timeline/beatFrames', '帧'], ['shots/s01/in', '帧'], ['shots/s02/out', '帧'],
    ['shots/s01/shutter/angleDeg', '度'], ['shots/s01/tiers/draft/samples', '次'], ['shots/s01/tiers/draft/scale', '无'],
    ['shots/s01/handles/tail', '帧'], ['transitions/cut-180/at', '帧'], ['events/title/frame', '帧'], ['style/colorScript/s01/tol', '色差'],
    ['style/finish/grain', '无'], ['title', '无'], ['shots/s01/seed', '无']]) {
    assert.equal(explainParam(f, path).unit, unit, path);
    // 问的人另给的单位改不了契约定的单位
    assert.equal(explainParam(f, { path, unit: '光年' }).unit, unit, path);
  }
  assert.equal(explainParam(fixture('toon'), 'overlays/name/in').unit, '帧');
});
test('复核 14：卡的参数照参数资料回单位', () => {
  const f = fixture('hard-surface'), margin = 'shots/s01/cards/fit/params/margin', az = 'shots/s01/cards/fit/params/azimuthDeg';
  const cards = { 'camera.fit': { params: { margin: { unit: '主体占画高的比例' }, azimuthDeg: { unit: 'deg' } } } };
  assert.equal(explainParam(f, margin).unit, '无');
  assert.equal(explainParam(f, margin, { cards }).unit, '主体占画高的比例');
  assert.equal(explainParam(f, az, { cards }).unit, 'deg');
  assert.equal(explainParam(f, az, { cards: { 'camera.fit@1': cards['camera.fit'] } }).unit, 'deg');
  assert.equal(explainParam(f, margin, { cards, units: { [margin]: '比例' } }).unit, '比例');
  assert.equal(explainParam(f, { path: margin, unit: '倍' }, { cards }).unit, '倍');
  assert.equal(explainParam(f, margin, { cardDefault: { [margin]: { from: 'camera.fit@1.0.0', value: 0.9, unit: '画高占比' } } }).unit, '画高占比');
  assert.throws(() => explainParam(f, { path: margin, unit: '' }), /单位/);
  assert.equal(explainParam(fixture('toon'), { path: 'shots/s01/params/bands', unit: '阶' }).unit, '阶');
});
test('应该修 1：知道修订号时写进片子层的出处', () => {
  const f = fixture('film-min');
  assert.deepEqual(explainParam(f, 'title').layers, [{ layer: 'film', from: 'film.json', value: f.title }]);
  const first = write(f, patch(set('title', '第一次')));
  const second = applyFilmWrite(first.film, { ...patch(set('title', '第二次')), rev: 8 });
  assert.deepEqual(explainParam(first.film, 'title').layers, [{ layer: 'film', from: 'rev 8，film.json', value: '第一次' }]);
  assert.deepEqual(explainParam(second.film, 'title').layers, [{ layer: 'film', from: 'rev 9，film.json', value: '第二次' }]);
  assert.equal(explainParam(f, 'title', { rev: 5 }).layers[0].from, 'rev 5，film.json');
  assert.equal(explainParam(first.film, 'title', { film: { title: { from: 'rev 8，agent 写入' } } }).layers[0].from, 'rev 8，agent 写入');
});

// 复核报告「六步报码和原子性实测」：每一步各取一处毛病，两两配对、正逆两种书写顺序，都报靠前的那一步
const faults = {
  2: remove('id'), 3: { op: 'set', path: 'title' }, 4: set('typo', 1), 5: remove('missing'), 6: set('title', 42),
};
const codes = { 1: 'busy.rev-conflict', 2: 'contract.immutable-key', 3: arg, 4: unknown, 5: impossible, 6: bad };
for (let early = 1; early <= 6; early++) for (let late = early + 1; late <= 6; late++) {
  test(`六步配对：第 ${early} 步先于第 ${late} 步，正逆序相同`, () => {
    const f = fixture('film-min'), before = structuredClone(f);
    const pairs = early === 1
      ? [{ ...patch(faults[late], set('title', '甲')), rev: 6 }, { ...patch(set('title', '甲'), faults[late]), rev: 6 }]
      : [patch(faults[early], faults[late]), patch(faults[late], faults[early])];
    for (const [i, body] of pairs.entries()) {
      const r = write(f, body);
      assert.deepEqual([r.ok, r.step, r.code], [false, early, codes[early]]);
      if (early >= 2 && early <= 5) assert.equal(r.opIndex, i);
      assert.deepEqual(f, before);
    }
  });
}
test('同一步里几个操作都有毛病，报书写在前的；未知键压过书写顺序', () => {
  const f = fixture('film-min');
  for (const [a, b, step, codeA, codeB] of [
    [remove('predicates'), remove('exam'), 2, 'auth.base-readonly', 'contract.immutable-key'],
    [set('output/typo', 1), remove('events/2/frame'), 4, unknown, pathError],
    [rename('title', 'format'), remove('events/nope'), 5, impossible, impossible]]) {
    for (const [ops, code] of [[[a, b], codeA], [[b, a], codeB]]) {
      const r = write(f, patch(...ops));
      assert.deepEqual([r.step, r.code, r.opIndex], [step, code, 0]);
    }
  }
  const extra = { ...remove('title'), extra: 1 }, plain = { op: 'set', path: 'title' };
  assert.deepEqual([write(f, patch(plain, extra)).code, write(f, patch(plain, extra)).opIndex], [unknown, 1]);
  assert.deepEqual([write(f, patch(extra, plain)).code, write(f, patch(extra, plain)).opIndex], [unknown, 0]);
});

// 复核报告「不变量与产物核对」：片子契约里只读片子描述自己的 13 条，冻结反例逐个送进真实写入口，只改无关的 title
test('冻结的片子反例 34 个都在第 6 步按值域拒', () => {
  const dir = new URL('./contracts/film/counterexamples/', import.meta.url);
  const read = name => JSON.parse(readFileSync(new URL(name, dir), 'utf8'));
  const own = new Set(['D1', 'D2', 'D8', 'D10', 'D11', 'D12', 'D13', 'D14', 'D16', 'D17', 'D18', 'D19', 'D20']);
  let count = 0;
  for (const entry of read('index.json')) {
    if (!own.has(entry.violates[0])) continue;
    const record = read(entry.file), film = record.format === 'film/3.0' ? record : record.film;
    const r = write(film, patch(set('title', '无关')));
    assert.deepEqual([r.ok, r.step, r.code], [false, 6, bad], entry.file);
    assert.match(r.message, new RegExp(`^${entry.violates[0]}：`), entry.file);
    count++;
  }
  assert.equal(count, 34);
});

// 复核报告「可复制的最小复现」原样收进来，五个输出各对一条断言
test('复核报告的最小复现脚本', () => {
  const film = fixture('film-min');
  const writeMin = body => applyFilmWrite(film, body, { rev: 7 });
  assert.equal(writeMin(String.raw`{"format":"patch/0.1","rev":7,"ops":[{"op":"set","path":"title","value":"\uD800"}]}`).ok, false);
  assert.match(writeMin(patch(set('shots/s01/out', -1), set('output/frames', 0))).message, /^shots\/s01\/out/);
  assert.equal(writeMin(patch(set('delivery/layers', ['depth']))).code, undefined);
  assert.deepEqual(explainParam(fixture('toon'), 'overlays/name/text').affects, { shots: ['s01'], frameRange: [54, 96] });
  const f = fixture('lab');
  const names = ['time.timeline', 'time.events', 'time.seeded', 'comp.display', 'deliver.encode'];
  const card = { version: '1.0.0', impl: ['data'], files: { a: 'bytes' },
    status: [{ level: 'read', host: 'kernel-eval', source: '1.0.0', gpu: 'none' }] };
  const context = { issuer: 'server', rev: 7, contracts: '1.0.0',
    machine: Object.assign(Object.create({ driver: 'cpu' }), { class: 'review' }),
    tools: { data: { host: 'kernel-eval', version: '1.0.0' } },
    sources: { 'ext.lab': { version: '1.0.0', host: 'plugin', image: 'sha256:' + '0'.repeat(64) } },
    cards: Object.fromEntries(names.map(n => [n, card])), assets: { 'asset:lab-piece@1': 'bytes' },
    view: { 'agx-mhc': 'lut' }, templates: { floor: '1.0.0', 'delivery-web': '1.0.0' } };
  // 缺自有的 driver：不签。补上以后签出来的锁写出去再读回，结构错误是空的
  assert.throws(() => generateLock(f, context), /driver/);
  context.machine = { class: 'review', driver: 'cpu' };
  assert.deepEqual(validate(JSON.parse(serializeLock(generateLock(f, context)))).schemaErrors, []);
});

test('二审 7 项回归：无净效果操作不改首错、D20 定位项号、拒继承验证槽、跨镜头事件卡依赖、Explain 上下文与单位及自定义出处修订号', () => {
  const base = fixture('film-min');
  const write7 = (...ops) => applyFilmWrite(base, { format: 'patch/0.1', rev: 7, ops }, { rev: 7 });
  const badExtra = set('predicates/extra', ['visible', 'a;b']);
  const badGrain = set('style/finish/grain', 2);

  // 第 3、4 项
  const r3a = write7(badExtra, badGrain);
  const r3b = write7(badExtra, badGrain, set('format', 'temp'), set('format', 'film/3.0'));
  const r3c = write7(badGrain, badExtra, set('format', 'temp'), set('format', 'film/3.0'));
  assert.equal(r3a.message, r3b.message);
  assert.match(r3c.message, /grain/);
  assert.equal(r3a.diagnostics[0].at, 'predicates/extra');
  assert.match(r3a.diagnostics[0].hint, /第 2 项/);

  // 第 7 项
  const lab = fixture('lab');
  for (const issuer of ['server', 'local']) {
    const row = { level: 'read', host: 'kernel-eval', source: '1.0.0', gpu: 'none' };
    const inheritedStatus = new Array(1);
    Object.setPrototypeOf(inheritedStatus, Object.assign(Object.create(Array.prototype), { 0: row }));
    const names = ['time.timeline', 'time.events', 'time.seeded', 'comp.display', 'deliver.encode'];
    const cards = Object.fromEntries(names.map(n => [n, { version: '1.0.0', impl: ['data'],
      files: { a: 'bytes' }, status: n === 'time.seeded' ? inheritedStatus : [row] }]));
    const ctx = { issuer, rev: 7, contracts: '1.0.0', machine: { class: 'review', driver: 'cpu' },
      tools: { data: { host: 'kernel-eval', version: '1.0.0' } }, cards,
      sources: { 'ext.lab': { host: 'plugin', version: '1.0.0', image: 'sha256:' + '0'.repeat(64) } },
      assets: { 'asset:lab-piece@1': 'bytes' }, view: { 'agx-mhc': 'lut' },
      templates: { floor: '1.0.0', 'delivery-web': '1.0.0' } };
    assert.throws(() => generateLock(lab, ctx), /验证记录/);
  }

  // 第 11、13 项
  const f11 = fixture('film-min');
  const typedCard = JSON.parse(readFileSync(new URL('./contracts/card-file/examples/typed-params.json', import.meta.url), 'utf8'));
  f11.events = [{ id: 'cue', shot: 's01', frame: 48 }];
  f11.shots[1].cards[0].params.enter = 'event(cue) + 160';
  assert.deepEqual(explainParam(f11, 'events/cue/frame', { cards: { [typedCard.id]: typedCard } }).affects, {
    shots: ['s01', 's02'],
    frameRange: [0, 300],
  });
  assert.throws(() => explainParam(f11, 'title', { jobOverride: { title: { value: 'x', from: '' } } }), TypeError);
  assert.throws(() => explainParam(f11, 'title', { coupling: { title: [''] } }), TypeError);

  // 第 14 项
  const t14 = fixture('toon');
  const bandPath = 'shots/s01/params/bands';
  delete t14.shots[0].params.bands;
  const e14 = explainParam(t14, bandPath, {
    cardDefault: { [bandPath]: { from: '卡', value: 2, unit: '阶' } },
    jobOverride: { [bandPath]: { from: '作业', value: null, unit: '米' } },
  });
  assert.equal(e14.winnerLayer, 'cardDefault');
  assert.equal(e14.value, 2);
  assert.equal(e14.unit, '阶');

  // 第 15 项
  let cur = fixture('film-min');
  const r8 = applyFilmWrite(cur, { format: 'patch/0.1', rev: 7, ops: [set('title', 'v7')] }, { rev: 7 });
  const r9 = applyFilmWrite(r8.film, { format: 'patch/0.1', rev: 8, ops: [set('title', 'v8')] });
  const f8 = explainParam(r8.film, 'title', { film: { title: { from: '片名编辑器' } } }).layers[0].from;
  const f9 = explainParam(r9.film, 'title', { film: { title: { from: '片名编辑器' } } }).layers[0].from;
  assert.notEqual(f8, f9);
  assert.match(f8, /rev 8/);
  assert.match(f9, /rev 9/);
});
