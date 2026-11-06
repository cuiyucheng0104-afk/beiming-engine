// 《北冥》540 秒正片制作表；时间单位为秒，区间一律 [start, end)。
// scene 为 1–15；id 在数据、分镜表及音画校准中保持不变。
// 仅为正片调度数据，不修改原 10 秒样片、A/B/C 参数、角色或粉紫暖金色板。
// kun 表示本镜可见鲲形体/局部；鹏由 kind: 'peng' 或 action 明确调度，不复用鲲冒充。
// glasses 表示本镜的眼镜显示层是否生效；摘下从 S048 关闭，戴回在 S051 首帧开启。
// S049/S051 必须复用完全相同的机位、焦距、地平线、底板和水面相位，只有鲲/HUD层有别。
// light 只标示叙事光源阶段，不是新 palette；关灯不关闭红绿航行灯。
// 快门画面固定在 486.000s；机械瞬态 485.88–486.00s，486–488s 全轨静音。
// 已按 audio/dialogue.json 校准对白；208s 汽笛、218s 鲲回应、510s「我接受」。
export const SHOTS = [
  // 01 外滩雾夜 · 0–15
  { id: 'S001', start: 0, end: 4, scene: 1, kind: 'birds', action: '鸽群受惊离开石地', title: '惊起', framing: 'medium', motion: 'locked', kun: false, glasses: false, light: 'city' },
  { id: 'S002', start: 4, end: 8, scene: 1, kind: 'birds', action: '鸽子扑两次翅落回栏杆', title: '飞不远', framing: 'wide', motion: 'track', kun: false, glasses: false, light: 'city' },
  { id: 'S003', start: 8, end: 15, scene: 1, kind: 'city', action: '浓雾遮住塔尖后移开', title: '无人抬头', framing: 'wide', motion: 'tilt', kun: false, glasses: false, light: 'city' },
  // 02 末班轮渡 · 15–60
  { id: 'S004', start: 15, end: 21, scene: 2, kind: 'rope', action: '靠泊后收紧缆绳落结', title: '熟练的手', framing: 'close', motion: 'locked', kun: false, glasses: false, light: 'city' },
  { id: 'S005', start: 21, end: 26, scene: 2, kind: 'helm', action: '回正舵轮按响收船汽笛', title: '末班到站', framing: 'close', motion: 'locked', kun: false, glasses: false, light: 'city' },
  { id: 'S006', start: 26, end: 32, scene: 2, kind: 'glasses', action: '戴稳眼镜查值班信息', title: '工作工具', framing: 'close', motion: 'locked', kun: false, glasses: true, light: 'city' },
  { id: 'S007', start: 32, end: 38, scene: 2, kind: 'deck', action: '转身复查空甲板后站回船头', title: '只剩她', framing: 'medium', motion: 'locked', kun: false, glasses: true, light: 'city' },
  { id: 'S008', start: 38, end: 43, scene: 2, kind: 'city', action: '聘书六点截止提醒遮住旧航线', title: '没有回复', framing: 'medium', motion: 'locked', kun: false, glasses: true, light: 'city' },
  { id: 'S009', start: 43, end: 47, scene: 2, kind: 'glasses', action: '划过镜腿关闭聘书提醒', title: '又一次划掉', framing: 'close', motion: 'locked', kun: false, glasses: true, light: 'city' },
  { id: 'S010', start: 47, end: 53, scene: 2, kind: 'rope', action: '盘好余绳把绳头压进绳圈', title: '十年如一日', framing: 'close', motion: 'push', kun: false, glasses: true, light: 'city' },
  { id: 'S011', start: 53, end: 60, scene: 2, kind: 'profile', action: '听见低鸣停手抬头', title: '声音来自上方', framing: 'medium', motion: 'push', kun: false, glasses: true, light: 'city' },
  // 03 云中之眼 · 60–80
  { id: 'S012', start: 60, end: 70, scene: 3, kind: 'city', action: '雾裂开露出楼群上方的巨体', title: '云里有东西', framing: 'wide', motion: 'tilt', kun: true, glasses: true, light: 'city' },
  { id: 'S013', start: 70, end: 80, scene: 3, kind: 'eye', action: '巨眼转向渡船缓慢眨一次', title: '它看见她', framing: 'close', motion: 'locked', kun: true, glasses: true, light: 'city' },
  // 04 问乐奇 · 80–120
  { id: 'S014', start: 80, end: 86, scene: 4, kind: 'profile', action: '朝巨眼发出识别请求', title: '这是什么', framing: 'medium', motion: 'locked', kun: false, glasses: true, light: 'city' },
  { id: 'S015', start: 86, end: 92, scene: 4, kind: 'eye', action: '识别框停在眼缘返回未能识别', title: '没有答案', framing: 'close', motion: 'locked', kun: true, glasses: true, light: 'city' },
  { id: 'S016', start: 92, end: 98, scene: 4, kind: 'profile', action: '改问什么鱼会在天上游', title: '换个问法', framing: 'medium', motion: 'push', kun: false, glasses: true, light: 'city' },
  { id: 'S017', start: 98, end: 106, scene: 4, kind: 'city', action: '鲲绕最亮楼群转弯伴随逍遥游答句', title: '北冥有鱼', framing: 'wide', motion: 'locked', kun: true, glasses: true, light: 'city' },
  { id: 'S018', start: 106, end: 114, scene: 4, kind: 'eye', action: '瞳孔离开渡船转向城市亮窗', title: '海与风', framing: 'close', motion: 'locked', kun: true, glasses: true, light: 'city' },
  { id: 'S019', start: 114, end: 120, scene: 4, kind: 'profile', action: '循着鲲的视线转头看灯海', title: '追光的鱼', framing: 'medium', motion: 'locked', kun: false, glasses: true, light: 'city' },
  // 05 撞向灯海 · 120–170
  { id: 'S020', start: 120, end: 126, scene: 5, kind: 'city', action: '鲲压向亮楼腹鳍擦过玻璃外缘', title: '假海', framing: 'wide', motion: 'push', kun: true, glasses: true, light: 'city' },
  { id: 'S021', start: 126, end: 131, scene: 5, kind: 'radio', action: '按下通话键向老周报告天上巨物', title: '呼叫调度', framing: 'close', motion: 'locked', kun: false, glasses: true, light: 'city' },
  { id: 'S022', start: 131, end: 135, scene: 5, kind: 'city', action: '擦过处海草沿玻璃格缝生长', title: '楼面的海草', framing: 'close', motion: 'push', kun: false, glasses: true, light: 'city' },
  { id: 'S023', start: 135, end: 139, scene: 5, kind: 'city', action: '一枚幻象贝壳贴住亮窗', title: '玻璃上的贝壳', framing: 'close', motion: 'locked', kun: false, glasses: true, light: 'city' },
  { id: 'S024', start: 139, end: 144, scene: 5, kind: 'eye', action: '眼中亮窗移动引它再转向', title: '还在找海', framing: 'close', motion: 'locked', kun: true, glasses: true, light: 'city' },
  { id: 'S025', start: 144, end: 150, scene: 5, kind: 'city', action: '绕回同一塔楼留下闭合雾痕', title: '又回原点', framing: 'wide', motion: 'locked', kun: true, glasses: true, light: 'city' },
  { id: 'S026', start: 150, end: 156, scene: 5, kind: 'radio', action: '收到回码头命令后拇指停在通话键上', title: '命令之后', framing: 'close', motion: 'locked', kun: false, glasses: true, light: 'city' },
  { id: 'S027', start: 156, end: 162, scene: 5, kind: 'profile', action: '看着楼群告诉老周它一直兜圈子', title: '只有她看见', framing: 'medium', motion: 'locked', kun: false, glasses: true, light: 'city' },
  { id: 'S028', start: 162, end: 170, scene: 5, kind: 'radio', action: '松开通话键把对讲机落回挂扣', title: '她没有返航', framing: 'close', motion: 'push', kun: false, glasses: true, light: 'city' },
  // 06 改航向 · 170–200
  { id: 'S029', start: 170, end: 175, scene: 6, kind: 'profile', action: '把导航终点改为吴淞口', title: '新的终点', framing: 'medium', motion: 'locked', kun: false, glasses: true, light: 'city' },
  { id: 'S030', start: 175, end: 182, scene: 6, kind: 'city', action: '导航线从江面延伸到天际', title: '线通向海', framing: 'wide', motion: 'tilt', kun: true, glasses: true, light: 'city' },
  { id: 'S031', start: 182, end: 188, scene: 6, kind: 'switch', action: '开启探照灯把光束指向下游', title: '给它一条路', framing: 'close', motion: 'locked', kun: false, glasses: true, light: 'city' },
  { id: 'S032', start: 188, end: 194, scene: 6, kind: 'rope', action: '解开靠泊缆把绳尾完整收回船上', title: '第一次离线', framing: 'close', motion: 'locked', kun: false, glasses: true, light: 'city' },
  { id: 'S033', start: 194, end: 200, scene: 6, kind: 'city', action: '渡船转舵向下游鲲跟上新航迹', title: '离开折返线', framing: 'overhead', motion: 'locked', kun: true, glasses: true, light: 'city' },
  // 07 随船下江 · 200–250
  { id: 'S034', start: 200, end: 213, scene: 7, kind: 'helm', action: '稳舵前行在208秒按下一次汽笛', title: '她先打招呼', framing: 'close', motion: 'locked', kun: false, glasses: true, light: 'city' },
  { id: 'S035', start: 213, end: 225, scene: 7, kind: 'city', action: '船过杨浦桥下鲲在218秒回应并掠过桥顶', title: '桥上桥下', framing: 'under', motion: 'track', kun: true, glasses: true, light: 'city' },
  { id: 'S036', start: 225, end: 234, scene: 7, kind: 'deck', action: '林潮走回船头抬头看回应的鲲', title: '它听见了', framing: 'medium', motion: 'locked', kun: false, glasses: true, light: 'city' },
  { id: 'S037', start: 234, end: 250, scene: 7, kind: 'city', action: '鲲与渡船并行尾鳍掠水拉出白浪', title: '同路', framing: 'wide', motion: 'track', kun: true, glasses: true, light: 'city' },
  // 08 吴淞口掉头 · 250–280
  { id: 'S038', start: 250, end: 259, scene: 8, kind: 'sea', action: '渡船抵达江口鲲停在黑海之前', title: '光到这里为止', framing: 'wide', motion: 'locked', kun: true, glasses: true, light: 'dark' },
  { id: 'S039', start: 259, end: 267, scene: 8, kind: 'eye', action: '眼中海面无光瞳孔转回城市', title: '不肯向前', framing: 'close', motion: 'locked', kun: true, glasses: true, light: 'dark' },
  { id: 'S040', start: 267, end: 274, scene: 8, kind: 'city', action: '鲲掉头逆着船向游回灯海', title: '回到亮处', framing: 'wide', motion: 'locked', kun: true, glasses: true, light: 'city' },
  { id: 'S041', start: 274, end: 280, scene: 8, kind: 'deck', action: '林潮留在船头举手后缓缓放下', title: '叫不回来', framing: 'medium', motion: 'locked', kun: false, glasses: true, light: 'dark' },
  // 09 默许来迟 · 280–320
  { id: 'S042', start: 280, end: 285, scene: 9, kind: 'radio', action: '举起对讲机准备报告返航', title: '准备回去', framing: 'close', motion: 'locked', kun: false, glasses: true, light: 'dark' },
  { id: 'S043', start: 285, end: 290, scene: 9, kind: 'profile', action: '回答老周自己在吴淞口', title: '吴淞口', framing: 'medium', motion: 'locked', kun: false, glasses: true, light: 'dark' },
  { id: 'S044', start: 290, end: 298, scene: 9, kind: 'city', action: '对讲机沉默时鲲背影没入城市雾光', title: '已经游远', framing: 'wide', motion: 'locked', kun: true, glasses: true, light: 'city' },
  { id: 'S045', start: 298, end: 306, scene: 9, kind: 'radio', action: '握住对讲机听老周说日志记避雾', title: '老周放行', framing: 'close', motion: 'locked', kun: false, glasses: true, light: 'dark' },
  { id: 'S046', start: 306, end: 313, scene: 9, kind: 'radio', action: '听完油够灯塔后放低对讲机', title: '许可来迟', framing: 'medium', motion: 'locked', kun: false, glasses: true, light: 'dark' },
  { id: 'S047', start: 313, end: 316, scene: 9, kind: 'helm', action: '314秒截止提醒响起时拉回油门停船', title: '停船', framing: 'close', motion: 'locked', kun: false, glasses: true, light: 'dark' },
  { id: 'S048', start: 316, end: 320, scene: 9, kind: 'glasses', action: '摘下眼镜把镜架落到胸前', title: '暂时不看', framing: 'close', motion: 'locked', kun: false, glasses: false, light: 'city' },
  // 10 同构图摘戴 · 320–360
  { id: 'S049', start: 320, end: 332, scene: 10, kind: 'reflection', action: '裸眼看城市倒影被波浪拉成灯海', title: '没有鲲的海', framing: 'wide', motion: 'locked', kun: false, glasses: false, light: 'city' },
  { id: 'S050', start: 332, end: 336, scene: 10, kind: 'glasses', action: '把眼镜从胸前抬回眼前', title: '再看一次', framing: 'close', motion: 'locked', kun: false, glasses: false, light: 'city' },
  { id: 'S051', start: 336, end: 350, scene: 10, kind: 'reflection', action: '原构图中鲲绕倒影上空再次折返', title: '它把灯当海', framing: 'wide', motion: 'locked', kun: true, glasses: true, light: 'city' },
  { id: 'S052', start: 350, end: 360, scene: 10, kind: 'profile', action: '说完真的海把视线移向探照灯', title: '不再用光引它', framing: 'medium', motion: 'locked', kun: false, glasses: true, light: 'city' },
  // 11 关灯出江 · 360–400
  { id: 'S053', start: 360, end: 374, scene: 11, kind: 'switch', action: '依次关闭探照灯和舱灯保留红绿航行灯', title: '撤掉假的海', framing: 'close', motion: 'locked', kun: false, glasses: true, light: 'dark' },
  { id: 'S054', start: 374, end: 386, scene: 11, kind: 'helm', action: '手沿暗处摸到舵轮推油门朝海', title: '在黑暗里出发', framing: 'close', motion: 'locked', kun: false, glasses: true, light: 'dark' },
  { id: 'S055', start: 386, end: 400, scene: 11, kind: 'sea', action: '一红一绿两点驶出江口与城市拉开距离', title: '两点灯', framing: 'overhead', motion: 'locked', kun: false, glasses: true, light: 'dark' },
  // 12 转身入海 · 400–455
  { id: 'S056', start: 400, end: 408, scene: 12, kind: 'sea', action: '鲲停住寻找已经熄灭的船灯光束', title: '光不在了', framing: 'wide', motion: 'locked', kun: true, glasses: true, light: 'dark' },
  { id: 'S057', start: 408, end: 416, scene: 12, kind: 'eye', action: '瞳孔移向海侧映出第一道天光', title: '第一次看暗处', framing: 'close', motion: 'push', kun: true, glasses: true, light: 'dawn' },
  { id: 'S058', start: 416, end: 425, scene: 12, kind: 'sea', action: '鲲缓慢转身腹鳍掠向海的方向', title: '转身', framing: 'under', motion: 'locked', kun: true, glasses: true, light: 'dawn' },
  { id: 'S059', start: 425, end: 433, scene: 12, kind: 'sea', action: '天光沿水平线铺开鲲朝海前行', title: '真正的海平线', framing: 'wide', motion: 'locked', kun: true, glasses: true, light: 'dawn' },
  { id: 'S060', start: 433, end: 440, scene: 12, kind: 'sea', action: '鲲低头俯冲全身扎入海面', title: '海运', framing: 'wide', motion: 'track', kun: true, glasses: true, light: 'dawn' },
  { id: 'S061', start: 440, end: 446, scene: 12, kind: 'sea', action: '鲲没入后海面隆起一座水山', title: '水山', framing: 'wide', motion: 'locked', kun: false, glasses: true, light: 'dawn' },
  { id: 'S062', start: 446, end: 451, scene: 12, kind: 'profile', action: '海风把短发衣领吹向陆地', title: '风来了', framing: 'medium', motion: 'locked', kun: false, glasses: true, light: 'dawn' },
  { id: 'S063', start: 451, end: 455, scene: 12, kind: 'sea', action: '水山顶端裂开腾起逆光水雾', title: '破水之前', framing: 'under', motion: 'tilt', kun: false, glasses: true, light: 'dawn' },
  // 13 实体化鹏与快门 · 455–490
  { id: 'S064', start: 455, end: 458, scene: 13, kind: 'sea', action: '鲲破水跃起腹鳍展开', title: '破水', framing: 'wide', motion: 'track', kun: true, glasses: true, light: 'dawn' },
  { id: 'S065', start: 458, end: 461, scene: 13, kind: 'feathers', action: '鳍缘裂成第一排羽轴', title: '鳍变成翼', framing: 'close', motion: 'locked', kun: true, glasses: true, light: 'dawn' },
  { id: 'S066', start: 461, end: 464, scene: 13, kind: 'feathers', action: '海草沿背脊逐束变成金翎', title: '草变成羽', framing: 'close', motion: 'track', kun: true, glasses: true, light: 'dawn' },
  { id: 'S067', start: 464, end: 467, scene: 13, kind: 'peng', action: '鸟喙颈尾与双翼完整显露', title: '鹏的真身', framing: 'medium', motion: 'tilt', kun: false, glasses: true, light: 'dawn' },
  { id: 'S068', start: 467, end: 470, scene: 13, kind: 'peng', action: '双翼从折叠展开遮住上方天空', title: '翼展', framing: 'under', motion: 'locked', kun: false, glasses: true, light: 'dawn' },
  { id: 'S069', start: 470, end: 473, scene: 13, kind: 'peng', action: '第一次下压双翼把水雾推出环浪', title: '乘风', framing: 'wide', motion: 'locked', kun: false, glasses: true, light: 'dawn' },
  { id: 'S070', start: 473, end: 476, scene: 13, kind: 'peng', action: '鹏抬升身体穿过第一层云', title: '扶摇', framing: 'wide', motion: 'track', kun: false, glasses: true, light: 'dawn' },
  { id: 'S071', start: 476, end: 479, scene: 13, kind: 'deck', action: '翼影掠过小背影林潮仰头', title: '人在翼下', framing: 'wide', motion: 'locked', kun: false, glasses: true, light: 'dawn' },
  { id: 'S072', start: 479, end: 482, scene: 13, kind: 'peng', action: '鹏越过渡船朝日出方向滑翔', title: '海天全开', framing: 'overhead', motion: 'track', kun: false, glasses: true, light: 'dawn' },
  { id: 'S073', start: 482, end: 486, scene: 13, kind: 'glasses', action: '抬指靠近镜腿在切点触发快门', title: '唯一一张照片', framing: 'close', motion: 'locked', kun: false, glasses: true, light: 'dawn' },
  { id: 'S074', start: 486, end: 488, scene: 13, kind: 'peng', action: '486秒快门定格0.8秒全轨静音至488秒', title: '咔嚓', framing: 'wide', motion: 'locked', kun: false, glasses: true, light: 'dawn' },
  { id: 'S075', start: 488, end: 490, scene: 13, kind: 'peng', action: '鹏继续远飞海风重新进入', title: '风回来', framing: 'wide', motion: 'track', kun: false, glasses: true, light: 'dawn' },
  // 14 同一江口接受聘书 · 490–525
  { id: 'S076', start: 490, end: 498, scene: 14, kind: 'sea', action: '船停稳鹏远去495秒浮出四分钟提醒', title: '仍在江口', framing: 'wide', motion: 'locked', kun: false, glasses: true, light: 'dawn' },
  { id: 'S077', start: 498, end: 502, scene: 14, kind: 'sea', action: '四分钟提醒留在海平线前等待回应', title: '最后一次提醒', framing: 'wide', motion: 'locked', kun: false, glasses: true, light: 'dawn' },
  { id: 'S078', start: 502, end: 510, scene: 14, kind: 'profile', action: '发出回复远洋公司邮件的口令', title: '回复', framing: 'medium', motion: 'locked', kun: false, glasses: true, light: 'dawn' },
  { id: 'S079', start: 510, end: 515, scene: 14, kind: 'profile', action: '看着海平线说我接受', title: '我接受', framing: 'close', motion: 'push', kun: false, glasses: true, light: 'dawn' },
  { id: 'S080', start: 515, end: 520, scene: 14, kind: 'sea', action: '我接受落字已发送后截止提醒消失', title: '发送完成', framing: 'wide', motion: 'locked', kun: false, glasses: true, light: 'dawn' },
  { id: 'S081', start: 520, end: 525, scene: 14, kind: 'helm', action: '重新握舵转向回程航道', title: '回去准备远行', framing: 'close', motion: 'locked', kun: false, glasses: true, light: 'dawn' },
  // 15 直线与真实贝壳 · 525–540
  { id: 'S082', start: 525, end: 531, scene: 15, kind: 'city', action: '渡船朝城驶去留下一条直航迹', title: '不再折返', framing: 'overhead', motion: 'locked', kun: false, glasses: true, light: 'dawn' },
  { id: 'S083', start: 531, end: 535, scene: 15, kind: 'shell', action: '真实贝壳随甲板轻晃留下湿痕', title: '它来过', framing: 'close', motion: 'push', kun: false, glasses: false, light: 'dawn' },
  { id: 'S084', start: 535, end: 540, scene: 15, kind: 'title', action: '真实贝壳画面留底显示片名北冥五秒', title: '北冥', framing: 'close', motion: 'locked', kun: false, glasses: false, light: 'dawn' },
];
