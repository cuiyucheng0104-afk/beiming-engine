// route-b.spawn-timeout：B 路线的 Node 代码不直接起外部进程（spawn / spawnSync / exec*），统一经 engine/native/cli.mjs 的
// runQuick（同步、必带超时）或 spawnStream（流式、超时 124、进程组清理、信号到来整组终止）。依据：M35「spawnSync 没有超时」、附录 C1。
import { B_CODE, nodeSources, stripComments } from './_shared.mjs';

const CALL = /(?<![\w.$])(spawnSync|execSync|execFileSync|execFile|exec|spawn)\s*\(/;
const ALLOWED = new Set(['engine/native/cli.mjs']);

export default {
  id: 'route-b.spawn-timeout',
  title: 'B 路线代码的外部进程都经带超时的公共件（runQuick / spawnStream）',
  run(ctx) {
    const out = [];
    const files = nodeSources(ctx, B_CODE).filter(f => !ALLOWED.has(f));
    for (const f of files) {
      if (!ctx.inScope(f)) continue;
      stripComments(ctx.read(f)).split('\n').forEach((l, i) => {
        const m = CALL.exec(l);
        if (m) out.push({ level: 'error', file: f, line: i + 1, message: `直接调用 ${m[1]}()：没有统一的超时与清理`, hint: '改用 engine/native/cli.mjs 的 runQuick（同步、必带超时）或 spawnStream（流式、超时、信号清理）', excerpt: l.trim().slice(0, 120) });
      });
    }
    if (!out.length) out.push({ level: 'info', message: `${files.length} 个 B 路线 Node 文件的外部进程都经 runQuick / spawnStream` });
    return out;
  },
};
