# 画面基线

读者｜改引擎、改样片、改模版的人与 agent　状态｜生效（2026-11-10）

改了会出画面的代码，合入前先跑：

```sh
node tools/baseline/golden.mjs compare --set beiming-core,lab,templates --strict
```

exit 0 就是逐像素没变；不是 0 就看报告里的差异热图与接触印（路径在 stderr 和 `--json` 信封的 `outputs` 里）。

| 文件 | 内容 |
|---|---|
| [POLICY.md](POLICY.md) | 规则：回归金标准与认可参照的区别、存什么、平台键与容差（附实测）、`--gpu` 策略、什么时候跑、画面有意改了怎么审批更新 |
| [beiming-original@v1/](beiming-original@v1/README.md) | 《北冥》认可画面参照：二十帧的清单、六张关键帧的登记（`keyframes.json`，`lookPreset` 与 look 闸门用；图用 `golden keyframes` 在 darwin-metal 上本机重建）、画风的几个数、认可依据 |
| [media-provenance.json](media-provenance.json) | `media/` 每个文件的来源、生成命令与复现结果 |
| [records/2026-11-10-darwin-metal-g0.md](records/2026-11-10-darwin-metal-g0.md) | 首批基线登记记录：与合并前的差异逐帧归因、确定性实测、容差标定 |
| [records/2026-11-10-d05-media-provenance.md](records/2026-11-10-d05-media-provenance.md) | D05 调查：公开成片里的红珊瑚从哪来、两种处理各改哪些文件 |
| [records/2026-11-10-d05-review.md](records/2026-11-10-d05-review.md) | D05 复核：读原始会话记录、独立重渲第 177 帧；结论成立，补了「复制早于 4K 构建结束」的时序证据 |
| [records/2026-11-10-rebase-2a0a0f3.md](records/2026-11-10-rebase-2a0a0f3.md) | 合入新底座后的复核（153/153 + 20/20 逐像素一致）、确定性实测、清单布局迁移 |
| [records/2026-11-11-review-fixes.md](records/2026-11-11-review-fixes.md) | 复核意见修复：底座 fb0b841 上的复核、templates 重新登记（P15 的 C 模版）、灰阶色卡登记、关键帧 PNG 移出仓库、C 路线字体纳入像素路径、CI 冒烟补丁 |

清单在 `tests/golden/<平台键>/manifest.json`（一个平台一份），审批记录在 `tests/golden/approvals.jsonl`，集合定义在 `tools/baseline/sets.json`。PNG 一律不进仓库（D10）：回归金标准的帧缓存在本机 `out/golden/`，认可参照的关键帧用 `golden keyframes` 重建到本机 `out/style-baselines/`（POLICY 第 2 节）。

别的平台（CI 的 `linux-swiftshader`、RTX 工作站）第一次建基线：在那台机器上 `capture --set <集合> --platform <平台键>` 写出待审批候选，审批人看过画面后 `approve` 转正（POLICY 第 6 节第 3 条）。
