// render.no-shell：渲染器的 Node 代码不经 shell 起子进程——不 spawn sh / bash / cmd / powershell、不写 shell: true、不用 exec / execSync
// 拼命令行。Windows 上没有 sh（P10 的跨平台要求），拼字符串还会被路径里的空格与中文打断。子进程一律 spawn(可执行文件, 参数数组)。
import { ownFiles } from './_shared.mjs';

const RULES = [
  [/\bspawn(?:Sync)?\(\s*['"`](?:sh|bash|zsh|cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh)['"`]/, '用 shell 解释器起子进程'],
  [/\bshell\s*:\s*true\b/, 'spawn 带 shell: true'],
  [/\bexec(?:Sync)?\(\s*[`'"]/, '用 exec / execSync 拼命令行'],
];

export default {
  id: 'render.no-shell',
  title: '渲染器的 Node 代码不经 shell 起子进程（Windows 上没有 sh）',
  run(ctx) {
    const out = [];
    const files = ownFiles(ctx);
    for (const f of files) {
      if (!ctx.inScope(f)) continue;
      ctx.read(f).split('\n').forEach((l, i) => {
        if (/^\s*(\/\/|\*)/.test(l)) return;
        for (const [re, what] of RULES) if (re.test(l)) out.push({ level: 'error', file: f, line: i + 1, message: `${what}`, hint: '改成 spawn(可执行文件, [参数…])，可执行文件经 tools/env/lib 解析（FFmpeg 用 ffmpegBins）', excerpt: l.trim().slice(0, 120) });
      });
    }
    if (!out.length) out.push({ level: 'info', message: `渲染器的 ${files.length} 个文件都不经 shell 起子进程` });
    return out;
  },
};
