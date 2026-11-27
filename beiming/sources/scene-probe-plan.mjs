// Plans for the optional session.probe method and per-frame metadata.
import { types } from 'node:util';
import { SourceError } from './three/hosts.mjs';

const BOTH = ['probe.ground', 'probe.deform', 'probe.joint-vel', 'probe.near-clip', 'probe.tri-budget'];
export const PROBE_KINDS = Object.freeze({
  three: Object.freeze([...BOTH, 'probe.footslide']),
  blender: Object.freeze([...BOTH, 'probe.section', 'probe.contact']),
});
const OPTIONS = {
  'probe.ground': ['tol'],
  'probe.contact': ['against', 'tol'],
  'probe.section': ['axis', 'offset'],
  'probe.deform': ['rest'],
  'probe.footslide': ['tol'],
  'probe.joint-vel': ['tol', 'against', 'window', 'bone', 'againstBone'],
  'probe.near-clip': ['distance'],
  'probe.tri-budget': ['limit'],
};
const TARGET = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*(\.\*)?$/;
const bad = (message) => new SourceError('usage.bad-argument', message);
const ownValue = (object, key) => Object.getOwnPropertyDescriptor(object, key)?.value;
const isProbe = (kind) => typeof kind === 'string' && Object.hasOwn(OPTIONS, kind);

function sceneProbeKind(query) {
  if (!query || typeof query !== 'object' || types.isProxy(query)) return undefined;
  const kind = ownValue(query, 'kind');
  return isProbe(kind) ? kind : undefined;
}

export function withProbeCaps(caps) {
  return { ...caps, ext: { ...caps.ext, 'scene.probes': [...PROBE_KINDS[caps.id]] } };
}

export function planProbe(source, query, frames, names) {
  const kind = sceneProbeKind(query);
  if (!kind) throw bad('场景探针必须给出已登记的 kind');
  if (!PROBE_KINDS[source]?.includes(kind)) {
    throw new SourceError('contract.unsupported-query', `这个帧源不答 ${kind} 探针`,
      [{ verb: 'PUT /v1/films/{id}/film', why: '把镜头切到支持该探针的帧源，或使用该帧源可用的场景探针' }]);
  }
  const keys = OPTIONS[kind], descriptors = Object.getOwnPropertyDescriptors(query);
  if (Array.isArray(query) || ![null, Object.prototype].includes(Object.getPrototypeOf(query))
      || Reflect.ownKeys(descriptors).some((key) => !['kind', 'of', ...keys].includes(key)
        || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value'))) throw bad('场景探针参数无效');
  const input = Object.fromEntries(Object.entries(descriptors).map(([key, d]) => [key, d.value]));

  function targets(list, key) {
    if (!Array.isArray(list) || types.isProxy(list) || !list.length) throw bad(`${key} 必须是非空实体列表`);
    const found = new Set();
    if (Reflect.ownKeys(list).length !== list.length + 1) throw bad(`${key} 必须是纯数据数组`);
    for (let i = 0; i < list.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(list, i), target = descriptor?.value;
      if (!descriptor?.enumerable || typeof target !== 'string' || !TARGET.test(target)) throw bad(`${key} 必须填实体名或前缀.*`);
      if (target.endsWith('.*')) {
        names.filter((name) => name.startsWith(target.slice(0, -1))).forEach((name) => found.add(name));
      } else if (names.includes(target)) found.add(target);
      else throw bad(`镜头里没有实体 ${target}`);
    }
    return [...found].sort();
  }

  const plan = { kind, of: Object.hasOwn(input, 'of') ? targets(input.of, 'of') : [...names].sort() };
  if (kind === 'probe.tri-budget' && !Object.hasOwn(input, 'of')) plan.allScene = true;
  for (const key of keys) {
    if (Object.hasOwn(input, key)) plan[key] = key === 'against' ? targets(input[key], key) : input[key];
  }
  const ranges = { tol: [0, Infinity], rest: [0, frames - 1], offset: [-Infinity, Infinity],
    window: [1, 120], distance: [Number.MIN_VALUE, Infinity], limit: [0, Number.MAX_SAFE_INTEGER] };
  for (const [key, [lo, hi]] of Object.entries(ranges)) {
    if (!Object.hasOwn(plan, key)) continue;
    const v = plan[key];
    if (!Number.isFinite(v) || v < lo || v > hi || (['rest', 'window', 'limit'].includes(key) && !Number.isSafeInteger(v))) {
      throw bad(`场景探针的 ${key} 超出值域`);
    }
  }
  if (Object.hasOwn(plan, 'axis') && !['x', 'y', 'z'].includes(plan.axis)) throw bad('剖面 axis 必须是 x、y 或 z');
  if (kind === 'probe.joint-vel' && plan.against && plan.against.length !== 1) {
    throw bad('关节滞后探针的 against 必须指定一个主关节');
  }
  for (const key of ['bone', 'againstBone']) {
    if (Object.hasOwn(plan, key) && (typeof plan[key] !== 'string' || !plan[key].length || plan[key].length > 128)) {
      throw bad(`${key} 必须是骨骼名`);
    }
  }
  if (plan.bone && plan.of.length !== 1) throw bad('bone 必须和一个已登记实体一起指定');
  if (plan.againstBone && !plan.against) throw bad('againstBone 必须同时指定 against');
  return plan;
}

export function planProbes(source, config, frames, names) {
  if (config === undefined) return [];
  if (!Array.isArray(config) || types.isProxy(config) || config.length > 16) throw bad('params.sceneProbes 必须是至多 16 项的数组');
  return Array.from({ length: config.length }, (_, i) => planProbe(source, ownValue(config, i), frames, names));
}
