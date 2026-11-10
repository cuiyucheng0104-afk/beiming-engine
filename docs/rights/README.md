# 权利、许可与合规

读者｜全部 agent 与维护者　状态｜生效（2026-11-10）　依据｜决定 D02、D03、D04、D11（[docs/decisions/2026-11-10-industrial-baseline.md](../decisions/2026-11-10-industrial-baseline.md)）

这里登记仓库里每一类素材**归谁、凭什么能用、能用到哪**，并规定写代码、做片、发布时要守的许可与安全规则。规则都有机器检查（`node tools/compliance/scan.mjs`，也接在仓库规范检查 `check:repo` 的 `comp.*` 规则里）。

## 先读这八条

1. **第三方与客户素材只用于登记过的作品。** 上美影 IP、乐奇客户材料、参考图等已由用户声明获得授权（2026-11-10），但授权范围等字段还「待补」；要用到新作品、模版、作品站新页面或其他对外物料，先问用户并在 [register.json](register.json) 写明范围。
2. **从上游借代码要写来源头。** 照抄、改名、改写都算；写法见 [licensing.md](licensing.md)「派生代码的来源头」。
3. **B 路线的运行时 RAEA 是第三方 FSL 软件**：只当内部制作工具，不分发、不搬源码、不做成对外的产品或服务（[fsl-boundary.md](fsl-boundary.md)）。
4. **含 AI 生成内容就做标识**：片尾与说明写「含 AI 生成画面」等固定文字，成片 comment 写隐式标识，派生底板记来源链（[aigc.md](aigc.md)）。
5. **不入库**：凭据与令牌、`.env`、私钥与证书、本机绝对路径、内网地址与工作站主机名、个人邮箱、带签名的下载链接。提交前跑 `node tools/compliance/scan.mjs --staged`。
6. **提交身份用 GitHub noreply 邮箱**（带账号数字 ID 的正式写法，见决定文档「补充约定」）。
7. **不知道就写「待补」**：权利方、授权范围、期限、书面证据，用户没给的一律不推断、不编造。
8. **不改写历史（D02）**：要删的内容在新提交里删；已公开的历史只报告。

## 本目录的文件

| 文件 | 内容 | 怎么维护 |
|---|---|---|
| [register.json](register.json) | 授权登记册的数据：13 类素材与运行时的权利方、授权方、范围、期限、书面证据存放位置、状态、证据位置、义务与 agent 规则、匹配哪些案例 | 手改（唯一的数据源） |
| [register.md](register.md) | 由上面生成的登记册：每类受影响的案例、Release 附件、预览与仓库内文件 | `node tools/compliance/rights-inventory.mjs --write` 生成，不要手改 |
| [licensing.md](licensing.md) | 根 LICENSE 的适用范围、REUSE.toml 的文字说明、文件头写法、派生代码的来源头与判定、已登记的派生文件 | 手改 |
| [fsl-boundary.md](fsl-boundary.md) | B 路线（北冥原生 · BNE）使用上游 RAEA 的许可边界、固定版本与转换日期、对外署名 | 升级运行时时同步改 |
| [aigc.md](aigc.md) | AI 生成内容的显式与隐式标识、C2PA 与来源链、对外描述 | 手改 |
| [signed-urls.md](signed-urls.md) | 历史 TTS 原始响应里的签名下载链接清单（不含签名原值） | `node tools/compliance/signed-urls.mjs list --md --out docs/rights/signed-urls.md` 生成 |

根目录相关：[LICENSE](../../LICENSE)（标准 MIT 正文）、[REUSE.toml](../../REUSE.toml)（逐路径许可）、[LICENSES/](../../LICENSES/)（许可全文）、[SECURITY.md](../../SECURITY.md)（安全报告与凭据处理）、[THIRD-PARTY.md](../../THIRD-PARTY.md)（上游来源与义务）。

## 命令

| 命令 | 作用 | 退出码 |
|---|---|---|
| `node tools/compliance/scan.mjs` | 全仓合规扫描（只读）：密钥、敏感文件、本机路径、内网地址、签名链接、个人邮箱、FSL 边界、派生代码、REUSE、LICENSE、登记册、AI 标识 | 0 无阻断；4 有阻断 |
| `node tools/compliance/scan.mjs --staged` | 只扫暂存区（提交前用） | 同上 |
| `node tools/compliance/scan.mjs --strict` | 待修豁免不生效，看真实欠账 | 同上 |
| `node tools/compliance/scan.mjs --only <规则> --scope archive` | 列出历史归档区的逐条发现 | 同上 |
| `node tools/compliance/rights-inventory.mjs --check` | 核对登记册是否最新、客户与 IP 作品是否全部登记 | 0 通过；4 过期或漏登 |
| `node tools/compliance/signed-urls.mjs list` | 列出签名链接（不输出签名值） | 0 |
| `node tools/compliance/aigc.mjs check <成片>` | 核对成片的隐式标识 | 0 通过；4 缺失或不合规 |

全部命令支持 `--help`（无副作用）与 `--json`（stdout 只有一个 JSON 对象，见 docs/CLI.md 的信封约定）；用法错误退出码 2，环境问题（不是 git 仓库、缺 ffprobe）退出码 3，工具自身出错退出码 1。

**区域**：仓库主体按规则阻断；`cases/source/`（历史归档）与 `cases/vendor/`（第三方快照）的发现**只报告不阻塞**，由案例库属主分批清理。

**允许清单** [tools/compliance/allowlist.json](../../tools/compliance/allowlist.json) 只有两类条目：`false-positive`（人工判定不是问题，写理由与判定人）与 `pending`（真问题、等别的工作包修，必须写属主、截止日期与跨包请求的出处，到期自动失效）。不要用它掩盖真实泄露。

## 怎么补授权信息

1. 用户给来授权书或合同的信息后，改 [register.json](register.json) 对应类别的 `holder`（权利方）、`licensor`（授权方）、`scope`（授权范围）、`term`（期限）、`writtenEvidence`（书面证据**存放位置**，不放合同正文），把 `status` 改成相应状态。
2. `node tools/compliance/rights-inventory.mjs --write` 重新生成 register.md，再 `--check`。
3. 授权范围不覆盖公开分发的素材：由用户决定是否下线；需要删除的在新提交里删除（D02），Release 附件的增删属于公开动作，要用户授权后执行。

新增第三方或客户素材时，先在 register.json 加一类或扩展已有类别的 `match`（案例、分组、文件通配或源码里的文字），再入库或发布。

## 签名链接的清理

历史配音的 TTS 原始响应（`cases/source/ppt-*/配音/wav/*.json`）里留有第三方 MiniMax 的 OSS 下载链接，查询串带 `OSSAccessKeyId`、`Signature` 与过期时间。签名已于 2026-11-03 至 11-04 过期，用户无法也无需轮换这把密钥（决定文档「补充约定」）；处理办法是**在新提交里去掉查询串**，不改写历史。清单见 [signed-urls.md](signed-urls.md)（281 处、281 个文件、7 个案例）。

由案例库属主执行，步骤：

```bash
node tools/compliance/signed-urls.mjs strip                       # 演练：列出要改的文件与处数，不写文件
node tools/compliance/signed-urls.mjs strip --write --patch-out <补丁.json>
#   只删 URL 里从 ? 开始的查询串；JSON 仍合法、换行不变；重复执行无副作用；目标文件有未提交改动时拒绝执行
# 用补丁里每个文件的新 sha256 与大小更新 cases/catalog.json（按 source 找全部引用），然后：
python tools/casebook.py check
node tools/compliance/scan.mjs --only signed-urls --scope archive  # 应为 0 处
node tools/compliance/signed-urls.mjs list --md --out docs/rights/signed-urls.md
```

注意：`cases/catalog.json` 给每个归档文件记了 `sha256`（仓库里这份副本的哈希）与 `originalSha256`（原始文件的哈希）。去掉查询串后 `sha256` 必须按补丁更新，否则 `casebook check` 报校验和不符；`originalSha256` 怎么处理（保留、删除或改为加盐摘要，审计 COMP-05 另有要求）由案例库属主决定。

## 提交身份与为什么没有 .mailmap

- 新提交一律用账号的正式 GitHub noreply 地址；扫描会对两种情况给提示：当前 git 配置是个人邮箱、2026-11-10 之后的提交用了不带数字 ID 的 noreply 地址。2026-11-10 之后仍用个人邮箱的提交会阻断（尚未推送时改作者后再推）。
- 已公开的旧提交里有 31 个用了个人邮箱。按 D02 不改写历史，只报告。
- **不建 .mailmap**：它只改变 `git log` 的显示，却要求把要隐藏的个人邮箱原样写进当前文件树——等于在最显眼的位置再公开一次。需要合并作者身份时由用户本人决定。
- 用户本人在 GitHub 设置里打开「Keep my email addresses private」与「Block command line pushes that expose my email」（账号设置，由用户操作）。

## 与其他工作包的分工

- `cases/**`（归档清理、案例卡的权利字段、签名链接清理）：案例库属主，按本目录的清单执行。
- `engine/**`、`tools/**` 里派生文件的来源头：各文件的属主，写法见 [licensing.md](licensing.md)。
- 根文档（README、AGENTS、ROUTES、THIRD-PARTY、docs/TRACKS）里的许可、署名与 AI 标识文字：根文档整合时统一写入。
- 出片与 QA 工具里的 AI 标识：编码器写隐式标识、QA 门核对，接口见 [aigc.md](aigc.md)。
