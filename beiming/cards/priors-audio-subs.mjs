// C10：声音、配乐、配音与字幕的先验库（priors-data/audio-subs.*.json）。
// 可移植量走 C9 priors/0.1 检索库；挂卡先验与做法只读返回，不当默认值。分流口径见 manifest 的 rules。

import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { createPriorsStore } from './priors.mjs';

const text = (name) => readFileSync(new URL(`./priors-data/${name}`, import.meta.url), 'utf8');
const read = (name) => JSON.parse(text(name));

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}

let cache;
function data() {
  cache ??= deepFreeze({
    cardPriors: read('audio-subs.card-priors.json').entries,
    practices: read('audio-subs.practices.json').entries,
    manifest: read('audio-subs.manifest.json'),
  });
  return cache;
}

let store;
/** 可移植先验检索库（过 C9 整表校验；条目全部「未在我方读回」）。 */
export function loadAudioSubsPriorsStore() {
  // 传原文而不是 JSON.parse 后的对象：重复键（prior.duplicate-key）只有 C9 看原文时才拦得住。
  store ??= createPriorsStore(text('audio-subs.json'));
  return store;
}

/** 挂到某张技术卡上的耦合先验；卡在目标帧源里重新标定读回前只作参考。 */
export function getAudioSubsCardPriors(cardId) {
  return Object.freeze(data().cardPriors.filter((e) => e.cardId === cardId));
}

/** 纯做法与修法条目（kind: method | fix）。 */
export function getAudioSubsPractices() {
  return data().practices;
}

/** 540 条分流总账、冲突归并与顺手修复记录。 */
export function getAudioSubsMigrationManifest() {
  return data().manifest;
}
