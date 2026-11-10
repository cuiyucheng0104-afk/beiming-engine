# tools/lib · 命令约定库

给仓库里所有新命令用的共用件。约定本身（退出码、`--json` 信封、参数规则、错误码）写在 [docs/CLI.md](../../docs/CLI.md)，这里只说怎么用。

| 文件 | 用途 |
|---|---|
| `cli.mjs` | Node 命令：声明参数与选项、严格解析、`--help` 无副作用、`--json` 信封、退出码常量 `EXIT`、错误类 `CliError`、信号清理 |
| `cli.py` | Python 命令：同一套退出码、信封与错误类；`ArgumentParser` 是 argparse 的严格版（中文报错、不接受缩写） |
| `routes.mjs` | 路线注册表 `routes/routes.json` 的唯一读取口：校验、按 id 或别名找路线、展开下一步命令 |
| `profiles.mjs` | 交付档位：读 `engine/production/profiles.json`（作品描述包的正式写法 `video` / `audio.loudness` / `default`），没有时用 D07 的兜底表 |
| `filmspec.mjs` | 作品描述的轻量规则：占位符、作品名与片名、film.json 结构自检；`formatFilmJson` 稳定排版（与 `engine/production/io.js` 的 `formatJson` 同一规则） |

## 写一个 Node 命令

```js
#!/usr/bin/env node
// 北冥仓库 · 某某命令：一句话说明做什么（docs/CLI.md 的约定）。
import { CliError, defineCommand, isMain, runCli } from './lib/cli.mjs';

export const command = defineCommand({
  name: 'thing',
  summary: '一句话说明',
  usage: ['node tools/thing.mjs <作品目录> [--frames a:b] [--json]'],
  positionals: [{ name: 'film', label: '<作品目录>', describe: 'films/<名字>' }],
  options: { frames: { type: 'string', arg: '<a:b>', describe: '整数帧，含头不含尾' }, 'dry-run': { type: 'boolean', describe: '只报告不写盘' } },
  exitCodes: { 0: '成功', 2: '用法错误', 4: '契约不通过' },
  async run(ctx) {
    const { film } = ctx.args;                  // 位置参数
    if (!film.startsWith('films/')) throw new CliError('usage.bad-film', `作品目录要在 films/ 下：${film}`, '例：films/dawn');
    ctx.log.info('进度……');                     // stderr；--quiet 时不打
    const undo = ctx.onCleanup(() => { /* 删临时文件 */ });   // 被 Ctrl+C 或抛错时执行
    // … 干活 …
    undo();
    ctx.out('给人看的结果');                     // stdout；--json 时不打
    return { data: { frames: 48 }, outputs: [{ path: `${film}/out/x.mp4`, sha256: '…', kind: 'video' }] };
  },
});

if (isMain(import.meta.url)) await runCli(command);
```

- `run` 抛 `CliError(code, message, { hint })`：`code` 前缀决定退出码（`usage.` 2、`env.` 3、`contract.` 4、`busy.` 5）。
- 想带结果失败（如规范检查有错误），返回 `{ data, error: { code, message, hint } }`，退出码由 `error.code` 推出，也可以直接给 `exitCode`。
- `--json`、`--quiet`、`-h/--help`、`--version` 是全局选项，不要自己声明。
- 帮助里的 `description`、`examples` 可以是函数，但只能读文件，不能有副作用。

## 写一个 Python 命令

```python
import pathlib, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'lib'))   # 按脚本所在层级调整
from cli import ArgumentParser, CliError, run

parser = ArgumentParser(prog='python tools/thing.py', description='一句话说明')
parser.add_argument('film')

def main(args, ctx):
    if not args.film.startswith('films/'):
        raise CliError('usage.bad-film', f'作品目录要在 films/ 下：{args.film}', hint='例：films/dawn')
    ctx.log('进度……')
    ctx.out('结果')
    return {'data': {'ok': True}}

if __name__ == '__main__':
    sys.exit(run(main, parser, command='thing'))
```

测试：`node --test tests/cli tests/governance`（含 `cli.py` 的用例，需要 `python3`）。`tests/cli/contract.test.mjs` 会自动识别用本库写的 npm 脚本并验证 `--help`、未知参数与 `--json`；还没接入的脚本要在它的 `KNOWN_EXCEPTIONS` 里登记属主与原因。
