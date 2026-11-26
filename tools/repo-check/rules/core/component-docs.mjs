// M7 / FX18：每个一级组件都要有短入口。计量与 API 入口一致，按 UTF-8 字节数估算 token。
const OWNERSHIP = 'beiming/kernel/contracts/ownership/ownership.json';
const LIMIT = 1500;

export default {
  id: 'core.component-docs',
  title: '北冥一级组件的 README 入口预算',
  run(ctx) {
    if (!ctx.isDir('beiming')) return [];
    if (!ctx.exists(OWNERSHIP)) {
      return [{ level: 'error', file: OWNERSHIP, message: '无法从目录归属契约读取组件列表' }];
    }
    const components = ctx.readJson(OWNERSHIP).entries
      .map(entry => entry.path)
      .filter(dir => dir !== '.' && !dir.includes('/'));
    const findings = [];
    for (const dir of components) {
      const file = `beiming/${dir}/README.md`;
      if (!ctx.exists(file) || !ctx.read(file).trim()) {
        findings.push({ level: 'error', file, message: '缺少组件入口说明', hint: '写明组件职责、入口和验证命令' });
        continue;
      }
      const tokens = Math.ceil(Buffer.byteLength(ctx.read(file), 'utf8') / 3.5);
      if (tokens > LIMIT) {
        findings.push({
          level: 'error', file, message: `估算 ${tokens} token，超过入口预算 ${LIMIT} token`,
          hint: '将细则移到组件的详细说明，入口保留职责、命令和链接',
        });
      }
    }
    return findings.length ? findings : [{
      level: 'info', message: `${components.length} 份一级组件入口说明均在 ${LIMIT} token 预算内`,
    }];
  },
};
