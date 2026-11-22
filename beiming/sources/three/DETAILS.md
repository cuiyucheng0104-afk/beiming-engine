# sources/three/ 细则

`README.md` 放不下的几段：快门相位的实测，参数容器，二维讲解舞台，场景查询。

## 快门相位的实测

`s4.test.mjs`：实渲 `probe-moving-cube` 第 24 帧，180 度 8 个子帧，像素质心和解析位置差 < 0.5 px；用整帧位移（f=24 → 25）标定速度，拖影中点在 f + 0.25 附近，和 Blender START 读数一致。Metal `SUBPIXEL_BITS=4` 下用 0.25 帧短基线标定有约 0.02308 帧量化差。

## 参数容器

`opts`、`shutter` 只收纯数据的普通对象：`Date`、多一层原型的、带取值器的、带契约外的键的都不收（报 `usage.bad-argument`）；别的上下文（另一个页面、`vm`）造的普通对象照常收。

## 二维讲解舞台

`two-d.js` 的 `createTwoDStage(ctx, opts)`（页面一侧，镜头代码在 `build` 里调，交回 Promise，兑现出来就是镜头对象 `{ scene, camera, entities, state, meta, dispose }`，`build` 直接把它交回去就行）。它把二维画面的每个元素光栅化成一张贴图，贴到相机空间里一块按像素对齐的平面网格上：元素就是实体，宿主照常从网格顶点量 `bbox2d`、`bbox3d`、屏占，编号、深度、法线三个辅助层和场景查询照常出，契约和宿主都不用为二维开口子。

`opts`：`elements`（见下表，不空）；`background` 纸色，默认 `#F4F0E9`；`css` 排版用的样式；`fonts` 要锁定的字体 `[{ family, url, weight?, style? }]`（woff2）。

| 种类 | 声明 | 实体和矩形 | 逐帧 |
|---|---|---|---|
| `canvas2d` | `{ kind, name, rect, draw(c, tools), opacity? }` | 一个实体 `name`，矩形是 `rect` | 每个 `(f, sub)` 调一次 `draw` 重画。`c` 是二维上下文，原点在矩形左上角；`tools` 是 `{ f, sub, width, height, rect, text(id, 文字, x, y) }` |
| `svg` | `{ kind, name, rect, svg, opacity? }` | 一个实体 `name`，整张图拉满 `rect`。标记必须正好是一个 `<svg>`，里面不能再写 `data-entity`（报 `usage.bad-argument`）：要逐个图形当实体，把 `<svg>` 写进 `dom` 元素，矩形照样从排版结果量 | 只在装载时光栅化一次 |
| `dom` | `{ kind, html, opacity? }` | 这一层里每个带 `data-entity="实体名"` 的节点一个实体，矩形是它排版出来的 `getBoundingClientRect()` | 只在装载时光栅化一次 |

- 矩形 `[x0, y0, x1, y1]`：像素，原点在左上角，照 `ctx.size`（输出尺寸）写，可以带小数，必须整个在画面里。相机在原点朝 −Z、竖直视场角 40 度；第一个元素在 10 米外，后登记的每个近 1 毫米，同一块屏幕上后来的盖住先来的（`dom` 一层里按文档顺序）。`rectToPlane(rect, size, order)` 是这一步的纯函数。网格顶点是单精度：离画面中心 960 像素以内，量回来的 `bbox2d` 和矩形差不到万分之一像素（`dom` 的矩形先被排版对到 1/64 像素上）。档位带缩放时包围盒和文字框跟着这一帧的实际尺寸走。
- `svg` 和 `dom` 走同一条路：排进页面里一个看不见、和画幅同大的容器（真的浏览器排版，弹性布局、网格布局都算），整层序列化成 SVG 的 `foreignObject`、解码成图、裁到实体的矩形里。画一个实体（量一段文字也一样）时这一层只画它一个，改的是抄出来的一份、页面里排着版的那份不动：它的祖先藏起来（`visibility: hidden`，底色、边框、伪元素不画，排版、裁剪、不透明度照旧作用在它身上），其余的节点（不在它里面的每一个，和它里面别的实体连同子孙）逐个写上 `opacity: 0` 和 `visibility: hidden`，它里面归它的子孙各自写回页面里算出来的 `visibility`（不靠继承：被画的节点是 `display: contents` 时，它首行上的子元素会按排版上的父节点、也就是被藏的祖先的首行样式继承），都是带 `!important` 的行内样式。逐个写而不是只写在最外面那个上，是因为 `display: contents` 的节点自己不生成盒，写在它身上的不透明度管不到它的子孙和它直接带着的字。被隐去的节点的 `::before`、`::after`、`::marker` 一并藏起来；祖先的 `::first-letter`、`::first-line` 跟着那个字所在的节点走，首字母是被画的节点的照画、是祖先自己的不画（祖先样式表里给首字母、首行写的 `visibility` 不作数）。所以不在任何 `data-entity` 里的节点只参与排版、不画出来；嵌在别的实体里的实体各画各的；邻居怎么写（显式的 `visibility: visible`、带 `!important` 的样式、外面套几层 `display: contents`）墨迹都串不进来；伸出实体矩形的东西（阴影、行高比字形矮时的笔画）会被裁掉。
  看不看得见以浏览器最终合成出来的墨迹为准，不另立规矩，被样式藏起来的不会被翻成看得见：`display: none`、`opacity: 0` 的祖先底下合成出来没有墨迹（子节点显式写 `visibility: visible` 也一样），实体的 `visible` 是 0、文字不进 `texts`；`visibility: hidden` 的祖先底下显式写回 `visibility: visible` 的子节点照 CSS 是真的看得见，照画，实体的编号层和 `visible` 照算，它是文字的话照进 `texts`。
  `<defs>`、`<symbol>`、`<clipPath>`、`<mask>`、`<pattern>`、`<marker>`、渐变、`<filter>` 这些只给别处引用的节点和它们里面的不动，祖先被藏起来时裁剪路径、蒙版照样作数。被画的节点用 `<use>` 引用的图形要放在 `<defs>` 或 `<symbol>` 里，放在它外面别处的会跟着一起隐去。管不到的：祖先和 `display: contents` 节点上别的会生成内容的伪元素（`::scroll-button` 这类）；`visibility: collapse` 的节点原样不动。解码是异步的、`state` 是同步的，所以内容只在装载时定一次；要逐帧变内容用 `canvas2d`。
- `opacity(f, sub)` 交 `[0, 1]` 里的数，不写就是 1；`dom` 一层的全部实体共用一个。是 0 时这一组实体不画，并且停到画面右边两个画幅宽以外：不占编号层，量出来的 `bbox2d` 在画面外、屏占是 0，它们的文字不进 `texts`。不是 `[0, 1]` 里的数这一帧报 `contract.bad-value`。
- 空实体：光栅化出来一个像素都没有的实体（CSS 的 `opacity: 0`、`visibility: hidden`、没有底色也没有内容的容器、这一刻什么都没画的 `canvas2d`），和排版出来没有面积的实体（自己或祖先 `display: none`、宽或高是 0、自己是 `display: contents`（没有盒，它里面的内容哪儿都不画）；照常装载，不报错），和不透明度是 0 的一样处理，不画、停到画面外、不占编号层、`visible` 是 0，它上面的文字不进 `texts`。`canvas2d` 每个时刻重画之后重判一次。颜色层上没有的东西，编号层和元数据也不说它在。
- 文字框：`dom`、`svg` 里带 `data-text-id="id"` 的节点（必须在某个 `data-entity` 里面，`<svg>` 里的 `<text>` 也算），`text` 是它的文字（空白并成一个空格、去掉两头），`bbox2d` 是墨迹的外接矩形（只让这段文字看得见、光栅化一遍、数不透明度不低于 32/255 的像素），不是排版盒；只算落在它所属实体（最近的那个 `data-entity`）矩形里的墨迹，伸出去的画不出来。进不进 `texts` 只看有没有墨迹，节点自己的盒不作数：去找墨迹的那一块是它自己的盒并上它里面内容的盒（`Range` 量的）再往外 32 像素，所以 `display: contents` 的文字节点（自己没有盒）、盒宽是 0 的、字伸出盒的（不换行的窄盒）照交，框是完整的墨迹；自己 `visibility: hidden` 而子节点显式写回 `visibility: visible` 的也照交。不进的：空的、`display: none` 的（哪儿都没排）、所属实体是空实体的、没有墨迹的（被样式藏起来的、透明的）。`text` 取节点的全部文字，其中有几个字被样式藏着也照交整段。带底色的节点会把底色也算成墨迹，`data-text-id` 只挂在只有字的节点上。
- `canvas2d` 里调 `tools.text` 画的字，框取这一笔真的落在画布上的墨迹：画之前、画之后各读一遍字形盒（`measureText` 的实际包围盒过当前变换，外面多看 2 像素）那一块的像素，有一个通道差到 32 的才算。所以当前的变换、裁剪区、合成方式都算在内：画到画布外面的、被 `clip()` 整个裁掉的、和底色分不出来的字不进 `texts`，裁掉一部分的交留下来的那部分。框落在整数像素上。阴影不在字形盒里的部分不算。
- 遮挡：一段文字的墨迹被登记在它所属实体之后的实体整个盖住时，这一帧不进 `texts`。盖得住的只有这一刻画着、整组不透明度不低于 0.999 的实体里完全不透明（255）的像素；半透明的盖不住，只盖住一部分的照交、框不变。只看实体之间：同一个实体里叠在字上面的东西（同一个 `data-entity` 里的节点、同一张画布上后画的图形）不查，那样的字仍然会交。
- 颜色：贴图当 sRGB 解码到线性光，纸色同样；半透明在线性光里混合，抗锯齿的字边会比浏览器里直接看略细。
- 拒收边界：排版是在活动的页面里做的（那里拿得到外部资源、也会执行脚本），光栅化用的 SVG 图片文档才是浏览器不让联网的那一步，所以 `svg`、`html` 和 `css` 进页面之前先查，不过的报 `usage.bad-argument`。不收的：标签 `script`、`iframe`、`frame`、`frameset`、`object`、`embed`、`applet`、`foreignObject`、`link`、`meta`、`base`、`audio`、`video`、`template`、`portal`、`fencedframe`，SMIL 动画（`animate`、`set`、`animateMotion`、`animateTransform`）；`on` 打头的属性（值是空的、没写值的也算）；`href`（含 `xlink:href`）、`src`、`action`、`formaction`、`background`、`poster`、`data` 不是 `#` 打头的；`srcset`、`imagesrcset`、`ping`、`archive`、`attributionsrc`（一个属性里能写好几个地址，浏览器挑哪个要看屏幕密度）写什么都不收，全是 `#片段` 的、没写值的也不收；样式（`<style>`、`style` 属性、`fill` 这类呈现属性、`opts.css`）里不是 `url(#片段)` 的 `url(…)`、`@import`、`image-set(…)`、反斜杠转义；`&amp;` `&lt;` `&gt;` `&quot;` `&apos;` `&nbsp;` 以外的字符引用（别的字直接写，单独的 `&` 照收）。查两遍：整段扫一遍（`checkElements` 在 node 里只有这一遍；它不分上下文、宁可错拒，文字内容里出现 `url(`、`src=`、反斜杠这些写法也拒），页面里再用 `DOMParser` 落成惰性文档逐个节点查；挂进页面的就是这份查过的节点，原文不再解析第二遍。所以图片只能用 `canvas2d` 画或者内联成 SVG 图形，字体只能走 `fonts`。这道关挡的是外链和脚本，不查样式会不会把别的层弄乱、也不查 CSS 动画（内容只在装载时定一次，动画停在哪一刻不保证）。
- 字体：照 `fonts` 取回来内联进光栅化用的 SVG 文档，同时登记给页面（排版和 `canvas2d` 用）；地址只能是本机静态服务上的（别的源报 `usage.bad-argument`），宿主为此放行了 `fonts/` 下的 woff2。没声明 `fonts`，或者文字里有字体子集没有的字，浏览器会悄悄用这台机器的系统字体，换台机器字形就不一样；这里不查字体覆盖。
- 报错：声明不对（种类不认识、矩形不是四个有限的数、宽高不是正的、伸出画面、实体名写法不对或重复、缺 `draw`、`svg`、`html`，标记或样式过不了拒收边界、`svg` 里嵌了 `data-entity`）报 `usage.bad-argument`，在调用 `createTwoDStage` 时同步抛出（不带 `await` 的 `try`/`catch` 也接得住，这时页面一个节点都还没动），`checkElements(size, elements)` 是这一步的纯函数，它按下标逐槽查：`elements` 里的数组空槽（`Array(1)`、`[元素, ,]`）和访问器不收。`ctx.size` 不是两个正数、`opts` 不是对象、`fonts` 不是数组或哪一款的 `family`、`weight`、`style`、`url` 写法不对，也在这时同步抛。字体取不到或不在本机静态服务上，和排版之后才查得出的，经交回的 Promise 报；这时已经挂进页面的排版容器、登记给页面的字体、建好的网格和贴图都先撤掉，页面和调用之前一样（`dispose()` 撤的是同一批）。排版之后才查得出的（`data-entity` 重名或写法不对、排出来的矩形伸出画面、一层 `dom` 里没有实体、文字不在实体里、文字 id 重复）报 `contract.bad-value`。

样板镜头 `s3-18-1.shot.js`：考题 18-1 的三场讲解，1920×1080、30 帧每秒，每场一个 SVG 徽标、DOM 标题和卡片、整块更替的 DOM 字幕，第二场有 SVG 流程图，第三场有逐帧现画的 Canvas 2D 柱状图；每场开头留 9 帧、最后一块字幕在场尾前 11 帧收掉、场尾 4 帧淡出。字体用仓库锁定的子集 `fonts/NotoSansSC-var.woff2`，它只有几十个字，文案只能用这些字。旁白驱动的时间（`time.narration`）和字幕卡（`overlay.subs`）不在这个镜头里，帧号是写死的。

测试：`s3.test.mjs`。探针镜头 `s3-probe.shot.js` 照参数搭任意元素：三种元素同台，`bbox2d` 对真实像素框、编号层反算的外沿、贴图朝向和颜色、隐藏文字、草稿档、各种报错；藏起来的、被盖住的、被裁掉的内容逐项对颜色像素、编号像素、`visible`、`texts` 四处（说法要一致），其中有邻居显式写 `visibility: visible` 的叠放实体和并排文字、带底色和伪元素的外壳、`display: none` 的实体，邻居外面套普通包装和 `display: contents` 包装的两组对照、直接带字和伪元素的 `display: contents` 节点、祖先的 `::first-letter` 和 `::first-line`、祖先 `<defs>` 里的裁剪路径、`visibility: hidden` 和 `opacity: 0` 的祖先底下显式看得见的字；同一段字幕写成 `display: inline` 和 `display: contents` 两种的对照（盖住时都不进 `texts`、撤盖后交的一模一样），连同盒宽是 0 的、字伸出盒的、自己藏着而子节点看得见的、里面是两个隔开的子元素的文字；声明不对时 `createTwoDStage` 同步抛；探针在页面里把数组空槽、访问器、不对的 `ctx` 和 `opts`、取不到的字体、重名的实体各试装一遍，经 `readings` 交回「当场抛没抛、Promise 报的错误码、事后页面多出来的节点数和字体数」；拒收表在 node 里和页面里各过一遍；样板镜头实渲 16 帧：元数据和核对记录过 `beiming/kernel/contracts/validate.mjs`（M、F 各条），实体过 L2 的编号层交并比，文字框过 L2 的墨迹核对（8 像素；没有文字识别引擎，内容对字幕稿、位置对墨迹），纸色按 16 档色格占 75% 到 85%，淡出 4 帧单调，另开一个会话倒着求帧、颜色层哈希逐位相同。

## 场景查询

会话的 `query(f, q)`（帧源接口契约 3.7）。能力声明列了三种：`bbox3d`、`anchor`、`belowGround`。都在 `(f, sub = 0)` 上求值：渲染器先把这一刻写进场景，宿主再量；`render` 每次自己写状态，查询写的不会留到下一次调用里。坐标都是世界坐标，米，右手、Y 向上。算式在 `beiming/host/page/measure.js` 的 `answerQuery`，判参数在 `plan.mjs` 的 `planQuery`。

| 种类 | 每项的 `a` | `value`（`unit` 都是 `m`） | `at` |
|---|---|---|---|
| `bbox3d` | 实体名 | 包围盒的对角线长度 | `[minX, minY, minZ, maxX, maxY, maxZ]` |
| `anchor` | `实体名#锚点名` | 锚点到世界原点的距离 | 锚点的位置 `[x, y, z]` |
| `belowGround` | 实体名 | 最低顶点陷在地面以下多深（`−minY`） | 最低的那个顶点 `[x, minY, z]` |

- 包围盒和最低点取实体全部网格顶点的世界坐标，和元数据的 `bbox3d` 是同一批顶点；没有几何的实体报错（不带错误码）。实例网格（`InstancedMesh`）每个实例各算一遍：对象的世界矩阵乘上那个实例的矩阵；一个实例都没有（`count` 是 0）就没有顶点，名下再没有别的几何时同样报没有几何。蒙皮和变形目标的形变不算。
- 锚点和这一帧元数据里的是同一份来源：镜头的 `meta(f)` 交的，加各张卡交的；只交挂在 `of` 配上的实体上的。查询要的是世界坐标，不投到屏幕：落在相机平面上的锚点元数据交不出（那一帧的 `render` 报错），查询照答。只看问到的实体上的锚点：它们写法不对、交了两次、坐标不是三个有限的数（缺一项的、带空位的 `[0, , -3]` 也算，判法是 `measure.js` 的 `isXyz`），报 `contract.bad-value`（是镜头或卡交错了）；合格的坐标照判过的三个下标抄成普通数组，不走数组的迭代器（迭代器只交前两项的 `Array` 子类实例，三个下标是 `0, 1, -3`，交回的 `at` 还是 `[0, 1, -3]`）；没问到的实体上的锚点写坏了不牵连这一次查询。卡把锚点挂到不是它自己带进来的实体上，和元数据一样报错（不带错误码），问谁都报。
- `belowGround`：地面是 `y = 0`，容差 `tol` 没写是 0；只有 `minY < −tol`（严格小于）的实体才出现在结果里。贴着地面的实体会因为单精度顶点带出 1e-9 米量级的负数，要滤掉就给一个小的 `tol`。
- `of` 的每一项是实体名或「前缀.*」（契约 5.5）：`kit.*` 配名字以 `kit.` 开头的全部实体，不含 `kit` 自己；一个都没配上交回空的 `items`，不报错。写了的实体名这个镜头里没有，报 `usage.bad-argument`。配上的实体去重。
- 「最严重」（契约 5.7 没定排法，这里定的）：`value` 大的在前，一样大的按 `a` 的 UTF-8 字节序（实现上按码点比，两个次序相同；不是 JS 字符串 `<` 的 UTF-16 码元序，那样 U+10000 起的字符会排到 U+E000 前面）；不管截没截断都这样排。超过 50 项只留前 50 项，`truncated` 写截掉了几项；没超过不出现 `truncated`（F9）。`bbox3d` 里一样大的方块，对角线会差在浮点的末位上，它们之间的先后不要当成按名字排。
- `against` 这三种查询都不用：写了照样判写法（至少一项、实体要有），不参与求值。`tol` 对 `bbox3d`、`anchor` 同样只判不用。

报错的先后：

1. `f` 不是整数、是负数、不小于镜头帧数：`usage.bad-argument`（F23），哪怕查询本身也有问题。
2. 查询不是普通对象，或者 `kind` 不是字符串：`usage.bad-argument`。
3. `kind` 不在能力声明里（`intersect`、`contact`，或者契约里没有的名字）：`contract.unsupported-query`（F8）。错对象的 `next` 是替代办法，每项 `{ verb, why }`，和 API 错误信封的 `next` 同一个写法（`verb` 是「方法 /v1/路径」，`{id}` 是片子工作区的编号，帧源不知道、留着占位），所以原样过得了 `beiming/api/envelope.mjs` 的 `fail`（字符串会被它整项滤掉）。`intersect`、`contact` 给两项：先是 `POST /v1/films/{id}/observe/query`，用 `bbox3d` 取两边的包围盒自己判相交（只是近似）；再是 `PUT /v1/films/{id}/film`，把镜头的帧源换成声明了它的（登记表里 `blender`、`core` 的上限含这两种；现在答不答以那个帧源的 `caps().sceneQuery` 为准，写这一段时 `blender` 还一种都没声明）。别的名字给一项：只问声明过的三种。
4. 别的写法不对（多了契约外的键、键是取值器或在原型上、`of` 或 `against` 是空的或有一项不合写法、数组的元素不是自有的可枚举数据属性（索引上的取值器、从原型继承来的元素、稀疏的洞、多出来的键；判的时候只读属性描述，取值器一次都不执行）、`tol` 是负数、非数、无穷、显式 `null` 或者不是数）：`usage.bad-argument`。契约第 6 节这几种还没定报什么，这里先都报这个码。

测试：`s7.test.mjs`。实渲 `probe-plane-steps`、`probe-axes-turntable`（第 0、12、24 帧，转台转过的角度不同）和一个 62 个实体、其中 60 个陷在地面以下的夹具（探针镜头 `s7-probe.shot.js`）；`planQuery`、`answerQuery` 另有不起浏览器的两条。一致性套件 `beiming/kernel/conformance/run.mjs` 把三种各问一次、问一次 `intersect`、把 `query` 的帧号传出值域一次。
