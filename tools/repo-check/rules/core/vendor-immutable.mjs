// core.vendor-immutable：cases/vendor/ 的第三方快照只读（D02 之外的硬约束；THIRD-PARTY.md「使用规则」第 1 条）。
//   - cases/vendor/<快照>/films/ 不得存在：上游说明让作品放 films/，在本仓库那是快照内部；作品一律放仓库根的 films/<名字>/
//   - 快照里不得有 lock.json 没登记的文件；登记的文件不得缺失、大小不得变（与 casebook check 同口径：node_modules、.venv、__pycache__ 不算）
//   - cases/vendor/ 根下只允许 README.md、lock.json 与 lock.json 登记的快照目录
// 逐字节校验（sha256 与 Git blob）由 python3 tools/casebook.py check 做；这里只做不读内容的快速检查。
import fs from 'node:fs';
import path from 'node:path';

const LOCK = 'cases/vendor/lock.json';
const IGNORED = new Set(['node_modules', '.venv', '__pycache__']);
const ROOT_FILES = new Set(['README.md', 'lock.json']);
const SHOW = 8;

function listFiles(absDir) {
  const out = [];
  const go = (d, rel) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (IGNORED.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) go(path.join(d, e.name), r);
      else out.push(r);
    }
  };
  go(absDir, '');
  return out;
}

const list = (xs, n = SHOW) => `${xs.slice(0, n).join('、')}${xs.length > n ? ` 等 ${xs.length} 个` : ''}`;

export default {
  id: 'core.vendor-immutable',
  title: 'cases/vendor/ 第三方快照只读：没有 films/、没有锁文件外的文件',
  run(ctx) {
    if (!ctx.isDir('cases/vendor')) return [{ level: 'info', message: 'cases/vendor/ 不存在，跳过' }];
    if (!ctx.exists(LOCK)) return [{ level: 'error', file: LOCK, message: '快照锁文件缺失，无法核对 vendor 快照', hint: '恢复 cases/vendor/lock.json' }];
    let lock;
    try { lock = ctx.readJson(LOCK); } catch (e) { return [{ level: 'error', file: LOCK, message: `不是合法 JSON（${e.message}）` }]; }
    const out = [];
    const repos = Array.isArray(lock.repositories) ? lock.repositories : [];
    const snapDirs = new Set(repos.map(r => String(r.path).replace(/^vendor\//, '')));
    for (const e of fs.readdirSync(ctx.abs('cases/vendor'), { withFileTypes: true })) {
      if (e.isDirectory() ? snapDirs.has(e.name) : ROOT_FILES.has(e.name)) continue;
      if (IGNORED.has(e.name)) continue;
      out.push({ level: 'error', file: `cases/vendor/${e.name}`, message: 'cases/vendor/ 根下只能有 README.md、lock.json 与登记过的快照目录', hint: '自己的东西放到自己的目录；作品放 films/<名字>/', excerpt: e.name });
    }
    let total = 0;
    for (const repo of repos) {
      const dirRel = `cases/${repo.path}`;
      if (!ctx.isDir(dirRel)) { out.push({ level: 'error', file: dirRel, message: `快照 ${repo.name} 的目录不存在`, hint: '恢复快照（git checkout -- 该目录）' }); continue; }
      if (fs.existsSync(path.join(ctx.abs(dirRel), 'films'))) {
        out.push({ level: 'error', file: `${dirRel}/films`, message: `快照 ${repo.name} 里出现了 films/：作品被放进了第三方快照`, hint: '把作品移到仓库根的 films/<名字>/（npm run new -- <a|b|c> <名字>），再删掉这个目录', excerpt: 'films' });
      }
      const expected = new Map((repo.files || []).map(f => [f.path, f.size]));
      const actual = listFiles(ctx.abs(dirRel));
      total += actual.length;
      const extra = actual.filter(f => !expected.has(f) && !f.startsWith('films/'));
      const actualSet = new Set(actual);
      const missing = [...expected.keys()].filter(f => !actualSet.has(f));
      const changed = actual.filter(f => expected.has(f) && (() => { try { return fs.statSync(path.join(ctx.abs(dirRel), f)).size !== expected.get(f); } catch { return false; } })());
      if (extra.length) out.push({ level: 'error', file: dirRel, message: `快照 ${repo.name} 里有锁文件没登记的文件：${list(extra)}`, hint: '快照只读：删掉这些文件；要改上游代码就复制到自己的目录并保留许可与署名', excerpt: extra[0] });
      if (missing.length) out.push({ level: 'error', file: dirRel, message: `快照 ${repo.name} 缺少登记过的文件：${list(missing)}`, hint: `git checkout -- ${dirRel}` });
      if (changed.length) out.push({ level: 'error', file: dirRel, message: `快照 ${repo.name} 里 ${changed.length} 个文件大小与锁文件不符：${list(changed)}`, hint: `快照被改过（Windows 上多半是 CRLF 换行）：git config core.autocrlf false 后 git checkout -- ${dirRel}，再跑 python3 tools/casebook.py check` });
    }
    if (!out.length) out.push({ level: 'info', message: `${repos.length} 个快照、${total} 个文件与锁文件一致（逐字节校验跑 python3 tools/casebook.py check）` });
    return out;
  },
};
