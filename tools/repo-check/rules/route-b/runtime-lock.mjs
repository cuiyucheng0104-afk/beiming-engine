// route-b.runtime-lock：原生运行时锁定记录 engine/native/runtime.lock.json 完整——版本、FSL-1.1-ALv2 许可、上游源码提交、
// 三平台归档 sha256、至少一个平台的可执行文件 sha256；engine/render/native.mjs 登记的 VALIDATED 与锁的版本一致
// （tools/env/spec.json 按正则读 VALIDATED，doctor / preflight 与渲染入口口径相同）。依据：加固计划 P14 · B1「运行时锁定」、M35。
const LOCK = 'engine/native/runtime.lock.json';
const PLATFORMS = ['macos-arm64', 'windows-x64', 'linux-x64'];

export default {
  id: 'route-b.runtime-lock',
  title: '原生运行时锁定记录完整，入口登记的版本与锁一致',
  run(ctx) {
    if (!ctx.exists(LOCK)) return [{ level: 'error', file: LOCK, message: '缺运行时锁定记录', hint: '从 git 历史恢复 engine/native/runtime.lock.json' }];
    let lock;
    try { lock = ctx.readJson(LOCK); } catch (e) { return [{ level: 'error', file: LOCK, message: `不是合法 JSON（${e.message}）` }]; }
    const out = [];
    const err = (message, hint) => out.push({ level: 'error', file: LOCK, message, hint });
    if (!/^\d+\.\d+\.\d+/.test(lock.version || '')) err('version 缺失或不是版本号');
    if (lock.license !== 'FSL-1.1-ALv2') err(`license 应为 FSL-1.1-ALv2（现在是 ${JSON.stringify(lock.license)}）`, '许可写错会让 FSL 使用边界的检查失效（决定 D03）');
    if (!/^[0-9a-f]{40}$/.test(lock.sourceCommit || '')) err('sourceCommit 应为 40 位上游提交号');
    for (const k of PLATFORMS) {
      const p = lock.platforms?.[k];
      if (!p) { err(`缺平台 ${k}`); continue; }
      if (!/^[0-9a-f]{64}$/.test(p.sha256 || '')) err(`${k} 的归档 sha256 缺失`, '取自上游发行页的资产 digest 或随包的 .sha256 文件');
      if (!p.binarySha256) out.push({ level: 'warn', file: LOCK, message: `${k} 还没有可执行文件 sha256`, hint: '在该平台解包后运行 node engine/native/runtime.mjs hash，把结果填进 binarySha256' });
    }
    if (!Object.values(lock.platforms || {}).some(p => /^[0-9a-f]{64}$/.test(p?.binarySha256 || ''))) err('没有任何平台锁定了可执行文件 sha256');
    const entry = 'engine/render/native.mjs';
    if (ctx.exists(entry)) {
      const m = /export const VALIDATED = '([^']+)'/.exec(ctx.read(entry));
      if (!m) out.push({ level: 'error', file: entry, message: '缺 export const VALIDATED = \'<版本>\'（tools/env/spec.json 的 raea.versionSource 读这一行）' });
      else if (lock.version && m[1] !== lock.version) out.push({ level: 'error', file: entry, message: `VALIDATED ${m[1]} 与 ${LOCK} 的版本 ${lock.version} 不一致`, hint: '换运行时版本时两处一起改，并重跑 B 手册「验收」' });
    }
    if (!out.some(f => f.level === 'error')) out.push({ level: 'info', message: `运行时 ${lock.version}：许可、三平台归档与可执行文件哈希已锁定，入口登记的版本一致` });
    return out;
  },
};
