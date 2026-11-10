# tools/remote · 控制机与工作站

> 读者｜要让另一台机器（通常是 Windows RTX 工作站）按指定提交出片的人与 agent　状态｜生效；本机目录传输（`--transport local`）在 macOS 上端到端实测过，ssh 传输待在工作站上实测　依据｜加固计划 GAP-09；退出码与 `--json` 信封遵守仓库统一约定

控制机上一条命令：把指定提交发到工作站 → 在那里建独立工作树、拿整机锁、按该提交的锁文件建环境 → 运行命令（日志实时转回）→ 取回产物并逐个核对 sha256 → 清理。工作站只需要 OpenSSH 服务、git 和 Node 22 以上，其余由 `npm run setup` 按该提交建好。

## 命令

```bash
node tools/remote/cli.mjs machines                                   # 列出机器档案
node tools/remote/cli.mjs check   rtx                                # 连得上吗、远端 Node / git / 显卡
node tools/remote/cli.mjs setup   rtx [--commit <提交>]              # 按该提交的锁文件在远端建环境
node tools/remote/cli.mjs doctor  rtx [--route a] [--gpu required]   # 远端环境自检，报告随运行记录取回
node tools/remote/cli.mjs render  rtx films/<名> [--commit <提交>] [--profile <档位>]
node tools/remote/cli.mjs run     rtx [--fetch <路径或模式>]… -- <远端命令…>
node tools/remote/cli.mjs cleanup rtx [--run <run-id>] [--all]
```

| 选项 | 作用 |
|---|---|
| `--commit <提交>` | 在远端运行哪个提交，默认 `HEAD`。工作区有未提交的改动时拒绝（远端只能拿到已提交的内容），确实只想用已提交版本时加 `--allow-dirty` |
| `--no-setup` | 不在远端跑 setup（提交早于环境工具时用，环境靠机器档案的 `env`） |
| `--wait <秒>` | 槽位被占时排队等待；默认不等，直接退出 5 |
| `--keep` | 保留远端工作树，排查问题用；之后 `cleanup` |
| `--fetch <路径或模式>` | 额外取回的文件，可写目录、`out/*.mp4`、`out/**/report.json`；命令的 `--json` 信封里列出的 `outputs` 会自动取回 |
| `--dest <目录>` | 产物放在本地哪里。`render` 默认按原路径放回仓库（`films/<名>/out/…`）；`run` 默认 `out/remote/<机器>/<run-id>/` |
| `--ssh <目标> --shell posix\|powershell --root <远端目录> --transport ssh\|local` | 不用档案，临时给出一台机器（机器名写 `adhoc`） |
| `--json` | stdout 只输出一个对象（统一信封）；日志走 stderr |

`render` 在远端运行 `node tools/film/cli.mjs build films/<名> --json`，所以要求该提交里有统一出片命令；没有时退出 3，可以改用 `run … -- <出片命令>` 加 `--fetch`。

退出码：远端命令的退出码原样返回；0 成功；2 用法错误；3 连不上、远端缺工具或缺环境；5 远端槽位被占；1 传输或哈希核对失败；130 / 143 中断（远端随即停止并清理）。

## 机器档案

放在仓库外：`BEIMING_MACHINES` 指定的文件；未设时 `$XDG_CONFIG_HOME/beiming/machines.json`；再未设时 `~/.config/beiming/machines.json`。主机名、账号、盘符只写在这里，不进仓库。

```json
{
  "machines": {
    "rtx": {
      "ssh": "<用户>@<主机或 ~/.ssh/config 里的 Host 别名>",
      "shell": "powershell",
      "root": "D:/beiming-remote",
      "node": "node",
      "git": "git",
      "env": { "BEIMING_ANGLE": "vulkan" },
      "slots": 1
    },
    "linux-gpu": { "ssh": "<用户>@<主机>", "shell": "posix", "root": "/srv/beiming-remote", "env": { "BEIMING_ANGLE": "vulkan" } }
  }
}
```

| 字段 | 说明 |
|---|---|
| `transport` | `ssh`（默认）或 `local`（同一台机器上的另一个目录，测试与单机用） |
| `ssh` | ssh 目标。只支持密钥登录（`BatchMode=yes`），不会弹出密码提示 |
| `sshOptions` | 可选，原样加在 ssh / scp 前面，例如 `["-p", "2222"]` |
| `shell` | 远端的登录环境：`powershell`（Windows）或 `posix`（macOS / Linux）。Windows 上命令用 `powershell -EncodedCommand` 传过去，OpenSSH 的默认 shell 是 cmd 还是 PowerShell 都能用 |
| `root` | 远端工作根目录，只能用 ASCII 字母、数字与 `_ : / \ . -`，不能有空格或中文。缓存仓库、运行目录、锁、共享的 Python 环境都在这里 |
| `node`、`git` | 远端命令名或完整路径。非交互 ssh 会话的 PATH 常常比桌面终端短，找不到时写完整路径 |
| `env` | 远端运行时附加的环境变量（例如 `BEIMING_ANGLE`） |
| `slots` | 这台机器同时允许几个远程任务，默认 1 |

## 工作站的一次性准备（Windows）

在工作站上以管理员身份打开 PowerShell：

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Git.Git -e
```

然后把控制机的公钥（例如 `~/.ssh/id_ed25519.pub` 的内容）加到工作站账号的 `C:\Users\<账号>\.ssh\authorized_keys`；管理员账号要加到 `C:\ProgramData\ssh\administrators_authorized_keys`。回到控制机确认：

```bash
ssh -o BatchMode=yes <用户>@<主机> node --version
node tools/remote/cli.mjs check rtx
```

FFmpeg、uv、显卡驱动按 [RTX 工作站](../../docs/RTX工作站.md)第 1 节装好；Python 不用装，setup 会用 uv 取 3.12。

## 工作站上的布局

```
<root>/
  repo.git/                缓存的裸仓库，按提交保存 refs/beiming/<sha>，第二次起只收增量
  runs/<run-id>/           每次运行一个独立工作树，结束后删除（--keep 时保留）
  runs/<run-id>.json       远端的运行记录
  locks/slot-<n>.json      整机槽位锁（持有者进程已不在时自动接管）
  deps/venv-<锁文件哈希>/   按 requirements.lock 的哈希共享的 Python 环境
  bin/agent-<哈希>.mjs      控制机每次上传的远端 agent（只用 Node 内置模块与 git）
```

run-id 形如 `20261110-153012-<短提交>-<随机>`。长期不用的运行目录：`node tools/remote/cli.mjs cleanup rtx` 删除 7 天以前的、没有被锁住的；`--all` 删除全部没被锁住的。

## 可靠性约定

- **按提交运行**：远端只拿到已提交的内容，并且检出的是确切的提交号，不是分支名；运行记录写明提交号与机器指纹（主机名、系统、CPU、内存、Node、git、显卡与驱动）。
- **取回即核对**：每个文件取回后重算 sha256，与远端记录的值不同就删掉本地副本并退出 1；本地已有同名但内容不同的文件不覆盖。
- **中断即清理**：控制机退出、按 Ctrl+C 或 ssh 断开时，远端 agent 发现 stdin 被关闭，就结束整棵子进程树、删除本次工作树、释放锁，退出 130。
- **不留后门**：远端不常驻任何服务，不开端口；agent 每次随命令上传、按内容哈希命名。
- **参数不经 shell 拼接**：所有参数先编码成 base64url 的 JSON 令牌再传给远端 agent，令牌里只有 `[A-Za-z0-9_-]`，任何 shell 都不会改写它。

## 本机试跑

不需要第二台机器，用 `local` 传输在本机另一个目录里走一遍全流程：

```bash
node tools/remote/cli.mjs run adhoc --transport local --root "$HOME/beiming-remote-test" --no-setup --fetch out/hello.txt -- node -e "require('fs').mkdirSync('out',{recursive:true});require('fs').writeFileSync('out/hello.txt','hi')"
```

```powershell
node tools/remote/cli.mjs run adhoc --transport local --root "$HOME/beiming-remote-test" --no-setup --fetch out/hello.txt -- node -e "require('fs').mkdirSync('out',{recursive:true});require('fs').writeFileSync('out/hello.txt','hi')"
```

取回的文件在 `out/remote/adhoc/<run-id>/out/hello.txt`，运行记录在 `out/remote/adhoc/<run-id>.json`。
