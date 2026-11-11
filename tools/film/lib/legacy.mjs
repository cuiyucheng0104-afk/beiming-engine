// 北冥仓库 · 出片编排 · 旧约定位置的临时工作区。
// 现有脚本有写死的读写位置（C 模版 mix.py 读作品目录的 events.json / timeline.json、写 out/mix.wav；cuecheck 读 out/；
// native.mjs 写 out/native.mp4、out/render.json、out/stills/）。编排器在用到这些位置前先登记、备份原有内容，
// 运行结束（成功、失败、被中断都一样）后还原：原来没有的删掉，原来有的按备份写回。产物只留在 out/<run-id>/。
//   const L = new Legacy(backupDir)
//   L.protect(absPath, { move })   登记一个旧位置（文件或目录）；原来存在就先备份：默认复制，move = true 时改为移走
//                                 （只用于 out/ 下的大体积旧产物，省一次复制）；复制备份时原位置若是硬链接，先换成独立的一份
//   L.place(absPath, src)       登记后把 src 复制过去（给只认旧位置的脚本读）
//   L.collect(absPath, dest)    把脚本写到旧位置的产物移进运行目录；返回是否收到
//   L.restore() → [{ path, action }]   全部还原；可重复调用
// 作品目录里的文件一律复制备份：即使编排器被强杀，旧位置的文件也还在原处。
import fs from 'node:fs';
import path from 'node:path';

export class Legacy {
  constructor(backupDir) { this.backupDir = backupDir; this.items = new Map(); this.n = 0; }

  protect(p, { move = false } = {}) {
    p = path.resolve(p);
    if (this.items.has(p)) return;
    let backup = null;
    if (fs.existsSync(p)) {
      backup = path.join(this.backupDir, String(++this.n), path.basename(p));
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      if (move) { try { fs.renameSync(p, backup); } catch { fs.cpSync(p, backup, { recursive: true, preserveTimestamps: true }); fs.rmSync(p, { recursive: true, force: true }); } }
      else { fs.cpSync(p, backup, { recursive: true, preserveTimestamps: true }); unshare(p); }
    }
    this.items.set(p, { existed: backup !== null, backup, createdDirs: missingParents(p) });
  }

  collect(p, dest) {
    p = path.resolve(p);
    if (!fs.existsSync(p)) return false;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    try { fs.renameSync(p, dest); } catch { fs.cpSync(p, dest, { recursive: true }); fs.rmSync(p, { recursive: true, force: true }); }
    return true;
  }

  place(p, src) {
    this.protect(p);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.rmSync(p, { recursive: true, force: true });
    fs.copyFileSync(src, p);
  }

  restore() {
    const done = [];
    for (const [p, it] of [...this.items].reverse()) {
      try {
        if (it.existed) {
          if (!sameContent(p, it.backup)) { fs.rmSync(p, { recursive: true, force: true }); fs.cpSync(it.backup, p, { recursive: true, preserveTimestamps: true }); done.push({ path: p, action: 'restored' }); }
        } else if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); done.push({ path: p, action: 'removed' }); }
        for (const d of it.createdDirs) { try { fs.rmdirSync(d); } catch { /* 非空或已不在 */ } }
      } catch (e) { done.push({ path: p, action: `failed: ${e.message}` }); }
    }
    this.items.clear();
    return done;
  }
}

// 旧位置的文件与别的名字共用一份数据（硬链接）时先换成独立的一份：audio/mix.py 用 soundfile 按截断方式原地覆写 out/mix.wav，
// 而早先版本的 tools/film/beiming.mjs 把 out/mix.wav 硬链接到上一次运行目录与步骤缓存里那份混音（现在改放独立的一份，
// 存量检出里仍可能是硬链接）——不先断开，重新混音会顺带改掉上一次运行的产物和缓存（之后命中这条缓存就拿到错的混音）。
function unshare(p) {
  const st = fs.lstatSync(p);
  if (!st.isFile() || st.nlink < 2) return;
  const tmp = `${p}.unshare-${process.pid}`;
  try { fs.copyFileSync(p, tmp); fs.renameSync(tmp, p); } finally { fs.rmSync(tmp, { force: true }); }
}

// 登记时还不存在的上级目录（还原时若已空就删掉，例如作品目录下原本没有 out/）
function missingParents(p) {
  const out = [];
  let d = path.dirname(p);
  while (!fs.existsSync(d) && path.dirname(d) !== d) { out.push(d); d = path.dirname(d); }
  return out;
}

function sameContent(a, b) {
  try {
    const sa = fs.statSync(a), sb = fs.statSync(b);
    if (sa.isDirectory() !== sb.isDirectory()) return false;
    if (sa.isDirectory()) {
      const la = fs.readdirSync(a).sort(), lb = fs.readdirSync(b).sort();
      return la.length === lb.length && la.every((n, i) => n === lb[i] && sameContent(path.join(a, n), path.join(b, n)));
    }
    return sa.size === sb.size && fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch { return false; }
}
