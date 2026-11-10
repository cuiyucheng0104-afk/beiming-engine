# .githooks · 提交前检查

给不走 Claude Code 的工具（Codex、Cursor、脚本、人工提交）用的同一套仓库约定。Claude Code 会话另有 `.claude/hooks/` 的护栏在工具调用前拦截，两者口径一致，说明见 [.claude/hooks/README.md](../.claude/hooks/README.md)。

## 启用与停用

本仓库**不替你启用**：是否启用由你决定，只作用于本仓库。

```sh
git config core.hooksPath .githooks          # 启用（macOS、Linux、Windows PowerShell 写法相同）
git config --unset core.hooksPath            # 停用
node .githooks/pre-commit.mjs --all          # 启用前先对整个索引跑一遍，看看现状
```

需要 Node 22 及以上与 git；Windows 上由 Git 自带的 sh 执行 `pre-commit`，在 PowerShell 里照常 `git commit` 即可。

## 检查什么

只看暂存区，也就是这次要提交的内容：

| id | 拦下什么 | 怎么改 |
|---|---|---|
| `vendor` | 改动 `cases/vendor/` 里的第三方快照（`cases/vendor/README.md` 除外） | `git restore --staged -- <文件>`；作品放 `films/<名字>/` |
| `source` | 修改或删除 `cases/source/` 里已归档的文件（新增放行） | 历史作品先 `python3 tools/casebook.py restore <id> --out out/casebook` 再改 |
| `films-out` | `films/<名字>/out/` 下的渲染产物、`films/` 下的音视频 | 渲染产物永不入库（决定 D10） |
| `large` | 单个文件大于 5 MiB | 放 Release 或对象存储，仓库只存清单；现有大文件登记在 `LARGE-FILES.allow`（还没有这份清单时，沿用 HEAD 里已有的大文件） |
| `secrets` | `.env`、`*.pem`、`*.key`、`*.p12`、`*.pfx`、私钥文本 | 移出仓库；样例配置命名为 `*.example` |
| `instructions` | 不在白名单里的 agent 指令文件（子目录 `AGENTS.md`、`CLAUDE.md`、新 `SKILL.md`、`.claude/` 配置） | 子目录说明写成 `README.md`；新增仓库 skill 先在 `tools/repo-check/rules/agent/instruction-files.json` 登记 |
| `bridge` | 根目录 `CLAUDE.md` 不是一行 `@AGENTS.md`，或被删 | 规则只写在 `AGENTS.md` |
| `crlf` | shell 脚本含 CRLF | 改回 LF |
| `conflict` | 残留合并冲突标记 | 解决冲突后再提交 |
| `repo-check` | `tools/repo-check.mjs --staged` 不通过（执行器支持 `--staged` 时才跑） | 按它的报错改 |

退出码：0 通过，4 不通过（git 中止提交），2 用法错误，3 找不到 git 或 node，1 检查自身出错。

## 临时放行

确实需要时（例如维护者升级 vendor 快照并更新 `lock.json`），只对这一次命令放行某几项：

```sh
BEIMING_PRECOMMIT_ALLOW=vendor git commit -m "升级 vendor 快照到 <提交>"      # bash / zsh
$env:BEIMING_PRECOMMIT_ALLOW="vendor"; git commit -m "…"; Remove-Item Env:BEIMING_PRECOMMIT_ALLOW   # PowerShell
```

`git commit --no-verify` 会跳过全部检查，只应由人本人在确认误报时使用；agent 护栏不允许 agent 这样做。
