# 行业示例 · 60 条（第 1–4 期）

20 种风格，每种风格配 3 个中小企业行业的 15 秒示例视频。同一风格的三条画风统一，但镜头、动效和叙事方式各不相同。品牌全部是虚构的，可以直接改成你自己的店名、文案和颜色（每个文件开头的 `Reel.cfg({...})` 里）。

## 怎么用

- 先看效果：用 Chrome 打开 `industry/` 里任意一个 `.html`，直接播放（3D 风格在没有独立显卡的电脑上预览会卡，导出的视频不会卡）。
- 出片：`node make.js industry 18a` → `out/industry/18-茶庄-云岫茶庄.mp4`（1080p、15 秒、含配乐音效、响度 -15 LUFS）。
- 一次出一期：`node make.js industry ep4`；一种风格的 3 条：`node make.js industry 18`；全部：`node make.js industry all`。
- 查编号：`node make.js industry list`。渲染中断后再运行同一条命令，会从断点继续。有独立显卡加 `--hwgpu` 快很多。
- 每条的渲染参数、配乐风格和音效时间点记录在 `industry/examples.json`。

## 第 1 期

| 编号 | 风格 | 行业 | 品牌（虚构） | 文件 |
|---|---|---|---|---|
| 01a | 逐帧手绘 / 剧情动画 | 咖啡烘焙 | 巷口咖啡 | [01a-coffee.html](01a-coffee.html) |
| 01b | 逐帧手绘 / 剧情动画 | 民宿 | 云栖小院 | [01b-minsu.html](01b-minsu.html) |
| 01c | 逐帧手绘 / 剧情动画 | 婚礼定制 | 拾柒婚礼 | [01c-wedding.html](01c-wedding.html) |
| 02a | 等轴 2.5D | 工厂数字化 | 恒创精工 | [02a-factory.html](02a-factory.html) |
| 02b | 等轴 2.5D | 园区招商 | 青禾产业园 | [02b-park.html](02b-park.html) |
| 02c | 等轴 2.5D | 供应链SaaS | 货流通 | [02c-supply.html](02c-supply.html) |
| 03a | 扁平矢量 | 教育培训 | 小步数学 | [03a-edu.html](03a-edu.html) |
| 03b | 扁平矢量 | 企业内训 | 新人七日通 | [03b-onboard.html](03b-onboard.html) |
| 03c | 扁平矢量 | AI做的App | 每日小账 | [03c-app.html](03c-app.html) |
| 04a | 线条动画 | 建筑事务所 | 白石建筑 | [04a-arch.html](04a-arch.html) |
| 04b | 线条动画 | 律所 | 衡正律所 | [04b-law.html](04b-law.html) |
| 04c | 线条动画 | 腕表 | ORIN | [04c-watch.html](04c-watch.html) |
| 05a | 3D 渲染 | 零食 | 果汁软糖 | [05a-gummy.html](05a-gummy.html) |
| 05b | 3D 渲染 | 美妆口红 | 绯FEI | [05b-lipstick.html](05b-lipstick.html) |
| 05c | 3D 渲染 | 小家电 | 随鲜榨汁杯 | [05c-blender.html](05c-blender.html) |

## 第 2 期

| 编号 | 风格 | 行业 | 品牌（虚构） | 文件 |
|---|---|---|---|---|
| 06a | 粒子形变 | 健身工作室 | 燃点健身 | [06a-gym.html](06a-gym.html) |
| 06b | 粒子形变 | 蓝牙耳机 | 声屿 | [06b-earbuds.html](06b-earbuds.html) |
| 06c | 粒子形变 | 线上课程 | 一人公司训练营 | [06c-course.html](06c-course.html) |
| 07a | 贴纸科普 | 家政保洁 | 小蜜蜂家政 | [07a-clean.html](07a-clean.html) |
| 07b | 贴纸科普 | 宠物医院 | 毛孩子宠物医院 | [07b-pet.html](07b-pet.html) |
| 07c | 贴纸科普 | 社区生鲜 | 邻里鲜 | [07c-grocery.html](07c-grocery.html) |
| 08a | 赛博 HUD | 无人机测绘 | 云眸测绘 | [08a-survey.html](08a-survey.html) |
| 08b | 赛博 HUD | 智能安防 | 守望安防 | [08b-security.html](08b-security.html) |
| 08c | 赛博 HUD | 电竞馆 | 零点电竞 | [08c-esports.html](08c-esports.html) |
| 09a | 拼贴（定格） | 独立书店 | 慢读书屋 | [09a-bookshop.html](09a-bookshop.html) |
| 09b | 拼贴（定格） | 定制旅行 | 出逃旅行 | [09b-travel.html](09b-travel.html) |
| 09c | 拼贴（定格） | 私房菜 | 阿婆私房菜 | [09c-kitchen.html](09c-kitchen.html) |
| 10a | 玻璃拟态 | 美业预约 | 约美 | [10a-beauty.html](10a-beauty.html) |
| 10b | 玻璃拟态 | 智能家居 | 栖家 | [10b-home.html](10b-home.html) |
| 10c | 玻璃拟态 | 深夜电台 | 夜航电台 | [10c-radio.html](10c-radio.html) |

## 第 3 期

| 编号 | 风格 | 行业 | 品牌（虚构） | 文件 |
|---|---|---|---|---|
| 11a | 包豪斯 | 设计工作室 | 方寸设计 | [11a-studio.html](11a-studio.html) |
| 11b | 包豪斯 | 几何家居 | 几何物 | [11b-furniture.html](11b-furniture.html) |
| 11c | 包豪斯 | 画廊展览 | 白盒子画廊 | [11c-gallery.html](11c-gallery.html) |
| 12a | 合成波 VHS | 复古Livehouse | 午夜磁带 | [12a-livehouse.html](12a-livehouse.html) |
| 12b | 合成波 VHS | 汽车改装洗车 | 霓虹车坊 | [12b-carwash.html](12b-carwash.html) |
| 12c | 合成波 VHS | 潮玩复古游戏厅 | 星际电玩城 | [12c-arcade.html](12c-arcade.html) |
| 13a | 像素 | 独立游戏工作室 | 八位元工作室 | [13a-studio.html](13a-studio.html) |
| 13b | 像素 | 少儿编程 | 小码星球 | [13b-coding.html](13b-coding.html) |
| 13c | 像素 | 奶茶会员积分 | 茶小满 | [13c-milktea.html](13c-milktea.html) |
| 14a | 液态金属 | 珠宝首饰 | 素银 | [14a-jewelry.html](14a-jewelry.html) |
| 14b | 液态金属 | 高端护肤精华 | 澄露 | [14b-serum.html](14b-serum.html) |
| 14c | 液态金属 | 精酿啤酒 | 铁锚精酿 | [14c-beer.html](14c-beer.html) |
| 15a | 综艺花字 | 街边小炒探店 | 火候小炒 | [15a-stirfry.html](15a-stirfry.html) |
| 15b | 综艺花字 | 农产品直播带货 | 橙心果园 | [15b-livestream.html](15b-livestream.html) |
| 15c | 综艺花字 | 驾校 | 安心驾校 | [15c-driving.html](15c-driving.html) |

## 第 4 期

| 编号 | 风格 | 行业 | 品牌（虚构） | 文件 |
|---|---|---|---|---|
| 16a | 真实页面 2.5D | SaaS官网 | 客满云 CRM | [16a-saas.html](16a-saas.html) |
| 16b | 真实页面 2.5D | 电商详情页 | 轻野户外 | [16b-ecom.html](16b-ecom.html) |
| 16c | 真实页面 2.5D | 招聘小程序 | 好职通 | [16c-jobs.html](16c-jobs.html) |
| 17a | 数据新闻 | 财税记账 | 明账财税 | [17a-tax.html](17a-tax.html) |
| 17b | 数据新闻 | 体检报告 | 安康体检 | [17b-health.html](17b-health.html) |
| 17c | 数据新闻 | 门店数据 | 小店参谋 | [17c-store.html](17c-store.html) |
| 18a | 水墨国风 | 茶庄 | 云岫茶庄 | [18a-tea.html](18a-tea.html) |
| 18b | 水墨国风 | 中医馆 | 仁和堂 | [18b-tcm.html](18b-tcm.html) |
| 18c | 水墨国风 | 古镇文旅 | 青溪古镇 | [18c-town.html](18c-town.html) |
| 19a | 黏土定格 | 亲子手工坊 | 小泥巴手作 | [19a-craft.html](19a-craft.html) |
| 19b | 黏土定格 | 烘焙蛋糕 | 糖果屋烘焙 | [19b-cake.html](19b-cake.html) |
| 19c | 黏土定格 | 宠物用品 | 毛球宠物 | [19c-pet.html](19c-pet.html) |
| 20a | 蓝图 → 实物 | 全屋定制 | 木作家 | [20a-home.html](20a-home.html) |
| 20b | 蓝图 → 实物 | 工业零件 | 精工机械 | [20b-parts.html](20b-parts.html) |
| 20c | 蓝图 → 实物 | 智能硬件 | 安心智能锁 | [20c-lock.html](20c-lock.html) |

## 用到的工具包（`lib/`）

`toon.js` 剧情动画 · `morph.js` 粒子形变 · `sticker.js` 贴纸 · `hud.js` 点云 + HUD · `collage.js` / `collage-parts.js` 拼贴（纸张高度场打光）· `glass.js` 液态玻璃 · `plates.js` 包豪斯薄板 · `retro.js` 合成波 · `pixel.js` 像素 · `chrome.js` 液态金属 · `variety.js` 综艺花字 · `inkwash.js` 水墨（墨晕、朱砂印、手卷桌面）· `clay.js` 黏土定格（物体列表 + 光线包围球筛选）· `blueprint.js` 蓝图（自动描线、剖面线、扫描线转实物、标注叠层）

成片（原画质 mp4）在仓库的 Releases 页面下载。

作者：肖雄 XIAOXIONG · MIT 协议（可免费用、改、商用，转载或二次分发请保留署名）
