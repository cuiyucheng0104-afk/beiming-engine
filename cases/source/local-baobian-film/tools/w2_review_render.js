export const meta = {
  name: 'baobian-w2-build-review-render',
  description: '《豹变》四版：A 版补搭 → 三视角评审 → 返修 → 对抗复核（不达交付线再修，最多三轮）→ 5090 出片 → 成片终检 → 四版横评',
  phases: [
    { title: 'Build', detail: 'A 水墨补搭（上一轮搭建代理中途断网，只留下 lib/ 半成品）' },
    { title: 'Review', detail: '画风 / 叙事镜头 / 技术三个视角，各自在 5090 上渲图审' },
    { title: 'Fix', detail: '合并问题单逐条返修，门禁重新全绿' },
    { title: 'Verify', detail: '对抗式复核，按交付线判定' },
    { title: 'Render', detail: '5090 渲整片、配乐对位、封装' },
    { title: 'QA', detail: '从成片抽帧终检' },
    { title: 'Compare', detail: '四版横评与交付说明' },
  ],
}

const ROOT = '@@CASE_ROOT@@'
const VERSIONS = [
  { key: 'A_shuimo', name: 'A 水墨', build: true },
  { key: 'B_zhuangshi', name: 'B 装饰' },
  { key: 'C_qitan', name: 'C 奇谭' },
  { key: 'D_wushan', name: 'D 雾山' },
]
// 第一轮搭建者自报的剩余问题（B、C、D），A 版由本工作流里的补搭给出
const SELF_ISSUES = {"B_zhuangshi": [{"id": "self-01", "level": "P2", "time": "0.0–3.4 s、27.4–30.0 s", "problem": "S1、S6 里 3D 的书桌、书和器物（砚、笔架、纸叠）还有一点柔和渐变的“渲染感”，不如壁画平涂干脆。改法：桌面和书页的二档再硬一些、渐变再压平，器物只留一档。", "fix": "改法：桌面和书页的二档再硬一些、渐变再压平，器物只留一档。"}, {"id": "self-02", "level": "P2", "time": "10.8–14.3 s", "problem": "集市底板 A16 是生图，用 Kuwahara 抹过以后仍有一点通用“国风插画”味。前景的幡、剪影、假光轮、面具都是代码和 3D 做的，能撑住画风，但后景偏甜。", "fix": "（见问题描述）"}, {"id": "self-03", "level": "P2", "time": "23.6–24.4 s（f567–f586）", "problem": "S5b 到 S5c 的“化开”用的遮罩边缘是 fbm 斑块，已经改成自右向左推进，但单帧看还是有点碎。可以换成横向的绢纹洇边，或者加一道墨晕前沿。", "fix": "（见问题描述）"}, {"id": "self-04", "level": "P2", "time": "1.5–1.85 s（f36–f44）", "problem": "S1 食指尖的墨渍落在 A 点（实测约 1190,590），但直径只有约 20 px，看得清，不算醒目。可以把手再推近 10%，或者把墨渍放大到 1.4 倍。", "fix": "（见问题描述）"}, {"id": "self-05", "level": "P3", "time": "7.8–10.8 s", "problem": "S2 的鹿群只有 52 px 高，在雾带里要注意看才能发现。", "fix": "（见问题描述）"}, {"id": "self-06", "level": "P3", "time": "20.25 s（f486）", "problem": "S4d 豹子从蹲换成坐是硬换图（设计里就是这样，带 4% 的压扁和拉长），会有一下跳。", "fix": "（见问题描述）"}, {"id": "self-07", "level": "P3", "time": "24.2–26.4 s", "problem": "S5c 里豹子在长卷中偏小（约 200 px），#8 画面略空。", "fix": "（见问题描述）"}, {"id": "self-08", "level": "P3", "time": "3.9–4.25 s（f94–f102）", "problem": "T1 金条正在弯成环的那几帧互相穿插，单帧看略乱（已经分层，不会打架）。动起来读得出“卷成光轮”。", "fix": "（见问题描述）"}, {"id": "self-09", "level": "P3", "time": "26.9–27.6 s", "problem": "P_g 按 A09 的实测锚点落在 (1016,330)，不是设计写的 (1040,410)。T2 豹眼高光已经同步放到这一点，两边十字交点只差 3 px，匹配剪辑成立。评审要是坚持 (1040,410)，需要同时移 S6 机位和背影。", "fix": "（见问题描述）"}], "D_wushan": [{"id": "self-01", "level": "P1", "time": "3.5–4.96 s（T1，f84–f118）", "problem": "BRIEF 要求的「横画变成远山的地平线」只读出一半。前半段（六爻浮起成云带、镜头钻进上六断口、纸纤维闪、穿两层纸云）都成立；但下坠和拉平这一段，五爻落成山谷里五层横带这件事不清楚：画面主要是雾和云海，只有六二、九四两排云带从平铺转为立起，九五靠底板的天际线来承担。DESIGN 第七节第 5 项的 3D 中景山脊（九三）在搭建时被我去掉了。改法：把九三的 3D 脊线加回来，五层云带的屏幕间距按 DESIGN 4.4 的表排齐，f106–f114 让横带一条接一条进画。", "fix": "改法：把九三的 3D 脊线加回来，五层云带的屏幕间距按 DESIGN 4.4 的表排齐，f106–f114 让横带一条接一条进画。"}, {"id": "self-02", "level": "P1", "time": "20.58–21.54 s（#13）", "problem": "和 ref_03 并排看（_work/compare/s5_vs_ref.jpg）差距明显：天空是一整片平涂的黄，崖顶是一整块平的黑剪影，缺少 ref_03 那种层层递进的金色逆光、暖褐色岩层、亮雾和崖沿的细节，画风还原不足。改法：天空做成从太阳向外的金→赭渐变，再叠金雾带；崖顶岩台加岩层台阶的折痕线和一层受光的暖赭顶面；远景云海加暖色层次。", "fix": "改法：天空做成从太阳向外的金→赭渐变，再叠金雾带；崖顶岩台加岩层台阶的折痕线和一层受光的暖赭顶面；远景云海加暖色层次。"}, {"id": "self-03", "level": "P2", "time": "21.54–23.08 s（#14）", "problem": "新机位在豹的侧下方空中，画面里看不到起跳用的崖顶，起跳读起来像豹已经在空中；穿云之前大片空天。改法：f517–f524 让崖顶岩台留在画面下沿，或者把相机放低一点，带进崖沿。", "fix": "改法：f517–f524 让崖顶岩台留在画面下沿，或者把相机放低一点，带进崖沿。"}, {"id": "self-04", "level": "P2", "time": "23.08–24.8 s（#15 三维段）", "problem": "圆顶山峰虽然加了折皱、竖皴、点苔和金边，形状还是偏几何、像锥体，比 ref_04 的山更硬、更像 3D。改法：加大方位角折皱的幅度，山脚多叠几层雾带，近景峰做成不规则的多峰。", "fix": "改法：加大方位角折皱的幅度，山脚多叠几层雾带，近景峰做成不规则的多峰。"}, {"id": "self-05", "level": "P2", "time": "7.5–10.58 s、18.0–20.58 s（#04 / #12）", "problem": "洞口暗拱是一整圈程序生成的暗块，岩石细节少；拱外的远山底板在雨雾里还有轻微的彩虹偏色（底板本身的群青和石绿被雾一混就发虹）。另外 #04 统计里青色只占彩色的 9%，原因是洞拱用的是蓝黛色。", "fix": "（见问题描述）"}, {"id": "self-06", "level": "P2", "time": "12.92–13.92 s（#08 转身入雾）", "problem": "雾墙远端和雾的尽头之间还有一条偏直的地平线；石板纹样偏规整；整段画面偏空，「转身走回雾里」主要靠影子和调色来讲。", "fix": "（见问题描述）"}, {"id": "self-07", "level": "P2", "time": "14.5–16.62 s（#10）", "problem": "灰豹是精灵放大再加景深，近看发软；墨滴和指尖墨渍在 1080 下偏小；袖子是简单的 3D 圆柱。", "fix": "（见问题描述）"}, {"id": "self-08", "level": "P2", "time": "27.17–30.0 s（S6）", "problem": "为了不让精灵的下沿露出来，拉镜只拉到 1.40 m（设计是 1.65 m），中景不够开；衬衫上的光斑虽然已经改成叶缝门控加暖色提亮，仍然有一点「印花」感。", "fix": "（见问题描述）"}, {"id": "self-09", "level": "P2", "time": "20.58–23.08 s", "problem": "豹的动作只靠网格形变加少量姿态换图：#13 的蓄力、#14 的起跳都偏僵，起跳伸展的动作幅度不够「燃」。", "fix": "（见问题描述）"}, {"id": "self-10", "level": "P3", "time": "28.62–29.8 s", "problem": "题字全部显出后只停留约 1.3 秒就开始淡出，读得完，但偏短。", "fix": "（见问题描述）"}, {"id": "self-11", "level": "P3", "time": "21.9–26.5 s", "problem": "尾迹墨点是在屏幕空间画的：从尾根落下后向右漂成一道弧，化开前后的口径一致，但在三维段里没有透视。", "fix": "（见问题描述）"}, {"id": "self-12", "level": "P3", "time": "全片", "problem": "画面统计和 DESIGN 2.3 的目标有偏差：#01 浓墨 6.8%（目标 10–25%），#13 金色高彩 73%（目标 35–65%），#12 收尾金色 1.2%（目标 8–20%），#12、#15 留白偏多。", "fix": "（见问题描述）"}], "C_qitan": [{"id": "self-01", "level": "P2", "time": "20.1–23.6 s（S5a）", "problem": "云海上的画面偏亮，暗部少。中位明度约 205，DESIGN 2.6 的目标是 150–185。只把云和天顶的颜色压了一档。改法：再压暗云海的受光色和地平色，或者在 S5 的调色里降一点曝光。", "fix": "改法：再压暗云海的受光色和地平色，或者在 S5 的调色里降一点曝光。"}, {"id": "self-02", "level": "P2", "time": "1.29–1.79 s（S1b，f31–f43）", "problem": "拿眼镜的手 A12 按设计一拍二走三档，但离镜头很近，换档时跳得大（f41→f42 相邻帧平均差 20.9），看着发顿。改法：这只手单独改成一拍一，或者档与档之间加拖影。", "fix": "改法：这只手单独改成一拍一，或者档与档之间加拖影。"}, {"id": "self-03", "level": "P2", "time": "12.25–13.83 s（S3b、S3c）", "problem": "金面具的朱妆、白线、诡笑都是在 UV 上画的，近看边缘有贴图感，和 ref_07 首格手绘勾脸的笔意比还差一截。", "fix": "（见问题描述）"}, {"id": "self-04", "level": "P3", "time": "4.8–11.0 s、18.25–20.1 s（S2a、S4c）", "problem": "人物和豹身后按设计加了白色轮廓辉光（α .10），衬在黑洞口前略有贴片的光晕感。改法：可以降到 .05，或者只在背光一侧加。", "fix": "改法：可以降到 .05，或者只在背光一侧加。"}, {"id": "self-05", "level": "P3", "time": "4.8–8.8 s（S2a）", "problem": "松针簇是 Canvas 笔触卡片，近看能分出一片一片，笔意弱于参考里手绘的松。", "fix": "（见问题描述）"}, {"id": "self-06", "level": "P3", "time": "28.2–29.6 s（S6 字幕）", "problem": "「豹变」在志莽行书里是草写字形，小字号下不太好认。这是字体本身的字形，没有换。", "fix": "（见问题描述）"}, {"id": "self-07", "level": "P3", "time": "27.8–29.6 s（S6）", "problem": "种子 7 那枚光斑落在他手上，已经不被叶团遮挡、半径也加到 40K，但环还是偏淡，要看大图才认得出它和墨环、豹斑是同一个形状。", "fix": "（见问题描述）"}, {"id": "self-08", "level": "P3", "time": "1.2–1.75 s（S1b）", "problem": "A10 头肩卡在 f43 之前用 Canvas 补掉了眼镜，但耳垂下面还残留一小段铜色弧线，很不显眼。", "fix": "（见问题描述）"}, {"id": "self-09", "level": "P3", "time": "4.8–8.8 s（S2a）", "problem": "鹿 A16 背上画了白色梅花鹿斑。混雾 42% 之后基本看不见，没有另做处理。", "fix": "（见问题描述）"}]}
// 主会话中期检查看门禁静帧时提的问题
const MAIN_NOTES = {"B_zhuangshi": [{"id": "main-01", "level": "P1", "time": "7.5–10.8 s（S2）、18.0–21.5 s、24.2–26.4 s、26.9 s（T2 豹头特写）", "where": "豹子全身与豹头特写", "problem": "豹子读不成「灰色小豹」：S2 里是细长四肢、细长身子、小尖脑袋的成年体型，像灵缇或黄鼠狼；T2 的豹头特写耳内粉红、长尖吻、窄脸，读起来像老鼠或狐狸。豹是主角，认不出是豹会直接伤叙事。", "fix": "按幼豹重新定造型：头大而圆，吻短而宽，有猫鼻和胡须点；耳朵小而圆，耳内不用粉红（用赭石或土黄）；四肢短粗，尾巴粗长带环纹。九色鹿式的修长勾线和平涂可以保留。先用 Magpie 重出豹的设定图，再拿设定图当参考重出 S2、S4、S5、T2 用到的各个姿态，同步更新 manifest 和代码里的锚点。", "evidence": "films/B_zhuangshi/_work/gate/main/s_7.5.jpg、s_26.9.jpg"}, {"id": "main-02", "level": "P1", "time": "15.0–19.5 s（S4 特写段）", "where": "全画面", "problem": "S4 特写里，豹背是一块带棕色轮廓的灰色平面，上面铺满一朵朵四瓣灰花，中间的墨团带尖刺，像病毒或海胆；看不出这是豹背，也不美。这一段是全片核心，任务书要求最慢最美。", "fix": "先交代空间：给一个能认出是豹背或豹肩的中近景（带上头颈或耳朵的轮廓、毛的走向），再推到特写。墨滴落下后用柔和的洇墨边晕开，不要尖刺，收紧成环斑的过程放慢。旧斑像没干的墨，颜色和形状要和新环斑分得开。去掉斑点上的小水滴尾巴。", "evidence": "films/B_zhuangshi/_work/gate/main/s_16.5.jpg、s_18.0.jpg"}, {"id": "main-03", "level": "P2", "time": "7.5–10.8 s（S2）", "where": "左上的松树", "problem": "松针画成一个个圆盘，像蒲公英或海胆，有装饰感，但不像松。", "fix": "参考 refs 里的松：松针画成扇形针簇，簇要有方向和疏密层次，平涂和勾线保留。", "evidence": "films/B_zhuangshi/_work/gate/main/s_7.5.jpg"}], "C_qitan": [{"id": "main-01", "level": "P1", "time": "4.1–11.6 s（S2），以及之后远景里出现这座山的地方", "where": "背景远山", "problem": "远山是一座孤立、左右对称的圆锥形山，配上平铺的云海，读起来像富士山。这是日本符号，和「南山」对不上，也偏离了中国奇谭的参考。", "fix": "改成中国山水的山形：多峰、不对称，有主峰和次峰，有山脊走向；可以叠两三层错落的峰峦（参考 refs/C_qitan 里的山和远景）。保持低饱和和雾的分层。", "evidence": "films/C_qitan/_work/gate/main/s_4.6.jpg、s_5.5.jpg"}, {"id": "main-02", "level": "P1", "time": "9.5–11.6 s，19.5 s，20.8–26.4 s", "where": "小豹", "problem": "小豹读起来像小熊或泰迪熊：圆耳、圆脸、闭眼弯眉，身上的斑又淡，猫科特征不够。", "fix": "保留中国奇谭式的圆润和萌，但要加上猫科特征：脸略宽扁，吻部有猫鼻和人中，加胡须点，眼睛用猫眼。变身前的斑要像没干的墨：深一些、湿一些、边缘洇开。尾巴要露出来，而且粗长。改资产时先出设定图，再出其余姿态。", "evidence": "films/C_qitan/_work/gate/main/s_9.5.jpg"}, {"id": "main-03", "level": "P2", "time": "15.0–18.0 s（S4 特写）", "where": "全画面", "problem": "特写里只有灰色毛面上的墨团和环斑，看不出这是豹背，空间没有交代。", "fix": "特写之前先给一个能认出豹背或豹肩的中近景，或者在特写画面边缘留出耳朵、脊线和毛的走向。墨滴从晕开到收紧成环的过程放慢。", "evidence": "films/C_qitan/_work/gate/main/s_15.0.jpg、s_16.5.jpg"}, {"id": "main-04", "level": "P3", "time": "全片", "where": "颗粒层", "problem": "评审前出的第一版成片 out/v1/豹变_C_qitan_v1.mp4 有 159 MB（约 42 Mbps），另外三版只有 41–45 MB。码率主要被每帧都变的细颗粒吃掉，发给手机看和在线播放都吃力，压缩后颗粒也会糊成噪点。", "fix": "降低颗粒强度或把颗粒尺度放大一档，颗粒图案可以一拍二（每 2 帧换一次）；改完先渲相邻帧确认颗粒仍然自然，再交给渲染出片。", "evidence": "out/v1/豹变_C_qitan_v1.mp4"}], "D_wushan": [{"id": "main-01", "level": "P3", "time": "7.5–20.6 s", "where": "豹子", "problem": "豹子坐着时头顶和陆蔚的肩差不多高，体型接近成年豹；任务书写的是小豹，这是一个「长大、长出文采」的故事。", "fix": "不重做资产的话，把豹缩到陆蔚坐姿的肩下，或者在 S2 里放得离镜头更远；如果要重出姿态，按亚成年豹的比例（头大一点、腿粗一点）。", "evidence": "films/D_wushan/_work/gate/main/s_9.5.jpg、s_18.0.jpg"}]}

const AUDIO = (v) => `配乐对位口径：成片第 t 秒对应配乐文件第 t + offset 秒，offset 以 films/${v.key}/audio.json 为准（写的是 anchor 就用 .venv/bin/python tools/audio_align.py audio/${v.key}.wav --anchor <anchor> 算；没有 audio.json 就按 anchor 21.0 算）。audio/${v.key}_report.txt 第一行写着它是按哪个截取起点算的；和实际 offset 不一致时，用 .venv/bin/python tools/audio_report.py audio/${v.key}.wav --offset <offset> --png films/${v.key}/_work/audio_curve.png > films/${v.key}/_work/audio_report.txt 重出一份再用。`

const HEAD = (role, v) => `你是《豹变》项目的子代理。角色：${role}；负责版本：${v.name}（目录 ${ROOT}/films/${v.key}/）。工程根目录 ${ROOT}。
开工前必须通读：${ROOT}/SUBAGENT_STANDARD.md（规范，逐条遵守）、${ROOT}/BRIEF.md、${ROOT}/films/${v.key}/STYLE.md、${ROOT}/films/${v.key}/DESIGN.md、${ROOT}/films/${v.key}/NOTES.md（如果已经有）。参考静帧在 ${ROOT}/refs/${v.key}/（总览 ${ROOT}/refs/${v.key}_board.jpg）。全程中文。
${AUDIO(v)}`

// 代理没有返回结果（多半是网络断了）时重跑一次，让它接着上一位的进度做
async function run(prompt, opts) {
  const r = await agent(prompt, opts)
  if (r) return r
  log(`${opts.label} 没有返回结果，重跑一次`)
  return agent(`${prompt}

（接手说明：上一位担任这个角色的代理中途断开了，可能已经改过一部分文件、渲过一部分图。先看现有文件、NOTES.md 和 _work/ 里的东西，再接着做完。）`, { ...opts, label: `${opts.label}:retry` })
}

const BUILD = (v) => `${HEAD('搭建（Builder）', v)}

按 ${ROOT}/films/${v.key}/DESIGN.md 和 ${ROOT}/films/${v.key}/assets/manifest.json，在 ${ROOT}/films/${v.key}/ 里写出完整的 30 秒影片（index.html 和 JS）。
先读：engine/render/page.mjs（页面约定）、films/_gatetest/index.html（最小示例）、films/_lib/（可以拷贝改用）、assets/ 里的每一张图（用 Read 看）。

接手说明：
- 上一位搭建代理写完 lib/ 下 6 个模块（core.js、draw2d.js、glsl.js、inklook.js、inkwash.js、sprite.js）后，因为 API 网络错误中断了：shots/ 是空的，没有 index.html 和 NOTES.md，也没在 5090 上渲过任何东西。lib/ 里的代码先通读，合格就接着用，不合格就改或重写，不要盲信。
- B、C、D 三版已经搭完并过了门禁，可以读它们的代码学做法（只读，不要改），例如 ${ROOT}/films/D_wushan/main.js 的镜头调度、${ROOT}/films/C_qitan/js/ 的后期管线。
- 主会话已经定了下面几件事，照此执行：
  1. 人物线条：同意定稿方案。陆蔚的手和背影按参考画细墨线加淡彩；动物、山石、树保持没骨。
  2. 书页上的「革」字作卦名：同意。
  3. S4 手特写用右手 assets/hand_rain_cu_right.png（A07-R），墨渍始终在右手食指上，和 S1、S3c、S6 连续；左手版 A07 不用。
  4. S1 的手建议用 A06-S1a–d（hand_s1_*.png）：不用旋转、不用接袖子，放大约 0.9 倍。最终由你定。
  5. assets/ 里的两张遗留废图（luwei_desk_back.png、scroll_a.png）已经移到 _work/asset_rejected/，manifest 里这两条已删掉，不要用。
- 资产代理留给搭建的提醒：
  - A03 豹头特写：近眼瞳心在 (638,409)，虹膜半径约 59。要把眼心放到 P=(650,372)、又不露出左边和下边的墨块图边，缩放要 ≥1.26（DESIGN 原估 1.15）。
  - A10 长卷：已裁成 4:1（2172×543），上下边渐变到纸白。画面几乎是纯墨色，淡彩要靠着色器加。右侧山体偏暗，尾迹墨点落在上面不明显，可以微调底板位置，让墨点走在雾区。
  - A02 的切分框互相重叠，要用拆好的单张 cub_poses_pose1–4.png；单张坐标 = 表坐标 − offset_in_sheet。
  - 放大倍数：A01 在 S4 近景约 1.36 倍，A08 约 1.47 倍。
  - 锚点是看网格手量的，误差约 ±5–10 px，要在 5090 静帧上复核。

要求：
- 严格按定稿设计和任务书做。三渲二要有真实的 3D 层和视差。转场按设计实现。所有尺寸乘以 K = H/1040。render(t) 必须是确定性的。
- 迭代方法：每做完一两个镜头，就用 sh tools/rog_stills.sh films/${v.key} --range <这段的起止>:0.25 --tag <名字> 在 5090 上渲出来，用 Read 看 sheet.jpg 和关键大图，对照 DESIGN 和参考静帧（tools/compare.py 并排比）。看到问题马上改。整片至少完整过三轮"渲 → 看 → 改"。
- 每轮都要检查：
  - 画风像不像参考；
  - 这段在演什么，一眼能不能看懂；豹子要一眼认得出是豹（不能像猫、狗、熊、鼠）；
  - 有没有贴片边缘、拉伸、白边、黑块、穿帮；
  - 相邻帧之间有没有闪烁（渲相邻的 1/24 秒对比）；
  - 字幕对不对、是不是竖排书法。
- 最后跑 sh tools/gate.sh films/${v.key}，必须全部 PASS；不通过就改到通过。
- 写 NOTES.md（内容按 BRIEF 第四节，"已知不足"要诚实）。如果要调整配乐的截取起点或锚点，写 audio.json。
只改 films/${v.key}/。汇报要用结构化字段，写清门禁结果和证据路径；六项自评分数要诚实，按规范第四节的口径；剩余问题按 P0–P3 列出。`

const SCORES = { type: 'object', properties: { style: { type: 'number' }, toon: { type: 'number' }, story: { type: 'number' }, camera: { type: 'number' }, composition: { type: 'number' }, clean: { type: 'number' } }, required: ['style', 'toon', 'story', 'camera', 'composition', 'clean'] }

const BUILD_SCHEMA = {
  type: 'object',
  properties: {
    gate_pass: { type: 'boolean' },
    gate_report: { type: 'string' },
    sheet: { type: 'string' },
    self_scores: SCORES,
    issues: { type: 'array', items: { type: 'object', properties: { level: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] }, time: { type: 'string' }, problem: { type: 'string' }, fix: { type: 'string' } }, required: ['level', 'problem'] } },
    summary: { type: 'string' },
  },
  required: ['gate_pass', 'gate_report', 'sheet', 'self_scores', 'issues', 'summary'],
}

const LENSES = [
  { id: 'style', zh: '画风还原与三渲二质感', how: `重点是"像不像"。对每个段落至少挑一张本片大图，用 tools/compare.py 和 2–3 张最接近的参考静帧并排比；再用 tools/palette.py 对比色板。逐条指出差在哪里：造型（尤其是豹和人物）、线、色、留白、肌理、3D 层是否露出塑料感、底板与 3D 是否融合。` },
  { id: 'story', zh: '叙事、镜头、转场与节奏', how: `重点是"看不看得懂、好不好看"。先装作没读过任务书，只看 0–30 秒每 0.5 秒一帧的接触印样，写下你以为每段在演什么、豹子是不是一眼认得出是豹，再和分镜对照。逐个检查：墨渍→豹斑→光斑母题是否成立；T1、S3 眼孔、T2 三处转场——渲转场前后各 1 秒、每 1/24 秒一帧，看过程是否成立；镜头运动；节奏；关键动作有没有踩在音乐点上（按上面的配乐口径换算时间）；片尾字幕。` },
  { id: 'tech', zh: '技术干净与稳定', how: `重点是"有没有毛病"。找穿帮：贴片边缘、白边、黑块、拉伸、穿模、裁切、闪烁。渲几组相邻帧（相差 1/24 秒）对比；4K 抽两帧（--size 3840x2080）看线宽和字是否按比例；查人物有没有正脸、有没有品牌或乱码文字、字幕字是否正确；看代码里有没有不确定性隐患；记录 5090 每帧耗时。` },
]

const REVIEW = (v, l) => `${HEAD(`评审（${l.zh}）`, v)}

你只从「${l.zh}」这个视角挑问题，默认至少能找出 6 个。${l.how}
自己在 5090 上渲图来审，不要信别人的截图：sh tools/rog_stills.sh films/${v.key} --range 0:29.5:0.5 --tag review_${l.id}，再按需要补渲细节（--tag review_${l.id}_x）。所有判断都要用 Read 亲眼看过图。
每个问题都要写：编号（${l.id}-01 起）、级别（P0–P3，口径见规范第四节）、时间点、画面位置、问题、原因、具体改法、证据图路径。
六项打分（1–10，口径见规范第四节）：你的视角相关的那几项要认真打，其余可以给出参考分。`

const ISSUE = { type: 'object', properties: {
  id: { type: 'string' }, level: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] }, time: { type: 'string' }, where: { type: 'string' },
  problem: { type: 'string' }, fix: { type: 'string' }, evidence: { type: 'string' } }, required: ['id', 'level', 'time', 'problem', 'fix'] }

const REVIEW_SCHEMA = {
  type: 'object',
  properties: { scores: SCORES, issues: { type: 'array', items: ISSUE }, summary: { type: 'string' } },
  required: ['scores', 'issues', 'summary'],
}

const FIX = (v, round, issues) => `${HEAD(`返修（第 ${round} 轮）`, v)}

下面是本轮要处理的问题单（JSON）。编号 main- 开头的是主会话中期检查看片时提的，self- 开头的是搭建者自己报的已知不足，v<轮次>- 开头的是上一轮复核新发现的，其余来自三位评审：
${JSON.stringify(issues)}
要做的事：
1. 先合并重复的问题，按 P0 → P1 → P2 → P3 排序。P0 和 P1 必须全部修好；P2 尽量修；P3 有余力再修。同一条修了两次还没改好，就换思路或降级处理，并在返修记录里写明。
2. 每修一批，就用 sh tools/rog_stills.sh films/${v.key} ... --tag fix${round}_<名字> 在 5090 上渲出相关时刻，用 Read 亲眼确认已经改好，而且没有改坏别的地方。
3. 需要重出资产时，用 Magpie（规范第二节第 10 条）：角色先出设定图，再拿设定图当参考出其余姿态；新图用 Read 看过、透明底查过，再更新 manifest.json 和代码里的锚点。也可以用 tools/rog_music.sh 重做配乐；改了 audio.json 或配乐，就按配乐口径重出 _work/audio_report.txt。
4. 最后跑 sh tools/gate.sh films/${v.key}，必须全部 PASS。再渲一张整片的接触印样：--range 0:29.5:0.5 --tag fix${round}_final。
5. 在 NOTES.md 的「返修记录」里，逐条写问题编号、处理结果（已修 / 部分修 / 未修）、怎么改的、证据图路径；未修的写明原因。
只改 films/${v.key}/（配乐只改 audio/${v.key}*）。汇报：逐条处理结果、门禁结果、整片印样路径。`

const FIX_SCHEMA = {
  type: 'object',
  properties: {
    gate_pass: { type: 'boolean' },
    sheet: { type: 'string' },
    results: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', enum: ['fixed', 'partial', 'not_fixed'] }, how: { type: 'string' }, evidence: { type: 'string' } }, required: ['id', 'status', 'how'] } },
    summary: { type: 'string' },
  },
  required: ['gate_pass', 'sheet', 'results', 'summary'],
}

const VERIFY = (v, round, issues, fix) => `${HEAD(`复核（对抗式，第 ${round} 轮）`, v)}

返修声称做了这些（JSON）：
${JSON.stringify(fix)}
原问题单（JSON）：
${JSON.stringify(issues)}
你的立场：默认不相信"已修"。逐条在 5090 上重新渲相关时刻（sh tools/rog_stills.sh films/${v.key} <时刻...> --tag verify${round}_<编号>），亲眼核实，给出结论：resolved（确实修好）、unresolved（没修好或修得不对）、regressed（改出了新问题）。原问题单里的每一条都要有结论，main- 和 self- 开头的也一样。
然后用 --range 0:29.5:0.5 --tag verify${round}_full 渲一张整片接触印样，再从头挑新问题（新问题编号写成 v${round}-01 这样）。
最后跑 sh tools/gate.sh films/${v.key}，核对门禁。
按规范第四节给六项打分（1–10），打分前把本片大图和参考静帧并排比过。交付线：六项都在 8 分以上，门禁全部通过，并且没有剩余的 P0 或 P1。达到才算 pass=true。分数要诚实，宁严勿松。`

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    gate_pass: { type: 'boolean' },
    scores: SCORES,
    verdicts: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, verdict: { type: 'string', enum: ['resolved', 'unresolved', 'regressed'] }, note: { type: 'string' } }, required: ['id', 'verdict'] } },
    new_issues: { type: 'array', items: ISSUE },
    summary: { type: 'string' },
  },
  required: ['pass', 'gate_pass', 'scores', 'verdicts', 'new_issues', 'summary'],
}

const RENDER = (v) => `${HEAD('渲染（Renderer）', v)}

执行正式出片：cd ${ROOT} && sh tools/finish.sh ${v.key}
这个脚本会依次做这些事：
- 整片渲染全局排队（另一版在渲时它会等锁）；
- 增量同步到 5090，用 6 个 worker 渲 720 帧（渲染期间持有本片的锁）；
- 配乐对位后截取 30 秒；
- 封装成 out/豹变_${v.key}.mp4，并写 out/check_${v.key}/report.txt 和 tile.jpg。
Bash 单次最长 10 分钟：用 run_in_background 跑，等完成通知；或者把超时设成 600000，超时后接着查进度。
如果失败，读报错：页面在 5090 上报错、超时之类的问题，可以改 films/${v.key}/ 里的代码，改完重跑门禁和 finish。不要改 tools/ 和 engine/，不要动 5090 上别人的进程。
完成后核对 report.txt：nb_read_frames=720、duration=30.000、I 在 −14 LUFS 左右、无长黑场。再用 Read 看 tile.jpg。`

const RENDER_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, mp4: { type: 'string' }, frames: { type: 'number' }, duration: { type: 'number' }, lufs: { type: 'string' }, render_seconds: { type: 'string' }, notes: { type: 'string' } },
  required: ['ok', 'mp4', 'notes'],
}

const QA = (v) => `${HEAD('终检（Final QA）', v)}

成片是 ${ROOT}/out/豹变_${v.key}.mp4，已经封装好，不要再改影片代码。
1. 用 ffmpeg 从成片里每 0.5 秒抽一帧，拼成 out/check_${v.key}/qa_sheet.jpg（可以用 tools/sheet.py；抽帧文件命名成 s_<秒>.jpg）。逐格用 Read 看。再抽 6 张全尺寸大图，看细节。
2. 和 films/${v.key}/_work/gate/main/ 里同一时刻的门禁静帧对比，确认成片和门禁时的画面一致：没有编码块、色偏或掉帧。
3. 查声音：ffmpeg 的 ebur128 和 astats 看响度、峰值、开头和结尾的淡入淡出；按配乐口径核实关键动作是不是踩在了音乐点上。
4. 如果 out/v1/ 里有这一版评审前的第一版（豹变_${v.key}_v1.mp4），抽同样的时刻对比，写清返修前后的变化。
5. 写 out/check_${v.key}/QA.md，内容包括：逐段的观感、剩余瑕疵（按 P0–P3）、六项打分、一句话卖点（这版最打动人的地方）。`

const QA_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, scores: SCORES, remaining: { type: 'array', items: ISSUE }, pitch: { type: 'string' }, summary: { type: 'string' } },
  required: ['ok', 'scores', 'remaining', 'pitch', 'summary'],
}

const MAX_ROUNDS = 3
const asSelf = (list) => (list || []).filter(i => ['P0', 'P1', 'P2', 'P3'].includes(i.level)).map((i, k) => ({ id: `self-${String(k + 1).padStart(2, '0')}`, level: i.level, time: i.time || '', problem: i.problem, fix: i.fix || '（见问题描述里的改法）' }))

const results = await pipeline(
  VERSIONS,
  async (v) => {
    if (!v.build) return { build: null, self: SELF_ISSUES[v.key] || [] }
    const b = await run(BUILD(v), { label: `build:${v.key}`, phase: 'Build', schema: BUILD_SCHEMA })
    if (!b) throw new Error(`${v.key} 补搭两次都没有结果`)
    if (!b.gate_pass) log(`${v.key} 补搭结束但门禁没全过，交给返修继续`)
    return { build: b, self: asSelf(b.issues) }
  },
  (prev, v) => parallel(LENSES.map(l => () => run(REVIEW(v, l), { label: `review:${v.key}:${l.id}`, phase: 'Review', schema: REVIEW_SCHEMA })))
    .then(reviews => ({ ...prev, reviews: reviews.filter(Boolean) })),
  async (prev, v) => {
    let issues = prev.reviews.flatMap(r => r.issues).concat(prev.self, MAIN_NOTES[v.key] || [])
    log(`${v.key} 第 1 轮问题单 ${issues.length} 条（评审 ${prev.reviews.flatMap(r => r.issues).length}、自报 ${prev.self.length}、主会话 ${(MAIN_NOTES[v.key] || []).length}）`)
    const history = []
    let verdict = null
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const fix = await run(FIX(v, round, issues), { label: `fix:${v.key}:r${round}`, phase: 'Fix', schema: FIX_SCHEMA })
      if (!fix) { log(`${v.key} 第 ${round} 轮返修没有结果，停止返修`); break }
      verdict = await run(VERIFY(v, round, issues, fix), { label: `verify:${v.key}:r${round}`, phase: 'Verify', schema: VERIFY_SCHEMA })
      history.push({ round, fix, verdict })
      if (!verdict) { log(`${v.key} 第 ${round} 轮复核没有结果，停止返修`); break }
      if (verdict.pass) { log(`${v.key} 第 ${round} 轮复核达到交付线`); break }
      const open = new Set((verdict.verdicts || []).filter(x => x.verdict !== 'resolved').map(x => x.id))
      issues = issues.filter(i => open.has(i.id)).concat(verdict.new_issues || [])
      log(`${v.key} 第 ${round} 轮复核未达交付线，剩 ${issues.length} 条`)
    }
    if (verdict && !verdict.pass) log(`${v.key} 返修结束仍未全部达标，带着剩余问题出片，在终检里列明`)
    return { ...prev, history, final_verdict: verdict }
  },
  (prev, v) => run(RENDER(v), { label: `render:${v.key}`, phase: 'Render', schema: RENDER_SCHEMA }).then(r => ({ ...prev, render: r })),
  (prev, v) => {
    if (!prev.render || !prev.render.ok) { log(`${v.key} 出片没有成功，跳过终检`); return prev }
    return run(QA(v), { label: `qa:${v.key}`, phase: 'QA', schema: QA_SCHEMA }).then(q => ({ ...prev, qa: q }))
  },
)

phase('Compare')
const brief = VERSIONS.map((v, i) => ({ version: v.key, name: v.name, verdict: results[i]?.final_verdict && { pass: results[i].final_verdict.pass, scores: results[i].final_verdict.scores }, qa: results[i]?.qa, render: results[i]?.render }))
const compare = await run(`你是《豹变》项目的总审。工程 ${ROOT}。四版成片在 ${ROOT}/out/豹变_<版本>.mp4，各自的终检在 out/check_<版本>/QA.md、tile.jpg、qa_sheet.jpg；B、C、D 在 out/v1/ 还有评审前的第一版。下面是各版复核和终检的结构化结果：
${JSON.stringify(brief)}
1. 逐版用 Read 看 tile.jpg 和 qa_sheet.jpg，每版再从成片抽 3 张大图，横向比较四版。
2. 写 ${ROOT}/out/SUMMARY.md，给来看片的用户看，中文，简洁。内容包括：
   - 四版成片路径和一句话定位；
   - 推荐看片顺序；
   - 每版的亮点和剩余问题（按 P0–P3）；
   - 四版横向打分表（六项）；
   - 你推荐哪一版作为下一步正片方向，理由是什么；
   - 如果要做成 3 分钟正片，还需要补什么。
不改任何影片和工具。汇报 SUMMARY.md 的要点。`, { label: 'compare:all', phase: 'Compare' })

return { versions: VERSIONS.map((v, i) => ({ version: v.key, ...(results[i] || { failed: true }) })), compare }
