// film.out-untracked：films/<名>/out/ 与 out/beiming/ 下的运行产物不得被 git 跟踪（决定 D10：渲染产物永不入库；附录 C4 的运行目录）。
export default {
  id: 'film.out-untracked',
  title: '运行产物不入库（films/<名>/out/、out/beiming/）',
  run(ctx) {
    const r = ctx.git(['ls-files', '-z', '--', 'films', 'out']);
    if (!r.ok) return [{ level: 'info', message: '不是 git 检出（或没有 git）：跳过' }];
    const files = r.stdout.split('\0').filter(Boolean).filter(f => /^films\/[^/]+\/out\//.test(f) || /^out\/beiming\//.test(f));
    return files.filter(f => ctx.inScope(f)).map(f => ({
      level: 'error', file: f, message: '运行产物被 git 跟踪了',
      hint: `git rm --cached -- '${f}'（文件留在磁盘上）；产物只放运行目录，成片对外分发走 Release`,
    }));
  },
};
