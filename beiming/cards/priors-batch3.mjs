// C12：第三批三份参数库先验（特效粒子界面 fx-ui、材质与硬表面 mat-hardsurf、渲染管线与后期 render-pipe）。
// 可移植量走 C9 priors/0.1 检索库（原文直传 createPriorsStore 拦重复键）；挂卡先验、做法与分流总账深冻结只读返回，绝不当默认值。

import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { createPriorsStore } from './priors.mjs';

export const C12_COLLECTIONS = Object.freeze(['fx-ui', 'mat-hardsurf', 'render-pipe']);
const COLLECTION_SET = new Set(C12_COLLECTIONS);

const text = (name) => readFileSync(new URL(`./priors-data/${name}`, import.meta.url), 'utf8');
const read = (name) => JSON.parse(text(name));

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}

function assertCollection(collection) {
  if (typeof collection !== 'string' || !COLLECTION_SET.has(collection)) {
    throw new RangeError(`未知的 C12 先验集合：${String(collection)}（可选：${C12_COLLECTIONS.join(', ')}）`);
  }
  return collection;
}

const cache = new Map();
function data(collection) {
  const col = assertCollection(collection);
  if (!cache.has(col)) {
    cache.set(col, deepFreeze({
      cardPriors: read(`${col}.card-priors.json`).entries,
      practices: read(`${col}.practices.json`).entries,
      manifest: read(`${col}.manifest.json`),
    }));
  }
  return cache.get(col);
}

const stores = new Map();
/** 按集合名加载 C12 可移植先验检索库（过 C9 整表校验；条目全部「未在我方读回」）。 */
export function loadBatch3PriorsStore(collection) {
  const col = assertCollection(collection);
  if (!stores.has(col)) {
    // 传原文而不是 JSON.parse 后的对象：重复键（prior.duplicate-key）只有 C9 看原文时才拦得住。
    stores.set(col, createPriorsStore(text(`${col}.json`)));
  }
  return stores.get(col);
}

/** 加载特效、粒子、界面与二维层可移植先验库（fx-ui）。 */
export function loadFxUiPriorsStore() {
  return loadBatch3PriorsStore('fx-ui');
}

/** 加载材质与硬表面建模可移植先验库（mat-hardsurf）。 */
export function loadMatHardsurfPriorsStore() {
  return loadBatch3PriorsStore('mat-hardsurf');
}

/** 加载渲染管线、采样、后期与性能分级可移植先验库（render-pipe）。 */
export function loadRenderPipePriorsStore() {
  return loadBatch3PriorsStore('render-pipe');
}

/** 挂到某张技术卡上的耦合先验；可选按 collection 过滤。卡在目标帧源里重新标定读回前只作参考。 */
export function getBatch3CardPriors(cardId, collection) {
  const cols = collection === undefined ? C12_COLLECTIONS : [assertCollection(collection)];
  if (typeof cardId !== 'string' || cardId.length === 0) return Object.freeze([]);
  const out = [];
  for (const col of cols) {
    for (const entry of data(col).cardPriors) {
      if (entry.cardId === cardId) out.push(entry);
    }
  }
  return Object.freeze(out);
}

let allPractices;
/** 纯做法与修法条目（kind: method | fix）；可选按 collection 过滤。 */
export function getBatch3Practices(collection) {
  if (collection !== undefined) return data(collection).practices;
  allPractices ??= Object.freeze(C12_COLLECTIONS.flatMap((col) => data(col).practices));
  return allPractices;
}

/** 指定集合的逐条分流总账、冲突归并、顺手修复与独立盲审记录。 */
export function getBatch3MigrationManifest(collection) {
  return data(collection).manifest;
}
