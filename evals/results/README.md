# 评测结果

读者｜评测方与维护者　状态｜尚无正式结果：首个基线在 G1 门之后记录（加固计划第 6 节）

本目录只放 `node tools/eval/score.mjs summary <评测根> --out evals/results/<日期>.json` 生成的结果文件，一次评测一份，
文件名是评测日期（`YYYY-MM-DD.json`；同一天第二次评测加后缀，如 `2026-11-20-b.json`）。格式见
[../agent/schema/result.schema.json](../agent/schema/result.schema.json)，字段含义见 [../agent/rubric.md](../agent/rubric.md)「汇总与仓库就绪度」。

- **入库的只有结果文件**。会话记录、被测检出、成片、评审素材与评审表都留在评测根（默认 `~/.cache/beiming/evals`），不入库。
- 结果文件不含本机绝对路径（生成时替换成 `~`）；评审备注里也不要写客户材料或凭据。
- 每份结果记着被测提交（`commit`）、判定工具提交（`judge.toolsCommit`）、评分规则版本（`rubricVersion`）与评测机环境（`environment`）。
  比较两次结果时先确认这三项，规则版本不同的分数不能直接比。
- 首个基线：G1 候选提交上，DF-A、DF-B、DF-C、DF-M 各 2 次独立运行，S1–S3 各 2 次，DR-W 隔离与对照各 1 次。
  之后每个治理类改动（入口文档、路线手册、出片工具）合入前后各跑一次，附两次的就绪度对比；W3 修完后复测一次。
