# 安全说明

## 支持的版本

只维护 `main` 分支的最新提交。已发布的标签（如 `v1.0`、`casebook-2026.11`）不再单独打补丁；修复进入 `main`，需要时另发新版本。

## 报告安全问题

请**不要**在公开 issue、讨论区或 PR 里贴出漏洞细节、密钥或可复现的攻击步骤。

1. 首选 GitHub 的私密漏洞报告：仓库页面 → Security → Report a vulnerability。（这个入口要仓库管理员在 Settings → Code security 里打开「Private vulnerability reporting」；未打开时见第 2 条。）
2. 入口没打开时，开一个**不含任何细节**的 issue，标题写「安全问题：请求私下联系」，维护者会回复联系方式。

报告里请写：影响的文件或命令、复现步骤、可能的影响，以及你希望的署名方式。

处理目标（维护者的目标，不是合同承诺）：3 个工作日内确认收到；10 个工作日内给出评估与处理计划；修复后在提交说明与相关文档里记录，并按你的意愿致谢。

## 范围

- 在范围内：本仓库的代码、工具与工作流（`engine/`、`src/`、`tools/`、`routes/`、`.github/` 等），以及仓库或 Release 里意外公开的凭据、个人信息、内网信息。
- 不在范围内：第三方组件本身的漏洞——请报告给上游：原生运行时 RAEA（不随本仓库分发，见 [docs/rights/fsl-boundary.md](docs/rights/fsl-boundary.md)）、`cases/vendor/` 下两套风格库快照、npm 依赖。若问题出在本仓库对它们的用法，仍在范围内。

## 仓库里不能出现的东西

凭据与令牌（API 密钥、访问令牌、带签名的下载链接）、`.env` 文件、私钥与证书包、本机绝对路径、内网地址与工作站主机名、个人邮箱、未经登记的客户内部材料。完整规则与允许的例外见 [docs/rights/README.md](docs/rights/README.md)。

提交前自查（只读，不改文件）：

```bash
node tools/compliance/scan.mjs --staged     # 只看这次要提交的改动；有阻断级发现时退出码 4
node tools/compliance/scan.mjs              # 全仓
```

## 发现泄露以后

1. **凭据先作废**：在对应服务的控制台吊销或轮换，再处理仓库。仓库公开过的凭据一律视为已泄露，删掉文件不能让它失效。
2. **在新提交里删除**，并补上忽略规则（由集成负责人改 `.gitignore`）。按决定 D02，**不改写已公开的 git 历史**；确实需要从历史里清除时，由用户决定方案后执行。
3. **第三方的、已过期的签名链接**（如历史配音原始响应里的下载地址）：去掉查询串即可，不需要轮换（决定文档「补充约定」；做法见 docs/rights/README.md「签名链接的清理」）。
4. Release 附件、仓库可见性、分支保护等仓库设置的改动属于公开或不可逆的动作，只在用户明确授权后执行。

## 提交身份

新提交使用账号的正式 GitHub noreply 邮箱（带账号数字 ID 的写法），不使用个人邮箱；建议在 GitHub 账号设置里打开「Keep my email addresses private」与「Block command line pushes that expose my email」。已公开的旧提交按 D02 不改写。
