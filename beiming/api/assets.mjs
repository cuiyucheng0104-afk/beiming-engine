import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_ASSETS } from '../sources/blender/host.mjs';

const builtins = { ...BUILTIN_ASSETS,
  'asset:mech-head-proxy@1': fileURLToPath(new URL('./mech-head-proxy.json', import.meta.url)),
};
const metadata = {
  'asset:rtx-card@1': ['显卡 硬表面 演示件', ['显卡', 'gpu', 'card', 'hard-surface'], [0.306, 0.145, 0.046]],
  'asset:mech-head-proxy@1': ['机械头 校准代理几何', ['机械头', 'calibration'], [0.15, 0.21, 0.131]],
};
export const ASSETS = Object.fromEntries(Object.entries(metadata).map(([id, [title, tags, bbox]]) => {
  const spec = JSON.parse(readFileSync(builtins[id], 'utf8'));
  return [id, { id, title, tags, bbox, parts: Object.keys(spec.parts).length, baked: ['blender-cards-data'] }];
}));

// 合规的小写文件名便于手写引用。其他文件名无损编码，扩展名参与区分同名网格。
export function uploadRef(name) {
  const slug = /^[a-z0-9][a-z0-9-]*\.(glb|stl)$/.test(name) && !name.startsWith('encoded-')
    ? name.replace('.', '-') : `encoded-${Buffer.from(name).toString('hex')}`;
  return `asset:upload-${slug}@1`;
}

export function assetPaths(workspace) {
  const dir = join(workspace, 'assets');
  const paths = { ...builtins };
  if (existsSync(dir)) for (const file of readdirSync(dir, { withFileTypes: true })) {
    if (file.isFile() && /\.(glb|stl)$/.test(file.name)) paths[uploadRef(file.name)] = join(dir, file.name);
  }
  return paths;
}
const summaryOf = ({ tags, ...data }) => data;

/** 按关键字检索：q 拆成空白分隔的词，命中词多的在前；limit 封顶 5 */
export function searchAssets({ q = '', limit = 5 } = {}) {
  const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
  const n = Math.max(1, Math.min(5, Number.isInteger(limit) ? limit : 5));
  const scored = Object.values(ASSETS).map((a) => {
    const hay = [a.id, a.title, ...a.tags].join(' ').toLowerCase();
    return { a, score: words.filter((w) => hay.includes(w)).length };
  }).filter((x) => !words.length || x.score > 0);
  scored.sort((x, y) => y.score - x.score || (x.a.id < y.a.id ? -1 : 1));
  return { expectedCount: scored.length, items: scored.slice(0, n).map((x) => summaryOf(x.a)) };
}

export const getAsset = (ref) => (Object.hasOwn(ASSETS, ref) ? ASSETS[ref] : null);

