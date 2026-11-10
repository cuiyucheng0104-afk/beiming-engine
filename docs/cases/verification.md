# 归档验收记录

> 读者：维护案例库的人｜状态：归档记录｜依据：2026-11-07，macOS；没有占用 5090 重新渲染影片

| 检查 | 实际结果 |
|---|---|
| SY 完整快照 | 331 文件，与 `e41dee31a5c05dffa12b2f241378e648d2a22df6` 的 Git blob 逐项一致 |
| Lemo 完整快照 | 2478 文件，与 `bebbbe1aa92a3cb4bb6f83500e61b23a17d1aa00` 的 Git blob 逐项一致 |
| 全部案例清单 | 96 条记录（95 工程+1 共用资源），路径、代码哈希、素材包引用和入口存在性检查通过 |
| 文件精确去重 | 2554 个代码/文本文件位置；137 处直接引用 Lemo 风格库快照；素材/代码合计避免约 764MB 重复保存 |
| 输入与实验图 | 6656 个唯一二进制对象；每个对象和压缩包都有 SHA256 |
| 原始视频 | 97 个原文件版本逐个 ffprobe 核对时长、尺寸、帧率/可用帧数；封装到原片包不修改字节 |
| 观看预览 | 86 个工程生成观看副本；由已有成片转码，不是重新渲染；多版本在同一卡片下 |
| 历史工程还原 | 水彩和瑞士排版恢复完整素材；两个 PPT 工程恢复源码；原本机文件未覆盖 |
| 实际渲染抽测 | 水彩 3s/14.75s、瑞士排版 2s/8s，经北冥 still 工具在 1920×1080 输出成功 |
| SY 风格库实际抽测 | 扁平矢量、像素、水墨三个原样示例，调用原生 __seek(5)，页面无异常并输出截图 |
| 画廊 | 96 卡片、PPT 筛选 7、搜索、播放弹窗、390px 窄屏无横向溢出；桌面与移动截图已检查 |
| 还原工具测试 | 9 项（2026-11-07 时）：哈希、目录穿越、符号链接越界、覆盖保护、损坏包、原子恢复、纯源码、大小写冲突、vendor 快照完整性；现状见下一节 |
| 既有路线计划 | routes:check 有效，原有 14 项测试通过；合入并行提交的 T01 实现后，生产契约 13 项测试也通过。该实现由并行工作提供，本批归档未代为完成其他计划任务 |

## 未扩大结论

没有重建全部历史影片，没有重新测 Windows/5090 性能，没有对七部 PPT 影片统一重做配音/响度母带，也没有新增 SY→北冥或北冥→RAEA 材质适配。快照完整不等于其全部依赖已经安装，归档可恢复不等于历史脚本已完全跨平台。

新归档的脚本路径替换为显式还原标记。上游快照保留公开源文件原样，并未改写作者文档。媒体和输入素材保留原项目权利范围。

**更正（2026-11-10）**：上一版这里写「归档源文本检查未发现常见密钥模式或签名下载令牌」，与事实不符：历史配音的 TTS 原始响应里有 281 个带签名查询串的第三方下载链接（签名已过期），带还原标记的文件还公开了脱敏前的哈希（能反推出标记原值），文档类文本里另有约 150 处原机路径。处理与复核见下一节。

## 2026-11-10 复核（可复现）

在仓库根目录执行；`<python>` 指仓库选定的解释器，命令写成 `node tools/env/py.mjs …` 时自动选择。

| 检查 | 命令 | 结果（2026-11-10，macOS） |
|---|---|---|
| 案例库核对 | `node tools/env/py.mjs tools/casebook.py check --rights` | 退出 0：96 条记录、2243 个唯一源文件、2809 个 vendor 文件（2 个快照）；权利字段与授权登记册一致；提示 7 个历史素材包混装公开与内部素材 |
| 签名链接 | `node tools/compliance/scan.mjs --only signed-urls --scope archive` | 0 处（281 个文件已在新提交里去掉查询串，catalog 记 `redactions: ["signed-url-query"]`） |
| 签名链接残留 | `git grep -c OSSAccessKeyId -- cases` | 无输出（0 处） |
| 脱敏前哈希 | `node tools/env/py.mjs tools/casebook.py check`（第 2 版字段校验） | 带还原标记的 219 条记录都没有 `originalSha256` |
| 本机路径 | `node tools/compliance/scan.mjs --only local-paths --scope archive` | 149 处、70 个文件（文档里的原机目录、工作站 `D:\` 路径、会话临时目录写法；只报告不阻塞，待逐条脱敏） |
| 权利字段交叉核对 | `node tools/repo-check.mjs --only cases` | `cases.rights`：10 个登记类别与合规工具的计算一致，内部案例 15 个 |
| 生成文件 | `node tools/env/py.mjs tools/casebook.py index --check` | 99 个生成文件（96 张案例卡、INDEX.md、index.html、NOTICES.md）都是最新的 |
| 工具测试 | `node tools/env/py.mjs -m unittest discover -s tools -p test_casebook.py` | 全部通过（数量以输出为准） |
| 作品站构建 | `node tools/env/py.mjs tools/build-showcase.py` | 79 部，`out/site/data/works.json` 与改动前逐字节相同 |


本批源码与素材下载入口在 [案例库](../../cases/README.md)。Release 的 `SHA256SUMS.txt` 可核对所有素材包、原片包和观看副本。每个工程的细项见 [catalog.json](../../cases/catalog.json)。
