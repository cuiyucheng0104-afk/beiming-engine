# .githooks · 提交前检查

给不走 Claude Code 的工具（Codex、Cursor、脚本、人工提交）用的同一套仓库约定。Claude Code 会话另有 `.claude/hooks/` 的护栏在工具调用前拦截，两者口径一致，说明见 [.claude/hooks/README.md](../.claude/hooks/README.md)。

## 启用与停用

`npm run setup` 会在**本仓库**执行 `git config core.hooksPath .githooks`（`npm run setup -- --no-hooks` 跳过）；不改全局或系统级 git 配置。也可以自己启用：

```sh
git config core.hooksPath .githooks          # 启用（macOS、Linux、Windows PowerShell 写法相同）
git config --unset core.hooksPath            # 停用
node .githooks/pre-commit.mjs --help         # 检查项、放行办法、退出码
```

需要 Node 22 及以上与 git；Windows 上由 Git 自带的 sh 执行 `pre-commit`，在 PowerShell 里照常 `git commit` 即可。

## 检查什么

只看这次要提交的内容（git 索引）。

**本文件自己判定**（只看暂存的改动，不依赖别的工具）：

| id | 拦下什么 | 怎么改 |
|---|---|---|
| `vendor` | 改动 `cases/vendor/` 里的第三方快照（`cases/vendor/README.md` 除外） | `git restore --staged -- <文件>`；作品放 `films/<名字>/` |
| `source` | 修改或删除 `cases/source/` 里已归档的文件（新增放行） | 历史作品先 `python3 tools/casebook.py restore <id> --out out/casebook` 再改 |
| `films-out` | `films/<名字>/out/` 下的渲染产物、`films/` 下的音视频 | 渲染产物永不入库（决定 D10） |
| `instructions` | 不在白名单里的 agent 指令文件（子目录 `AGENTS.md`、`CLAUDE.md`、新 `SKILL.md`、`.claude/` 配置） | 子目录说明写成 `README.md`；新增仓库 skill 先在 `tools/repo-check/rules/agent/instruction-files.json` 登记 |
| `bridge` | 根目录 `CLAUDE.md` 不是一行 `@AGENTS.md`，或被删 | 规则只写在 `AGENTS.md` |
| `conflict` | 残留合并冲突标记 | 解决冲突后再提交 |

**交给仓库里已有的工具**（同一份实现，不另造；四个并行，工具不在时跳过并提示）：

| id | 工具 | 判定 |
|---|---|---|
| `large` | `node tools/env/large-files.mjs`（环境包） | 超过 5 MiB 的文件必须登记在 `LARGE-FILES.allow` 且 sha256 一致（D10） |
| `compliance` | `node tools/compliance/scan.mjs --staged`（合规包） | 密钥、敏感文件、本机路径、内网地址等；退出 4 阻断，退出 3（环境不全）只提示 |
| `eol` | `node tools/repo-check/rules/env/index.mjs --only env.eol`（环境包） | 索引里没有 CRLF（归档除外；`*.ps1`、`*.cmd` 按 `.gitattributes` 用 CRLF） |
| `repo-check` | `node tools/repo-check.mjs --staged`（治理骨架） | 仓库规范检查；合规与 env 两个域上面已经跑过，这里不重复。「规则自身出错」只提示不阻断（结果不完整，报告给规则属主），其余错误阻断 |

合并提交（有 `MERGE_HEAD`）只检查与两个父提交都不同的路径，也就是冲突的解决结果；合并进来的改动已在来源分支上检查过，工具对这些路径的发现降为提示。

退出码：0 通过，4 不通过（git 中止提交），2 用法错误，3 找不到 git 或不在仓库里，1 检查自身出错。`--json` 输出 [docs/CLI.md](../docs/CLI.md) 的信封（`data.checks` 是每项的状态，`data.findings` 是逐条发现）。

`--all` 检查索引里的全部文件（首次启用或在 CI 里用）；合规全量与规范检查全量另有 `npm run comp:scan`、`npm run check:repo`，存量问题按各自的豁免表处理。

## 临时放行

确实需要时（例如维护者升级 vendor 快照并更新 `lock.json`），只对这一次命令放行某几项：

```sh
BEIMING_PRECOMMIT_ALLOW=vendor git commit -m "升级 vendor 快照到 <提交>"      # bash / zsh
```

```powershell
$env:BEIMING_PRECOMMIT_ALLOW = "vendor"; git commit -m "…"; Remove-Item Env:BEIMING_PRECOMMIT_ALLOW
```

`git commit --no-verify` 会跳过全部检查，只应由人本人在确认误报时使用；agent 护栏不允许 agent 这样做。
