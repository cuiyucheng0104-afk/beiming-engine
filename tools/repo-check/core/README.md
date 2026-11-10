# tools/repo-check · 规范检查框架

`npm run check:repo`（即 `node tools/repo-check.mjs`）的执行器：加载规则、在被检查的仓库上逐条运行、套用限期豁免、输出报告。只读：不改文件、不渲染、不联网。命令约定见 [docs/CLI.md](../../../docs/CLI.md) 第 12 节。

| 文件 | 用途 |
|---|---|
| `index.mjs` | 命令声明与执行流程（`--only`、`--list`、`--strict`、`--staged`、`--root`） |
| `loader.mjs` | 扫描 `tools/repo-check/rules/<域>/*.mjs`：一个文件一条规则，或一个域模块装本域的多条规则 |
| `context.mjs` | 规则拿到的 `ctx`（只读、带缓存） |
| `markdown.mjs` | Markdown 解析：遮代码、链接、标题与 GitHub 锚点、代码块 |
| `report.mjs` | 限期豁免、汇总、文字报告 |
| `waivers.json` | 限期豁免表（存量问题、属主与原因） |

## 写一条规则

规则放在自己工作包的域目录里：`tools/repo-check/rules/<域>/<名字>.mjs`（`core` 由治理骨架维护；`comp`、`agent`、`render`、`spec`、`film`、`qa`、`baseline`、`env`、`route-a`、`route-b`、`route-c`、`cases` 各归其包）。以 `_` 开头的文件是同域辅助模块，以 `.test.mjs` 结尾的是测试，都不当规则加载。

```js
// comp.example：一句话说明检查什么、为什么（引用决定书或差距编号）。
export default {
  id: 'comp.example',                // "<域>.<名字>"，域等于目录名，名字小写 kebab-case
  title: '一句话说明检查什么',
  run(ctx) {                         // 可以 async
    const out = [];
    for (const f of ctx.mdFiles()) {
      if (!ctx.inScope(f)) continue; // --staged 时只看暂存区涉及的文件
      const lines = ctx.md.maskCode(ctx.read(f)).split('\n');
      lines.forEach((l, i) => {
        if (/某个问题/.test(l)) out.push({ level: 'error', file: f, line: i + 1, message: '哪里不对', hint: '下一步怎么改', excerpt: '命中的原文' });
      });
    }
    return out;                      // 没问题返回 []；可以加一条 level: 'info' 的汇总
  },
};
```

- `level`：`error`（规范错误，退出 4）、`warn`（提示，不影响退出码）、`info`（汇总说明）。`message` 说原因，`hint` 说下一步怎么做，都用中文；`file` 是仓库相对路径、正斜杠。
- `ctx`：`root`、`rel / abs`、`exists / isDir`、`read / readJson`（缓存）、`walk(目录, { dirs, files })`（跳过 `node_modules`、`.git`、`out`、`__pycache__`、`.venv`、`.cache`、`_site`、`_previews`、`.claude/worktrees` 与 `tests/**/fixtures`）、`mdFiles({ vendor })`、`git(args)`（`{ ok, stdout }`）、`registry`（路线注册表）、`pkg`（package.json）、`inScope(rel)`、`staged`（暂存区涉及的文件集合或 `null`）、`strict`（加了 `--strict`：规则自己的待修豁免也不该生效，例如 comp 的允许清单里的 pending 条目）、`md`（`markdown.mjs` 的全部函数）、`memo(key, fn)`。
- 规则抛错或超过 120 秒不返回，记成「规则自身出错」，整次检查退出 1；别的规则照常跑。
- 规则文件本身坏了（语法错误、导出的形状不对、域或 id 不合格）记成 `core.loader` 的错误，同样退出 1。全量检查全部报出；`--only <域或规则>` 只报选中的域的加载问题（选单条规则时算它所在的域），别的包正在改的规则文件不会连累 `--only core`。
- 测试放 `tests/<域>/`：用 `--root <临时目录>` 在构造的小仓库上跑，断言规则 id 与退出码（参考 `tests/governance/`）。

### 域模块：一个文件装本域的多条规则

域里的规则还要能单独运行（自带命令行入口、给 CI 或提交钩子直接调）时，可以把整个域写成一个模块，例如 `rules/env/index.mjs`、`rules/qa/index.mjs`。执行器认具名导出：

```js
export const domain = 'env';                       // 可选；写了就必须等于目录名
export const rules = [                             // 每条的 id、title、run 要求同上
  { id: 'env.eol', title: '索引里没有 CRLF', severity: 'error', run: async ctx => [/* Finding */] },
];
export function createContext(root, { staged }) { /* 可选：本域自己的 ctx */ }
```

- 导出了 `createContext` 的，执行器每次检查调用一次，把它返回的对象交给本模块的全部规则；没导出的，规则拿框架的 `ctx`。`staged` 是 `--staged` 时暂存区涉及的文件集合，否则为 `null`。
- 发现按域模块的约定换算：没写 `level` 的取该规则的 `severity`（缺省 `error`）；`level: 'ok'` 是「通过」说明，不进报告；没写 `hint` 时用 `fix`。
- 同一个文件不能既导出单条规则（`id`、`title`、`run`）又导出 `rules` 数组。

## 限期豁免

`waivers.json` 只给「属主还没轮到改」的存量问题用：

```json
{ "rule": "core.terms", "file": "AGENTS.md", "match": "两条路线", "owner": "PZ", "reason": "根文档由 PZ 在整合时改成三条路线（D01）" }
```

- 同规则、同文件、消息或摘录里含 `match` 的错误降为提示，并在报告里标出属主；`--strict` 时不降（发布前用）。
- 条目不再命中任何问题时，检查报一条提示要求删掉它：豁免只减不增。
- 新增条目必须写属主与原因，并在提交说明里写明；不要用豁免掩盖本包自己的问题。
