// 跨平台路径工具：统一斜杠、realpath（含尚不存在的尾段）、判断「是否在某目录内」。
//
// macOS 与 Windows 的默认文件系统不区分大小写，判断包含关系时按小写比较；
// /tmp 与 /private/tmp、/var 与 /private/var 这类别名统一按 realpath 归一。
// 接口：toPosix、canonical、relInside、isInside、expandHome、startsWithPrefix、homeDir

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

/** 把任意分隔符统一成 /。 */
export const toPosix = p => String(p).replace(/\\/g, '/');

/** 评测时把 HOME 覆盖成假目录（测试用），否则取系统家目录。 */
export const homeDir = () => process.env.BEIMING_EVAL_HOME || os.homedir();

/** realpath；路径不存在时对最近一个存在的祖先取 realpath 再拼回剩余段。 */
export function canonical(p) {
  let cur = path.resolve(String(p));
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(String(p));
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

const norm = p => {
  const s = toPosix(p).replace(/\/+$/, '');
  return CASE_INSENSITIVE ? s.toLowerCase() : s;
};

/**
 * p 在 root 之内时返回相对路径（/ 分隔，root 本身返回 ''），否则返回 null。
 * 两个参数都会做 canonical。
 */
export function relInside(root, p) {
  const r = canonical(root);
  const target = canonical(p);
  const a = norm(r);
  const b = norm(target);
  if (a === b) return '';
  if (!b.startsWith(a + '/')) return null;
  return toPosix(target).replace(/\/+$/, '').slice(toPosix(r).replace(/\/+$/, '').length + 1);
}

export const isInside = (root, p) => relInside(root, p) !== null;

/** 展开 ~、$HOME、${HOME}、%USERPROFILE%。 */
export function expandHome(p, home = homeDir()) {
  return String(p)
    .replace(/^~(?=$|[\\/])/, home)
    .replace(/^\$\{?HOME\}?(?=$|[\\/])/, home)
    .replace(/^%USERPROFILE%(?=$|[\\/])/i, home);
}

/** 仓库相对路径 rel（/ 分隔）是否以 prefix（以 / 结尾表示目录）开头；大小写按平台。 */
export function startsWithPrefix(rel, prefix) {
  const a = CASE_INSENSITIVE ? rel.toLowerCase() : rel;
  const b = CASE_INSENSITIVE ? prefix.toLowerCase() : prefix;
  if (b.endsWith('/')) return a === b.slice(0, -1) || a.startsWith(b);
  return a === b || a.startsWith(b + '/');
}
