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
| [beiming-original@v1/](beiming-original@v1/README.md) | 《北冥》认可画面参照：二十帧、各帧名字（`lookPreset` 用）、画风的几个数、认可依据 |
| [media-provenance.json](media-provenance.json) | `media/` 每个文件的来源、生成命令与复现结果 |
| [records/2026-11-10-darwin-metal-g0.md](records/2026-11-10-darwin-metal-g0.md) | 首批基线登记记录：与合并前的差异逐帧归因、确定性实测、容差标定 |
| [records/2026-11-10-d05-media-provenance.md](records/2026-11-10-d05-media-provenance.md) | D05 调查：公开成片里的红珊瑚从哪来、两种处理各改哪些文件 |

清单在 `tests/golden/manifests/<平台键>/`，审批记录在 `tests/golden/approvals.jsonl`，集合定义在 `tools/baseline/sets.json`。PNG 不进仓库，只在本机 `out/golden/` 缓存。
