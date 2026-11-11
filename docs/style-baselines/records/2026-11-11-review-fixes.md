# 2026-11-11 · 复核意见修复与新底座 9682eee 上的复核

读者｜集成负责人　状态｜修复完成；两条新登记待集成负责人复核　依据｜独立复核意见（3 条 must、3 条 should）；规则见 [../POLICY.md](../POLICY.md)

`hard/P08` 已合入集成分支 `routes-template@9682eee`，比上一版底座多了 P15（C 路线）与 P16（案例库）。本页记录：合入后基线还成不成立、复核意见每一条怎么改、怎么验证。环境：Apple M5 Pro，ANGLE Metal；chromium-headless-shell 153.0.8010.12；Node 24.13.1。

## 1. 合入后的像素相关路径

- `git diff --stat c49da14 9682eee -- engine src lab assets fonts index.html routes/a-webgl/template`：没有改动。
- 变了的只有 `routes/c-style/template`（11 个文件）与 `routes/c-style/fonts`（17 个文件），都是 P15 的提交（db8da8a 片名字体与 film.json v2、be1dd93 笔触与染色等）。

## 2. 复核结果

| 命令 | 结果 |
|---|---|
| `node tools/baseline/golden.mjs compare --set beiming-core,lab,beiming-detail --strict --json` | exit 0；44/44、60/60、37/37 逐像素一致；88 秒 |
| `node tools/baseline/golden.mjs compare --set beiming-original-v1 --reference beiming-original@v1 --strict --json` | exit 0；20/20 |
| `node tools/baseline/golden.mjs compare --set templates --strict --json`（重新登记前） | exit 4：tpl:a 6/6 一致；tpl:c 缺 6 帧、多 6 帧，没有同编号帧变化 |
| `node tools/baseline/determinism.mjs . --seams --workers 4` | exit 0；12 帧；31 秒 |
| `node tools/baseline/determinism.mjs .` | exit 0；18 帧；46 秒 |
| `node tools/baseline/determinism.mjs --template a` / `--template c` | 都是 exit 0；各 15 帧；各约 23 秒 |

tpl:c 缺帧、多帧的原因：P15 把 C 模版的片长从 3 秒改成 8 秒，集合按 `uniformMid: 6` 取样，取样时刻全部变了。

## 3. templates 重新登记（复核意见 should #1）

- **归因**：tpl:a 逐像素不变；tpl:c 的变化全部来自第 1 节列的 P15 改动。P15 经独立复核通过，集成负责人在 9682eee 合入，这就是批准依据。新画面已逐帧查看：毛笔楷书片名竖排、朱印「北冥」，没有字体回落。新 C 模版的确定性检查也通过（第 2 节）。
- **登记**：`golden update --set templates --commit 9682eee`。登记的是集成分支上的提交：它在像素相关路径上与本分支逐字节相同，工作分支压扁合并后清单里的提交仍然找得到。审批记录的 `by` 写的是集成负责人，并注明由本包代理代为执行、待集成负责人复核。不同意的话，回退提交 ed088d3 里 templates 那一项。
- **验证**：登记后 `compare --set templates --strict --no-cache`（独立重截一遍）→ 12/12 逐像素一致。

## 4. fixtures 首次登记：灰阶色卡（复核意见 should #2）

darwin-metal 原先登记的四套集合里没有 `fixture:graycard`，GPU 平台截图链路本身改色（色彩配置、合成器、ANGLE 输出）没有基线守。这次首次登记夹具集合 `fixtures`：纯函数画布页 4 帧，灰阶与色块卡 1 帧。已有集合都没改，它们的集合哈希不变。登记人与 G0 相同（本包代理，待集成负责人复核）。登记后 `compare --set fixtures --strict --no-cache` → 5/5。

## 5. 关键帧 PNG 移出仓库（复核意见 must #1，D10）

- 仓库只留登记 `beiming-original@v1/keyframes.json`，内容是名字 → 帧编号、像素哈希、首次导出的字节哈希。六张 PNG（17.1 MiB）在新提交里删除；历史里的 84c92dd 怎么处理由集成负责人在合入时定。
- `golden keyframes` 改为重建到 `out/style-baselines/<名@v版本>/keyframes/`。登记完整时不改任何入库文件，登记被手改就拒绝。实测：darwin-metal 上 17 秒重建六张，与登记**逐字节**相同（6/6 sha256 一致），`git status` 干净。
- 规则：`baseline.references` 只核对登记，不再要求 PNG 在库；`baseline.no-render-products` 拒绝 `docs/style-baselines/` 下任何入库的图片或视频，关键帧 PNG 会给出移出与重建的命令。
- 只能在 darwin-metal 上重建。跨机器分发走 Release 附件，属于公开动作，要用户授权。

## 6. 像素相关路径补上 C 路线字体（复核意见 must #3）

- **现象**：C 模版运行时会读 `../../routes/c-style/fonts/fonts.json`，但 `PIXEL_PATHS` 不含这个目录。结果有三处：现渲旧提交时导出的快照里没有字体清单，C 模版打不开；`compare --set templates --against routes-template` 以 exit 1 失败；审批时的等价性核对也看不到字体改动。
- **修复**：`tools/baseline/lib/git.mjs` 的 `PIXEL_PATHS` 加 `routes/c-style/fonts`。新增单测，扫 `sets.json` 里全部模版页的 `../../` 运行时引用，核对它们都落在快照导出的路径内；去掉修复时这个单测会报出 `film.js → routes/c-style/fonts/fonts.json`。
- **验证**：`compare --set templates --against routes-template --json` → exit 0，12/12 逐像素一致；快照 189 个文件、66.8 MiB，用完即删。

## 7. 测试不再假定 out/ 已存在（复核意见 must #2）

四个测试原先直接在 `out/` 下建临时目录。现在其中三个先建 `out/`，页面快照那一个改用系统临时目录。在新检出的工作树上验证：

| 场景 | 结果 |
|---|---|
| 新检出、有浏览器，`node tools/run-tests.mjs --only golden` | 27/27 通过 |
| 新检出、没有浏览器（模拟 CI 的 unit job） | 23 通过，4 跳过（要浏览器的那 4 项），0 失败 |

## 8. CI 冒烟（复核意见 should #3，文件属 P09）

`tests/ci/smoke-render.mjs`、`tests/ci/README.md`、`.github/workflows/ci.yml` 的改动已做成补丁交给集成负责人，与本包同批合入。改了这几处：

- 默认集合改为 `ci`。
- auto 模式只在这些集合都有经审批的基线时才比对，只有候选时按首次采集处理。
- 只有 exit 4 才附「像素有变化」的提示。
- 工件带上截帧目录，包括帧图、总览 `contact.png` 和 `capture.json`。
- 首次采集的说明改为 approve 转正流程。
- smoke-render 的 checkout 改为 `fetch-depth: 0`。

本机在临时工作树里用 SwiftShader 端到端验证（load average 约 17），P09 的测试 15/15 通过：

| 步骤 | 结果 | 用时 |
|---|---|---|
| ① 首次采集 | exit 0，写出候选；工件 26 MiB，含 38 帧与 contact.png | 84 秒 |
| ② 只有候选时再跑 | exit 0，再采集一遍（补丁前这一步是 exit 1） | 96 秒 |
| ③ approve | exit 0 | — |
| ④ 再跑 | exit 0，38/38 逐像素一致 | 92 秒 |
