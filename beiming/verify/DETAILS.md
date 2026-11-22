# Welch 检验细则

[README.md](README.md) 的补充：`welch.mjs` 的数值口径、通道选择、校准实测、已知误报漏报和输入校验边界。接口与输出结构看 README。文末另有 `controllability.mjs` 两项回归作业（局部性、加锁重建）的细则。

## 做法与数值口径

- **做法**：三通道先取线性亮度，按 `blockSize × blockSize` 求块均值（尾块按实际像素数平均），每个单元算两边的均值和无偏方差，做 Welch t 检验（Welch–Satterthwaite 自由度，双侧 p 值），再对参检单元做 Benjamini–Hochberg 校正。
- **数值口径**：块均值与偏差图均对精确商作单次最近偶数舍入：块均值是「块内像素的精确和除以像素数」这个有理数的最近双精度数，每个单元的 `biasMap` 是「两边 2K 个带符号样本的精确和除以 K」的最近双精度数（两边共有的大数先精确相消）。不先把和舍入成 53 位再除，所以 3、5 个像素的尾块、不是 2 的幂的 K、商落进次正规区时都不多舍一次，`[5.25, 6×2^-52, 0]` 对 `[5.25, 9×2^-52, 0]` 这样只差 1 个末位的块均值不会被并成相等。块均值只取决于这批像素的多重集：同一批像素怎么排列都得逐位相同的均值，`[-2^54, 2^54, 100]` 对 `[-2^54, 2^54, 101]` 这种大数相消后才露出来的差也照常检出。判据按实现的顺序：先看 `maxAbs × n < 2^1023`，满足就用 Shewchuk 精确求和（同 Python 的 `math.fsum`）算出 `sum`；`sum === 0` 时对任意除数直接返回 0；和不为 0 时，只有除数是 2 的幂且 `abs(sum) >= divisor × 2^-1021` 才走只移指数的快速路径；其余（含 `maxAbs × n >= 2^1023`）保留整数余数作单次最近偶数舍入（BigInt 整数除法）。两条路算的是同一个精确商，后者慢：640×360、K=16 实测 3×3 块约 1.4 秒（8×8 块约 0.14 秒），K=5 逐像素约 0.87 秒（K=16 约 0.61 秒）。方差不用边读边更新的算法：每组先减去组内最小值，再按离差的量级除掉一个 2 的幂后中心化、平方、精确求和，所以 `1` 与 `1 + 2^-52` 这样只差 1 个末位的样本方差不会被舍成 0，同一组种子换个次序 p 值逐位相同。自由度按两边方差之比算。样本整体乘同一个正数（1e-250 到 1e250 都测过）p 值不变，乘的是 2 的幂时逐位不变。贴近双精度上限、几个数相加就溢出的块和单元也走 BigInt，结果与常规路径是同一个函数；两边符号相反又都贴近 1.8e308、均值差不可表示时 `biasMap` 记 `±Infinity`，检验照常出结果。分辨率的下限是双精度本身：两个精确均值的相对差小于 2^-52（或差值小于最小次正规数）时可能落到同一个双精度数上，这样的单元算相等；t 的绝对值超过约 1e154（平方溢出）时 p 记 0。全高清三通道 K=16 逐像素约 5 秒、8×8 块约 1.5 秒（Darwin arm64、Node 24 实测）。

## 通道与结果

- **取哪个通道**：EXR 有 `color.R/G/B` 就取它，没有才取裸 `R/G/B`，再没有就要求只有一个浮点通道；其余情况（比如只有 `normal.X/Y/Z`）不猜，抛错，要检就用 `channel` 给通道名。`channel` 给序号时只检颜色的那一个通道。两边解析出的形态要一致，一边三通道亮度、一边单通道会抛错。
- **结果**：`biasMap`（A 减 B 的均值差，偏差位置图）、`pMap`、`qMap`、`significantMask`（都是 `gridSize` 宽高的行主序平面）、`significantRatio`（校正后显著的单元比例）、`rawSignificantRatio`（未校正 p ≤ alpha 的比例）、`pHistogram`（`counts` 是 `bins` 个等宽桶的计数，`flat` 是平坦性判定，`lowTailP` 是判定用的 p 值，`effectiveAlpha` 是判定用的名义率）。`pass` 等于 `significantRatio <= alpha && pHistogram.flat`，两个条件缺一不可。
- **`testedUnits` 与 `totalUnits`**：`totalUnits` 是网格单元总数，`testedUnits` 是参检单元数，差值是 `deterministicUnits`。两个比例、直方图和 BH 校正的分母都是 `testedUnits`。
- **无噪声单元**：两边方差都是 0 且均值相等的单元（纯黑背景）记入 `deterministicUnits`，不参检，平面里 p 和 q 记 1；方差都是 0 而均值不等的单元 p 记 0，参检并必然显著。全图都不参检时 `pass` 为真，这只说明两组各统计单元样本逐位相等（块模式下指块聚合后的统计单元）。

## 平坦性判定与校准实测

- **平坦性只判小 p 端**：有偏会让小 p 变多。`flat` 检的是 p ≤ alpha 的单元数有没有显著超过 `effectiveAlpha × testedUnits`（单侧二项精确检验，`lowTailP < histogramAlpha` 判不平坦，缺省 0.001）。p 偏向 1 不判不过，代价是两边误用同一批种子时也判过，这时 `counts` 全堆在最后一桶，`rawSignificantRatio` 为 0。
- **名义率的余量**：`effectiveAlpha = max(alpha, min(0.25, alpha × (1 + 0.5 / max(2, K - 1))))`：余量最多把名义率抬到 0.25，`alpha` 本身大于 0.25 时就用 `alpha`；K 为 16 时是 0.05167。t 检验只在高斯噪声下精确，噪声非高斯时小 p 的比例会偏离 alpha，全高清有两百万个单元，千分之几的偏离也显著，不留余量同一渲染器换种子就会判不过。下表是 1920×1080 逐像素、同分布两组、alpha 0.05 的实测（每格两次）：

  | 每像素噪声 | K=16 | K=8 | K=4 |
  |---|---|---|---|
  | 高斯 | 0.0498、0.0499 | 0.0480、0.0481 | 0.0411、0.0413 |
  | 均匀 | 0.0503、0.0504 | 0.0500、0.0499 | 0.0456、0.0459 |
  | 两点（各半取 0 或 1） | 0.0502、0.0502 | **0.0769、0.0768** | 没测 |
  | 一成概率的亮点 | 0.0285、0.0287 | 0.0057、0.0057 | 没测 |
  | 余量后的名义率 | 0.0517 | 0.0536 | 0.0583 |

- **已知的误报与漏报**（都是上表同一套实测）：
  - K 小而噪声离散时会误报：K=8 的两点噪声小 p 比例约 0.077，同一渲染器换种子也判不过。每像素只有几种取值的低采样画面用 K=16，或者按 8×8 块检（块均值接近高斯）。
  - 余量会吃掉逐像素的检出力：每像素噪声标准差是均值两成的高斯噪声下，一边乘 1.01 的逐像素小 p 比例是 0.0515，低于 0.0517，逐像素判过；同一组数据按 8×8 块是 0.192，判不过。噪声大时用块做门。
  - 二项检验假设单元之间独立。3×3 盒式像素滤波下实测比例是 0.0494 到 0.0499，没有误报；更宽的滤波核没测，相关会让计数的波动大于二项分布，遇到贴线的不平坦先换成不小于滤波核的块再看。

## 用法建议

- **下游怎么用**（V19 等对拍条目）：门只看 `pass`。不过时先看 `significantRatio` 和 `biasMap` 定位，再看 `pHistogram.counts` 区分「少数单元强偏」和「整体轻微偏」。报告里同时写 `testedUnits` 和 `totalUnits`，`testedUnits` 远小于 `totalUnits` 时结论只覆盖带噪区域；`rawSignificantRatio` 为 0 且末桶堆满，先查两边是不是用了同一批种子。
- **选粒度**：逐像素能定位到像素，但噪声大、分布重尾时检出力很低；像素间噪声独立时 8×8 块把标准差压到八分之一，日常门用块，定位时再看逐像素。单元数少于 `1 / alpha` 时一个假阳性就让比例超过 alpha，这种小图的误报率约等于 alpha。

## 限制与输入校验

- **限制**：亮度检验看不到亮度相抵的纯色偏，要查色偏时按 `channel: 0`、`1`、`2` 各跑一次。样本含 NaN 或无穷（帧对象查 `data` 的全部分量，含当前 `channel` 没用到的通道，抛 `RangeError`；EXR 只查参与计算的通道，深度层的无穷不算错）、`data` 不是 TypedArray 或普通数组、普通数组里有不是 number 的元素（`null`、字符串、布尔，抛 `TypeError`，不做隐式转换）、尺寸不一致、种子组或 `data`、p 值数组含空洞（稀疏数组，抛 `TypeError`，先于个数与长度检查，所以 `new Array(1)` 也报空洞；普通数组的每个元素只读一次并拷成快照，读取中途被 getter 删项同样抛 `TypeError`，改了长度抛 `RangeError`；种子组分两段读：入口先记下两边的长度和每个槽位的属性描述符（不触发元素 getter），普通数据槽位的帧就此定下，带 getter 的槽位等读完 `options` 再各读一次；种子数够不够、相不相等都按入口长度判（稠密的 0 个、1 个与两边不等都抛 `RangeError`），再解析全部帧。入口长度是函数调用入口第一步、读 `options` 之前各读一次的 `length`，须是原始的非负安全整数：`Array` 的 Proxy 让 `length` 返回对象、字符串、负数或小数一律抛 `TypeError`，`data` 与 p 值数组的 `length` 同理；之后的平面数、统计轮数和自由度都只认这一个数，返回的 `kA`、`kB` 恒等于它。每读一个 `options` 属性、每读一个带 getter 的槽位、每解析完一帧各复查一次原种子组，长度变了或槽位被换成别的帧抛 `RangeError`、槽位是空洞或被删抛 `TypeError`，复查只比长度和槽位描述符、不再读元素，所以 `options` 或 A 的 getter 把 B 从 4 帧缩成 3 帧、`alpha` 把 B 缩成 2 帧而 `blockSize` 再补回 3 帧、不改长度原地把 B 的某一帧换掉、或帧的 `data` 与像素 getter 回头改种子组，都在统计前被拒；读一次就把自己改写成数据属性的惰性 getter 也算被换，要惰性加载就传路径。帧对象本身（`data` 里的数）在调用期间被别处改写不在防护范围内）、`options` 不是普通对象、`alpha` 不是 (0, 1) 内的数、`bins` 超过 10000 时抛错。两边全部帧先解析、校验完才开始统计，任何一帧不合格都不会算出半截结果；代价是 2K 个平面同时在内存里（每单元 8 字节）。`studentTwoSidedP` 在自由度大于 1e7（含无穷）时按正态算；`benjaminiHochberg` 只收 [0, 1] 内的数字。

## 可控与可复现回归（controllability.mjs）

04 §12 看板「可控与可复现」栏的两项作业。两项都先让片子描述过 `film/3.0` 契约，交给渲染器的是副本，不改调用方的片子描述、补丁和锁。片子描述、补丁、锁在入口各存一份快照（`structuredClone`），之后的校验、每一遍渲染和报告的 `filmId`、`rev` 都只认快照：作业进行中调用方改了原对象（比如第一遍开渲后把锁换成下一个修订号），后一遍用的仍是入口核过的那一份；带着函数之类存不成快照的值抛 `TypeError`，渲染器一次都不调。片子描述的修订号（补丁入口记在对象上的）也在入口读一次。

### 帧对象与帧对比较

- **帧对象**：`{ frame, width, height, color, channels?, shot? }`。`color` 收 `Uint8Array`、`Uint8ClampedArray`（按 ÷255 归一）、`Float32Array`、`Float64Array` 与数的数组（按 [0, 1] 标尺直接比）；`channels` 只收 1、3、4，不写时照长度推。渲染器交回全片 `[0, output.frames)` 每帧正好一幅：缺帧、重复抛 `Error`，帧号越界抛 `RangeError`，没交数组抛 `TypeError`。
- **`compareFramePair(a, b, { diffLevel = P8_DIFF_LEVEL })`** 回冻结的 `{ identical, sha256A, sha256B, mse, psnrDb, maxAbsDiff, gt5Pixels, totalPixels, fracGt5 }`。`identical` 看颜色层字节的 SHA-256，所以 +0 与 −0 算不同；`mse` 对全部分量求平均，`psnrDb = 10 × log10(1 / mse)`，`mse` 是 0 时为 `Infinity`。平方和在原始刻度上累加、最后归一一次：8 位帧累加的是整数，`mse = sumSq / (分量数 × 65025)`，和 P8（`kernel/conformance/suite.mjs`）同一个算式，100 × 120 的 RGB8 帧 23409 个分量差 1 级恰好是 50 dB，不会算成 49.99999999999771；判线用原值，不舍入（49.996 dB 不过）。一个像素任一通道差严格大于 `diffLevel` 算一个超差像素，`fracGt5 = gt5Pixels / (width × height)`。
- **坏输入抛错**：不是帧对象、`color` 类型不收、数组有空洞或非数的元素、两边数组类型不同抛 `TypeError`；宽高不是正整数、通道数或长度不对、两边尺寸不一致、分量是 NaN 或无穷、`diffLevel` 为负抛 `RangeError`。
- **P8 口径**：`P8_PSNR_MIN_DB = 50`、`P8_MAX_DIFF_FRAC = 0.001`、`P8_DIFF_LEVEL = 5 / 255`。容差档一帧在线内，要 `psnrDb >= psnrMinDb` 且 `fracGt5 <= maxDiffFrac`，三个门限都能在两项作业的参数里改。

### 局部性回归 runLocalityTest

参数 `{ film, patch, renderFilm, explainContext = {}, tier = 'hash', allowNoOp = false, psnrMinDb, maxDiffFrac, diffLevel }`。

- **补丁**：`patch/0.1`，经 `applyFilmWrite` 作用；片子描述没带修订号时按补丁自己的 `rev` 对。作用不上抛错（消息以「补丁作用不上」开头），改了总帧数抛 `RangeError`。
- **预测**：补丁每个操作的路径（`rename` 另加新路径）在改动前、改动后的片子描述上各问一次 `explainParam`，问到的取并集（新加的键改动前问不到，删掉的键改动后问不到；两边都问不到就抛错）。一帧算在范围里要同时满足：帧号落在某条预测的半开区间 `frameRange` 里、它所在的镜头在那条预测的 `shots` 里（`style/view/scene` 这类预测区间会跨过没受影响的镜头，按镜头表收紧）、帧上标了 `shot` 时标的镜头也在里面。
- **渲染**：`renderFilm(片子描述, { phase: 'before' | 'after' })` 各调一次，可以是异步的。改动前那一遍交回后、后一遍开渲前，每帧当场另存（帧对象浅拷贝，像素是独立副本、数组类型不变）：帧源复用同一块工作缓冲区或同一批帧对象、后一遍原地覆写，泄漏帧照样比得出来。
- **算不算变了**：`hash`、`hash-same-machine` 看字节，差一个末位也算；`tolerance` 只把超出 P8 口径的差算成变化。
- **判定**：有变化帧在范围外，`reason` 是 `leaked-outside-affects`；一帧都没变是 `no-frames-changed`（不理参数的空壳渲染器过不了；确实不该变时给 `allowNoOp: true`）；否则 `ok`。
- **报告**（深冻结）：`{ format: 'locality-regression/0.1', pass, reason, filmId, tier, gate: { psnrMinDb, maxDiffFrac, diffLevel }, allowNoOp, paths, predicted: { shots, frameRanges, frameCount }, totalFrames, changedFrames, leakedFrames, unchangedOutsideCount }`。`changedFrames`、`leakedFrames` 是全片帧号的升序数组，`frameRanges` 是按镜头表收紧后的预测区间（每条预测和它点名的每个镜头取交集），并起来正好是 `frameCount` 帧。04 §3.5 样例把 `shots/s01/cards/cam/params/margin` 从 0.9 改成 0.82：预测 `shots: ['s01']`、`frameRanges: [[0, 180]]`，`[180, 300)` 变一帧就不过。

### 加锁重建回归 runRebuildTest

参数 `{ film, lock, renderLocked, tier = 'hash-same-machine', allowPartialLock = false, psnrMinDb, maxDiffFrac, diffLevel }`。

- **开渲之前就拒**（渲染器一次都不调）：缺锁、锁不是 `lock/1.0` 或不合锁文件契约、片子描述带着修订号（补丁入口交回的）而和 `lock.rev` 不同；再照出锁时那套跨文件核对查一遍锁和片子描述：`lock-check/0.1` 的全部不变量（`kernel/contracts/lock/check.mjs`）加片子描述一侧的 D3，片号、种子（LK3，锁里镜头种子 7802 改成 7803 就拒）、镜头表、卡、帧源、模版、查找表、资产对不上都拒，消息带不变量编号。
- **`allowPartialLock: true`**：只放过「锁里没有这一项」的违反（LK1、LK4、LK8、LK9、LK10、D3 里报缺项的那几句）；锁里写了却对不上的（模版或卡的主版本、帧源的宿主、卡的 `from`，同样是这几个规则码）照样在开渲前拒收，片号、种子、镜头表照查。资产的版本写在键名 `asset:<名>@<版本>` 里，上游 D3 只查整个键：片子要 `asset:rtx-card@3`、锁里钉的是 `asset:rtx-card@4` 时它报的和没钉是同一句，这里另查，锁里有同名的别的版本就按对不上拒收（消息写明两个键），整个名字都没钉才放过；报告的 `lockCheck` 记 `partial`（全过记 `full`）。一致性夹具的锁只钉了帧源，要给这个开关。
- **渲染**：`renderLocked(片子描述, 锁, { run: 1 | 2 })` 调两次，每次交回帧数组，或 `{ frames, deliverables }`（`deliverables` 是「文件名 → 哈希字符串」）。两遍必须各自重渲：同一帧两遍交回同一块缓冲区直接抛错。第一遍的帧和 `deliverables` 表在第二遍开渲前当场另存，第二遍原地覆写工作缓冲区或改同一张表也瞒不过。
- **判定**：哈希档有帧不逐位相同是 `frames-differ`，帧都相同而 `deliverables` 有键不同（多一键、少一键、值不同）是 `deliverable-mismatch`；容差档有帧超出 P8 口径是 `outside-tolerance`，不比 `deliverables`（编码件在容差档本来就不要求逐位相同）。
- **报告**（深冻结）：`{ format: 'rebuild-regression/0.1', pass, reason, filmId, rev, tier, gate: { psnrMinDb, maxDiffFrac, diffLevel }, lockCheck, totalFrames, identicalFrames, failedFrames, mismatchedDeliverables, worstPsnrDb, worstFracGt5 }`。`rev` 是锁的修订号，锁没写时为 `null`；`worstPsnrDb` 是各帧里最低的，全片零差时为 `Infinity`。

### 看板行

- **`buildControllabilityRow({ filmId, recordedAt, jobId = null, film = null, l2PassRate = null, locality = null, rebuild = null, legacyNightlyPass = null })`** 回深冻结的 `controllability-row/0.1`：`locality` 是 `{ pass, reason, tier, gate, pathCount, paths, totalFrames, predictedFrames, changedFrames, leakedFrames, leakedSample }`（`changedFrames`、`leakedFrames` 是帧数），`rebuild` 是 `{ pass, reason, tier, gate, lockCheck, rev, totalFrames, identicalFrames, failedFrames, failedSample, worstPsnrDb, worstFracGt5 }`（`failedFrames` 是帧数；无穷大的 PSNR 记 `null`，整行可直接写成 JSON），没给的项是 `null`。
- **体积上界**：逐帧明细不进这一行，只留总数和样例。`paths` 留首尾各 4 条、每条截到 96 个字符，总数在 `pathCount`；`leakedSample`、`failedSample` 留首尾各 3 个帧号；`filmId`、`jobId` 各不超过 128 个字符。一行不超过 8192 字节。
- **不轻信报告**：帧表、计数、读数、门限照两项作业的判定规则重算一遍，和报告写的 `pass`、`reason` 对不上就拒收。各个数组都要是实心的（没有空洞、没有多出来的自有属性），路径、镜头、交付件名不空不重复。局部性：帧号表要是 `[0, totalFrames)` 里严格升序的整数，泄漏帧都在变化帧里，变化帧不在预测区间里的必须记成泄漏，范围里变了的帧不多于 `predicted.frameCount`，预测区间不出全片、并起来盖住的帧数正好是 `frameCount`，`frameCount > 0` 时 `predicted.shots` 不空，`unchangedOutsideCount` 和总帧数对得上。重建：`totalFrames ≥ 1`，`0 ≤ identicalFrames ≤ totalFrames`；哈希档不过的帧数正好是不相同的帧数；全片逐位相同时 `worstPsnrDb` 必须是 `Infinity`、`worstFracGt5` 是 0；容差档有没有不过的帧要和最差读数过不过门限一致；`worstFracGt5` 在 [0, 1] 内。
- **两份报告互核**：`locality`、`rebuild` 都给了，两边的 `totalFrames` 要相同（300 帧配 301 帧拒收），不带 `film` 也查。
- **带着片子描述核**（`film`，可不给）：给了就要合 `film/3.0` 契约、`film.id` 等于 `filmId`、`output.frames` 等于两份报告的 `totalFrames`，并照镜头表核 `predicted`：点名的镜头都在表里、每个都有预测帧落在里面，每条预测区间都落在点名的镜头里。04 §3.5 样例里 s01 是 `[0, 180)`、s02 是 `[180, 300)`：区间 `[[0, 180]]` 配 `['s01']` 收，配 `['s02']` 拒。不给 `film` 时报告里没有镜头边界，这一项查不了。补丁改了镜头号或切点的报告，预测是照改动前后两张镜头表并起来的，和单独一张表对不上，不要带 `film`。
- **`overallPass`**：给了的项全过才是 `true`，`l2PassRate` 要正好是 1，`legacyNightlyPass` 不是 `false`；容差档的门限调得比 P8 松（`psnrMinDb` 低于 50、`maxDiffFrac` 高于 0.001 或 `diffLevel` 高于 5/255）的，作业自己判过也不给绿，行里留着实际用的门限。
- **拒收**：抛的错都带 `code: 'usage.bad-argument'`。两份报告一项都没给、`filmId` 和报告或 `film` 的片号不同、报告自相矛盾、报告和 `film` 的总帧数或镜头表对不上抛 `Error`；`recordedAt` 不是带时区的 ISO 8601 时刻、`l2PassRate` 不在 [0, 1]、`filmId` 或 `jobId` 超长、`jobId` 是空串抛 `RangeError`；参数不是对象、报告结构不对（`predicted.frameRanges` 里有不是二元整数数组的项在内）、`film` 不是 `film/3.0`、`jobId` 不是字符串、`legacyNightlyPass` 不是布尔抛 `TypeError`。
- **`appendControllabilityRow(filePath, row)`**：追加一行 JSON（目录不在就建），交回这一行。只收 `buildControllabilityRow` 交回的行，手拼的、读回来改过的抛 `TypeError`。并发追加逐行完整：同一个进程里按规范化的目标路径（目录过 `realpath`，经符号链接的另一种写法算同一个文件）排队；别的进程靠锁文件 `<目标>.lock`（独占创建，写完就删）挡，等锁最多 30 秒，握锁的进程死了留下、超过 10 秒的旧锁清掉再写；每行又是一次不超过 8192 字节的追加写。

### 实渲核验

测试 V14-9 用页面宿主（`beiming/host/page`）把一致性校准片裁成两个镜头实渲：改 s01 的快门角只变 `[0, 3)`，改 s02 的背景只变 `[3, 6)`；加锁重渲每遍新起一个帧源进程（裁出来的锁只钉了帧源，带 `allowPartialLock`），6 帧逐位相同；串扰与第二遍动过参数的负对照都判红。本机没有无头浏览器（二进制不存在）时这一条跳过，别的启动错误照常算失败。
