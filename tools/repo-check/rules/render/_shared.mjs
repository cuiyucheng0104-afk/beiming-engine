// render 域的辅助（以 _ 开头，不当规则加载）：P04 渲染器自己的文件清单与错误码的写法。
// 只看渲染器 v2 的文件；engine/render 下的 build.mjs、events.mjs（出片编排）与 native.mjs（B 路线）归别的包，不在这里查。
export const OWN_FILES = ['engine/render/page.mjs', 'engine/render/still.mjs', 'engine/render/video.mjs', 'engine/render/shots.mjs', 'engine/render/serve.mjs'];
export const OWN_DIRS = ['engine/render/lib', 'tools/rtx'];
export const README = 'engine/render/README.md';
/** 错误码：点分、前缀决定退出码（docs/CLI.md 第 4 节） */
export const CODE_RE = /^(usage|env|contract|busy|timeout|failure|signal)\.[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LITERAL = /['"`]((?:usage|env|contract|busy|timeout|failure|signal)\.[a-z0-9]+(?:-[a-z0-9]+)*)['"`]/g;

/** 渲染器自己的 .mjs 文件（存在的） */
export function ownFiles(ctx) {
  const out = OWN_FILES.filter(f => ctx.exists(f));
  for (const d of OWN_DIRS) out.push(...ctx.walk(d).filter(f => f.endsWith('.mjs') && !f.endsWith('.test.mjs')));
  return out;
}

/** 文件里以字符串字面量出现的错误码 → Map<码, [{file, line}]>；注释行不算 */
export function codesIn(ctx, files) {
  const found = new Map();
  for (const f of files) {
    ctx.read(f).split('\n').forEach((l, i) => {
      if (/^\s*(\/\/|\*)/.test(l)) return;
      const add = code => { if (!found.has(code)) found.set(code, []); found.get(code).push({ file: f, line: i + 1 }); };
      for (const m of l.matchAll(LITERAL)) add(m[1]);
      // 命令约定库与渲染器的简写：usageError('unknown-option', …) / renderUsage('x', …) 在运行时补上 usage. 前缀
      for (const m of l.matchAll(/\b(?:usageError|renderUsage)\(\s*['"`]([a-z0-9]+(?:-[a-z0-9]+)*)['"`]/g)) add(`usage.${m[1]}`);
    });
  }
  return found;
}
