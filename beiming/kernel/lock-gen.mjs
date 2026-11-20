import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import sourceRegistry from './contracts/source/source.json' with { type: 'json' };
import { loadContracts } from './contracts/validate.mjs';
import { checks as lockChecks } from './contracts/lock/check.mjs';
import { checks as filmChecks } from './contracts/film/check.mjs';

const { validate } = await loadContracts();
const MAX_INTEGER = 9007199254740991;
const MAX_SEED = 4294967295;
// 全程只读自有属性：继承来的字段不算这份资料给过的。
const get = (o, k) => o != null && Object.hasOwn(o, k) ? o[k] : undefined;
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const map = () => Object.create(null);
const hash = bytes => createHash('sha256').update(bytes).digest();
const seed = text => hash(text).readUInt32BE(0);
const digest = bytes => 'sha256:' + hash(bytes).toString('hex');
function need(o, key) {
  const value = get(o, key);
  if (value === undefined) throw new TypeError(`缺少锁生成资料 ${key}`);
  return value;
}
function text(o, key) {
  const value = need(o, key);
  if (typeof value !== 'string' || !value) throw new TypeError(`锁生成资料 ${key} 必须是不空的字符串`);
  return value;
}
function integer(value, min, max, what) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${what} 必须是 ${min} 到 ${max} 的整数`);
  return value;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isObj(value)) return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    Object.defineProperty(out, key, { value: canonical(value[key]), enumerable: true, writable: true, configurable: true });
  }
  return out;
}
export const serializeLock = lock => JSON.stringify(canonical(lock));

function cardHash(files) {
  if (!isObj(files)) throw new TypeError('卡目录不合法');
  const names = Object.keys(files).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  if (!names.length) throw new Error('卡目录为空');
  const h = createHash('sha256');
  for (const name of names) h.update(`${name}\n${hash(files[name]).toString('hex')}\n`);
  return h.digest('hex');
}

// 锁格式当前选定的宿主（LK 契约 3.3 和第 6 节）：three 用页面宿主、版本 0.187.0，core 用离屏宿主。
// 登记表里别的宿主（例如 core 的 headless-page）片子描述写得进去，锁不出。
function lockedHost(who, source, host, version) {
  const registered = get(sourceRegistry.sources, source);
  if (registered && !registered.hosts.includes(host)) throw new Error(`${who}：宿主 ${host} 不在帧源 ${source} 的登记表里`);
  if (source === 'three' && host !== 'page') throw new Error(`${who}：帧源 three 的锁条目用页面宿主 page，不是 ${host}`);
  if (source === 'three' && version !== '0.187.0') throw new Error(`${who}：帧源 three 的版本必须是 0.187.0，不是 ${version}`);
  if (source === 'core' && host !== 'offscreen') throw new Error(`${who}：帧源 core 的锁条目用离屏宿主 offscreen，不是 ${host}`);
}

function verify(lock, film) {
  const result = validate(lock);
  const errors = [...result.schemaErrors, ...Object.values(result.violations).flat()];
  if (!errors.length) {
    for (const check of Object.values(lockChecks)) errors.push(...check({ format: 'lock-check/0.1', lock, film }));
    errors.push(...filmChecks.D3({ format: 'film-check/0.1', film, lock }));
  }
  if (errors.length) throw new Error(`生成的锁不合锁文件契约，不出锁：\n${errors.join('\n')}`);
}

// context 是这台机器或服务器解析出来的资源目录：
//   issuer 'server' | 'local'；contracts 契约集版本；rev 修订号（只有 server 用）；machine { class, driver }（server 必填）
//   sources { 帧源名: { version, host, image?, browser?, motionBlur?: { samples }, scenePacks?: { 镜头 id: 字节 } } }
//   cards { 卡名: { version, impl, files: { 路径: 字节 }, status: [{ level, host, source, gpu }] } }
//   tools { data | bake | comp: { host, version } }：装着的求值核、烘焙工具、合成工具；data 的 host 必须是 kernel-eval
//   assets { 资产引用: 字节 }；view { 查找表名: 字节 }；templates { 名字: 三段版本 }
// 交回的锁是序列化之后再读回来的对象，和 serializeLock 写出去的字节是同一份内容。
export function generateLock(film, context) {
  const issuer = need(context, 'issuer');
  const lock = { format: 'lock/1.0', issuer, film: need(film, 'id'), contracts: need(context, 'contracts'),
    seeds: map(), shots: map(), sources: map(), cards: map(), assets: map(), templates: map(), view: map() };
  if (issuer === 'server') lock.rev = integer(need(context, 'rev'), 0, MAX_INTEGER, '修订号 rev');
  if (issuer === 'server' || get(context, 'machine') !== undefined) {
    const machine = need(context, 'machine');
    lock.machine = { class: need(machine, 'class'), driver: need(machine, 'driver') };
  }
  const filmSeed = get(film, 'seed');
  lock.seeds.film = filmSeed === undefined ? seed(text(film, 'id')) : integer(filmSeed, 0, MAX_SEED, '全片种子 seed');
  const shots = need(film, 'shots');
  if (!Array.isArray(shots)) throw new TypeError('shots 必须是数组');
  const contextSources = need(context, 'sources');
  for (const shot of shots) {
    const id = text(shot, 'id'), renderer = get(shot, 'renderer');
    const shotSeed = get(shot, 'seed');
    lock.seeds[id] = shotSeed === undefined ? seed(`${lock.seeds.film}:${id}`) : integer(shotSeed, 0, MAX_SEED, `镜头 ${id} 的 seed`);
    for (const p of renderer === undefined ? [shot] : [shot, renderer]) {
      const who = p === shot ? `镜头 ${id}` : `镜头 ${id} 的 renderer`;
      const source = text(p, 'source'), info = need(contextSources, source);
      const version = text(info, 'version'), host = text(info, 'host');
      if (host !== need(p, 'host')) throw new Error(`${who}：片子描述写的宿主是 ${get(p, 'host')}，资源目录里帧源 ${source} 的宿主是 ${host}`);
      lockedHost(who, source, host, version);
      if (!Object.hasOwn(lock.sources, source)) {
        const entry = { version, host };
        if (issuer === 'server') entry.image = need(info, 'image');
        const browser = get(info, 'browser');
        if (browser !== undefined) entry.browser = browser;
        if (source === 'core') entry.scenePacks = map();
        lock.sources[source] = entry;
      }
      if (source === 'core') lock.sources[source].scenePacks[id] = digest(need(need(info, 'scenePacks'), id));
    }
    // 生效的子帧采样数（LK 契约 3.2）：写了就照抄；没写时快门角是 0 取 1，不是 0 用出帧者能力声明的值
    const shutter = get(shot, 'shutter');
    const producer = need(contextSources, text(renderer ?? shot, 'source'));
    const samples = get(shutter, 'samples') ?? ((get(shutter, 'angleDeg') ?? 0) === 0 ? 1 : need(get(producer, 'motionBlur'), 'samples'));
    lock.shots[id] = { shutterSamples: integer(samples, 1, MAX_INTEGER, `镜头 ${id} 的 shutterSamples`) };
  }
  const contextCards = need(context, 'cards');
  function addCard(ref, from) {
    if (typeof ref !== 'string') throw new TypeError('卡的引用必须是字符串');
    const [name, major] = ref.split('@');
    const info = need(contextCards, ref === name || !Object.hasOwn(contextCards, ref) ? name : ref);
    const version = text(info, 'version');
    if (major !== undefined && version.split('.')[0] !== major) throw new Error(`卡 ${ref} 的主版本不符`);
    if (Object.hasOwn(lock.cards, name) && lock.cards[name].version !== version) throw new Error(`卡 ${name} 的版本冲突`);
    const impl = need(info, 'impl');
    if (!Array.isArray(impl)) throw new TypeError(`卡 ${ref} 的 impl 必须是字符串数组`);
    for (let idx = 0; idx < impl.length; idx++) {
      if (!Object.hasOwn(impl, idx) || typeof impl[idx] !== 'string') {
        throw new TypeError(`卡 ${ref} 的 impl 必须是自有字符串数组`);
      }
    }
    // 验证状态不能借（LK 契约 5.4、5.8）：有帧源落点的卡对锁里它的落点帧源；别的卡对装着的工具，求值核的名字只认 kernel-eval
    const landings = impl.filter(v => v.startsWith('source:')).map(v => get(lock.sources, v.slice('source:'.length)));
    const hosts = landings.length ? landings.filter(Boolean).map(s => [s.host, s.version]) : impl.flatMap(v => {
      const tool = get(need(context, 'tools'), v);
      if (tool === undefined) return [];
      const host = text(tool, 'host');
      if (v === 'data' && host !== 'kernel-eval') throw new Error(`卡 ${ref}：落点 data 对应求值核，宿主名必须是 kernel-eval，不是 ${host}`);
      return [[host, text(tool, 'version')]];
    });
    const statuses = need(info, 'status');
    if (!Array.isArray(statuses)) throw new TypeError(`卡 ${ref} 的 status 必须是数组`);
    let matched;
    for (let idx = 0; idx < statuses.length; idx++) {
      if (!Object.hasOwn(statuses, idx)) continue;
      const item = statuses[idx];
      if (hosts.some(([host, v]) => get(item, 'host') === host && get(item, 'source') === v)) {
        matched = item;
        break;
      }
    }
    if (!matched) throw new Error(`卡 ${ref} 缺少对应宿主与版本的验证记录`);
    const verified = { level: need(matched, 'level'), host: need(matched, 'host'), source: need(matched, 'source'), gpu: need(matched, 'gpu') };
    lock.cards[name] = { version, impl: [...impl], sha256: cardHash(need(info, 'files')), verified, ...(from ? { from } : {}) };
  }
  for (const name of ['time.timeline', 'time.events', 'time.seeded']) addCard(name);
  for (const shot of shots) for (const card of get(shot, 'cards') ?? []) addCard(need(card, 'use'));
  const style = need(film, 'style');
  for (const [key, name, block] of [
    ['style.view', 'comp.display', need(style, 'view')], ['style.finish', 'comp.finish', get(style, 'finish')],
    ['delivery', 'deliver.encode', need(film, 'delivery')], ['audio', 'audio.master', get(film, 'audio')],
  ]) if (block !== undefined) {
    const ref = get(block, 'card') ?? name;
    if (typeof ref !== 'string' || ref.split('@')[0] !== name) throw new Error(`全片键 ${key} 的绑卡不符`);
    addCard(ref, key);
  }
  if (get(film, 'overlays')?.length) addCard('two-d.overlay' + '@1', 'overlays');
  const contextAssets = need(context, 'assets');
  for (const owner of [film, ...shots]) {
    const ownerAssets = get(owner, 'assets');
    if (!isObj(ownerAssets)) continue;
    for (const ref of Object.values(ownerAssets)) {
      if (!Object.hasOwn(lock.assets, ref)) lock.assets[ref] = digest(need(contextAssets, ref));
    }
  }
  const scene = text(need(style, 'view'), 'scene');
  lock.view[scene] = digest(need(need(context, 'view'), scene));
  const contextTemplates = need(context, 'templates');
  for (const ref of need(need(film, 'predicates'), 'base')) {
    const [name] = String(ref).replace(/^template:/, '').split('@');
    lock.templates[name] = need(contextTemplates, name);
  }
  // 签发前判手里这份，签发后判写出去再读回来的那份：交回的和落盘的是同一份内容
  const issued = canonical(lock);
  verify(issued, film);
  const out = JSON.parse(JSON.stringify(issued));
  verify(out, film);
  return out;
}
