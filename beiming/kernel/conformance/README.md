# 帧源一致性与历史不变量

注册或升级帧源时，用 `suite.mjs` 核对七项实测。检查某条历史回归时，用 `invariants.mjs` 对照观测。另有 `run.mjs` 实渲三个校准镜头，验证求值核与帧源接口。以下命令从仓库根目录运行。

## 帧源注册与升级：七行报告

查看 Mac 上 Blender 的 P8 探针报告。把 `blender` 换成 `three` 可读 P7，机器可选 `mac` 或 `linux-5090`。

```sh
node --input-type=module -e "import {loadProbeSuiteReport as load} from './beiming/kernel/conformance/suite.mjs'; const r = load('blender', {machine:'mac'}); console.table(r.rows); process.exitCode = r.ok ? 0 : 1"
```

| 检查 | 过线条件（含端点） |
|---|---|
| `color-linearity` | 非零线性 RGB 分量最大相对误差 ≤ 0.02，零分量最大绝对误差 ≤ 0.005 |
| `depth` | 已知平面的相机前向深度相对误差中位数 ≤ 0.02 |
| `object-id-meta` | 近、中、远三个方块各自单渲，编号层像素框与元数据框的最小 IoU ≥ 0.95 |
| `normal-space` | 实测法线与同空间预期向量夹角的中位数 ≤ 2° |
| `camera-convention` | 相机锚点在渲染图像上的最大位置误差 ≤ 1 px |
| `shuffled-order` | 实际改变访问顺序，按帧号配对，每帧达到所选确定性档 |
| `repeat-twice` | 按原顺序独立渲染两遍，每帧达到同一确定性档 |

`hash-same-machine` 要求摘要相同。`tolerance` 要求每帧 PSNR ≥ 50 dB，且任一 RGB8 通道差值 > 5 的像素占比 ≤ 0.1%。每行返回 `status`、`measured`、`threshold`。必测项缺数或越线时，行状态为 `fail`，整份报告 `ok: false`。

新帧源用 `evaluateSourceConformance` 传入 `readings` 或原始 `observations`。Three 和 Blender 固定走 `full`，两者均需三个具名方块的 IoU。`legacy-page` 和 `ext.<名字>` 可选 `limited`，其中深度、编号、法线、相机四行标为 `exempt`。目前 5090 两列缺法线和乱序补测，Blender 另缺三个方块的单渲证据。[字段与采集方法](DETAILS.md#帧源注册与升级七行报告)

## 历史不变量：逐项做正负对照

| 编号 | 按编号顺序检查的内容 |
|---|---|
| `INV-01` 至 `03` | 顺序、乱序与单帧求值一致；随机源显式播种并独立于墙钟；有理帧率与连续整数帧区间 |
| `INV-04` 至 `07` | 有限范围 BT.709 标签；响度增益与真峰值；短音轨保留末帧；失败进程限时退出并清理 |
| `INV-08` 至 `11` | 缓存键覆盖运行时、后端与源码；风格随分辨率缩放；逐字探测缺字；分频带检测起音 |
| `INV-12` 至 `14` | 文字停留、对比度与安全区；按平台分档并区分认可参照与回归基线；CLI、HTTP 信封与退出码一致 |
| `INV-15` 至 `17` | 生成、技检和用户认可各有证据；按文件名暂存并检查体积与产物；完整 Git 历史可解析基线提交 |

`checkInvariant(id, fixture)` 核对单项。用 `makeValidInvariantFixture(id)` 查看合规输入，用 `makeViolatingInvariantFixture(id)` 对照失败原因。`runInvariantSuite(cases)` 要求 17 个编号各出现一次且全部通过。[夹具示例与扫描范围](DETAILS.md#历史不变量逐项做正负对照)

## 运行检查

```sh
node --test beiming/kernel/conformance/*.test.mjs
node beiming/kernel/conformance/fixtures/v4-probe.mjs check
```

以上两条离线核对单测与已有补测记录。执行 `node beiming/kernel/conformance/run.mjs` 会启动浏览器实渲，并先清空 `out/skeleton/`，再写入层文件、核对记录与 `summary.json`。[三镜头观测点、记录字段与退出条件](DETAILS.md)
