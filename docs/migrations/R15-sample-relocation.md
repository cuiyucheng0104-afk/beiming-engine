# R15：样片源码归位与金标准重登记预留

《北冥》10 秒样片的唯一实现及页面位于 `films/beiming-10s/src/` 与 `films/beiming-10s/index.html`。根 `index.html`、`src/*.js` 是公开地址兼容入口，仅转调唯一实现。音频脚本、底板、字体仍由站点、自测页与共享注册表使用，保留 `audio/`、`assets/`、`fonts/` 的实际位置。作品描述保留 `mirror.paths=repo`，共享引用与旧输出目录不改变。

真实调用者（lab、站点模块图、原生导出桥、资产和风格注册表、时间线一致性检查、基线集合与快照路径）已改用唯一实现。新帧源按 mirror 路径基准解析 entry，不把仓库相对路径重复拼到作品目录。

迁移核验：2026-11-26，macOS arm64 Metal，原检出的 `src/` 与 `index.html` 相对 origin/main 无差异。在原入口、新作品入口、兼容根入口分别渲第 0、84、182、230 帧，三组 RGB 像素摘要逐帧相同；摘要见 `R15-sample-relocation-parity.json`。四帧检查覆盖 A/B/C 镜与片尾文字。另独立采集迁移前与迁移后兼容入口的核心金标 44 帧（40 张 1920×1040、4 张 3840×2080），44/44 像素摘要一致；当前严格金标比较也退出 0，44/44 与本机现渲的基线提交 c49da141c6d8 相同。34 张已存摘要存在浏览器环境漂移，工具以重建原基线提交核对，没有改写已存清单。

金标准重新登记独立保留一次。现有平台清单、认可参照与审批记录均未伪造或自动批准。`tools/baseline/sets.json` 的 film 页暂留已验证的根兼容入口 `.`，因此当前签名集合定义不变、旧登记仍可使用。新作品入口已有独立像素相等证据。后续单独重登记时，先将该文件 `pages.film.dir` 从 `.` 改成 `films/beiming-10s`；这会改变集合摘要。必须在登记平台完整重建并核对，再由真实批准人执行既有登记流程。待该独立变更提交形成后：

```sh
node tools/baseline/golden.mjs capture --set beiming-core,beiming-detail
node tools/baseline/golden.mjs update --set beiming-core,beiming-detail --by '<真实批准人>' --reason 'R15 源码迁移，完整重建核验后的批准依据' --commit '<迁移提交>' --ref '<批准出处>'
node tools/baseline/golden.mjs compare --set beiming-core,beiming-detail --strict
```

重登记后仍需运行仓库夜间重建。上述步骤尚未代替批准人执行，四帧相同不等于夜间全量重建已绿。
