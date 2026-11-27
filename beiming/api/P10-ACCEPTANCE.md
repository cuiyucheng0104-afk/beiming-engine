# P10 异族模型接入验收记录

2026-11-27 补记。按条目化清单 P10 的 D2 和 D5 条件复核。离线复跑基线为引擎 `121e605e`，环境为 macOS arm64、Node.js `v25.6.0`。历史联调采用 2026-11-22 的 M1a 归档，归档报告标记引擎基线为 `5e10ff3`。 [HTTP 代理接入 PR #69](https://github.com/cuiyucheng0104-afk/beiming-engine/pull/69)

## D2 假服务与独立账本

在本机分别启动 Chat Completions 夹具和北冥 HTTP 假服务。用现有 [`runHandsOnAgent`](./agents.mjs) 配置下表中的历史模型（省略路由前缀）。每组夹具先返回一次唯一工具 `http_request`，参数为 `GET /v1/guide`，再检查收到假服务的 `envelope/0.1` 及测试标记。假服务收到两次经过鉴权的请求，账户令牌未进入模型消息。每组代理在两轮后返回 `done`，一次工具调用为 HTTP 200、`ok: true`。

| 夹具配置的模型 ID | `external-ledger.jsonl` | 每行输入 / 输出 token |
| --- | --- | ---: |
| `gpt-6.2-sol` | 序号 1–2，`role: agent`，`family: gpt` | 11 / 7 |
| `gemini-4-hydrogen` | 序号 3–4，`role: agent`，`family: gemini` | 11 / 7 |

另以 `createOpenAiVisionReviewer` 用 Gemini 模型 ID 向同一模型夹具发送合成 PNG。夹具收到 `image_url`、返回一张合规选票，客户端读出 1 张有效票、0 张无效票。账本序号 5 为 `role: reviewer`、`family: gemini`，输入 / 输出 11 / 7 token。L5 审片客户端接收素材并返回选票，`http_request` 工具由亲手模式客户端提供。本节的模型响应和用量均来自本地夹具。

## D5 真实北冥 API 联调

历史 A11 两次尝试的代理轨迹均显示，模型在第 1 步通过 `http_request` 发出 `GET /v1/guide`，收到 HTTP 200、`ok: true`。同批外部账本第 1 行可按 `role: agent`、`step: 1` 和模型 ID 对上。用量记在独立的外部账本。

| 历史运行 | 调用入口的模型 | 第 1 行输入 / 输出 token |
| --- | --- | ---: |
| A11 · GPT 第一次尝试 | `gpt-6.2-sol` | 5,724 / 66 |
| A11 · Gemini 第二次尝试 | `gemini-4-hydrogen` | 3,326 / 79 |

历史 A10 核验报告的 `verification.L5` 记录了真实审片，Gemini 返回 `status: ok`、2 条意见和 `overridesHardGates: false`。同批外部账本第 41 行记为 `role: reviewer`，输入 / 输出 5,398 / 5,269 token。A11 第一次尝试的 Gemini 审片同样返回 `status: ok`，对应外部账本第 60 行的 5,376 / 3,688 token。A11 第一次尝试的整包验收被 L2 纯函数门拦截。

## 自动化复核

三套 API 测试共通过 40 项，无失败或跳过。覆盖 `/v1/guide` 合同、模拟代理工具循环与计量、视觉客户端错误处理、图像工具响应、需求原文转发，以及 L5 的记账、预算与并发。

```sh
env -u BEIMING_AGENT_ENDPOINT -u BEIMING_AGENT_API_KEY -u BEIMING_AGENT_MODEL \
    -u BEIMING_REVIEW_ENDPOINT -u BEIMING_REVIEW_API_KEY -u BEIMING_REVIEW_MODEL \
    node --test \
    beiming/api/api.test.mjs beiming/api/m1b-visual-review.test.mjs beiming/api/l5-parallel.test.mjs
```

## 记录范围

D2 的功能证据为 11 月 27 日补测，D5 的入口证据来自 11 月 22 日的真实模型和真实北冥 API 运行。上述两条历史模型 ID 为实际参测组合，用户在 D2 前确认的选型和当日执行凭证仍待补记。本轮复跑只使用回环服务与临时账本。
