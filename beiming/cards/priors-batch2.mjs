// C11：参数库第二批的先验库（priors-data/{arch-scene,motion-rig,light-cam}.*.json）。
// 可移植量走 C9 priors/0.1 检索库；挂卡先验与做法只读返回，不当默认值。分流口径见各份 manifest 的 rules。

import { existsSync, readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { createPriorsStore } from './priors.mjs';

/** 第二批三份汇编：建筑场景地形与水、动作与骨骼、光照天空大气与相机。 */
export const C11_COLLECTIONS = Object.freeze(['arch-scene', 'motion-rig', 'light-cam']);

const text = (name) => readFileSync(new URL(`./priors-data/${name}`, import.meta.url), 'utf8');
const read = (name) => JSON.parse(text(name));

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}

function known(collection) {
  if (!C11_COLLECTIONS.includes(collection)) throw new TypeError(`未知的先验集合，可用：${C11_COLLECTIONS.join('、')}`);
  return collection;
}

const cache = new Map();
function data(collection) {
  if (!cache.has(known(collection))) {
    const manifest = read(`${collection}.manifest.json`);
    if (Array.isArray(manifest.cards)) {
      manifest.cards = manifest.cards.map((card) => ({
        ...card,
        exists: existsSync(new URL(`./${card.cardId.replace('.', '/')}/card.json`, import.meta.url)),
      }));
    }
    cache.set(collection, deepFreeze({
      cardPriors: read(`${collection}.card-priors.json`).entries,
      practices: read(`${collection}.practices.json`).entries,
      manifest,
    }));
  }
  return cache.get(collection);
}
const each = (collection) => (collection === undefined ? C11_COLLECTIONS : [known(collection)]);

const stores = new Map();
/** 某一份的可移植先验检索库（过 C9 整表校验；条目全部「未在我方读回」）。 */
export function loadBatch2PriorsStore(collection) {
  // 传原文而不是 JSON.parse 后的对象：重复键（prior.duplicate-key）只有 C9 看原文时才拦得住。
  if (!stores.has(known(collection))) stores.set(collection, createPriorsStore(text(`${collection}.json`)));
  return stores.get(collection);
}
export const loadArchScenePriorsStore = () => loadBatch2PriorsStore('arch-scene');
export const loadMotionRigPriorsStore = () => loadBatch2PriorsStore('motion-rig');
export const loadLightCamPriorsStore = () => loadBatch2PriorsStore('light-cam');

/** 挂到某张技术卡上的耦合先验（不给 collection 就三份都查）；卡在目标帧源里重新标定读回前只作参考。 */
export function getBatch2CardPriors(cardId, collection) {
  return Object.freeze(each(collection).flatMap((c) => data(c).cardPriors.filter((e) => e.cardId === cardId)));
}

/** 纯做法与修法条目（kind: method | fix）；不给 collection 就三份合并。 */
export function getBatch2Practices(collection) {
  return collection === undefined ? Object.freeze(C11_COLLECTIONS.flatMap((c) => data(c).practices)) : data(collection).practices;
}

/** 某一份的分流总账（rows）、冲突、不迁清单、独立复核与顺手修复记录。 */
export function getBatch2MigrationManifest(collection) {
  return data(collection).manifest;
}
