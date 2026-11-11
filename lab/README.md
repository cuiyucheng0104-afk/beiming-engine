# A 路线模块自测页（lab/）

经仓库根的 `index.html?test=<名字>` 打开（`src/boot.js` 分发到 `lab/<名字>.js`），每页兑现页面约定（`window.DUR / render(t) / READY`），所以能用渲染器出静帧：

```sh
node engine/render/still.mjs . 0.5 2.0 3.5 --size 1280x720 --query test=kun_qinglv --out out/lab
node tools/lookdev/sweep.mjs . --t 1.0 --q test=look --q kr=3,5,7      # 扫一个查询参数，出对照网格
```

**风格认可只接受正片管线渲出的帧。** 下表「正片后期」一列为「是」的页，墨线、笔触、纸纹、调色与正片同一条管线（`src/look.js` → `engine/look`）；为「否」的页是单项检查，画面不能拿去当画风依据。

| 页 | 验证什么 | 正片后期 | 常用参数 |
|---|---|---|---|
| `look` | 后期各道（墨线、雾、bloom、调色、Kuwahara、纸纹、暗角、颗粒）的开关与调试视图；测试材质 | 是（测试场景） | `lw wob kr kf ks pk bs`（见页头注释）、`dbg=id\|edge\|line\|kuwahara\|paper` |
| `kun` | 原版鲲：造型、卡通材质、一拍三姿态、眼睛 | 是（默认） | `view=side\|top\|far\|eye\|under\|reveal`、`lod`、`roll`、`look=1`、`noink=1`、`pass=1`、`dbg=` |
| `kun_refine` | 原版精修（图上标「东方化」） | 是（默认） | 同上，另有 `nopine nowhisk noclouds nowisps`、`cam= at= fov= sky=` 自由机位 |
| `kun_qinglv` | 青绿仙山：瀑布、仙岛、扇形胸鳍 | 是（默认） | 同 `kun`，另有 `view=hero\|isle\|front\|tail` |
| `kun_qinglv_look` | 青绿仙山换进正片后期：ID 图能否编译 `userData.outlineVertex`（墨线贴着弯过的形体走） | 是 | `view=side\|hero\|under`、`dbg=` |
| `kun_xuan` | 玄鲲云纹 | 是（默认） | 同 `kun` |
| `kun_bronze` | 青铜古鲲：纹样、玉眼、垂苔 | 是（默认） | 同 `kun`；`dbg=pattern\|fins` 看纹样展开图与离缘距离场（不渲 3D） |
| `kun_peng` | 鲲鹏将化：身体一拍三、翅膀一拍二 | 是（默认） | 同 `kun`；`wt=` / `bt=` 固定翅膀或身体时钟 |
| `girl` | Canvas 2D 人物：锚点、单层查看、表演时间点（自带近似正片的简易后期，只供自查） | 否 | `bg post grain layer debug cam`（见页头注释） |
| `hud` | 显示层：片名逐笔书写、骨架叠图核对、文字方框、界面元素 | 否（显示层本来就不过后期） | `skel=1`、`boxes=1`、`theme=neutral` |

`kun_bench.js` 是各鲲页共用的渲染器、机位表与后期选择，不是自测页（直接打开会报错提示）。`regress.test.mjs` 是正片源码的回归测试：`node --test lab/regress.test.mjs`。

## 2026-11 起变体页默认走正片后期

此前 `kun`、`kun_refine`、`kun_qinglv`、`kun_xuan`、`kun_bronze`、`kun_peng` 六页用一段临时屏幕描边（深度 + 法线 + 物体 ID），看到的线条、笔触、纸纹和换进正片后不一样（审计 CRAFT-16；`docs/routes/beiming-style.md:151`）。现在它们默认走正片后期（`lab/kun_bench.js` 的 `labPipeline`），旧画面用 `&ink=lab` 仍能逐像素复现（`&ink=2` 是旧描边的手绘加强版）。

- 有意改变的像素：上面六页的默认画面（每页 3 个时刻实测全部改变，变化是正片后期本身：Kuwahara 笔触、纸纹、调色、ID 图墨线）。
- 没有改变的：`look`、`kun_qinglv_look`、`girl`、`hud` 四页与《北冥》正片——逐像素一致。
- `&ink=lab` 下六页 18 张帧与改动前的默认画面逐像素一致。
- 这次基线更新要经金标准的审批流程登记（`docs/style-baselines/` 的 POLICY，由基线的属主维护）；审批前，回归对照请对旧基线加 `&ink=lab`。
