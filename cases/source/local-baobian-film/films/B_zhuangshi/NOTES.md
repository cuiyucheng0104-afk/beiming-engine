# 《豹变》B 装饰版 · 搭建笔记（NOTES.md）

- 角色：搭建（Builder），只管 `films/B_zhuangshi/`。依据 `DESIGN.md`（定稿）与 `assets/manifest.json`。
- 日期：2026-11-04。门禁：`_work/gate/GATE.md` 全部 PASS（返修第 3 轮后复跑：G4 中位 33 ms/帧；G3、G5 全部通过）。返修记录见第九节（第 1 轮）、第十节（第 2 轮）、第十一节（第 3 轮）。
- 证据：门禁静帧 `_work/gate/main/sheet.jpg`；五轮整片静帧 `_work/stills/r1`、`r2`、`r3`（0.5 秒一张）、`r4`、`r5`（0.25 秒一张，`sheet_a/b/c.jpg`）；相邻帧 `_work/stills/flick/`；与参考并排 `_work/stills/cmp/`。全部在 5090 上渲。
- 未验证：整片视频（`finish.sh` 属渲染角色）没有渲；配乐对位只按帧号核对，没有放片听。

## 一、文件

| 文件 | 内容 |
|---|---|
| `index.html` | importmap（three 0.170 + addons）、`main.js` |
| `main.js` | 渲染器、look.js 后期、时间轴分派（按 f 选场景）、门户、叠加层、DOM 字幕与片尾纸白、`DUR / render / READY / TEXTS` |
| `lib.js` | K 缩放、缓动、帧号工具、GLSL 公共件（PCG 哈希、值噪声、文斑距离场、化开遮罩）、着色器卡片、2D 精灵（分区形变 + 水平剪切（fix3）+ alpha 重截边 + 深度遮罩层） |
| `overlay.js` | 叠加层 O：三层斜雨（可慢放）、地平金线、金环（杏仁 → 圆、金 → 墨）、水珠 / 墨滴、皇冠溅、雨打水花、浮尘、闪（四角星 + 中心圆 + 细环 + 光晕）、斜亮带、暖色小光点 |
| `leo.js` | 豹精灵：线 / 身 / 特征色按「图里线色—身白」混合线段重分（fix1）、白身换色（灰 → 奶金径向擦除）、18 枚文斑的五个状态（湿墨斑 / 晕开 / 收紧 / 点亮 / 环斑；fix3：其余 17 枚从湿墨斑轮廓起晕开）、眨眼、落墨溅点 |
| `room.js` | 场景 R：书桌、线装书（画布贴图：版框、界行、伪字、鱼尾、撕口、木刻豹）、䷰、砚笔纸、镊子、眼镜、窗光 gobo（窗棂 + 柳叶）、T1 的 8 段金条（CPU 逐帧弯曲；fix3：先散开、再定曲率、后沿圆周生长，全程同心）、火舌环、日盘 + 虹膜门户、S6 的墙 / 窗墙 / 越肩背影 / 补书的手 |
| `cliff.js` | 场景 Y：天幕、七日、六道叠晕远脊、四条雾带 + S4d 雾带、鹿群、崖与洞底板、3D 虬松（渐细管 + 松针扇 + fix2 加的 3D 根）、前缘崖面卡片（fix2：手绘崖面 LEDGE_FS，3D 长石 / 巨石停用；fix3：本体换成 A20 手绘崖面贴图，下沿入雾、圆钝岩角、悬挑下一簇钟乳）、平台地面、陆蔚坐背、灰豹、S4a 的手 |
| `market.js` | 场景 M / K：集市底板、幡、人头剪影（fix3：幞头 + 飘带 / 展脚官帽 / 盔 + 缨 / 高髻 + 簪四种头饰、斜肩立领；脸侧金面具边）、假光轮、3D 金面具（弯面 + alphaTest 镂空 + 受光金边 + 扫光 + 眼孔金边）、摊主握杆的手、S3b 的手、S3c 背影与冷雾墙、S3d 眼孔门户 |
| `sky.js` | 场景 S / H：天（晴空 → 深靛 → 绢，化开）、真光轮（金日 + 三环头光）、卷云（云海顶、后云团、前景云墙 L1/L2、残云）、长卷（三排灰紫叠晕山 + 三条云堤）、S5a 山顶（fix1 起改为叠晕山 SDF 卡片，3D 山顶石停用）、坐 / 起跳 / 伸展三姿、墨影、墨点弧与三枚大墨印；豹头（#9 用 A05，T2 用 fix2 派生的 A05x2 两倍图） |
| `s6.js` | S6 机位、P_g 推算、人身上的光斑（日影 → 豹纹）、右镜片卡片（fix3：补全整圈镜框 + 镜片 + 反光）与绕镜片一圈的金线 |
| `audio.json` | `{"offset": 0}`（锁死截取起点，帧号全部按这条配乐） |

## 二、画风参数

- **色阶**：3D 道具 2 阶（step1 0.50 / 羽化 0.02，step2 0.12）；崖石、松干 3 阶（0.58 / 0.34，羽化 0.025–0.03）；山顶石"叠晕 4 带 + 2 阶光照"（法线钩子按面向相机程度分带，外亮内暗、层间硬边）；所有 toon 材质 `rimAmt 0`、不开阴影、`NoToneMapping`。2D 角色完全平涂，不加明暗。
- **交界软硬**：toon 交界羽化 0.02–0.03（硬）；叠晕山、卷云的层间按 fwidth 截边（卷云另加 0.012 微羽化）；雾带上沿软。
- **描线**：3D 物件走 look.js 描线（修复室 #2B2622 2.0、雾崖 #1E3444 1.6、集市 #3A1A10 2.4 且沸腾 12 fps、天空 #2E2A33 1.4；除集市外 boilFps 0）；S1 前 62 帧线不透明度 0.55，戴上眼镜后到 1.0。角色线画在精灵图里（豹赭褐 #6E5340、人深赭墨 #2E2420），放大 >1.2 倍时按亮度等值线重新截边，S4b 2.15 倍特写背线仍干净。远山、云、日、雾不勾墨线；岩石只有同色深一档的断续层缘线和竖向挂笔。
- **留白**：S2 天与雾约占 55%（地平线 y 520）；S5a 天约 50%；S5c 绢天约 55%；S6 右上暗墙留给字幕。
- **纸纹 / 颗粒 / 剥落**：look paper（`_lib/paper.png`，强度 0.08–0.12，scale = K）；颗粒 0.25（逐帧，胶片颗粒）；剥落只在天幕、绢天、S6 墙（fbm 阈值块，提亮 18–25% 向 #E8DDC6），不上角色、光轮、环斑、字幕。
- **调色板**：按 DESIGN 第二节。现实段暖土（墙 #D9C48F、桌 #8C5A3A、书页 #EFE6CF、墨 #2B2622）；T1 金 #D9A93F / 胭脂日 #951E41 / 火舌 #B88B5E→#F2DEC4；雾崖冷青灰（天 #BCD9DE→#E3EFEB、六脊 fix1 起改灰绿 #D2DDCC→#7F9A82、七日 #C2553A→#D0CDCA 递淡）；集市朱砂金（#B5402A、#E2B93B、琉璃绿）；豹变后奶金 #EEDFB0 + 七色环斑（石青 #4995C6 起）；卷云 #213E77 / #1A52A0 / #0B68C4、深靛 #1B2238；长卷绢（fix1 起压暗一档 #D6C08E→#C29C64）、山 fix1 起改 ref_00 灰紫三排（#AE959F / #857581 / #5E5760，4 层硬边叠晕）、云堤 #F2EEE4 + 下沿硬边影带 #A3B7A8。

## 三、每段怎么做的

| 段 | 帧 | 做法 |
|---|---|---|
| S1 修复室 | [0,81) | 陆蔚主观俯拍 60°、50 mm 缓推。书页是 2048×2900 的画布贴图（伪字只用短横短竖，不封口成字）；䷰ 由页面着色器画（离纸后留 25% 印痕 + 爻影）。手是平贴书页的精灵（抬起时才转向镜头），指尖三枚"墨渍态"文斑，食指尖那枚 rot −18°，f36–f44 落在 A=(1188,592)（实测 ≈(1190,590)）。f32 镊子松手落桌回弹；f52 捏镜腿，眼镜按屏幕关键帧升向镜头、镜腿展开，f62 右镜框处一闪 + 斜 35° 亮带；f66 出画；暖色光点滑到卦心。窗光 gobo（窗棂 + 三条柳枝的鱼骨叶）同一套用于 S6。手、眼镜一拍二。 |
| T1 光轮入书 | [81,139) | 六爻自下而上离纸、翻面（墨面翻下金面翻上）、升到光轮平面；初九拉成 2 m 地平线（f106 换屏幕金线 y=520）；九三、九四、九五弯成全环，六二、上六各两段先平面内转 90° 再弯成半环、整体再转 90° 把缺口转到 3/9 点；f106 锁轮（1.04→1.00）+ 金箔扫光 + 上六外缘 28 舌火舌生长；光点胀成胭脂日 + 细粉环。f116 起日心开虹膜，孔里是场景 Y 的实时渲染（门户），俯冲按对数线性逼近，f139 日面在屏幕上约 1244 px，盖满。8 段金条各占一层高度，交叉处不打架。 |
| S2 南山雾崖 | [139,260) | 85 mm 平视长焦舞台构图，f139–f163 接住冲势，之后右移 0.25 m。底板 A17 + 3D 虬松 + 3D 前缘长石 / 巨石（层纹、竖向挂笔、苔点）+ 六道叠晕远脊卡片 + 四条雾带（深度不同、各自漂）+ 叠加层三层斜雨。七日串行沿二次贝塞尔弧滑过，一个比一个淡；第七日 f250–f258 被雾吞在 P7。鹿群右→左（位移偶数帧更新、两张走姿每 6 帧换），第 3 只停步抬头。灰豹只呼吸、眨眼两次、抖耳、尾慢摆；18 枚湿墨斑（深墨、流痕、湿亮点）。白金闪峰 f141；金线 f139–f150 淡出、最远脊线金边 f170 前褪回雾色。 |
| S3 面具集市 | [260,343) | 四刀踩鼓。S3a 横掠：底板 A16 + 幡 + 无五官人头剪影（脸侧一线金面具边）+ 朱砂金假光轮（36 舌躁动）+ 3D 金面具（椭球弯面、alphaTest 镂空、受光金边、扫光）被握杆的手直冲到画心。S3b 沾墨的手抬起、悬停、一蜷、落下（手背金光渐强）。S3c 客观镜头：面具在左前景被裁掉一半，背影走进升起的冷雾墙，底板与幡撤景、去饱和。S3d 相机对准左眼孔对数逼近，假光轮缩回、眼孔金边亮起，眼孔后的门户卡片显示场景 Y（S4a 机位、含雨）。 |
| S4 豹变 | [343,496)（fix1：S4a–c [343,470)、S4d [470,496)） | S4a：叠加层金环由眼孔形缩成圆、移到 A、由金变墨，f351 落进食指尖墨渍；雨冲淡墨渍、水珠长大，f360 脱落，相机随降（pedestal，墨滴始终在 A），屏息里雨慢放到 0.15 倍。S4b：f374 落背皇冠溅 → 晕开（中段最快，对 16.11 s 最大涌起）带树枝状须边与咖啡环 → 收紧成四瓣月牙环 → 顺时针点亮成石青 → 一粒白闪；精灵放大约 2.15 倍。S4c（fix1 起 [430,470)）：后拉到中景，其余 17 枚分 4 组依次晕开收紧点亮（各带小闪），身色从环 0 径向擦除成奶金，f452 抬头，雨渐停，f462–f470 完整的豹静 8 帧。S4d（fix1 起 [470,496)）：与 S2 同构图，三条扇贝云头雾带从中线左右拉开、下沉淡出（不再是整幅矩形雾幕），谷雾下沉，天转晴、远脊变清，第七日在 P7 亮成金日 + 三环头光，最后几枚环斑点亮完、18 枚依次闪，f486 换坐姿。 |
| S5 一跃·逍遥 | [496,646) | S5a 徽记：坐豹嵌在金日 + 三环头光中央，3D 山顶石（叠晕），云海顶；金光扫斑、屏息四步蓄势、f520 换起跳 + 三个墨影。S5b：相机按 P(t−0.12 s) 跟拍（豹二拍、镜头一拍），天由晴转深靛，金月在豹后；两堵四排卷云墙从上缘压下、盖满（f536–f542）、豹冲出（f543）、再一层（f567）。S5c：天、云、山、云堤用同一张化开遮罩由右向左"化"成绢上青绿长卷；墨点每 4 帧一枚固定在世界里，f606/f612/f618 三枚大墨印金心一闪。#8、#9 两刀推近（切前 2 帧 103% 的顿）。 |
| T2 匹配剪辑 | [646,658) | A05 豹头大特写，原画眼睛保留、代码画的高光点在 P_g；f652–f658 高光长成闪（L 0→600）、bloom 0.45→1.60、曝光 +0.6 EV。 |
| S6 回现实 | [658,720) | 越右肩 3/4 背后、40 mm，闪光里后拉 8% 后静止。同一张桌、同一套窗光（加了左侧窗墙）。人身上先压一档树荫，叶隙日影是软边椭圆，f670–f674 一齐变成"光斑态"文斑排成豹纹（第一枚在右肩 A，其余按距离延迟、轻微过冲），墙和桌上的光斑一直不规则。双手一拍二补书。字幕马善政楷书竖排两列（自右向左），f676 起逐字淡入、f696 全显，29.55–29.95 s 与画面一起化入纸白 #F2EDE0。 |

## 四、转场

- **T1 卦爻 → 光轮 + 地平线 → 门户**：每帧先用 look.js 把场景 Y（S2 机位）渲到 `rtPortal`，雨叠加层也画进去（只在门里下雨）；日盘着色器在虹膜半径内按屏幕坐标取样，sRGB 转回线性再输出；外层调色 f116–f139 过渡到中性，门户盖满时与 S2 第一帧不跳色。地平金线 y=520 与 S2 最远脊线对齐，f139 起化成脊线金边再褪回雾色。
- **S3d → S4a 眼孔**：面具 alphaTest 镂空、眼孔后 3 cm 一块写深度的门户卡片（场景 Y 在 S4a 机位，含雨）；假光轮缩进面具、眼孔金边亮起；f343 起只渲场景 Y，叠加层金环接着缩成指尖墨渍（"金退回去、墨留下来"）。
- **T2 豹眼一闪 → 镜片一闪**：两边调用同一个 `glint()`、同一个点 P_g、同一个长度 600·K、同样的 bloom；f658 直切，只有底下的画面换了。实测两边十字交点 (1016,330) / (1019,328) 相差 3 px。
- 其余：f260 第一刀踩低频进入；S3 四刀踩鼓；f462 特写拉开 → 同构图全景；f496 切徽记；f543/f567 云墙盖满又让开；f567–f586 化开成绢；f624/f635/f646 三刀推近。

## 五、配乐对位（offset 0，配乐时间 = 画面时间）

f141 白金闪峰 = 5.867 s；f260 第一刀 = 10.860；f279 / f308 / f331 鼓点切；f343 穿眼孔 = 14.302；f351 金环落进墨渍 = 14.617；f374 墨落豹背 = 15.605；f383–f390 晕开最快对 16.11 最大涌起；f470 S4c → S4d 切点、雾散 = 19.58–19.60（fix1：原 f462 的切点后移 8 帧，S4c 最后 8 帧给完整的豹）；f520 起跳 = 21.661；f543 破第一层云 = 22.604；f567 破第二层 = 23.616；f606 / f612 / f618 三枚大墨印 = 25.233 / 25.497 / 25.741；f658 眼 → 镜片 = 27.413（全片最强）；f670 光斑成豹纹 = 27.922；f676 字幕起、f696 = 29.000 全显；f709–f719 化入纸白。`audio.json` 写 `{"offset": 0}`，防止配乐重出后锚点漂移。

## 六、与定稿的偏差（都写在这里，评审可以按需追回）

1. **P_g**：按 A09 的实测锚点，以 A 为准摆越肩背影后，镜片外缘闪点落在 (1016,330)，不是 (1040,410)；T2 豹眼高光同步放在这一点（A09 备注已预告此调整），匹配剪辑成立。
2. **豹斑半径**：manifest 的斑半径（0.0266 m）在 S2 全景里只有 10 px 左右，读不出"文"，全片统一 ×1.15。
3. **S1 的手**：精灵平贴书页（朝相机的面片会插进页面、下半截被页面吃掉），抬手捏镜腿时再逐步转向镜头。
4. **T2 的眼睛**：原计划全部代码重画；实际保留 A05 原画的眼睛（更像九色鹿），只叠代码高光点。
5. **S4d 雾幕**：在设计的"前雾、崖后雾左右分开"之外，加了一整幅从中线拉开的雾幕，让"第七天雾散"一眼看懂。
6. **S4 平台地面**：加了一块与底板平台同色的地面卡片（只在 S4 近景出现），底板放大 2.5 倍后平台太软，豹脚下会露空。
7. **S5b 云墙**：按屏幕关键帧移动（而不是固定在世界里），保证"盖满 → 冲出"正好落在 f536–f543、f561–f567。云墙是四排错落的云头，没有平的云体。
8. **#8**：85 mm 下中、近排山会被放大成大块，只留远排山与两条云堤。
9. **S6**：越肩背影与补书的手按顺序叠放（不和 3D 桌面做深度测试，否则手被桌面切出直边）；袖子按图像最后一列延伸出画。
10. **集市假光轮**：半径 0.24 m（设计 0.34 m），否则面具被光轮吃掉。
11. **S6 书与手**（w3，v3-04）：机位、P_g、A 不动；书在 S6 里挪到世界 (0.24, 0, 0.0)、转 36.5° 正对他，右页 ䷰ 整个露在执笔手右边、左页木刻豹在笔尖旁露出一部分；双手缩到 0.86 倍。**笔尖落在左页靠书口一侧，没有落在右页上**：手精灵的手掌在笔尖右上方约 210 × 260 px，笔尖一放到右页就会把 ䷰ 和撕口整个盖住；取舍是保住 ䷰（和 S1 最强的呼应）。撕口被归位的小纸片盖着，S6 里看不出。

## 七、自查记录（渲 → 看 → 改，五轮）

- **第一轮**（`t01–t03`、`r1`）：搭通管线（5090 每帧约 35 ms）。修：手精灵插进页面；手的墨渍太小；gobo 太花；火舌太粗；地面空、前缘长石发灰发亮像塑料；湿墨斑太浅；晕开边缘像齿轮；雾带中线空缺；松针盘太密；S6 光斑看不出；S5 卷云像平面贴纸；长卷山排挤在一起；山顶石成矮柱。
- **第二轮**（`r1b`、`r2`）：S6 加窗墙、人身上改成"树荫 + 叶隙日影"；岩石改竖向挂笔；卷云改受光顶偏心叠晕 + 深色旋涡缝；云墙改三 / 四排云头；面具眼孔门户写深度（之前被身后假光轮盖住）；落墨溅点移到晕外；人头剪影金边只露脸侧。
- **第三轮**（`r3`、`r3a–c`）：S5b 云墙按屏幕关键帧扫过、同一个日贯穿 S5；S5b → S5c 改为同一张遮罩"化开"；眼镜改屏幕关键帧路径；远脊卡片加高（雾散后不露下沿）；门户内层先设自己的主光；环心改透出奶金；指尖墨渍加重。
- **第四轮**（`r4`、`r4a–d`、`flick`）：金条分层防打架；平台地面改成石面；S4d 续完最后几枚点亮与擦除；化开改成自右向左；加 S4d 雾幕；手与眼镜、面具改一拍二；山顶石与巨石合并顶点后再算法线（之前是低模面片）；卷云微羽化、旋涡缝向里收细；相邻帧来回跳像素检测：静止镜头（S6）0.008%，其余只是细线随推镜移动，没有闪烁。
- **第五轮**（`r5`、`r5b–c`、`pg`）：发现两处跨帧状态（S4d 改过第七日的颜色、S6 改过修复室相机焦段，乱序渲染会不同）并修掉，乱序与顺序渲染同一时刻差 0.000；S1 因此回到设计的 50 mm；眼镜镜腿改成向内折；T2 漂移终点对齐 P_g；门禁复跑全部 PASS。

## 八、已知不足（返修第 1 轮之后；第 2 轮之后见第十节末，第 3 轮之后见第十一节末）

- P2：S2 的橄榄 / 苔黄色族只有约 3.7%（S4d 约 6%），没到评审要的 ≥ 15%：雾和天（规定不动）占了画面一半，远脊和底板受光处已经往灰绿、橄榄推过一档。
- P2：陆蔚的画法只做了线加粗（着色器膨胀），头发的扇贝卷边和衣褶数量是资产里画死的，没有重出 A07–A09。
- P2：集市底板 A16 仍是生图，只用 Kuwahara 0.8 / 饱和 0.85 / 天空喷绘渐变压过；没有按 ref_07 重出。
- P2：S5b→S5c 化开期间相邻帧平均差约 13–20，和 S5b 跟拍本身的相邻帧差（约 16）同量级；斑块跳变已经没有，剩下的是镜头在高对比卷云上平移造成的。
- P3：S4d f486 蹲 → 坐仍是硬换图；T1 f94–f102 金条弯曲途中仍有交叉（金环收细后不显乱）；S6 镜片外框弧（story-12）没做；S2 闭眼的眼睑线是一笔直线。

## 九、返修记录（第 1 轮，2026-11-04）

全部在 5090 上渲图、Read 亲眼核对。整片接触印样：`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_final/sheet.jpg`（0.5 秒一张）。门禁：`@@CASE_ROOT@@/films/B_zhuangshi/_work/gate/GATE.md` 全部 PASS。
中间渲图：`fix1_a`（第一轮改完）→ `fix1_b`、`fix1_c`、`fix1_d`（逐项复核）→ `fix1_e`、`fix1_f`（色板复测）→ `fix1_g`（反应、S4c、匹配剪辑）→ `fix1_adj`（化开相邻帧）→ `fix1_full1`、`fix1_final`（整片）。旧资产与旧 manifest 备份在 `_work/asset_attempts/pre_fix1/`。

### 资产（Magpie 重出，先设定图后姿态）

- A00 `leo_sheet.png`：新幼豹设定图（大圆头、短方吻 + 胡须点、小圆耳在头顶、耳内赭黄 + 深棕耳缘、琥珀眼黑瞳、泪线、额颊实心小墨点、粗长尾尖三道深环、四肢粗壮；白身无影无斑）。参考 ref_00_c / ref_02 / ref_06_c / ref_01_c。
- A01–A04（蹲 / 坐 / 起跳 / 伸展）：都以新 A00 为第一参考；透明底 `alpha_tool.py clean --harden 40,215` 后半透明 0.9–1.5%、偏暗（线色），无白边、无孤岛。A05 头像第一次出图颈部有透明大洞（半透明 28%、14 个孤岛），按"同样失败换思路"改提示词（整块实底、颈部出画）重出一次通过（半透明 2.1%）。
- 锚点：`_work/fix1/leo_anchors2.py` 重量（脊线、18 斑位、眼、鼻尖、足底轴心、重心、尾根、头颈 / 耳 / 呼吸 / 尾形变区），叠图 `@@CASE_ROOT@@/films/B_zhuangshi/_work/fix1/anchors/anchors_all.jpg`；`_work/fix1/update_manifest_leo.py` 写进 manifest（含 `colors.body_srgb / line_srgb` 给着色器分线身）。A05 眼锚点 = 琥珀虹膜块，高光点取图里瞳孔上的白点。
- A16 `market_plate.png`：左下人群里那颗白色四角星用周围袍子的绿补掉（只改这一处，原图备份在 pre_fix1）。

### 逐条

| 编号 | 级 | 结果 | 怎么改的 | 证据 |
|---|---|---|---|---|
| main-01 / story-01 / style-03 | P1 | 已修 | 按幼豹重定造型并重出 A00–A05（见上）；S2 契约改为 x≈470–1030、着地线 y 790；豹头特写线在 T2 向内腐蚀 1.6 图像像素、线色混成 #7D5732 的 80% | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_final/s_7.50.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_final/s_26.50.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_b/s_27.0.jpg` |
| main-02 | P1 | 已修 | S4a 随降时同时沿 A 的视线后拉到 d = 2.0：墨滴落背那一刻是看得见耳、头、肩、背的中近景，S4b 晕开时再推到 d ≈ 1.0（耳朵留在右上角）；晕开改柔和毛细洇边；收紧放慢到 f398–f420；湿墨斑改一整团墨，和亮色环斑分开；去掉小水滴尾巴；环 0 在墨滴落下前不存在 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_a/s_15.62.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_b/s_16.5.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_b/s_17.9.jpg` |
| style-01 | P1 | 已修 | 须边频率 5.4 → 18 + 44 两层、阈值 0.40、幅度 0.18 / 0.06（圆周上取样，无接缝）；浓度 mix(1.0, .90, u)、gran 0.95–1.05；外缘干墨边 0.65；环心改硬边平涂蛤白圆（±0.02R）。f386 墨团中心实测 #484848（目标 ≤ #4A4B4D） | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_e/s_16.083.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_b/s_16.5.jpg` |
| style-02 / tech-15 | P1 / P3 | 已修 | 湿墨斑：缺口 [10°,3°,3°,3°]、瓣与心都填墨（心 α0.60、瓣 / 干墨边 0.40–0.55）、外面一圈淡洇；删掉白高光点和三角流痕（主会话 main-02 要求去掉） | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_c/s_7.5.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_b/s_16.5.jpg` |
| style-04 | P1 | 已修 | 按风险 #16 降级：三排山换 ref_00 灰紫（远 #AE959F、中 #857581、近 #5E5760），峰高 170–420、半宽 120–240、指数 1.4–2.2，带肩峰，去掉三角峰；4 层硬边叠晕（层顶一线亮、逐层 ×0.84，核 ×0.30–0.55）；云堤上部平涂 #F2EEE4、下沿 11–14 px 硬边影带；绢丝纹 ±6%、S5c paper 0.09 → 0.04；绢天压暗一档。复测深色（L<80）19.0%（25.0 s）、22.8%（25.5 s） | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_full1/s_25.00.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_full1/s_25.50.jpg` |
| style-05 | P1 | 已修 | 云头压扁到约 1.8:1；叠晕改成沿轮廓的窄带（外缘暗 → 亮带 → 中 → 大云头再一道亮带 → 暗核）；旋涡改成卷进核里的亮带；云墙垫深靛实底（云隙 #1B2238）。复测暗部（L<80）72.6% | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_c/s_22.5.jpg` |
| style-06 / tech-11 / tech-12 | P1 / P2 / P3 | 已修 | 长石去掉顶面压平、前缘沿 z 圆滑下弯，向下加厚到出画（崖壁落进雾海，画面下缘不再从垂滴之间漏亮天）；颜色换底板实测 #6C878E / #5A707A / #475B6D，down 压暗 0.88，挂笔 0.36 + 0.25·down、每列长短 0.3–1.0；巨石细分 14 级、顶面从 y 0.2 平滑压到 0.7；前雾加长、下沿 α 0.86 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_c/s_7.5.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_final/s_20.50.jpg` |
| style-07 | P1 | 已修（降级） | 按 ⑤ 降级：3D 山顶石停用，换成和长卷同一套的叠晕山 SDF 卡片（主峰圆顶、顶上压出一小块坐台，两侧矮峰），外亮内暗、层间硬边 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_e/s_21.0.jpg` |
| tech-01 / story-02 | P1 / P2 | 已修 | 门户打开后屏幕金线只画在虹膜之外（叠加层按虹膜屏幕半径遮罩），虹膜里由场景 Y 最远一道脊的金边接力（同宽 5 px）；f139 起不再画屏幕金线；最远脊脊顶压到 y 516–524 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_d/s_5.5.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_d/s_5.75.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_d/s_6.0.jpg` |
| tech-02 | P1 | 已修 | S5b–S5c 豹的位移改一拍一（P(f) 连续）、俯仰也用连续 f，只有姿态与起伏走一拍二。实测三连帧豹包围盒左缘 22.083/22.125/22.167 s：553/551/553；25.0/25.042/25.083 s：619/619/615（原来 ±27 / ±45 px 跳） | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_d/s_22.083.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_d/s_25.042.jpg` |
| style-08 / tech-03 | P2 | 已修 | 线 / 身按「线色—身白」混合线段重分：落在线段上的像素按覆盖率混成 线色 ↔ 身色，离线段 > 0.09–0.15 的才算特征色保留原色 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_b/s_16.5.jpg`（背线）、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_c/s_7.5.jpg`（腿根线） |
| style-09 / tech-06 | P2 | 已修 | 火舌 28 → 44 舌、根→身→尖平滑过渡，后面叠一排更长更浅的火舌；3/9 点钟缺口两侧舌长平滑收到 0、舌根圆帽；抗锯齿改用连续量（世界坐标导数），火舌 / 日盘不挡线；胭脂日铺满光轮内径（R 0.0485），金环收细到 0.0034 m，读成日轮 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_b/s_4.5.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_b/s_5.0.jpg` |
| style-10 / main-03 | P2 | 已修 | 松针改成扇形针簇（深靛扇心、只有梢头亮 #6FA3A0、18–30 根、长短 0.66–0.98、扇宽高 1.3:0.75），每簇一排叠压约 40% 再加一排错开的 3 把；松干 dabAmt 0.6、4 个疙瘩、半径起伏 ±25%、颜色压暗一档 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_c/s_7.5.jpg` |
| style-11 / self-02 | P2 | 部分修 | 面具材质色 ×(0.93,0.87,0.72) 再去饱和 15%（金 ≈ #D3A245）；假光轮去掉 ×1.25、平滑配色、连续量抗锯齿；集市 Kuwahara 0.8 / farRadius 3.0、底板饱和 0.85、天空区叠杏 → 淡紫喷绘渐变 α0.35。A16 没有重出 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_c/s_12.0.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_final/s_11.00.jpg` |
| style-12 / tech-07 / story-06 | P2 | 已修 | 去掉整幅矩形雾幕，换三条前后错开的雾带（α 0.40 / 0.52 / 0.60，扇贝云头上沿、羽化 60 px，雾色比天亮 #EEF4EE），从中线向两侧拉开、分开处是 fbm 云头边、下沉淡出；被雾盖住时松干 / 巨石 / 长石的描线按雾浓度淡掉；云头鼓包不再被卡片上缘截平 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_c/s_19.6.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_c/s_19.75.jpg` |
| style-13 | P2 | 已修 | 头光环间过渡 ±0.07R、由内向外 α 0.85 → 0.35、总 α 约 0.6；S5a 推近到 z 3.6 → 3.45，坐豹高约 0.75 日径、头顶出日轮约 30 px、豹身居中 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_e/s_21.0.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_final/s_20.50.jpg` |
| style-14 | P2 | 部分修 | 陆蔚三个精灵在着色器里做线膨胀（S2 2.2、S3c 1.6、S6 1.0 图像像素）；头发扇贝卷边、衣褶数没改（要重出 A07–A09） | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_final/s_29.00.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_e/s_13.5.jpg` |
| style-15 / story-10 | P2 | 已修 | 人整个压在暖色树荫里（col×(.80,.73,.60)），叶隙光改暖黄加色（约 #FFF0BC，略带 HDR）、外缘一线亮边、一点柔光；大小 ±15%、角度 ±10°、位置错开 ±10 px；第一枚在 A 先亮 2 帧再向外成形；成形后随叶影摆 ±7 px、亮度 ±8% 轻闪 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_c/s_29.0.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_final/s_28.50.jpg` |
| style-16 / self-01 | P2 | 已修 | gobo 半影 0.002–0.006 m（两档硬边）；书桌交界羽化 0.008、木纹两档 + 细木纹线 #7A4A2E；书桌、封面、书页、书口加 1.0 描线（α0.8）；器物（镊子、砚、笔、纸叠）改两档平涂 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_final/s_1.50.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_final/s_0.00.jpg` |
| style-17 | P2 | 部分修 | 平台地面往 #A7B49E / #BAC4A6 偏；岩石受光面加 #979672 苔黄干笔；底板受光层顶往橄榄推（R ×1.55、B ×0.62，斑块状）；六道远脊改灰绿（#D2DDCC…#7F9A82）；最暗色 #3A5254（巨石背光）。复测橄榄色族（色相 50–125°）S2 3.7%、S4d 6.1%，没到 15%（雾色、天色按要求不动） | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_f/s_7.5.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_f/s_20.2.jpg` |
| style-18 | P2 | 已修 | 绢天压暗一档（#D6C08E / #CDAE78 / #C29C64），豹贴着远山上沿飞。实测豹身亮度 223、身后远山 129、豹旁绢天 176（差 47） | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_d/s_25.0.jpg` |
| style-19 / tech-04 | P2 | 已修 | 新 A05 的眼是干净的琥珀虹膜 + 黑瞳；T2 眼框内线与特征色保留原画（不换线色、不腐蚀），身色照常换（没有白圈） | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_b/s_27.0.jpg` |
| style-20 / story-08 / tech-10 / self-03 | P2 | 已修（tech-10 数值部分） | 化开改成一道横向干笔刷边自右向左推（干笔纹横向拉长约 7 倍、边宽 ±38 px、ss 缓入缓出），天、卷云、山、云堤共用同一张遮罩；时长 19 → 28 帧（f567–f595）。不再有一块块跳出的孤岛；相邻帧平均差 13–20，和 S5b 跟拍本身（约 16）同量级 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_adj/sheet.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_a/s_24.0.jpg` |
| style-21 / story-03 / self-04 | P3 / P2 | 已修 | 指尖墨渍从指甲面挪到指甲后面的皮肤上（沿手指方向往里 3.4 个半径），半径 ×1.35，改湿墨：不规则洇边、外圈干墨边、顺手指往掌心拖一道干笔蹭痕；只有 A 点那枚内部隐约是四瓣环（rot −18°）；S1 f36–f46 手亮一档；S3b、S4a 同一套 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_c/s_1.5.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_d/s_12.0.jpg` |
| style-22 / story-05 | P3 / P2 | 已修 | S4c 延到 f470：其余 17 枚分 4 组（4/4/4/5）在 f430 / f436 / f442 / f448 起、组内相隔 1 帧，每枚 晕开 4 → 收紧 4 → 点亮 2 帧；晕开上限 1.12R；第一组在特写里亮、后三组在后拉后的中景里亮；身色擦除 f432–f456；f462–f470 完整的豹静 8 帧再切 S4d | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_g/s_18.3.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_g/s_19.25.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_final/s_19.50.jpg` |
| style-23 | P3 | 已修 | S4 特写里底板高饱和蓝苔点压成平涂小色点（uFlatMoss） | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_b/s_16.5.jpg` |
| story-04 / story-11 / self-05 | P2 / P3 | 已修 | 鹿放大到约 85 px、暖赭身色（#AD8A5C 左右）、深棕线，放在谷雾 2 与谷雾 1 之间、脚线 y 642，f165 入画；f175 领头那只停步仰头、鹿群停 12 帧；灰豹 f175 耳朵一抖、头朝鹿转 7°、睁眼盯住，f199–f211 慢慢转回，f213–f227 慢慢闭眼 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_g/s_7.25.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_g/s_7.5.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_g/s_9.1.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_final/s_9.00.jpg` |
| story-07 | P2 | 已修 | f520–f531 从 S5a 机位插值到跟拍机位（不再硬换）；f531 前山顶与云海顶还在画面下缘，豹从峰顶蹬起、三道墨影；蓄势压到 0.88、前倾 −6°，f518 停一帧 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_d/s_21.583.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_d/s_21.667.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_d/s_21.75.jpg` |
| story-09 / story-13 | P2 / P3 | 已修 | #8 里豹按 P(f) 继续飞、85 mm 跟拍，墨点向左拉开；#8 的日放到豹身后画左（x 300），和 #9 同侧 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_d/s_26.1.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_d/s_26.3.jpg` |
| story-12 | P3 | 未修 | 要改 S6 起始机位露出镜框弧，会动 P_g 与 T2 的同点契约；本轮没做 | — |
| story-14 / self-07 | P3 | 已修 | 豹贴着远排山上沿飞（远山做底），身长约 420 px；墨点去掉竖向哈希偏移，三枚大墨印沿同一条弧落下（去掉 −0.25 m） | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_d/s_25.0.jpg` |
| story-15 | P3 | 已修 | S3b 手的最高点停在面具下巴下面（锚点 (1015, 1030)，指尖约 y 880），悬停时扫光扫过面具、手背金光 0.35 + 一下脉动；S3c 背影走远 0.8 m（缩小约 15%），脚前加一层低雾 f324 前漫过小腿 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_d/s_12.2.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_e/s_13.5.jpg` |
| story-16 | P3 | 已修 | 字幕逐字间隔 2 → 1 帧，f689 八字全显，保持约 0.83 秒再化白 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_final/s_28.50.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_final/s_29.00.jpg` |
| story-17 | P3 | 已修 | 墨滴墨占 0.9、外缘 2 px 浅水边 + 小高光，脱落后拖 4 帧细墨尾 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_g/s_15.25.jpg` |
| tech-05 | P2 | 已修 | 远脊卡片加宽到 4400 px、雾带 5200 px，都居中摆，S4 换 50 mm 后右缘不再露卡片边 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_d/s_14.5.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_d/s_16.0.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_d/s_18.5.jpg` |
| tech-08 | P2 | 已修 | 伪字每格 2–3 笔各占一个象限、互不相接，横、竖各至多一笔，其余是点 / 撇 / 捺，低对比赭墨——拼不出 十 丁 上 二 三 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_c/s_1.5.jpg` |
| tech-09 | P2 | 已修 | 卷云云头下沿那条 step() 硬切的暗带去掉（暗边改成沿整圈轮廓的窄带）；旋涡的抗锯齿只用径向导数，分支切口不再出细线 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_c/s_22.5.jpg` |
| tech-13 | P3 | 已修 | 云墙在云头之间垫一层 #1B2238 实底（卡片 3%–90% 高度），盖满那几帧不漏底 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_c/s_22.5.jpg` |
| tech-14 | P3 | 已修 | 底板那颗白色四角星补掉（见资产） | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_c/s_12.0.jpg` |
| self-06 | P3 | 未修 | 蹲 → 坐仍是硬换图加 4% 压扁拉长（设计如此），本轮没加过渡 | — |
| self-08 | P3 | 部分修 | 金环收细后交叉处不显乱；弯曲途中的穿插本身没改 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_final/s_4.00.jpg` |
| self-09 | P3 | 不改 | P_g 仍按 A09 实测锚点 (1016, 330)，T2 豹眼高光同点，匹配剪辑成立 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix1_g/s_27.3.jpg` |

### 本轮新增的偏差（相对 DESIGN.md）

1. 豹按主会话 main-01 改成幼豹造型（DESIGN 风险 #1 原本防的"大头"在这里是主会话的要求），斑半径、比例尺全部按新 A01 重量。
2. S4 机位：S4a 随降时同时后拉（d 1.05 → 2.0），S4b 再推近到 d ≈ 1.0；S4c / S4d 分界从 f462 挪到 f470（19.58 s，正好在 19.53–19.57 s 的高频起音上）。
3. S5a 山顶石改叠晕山 SDF 卡片（3D 山顶石停用，风险 #4 / style-07 ⑤ 的降级）；S5a 机位推近到 z 3.6 → 3.45，日轮 Ø 520、圆心 (960, 480)。
4. T1 胭脂日铺满光轮内径（R 0.0485），金环收细；门户改成单独一张虹膜盘。
5. S4d 去掉整幅雾幕，换三条软雾带。
6. S5c 长卷山从石绿 / 石青改成 ref_00 灰紫（风险 #16 的降级）；绢天压暗一档。

## 十、返修记录（第 2 轮，2026-11-04）

问题单 22 条，合并重复后按级排序：P1 两组（style-06、main-02 + v1-05），P2 十组，P3 八组。全部在 5090 上渲图，用 Read 逐张看过；关键处另做 1:1 裁切和数值复测。
整片接触印样：`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix2_final/sheet.jpg`（0.5 秒一张，60 张）。门禁：`@@CASE_ROOT@@/films/B_zhuangshi/_work/gate/GATE.md` 全部 PASS（中位 33 ms/帧）。
中间渲图（都在 `_work/stills/`）：`fix2_a`（崖面、墨晕、擦除、地面）→ `fix2_b`–`fix2_e`（崖面迭代、色板）→ `fix2_s5`、`fix2_s5b`、`fix2_s5c`（起跳与云）→ `fix2_t2`、`fix2_t2b`（豹头）→ `fix2_s3a`、`fix2_s3b`（集市）→ `fix2_char`（新人物、新底板）→ `fix2_s6arc`、`fix2_s6arc2`（镜框弧）→ `fix2_full1`（整片）→ `fix2_olive`、`fix2_olive2`（色板复测）→ `fix2_t1`（金条）→ `fix2_walls`（云墙复查）→ `fix2_4k`（4K 抽查，缩小后与 1080 版平均差 0.62–1.02）→ `fix2_final`。
本轮旧代码与旧 manifest 备份在 `_work/fix2/backup/`，旧资产在 `_work/asset_attempts/pre_fix2/`；本轮脚本 `_work/fix2/make_head_2x.py`、`_work/fix2/smooth_a09_hair.py`、`_work/fix2/olive.py`（橄榄色族复测）。配乐、`audio.json` 未动（offset 0，报告首行起点 0.00 s，一致）。

### 资产

- A07 `lw_sit_back.png`、A08 `lw_walk_back.png`（style-14）：Magpie 重出，A06 设定图为第一参考、旧图为构图参考、ref_08_c / ref_11_c 为画风参考；提示词写死"天书奇谭白衣人式的简化平涂、背上至多 4 道褶、头发一整块平涂外轮廓顺滑、粗细有变化的墨线、无五官"。两张都一次通过：严格背影 / 只露耳和镜腿；透明底半透明像素 0.54% / 0.75%，半透明均色偏暗（线色 #514032 左右），无白边、无棋盘格。锚点按新图量（外接框、底轴心、头区、呼吸区）写进 manifest。
- A16 `market_plate.png`（style-11 ③ / self-02）：按风险 #6，ref_07 为第一参考、旧 A16 为构图参考重出：大块喷绘杏 → 淡紫天、建筑大块平涂、人群简化成几排无五官背影剪影，匾、幡无字。右下草丛里几朵白色小花是花。
- A09 `lw_desk_back.png`（style-14 ③）：不重出（P_g 镜片闪点和右肩 A 是锚点契约），`smooth_a09_hair.py` 离线只改头发：去扇贝卷边、外轮廓平滑、面积缩到 0.82；缩掉的部分靠背景一侧变透明、靠脖子一侧补肤色，脖根露出的一小段补 3 px 轮廓线；耳朵、镜腿、镜片弧、衬衫、全部锚点不动。
- A05x2 `leo_head_2x.png`（v1-06，派生资产）：`make_head_2x.py` 把 A05 两倍 Lanczos 预放大（预乘 alpha，按源图 3×3 邻域夹值去振铃），鼻头里两道深色明暗笔压成鼻头主色 #683B1C。只在 T2 用。

### 逐条

| 编号 | 级 | 结果 | 怎么改的 | 证据 |
|---|---|---|---|---|
| style-06（v1-08 同区另列） | P1 | 已修（按 DESIGN 风险 #4 降级） | 3D 长石 / 巨石两轮都读成 CG 石饼（压平顶、多边形剪影、深石板色），本轮换思路：**停用 3D 长石和两块巨石**，换一张手绘崖面卡片（cliff.js `LEDGE_FS`）：代理网格按 S2 参考机位投影铺，顶边贴 A17 平台前沿（y≈841，和底板同深度 11.4 m），往下前凸到 10.9 m，保留一点真实视差。着色器在 cam0 设计像素里画：前沿一线灰绿受光 #BCC6A6、沿下一道深青暗带、三层披麻皴式竖笔（深青 #1D3738、灰紫 #A2A8B6、苔黄 #979672，成簇疏密、长短 0.08–0.8 崖高）、受光上部苔黄干笔、下沿暗面 + 成簇钟乳（右端悬挑处更密，长 14–164 px）、下部渐入雾。底色取灰绿 #7B886E → #7D876F → #A4AC92，和平台是一块石头。前雾上沿下移 42 px、α 0.86 → 0.74，钟乳尖先露出来再进雾。S4a–c 近景不画（被平台地面挡住），S4d 跟底板同步调暖 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix2_final/s_7.50.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix2_final/s_6.00.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix2_final/s_20.50.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/fix2/cmp_s2_fix2.jpg` |
| main-02 + v1-05 | P1 / P2 | 已修 | leo.js 晕开距离场重写：基础半径叠 3 个低频瓣（±0.085 / 0.055 / 0.045 R，相位随 0.30 / 0.21 / 0.17·t 缓变），正圆打破；高频毛细须边幅度 0.05R，只在约 30% 的角度上出现（低频角向门控），覆盖羽化 0.04 / 0.02R；外缘一道约 0.044R 宽、α0.7 的干墨边，外面一圈 0.16R、α0.20 的淡水痕；墨往外推时中心淡 18%；收紧阶段用同一套边逐渐收进环形。湿墨斑四瓣再弱一档（0.40 → 0.26），读成一团没干的墨、不读成四瓣灰花，和亮色环斑分得开。fix1 的中近景交代（15.5 s 看得见耳、头、肩）、放慢收紧、去水滴尾巴保留。1:1 复查 16.083 / 16.333 / 16.50 / 16.667 s：墨团是不规则圆润的洇墨团，边上只有零星细毛，不再是海胆 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix2_a/s_16.083.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix2_a/s_16.333.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix2_a/s_16.5.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix2_a/s_16.667.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix2_a/s_17.5.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix2_final/s_15.50.jpg` |
| style-11 + self-02 | P2 | 已修 | ① 面具金（fix1 已乘 (0.93,0.87,0.72) 并去饱和）复测 S 中位 0.73、p90 0.75；② 假光轮火舌金预先压饱和（根 #A27A3E、身 #D9B45E、尖 #EAD49C），集市调色后实测 S 中位 0.68、p90 0.73（原 0.98），火舌根→身→尖平滑过渡（fix1）；③ A16 按 ref_07 重出（见资产），底板饱和 0.85 → 0.92、天空喷绘层 0.35 → 0.15（新图自带喷绘天），Kuwahara 0.8 / farRadius 3.0 保留 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix2_final/s_11.00.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix2_final/s_12.00.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/fix2/cmp_s3_fix2.jpg` |
| style-14 | P2 | 已修 | ① 重出 A07 / A08（见资产）；② S2 / S4d 坐背线在着色器里再膨胀 2.6 图像像素（7.5 s 实测外轮廓 2–3 px、内部褶线 1–2 px，粗细有变化），S3c 走背 1.0（新图的线本身就粗）；③ A09 头发离线改成一整块平涂、外轮廓顺滑、缩小约 18%（见资产）。S2 按新图外接框摆：人高 386 px、底轴心 (1179, 792)，和原契约一致 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix2_char/s_7.5.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix2_char/s_12.9.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix2_char/s_20.5.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix2_char/s_28.0.jpg` |
| style-17 | P2 | 已修 | 六道远脊再推一档灰绿（#CFD8B6 … #7F9369）；底板受光层顶橄榄推 0.8 → 1.0，中间调斑块往灰绿偏（×1.16 / 1.07 / 0.74）；最暗处推成青黑（线性 ×0.42 / 0.88 / 0.62），雾崖调色 lift B 0.040 → 0.034；平台地面 #B2BC9C / #C2C8A6；新崖面灰绿底 + 苔黄干笔；S4d 晴后近脊 #5F8A93 → #6E8C7A；雾色、天色不动。按 palette.py 同算法（k=10，色相 50–125° 且 S ≥ 0.06 的簇）复测：S2 6.5 / 7.5 / 9.5 / 10.5 s = 15.6 / 15.6 / 16.3 / 15.4%，S4d 20.5 s = 24.3%（fix1 为 3.7% / 6%）；最暗簇 #26383E（原 #313C4A 蓝石板） | `@@CASE_ROOT@@/films/B_zhuangshi/_work/fix2/olive_fix2.txt`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/fix2/pal_s2_fix2.png`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/fix2/pal_s4d_fix2.png`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix2_olive2/s_9.5.jpg` |
| story-07 + v1-03 | P2 | 已修 | 后云团不再在 f520 一帧整片出现：f520 时还在画面上缘外 760 px，f520–f530 随镜头上摇从上缘压下来（eo）。f520 只有晴空、金日和起跳，f521 上缘露一角，f522 盖上三分之一，f524 起金日才被遮住。fix1 的机位插值、峰顶蹬起、三道墨影、蓄势 0.88 / −6°、f518 停一帧保留 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix2_s5c/sheet.jpg`（21.625–22.167 s 十一张） |
| tech-13 + v1-01 | P3 / P2 | 已修 | 去掉云墙的矩形实底（它半入画时成了一条直横缝）；改为每两排之间垫一排"填缝云头"（画在两排下面，只从缝里露出来），最下面再垫一排小云头（全在卡片里，不会被截平）；云头抖动收小；盖满段 L1 / L2 上缘关键帧 −260 → −230、−60 → −50。复测 22.42 / 22.5 / 22.58 / 23.25 / 23.35 / 23.46 s：亮于 150 的像素 ≤ 0.003%、金色 0%；22.17–22.29、23.08–23.21、23.58–23.67 s 入画 / 出画边都是扇贝云头，没有直缝 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix2_walls/sheet.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix2_walls/s_22.25.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix2_walls/s_22.42.jpg` |
| v1-02 | P2 | 已修 | `mkCloud`：云头（含 ±5.5% 起伏）离卡片左右边不足 0.03 卡高时，卡片两边各加宽、云头整体平移（卡片中心和云头位置不变）；后云团、残云按原高摆，宽度随之加宽。复查 21.833 / 22.0 / 22.208 s 没有竖直切边 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix2_walls/s_21.833.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix2_walls/s_22.0.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix2_walls/s_22.208.jpg` |
| v1-04 | P2 | 已修 | 平台地面的蓝苔点从值噪声方格阈值改成每格一个哈希圆点（fwidth 抗锯齿，半径 0.22 格，约 11% 的格子有点，只在斑驳暗处），颜色 #2E5F86、α0.55 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix2_a/s_18.5.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix2_a/s_16.083.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix2_a/s_19.25.jpg` |
| v1-06 | P2 | 已修 | T2 改用 A05x2（两倍预放大、去振铃、鼻头压平），腐蚀量按两倍换算（3.2 图像像素）；鼻头、须点、泪线、额点、颊点按特征区椭圆整块保留原棕色（不腐蚀、不换线色）。1:1 复查 27.0 / 27.25 s：鼻头一块平涂、轮廓顺滑；须点圆、无锯齿和浅晕；泪线一色到底 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix2_t2b/s_27.0.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix2_t2b/s_27.25.jpg` |
| story-12 | P3 | 已修（换做法） | 不动 S6 起始机位（会破坏 P_g / A 的同点契约，见第六节偏差 #1）。A09 图里本来就画着右镜片外框的一段"("形弧（头右缘外、耳朵右边）；f659–f667 闪光退去时沿这段弧亮一道 3 px 细金线（叠加层加色，按图里墨线拟合的椭圆弧，半张角 72°，屏幕约 80 px 高），f663 起淡出——闪光收成一个圆，和 T1 的光轮、豹眼的圆呼应 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix2_s6arc2/s_27.542.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix2_s6arc2/s_27.583.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix2_s6arc2/s_27.667.jpg` |
| story-15 | P3 | 已修（S3b 坐标按画面调整） | S3b：手改从右下入画，和摊主握杆的手分开；最高时指尖停在面具右下颊外缘（约 (1235, 760)，离金面具边约 20 px）。本片面具居中且很大（下巴 y≈880），设计写的 (1010, 640) 会落在面具鼻子上、像摸到了面具，所以按"伸向金光、差一点碰到、停住"的意图摆；扫光 f286–f298、手背金光 0.35 + f292 脉动、f296–f300 蜷指 4 帧沿用 fix1。S3c：走远 0.8 m（按机位算缩小约 16%）、低雾 f324 前漫过小腿（fix1），换新 A08 后按 1.73 m 身高摆 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix2_s3b/s_12.25.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix2_s3b/sheet.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix2_final/s_13.00.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix2_final/s_13.50.jpg` |
| v1-07 | P3 | 已修 | 墨点和大墨印的出生点从尾根改到尾尖后方 0.18 m（沿飞行方向反向）；墨点卡片画在豹后面（renderOrder 12 → 9.2），出生时被豹挡住而不是贴在臀上；三枚大墨印仍踩 f606 / f612 / f618（没有晚 2 帧，免得离开重拍） | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix2_s5/s_25.25.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix2_s5/s_25.75.jpg` |
| v1-08 | P3 | 已修 | 松干起点前接一段 3D 根（渐细管 0.16 → 0.125 m、两个疙瘩），从画左外的崖壁里横着长出来接进原干基，平切的管口被根盖住；S2、S4d 里干都从画左缘出画 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix2_final/s_7.50.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix2_final/s_20.50.jpg` |
| v1-09 | P3 | 已修 | 前景云丝改成和云堤同一套：扁的扇贝边云带、白顶平涂 + 下沿硬边影带、两头收尖，掠过只靠位移；#9 头后的云堤换成硬边云堤着色器（BANK_FS） | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix2_s5/s_25.0.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix2_s5/s_26.5.jpg` |
| v1-10 | P3 | 已修 | 擦除遮罩边宽收到约 0.008 身长（原来是约 100 px 的柔边椭圆），洇边 fbm 两个尺度、幅度约 0.02 身长；外缘（灰的一侧）一道约 0.002 身长、深一档（×0.84）的湿边 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix2_a/s_18.3.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix2_a/s_18.5.jpg` |
| self-06 | P3 | 未修 | 蹲 → 坐仍是设计规定的硬换图 + 4% 压扁拉长。要真正消掉得加一张"半起身"原画（Magpie 出图、重量锚点），排在 P1 / P2 之后，本轮没做 | — |
| self-08 | P3 | 未修 | T1 f94–f102 金条弯曲途中仍有交叉（各占一层、不打架，动起来读得出"卷成光轮"）；要消掉得重排六爻成轮的编舞，本轮没做 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix2_t1/sheet.jpg`（现状） |

### 本轮新增的偏差（相对 DESIGN.md）

1. 前缘长石与两块巨石不再是 3D toon，换成按 S2 机位投影的手绘崖面卡片（风险 #4 的降级）。场景 Y 里的 3D 还有虬松（干、枝、根）；全片的 3D 还有书桌器物、卦爻金条、面具。
2. T2 用派生的两倍豹头图 A05x2，#9 仍用 A05。
3. A07 / A08 / A16 重出；A09 头发离线修改（锚点不变）。
4. 云墙不垫矩形实底，改为填缝云头 + 底排小云头；后云团 f520–f530 从上缘压下来。
5. 墨点在尾尖后方 0.18 m 出生、画在豹后面。
6. S6 闪光退去时沿 A09 画好的右镜片外框弧亮一道细金线（f659–f667）。
7. S3b 手的最高点在面具右下颊外缘 (≈1235, 760)，不是设计的 (1010, 640)（理由见 story-15）。
8. 雾崖调色 lift 改为 [0.026, 0.036, 0.034]（原 [0.030, 0.035, 0.040]）。

### 第 2 轮之后的已知不足

- P3：self-06（蹲 → 坐硬换图）、self-08（T1 金条弯曲途中交叉）未修，原因见上表。
- 橄榄色族按 k-means 色板口径到了 15.4–16.3%（S2）、24.3%（S4d）；逐像素口径（色相 50–125°、S ≥ 0.06）是 13.5–14.7%，雾和天按要求没动，它们占了画面一半。
- 新崖面是 2D 卡片，只在 S2 横移时有约 5 px 的上下视差差，不受光；S4d 机位推近 0.6 m 时看不出问题。
- 未验证：整片视频（`finish.sh` 属渲染角色）没有渲；配乐对位只按帧号核对。

## 十一、返修记录（第 3 轮，2026-11-04）

问题单 7 条，没有重复项，按级排序：P2 两条（v2-01、v2-02），P3 五条（v2-03、v2-04、story-12、self-06、self-08）。全部在 5090 上渲图、用 Read 亲眼看过；关键处另做 1:1 裁切、逐帧拼条和数值复测。
整片接触印样：`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix3_final/sheet.jpg`（0.5 秒一张，60 张）。门禁：`@@CASE_ROOT@@/films/B_zhuangshi/_work/gate/GATE.md` 全部 PASS（中位 33 ms/帧）。
中间渲图（都在 `_work/stills/`）：`fix3_a`（湿墨斑晕开、崖面第一版）→ `fix3_b`–`fix3_d`（崖面三种程序笔触，都不过关）→ `fix3_e`–`fix3_g`（A20 崖面贴图、集市、手、镜片）→ `fix3_h`（镜片合成修正）→ `fix3_i`（T1 弯曲、S4d 起身中间张、人群）→ `fix3_olive`–`fix3_olive5`（橄榄色族复测）→ `fix3_4k` / `fix3_1080`（新改处 4K 抽查）→ `fix3_t1`、`fix3_t1b`（T1 两种编舞对比，留第一种）→ `fix3_final` → `fix3_verify`（终版复查，和各条证据逐像素一致）。
本轮旧代码、旧 manifest、旧 NOTES 备份在 `_work/fix3/backup/`；拼条、裁切、对比图都在 `_work/fix3/`。配乐、`audio.json` 未动（offset 0；`audio/B_zhuangshi_report.txt` 首行截取起点 0.00 s，一致，不用重出报告）。

### 资产

- A20 `ledge_face.png`（v2-02）：Magpie 新出的手绘崖面条（要 4:1，实际给了 3:1 的 2172×724），参考图 ref_08_c、ref_10_c、A17；提示词写死"天书奇谭式水粉、大笔披麻皴斜向左下、深青凹处、灰绿 / 灰紫脊、柔和过渡、下三分之一化进白雾、无天无钟乳无人物无边框"，一次通过。不透明底图，不用抠底。已写进 `assets/manifest.json`（含铺贴换算的"锚点"：图顶 y 48、0.90 设计像素 / 图像像素、x 偏 60）；`main.js` 的资源名单加了 `ledge_face`。原图存 `_work/asset_attempts/fix3/ledge_face_v1.png`。
- 没有重出角色资产：self-06 的起身中间张由 A02 坐姿图在顶点着色器里派生（见下），不另出图。

### 逐条

| 编号 | 级 | 结果 | 怎么改的 | 证据 |
|---|---|---|---|---|
| v2-01 | P2 | 已修 | `leo.js` 晕开段：环 0 仍从落点 0.2R 起（墨滴落下前它不存在）；其余 17 枚改成从**湿墨斑本身的轮廓**起——湿墨斑抽成函数 `leoWet()`，晕开半径 `Rb = mix(0.97, Rmax, e)`，轮廓距离场由"湿墨斑轮廓按 Rb 等比放大"渐变到晕开的洇墨边（u = 1 时与收紧段首帧一致），颜色按预乘色由湿墨斑（WETD + 弱四瓣）交叉淡到墨（smoothstep 0 → 0.75）；u = 0 那一帧与湿墨斑逐像素相同。逐帧复查 17.833–18.292 s（第 1 组）和 18.333–18.75 s（第 2–4 组）：再没有"整枚消失换成小黑点"的帧，每枚是先变深、略胀、再收紧点亮 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/fix3/v201_strip_a1.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/fix3/v201_strip_a2.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/fix3/v201_strip_a3.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix3_a/`（17.833–18.75 s 逐帧） |
| v2-02 | P2 | 已修（换思路） | 先照单改了程序崖面（`fix3_a`：下沿 80 px fbm 打散入雾、主笔格宽 32、空格约 35%、灰紫收尖笔换成不收尖的浅干笔、右端圆角、钟乳减半集中到悬挑）——浮空石板的问题没了，但笔触仍读成一排竖向雨痕；又试了块面岩柱（`fix3_c`，读成砖墙）和弯曲笔场（`fix3_d`，读成水草），同一方向两次不成，换思路：崖面本体改用 A20 手绘贴图（按 cam0 设计像素铺，贴着 rimY 走，亮度映到本片灰绿色板 深青 → 青灰 → 橄榄中灰 #5D6A4E → #7B886E → #A4AC92，只留一成原色）。着色器保留并重写了外形：① 左段不画下沿剪影，约 y 985 起 80 px 内 fbm 打散、同时褪向暖一点的雾色，崖体往下进前雾；② 右端只有悬挑段（x ≳ 1100–1250 渐入）露出下沿，右下是带 fbm 起伏、半径 50 px 的圆钝岩角，顶角也倒了一点；③ 钟乳只挂在悬挑下（约 6 根，长短双峰 14–56 / 95–235 px）；④ 原来那排竖向苔黄飞白条（读成流苏）去掉，改成跟着贴图亮处走的淡苔黄。橄榄色族复测（同 fix2 的 olive.py）：逐像素 6.5 / 7.5 / 9.5 / 10.5 / 20.5 s = 16.9 / 16.5 / 15.6 / 15.5 / 15.0%（fix2 为 14.7 / 14.4 / 13.6 / 13.6 / 13.5%），k-means 15.6 / 21.6 / 15.2 / 15.4 / 19.2%；4K 缩小后与 1080 平均差 0.83（7.5 s） | `@@CASE_ROOT@@/films/B_zhuangshi/_work/fix3/v202_ledge_vs_ref08.jpg`（与 ref_08 左侧悬挑并排）、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix3_final/s_6.00.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix3_final/s_7.50.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix3_final/s_9.50.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix3_final/s_20.50.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/fix3/olive_fix3.txt`；失败的三版：`@@CASE_ROOT@@/films/B_zhuangshi/_work/fix3/z_ledge_left_a.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/fix3/z_ledge_right_c.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/fix3/z_ledge_left_d.jpg` |
| v2-03 | P3 | 已修 | `market.js` S3b 手：金色加色只叠在手的上缘（图像上部 4–36%，往下渐隐），三处墨渍（含蹭痕）按墨渍 alpha 整块遮掉、不吃加色；强度 0.40·near + 0.20·脉动（≤ 0.6 倍 #E2B93B）。12.083 s 墨渍最暗处实测 #51341E–#5C3C24（S1 #443629–#605247；改前 #BE973C）。面具扫光改成屏幕 35° 的硬边平涂亮带（宽约 70 px，原来约 140 px 柔边）+ 旁边一道约 8 px 的细线，α 0.40 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/fix3/z_s3b_hand_final_12.083.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/fix3/z_s3b_hand_final_12.25.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix3_h/s_12.25.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix3_h/s_12.333.jpg` |
| v2-04 | P3 | 已修 | `market.js` HEAD_FS 重写：斜肩（每侧斜 0.55）+ 立领（亮一档）+ 颈；四种头饰——幞头（包住上半个头的圆顶 + 脑后两个结 + 两条随一拍二轻摆的飘带）、展脚官帽（贴头圆顶 + 后山 + 两条平伸长翅）、盔（护颈外张 + 盔尖 + 向后甩的一束长缨）、高髻（髻 + 小环 + 横簪）；帽 / 发 / 缨与衣分两种深色平涂；外缘 1–2 px 干笔起伏；大小 1.00 / 1.20 / 0.92 / 1.10（相邻差 15–25%），各自倾斜 −3° / 2.5° / −4° / 3°；脸侧金面具边改沿外轮廓走 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix3_verify/s_10.875.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix3_verify/s_11.0.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix3_verify/s_11.25.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/fix3/z_crowd_10.875.jpg` |
| story-12 | P3 | 已修（换做法） | 没有转 S6 机位：A09 是一张 2D 背影，转机位露不出图里没画的镜框，还会挪动 P_g 与 A 的同点契约（第六节偏差 #1）。改成在精灵上挂一张同平面的小卡片（`s6.js` LENS_FS）：沿图里那道"("的同一个椭圆（圆心 (946, 346)、半径 30 × 41 图像像素）把右镜片补成整圈——图里画了的左段 3 px 深框、远侧 2 px 淡一档，框里极淡的镜片色和一道斜 35° 的细反光（镜框按预乘合成，不混进镜片的浅色）；金线改成从闪点所在的左缘向两边绕，f658.5–f662 合成整圈、f663–f668 淡出——"豹眼的圆 → 镜片的圆"一眼可见；闪光跟着镜片走（f658 仍在 P_g，与 T2 同点同形）。脸颊以外不露五官，也不是眼镜特写 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/fix3/s6_lens_strip_h.jpg`（27.5 / 27.625 / 27.75 / 28.0 / 28.5 s）、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix3_h/s_28.5.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix3_verify/s_27.5.jpg` |
| self-06 | P3 | 已修 | `lib.js` 精灵顶点着色器加水平剪切 `uShear`（脚不动、越往上越往前）；`cliff.js` S4d 在 f486 插一张"起身"中间张：A02 坐姿以足底为轴纵向压到 0.80、横向 1.04、向前剪切 0.20，头颈再低 8°——眼睛落在蹲姿（世界 (0.80, 0.35) m）与坐姿（(0.44, 0.88) m）之间约 (0.62, 0.71) m；f488 坐直并拉长 104%，f490 回 100%。原来一次硬跳拆成三步；中间张上 18 枚环斑的闪点按同一形变走 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/fix3/s4d_rise_strip_i.jpg`（20.083–20.417 s 逐帧）、`@@CASE_ROOT@@/films/B_zhuangshi/_work/fix3/s4d_rise_zoom_i.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/fix3_verify/s_20.25.jpg` |
| self-08 | P3 | 部分修 | `room.js` T1：原来中点移动、曲率（m/R）、弧长三件事同时走，半弯的金条是一段段圆心各不相同的大圆弧，上下两侧的臂在环外交叉。改成三步：f94–f97 中点先平移到各自环位（直条沿径向散开，阴爻两段同时转 90°）；f96–f99 在短条长度下曲率升到 1/R（中点已就位，各段是以 H1 为圆心的同心弧）；f97.5–f103 弧长沿各自圆周长到整环 / 半环。f97 起所有金条都是同心弧、互不相交，f106 锁轮不变。剩下 f95–f96 两帧：转向中的阴爻两段与直条端点相碰（六二要从九三下面换到最内圈，拓扑上躲不开）；试过让阴爻晚转（`fix3_t1`），f98 反而出现"Λ"压过九三的交叉，退回 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/fix3/t1_bend_strip_final.jpg`（3.917–4.6 s）、对照改前 `@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/verify2_self08/sheet.jpg`、晚转版 `@@CASE_ROOT@@/films/B_zhuangshi/_work/fix3/t1_bend_strip_t1.jpg` |

### 本轮新增的偏差（相对 DESIGN.md）

1. 平台前缘崖面本体改用 Magpie 手绘贴图 A20（DESIGN 风险 #4 的"投影贴图"降级方向；3D 长石、巨石在 fix2 已停用）。外形（下沿入雾、圆钝岩角、钟乳）仍是着色器画。
2. S6 右镜片补成整圈镜框（A09 只画了外框左段），金线绕整圈；闪光跟着镜片走，f658 仍在 P_g。
3. S4d 蹲 → 坐加一张 f486 起身中间张（坐姿图派生），坐直拉长挪到 f488、回 100% 在 f490（设计是 f486 换图拉长、f488 回 100%）。
4. T1 金条成轮改成"先散开 → 定曲率 → 沿圆周生长"（设计 5.1 是曲率 m/R 与中点移动同步），起止帧 f94 / f106 不变。
5. S3a 人头剪影改为四种头饰、斜肩立领（设计是头圆 + 发髻圆 + 肩梯形）。
6. 面具扫光改为硬边平涂亮带（约 70 px）+ 细线、α 0.40（设计 ⑥ 是宽 0.12 物体尺寸、α 0.55 的柔带）。

### 第 3 轮之后的已知不足

- P3：self-08 剩 f95–f96 两帧阴爻转向时与直条端点相碰（原因见上表）。
- 崖面为了保住 style-17 的橄榄色族，色相落在灰绿，比 ref_08 的灰蓝暖一档；笔触结构与 ref_08 一致。
- 起身中间张是坐姿图的形变派生，不是新画的原画；只出现 2 帧（一拍二的一张），在 S4d 全景里看不出变形。
- 未验证：整片视频（`finish.sh` 属渲染角色）没有渲；配乐对位只按帧号核对。

## 十二、返修记录（第三轮第 1 次 · 总第 4 轮，2026-11-04）

问题单 `_work/w3/ISSUES.json` 12 条。合并重复：self-08 与 qa2-02 是同一处（T1 f95–f96 金条梯形）；v3-02 与 qa2-04 同是 S4a 墨滴，分开记但一起改。合并后 11 组，按级排序：P2 一组（qa2-01），P3 十组；P3 里先做复核 / 总审扣分理由点到的（T1 梯形、T2 双色线、S5c 下半幅闷）。
全部在 5090 上渲图、用 Read 亲眼看过，并和 v2 冻结存档同一时刻比过。整片接触印样：`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/w3fix1_final/sheet.jpg`（0.5 秒一格，60 格）。门禁：`@@CASE_ROOT@@/films/B_zhuangshi/_work/gate/GATE.md` 全部 PASS（中位 33 ms/帧）。
与 v2 逐格对比：`@@CASE_ROOT@@/films/B_zhuangshi/_work/w3/final_vs_v2.txt`。S1（0–3.5 s）、S3（11–14 s）、S4b/c（16–18 s）、S5a/b（21–23.5 s）、#9 与 v2 一致（和同为 5090 渲的 fix3_final 逐像素差 0.00）；有差的格子都落在本轮改到的地方。
本轮旧代码、旧 manifest、旧 NOTES 备份在 `_work/w3/backup/`；拼条工具 `_work/w3/tools/strip.py`。没有重出资产（manifest 未改），配乐与 `audio.json` 未动（offset 0，报告首行起点 0.00 s，一致）。

| 编号 | 级 | 结果 | 怎么改的 | 证据 |
|---|---|---|---|---|
| qa2-01 | P2 | 已修 | `sky.js`：云丝是固定在世界里的卡片（D 3.0），每帧移约 55–170 px；原来只在 [596, 606) 显示，在画中间一帧冒出、一帧消失。改成整个 S5c（fi ≥ 578）都显示：f581 前整条在右框外，f582 左尖从右缘进画，斜着往左下掠过，f615 右端出左缘，f616 起画里没有。逐帧实测位置见 txt | `@@CASE_ROOT@@/films/B_zhuangshi/_work/w3/wisp_f576_623.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/w3/wisp_full_sel.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/w3/wisp_track.txt`；改前 `@@CASE_ROOT@@/films/B_zhuangshi/_work/w3/base_wisp_f594_607.jpg` |
| self-08 + qa2-02 | P3 | 已修（换思路） | fix3 改过一次编舞仍剩 f95–f96 两帧梯形（六二要从九三下面换进最内圈、上六要绕到最外圈，拓扑上必和阳爻交错）。本轮换思路：阴爻两段先顺着自己收成短光珠（f94–f95.5，0.038 → 0.007 m），转向和赶路都晚起快走（f94.8–f97），在 f95 与 f96 之间一步跨过阳爻，渲出来的帧里不交叠；到位后沿各自圆周展开成半环（f96.5–f102.5），f98–f106 转 90° 锁轮不变。上六翻面提前在 f95.5 翻完（原来 f95 正好侧立成两道黑细线）。成轮期间阴爻层高放到阳爻下面，f101 起回到原层高（俯冲段与 v2 逐像素一致） | `@@CASE_ROOT@@/films/B_zhuangshi/_work/w3/t1c_f92_106.jpg`（f92–f106 逐帧）、`@@CASE_ROOT@@/films/B_zhuangshi/_work/w3/t1b_f92_99.jpg`；改前 `@@CASE_ROOT@@/films/B_zhuangshi/_work/w3/base_t1_f92_100.jpg` |
| v3-01 | P3 | 已修 | `cliff.js` LEDGE_FS：悬挑下暗面的噪声 x 频率 .30 → 低频 fbm（.05），不再是梳齿竖纹；钟乳宽度叠 1–2 个鼓包 / 缩颈、横向摆 6–10 px（略弯）、根宽 ×1.6 且从暗面里 14 px 渐显（起点高低不齐）、尖端 10 px 淡到 α0.6；长钟乳只挂双号格（相邻不并排），长度封顶 150 px | `@@CASE_ROOT@@/films/B_zhuangshi/_work/w3/ledge_under_new2.jpg`（6.0 / 7.5 / 20.5 s，2 倍）；改前 `@@CASE_ROOT@@/films/B_zhuangshi/_work/verify3/z_ledge_under_7.5.jpg`、ref_08 对照 `@@CASE_ROOT@@/films/B_zhuangshi/_work/verify3/v202_ledge_vs_ref08_v3.jpg` |
| v3-02 | P3 | 已修 | 墨滴按 A12 的 drop_spawn（指尖下缘接触点）挂着长大，尖顶藏进指尖、叠加层按手精灵的 alpha 遮掉，只画在指尖轮廓以下；f359–f361 下坠拉长，墨滴顶与接触点之间连一道"颈"（两端半宽 3.2 / 2.6 px、中段收到 1.1 px）；f362 断开，上截挂在指尖、下截在墨滴顶，各用 2 帧缩回（f362 留 40% / 30%，f363 再减半，f364 没了），没有悬空短线；浅水边只留左下约 1/3 弧、α ≤ 0.5，高光缩到 60%。f359 的挂点按机位与一拍二抖动解析算出，不读上一帧状态 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/w3/v302_neck_f358_366_x3.jpg`（f358–f366，3 倍）、`@@CASE_ROOT@@/films/B_zhuangshi/_work/w3/v302_drop_f356_367_x15.jpg`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/w3/v302_grow_f350_357.jpg`；改前 `@@CASE_ROOT@@/films/B_zhuangshi/_work/w3/base_drop_f356_378.jpg` |
| qa2-04 | P3 | 已修 | 墨滴脱落后从挂点平滑移到落点、半径 13 → 15 px（落背前宽 30 px）；f374 压扁成一摊（宽 1.35 倍、高 0.45 倍，不画高光）并叠一帧深色冲击环（半径 22 px、线宽起伏、偶有断口）；皇冠溅缩放 0.75 → 1.2–1.45（溅点约 5–9 px） | `@@CASE_ROOT@@/films/B_zhuangshi/_work/w3/qa204_land_f368_380.jpg` |
| v3-03 | P3 | 已修 | `cliff.js`：陆蔚坐背 S4c 显示从 f446 提前到 f439.5。逐帧（i/24）查 f436–f450：f443 前在右缘外，f444 起裤腿、衬衫随后拉一点点滑进画 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/w3/lw_in_f436_450.jpg` |
| v3-04 | P3 | 部分修 | `room.js` 把书（封面、两页、书口、小纸片）收进一个组，S1 / T1 是单位变换、和原来一样；页面着色器画 ䷰ 改用组的本地坐标，卦画跟着书走。S6 里书挪到他右前方并正对他，右页 ䷰ 和版框、鱼尾、蓝封面完整露在 x 1500–1900、y 900–1030，左页木刻豹在笔尖旁露出一部分；双手缩到 0.86 倍，左手下移 28 px、两指按在书的左上沿。机位、P_g、A 不动。**未做到的一点**：笔尖落在左页靠书口处，不在右页（原因见第六节偏差 #11） | `@@CASE_ROOT@@/films/B_zhuangshi/_work/w3/s6_book_v2_vs_w3_28.5.jpg`（上 v2、下本轮）、`@@CASE_ROOT@@/films/B_zhuangshi/_work/stills/w3fix1_s6/s_28.0.jpg`、`s_28.5.jpg`、`s_29.0.jpg` |
| qa2-03 | P3 | 已修 | 白金闪从整屏加色 0.85 改成按 alpha 盖一层暖白 #FFF4D6 的幕（峰值 0.87）+ 3% 加色。f141 平均亮度 254.8 → 239.2，RGB 均值 (247, 240, 212)（暖），近白像素 93% → 0%，S2 的崖、松、人豹透出一层影 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/w3/flash_f138_145.jpg`；改前 `@@CASE_ROOT@@/films/B_zhuangshi/_work/w3/base_flash_f139_144.jpg` |
| qa2-05 | P3 | 已修（查到真原因） | 不是线色分离的问题（按问题单改了线色判定，像素一个没变；把豹头涂成纯红后外缘仍是暗红）：精灵的深度遮罩层在不透明队列先画，把身后的绢天卡片（透明队列）挡掉，剪影边上半透明的一圈和清屏黑色混成了 1–2 px 深棕。场景 H 只有三张靠顺序叠的卡片，两张豹头图关掉遮罩层即可。x = 1450 处外缘像素由亮度 98 变成 150 → 142 → 130 的单色过渡，整条线一种线色 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/w3/t2_outline_x4_before_after.png`（左改前、右改后，4 倍）、`@@CASE_ROOT@@/films/B_zhuangshi/_work/w3/t2_outline_profile.txt`、`@@CASE_ROOT@@/films/B_zhuangshi/_work/w3/t2_new_vs_base.jpg` |
| qa2-06 | P3 | 已修 | `s6.js` 光斑成纹的整张时间表提前 2 帧：A 点那枚 f668 起变、f670（27.917 s）四瓣环成形，正踩 27.926 s 的重拍；其余按距离延迟不变 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/w3/s6A_f664_676.jpg`；改前 `@@CASE_ROOT@@/films/B_zhuangshi/_work/w3/base_s6A_f666_676.jpg` |
| zs-01 | P3 | 已修 | `sky.js` 长卷：远排冷而淡（淡青紫 #B7AFC3，核 ×0.72、层间 ×0.92），中排灰紫 #9C8794（核 ×0.52），近排暖一点、浓一点（赭紫 #86666B，核 ×0.42），冷暖、浓淡按远近拉开；近排矮一截（180–310 px），卡片中段压成矮丘留出云口；近排云堤 150 → 260 px，下缘成一片云海。下半幅暗部（L<80）35–46% → 5–6%，均亮度 111–130 → 163–171。豹、尾迹、日没动 | `@@CASE_ROOT@@/films/B_zhuangshi/_work/w3/s5c_c.jpg`（24.5 / 25.0 / 25.5 / 25.95 s）、`@@CASE_ROOT@@/films/B_zhuangshi/_work/w3/s5c_cmp_ref00.jpg`（v2 / 两档试色 / ref_00 并排）、`@@CASE_ROOT@@/films/B_zhuangshi/_work/w3/s5c_lowerhalf_stats.txt`；改前 `@@CASE_ROOT@@/films/B_zhuangshi/_work/w3/base_s5c.jpg` |

### 本轮新增的偏差（相对 DESIGN.md）

1. T1 阴爻成轮改为"收成光珠 → 赶到环位 → 沿圆周展开"（设计 5.1 是两段平面内转 90° 再弯成半环）；起止帧 f94 / f106 不变。
2. S6 书的位置与朝向、双手 0.86 倍、笔尖在左页（见第六节偏差 #11）。
3. S5c 长卷三排山改为远冷近暖的三色（设计 2.6 原为石绿 / 石青，fix1 起为同一灰紫），近排加云口、近排云堤加高。
4. S4a 墨滴挂在指尖下缘接触点而不是 A 点下方 17 px，脱落后再移到落点 A；落背加一帧压扁和冲击环。
5. 白金闪改为暖白幕（设计是 #FFF4D6 加色 0.85）。

### 本轮之后的已知不足

- S6 左页木刻豹被执笔手的手指挡住大半，只露出笔尖旁一小块；撕口被小纸片盖着。
- 其他场景的精灵（豹、陆蔚）也带同一个深度遮罩层，剪影外缘同样会混进一点黑；它们的线本来就深，看不出，本轮没动。
- 未验证：整片视频没有渲（`finish.sh` 属渲染角色）；配乐对位只按帧号核对。
