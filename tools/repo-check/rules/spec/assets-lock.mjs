// spec.assets-lock：共享资产（engine/assets/manifest.js 登记的造型、角色、底板、字体）的 sha256 与锁文件
// engine/assets/assets.lock.json 一致。资产改了锁文件没更新：用到它的作品缓存失效、认可过的风格帧要复核（ORCH-15）。
import { engineLibs, finding } from './_lib.mjs';

const LOCK = 'engine/assets/assets.lock.json';

export default {
  id: 'spec.assets-lock',
  title: '共享资产的 sha256 与锁文件一致',
  async run(ctx) {
    const L = await engineLibs(ctx);
    const lock = L.assets.readLock(ctx.abs(LOCK));
    if (!lock) return [finding('error', 'assets-lock-missing', LOCK, '资产锁文件缺失', 'node engine/assets/manifest.js lock --write')];
    const next = L.assets.buildLock({ root: ctx.root });
    const out = [];
    for (const [id, v] of Object.entries(next.assets)) {
      const old = lock.assets?.[id];
      if (!old) out.push(finding('error', 'asset-unlocked', LOCK, `资产 ${id} 不在锁文件里`, 'node engine/assets/manifest.js lock --write'));
      else if (old.sha256 !== v.sha256) {
        const changed = Object.keys(v.files).filter(f => old.files?.[f] !== v.files[f]);
        out.push(finding('error', 'asset-changed', LOCK, `资产 ${id} 改了（${changed.join('、') || '文件集合变了'}）但锁文件没更新：用到它的作品缓存失效、认可过的风格帧要复核`, '确认是有意改动后：node engine/assets/manifest.js lock --write'));
      }
    }
    for (const id of Object.keys(lock.assets ?? {})) if (!next.assets[id]) out.push(finding('warn', 'asset-lock-stale', LOCK, `锁文件里的 ${id} 已不在注册表里`, 'node engine/assets/manifest.js lock --write'));
    if (!out.length) out.push({ level: 'info', message: `${Object.keys(next.assets).length} 项共享资产与锁文件一致` });
    return out;
  },
};
