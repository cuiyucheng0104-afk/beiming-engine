// route-b.no-hardcoded-contract：B 模版与原生出片入口不写死某部片的契约（240 帧、-t 10、native-10s），一律从 film.json 读。
// 依据：加固计划 P14 · B1 验收「git grep -nE '\b240\b|-t 10|native-10s' -- routes/b-native/template engine/render/native.mjs 无输出」。
const RE = /\b240\b|-t 10\b|native-10s/;

export default {
  id: 'route-b.no-hardcoded-contract',
  title: 'B 模版与原生出片入口不写死帧数、时长与产物名',
  run(ctx) {
    const out = [];
    const files = [...ctx.walk('routes/b-native/template'), 'engine/render/native.mjs'].filter(f => ctx.exists(f) && /\.(m?js|tsx?|json|py)$/.test(f));
    for (const f of files) {
      if (!ctx.inScope(f)) continue;
      ctx.read(f).split('\n').forEach((l, i) => {
        if (RE.test(l)) out.push({ level: 'error', file: f, line: i + 1, message: '写死了某部片的契约（240 帧 / -t 10 / native-10s）', hint: '帧数、时长、产物名从 film.json 读（output.frameCount、dur × fps）', excerpt: l.trim().slice(0, 120) });
      });
    }
    if (!out.length) out.push({ level: 'info', message: `${files.length} 个文件没有写死帧数、时长与产物名` });
    return out;
  },
};
