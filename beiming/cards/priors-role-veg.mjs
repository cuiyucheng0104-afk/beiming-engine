// C13：角色、生物与植被全部挂卡。这里的参考文本不写入卡文件、锁或运行时默认值。
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

const read = (name) => JSON.parse(readFileSync(new URL(`./priors-data/role-veg.${name}.json`, import.meta.url), 'utf8'));
let entries;
let manifest;

/** 同 C10–C12：未在目标帧源重新标定前，只供检索参考；返回值深冻结。 */
export function getRoleVegCardPriors(cardId) {
  if (typeof cardId !== 'string' || !cardId.length) return Object.freeze([]);
  entries ??= deepFreeze(read('card-priors').entries);
  return Object.freeze(entries.filter((entry) => entry.cardId === cardId));
}

/** 实际 514 行总账（388 明细 + 126 汇总），含历史 516 计数的校正证据。 */
export function getRoleVegMigrationManifest() {
  manifest ??= deepFreeze(read('manifest'));
  return manifest;
}
