// core.ascii-paths：routes/、films/、tools/、engine/ 下的目录名与文件名只用 ASCII（跨平台路径、URL、命令行都不出意外）。
// 中文写进文件内容与 film.json 的 title，不写进路径。
const ROOTS = ['routes', 'films', 'tools', 'engine'];
const NON_ASCII = /[^\x20-\x7e]/;

export default {
  id: 'core.ascii-paths',
  title: 'routes/ films/ tools/ engine/ 的路径只用 ASCII',
  run(ctx) {
    const out = [];
    for (const top of ROOTS) {
      for (const p of [...ctx.walk(top, { dirs: true, files: false }), ...ctx.walk(top)]) {
        const base = p.split('/').pop();
        if (NON_ASCII.test(base) || /\s/.test(base)) out.push({ level: 'error', file: p, message: `路径「${base}」含非 ASCII 字符或空白`, hint: '改成小写字母、数字、连字符；中文写进内容（如 film.json 的 title）', excerpt: base });
      }
    }
    return out;
  },
};
