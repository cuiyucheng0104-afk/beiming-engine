# 质量：机器 QA 门与评分标尺

| 文件 | 用来做什么 |
|---|---|
| [QA-GATE.md](QA-GATE.md) | 机器 QA 门 `tools/qa`：命令、退出码、每项检查的判据与修法、豁免、报告格式、实测记录。出片后先跑它 |
| [RUBRIC.md](RUBRIC.md) | 成片评分标尺：六个维度、锚点、一票否决、评审记录的写法。审片人与评测方用 |
| [known-issues.json](known-issues.json) | 已知问题台账：每条有症状、根因、证据、回归命令、属主；QA 的 `report` 会读它 |
| [waivers/](waivers/README.md) | 豁免记录：只有用户批准的才生效，agent 只能起草 |

一句话流程：终渲 → `node tools/qa/cli.mjs report <成片>`（exit 0 才算「代理检查通过」）→ 人全速带声看完、按 RUBRIC 记分与原话 → 用户签认后才是 accepted。
