# kernel/conformance/：一致性入口

把最小出帧链路实跑一遍，把看到的东西写成核对记录，交给契约的校验器，再对校准场景的标准答案。

```sh
node beiming/kernel/conformance/run.mjs
```

它做的事：读 `fixtures/film.json`（三个镜头：前两个是校准场景「匀速方块」，第二个不设背景、条目顶层写的帧源留作对照、出帧的是 `renderer` 对象里写的；第三个是校准场景「辅助样本」，视场外另放三个实体，名字带大写、下划线和点号，按字节序和按字典序排出来不一样；后两个都不从全片第 0 帧起；每个镜头里有一个事件）→ 求值核展开事件表、算出每个镜头的镜头输入 → 每个镜头起两个帧源进程（两个浏览器）→ 只经帧源接口出帧、拿层引用 → 量几样要进记录的读数 → 写核对记录 → 逐个对象过校验 → 对标准答案。先写记录再对答案，对答案出错不影响记录。入口自己就是「帧源上面的那一层」：事件由它展开一次，放进镜头输入。

产物在 `out/skeleton/`（每次运行先清空，不提交）：

| 路径 | 内容 |
|---|---|
| `<镜头>/a-sequential/` | 第一个进程的主会话：按帧号顺序渲的帧、只要元数据（排在另一帧的整帧渲染后面）、同一帧再渲一遍、纯函数门的各个时刻。每次 render 一个目录：帧源写的层文件，加入口写的 `meta.json` |
| `<镜头>/a-moment-<序号>/` | 新开会话只求一个时刻 |
| `<镜头>/a-locked/` | 带着例子锁装载（镜头输入里故意不写种子）再渲一帧 |
| `<镜头>/a-draft/` | 草稿档装载再渲一帧 |
| `<镜头>/a-rejected/` | 故意造的装不了的镜头输入：都该报错，不留产物 |
| `<镜头>/a-stranger/` | 场景里多一条线（辅助层画不了的对象）时不要辅助层的那一帧 |
| `<镜头>/b-single/`、`<镜头>/b-shuffled/` | 第二个进程：新会话只渲一帧、再开会话乱序渲 |
| `checks/` | `time-check.json`、`events-check.json`（全片各一份），每个镜头的 `<镜头>.shot-check.json`、`<镜头>.source-check.json`、`<镜头>.meta-check.json` |
| `summary.json` | 每个对象过没过、违反哪条；每道门；层文件的哈希；量到的读数；对标准答案的读数；静态扫描的结果 |

## 帧源里面的事从哪看

帧源（渲染器加宿主）是黑盒，入口只调它的六个函数。里面发生了什么，靠两样：

- **观测点** `fixtures/observe.js`：入口自己的代码，包在夹具镜头代码外面，站在帧源和镜头代码之间。它记下 `build` 跑了几次、`state` 每次收到的 `(f, sub)`、场景停在那个状态时被画了几遍和各是哪一种（镜头自己的材质还在是颜色，被换了材质是辅助层；这是对这一个渲染器的假设）、`meta(f)` 每次收到的帧号和交回的键、`ctx.cards.use` 每次调用传的实例名和 `runtime` 的键、`ctx.rng` 开出的流的名字原文和出的数、`ctx.events` 里的每一项、`build` 收到的 `ctx` 里的 `seed`、`fps`、`frames`、`size`、`shot.in`、`shot.id`（在宿主给的原对象上读，没有的那一项不写）。它转交给镜头代码的 `ctx` 是挂在宿主那个对象上面的一层，只换掉 `cards`，别的项不丢。这些经 `meta(f)` 的 `readings` 交出来；读数只能是数，字符串按字符码摊开。观测只能跟着一次成功的 `render` 出来：`build` 报了错的装载交不出观测，所以镜头代码调了没声明的卡、宿主照规定报错的那种情形，这条路看不到那次调用。
- **读回的像素**：层文件自己读、哈希自己算，再照校准场景的规格求交去对。

## 记录里每一段的来历

来历是相对入口（测试工具）说的：入口自己传的、自己备的是「请求」；入口读产物、数返回值、照规格求交得出的是「量的」；观测点看到的是「旁观」；帧源交回的东西里原样抄的是「自报」。

| 记录 | 字段 | 怎么得到的 | 来历 |
|---|---|---|---|
| 时间 | `fps`、`shots[]`、`evaluations[]` 的 `shot`、`f`、`sub`、`mode`、`frames[]` 的 `frame`、`shot`、`shutterAngleDeg`、`holds[]` 的 `f`、`n`、`rng[]` 的 `run`、`shot`、`arg`、`localized[]` 的 `shot`、`frame` | 从片子描述读的、入口自己传的参数、入口放进镜头输入事件表的帧号、那次 `render` 请求的帧号换成的全片帧号 | 请求 |
| 时间 | `evaluations[].digest` | 只取一个子帧采样渲那个时刻（落在快门角 ÷ 720，观测点确认落在要的时刻才记），摘要是那张颜色层文件的哈希。只看得见会改变颜色的状态；相位大于 0.5 的时刻要不到 | 量的 |
| 时间 | `frames[]` 的 `f`、`samples[]`、`aux`，`localized[].f` | 观测点记下的：`state` 收到的时刻，带着镜头自己的材质被画的是颜色采样、被换了材质画的是辅助层；`samples[].shot` 是观测点在 `build` 收到的 `ctx.shot.id` 上读到的原文，不拿别的值去倒查，没读到时这一帧整项不写（有一道门盯着，少一项就不过）；`localized[].f` 有两种：`ctx.events` 里看到的帧号，和每次 `meta(f)` 收到的帧号 | 旁观 |
| 时间 | `accumulation.linearErr` | 照规格在每个子帧采样时刻求交出预言图（时刻照「(i + 0.5) ÷ 个数 × (快门角 ÷ 360)」自己算，不取观测点记的），在线性值上取算术平均，和帧源交回的累积颜色层逐像素、逐分量比，取最大绝对差。**边缘带里的像素不比**：采样位置在像素中心周围挪十六分之一像素、期望打到的物体会变的像素，光栅化判到哪边都合规，预言图定不下来；连边缘带一起比的读数另外打印、写进 `summary.json`，不进记录。各时刻预言全相同（没有运动、只有一个子帧采样）的帧不写；输出尺寸不是规格画幅的帧量不出，不写，打印一行原因。量法就是时间键契约 5.6 写的那一种；「十六分之一像素」是输出通道契约 5.1 给光栅化帧源定的 δ | 量的 |
| 时间 | `auxMismatch` | 照规格在这一帧 `sub = 0`、针孔、像素中心求交出预言图，和帧源交回的编号层逐像素比，编号经实体清单按名字查；写的是对不上、又不在边缘带里的像素数。交了三个辅助层、输出尺寸是规格画幅的调用才量；草稿档和缩放不是 1 的终稿档尺寸不是规格的画幅，不量。量法就是时间键契约 5.7 写的那一种。取错了要场景里有对应的东西才看得出：前两个镜头只有运动的方块，量出来的 0 判得了取错时刻，判不了孔径和像素内位置；三样都有的只有第三个镜头 | 量的 |
| 时间 | `holds[].result`、`rng[].digest`、`scan` | 入口调 `hold`；观测点取出的数由入口算摘要；入口自己扫文件 | 量的 |
| 时间 | `rng[].name` | 帧源里的宿主展开的流名，经 `ctx.rng` 交到镜头代码手里；观测点把拿到的原文交出来，不替它判对错 | 自报（经观测点取到） |
| 时间 | `accumulation.postRuns`、`postInput`、`postDepth` | 不写：从外面量不到，这条链路也没有后期链 | — |
| 镜头 | `shot`、`mode`、`entry`（出帧用的那一套）、`declaredCards`、`metaEntities[].f`、`evaluations[]` 的 `f`、`sub`、`mode` | 从片子描述读的、入口自己传的 | 请求 |
| 镜头 | `languages`、`build`、`error`、`evaluations[].digest`、`scan` | 从入口文件和顺着引用一直追到的文件的扩展名认语言；原样的镜头输入 `open` 成功还是报错；同上；自己扫文件，每个镜头各扫各的，只扫和入口同目录的那些（见镜头契约 5.7），注释里、字符串里写到的引用语句不追 | 量的 |
| 镜头 | `sources`、`entities`、`omittable`、`metaEntities[]` 的 `names`、`omittedParts` | 元数据的 `source.renderer`；实体清单；实体清单里类别是 `part`、片子描述里没有角色的；元数据里的 | 自报 |
| 镜头 | `buildCalls`、`metaKeys`、`cardUses` | 观测点数的：`build` 跑了几次、`meta(f)` 交回过的键、`ctx.cards.use` 每次调用的 `as` 和 `runtimeKeys`（一次都没调是空数组；`paramKeys` 要卡的声明，夹具里没有卡，不写）。一次观测都没交出来、或者镜头没有入口文件时，三个都不写 | 旁观 |
| 镜头 | `ctx[].want` | 一次装上了的 `open` 一项，照那次传的镜头输入和 `env` 算：种子带锁取锁里的、不带锁取镜头条目的，帧率和画幅取镜头输入的 `output`，帧数是 `out` 减 `in`，`shotIn` 是镜头条目的 `in`；那次装载的档位生效的缩放不是 1 时不记画幅 | 请求 |
| 镜头 | `ctx[].seen` | 观测点在 `build` 收到的 `ctx` 上读到的五个值（`shotIn` 读的是 `ctx.shot.in`），取那次装载里第一次带观测的 `render` 交出来的；那次装载没有这样的 `render` 就没有这一项 | 旁观 |
| 镜头 | `patches` | 不写：没有来源 | — |
| 帧源 | `shot`、`scenePack`、`opens[]` 前六个字段（`host`、`mode` 是出帧用的那一套）和 `unfitInput`、`badArgs[]` 的 `call`、`arg`、`renders[]` 的 `shotFrame`、`want`、`shutterAngleDeg`、`shutterSamples`、`size`、`unsupportedOpts`、`unfitOutputs`、`shotColorRef`、`orderRuns[]` 的 `shotFrame`、`mode`、`queries[].kind`、`metaEntities[].shotFrame` | 入口自己传的、自己备的夹具的事实、从片子描述算的。`unfitInput` 照 three 帧源的说明填：卡、资产、叠加层它都还没接，镜头输入带着哪一样就记哪一样 | 请求 |
| 帧源 | `opens[]`、`renders[]`、`queries[]`、`badArgs[]` 的 `status`、`code`，`renders[]` 的 `meta`、`layers`，`layerRefs[]` 的 `output`、`fileHash`、`fileBytes`，`orderRuns[].digest`，`queries[]` 的 `total`、`returned` | 调用的结局（报的错不带错误码时 `code` 不写，原话记在出错清单里）、数交回的东西、读层文件重算；`total` 照自己问了几个实体算 | 量的 |
| 帧源 | `caps`、`manifest`、`layerRefs[]` 的 `shape`、`hash`、`metaShutterAngleDeg`、`colorRef`、`metaEntities[].entities`、`queries[].truncated` | 帧源交回的东西里原样抄 | 自报 |
| 帧源 | `colorTransfer`、`failures`、`textReadbacks` | 不写：要用灰阶场景量、要造渲染失败、要有文字框，这条链路没接 | — |
| 元数据 | `film`、`shot`、`fps`、`start`、`seed`、`source`、`call`、`shotFrame`、`tier` | 入口的：`film`、`fps` 取片子描述的 `id`、`output.fps`，`shot` 是请求的那个镜头条目的 `id`，都不从元数据抄；`seed` 取片子描述里镜头条目的（例子锁里记的是同一个数，测试盯着），`source` 是片子描述里镜头条目顶层写的帧源，`tier` 是那次 `open` 传的档位 | 请求 |
| 元数据 | `metas`、`metaBytes`、`colorFileHash`、`colorShape` | 数返回值；元数据不带缩进、末尾不带换行写成 JSON 的字节数（落盘的 `meta.json` 带缩进，不是量的这个数）；读层文件重算；颜色层文件的字节数等于层引用的 `shape` 三项之积乘 4 时记这个 `shape`，对不上不写 | 量的 |
| 元数据 | `metaFilm`、`metaShot`、`metaFps`、`metaFrame`、`metaShotFrame`、`metaSeed`、`metaSize`、`metaTier`、`metaSourceId`、`metaHashColor` | 元数据里原样抄 | 自报 |
| 事件 | `events` | 求值核展开的事件表，整份收进来 | 自报 |
| 事件 | `film` | 入口读的片子描述 | 请求 |

## 退出码 0 要过的门

- 每个对象（片子描述、例子锁、能力声明、事件表、镜头输入、每一份改过的镜头输入、实体清单、每份元数据、每个层引用、每份核对记录）结构合法、一条不违反。
- 每次 `open`、`render`、`query` 和参数出值域的调用，结局和打算的一样：该成功的成功，故意造的错报的是那个错误码。场景查询的期望照能力声明算：列了的种类各问一次、该给结果，再问一种没列的、该报不答这种查询。
- 能力声明里列了的每种场景查询、每种作者模式都验到了；哪一种没有夹具，打印「没验」，这道门不过。现在备了问法的查询只有 `bbox3d`。
- 每次出了颜色层的成功 `render` 在时间核对记录的 `frames` 里都有一项；每次交回元数据的 `render` 都记到了 `meta(f)` 收到的帧号。
- 同一帧的每一层在两个进程、几种渲法下逐位相同，元数据去掉 `timing` 之后相同；带着例子锁、镜头输入不写种子装载渲出的各层和不带锁的相同。
- 草稿档每一层都照能力声明的缩放出；每个层文件的字节数等于 `shape` 各项之积乘 4。
- 只要元数据的那次调用排在同一个会话里另一帧的整帧渲染后面，不交任何层；它交回的元数据去掉 `stats`、`hash`、`timing`（还有观测点自己记的那次调用里 `state` 的流水）之后，等于同一帧整帧渲染交回的元数据。
- 子帧采样数和要的一样；只求一个时刻的每次调用都落在要的时刻上。
- 镜头代码拿到的随机流名字对、序列和参考实现相同。
- 元数据的 `source.id` 是镜头条目顶层写的帧源，`source.renderer`、`source.host` 是出帧的那一套。
- `ctx.events` 里有镜头输入的每个命名事件；元数据的 `events` 正好是镜头输入里落在那一帧上的事件。
- 每个交付帧都量出了累积颜色层对预言图的差，也量出了编号层对预言图在边缘带之外对不上的像素数；量和比的过程没有出错。
- 编号层对照规格逐像素求交：主物体重心的差不超过规格的容差，并且编号不同的像素只许出现在边缘带里。编号经实体清单按名字查。
- 用编号层核对元数据：元数据里主物体的屏幕包围盒，对从编号层反算出的包围盒（它自己的编号加名字以它的名字加点号开头的实体的编号占的像素，取像素外沿），交并比不低于 0.95，就是帧源接口契约 5.3 的过线；主物体没被挡，合渲的编号层等于单独渲的（这个前提契约第 6 节登记了没人判）。这条链路量到的读数是 0.9628 到 0.9926，读数每次都打印、写进 `summary.json` 的 `metaBoxIou`。包围盒中心对编号层重心的距离不超过规格的容差那一道还留着，只当辅助。
- 深度层和求交的深度的相对差不超过规格给的容差；求交什么都没打到的像素编号 0、深度 1e10、法线 `(0, 0, 0)`。
- 真正累积出来的颜色层：拖影按线性亮度加权的重心，对快门中点那一刻的画面按自发光值加权的重心，差不超过规格的容差。
- 答案里点了名的 sub 不为 0 的时刻：只取一个子帧采样渲出的主物体重心对得上那一刻的求交。
- 规格点名的像素打到的物体和深度对得上；主物体重心处的法线朝着相机。

| 文件 | 管什么 |
|---|---|
| `run.mjs` | 入口 |
| `records.mjs` | 把观测整理成核对记录；只整理，不补数 |
| `scan.mjs` | 静态扫描：渲染路径里的墙钟和不带种子的随机。认直接写出来的调用，点号取和方括号里写字符串取成员都算；Python 的 `random` 模块和间接调用不认 |
| `compare.mjs` | 读层文件、求重心、照规格逐像素求交、量累积颜色层对线性平均预言图的差、从编号层反算包围盒和交并比 |
| `fixtures/film.json`、`fixtures/lock.json` | 最小片子描述；例子锁：照本机锁的写法手写（`issuer` 是 `local`，不写修订号、机器和镜像哈希，本机交不出这三样）；内建卡是照契约的例子填的示意值；全片种子照锁文件契约 5.7 由片子 `id` 派生，镜头种子和子帧采样数和片子描述一样。本机的锁生成器做出来以后换成它的输出 |
| `fixtures/calib-scene.js` | 照校准场景的规格搭镜头；镜头条目的 `params.offscreen` 列了名字时，每个名字在视场外另放一个小方块 |
| `fixtures/observe.js` | 观测点，和从 `readings` 里把观测读出来的函数 |
| `fixtures/<名字>.shot.js`、`fixtures/<名字>.scene.json` | 入口文件和它旁边的规格（从校准目录抄的相机、背景、物体，测试盯着两边一致） |

后面要在上面出帧的那几次 `open`（原样的镜头输入、带例子锁的、草稿档的）装不上时，入口当场停下，不写记录。

## 帧源注册与升级：七行报告

`run.mjs` 是三镜头的实渲入口；`suite.mjs` 是判定器，**读历史测量，不启动渲染器**。在仓库根目录看某一列：

```sh
node --input-type=module -e "import {loadProbeSuiteReport as load} from './beiming/kernel/conformance/suite.mjs'; const r = load('blender', {machine:'mac'}); console.table(r.rows); process.exitCode = r.ok ? 0 : 1"
```

`loadProbeSuiteReport(source, {machine, conformance, tableDir})` 支持 `three`、`blender`；机器默认 `mac`，合规档默认 `full`。先读[探针表](../../calib/table/README.md)，再读同帧源、同机器的 `fixtures/v4-<source>.<machine>.json` 补测法线与乱序。指定自备 `tableDir` 时，把探针列和补测 JSON 放在该目录，不借用内置补测。**缺测不是通过**：Linux 5090 两遍重渲的历史读数不能证明乱序或法线合规；没有该机补测时，这两行应为 `fail`。

Mac 补测走两个实际帧源的 `open` 和 `render`。Three 用页面宿主，Blender 用 Cycles CPU。预期法线由校准场景求交得到，固定在相机空间。每个帧源在三个静止端头球内部采 256 个像素，连续比较五个采样帧，共 1280 对向量；另起进程以 `[24,48,0,36,12]` 重排五帧，按帧号比较颜色和法线层的 SHA-256。两份实测的法线夹角中位数分别为 0.05224° 和 0.02611°，两层各自的乱序差异帧数均为 0。重新采集会更新对应的 Mac JSON：

```sh
node beiming/kernel/conformance/fixtures/v4-probe.mjs record three
node beiming/kernel/conformance/fixtures/v4-probe.mjs record blender
node beiming/kernel/conformance/fixtures/v4-probe.mjs check
```

最后一条命令只复核已有记录，可在没有渲染器的环境下运行。

新帧源直接调用 `evaluateSourceConformance({source, machine, conformance, determinism, readings, observations})`。结果总是按下表顺序列七行，有 `status`、`measured`（按指标名取值）、`threshold`（含端点的 `[下限, 上限]`，`null` 上限表示不限）；失败时另有 `reason`。`limited` 只免第 2–5 行，任一必测行缺数、错类型或越线均令 `ok: false`。

| 行 | `readings` 字段与口径 |
|---|---|
| `color-linearity` | `colorLinearityMaxRelErr` ≤ 0.02；零分量另量 `colorZeroMaxAbsErr` ≤ 0.005。取线性 RGB，不用显示码值。 |
| `depth` | `depthMedianRelErr` ≤ 0.02；取已知平面的相机前向深度（米），不是射线距离。 |
| `object-id-meta` | `objectIdMetaMinIou` ≥ 0.95；三个方块取单独渲的编号层。Blender 旧表没有单独渲 IoU，只取完全可见的前景主方块，不把被遮挡的可见部分与完整框硬比。 |
| `normal-space` | `normalMedianDeg` ≤ 2°；实测法线与同空间预期向量夹角的中位数。 |
| `camera-convention` | `cameraAnchorMaxPx` ≤ 1 px；取三轴及转台光栅化位置的最大误差，不用纯矩阵投影冒充读回。 |
| `shuffled-order` | 哈希档 `shuffledMaxDiff` = 0；容差档 `shuffledPsnrDb` ≥ 50 且 `shuffledFracAbove5` ≤ 0.001。 |
| `repeat-twice` | 同上，字段前缀为 `repeat`。5090 的 Blender 显卡列用容差档；其余三列用同机哈希档。 |

例如旧页面帧源只需提交三行的观测：

```js
const report = evaluateSourceConformance({ source: 'legacy-page', conformance: 'limited',
  determinism: 'hash-same-machine', readings: {
    colorLinearityMaxRelErr: 0.012, colorZeroMaxAbsErr: 0, shuffledMaxDiff: 0, repeatMaxDiff: 0,
  } });
```

也可传原始 `observations`，对应行优先重算而不信汇总：`normals` 为 `{expected, got}` 三维向量对；`sequential`、`shuffled`、`repeat` 是独立采集的帧记录数组，键为整数 `frame`。哈希档每帧带解码层数据的 SHA-256 `digest`。采集法线层时，每帧同时提供 `normalDigest`，任一层发生变化都会记为该帧不一致。容差档每帧带展平的 `rgb8` 三通道数组。按帧号配对，取各帧最低 PSNR 与最高大差像素比例（一个像素的任一通道差 **>5** 才计一次）。完全相同的像素在 JSON 报告中写 `'+Infinity'`。乱序至少两帧、帧集合相同且访问顺序确实改变；重复两遍不得代替乱序证据。

两次采集的进程与会话由调用方建立。Three 的历史表保留六个场景的两遍 SHA-256 比较结论，Blender 的历史表还保留用于比对的摘要对。文件加载器另核对补测的帧源版本、校准像素集合、相机空间方向和转台的实际帧序。

## 历史不变量：逐项做正负对照

`invariants.mjs` 的 `INVARIANTS` 按 `INV-01` 至 `INV-17` 登记。用 `makeValidInvariantFixture(id)` 看该项的输入形状；传入实际观测即可判定。`makeViolatingInvariantFixture(id)` 提供相同口径下的单故障反例。示例（不是对当前成片、CI 或机器的认证）：

```js
import { INVARIANTS, checkInvariant, makeValidInvariantFixture, makeViolatingInvariantFixture, runInvariantSuite } from './invariants.mjs';
const id = 'INV-04';
console.log(checkInvariant(id, makeViolatingInvariantFixture(id))); // ok: false，并给出失败原因
const cases = INVARIANTS.map(({ id }) => ({ id, fixture: makeValidInvariantFixture(id) }));
console.log(runInvariantSuite(cases)); // passed: 17, failed: 0
```

运行全部对照与原三镜头单测：`node --test 'beiming/kernel/conformance/*.test.mjs'`（不起浏览器）。
