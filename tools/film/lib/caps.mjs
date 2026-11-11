// 北冥仓库 · 出片编排 · 渲染器能力探测：读 engine/render/<脚本> 的用法文字，看它认哪些选项。
// 渲染器 v2（加固计划 P04）会陆续加上 --gpu、--profile、--frames、--shots、--resume 等选项；编排器不写死版本号，
// 只在渲染器的用法里出现某个选项时才传它，所以 P04 合入前后同一份编排器都能用（接口变化以 P04 为准）。
//   rendererCaps('video.mjs') → Set(['--size', '--fps', '--any-fps', …])
// 探测方式：node <脚本> --help（附录 C2 约定 --help 无副作用）；旧版渲染器把 --help 当未知选项、打印用法后退出码 2，
// 同样不启动浏览器，用法文字照样能读。结果按脚本内容哈希缓存在本进程里。
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ROOT, fileHash } from './repo.mjs';

const memo = new Map();

export function rendererCaps(script) {
  const file = path.isAbsolute(script) ? script : path.join(ROOT, 'engine/render', script);
  let key;
  try { key = `${file}|${fileHash(file)}`; } catch { return new Set(); }
  if (memo.has(key)) return memo.get(key);
  const r = spawnSync(process.execPath, [file, '--help'], { cwd: ROOT, encoding: 'utf8', timeout: 20000, windowsHide: true });
  const text = `${r.stdout || ''}\n${r.stderr || ''}`;
  const set = new Set((text.match(/--[a-z][a-z0-9-]*/g) || []).filter(f => f !== '--help'));
  memo.set(key, set);
  return set;
}

export const supports = (script, flag) => rendererCaps(script).has(flag);
