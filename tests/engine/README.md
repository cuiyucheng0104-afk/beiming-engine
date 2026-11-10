# tests/engine · 引擎九层的测试

读者｜改 engine/core、form、shade、stage、look、paint、overlay 的人与 agent　维护｜P13

改了引擎先跑这一组，再看像素（金标准 `npm run golden -- compare`，P08）。

```sh
node --test "tests/engine/**/*.test.mjs"      # 本目录，约 1–2 秒（Node 24 的 node --test 要写 glob）
node tools/run-tests.mjs --only engine,lab    # 连同 engine/*/ 里的老测试与 lab 回归，约 5 秒；软件渲染约 30 秒
```

带 `.browser` 的文件要无头浏览器（`npm run setup` 装）；没装时整组跳过，不算失败。`BEIMING_ANGLE=swiftshader` 可在没有显卡的机器上跑。

| 文件 | 锁住什么 |
|---|---|
| core.test.mjs | math 的缓动与哈希、clock（24 fps 逐位不变，25 / 30 fps 一拍 n 每张停 n 帧）、noise 必须给种子、笔触轮廓 |
| stage.test.mjs | film.js 的 `__RENDER` 校验（渲染器注入的 `fps: null` = 没指定）、设计画幅适配、镜头表与局部时间（老写法逐位同改动前）、TEXTS 规整、screenAnchor |
| film.browser.test.mjs | 页面约定 v1 在真浏览器里：24 / 25 / 30 fps 帧号无重复、注入 `fps: null` 时退回页面帧率、镜头 ctx、加长前一镜后一镜逐像素一致、纸纹地址失败时渲染器非零退出且不留图片 |
| shade-anchors.test.mjs | three r170 着色器锚点：所有材质族与弯曲钩子都注入得进去、`#include` 块都存在、锚点写错直接报错；compose 的纸纹变体（锚点、面积取样）对得上 FINAL_FS，默认仍用原文 |
| api-snapshot.test.mjs | 50 个模块的导出名（`api-snapshot.json`；stable 逐个锁定，experimental 只要求登记） |
| form.test.mjs | 弯曲 JS 镜像（头部不动、刚体、周期）、放样、山石、散布、平面曲线的性质 |
| look-paint.test.mjs | 颗粒 / 墨线沸腾的种子（默认逐位同改动前）、纸纹锚点、仿射、弧长曲线、飞白笔毛、宣纸亮度场、倒角距离、显示层文字方框（TEXTS 的 box / alpha / font） |
| paint.browser.test.mjs | 毛笔（确定性、不弄脏画布状态、飞白只露纸、按变换画）与宣纸（无缝、纸色、canvasPaper 中性点） |

`fixtures/paper-missing/` 是渲染器失败夹具（故意缺纸纹图），`lib/` 是浏览器夹具与快照比对，都不是测试文件。

**有意改了 API**（删、改名、新增 stable 模块的导出）：确认后运行 `node tests/engine/lib/api-snapshot.mjs --write` 更新快照，在 CHANGELOG 的 [Unreleased] 记一笔。新模块按 experimental 登记，稳定后在 `api-snapshot.json` 里改成 stable。

**改着色器补丁或升级 three**：先跑 `shade-anchors.test.mjs`，再跑 `engine/look/gpu.test.mjs`（要 GPU 或 `BEIMING_ANGLE=swiftshader`；R61–R63 守纸纹锚点、scaleMode 与「原生 4K 缩回 1080 与 1080 直出高频能量相同」）。

**像素纪律**：《北冥》（src/）、作品站（src/kun_qinglv.js 等的 import 链）与 lab 的画面不许无意改变。新参数一律默认关；本目录里「与改动前逐位相同」的用例就是守这条的。
