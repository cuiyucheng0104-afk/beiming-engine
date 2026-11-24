# -*- coding: utf-8 -*-
"""音效库检索词表、世界观调性路由与全片三干线声族池规划（UCS v8.2.1 官方公有领域分类同义词表 + 北冥音效师复合检索词配方）。

解决三个层次的检索与规划问题：
  1. 行业通用分类与同义词反查（UCS v8.2.1）：82 大类、753 个 CatID、9973 个英文检索词、3020 个中文同义词，
     供 Soundminer / BaseHead / Soundly / Reaper / Freesound 中英互查；
  2. 音效师复合短语扩展（DESIGNER_RECIPES + SEARCH_MODIFIERS）：把单字名词（如「齿轮」「菜单」「圆珠笔」）
     拆成「认知锚点词（Identity）+ 跨界精密叠层词（Detail）+ 尺度/录音修饰词（Modifier）」，
     并自动携带 sfx_judge 的声学原型（archetype）与动力源守卫（passive / motorized / digital）；
  3. 导演世界观调性过滤与三干线音效池规划（WORLD_PALETTES + search_by_world + classify_stem + plan_film_sound_pool）：
     按 realistic / semi_realistic / hitech / scifi / cartoon / poetic 六种世界观加权偏好大类、剔除违和禁入类，
     自动把 film.json 镜头与事件拆分为 Ambience / SFX / Foley 三干线候选检索词方案。

主要接口：
  load_ucs()                                  加载 engine/audio/ucs_vocab.json
  list_categories()                           列出全部 82 个顶层大类（中英对照与子类数）
  get_cat(cat_id_or_prefix)                   按精确 CatID（如 MECHGear）或前缀（如 MECH / UI）取词条
  search_ucs(query, top_n=10)                 中英文关键词或 CatID 检索 UCS 753 子类与同义词
  match_recipes(query, top_n=5)               匹配北冥 25 类音效师复合检索配方
  expand_for_freesound(query, ..., world=None) 将中文意图、CatID 或泛词扩展成英文检索短语列表
  WORLD_PALETTES                              六种世界观调性声族路由与三干线配比表（与 director.WORLD_PROFILES 对齐）
  SCENE_AMBIENCE_LAYERS                       复合场景三层环境声拆解词典（远景底床 + 主环境纹理 + 间歇生机点缀）
  decompose_scene_ambience(scene_desc, world='realistic') 把任意场景描述拆为 Base Hum / Primary Texture / Spot Life 三层检索方案
  search_by_world(query, world='realistic', top_n=8) 按世界观调性过滤禁入大类并重排 UCS 与检索短语
  classify_stem(cue_desc, world='realistic')  判定画面声音需求归属 amb / fx / foley 三干线及 hitech 降级/跳过建议
  plan_film_sound_pool(spec_or_events, *, world='realistic') 输入 film.json 或事件列表生成全片三干线检索词方案
"""
from functools import lru_cache
import json
from pathlib import Path
import re

VOCAB_PATH = Path(__file__).resolve().parent / 'ucs_vocab.json'
CJK_RE = re.compile(r'[\u4e00-\u9fff]')
_TOKEN_SPLIT_RE = re.compile(r'[\s,，、/|+；;：:()（）\-]+')

# 音效库检索修饰词表：单独搜泛词（如 "gear"、"beep"、"laser"）极易召回 8-bit 合成器或工厂电机噪音，
# 叠加下列修饰词能显著拉升 CC0 实录与高科技微界面的命中纯度。
SEARCH_MODIFIERS = {
    'precision_boost': {
        'label': '微型精密机械提纯词',
        'tokens': ['micro', 'miniature', 'pocket watch', 'camera', 'caliper', 'detent', 'crisp', 'close-mic'],
        'note': '搜细小齿轮、卡扣、转轴时追加，跨界借用怀表擒纵、相机快门拨盘与千分尺棘轮',
    },
    'hitech_boost': {
        'label': '高科技界面（HUD/UI）放行与提纯词',
        'tokens': ['hitech', 'hud', 'telemetry', 'micro beep', 'readout', 'scanner', 'clean', 'pulse'],
        'note': '显式触发 fetch_sfx.is_hitech_query 电子标签放行，避免误落入复古 8-bit 街机音效',
    },
    'foley_clean_boost': {
        'label': '近场干净拟音录音提纯词',
        'tokens': ['foley', 'close-mic', 'isolated', 'dry', 'single', 'clean', 'field-recording'],
        'note': '优先召回消声/近讲单次干声，避开大混响与嘈杂环境录音',
    },
    'passive_exclude': {
        'label': '无源机械防电机污染排除词',
        'tokens': ['-motor', '-servo', '-drill', '-engine', '-fan', '-synth', '-loop'],
        'note': '圆珠笔、发条钟表、木石机关、积木等无电机物件必加，防止窄带伺服嗡鸣混入',
    },
    'organic_exclude': {
        'label': '自然材质防电子/音乐污染排除词',
        'tokens': ['-synth', '-8bit', '-chiptune', '-loop', '-music', '-vocal'],
        'note': '搜风、水、木、石、布料、刀剑等自然实录时排除合成器与配乐循环',
    },
}

# 25 类高频影视/代码动画场景的音效师复合搜索词配方：
# identityQueries = 认知锚点层（搜本尊物件）；detailQueries = 高频精密/质感叠层（跨界借声）
DESIGNER_RECIPES = [
    {
        'id': 'scissors_cut',
        'title': '剪刀裁纸 / 双刃行进剪切',
        'layer': '物理本体',
        'power': 'passive',
        'archetype': 'foley_snap',
        'catIds': ['TOOLHand', 'OBJOffc', 'PAPRRip', 'PAPRFric'],
        'triggers': [
            'scissors', 'scissor', 'shears', 'shear', 'snip', 'snips',
            'papercut', 'paper-cut', 'paper cut', 'cut paper', 'cutting paper',
            'scissors paper', 'cut cardstock', 'cutting cardstock',
            '剪刀', '剪子', '剪纸', '裁纸', '剪窗花', '窗花剪纸', '钢剪', '裁切', '双刃剪切',
        ],
        'identityQueries': [
            'scissors cutting paper',
            'scissors cut paper close',
            'paper snip scissors foley',
            'shears cutting cardstock',
        ],
        'detailQueries': [
            'scissors metal blade slide',
            'crisp paper tear short',
            'cardstock cut crisp',
        ],
        'avoid': [
            'scroll unroll', 'lego', 'plastic latch', 'motor', 'servo', 'synth', '8bit', 'cartoon',
        ],
    },
    {
        'id': 'pen_button_switch',
        'title': '圆珠笔按压 / 精密按钮开关',
        'layer': '物理本体',
        'power': 'passive',
        'archetype': 'mechanical',
        'catIds': ['OBJWrite', 'MECHClik', 'MECHSwtch'],
        'triggers': ['圆珠笔', '按动笔', '笔帽', '按压', '按钮', '微动开关', 'ballpoint', 'pen click', 'retractable pen', 'push button', 'micro switch'],
        'identityQueries': ['ballpoint pen click', 'retractable pen button', 'clicker pen press', 'plastic button click'],
        'detailQueries': ['micro switch click', 'camera shutter button', 'precision ratchet click', 'small metal latch'],
        'avoid': ['servo', 'electric motor', 'bed spring', '8bit'],
    },
    {
        'id': 'precision_gear_ratchet',
        'title': '精密齿轮咬合 / 步进棘轮 / 擒纵机构',
        'layer': '物理本体',
        'power': 'passive',
        'archetype': 'mechanical',
        'catIds': ['MECHGear', 'CLOCKMech', 'CLOCKTick', 'TOOLHand'],
        'triggers': ['齿轮', '棘轮', '擒纵', '咬合', '转轴', '表冠', '上弦', '密码盘', 'gear', 'ratchet', 'escapement', 'clockwork', 'cog', 'detent', 'dial'],
        'identityQueries': ['pocket watch escapement', 'clockwork gear wind', 'ratchet wrench fine', 'safe combination dial'],
        'detailQueries': ['camera shutter dial', 'micrometer ratchet click', 'watch crown wind', 'rotary detent switch'],
        'avoid': ['industrial factory motor', 'power drill', 'car transmission', 'loop'],
    },
    {
        'id': 'latch_brick_snap',
        'title': '卡扣锁合 / 积木拼插 / 硬塑脆响',
        'layer': '物理本体',
        'power': 'passive',
        'archetype': 'impact',
        'catIds': ['MECHLtch', 'MECHLock', 'PLASImpt', 'TOYMech'],
        'triggers': ['积木', '乐高', '卡扣', '搭扣', '插销', '扣合', '拼插', '塑料碰撞', 'lego', 'brick', 'snap', 'latch', 'clasp', 'buckle', 'plastic click'],
        'identityQueries': ['lego brick click', 'plastic snap latch', 'toy block clack', 'buckle clasp snap'],
        'detailQueries': ['camera lens lock click', 'cassette case snap', 'hard plastic tap dry'],
        'avoid': ['hollow drum', 'cartoon boing', 'synth'],
    },
    {
        'id': 'helical_screw_thread',
        'title': '螺纹旋松旋紧 / 金属管套滑擦',
        'layer': '物理本体',
        'power': 'passive',
        'archetype': 'scrape',
        'catIds': ['METLFric', 'PLASFric', 'OBJCont', 'TOOLHand'],
        'triggers': ['螺纹', '旋开', '旋紧', '拧盖', '笔杆旋开', '螺母', 'unscrew', 'screw', 'thread', 'twist cap', 'metal lid'],
        'identityQueries': ['metal cap unscrew', 'flashlight battery cap thread', 'thermos lid twist', 'jar lid unscrew'],
        'detailQueries': ['fine metal slide scrape', 'caliper metal slide', 'pen barrel unscrew'],
        'avoid': ['electric screwdriver', 'cordless drill', 'impact driver'],
    },
    {
        'id': 'micro_spring',
        'title': '微型弹簧压缩与受抑回弹',
        'layer': '物理本体',
        'power': 'passive',
        'archetype': 'mechanical',
        'catIds': ['METLMvmt', 'MECHMisc', 'CLOCKMech'],
        'triggers': ['弹簧', '发条', '簧片', '回弹', 'spring', 'coil', 'mainspring', 'tension'],
        'identityQueries': ['small metal spring release', 'watch mainspring wind', 'ballpoint spring clink'],
        'detailQueries': ['thin wire pluck', 'stapler spring slide', 'metal clip snap'],
        'avoid': ['cartoon boing', 'mattress bed spring', 'trampoline'],
    },
    {
        'id': 'drafting_scribe_pen',
        'title': '制图划线 / 钢笔铅笔纸面刮擦 / 卡尺测量',
        'layer': '物理本体',
        'power': 'passive',
        'archetype': 'paper',
        'catIds': ['OBJWrite', 'PAPRFric', 'TOOLHand'],
        'triggers': ['划线', '写字', '画线', '制图', '圆规', '卡尺', '铅笔', '钢笔', '粉笔', 'pen write', 'pencil draw', 'chalk', 'scribe', 'caliper'],
        'identityQueries': ['fountain pen paper write', 'pencil sketch stroke dry', 'drafting compass draw', 'chalk stroke blackboard'],
        'detailQueries': ['caliper slide click', 'watch tick single crisp', 'wooden ruler set down'],
        'avoid': ['keyboard typing', 'printer motor'],
    },
    {
        'id': 'hitech_menu_beep',
        'title': '高科技菜单弹出 / 微提示音（HUD Beep）',
        'layer': '编码界面',
        'power': 'digital',
        'archetype': 'ui',
        'catIds': ['UIBeep', 'UIClick', 'UIAlert', 'EQUIPTech'],
        'triggers': ['菜单', '弹出', '提示音', '界面', '气泡框', '标注弹出', 'hitech', 'hud', 'beep', 'menu', 'popup', 'ui', 'tooltip'],
        'identityQueries': ['hitech micro beep', 'hud telemetry blip', 'clean sci-fi ui button', 'futuristic interface confirm'],
        'detailQueries': ['digital micro click clean', 'medical monitor soft beep', 'camera focus confirm beep'],
        'avoid': ['8bit arcade', 'retro game coin', 'loud alarm siren'],
    },
    {
        'id': 'hitech_laser_trace',
        'title': '高科技细线绘制 / 镭射脉冲扫描（Laser Trace）',
        'layer': '编码界面',
        'power': 'digital',
        'archetype': 'ui',
        'catIds': ['LASRBeam', 'UIData', 'SCICmpt', 'UIMvmt'],
        'triggers': ['细线', '引出线', '走线', '镭射', '激光扫描', '尺寸线', '矢量绘制', 'laser scan', 'laser pulse', 'telemetry', 'scan line', 'hud draw'],
        'identityQueries': ['hitech laser scan', 'hud telemetry pulse', 'barcode laser scanner clean', 'digital scanner sweep'],
        'detailQueries': ['ui data tick fast', 'high frequency micro pulse', 'holoscreen line draw'],
        'avoid': ['star wars blaster pew', 'laser gun explosion', 'harsh feedback'],
    },
    {
        'id': 'hitech_data_readout',
        'title': '数据跳字 / 遥测读数流 / 终端打印',
        'layer': '编码界面',
        'power': 'digital',
        'archetype': 'ui',
        'catIds': ['UIData', 'SCICmpt', 'CMPTMisc'],
        'triggers': ['数据流', '读数', '滚动数字', '代码打印', '遥测', '计数器', 'data readout', 'telemetry', 'text scroll', 'counter tick'],
        'identityQueries': ['hud telemetry data readout', 'hitech text scroll ticks', 'digital counter readout', 'sci-fi computer data'],
        'detailQueries': ['geiger counter single click', 'micro relay tick'],
        'avoid': ['dialup modem screech', 'loud glitch noise'],
    },
    {
        'id': 'hitech_glitch_error',
        'title': '界面报错 / 信号闪烁故障（Glitch / Alert）',
        'layer': '编码界面',
        'power': 'digital',
        'archetype': 'ui',
        'catIds': ['UIGlitch', 'UIAlert', 'ELECSprk'],
        'triggers': ['报错', '故障', '闪烁', '警告音', '拒绝', 'glitch', 'error beep', 'ui fail', 'warning'],
        'identityQueries': ['ui interaction error beep', 'hitech subtle glitch', 'hud warning double beep', 'digital cancel tone'],
        'detailQueries': ['short static zap micro', 'clean low blip'],
        'avoid': ['harsh white noise blast', 'air raid siren'],
    },
    {
        'id': 'sword_blade_metal',
        'title': '刀剑出鞘 / 兵刃交击 / 金属清鸣',
        'layer': '物理本体',
        'power': 'passive',
        'archetype': 'metal',
        'catIds': ['WEAPSwrd', 'WEAPKnif', 'METLImpt', 'METLTonl'],
        'triggers': ['拔剑', '出鞘', '剑鸣', '刀剑', '兵器', '拼刀', '剑鞘', 'sword', 'unsheath', 'katana', 'blade', 'sheath', 'clang'],
        'identityQueries': ['sword unsheath metal', 'katana draw scabbard', 'sword blade clang', 'knife blade slide ring'],
        'detailQueries': ['tuning fork high ring', 'leather scabbard slide', 'bamboo stick whoosh'],
        'avoid': ['kitchen fork plate', 'hollow tin can'],
    },
    {
        'id': 'cloth_robe_rustle',
        'title': '衣袂翻飞 / 披风抖动 / 布料摩擦',
        'layer': '物理本体',
        'power': 'passive',
        'archetype': 'cloth',
        'catIds': ['CLOTHFlp', 'CLOTHMvmt', 'FOLYClth'],
        'triggers': ['衣袂', '衣服', '布料', '披风', '大氅', '袍子', '丝绸', '袖子', 'cloth', 'robe', 'cape', 'fabric', 'rustle', 'flap'],
        'identityQueries': ['heavy cloth flap foley', 'coat movement rustle close', 'canvas flag snap', 'silk fabric swish'],
        'detailQueries': ['leather belt creak subtle', 'soft air swish'],
        'avoid': ['plastic raincoat crinkle', 'mic handling wind rumble'],
    },
    {
        'id': 'whoosh_swish_transition',
        'title': '挥动破空 / 镜头甩镜转场（Whoosh / Swish）',
        'layer': '意象转译',
        'power': 'passive',
        'archetype': 'whoosh',
        'catIds': ['SWSH', 'WHSH', 'DSGNWhsh', 'FIREWhsh'],
        'triggers': ['破空', '挥动', '嗖嗖', '呼啸', '转场', '甩镜', '掠过', 'whoosh', 'swish', 'swoosh', 'pass by', 'whip'],
        'identityQueries': ['bamboo stick whoosh', 'wooden dowel fast swish', 'organic air whoosh', 'heavy rope swing whoosh'],
        'detailQueries': ['cloth whip snap', 'soft breath air rush'],
        'avoid': ['edm synth white noise riser', 'jet plane flyby'],
    },
    {
        'id': 'wood_carpentry_impact',
        'title': '木质敲击 / 榫卯扣合 / 竹木梆声',
        'layer': '物理本体',
        'power': 'passive',
        'archetype': 'impact',
        'catIds': ['WOODImpt', 'WOODFric', 'WOODHndl', 'DOORWood'],
        'triggers': ['木头', '木块', '榫卯', '竹子', '木门', '木槌', '棋子', 'wood hit', 'wooden block', 'bamboo', 'mallet', 'timber'],
        'identityQueries': ['hardwood block hit dry', 'bamboo clack foley', 'wooden mallet tap', 'heavy wood chest close'],
        'detailQueries': ['wood creak subtle', 'wooden drawer slide'],
        'avoid': ['snare drum', 'reverb hall'],
    },
    {
        'id': 'stone_ceramic_seal',
        'title': '石材落定 / 金石篆刻印章 / 陶瓷碰撞',
        'layer': '物理本体',
        'power': 'passive',
        'archetype': 'impact',
        'catIds': ['ROCKImpt', 'ROCKFric', 'CERMImpt', 'GLASImpt'],
        'triggers': ['印章', '落款', '石头', '岩石', '石碑', '陶瓷', '茶杯', '玉石', 'stone', 'rock', 'seal stamp', 'ceramic', 'porcelain', 'marble'],
        'identityQueries': ['stone block thud dry', 'marble slab slide', 'ceramic cup clink', 'heavy rock impact'],
        'detailQueries': ['gravel grit crunch', 'thick paper stamp press'],
        'avoid': ['explosion debris', 'avalanche'],
    },
    {
        'id': 'paper_scroll_book',
        'title': '画卷展开 / 宣纸翻页 / 卡纸滑擦',
        'layer': '物理本体',
        'power': 'passive',
        'archetype': 'paper',
        'catIds': ['PAPRFric', 'PAPRFltr', 'PAPRHndl', 'OBJBook'],
        'triggers': ['宣纸', '画卷', '卷轴', '翻书', '书页', '折纸', '纸张', 'paper', 'scroll', 'page turn', 'cardboard', 'origami'],
        'identityQueries': ['paper scroll unroll', 'thick book page turn', 'cardstock paper slide', 'parchment paper handle'],
        'detailQueries': ['wooden scroll rod tap', 'soft brush paper sweep'],
        'avoid': ['paper shredder machine', 'crumpling trash ball'],
    },
    {
        'id': 'footsteps_foley',
        'title': '脚步拟音（石板 / 木地板 / 碎石 / 雪地）',
        'layer': '物理本体',
        'power': 'passive',
        'archetype': 'footstep',
        'catIds': ['FEETHmn', 'FOLYFeet', 'SNOWCrsh', 'DIRTCrsh'],
        'triggers': ['脚步', '走路', '奔跑', '靴子', '踏雪', '碎石路', 'footsteps', 'walk', 'boots', 'step'],
        'identityQueries': ['footsteps stone single dry', 'footsteps wood floor foley', 'footsteps gravel walk', 'snow footsteps crunch'],
        'detailQueries': ['cloth movement step', 'leather boot creak'],
        'avoid': ['crowd marching', 'echoing stairwell'],
    },
    {
        'id': 'water_splash_ink',
        'title': '水花破浪 / 水墨晕染 / 深水潜流',
        'layer': '物理本体',
        'power': 'passive',
        'archetype': 'water',
        'catIds': ['WATRSplsh', 'WATRImpt', 'WATRDrip', 'WATRFlow', 'WATRUndwtr'],
        'triggers': ['水花', '破水', '入水', '水滴', '水流', '水下', '水墨', '鲲', 'water', 'splash', 'plunge', 'underwater', 'drip', 'wave'],
        'identityQueries': ['water plunge splash', 'calm lake water lap', 'single water drop resonant', 'underwater cave rumble'],
        'detailQueries': ['water bubbles rise', 'wet brush stroke'],
        'avoid': ['toilet flush', 'kitchen sink faucet'],
    },
    {
        'id': 'wind_fog_ambience',
        'title': '旷野山风 / 晨雾空气底噪（Ambience Bed）',
        'layer': '物理本体',
        'power': 'passive',
        'archetype': 'ambience',
        'catIds': ['WIND', 'WINDGust', 'AMBAir', 'AMBAlpn', 'AMBRoom'],
        'triggers': ['风声', '山风', '阵风', '晨雾', '空气声', '环境底噪', '室温音', 'wind', 'breeze', 'gust', 'room tone', 'fog ambience'],
        'identityQueries': ['cold mountain wind', 'gentle breeze open field', 'quiet room tone air', 'wind through trees'],
        'detailQueries': ['dry leaves rustle wind', 'distant reed flute air'],
        'avoid': ['microphone wind buffeting distortion', 'traffic highway hum'],
    },
    {
        'id': 'fire_torch_ember',
        'title': '火焰燃烧 / 火把呼啸 / 炭火噼啪',
        'layer': '物理本体',
        'power': 'passive',
        'archetype': 'scrape',
        'catIds': ['FIREBurn', 'FIRECrkl', 'FIREBrst', 'FIREWhsh'],
        'triggers': ['火焰', '火苗', '篝火', '火把', '火星', '爆燃', '灯芯', 'fire', 'flame', 'campfire', 'torch', 'crackle'],
        'identityQueries': ['campfire wood crackle close', 'fire torch whoosh', 'fireplace steady burn'],
        'detailQueries': ['match strike flare', 'charcoal ember pop'],
        'avoid': ['rain mistaken for fire', 'vinyl dust crackle'],
    },
    {
        'id': 'wings_bird_flap',
        'title': '飞鸟振翅 / 群鸽起飞 / 巨翼拍击',
        'layer': '物理本体',
        'power': 'passive',
        'archetype': 'whoosh',
        'catIds': ['WINGBird', 'WINGCrea', 'BIRDFowl', 'BIRDSong'],
        'triggers': ['振翅', '翅膀', '鸽子', '飞鸟', '鸟鸣', '扑棱', 'wing flap', 'pigeon wings', 'bird takeoff', 'feathers'],
        'identityQueries': ['pigeon wing flap close', 'bird wings takeoff', 'large leather wing flap'],
        'detailQueries': ['heavy cloth snap', 'feather rustle'],
        'avoid': ['city traffic background', 'cage rattle'],
    },
    {
        'id': 'bell_gong_resonance',
        'title': '古钟长鸣 / 铜锣重音 / 颂钵泛音',
        'layer': '意象转译',
        'power': 'passive',
        'archetype': 'tonal',
        'catIds': ['BELLGong', 'BELLLrg', 'BELLHand', 'HORNAir'],
        'triggers': ['钟声', '古钟', '寺庙钟', '铜锣', '颂钵', '雾角', '号角', 'bell', 'gong', 'singing bowl', 'foghorn', 'chime'],
        'identityQueries': ['temple bronze bell strike', 'deep tam-tam gong', 'tibetan singing bowl resonant', 'distant harbor foghorn'],
        'detailQueries': ['wooden bell striker hit', 'metal shimmer tail'],
        'avoid': ['doorbell buzzer', 'bicycle bell'],
    },
    {
        'id': 'servo_robotic_motor',
        'title': '机器人关节伺服 / 步进电机（有源动力专用）',
        'layer': '物理本体',
        'power': 'motorized',
        'archetype': 'motorized',
        'catIds': ['MOTRSrvo', 'MOTRElec', 'ROBTMvmt', 'COMCam'],
        'triggers': ['伺服', '电机', '马达', '机器人', '机械臂', '电动云台', '自动对焦', 'servo', 'stepper motor', 'robot joint', 'actuator'],
        'identityQueries': ['robotic servo movement', 'camera lens autofocus motor', 'small stepper motor whine', 'precision linear actuator'],
        'detailQueries': ['metallic gear stop click', 'hydraulic hiss short'],
        'avoid': ['lawnmower engine', 'vacuum cleaner'],
    },
    {
        'id': 'pneumatic_hydraulic_valve',
        'title': '气动泄压阀门 / 液压舱门（有源气液专用）',
        'layer': '物理本体',
        'power': 'motorized',
        'archetype': 'whoosh',
        'catIds': ['MECHHydr', 'AIRBrst', 'AIRHiss', 'SCIDoor'],
        'triggers': ['气动', '液压', '泄压', '气闸门', '活塞', 'pneumatic', 'hydraulic', 'air release', 'airlock', 'piston'],
        'identityQueries': ['pneumatic air release hiss', 'compressed air burst valve', 'hydraulic cylinder press', 'heavy airlock seal'],
        'detailQueries': ['heavy metal latch clunk', 'pressure gauge tick'],
        'avoid': ['white noise static'],
    },
]


@lru_cache(maxsize=1)
def load_ucs() -> dict:
    """读取并缓存 engine/audio/ucs_vocab.json（82 大类、753 个 CatID、中英同义词表）。"""
    return json.loads(VOCAB_PATH.read_text(encoding='utf-8'))


def list_categories() -> list:
    """返回按英文名排序的 82 个顶层大类摘要列表。"""
    grouped = {}
    for e in load_ucs()['entries']:
        cat = e['category']
        if cat not in grouped:
            grouped[cat] = {
                'category': cat,
                'categoryZh': e['categoryZh'],
                'catShort': e['catShort'],
                'subCount': 0,
                'sampleCatIds': [],
            }
        grouped[cat]['subCount'] += 1
        if len(grouped[cat]['sampleCatIds']) < 5:
            grouped[cat]['sampleCatIds'].append(e['catId'])
    return [grouped[k] for k in sorted(grouped)]


def get_cat(cat_id_or_prefix: str) -> list:
    """按精确 CatID（如 'MECHGear'）或大类简称/名称（如 'MECH'、'USER INTERFACE'、'钟表'）获取词条列表。"""
    q = str(cat_id_or_prefix or '').strip()
    if not q:
        return []
    ql = q.lower()
    entries = load_ucs()['entries']
    exact = [e for e in entries if e['catId'].lower() == ql]
    if exact:
        return exact
    return [
        e for e in entries
        if e['catShort'].lower() == ql
        or e['category'].lower() == ql
        or e['categoryZh'] == q
        or e['catId'].lower().startswith(ql)
    ]


def tokenize_query(query: str) -> list:
    raw = str(query or '').strip()
    if not raw:
        return []
    parts = [p.strip() for p in _TOKEN_SPLIT_RE.split(raw) if p.strip()]
    return parts if parts else [raw]


def search_ucs(query: str, top_n: int = 10) -> list:
    """按中英文关键词、动作材质词或 CatID 检索 UCS v8.2.1 全部 753 个子类，按命中精度打分排序。"""
    q = str(query or '').strip()
    if not q:
        return []
    ql = q.lower()
    toks = [t.lower() for t in tokenize_query(q)]
    has_cjk = bool(CJK_RE.search(q))
    scored = []

    for e in load_ucs()['entries']:
        score = 0.0
        matched_en, matched_zh = [], []
        cid_l = e['catId'].lower()
        cat_l = e['category'].lower()
        sub_l = e['subCategory'].lower()
        czh = e['categoryZh']
        szh = e['subCategoryZh']

        if cid_l == ql:
            score += 120.0
        elif cid_l.startswith(ql) and len(ql) >= 3:
            score += 65.0

        if cat_l == ql or sub_l == ql or czh == q or szh == q:
            score += 85.0

        for t in toks:
            if not t:
                continue
            if t == cat_l or t == sub_l or t == czh or t == szh:
                score += 55.0
            elif len(t) >= 2 and (t in cat_l or t in sub_l or t in czh or t in szh):
                score += 32.0

            for se in e['synonymsEn']:
                sel = se.lower()
                if sel == t:
                    score += 48.0
                    if se not in matched_en:
                        matched_en.append(se)
                elif len(t) >= 3 and (sel.startswith(t) or t in sel):
                    score += 18.0
                    if se not in matched_en:
                        matched_en.append(se)

            for sz in e['synonymsZh']:
                if sz == t:
                    score += 50.0
                    if sz not in matched_zh:
                        matched_zh.append(sz)
                elif (has_cjk or len(t) >= 2) and (t in sz or (len(sz) >= 2 and sz in q)):
                    score += 24.0
                    if sz not in matched_zh:
                        matched_zh.append(sz)

            if not has_cjk and len(t) >= 4 and re.search(rf'\b{re.escape(t)}', e['explanation'], re.I):
                score += 12.0

        if score > 0:
            scored.append({
                'score': round(score, 1),
                'catId': e['catId'],
                'catShort': e['catShort'],
                'category': e['category'],
                'subCategory': e['subCategory'],
                'categoryZh': e['categoryZh'],
                'subCategoryZh': e['subCategoryZh'],
                'explanation': e['explanation'],
                'matchedEn': matched_en[:8],
                'matchedZh': matched_zh[:8],
                'synonymsEn': e['synonymsEn'],
                'synonymsZh': e['synonymsZh'],
            })

    scored.sort(key=lambda x: (-x['score'], x['catId']))
    return scored[:max(1, int(top_n))]


_CUTTING_TOOL_RE = re.compile(
    r'剪刀|剪子|剪纸|裁纸|剪窗花|窗花剪纸|钢剪|裁切|双刃|剪切|'
    r'\b(scissors?|shears?|snips?|papercut|paper[- ]cut|cut(?:ting)?\s+(?:paper|cardstock|cardboard)|(?:paper|cardstock|cardboard)\s+cut(?:ting)?)\b',
    re.I,
)
_PASSIVE_PAPER_MATERIAL_RE = re.compile(
    r'宣纸|纸张|卡纸|红纸|白纸|纸|\b(paper|cardstock|cardboard|parchment)\b',
    re.I,
)
_EXPLICIT_SCROLL_BOOK_RE = re.compile(
    r'画卷|卷轴|翻书|书页|\b(scroll|unroll|page\s*turn|book)\b',
    re.I,
)
_EXPLICIT_TOY_BRICK_RE = re.compile(
    r'积木|乐高|玩具|\b(lego|brick|toy\s*block)\b',
    re.I,
)
_SCRIBE_TOOL_RE = re.compile(
    r'钢笔|铅笔|粉笔|圆规|卡尺|制图|\b(fountain\s*pen|pencil|chalk|caliper|drafting\s*compass|scribe)\b',
    re.I,
)
# 只拦「纸类泛词作为子串被 scissors_cut 这类带纸的复合触发词劫持」；plastic / metal / wood 等不在其内，保持与 main 一致的反向子串命中
_GENERIC_SUBSTR_GUARD_TOKENS = {
    'paper', 'cardstock', 'cardboard', 'parchment',
    '纸', '纸张', '宣纸', '卡纸',
}


def _ascii_trigger_in_query(trig_lower: str, query_lower: str) -> bool:
    return bool(re.search(rf'(?<![a-z0-9]){re.escape(trig_lower)}(?![a-z0-9])', query_lower))


def match_recipes(query: str, top_n: int = 5) -> list:
    """匹配北冥音效师复合搜索词配方（DESIGNER_RECIPES），对「工具/动作 + 材质」复合查询优先锁定具体工具动作。"""
    q = str(query or '').strip()
    if not q:
        return []
    ql = q.lower()
    toks = [t.lower() for t in tokenize_query(q)]
    has_cutting = bool(_CUTTING_TOOL_RE.search(q))
    has_scribe = bool(_SCRIBE_TOOL_RE.search(q))
    has_paper_mat = bool(_PASSIVE_PAPER_MATERIAL_RE.search(q))
    has_scroll_book = bool(_EXPLICIT_SCROLL_BOOK_RE.search(q))
    has_toy_brick = bool(_EXPLICIT_TOY_BRICK_RE.search(q))

    hits = []
    for rec in DESIGNER_RECIPES:
        score = 0.0
        rev_matched_toks = set()
        if ql == rec['id'] or ql in [c.lower() for c in rec['catIds']]:
            score += 100.0
        for trig in rec['triggers']:
            tl = trig.lower()
            is_cjk_trig = bool(CJK_RE.search(tl))
            if tl == ql:
                score += 95.0
            elif (tl in ql) if is_cjk_trig else _ascii_trigger_in_query(tl, ql):
                spec_bonus = 18.0 if (' ' in tl or (is_cjk_trig and len(tl) >= 3)) else 0.0
                score += 48.0 + spec_bonus
            elif len(ql) >= 2 and ql in tl and ql not in _GENERIC_SUBSTR_GUARD_TOKENS:
                if '__q__' not in rev_matched_toks:
                    score += 38.0
                    rev_matched_toks.add('__q__')
            else:
                for tok in toks:
                    if len(tok) < 2:
                        continue
                    if tok == tl:
                        score += 28.0
                    elif len(tl) >= 2 and tl in tok and (is_cjk_trig or len(tl) >= 3):
                        score += 22.0
                    elif tok in tl and tok not in _GENERIC_SUBSTR_GUARD_TOKENS and tok not in rev_matched_toks:
                        score += 18.0
                        rev_matched_toks.add(tok)

        if has_cutting:
            if rec['id'] == 'scissors_cut':
                score += 75.0 + (30.0 if has_paper_mat else 0.0)
            elif rec['id'] == 'paper_scroll_book' and not has_scroll_book:
                score = 0.0
            elif rec['id'] in ('latch_brick_snap', 'pen_button_switch', 'sword_blade_metal') and not has_toy_brick:
                score = round(score * 0.18, 1)
        elif has_scribe:
            if rec['id'] == 'drafting_scribe_pen':
                score += 45.0
            elif rec['id'] == 'paper_scroll_book' and not has_scroll_book:
                score = round(score * 0.35, 1)

        if score > 0:
            out = dict(rec)
            out['score'] = round(score, 1)
            hits.append(out)
    hits.sort(key=lambda x: (-x['score'], x['id']))
    return hits[:max(1, int(top_n))]


# 六种影片世界观调性的声族池路由与三干线配比表（与 engine.audio.director.WORLD_PROFILES 严格同构）：
# preferred_cats 按优先级从高到低加权；forbidden_cats 一票剔除违和声族；foley_enabled 控制是否启用独立生命体拟音层。
WORLD_PALETTES = {
    'realistic': {
        'label': '写实实景 / 历史武侠',
        'preferred_cats': [
            'AMB', 'WIND', 'WATR', 'FIRE', 'CLOTH', 'FEET', 'FOLY',
            'WOOD', 'METL', 'ROCK', 'WEAP', 'DOOR', 'LETHR', 'RAIN', 'HORN', 'BOAT',
        ],
        'forbidden_cats': ['TOON', 'SCI', 'UI', 'LASR', 'ROBT', 'MAG', 'FART'],
        'foley_enabled': True,
        'stems_lufs': {'amb': -31.0, 'fx': -17.5, 'foley': -21.0},
        'query_boost': ['foley', 'close-mic', 'dry', 'field-recording'],
        'avoid': ['cartoon', '8bit', 'synth', 'sci-fi', 'laser', 'loop'],
        'fallback_cats': {'amb': ['AMBAir', 'WIND', 'AMBRoom'], 'fx': ['WOODImpt', 'METLImpt', 'ROCKImpt'], 'foley': ['FOLYClth', 'FEETHmn', 'FOLYHand']},
        'default_amb': {
            'desc': '写实自然空间空气声与微风底噪',
            'catIds': ['AMBAir', 'WIND', 'AMBRoom'],
            'identity': ['quiet room tone air', 'gentle breeze open field', 'natural outdoor ambience'],
            'detail': ['distant leaves rustle subtle', 'soft air movement'],
        },
    },
    'semi_realistic': {
        'label': '半写实角色 / 定格积木 / 风格化叙事',
        'preferred_cats': [
            'MECH', 'PLAS', 'WOOD', 'TOY', 'AMB', 'CLOTH', 'FEET',
            'FOLY', 'SWSH', 'WHSH', 'BELL', 'CLOCK', 'PAPR', 'OBJ',
        ],
        'forbidden_cats': ['GORE', 'FART'],
        'foley_enabled': True,
        'stems_lufs': {'amb': -33.0, 'fx': -17.0, 'foley': -22.5},
        'query_boost': ['miniature', 'crisp', 'dry', 'foley', 'plastic', 'wooden'],
        'avoid': ['gore', 'heavy industrial motor', '8bit', 'loop'],
        'fallback_cats': {'amb': ['AMBRoom', 'AMBAir'], 'fx': ['PLASImpt', 'WOODImpt', 'TOYMech'], 'foley': ['FOLYHand', 'FOLYClth', 'FEETHmn']},
        'default_amb': {
            'desc': '定格桌面微空间干净室温底噪',
            'catIds': ['AMBRoom', 'AMBAir'],
            'identity': ['quiet studio room tone', 'soft indoor air bed'],
            'detail': ['subtle paper table presence', 'warm wooden room tone'],
        },
    },
    'hitech': {
        'label': '高科技界面 / 工程拆解 / 抽象数据',
        'preferred_cats': ['UI', 'BEEP', 'LASR', 'MECH', 'CLOCK', 'EQUIP', 'CMPT', 'ELEC'],
        'forbidden_cats': ['TOON', 'GORE', 'CRWD', 'ANML', 'FART', 'MAG'],
        'foley_enabled': False,
        'stems_lufs': {'amb': -38.0, 'fx': -16.5, 'foley': None},
        'query_boost': ['hitech', 'hud', 'telemetry', 'micro', 'precision', 'clean'],
        'avoid': ['cartoon', 'boing', '8bit', 'arcade', 'crowd', 'gore'],
        'fallback_cats': {'amb': ['AMBAir', 'AMBRoom', 'CMPTMisc'], 'fx': ['UIClick', 'MECHClik', 'CLOCKTick'], 'foley': ['MECHClik', 'UIClick']},
        'default_amb': {
            'desc': '超净消声室极低电平精密空气底噪',
            'catIds': ['AMBAir', 'AMBRoom'],
            'identity': ['clean room tone quiet air', 'subtle lab air ambience'],
            'detail': ['ultra quiet studio air'],
        },
    },
    'scifi': {
        'label': '科幻世界 / 未来机甲与力场',
        'preferred_cats': ['SCI', 'LASR', 'ROBT', 'ELEC', 'MOTR', 'MECH', 'AIR', 'UI', 'DSGN'],
        'forbidden_cats': ['TOON', 'FART'],
        'foley_enabled': True,
        'stems_lufs': {'amb': -30.5, 'fx': -16.0, 'foley': -23.5},
        'query_boost': ['sci-fi', 'futuristic', 'servo', 'laser', 'telemetry', 'airlock'],
        'avoid': ['cartoon', 'boing', '8bit', 'retro game'],
        'fallback_cats': {'amb': ['SCIShip', 'AMBAir', 'AIRBlow'], 'fx': ['SCIEnrg', 'LASRBeam', 'ROBTMvmt'], 'foley': ['FOLYClth', 'LETHRMvmt', 'FEETHmn']},
        'default_amb': {
            'desc': '科幻舱室低频循环气流与能量场声床',
            'catIds': ['SCIShip', 'AMBAir', 'AIRBlow'],
            'identity': ['sci-fi spaceship cabin ambience', 'futuristic control room air hum', 'deep airlock ventilation'],
            'detail': ['subtle telemetry background pulse', 'low atmospheric drone clean'],
        },
    },
    'cartoon': {
        'label': '卡通弹性夸张 / 幽默动画',
        'preferred_cats': ['TOON', 'TOY', 'WHST', 'BELL', 'SWSH', 'WHSH', 'BEEP', 'PLAS', 'RUBR', 'MUSC'],
        'forbidden_cats': ['GORE', 'FART'],
        'foley_enabled': True,
        'stems_lufs': {'amb': -35.0, 'fx': -15.5, 'foley': -22.0},
        'query_boost': ['cartoon', 'boing', 'pop', 'whistle', 'toy', 'elastic'],
        'avoid': ['gore', 'flesh', 'blood', 'harsh feedback'],
        'fallback_cats': {'amb': ['AMBAir', 'WIND'], 'fx': ['TOONPop', 'TOONBoing', 'TOYMech'], 'foley': ['TOONSqk', 'FEETHmn', 'CLOTHFlp']},
        'default_amb': {
            'desc': '轻盈留白空气底床（不抢夸张前景点音）',
            'catIds': ['AMBAir', 'WIND'],
            'identity': ['light outdoor breeze clean', 'quiet sunny park air'],
            'detail': ['distant gentle bird chirp'],
        },
    },
    'poetic': {
        'label': '东方水墨写意 / 留白意象',
        'preferred_cats': [
            'WIND', 'WATR', 'BELL', 'MUSC', 'PAPR', 'CLOTH', 'WING',
            'SWSH', 'WHSH', 'AMB', 'RAIN', 'SNOW', 'ROCK', 'WOOD',
        ],
        'forbidden_cats': ['TOON', 'SCI', 'MOTR', 'ROBT', 'LASR', 'GUN', 'BLLT', 'GORE', 'FART'],
        'foley_enabled': True,
        'stems_lufs': {'amb': -32.0, 'fx': -18.5, 'foley': -23.0},
        'query_boost': ['organic', 'bamboo', 'silk', 'resonant', 'calm', 'natural'],
        'avoid': ['motor', 'servo', 'cartoon', '8bit', 'synth', 'sci-fi', 'laser'],
        'fallback_cats': {'amb': ['WIND', 'AMBAir', 'WATRFlow'], 'fx': ['PAPRFric', 'BELLGong', 'ROCKImpt'], 'foley': ['CLOTHFlp', 'PAPRHndl', 'WINGBird']},
        'default_amb': {
            'desc': '东方写意旷野远风与宣纸空气留白声床',
            'catIds': ['WIND', 'AMBAir', 'AMBAlpn'],
            'identity': ['cold mountain wind calm', 'quiet open valley air', 'distant mist breeze'],
            'detail': ['distant bamboo leaves wind', 'subtle water lap'],
        },
    },
}

_ARCHIVED_META_SHORTS = {
    'ADR', 'ASSET', 'BNCE', 'IR', 'LPGRP', 'MIX', 'PFX',
    'PROD', 'RAW', 'REF', 'SCNE', 'TEST', 'TMARK', 'WIP', 'WTF',
}

# 将配方或词表粗分类统一映射到 engine.audio.sfx_judge.ARCHETYPES 的 14 个权威原型名
_TO_JUDGE_ARCH = {
    'friction_cloth': 'friction_cloth',
    'cloth': 'friction_cloth',
    'paper': 'friction_cloth',
    'whoosh': 'whoosh',
    'water': 'water',
    'metal_blade': 'metal_blade',
    'metal': 'metal_blade',
    'impact': 'impact',
    'wood': 'wood',
    'foley_snap': 'foley_snap',
    'footstep': 'foley_snap',
    'mechanical': 'mechanical',
    'ambience': 'ambience',
    'low_drone': 'low_drone',
    'sustained_tonal': 'sustained_tonal',
    'tonal': 'sustained_tonal',
    'tonal_ui': 'tonal_ui',
    'ui': 'tonal_ui',
    'motorized': 'motorized',
    'scrape': 'generic',
    'generic': 'generic',
}

_CATSHORT_TO_JUDGE_ARCH = {
    'AMB': 'ambience', 'WIND': 'ambience', 'RAIN': 'ambience', 'WTHR': 'ambience', 'STORM': 'ambience',
    'CLOTH': 'friction_cloth', 'PAPR': 'friction_cloth', 'LETHR': 'friction_cloth',
    'FEET': 'foley_snap', 'FOLY': 'foley_snap', 'TOY': 'foley_snap',
    'MECH': 'mechanical', 'CLOCK': 'mechanical', 'TOOL': 'mechanical', 'CMPT': 'mechanical',
    'UI': 'tonal_ui', 'BEEP': 'tonal_ui', 'LASR': 'tonal_ui', 'SCI': 'tonal_ui', 'EQUIP': 'tonal_ui',
    'MOTR': 'motorized', 'ROBT': 'motorized',
    'WOOD': 'wood',
    'METL': 'metal_blade', 'WEAP': 'metal_blade', 'CHAIN': 'metal_blade',
    'BELL': 'sustained_tonal', 'HORN': 'sustained_tonal', 'WHST': 'sustained_tonal', 'MUSC': 'sustained_tonal',
    'WATR': 'water', 'LIQ': 'water',
    'SWSH': 'whoosh', 'WHSH': 'whoosh', 'WING': 'whoosh', 'BIRD': 'whoosh', 'AIR': 'whoosh',
    'ROCK': 'impact', 'PLAS': 'impact', 'CERM': 'impact', 'GLAS': 'impact', 'DOOR': 'impact',
    'TOON': 'generic', 'DSGN': 'low_drone',
}

# 分镜/剧本常见中文意象词到可检索声学概念的桥接扩展
_STORYBOARD_BRIDGES = [
    (re.compile(r'窗花|剪纸|裁纸|起剪|运剪|连剪|双刃|钢剪|\b(scissors?|shears?|papercut|snip)\b', re.I), '剪刀 裁纸 双刃剪切 scissors cutting paper snip'),
    (re.compile(r'落笔|书写|毛笔|题写|第一笔|书法|brush|calligraph', re.I), '宣纸 划线 毛笔 paper brush'),
    (re.compile(r'钤印|印章|落款|篆刻|seal|stamp', re.I), '印章 石材 宣纸 stone seal stamp'),
    (re.compile(r'汽笛|雾角|号角|鲲鸣|ferry\s*horn|foghorn', re.I), '雾角 号角 古钟 foghorn horn'),
    (re.compile(r'气压|暗影|低频|潜流|巨物|sub|drone|glimpse|shadow', re.I), '深水 阵风 低鸣 underwater wind rumble'),
    (re.compile(r'唤醒|提醒卡|识别框|导航卡|显示层|wake_ping|ui_scan|ui_fail|ui_nav', re.I), '提示音 菜单 界面 beep menu ui'),
    (re.compile(r'镜腿|轻触|指腹|touch|tap', re.I), '轻触 微动开关 按钮 click tap'),
    (re.compile(r'轻步|快步|慢步|迈步|漫步|踱步|踏.*步', re.I), '脚步 走路 footsteps walk'),
    (re.compile(r'短发|发丝|hair', re.I), '丝绸 布料 微风 silk cloth rustle'),
    (re.compile(r'海草|水草|seaweed|kelp', re.I), '水流 植物 水下 water foliage'),
    (re.compile(r'太阳|日出|破晓|顶点|sun-break|apex', re.I), '古钟 颂钵 泛音 bell gong chime'),
    (re.compile(r'弹跳|q弹|弹簧音|boing|bounce', re.I), '弹簧 卡通弹跳声 spring boing'),
    (re.compile(r'机甲|外骨骼|力场|能量盾|mech|forcefield', re.I), '机器人 伺服 能量 科幻 robot servo energy'),
]

# 世界观专属跨声族概念注入表：保证同一动作意图在不同 world 下精准落入该调性的标志性声族
_WORLD_CONCEPT_HINTS = {
    'cartoon': [
        (re.compile(r'弹簧|弹跳|q弹|跳|spring|boing|bounce|jump', re.I),
         ['TOONBoing', 'TOONPop', 'TOYMech'],
         ['cartoon spring boing', 'elastic rubber bounce', 'toy jack-in-the-box spring'],
         ['bubble pop clean', 'slide whistle short'], 'generic', 'passive'),
        (re.compile(r'打|撞|敲|砸|落|剑|hit|impact|bonk|clang|slam|sword', re.I),
         ['TOONImpt', 'TOONClang', 'TOYMisc', 'PLASImpt'],
         ['cartoon bonk hit', 'hollow wood block pop', 'comic anvil clang'],
         ['rubber squeak toy', 'funny slide whistle'], 'impact', 'passive'),
        (re.compile(r'哨|滑|嗖|蹿|飞|转场|whistle|slide|zip|whoosh|swish', re.I),
         ['WHSTHmn', 'TOONWhis', 'TOONZip', 'TOONSwsh'],
         ['slide whistle cartoon', 'cartoon zip fast whoosh', 'bird whistle call'],
         ['air pop comic', 'woodwind pluck'], 'whoosh', 'passive'),
        (re.compile(r'提示|菜单|叮|星|眨眼|beep|menu|ui|blink|bell|ping', re.I),
         ['TOONPluk', 'TOONPop', 'BELLHand', 'BEEP'],
         ['cartoon bubble pop', 'toy bell ding crisp', 'xylophone comic twinkle'],
         ['finger pop clean', 'small triangle chime'], 'tonal_ui', 'passive'),
    ],
    'scifi': [
        (re.compile(r'门|舱|闸|开|关|door|hatch|airlock|gate', re.I),
         ['SCIDoor', 'AIRHiss', 'MECHHydr'],
         ['sci-fi airlock door', 'futuristic sliding hatch', 'pneumatic seal hiss'],
         ['heavy metal latch clunk', 'servo lock click'], 'whoosh', 'motorized'),
        (re.compile(r'激光|光束|射线|扫描|细线|走线|laser|beam|scan|ray|trace', re.I),
         ['LASRBeam', 'LASRGun', 'SCICmpt'],
         ['sci-fi laser beam pulse', 'futuristic energy scanner', 'hitech telemetry sweep'],
         ['electric arc micro', 'ui data tick fast'], 'tonal_ui', 'digital'),
        (re.compile(r'机器人|机甲|伺服|电机|关节|机械臂|步|robot|mech|servo|motor|joint', re.I),
         ['ROBTMvmt', 'MOTRSrvo', 'SCIMech'],
         ['robotic servo joint movement', 'futuristic mech actuator', 'stepper motor precision'],
         ['metallic gear detent', 'hydraulic valve short'], 'motorized', 'motorized'),
        (re.compile(r'打|撞|冲击|爆炸|力场|能量|武器|hit|impact|blast|shield|energy', re.I),
         ['SCIImpt', 'SCIEnrg', 'LASRImpt', 'DSGNBoom'],
         ['sci-fi energy impact', 'forcefield pulse hit', 'futuristic bass drop'],
         ['electric spark crackle', 'metallic sub resonance'], 'impact', 'digital'),
    ],
    'hitech': [
        (re.compile(r'菜单|弹出|提示|界面|气泡|卡片|唤醒|识别|导航|menu|popup|hud|ui|beep|ping|alert', re.I),
         ['UIBeep', 'UIClick', 'UIAlert', 'UIData', 'BEEPMed', 'EQUIPTech'],
         ['hitech micro beep', 'hud telemetry blip', 'clean futuristic interface click'],
         ['medical monitor soft pip', 'digital micro click clean'], 'tonal_ui', 'digital'),
        (re.compile(r'细线|走线|引出线|划线|标尺|扫描|数据|laser|trace|scan|line|readout|data', re.I),
         ['LASRBeam', 'UIData', 'UIMvmt', 'CMPTMisc'],
         ['hitech laser scan', 'hud telemetry pulse', 'digital data readout ticks'],
         ['high frequency micro pulse', 'micro relay tick'], 'tonal_ui', 'digital'),
        (re.compile(r'齿轮|棘轮|按压|按钮|开关|拆解|卡尺|旋钮|gear|ratchet|click|switch|pen|button|dial', re.I),
         ['MECHGear', 'MECHClik', 'MECHSwtch', 'CLOCKMech', 'CLOCKTick'],
         ['pocket watch escapement', 'micro switch click', 'camera shutter dial'],
         ['micrometer ratchet click', 'watch crown wind'], 'mechanical', 'passive'),
    ],
    'poetic': [
        (re.compile(r'落笔|书写|毛笔|画卷|宣纸|片名|水墨|brush|write|scroll|paper|ink|title', re.I),
         ['PAPRFric', 'PAPRFltr', 'WATRDrip', 'WATRFlow'],
         ['paper scroll unroll', 'soft brush paper sweep', 'single water drop resonant'],
         ['wooden scroll rod tap', 'silk fabric subtle rustle'], 'friction_cloth', 'passive'),
        (re.compile(r'印章|钤印|落款|玉|石|茶盏|瓷|seal|stamp|stone|jade|ceramic', re.I),
         ['ROCKImpt', 'CERMImpt', 'PAPRImpt'],
         ['stone block thud dry', 'ceramic cup clink', 'thick paper stamp press'],
         ['marble slab slide', 'wooden table soft tap'], 'impact', 'passive'),
        (re.compile(r'钟|磬|锣|日出|太阳|顶点|唤醒|提示音|bell|gong|chime|sun|ping', re.I),
         ['BELLGong', 'BELLLrg', 'BELLHand', 'MUSCBell'],
         ['temple bronze bell strike', 'tibetan singing bowl resonant', 'small bronze chime clean'],
         ['wooden bell striker hit', 'calm mountain air tail'], 'sustained_tonal', 'passive'),
    ],
    'realistic': [
        (re.compile(r'唤醒|提示音|界面|识别|导航|菜单|ui|hud|beep|ping', re.I),
         ['BELLHand', 'GLASImpt', 'MECHClik', 'CLOCKTick'],
         ['small glass harmonic tap', 'brass hand bell single', 'clean mechanical switch click'],
         ['watch tick single crisp', 'finger tap glass dry'], 'foley_snap', 'passive'),
    ],
    'semi_realistic': [
        (re.compile(r'积木|拼插|卡扣|塑料|玩具|组装|lego|brick|snap|block|toy|latch', re.I),
         ['PLASImpt', 'TOYMech', 'MECHLtch', 'WOODImpt'],
         ['lego brick click', 'plastic snap latch', 'wooden toy block clack'],
         ['cassette case snap', 'camera lens lock click'], 'impact', 'passive'),
    ],
}

_AMB_STEM_RE = re.compile(
    r'环境|氛围|铺底|声床|底噪|室温|宽空气|空间打开|雾江|晨雾|山风|海风|微风|江面|远山|开阔环境|夜色|雨声连绵|'
    r'\b(amb|ambience|ambiance|room\s*tone|air\s*bed|atmosphere|breeze|fog|open\s*air|background\s*bed|city\s*hum|forest\s*bed)\b',
    re.I,
)
_AMB_EXCLUDE_RE = re.compile(
    r'破空|挥动|甩镜|掠过|惊起|振翅|吹的沙沙|低频气压|暗影划过|'
    r'\b(whoosh|swish|swoosh|whip|flap|takeoff|glimpse|pass\s*by)\b',
    re.I,
)
_FOLEY_STEM_RE = re.compile(
    r'脚步|轻步|快步|慢步|迈步|漫步|踱步|走路|奔跑|踏雪|踏.*步|碎石路|靴子|鞋声|衣袂|衣服|衣料|布料|披风|大氅|袍子|丝绸|袖子|短发|发丝|'
    r'呼吸|喘息|叹气|心跳|手指|指腹|轻触|抓握|抚摸|拍手|跌倒|拳击|拳脚|'
    r'鸽群|鸽子|飞鸟|振翅|翅膀|扑棱|羽毛|马蹄|动物|海草.*摆动|'
    r'\b(foley|footstep|footsteps|walk|walking|run|running|boots|cloth|robe|cape|fabric|rustle|garment|sleeve|hair|'
    r'breath|breathing|sigh|finger|hand\s*touch|grab|bodyfall|pigeon|pigeons|bird|wing|flap|feathers|hoof)\b',
    re.I,
)
_DEVICE_OBJECT_RE = re.compile(
    r'按钮|开关|微动|圆珠笔|笔帽|齿轮|棘轮|镜腿|旋钮|卡扣|插销|螺纹|卡尺|剪刀|剪子|钢剪|裁纸|裁切|菜单|界面|屏幕|键盘|'
    r'\b(button|switch|pen|gear|ratchet|dial|latch|screw|caliper|scissors?|shears?|snip|menu|hud|ui|screen|key)\b',
    re.I,
)
_DIGITAL_UI_RE = re.compile(
    r'提示音|唤醒.*音|识别框|导航卡|菜单弹出|数据流|读数|镭射|激光扫描|报错|'
    r'\b(wake_ping|ui_scan|ui_fail|ui_nav|beep|telemetry|hud|laser\s*scan|readout|glitch)\b',
    re.I,
)


def _resolve_world(world: str = 'realistic') -> str:
    w = str(world or 'realistic').strip().lower()
    if w not in WORLD_PALETTES:
        raise ValueError(f"未知 world 调性 {world!r}；可选：{', '.join(WORLD_PALETTES)}")
    return w


def _normalize_judge_archetype(raw_arch: str = None, *, cat_short: str = None, text: str = '') -> str:
    """将配方分类、UCS 大类简称或文本描述归一化为 sfx_judge.ARCHETYPES 支持的 14 个原型名之一。"""
    t = str(text or '')
    if re.search(r'低频气压|暗影.*低频|潜流|超低频|\b(low_drone|sub_hit|rumble|kun_glimpse|shadow)\b', t, re.I):
        return 'low_drone'
    if re.search(r'汽笛|雾角|号角|鲲鸣|古钟|铜锣|颂钵|\b(foghorn|horn|kun_call|gong|singing\s*bowl)\b', t, re.I):
        return 'sustained_tonal'
    if raw_arch and raw_arch in _TO_JUDGE_ARCH:
        mapped = _TO_JUDGE_ARCH[raw_arch]
        if mapped != 'generic':
            return mapped
    if cat_short and cat_short in _CATSHORT_TO_JUDGE_ARCH:
        return _CATSHORT_TO_JUDGE_ARCH[cat_short]
    from .sfx_judge import infer_archetype
    inferred = infer_archetype(t)
    return inferred if inferred in _TO_JUDGE_ARCH else 'generic'


def _bridge_query(q: str) -> str:
    extra = [aug for pat, aug in _STORYBOARD_BRIDGES if pat.search(q)]
    return f"{q} {' '.join(extra)}".strip() if extra else q


def search_by_world(query: str, world: str = 'realistic', top_n: int = 8) -> dict:
    """按影片世界观调性（WORLD_PALETTES 六种世界观）加权偏好 UCS 大类、剔除禁入大类并重排英文检索词。"""
    w = _resolve_world(world)
    palette = WORLD_PALETTES[w]
    n_lim = max(1, int(top_n))
    q = str(query or '').strip()
    if not q:
        return {
            'query': '',
            'world': w,
            'worldLabel': palette['label'],
            'power': 'passive',
            'archetype': 'generic',
            'preferredCats': list(palette['preferred_cats']),
            'forbiddenCats': list(palette['forbidden_cats']),
            'excludedCats': [],
            'ucs': [],
            'recipes': [],
            'identityQueries': [],
            'detailQueries': [],
            'avoid': list(palette['avoid']),
            'queries': [],
        }

    forb_set = set(palette['forbidden_cats'])
    pref_rank = {cat: idx for idx, cat in enumerate(palette['preferred_cats'])}
    by_cid = {e['catId']: e for e in load_ucs()['entries']}
    q_bridged = _bridge_query(q)

    raw_ucs = search_ucs(q, top_n=753)
    if q_bridged != q:
        seen_raw = {u['catId']: u for u in raw_ucs}
        for u2 in search_ucs(q_bridged, top_n=120):
            if u2['catId'] not in seen_raw:
                u2_copy = dict(u2)
                u2_copy['score'] = round(u2['score'] * 0.78, 1)
                raw_ucs.append(u2_copy)
                seen_raw[u2['catId']] = u2_copy

    raw_recipes = match_recipes(q_bridged, top_n=8)
    excluded_cats = []

    def _note_excluded(cshort):
        if cshort in forb_set and cshort not in excluded_cats:
            excluded_cats.append(cshort)

    # 1. 过滤并按 world 重排音效师配方
    world_recipes = []
    for rec in raw_recipes:
        rec_shorts = [by_cid[c]['catShort'] for c in rec['catIds'] if c in by_cid]
        for cs in rec_shorts:
            _note_excluded(cs)
        allowed_cids = [c for c in rec['catIds'] if c in by_cid and by_cid[c]['catShort'] not in forb_set]
        if not allowed_cids:
            continue
        if rec['power'] == 'motorized' and 'MOTR' in forb_set:
            _note_excluded('MOTR')
            continue
        if rec['power'] == 'digital' and 'UI' in forb_set and 'SCI' in forb_set and w in ('realistic', 'poetic'):
            continue
        pref_hits = [by_cid[c]['catShort'] for c in allowed_cids if by_cid[c]['catShort'] in pref_rank]
        w_bonus = 0.0
        if pref_hits:
            best_idx = min(pref_rank[cs] for cs in pref_hits)
            w_bonus = max(14.0, 42.0 - best_idx * 2.2) + 8.0 * len(pref_hits)
        rc = dict(rec)
        rc['catIds'] = allowed_cids
        rc['score'] = round(rec['score'] + w_bonus, 1)
        world_recipes.append(rc)
    world_recipes.sort(key=lambda x: (-x['score'], x['id']))

    # 2. 合并世界观专属概念提示词条（若已有高置信具体动作配方且其 avoid 明确排斥该提示词，防止泛化材质/积木词劫持具体工具动作）
    raw_hint_matches = [h for h in _WORLD_CONCEPT_HINTS.get(w, ()) if h[0].search(q)]
    if world_recipes and world_recipes[0]['score'] >= 90.0 and w not in ('cartoon', 'scifi'):
        top_avoid_low = [a.lower() for a in world_recipes[0]['avoid']]
        hint_matches = [
            h for h in raw_hint_matches
            if not any(av in phrase.lower() for phrase in h[2] for av in top_avoid_low)
        ]
    else:
        hint_matches = raw_hint_matches

    # 3. 对 UCS 词条执行禁入剔除 + 偏好大类加权
    cand_map = {}

    def _put_ucs(entry_obj, base_sc: float, source_boost: float = 0.0):
        cs = entry_obj['catShort']
        if cs in forb_set:
            _note_excluded(cs)
            return
        if cs in _ARCHIVED_META_SHORTS and entry_obj['catId'].lower() != q.lower():
            return
        mult = 1.0
        add = source_boost
        if cs in pref_rank:
            r_idx = pref_rank[cs]
            mult = 1.55 if r_idx < 4 else (1.35 if r_idx < 9 else 1.20)
            add += max(16.0, 52.0 - r_idx * 3.0)
        final_sc = round(base_sc * mult + add, 1)
        cid = entry_obj['catId']
        prev = cand_map.get(cid)
        if prev is None or final_sc > prev['score']:
            cand_map[cid] = {
                'score': final_sc,
                'baseScore': round(base_sc, 1),
                'worldBoost': round(final_sc - base_sc, 1),
                'catId': cid,
                'catShort': cs,
                'category': entry_obj['category'],
                'subCategory': entry_obj['subCategory'],
                'categoryZh': entry_obj['categoryZh'],
                'subCategoryZh': entry_obj['subCategoryZh'],
                'explanation': entry_obj['explanation'],
                'matchedEn': list(entry_obj.get('matchedEn') or []),
                'matchedZh': list(entry_obj.get('matchedZh') or []),
                'synonymsEn': entry_obj['synonymsEn'],
                'synonymsZh': entry_obj['synonymsZh'],
            }

    for u in raw_ucs:
        _put_ucs(u, u['score'])
    for rec in world_recipes[:3]:
        if rec['score'] >= 40.0:
            for cid in rec['catIds']:
                if cid in by_cid:
                    _put_ucs(by_cid[cid], rec['score'], source_boost=12.0)
    for idx_h, (_, h_cids, _, _, _, _) in enumerate(hint_matches):
        for rank_c, cid in enumerate(h_cids):
            if cid in by_cid:
                _put_ucs(by_cid[cid], 95.0 - idx_h * 8.0 - rank_c * 4.0, source_boost=28.0)

    # 若原查询命中的大类全部被当前 world 剔除（例如在 realistic 下搜纯科幻词），启用本世界观安全声族兜底
    if not cand_map:
        fb_cids = palette['fallback_cats']['fx']
        for rank_c, cid in enumerate(fb_cids):
            if cid in by_cid:
                _put_ucs(by_cid[cid], 35.0 - rank_c * 3.0, source_boost=10.0)

    ucs_hits = sorted(cand_map.values(), key=lambda x: (-x['score'], x['catId']))[:n_lim]

    # 4. 生成按 world 调性裁剪的 Identity / Detail / Avoid 检索词
    id_queries, det_queries, avoid_list = [], [], []
    seen_id, seen_det, seen_av = set(), set(), set()

    def _push(dst, seen_s, text_item):
        p = re.sub(r'\s+', ' ', str(text_item or '')).strip()
        if p and p.lower() not in seen_s:
            seen_s.add(p.lower())
            dst.append(p)

    for _, _, h_id, h_det, _, _ in hint_matches:
        for x in h_id:
            _push(id_queries, seen_id, x)
        for x in h_det:
            _push(det_queries, seen_det, x)

    top_rec_avoid = [a.lower() for a in world_recipes[0]['avoid']] if world_recipes else []
    for r_idx, rec in enumerate(world_recipes[:2]):
        if r_idx > 0 and rec['score'] < world_recipes[0]['score'] * 0.55:
            continue
        for iq in rec['identityQueries'][:4 if r_idx == 0 else 3]:
            if r_idx == 0 or not any(av in iq.lower() for av in top_rec_avoid):
                _push(id_queries, seen_id, iq)
        for dq in rec['detailQueries'][:3]:
            if r_idx == 0 or not any(av in dq.lower() for av in top_rec_avoid):
                _push(det_queries, seen_det, dq)
        for av in rec['avoid']:
            _push(avoid_list, seen_av, av)

    if len(id_queries) < 3:
        w_prefix = {
            'cartoon': 'cartoon',
            'scifi': 'sci-fi',
            'hitech': 'hitech',
            'poetic': 'natural',
            'semi_realistic': 'crisp',
            'realistic': 'foley',
        }[w]
        for u in ucs_hits[:3]:
            sub_w = u['subCategory'].lower().replace('&', ' ').strip()
            cat_w = u['category'].lower().replace('&', ' ').strip()
            syns = u['matchedEn'][:2] if u['matchedEn'] else u['synonymsEn'][:2]
            for syn in syns:
                sl = syn.lower()
                if w in ('cartoon', 'scifi', 'hitech') and w_prefix not in sl and w_prefix not in cat_w:
                    _push(id_queries, seen_id, f"{w_prefix} {sl} {sub_w}".strip())
                elif sl not in sub_w:
                    _push(id_queries, seen_id, f"{sl} {sub_w}".strip())
                else:
                    _push(id_queries, seen_id, f"{sl} {cat_w}".strip())

    if not det_queries:
        boost_pair = ' '.join(palette['query_boost'][:2])
        top_sub = ucs_hits[0]['subCategory'].lower() if ucs_hits else 'texture'
        _push(det_queries, seen_det, f"{boost_pair} {top_sub}".strip())

    for av in palette['avoid']:
        _push(avoid_list, seen_av, av)

    # 判定本体守卫 power 与 sfx_judge 原型 archetype
    if hint_matches:
        _, _, _, _, h_arch, h_pow = hint_matches[0]
        power = h_pow
        judge_arch = _normalize_judge_archetype(h_arch, cat_short=ucs_hits[0]['catShort'] if ucs_hits else None, text=q)
    elif world_recipes:
        top_r = world_recipes[0]
        power = top_r['power']
        judge_arch = _normalize_judge_archetype(top_r['archetype'], cat_short=ucs_hits[0]['catShort'] if ucs_hits else None, text=q)
    else:
        top_cs = ucs_hits[0]['catShort'] if ucs_hits else None
        if top_cs in ('UI', 'BEEP', 'LASR') or (top_cs == 'SCI' and w in ('hitech', 'scifi')):
            power = 'digital'
        elif top_cs in ('MOTR', 'ROBT') and 'MOTR' not in forb_set:
            power = 'motorized'
        else:
            power = 'passive'
        judge_arch = _normalize_judge_archetype(None, cat_short=top_cs, text=q)

    if power == 'passive':
        for m_av in ('servo', 'electric motor'):
            _push(avoid_list, seen_av, m_av)

    queries = []
    seen_q = set()
    q_clean = re.sub(r'\s+', ' ', q).strip()
    is_ascii_q = bool(q_clean and not CJK_RE.search(q_clean))
    q_violates_avoid = any(av.lower() in q_clean.lower() for av in avoid_list) if is_ascii_q else False
    candidate_pool_low = {p.lower() for p in (*id_queries, *det_queries)}
    if is_ascii_q and not excluded_cats and q_clean.lower() in candidate_pool_low:
        seen_q.add(q_clean.lower())
        queries.append(q_clean)
    for phrase in id_queries[:4]:
        if phrase.lower() not in seen_q:
            seen_q.add(phrase.lower())
            queries.append(phrase)
    if is_ascii_q and not excluded_cats and not q_violates_avoid and q_clean.lower() not in seen_q and len(tokenize_query(q_clean)) >= 2:
        seen_q.add(q_clean.lower())
        queries.append(q_clean)
    for phrase in det_queries[:3]:
        if phrase.lower() not in seen_q:
            seen_q.add(phrase.lower())
            queries.append(phrase)
    if is_ascii_q and q_clean.lower() not in seen_q and not excluded_cats and not q_violates_avoid:
        queries.append(q_clean)

    return {
        'query': q,
        'world': w,
        'worldLabel': palette['label'],
        'power': power,
        'archetype': judge_arch,
        'preferredCats': list(palette['preferred_cats']),
        'forbiddenCats': list(palette['forbidden_cats']),
        'excludedCats': excluded_cats,
        'ucs': ucs_hits,
        'recipes': world_recipes[:5],
        'identityQueries': id_queries[:6],
        'detailQueries': det_queries[:5],
        'avoid': avoid_list,
        'queries': queries[:n_lim],
    }


def classify_stem(cue_desc, world: str = 'realistic') -> dict:
    """判定任意画面声音需求归属三干线中的哪一层（'amb' 环境层 / 'fx' 硬效与设计层 / 'foley' 生命体动作拟音层），
    并在纯无生命体 hitech 世界观下对非必要生命体拟音给出跳过（skip）或降级并入 fx（downgrade_to_fx）建议。"""
    w = _resolve_world(world)
    palette = WORLD_PALETTES[w]
    domain = ''
    if isinstance(cue_desc, dict):
        domain = str(cue_desc.get('domain') or '').strip().lower()
        parts = [
            str(cue_desc.get('desc') or ''),
            str(cue_desc.get('visual') or ''),
            str(cue_desc.get('note') or ''),
            str(cue_desc.get('audio') or ''),
            str(cue_desc.get('id') or ''),
        ]
        text = ' '.join(p for p in parts if p).strip()
    else:
        text = str(cue_desc or '').strip()

    signals = []
    amb_hits = [m.group(0) for m in _AMB_STEM_RE.finditer(text)]
    amb_excl = bool(_AMB_EXCLUDE_RE.search(text))
    foley_hits = [m.group(0) for m in _FOLEY_STEM_RE.finditer(text)]
    has_device = bool(_DEVICE_OBJECT_RE.search(text))
    has_digital_ui = bool(_DIGITAL_UI_RE.search(text))

    if domain in ('amb', 'ambience'):
        raw_stem = 'amb'
        signals.append(f'domain={domain}')
    elif domain == 'foley':
        raw_stem = 'foley'
        signals.append('domain=foley')
    elif domain == 'ui' and has_digital_ui and not re.search(r'手指|指腹|轻触镜腿|cloth|footstep', text, re.I):
        raw_stem = 'fx'
        signals.append('domain=ui(digital)')
    elif amb_hits and not amb_excl and not foley_hits:
        raw_stem = 'amb'
        signals.extend(amb_hits[:3])
    elif foley_hits and not (has_digital_ui and not re.search(r'手指|指腹|轻触|脚步|衣|发丝|呼吸|翅|鸽', text, re.I)):
        raw_stem = 'foley'
        signals.extend(foley_hits[:3])
    else:
        ucs_top = search_ucs(_bridge_query(text), top_n=3) if text else []
        top_short = ucs_top[0]['catShort'] if ucs_top else ''
        top_score = float(ucs_top[0]['score']) if ucs_top else 0.0
        if top_short in ('AMB', 'RAIN', 'WTHR', 'STORM') and top_score >= 48.0 and not amb_excl and domain not in ('sfx', 'fx', 'ui', 'text'):
            raw_stem = 'amb'
            signals.append(f'ucs={top_short}')
        elif top_short in ('FEET', 'FOLY', 'CLOTH', 'HMN', 'ANML') and top_score >= 48.0 and not has_device:
            raw_stem = 'foley'
            signals.append(f'ucs={top_short}')
        else:
            raw_stem = 'fx'
            signals.append(f'ucs={top_short}' if top_short else 'hard_fx_or_designed')

    stem = raw_stem
    action = 'keep'
    enabled = True
    if raw_stem == 'amb':
        reason = '持续空间声床与环境空气底噪，归入 amb 环境氛围干线'
        suggestion = '按场景切点使用 55 ms 等功率微交叉淡化（hard_cut）或 J/L-cut 声桥铺底'
    elif raw_stem == 'foley':
        if not palette['foley_enabled']:
            if has_device:
                stem = 'fx'
                action = 'downgrade_to_fx'
                enabled = True
                reason = 'hitech 纯无生命体调性关闭独立 foley 轨，但画面含机械/界面交互主体'
                suggestion = '剥离皮肤/衣料等生命体摩擦声，降级并入 fx 干线（改用精密微动开关或 HUD 微点击）'
            else:
                stem = 'foley'
                action = 'skip'
                enabled = False
                reason = 'hitech 纯无生命体调性（foley_enabled=False）不设人物/生物拟音轨'
                suggestion = '非必要生命体拟音建议直接跳过（skip）；若确需动势衬托可降级为 fx 极简高频微脉冲或纯净气流'
        else:
            reason = '人物/动物/生物肢体、脚步、衣料或手部触碰动作，归入 foley 拟音干线'
            suggestion = '优先选 close-mic / dry 近场单次干声，连续同类动作启用 ActionVariationDeck 防机关枪效应'
    else:
        reason = '器物机关、物理冲击、自然瞬态、巨物设计声或 UI 编码界面音，归入 fx 硬效干线'
        suggestion = '拆分为认知锚点层（Identity）与高频精密/质感叠层（Detail），严守 power 动力源本体门禁'

    return {
        'stem': stem,
        'rawStem': raw_stem,
        'world': w,
        'action': action,
        'enabled': enabled,
        'reason': reason,
        'suggestion': suggestion,
        'matchedSignals': signals,
    }


def _cues_dict_to_events(raw_spec: dict, fps: int) -> list:
    """当 film.json（如 C 路线模版）未显式写 events 而使用 tempo + cues 节拍打点表时，自动换算为候选声音事件列表。"""
    cues_map = raw_spec.get('cues')
    if not isinstance(cues_map, dict) or not cues_map:
        return []
    tempo_list = raw_spec.get('tempo') or [{'id': 'A', 't0': 0, 'bpm': 90, 'meter': 4}]
    sec_by_id = {str(s.get('id', 'A')): s for s in tempo_list if isinstance(s, dict)}
    default_sec = next(iter(sec_by_id.values()), {'t0': 0.0, 'bpm': 90.0, 'meter': 4})

    cue_semantics = [
        (re.compile(r'^touch$|^tap$', re.I), '手指轻触起拍微响'),
        (re.compile(r'^title$|片名', re.I), '片名落笔宣纸毛笔书写'),
        (re.compile(r'^seal$|印', re.I), '金石篆刻印章落款'),
        (re.compile(r'^s\d+$|^step\d+$|^beat\d+$', re.I), '水墨笔触划线与木头敲击点音'),
    ]
    out = []
    for cue_id, addr in cues_map.items():
        t_s = 0.0
        if isinstance(addr, (list, tuple)) and len(addr) >= 2:
            sec = sec_by_id.get(str(addr[0]), default_sec)
            bar = float(addr[1])
            beat = float(addr[2]) if len(addr) >= 3 else 1.0
            frac = float(addr[3]) if len(addr) >= 4 else 0.0
            bpm = max(1.0, float(sec.get('bpm', 90.0)))
            meter = float(sec.get('meter', 4.0))
            t_s = float(sec.get('t0', 0.0)) + ((bar - 1.0) * meter + (beat - 1.0) + frac) * (60.0 / bpm)
        elif isinstance(addr, (int, float)):
            t_s = float(addr)
        desc = next((d for pat, d in cue_semantics if pat.search(str(cue_id))), f'画面节奏打点 {cue_id}')
        out.append({
            'id': f'cue:{cue_id}',
            'frame': int(round(t_s * fps)),
            'audio': str(cue_id),
            'desc': desc,
        })
    return out


def _build_pool_entry(*, item_id: str, stem: str, shot_id: str, desc: str, world: str,
                      t_s: float = None, in_s: float = None, out_s: float = None,
                      perspective: str = None, transition: str = None, note: str = None) -> dict:
    """调用 search_by_world 构建单条候选池记录，确保 CatID、sfx_judge archetype、power 与三组检索词完整一致。"""
    palette = WORLD_PALETTES[world]
    sbw = search_by_world(desc, world=world, top_n=6)
    cat_ids = [u['catId'] for u in sbw['ucs'][:4]]
    if not cat_ids:
        cat_ids = list(palette['fallback_cats'].get(stem, palette['fallback_cats']['fx']))

    arch = sbw['archetype']
    power = sbw['power']
    if stem == 'amb':
        arch = 'ambience'
        if world != 'scifi' and 'MOTR' in palette['forbidden_cats']:
            power = 'passive'
    elif stem == 'foley':
        power = 'passive'
        if arch in ('ambience', 'tonal_ui', 'sustained_tonal', 'low_drone'):
            arch = _normalize_judge_archetype('foley_snap', text=desc)

    identity = list(sbw['identityQueries'][:4])
    detail = list(sbw['detailQueries'][:3])
    avoid = list(sbw['avoid'])
    if stem == 'foley' and 'foley' not in ' '.join(identity).lower():
        detail = [*detail, 'close-mic dry single foley'][:4]

    queries = []
    seen = set()
    for q_str in (*identity, *detail):
        if q_str.lower() not in seen:
            seen.add(q_str.lower())
            queries.append(q_str)

    entry = {
        'id': item_id,
        'stem': stem,
        'shot': shot_id,
        'desc': desc,
        'catId': cat_ids[0],
        'catIds': cat_ids,
        'archetype': arch,
        'power': power,
        'identity': identity,
        'detail': detail,
        'avoid': avoid,
        'queries': queries[:6],
    }
    if in_s is not None:
        entry['in_s'] = round(float(in_s), 3)
    if out_s is not None:
        entry['out_s'] = round(float(out_s), 3)
    if t_s is not None:
        entry['t_s'] = round(float(t_s), 3)
    if transition:
        entry['transition'] = transition
    if perspective:
        entry['perspective'] = perspective
    if note:
        entry['note'] = note
    return entry


# 复合场景三层环境声拆解词典（Scene Ambience Decomposition）：
# 防止搜单个泛词（如“海边”只铺一条白噪海浪）漏掉画面里真实共存的多层空间声——
# 每个场景标准拆解为：base_hum（远景底床）+ primary_texture（主环境纹理）+ spot_life（间歇生机点缀）。
SCENE_AMBIENCE_LAYERS = {
    'coastal_town': {
        'title': '海岸小镇 / 海滨电车公路 / 港口海岬',
        'triggers': ['海岸', '海边', '海滨', '海岬', '海浪', '沙滩', '港口', '灯塔', '海风', '海面', '海湾', '镰仓', '沿海',
                     'coast', 'coastal', 'seaside', 'beach', 'ocean', 'shore', 'harbor', 'lighthouse'],
        'base_hum': {
            'desc': '海岬小镇远景生活底噪与海平面开阔空气声床',
            'catIds': ['AMBTown', 'AMBUrbn', 'AMBAir'],
            'queries': ['coastal town distant ambience', 'distant city traffic hum quiet', 'open seaside air bed'],
            'avoid': ['car horn close', 'siren', 'harsh wind buffeting'],
            'mixHint': {'gainDb': -4.5, 'lpHz': 4200.0},
        },
        'primary_texture': {
            'desc': '近岸海浪周期拍岸呼吸与潮水退洗纹理',
            'catIds': ['WATRWave', 'WATRSurf', 'AMBSea'],
            'queries': ['ocean waves shore wash', 'gentle sea surf lap', 'coastal breeze steady'],
            'avoid': ['tsunami', 'toilet', 'white noise synth'],
            'mixHint': {'gainDb': 0.0, 'lpHz': 9800.0},
        },
        'spot_life': {
            'desc': '天空海鸥间歇鸣叫与夏蝉/远船微声点缀',
            'catIds': ['BIRDSea', 'AMBInsc', 'ANMLInsc'],
            'queries': ['seagull call coastal', 'distant gulls cry', 'summer cicada coastal'],
            'avoid': ['human vocal imitation', 'chicken', 'synth'],
            'mixHint': {'gainDb': -2.0, 'intervalSec': (2.2, 4.8)},
        },
    },
    'urban_street': {
        'title': '都市街区 / 现代街道 / 天桥十字路口',
        'triggers': ['都市', '城市', '街道', '街区', '马路', '天桥', '十字路口', '楼群',
                     'city', 'urban', 'street', 'downtown', 'avenue', 'metropolis'],
        'base_hum': {
            'desc': '远景城市交通稳态低鸣与高楼峡谷空气底床',
            'catIds': ['AMBUrbn', 'AMBTraf', 'AMBAir'],
            'queries': ['distant city hum skyline', 'quiet urban background ambience', 'distant traffic bed'],
            'avoid': ['loud police siren', 'honking jam', 'music'],
            'mixHint': {'gainDb': -4.0, 'lpHz': 3800.0},
        },
        'primary_texture': {
            'desc': '中景穿街微风、行道树沙沙与偶发轮胎轻滑纹理',
            'catIds': ['AMBTown', 'WINDVege', 'AMBSubn'],
            'queries': ['city street breeze trees', 'quiet neighborhood street ambience', 'urban park air'],
            'avoid': ['crowd shouting', 'construction jackhammer'],
            'mixHint': {'gainDb': 0.0, 'lpHz': 9200.0},
        },
        'spot_life': {
            'desc': '麻雀/城市飞鸟短鸣、远景车铃或远处人声微影',
            'catIds': ['BIRDSong', 'BIRDCrow', 'AMBPark'],
            'queries': ['city sparrow chirp single', 'distant crow call', 'distant bicycle bell street'],
            'avoid': ['close talking speech', 'loud bark'],
            'mixHint': {'gainDb': -2.5, 'intervalSec': (2.5, 5.2)},
        },
    },
    'suburban_railway': {
        'title': '郊外铁道 / 电车站台 / 道口沿线',
        'triggers': ['铁道', '铁轨', '电车', '火车', '站台', '道口', '月台',
                     'railway', 'railroad', 'tram', 'streetcar', 'station', 'platform', 'crossing'],
        'base_hum': {
            'desc': '城郊开阔地平线远景底噪与小镇微弱生活声',
            'catIds': ['AMBSubn', 'AMBTown', 'AMBAir'],
            'queries': ['suburban town quiet ambience', 'open horizon air bed', 'distant town hum'],
            'avoid': ['airport jet', 'heavy highway'],
            'mixHint': {'gainDb': -4.5, 'lpHz': 4200.0},
        },
        'primary_texture': {
            'desc': '铁轨沿线草丛微风与架空线/站台轻柔空气纹理',
            'catIds': ['WINDVege', 'WIND', 'TRNTram'],
            'queries': ['gentle breeze grass field', 'quiet railway station outdoor air', 'soft wind wires'],
            'avoid': ['diesel locomotive idle close', 'harsh hiss'],
            'mixHint': {'gainDb': 0.0, 'lpHz': 9500.0},
        },
        'spot_life': {
            'desc': '沿线飞鸟/乌鸦或夏蝉点缀与极远轨道微响',
            'catIds': ['BIRDCrow', 'BIRDSong', 'ANMLInsc'],
            'queries': ['distant crow call outdoor', 'sparrow chirp dry', 'summer cicada trees'],
            'avoid': ['loud train crash', 'alarm'],
            'mixHint': {'gainDb': -2.5, 'intervalSec': (2.6, 5.5)},
        },
    },
    'mountain_valley_forest': {
        'title': '山谷竹林 / 旷野山林 / 雾江山水',
        'triggers': ['山谷', '山林', '森林', '树林', '竹林', '山风', '雾江', '晨雾', '旷野', '江面', '远山',
                     'mountain', 'valley', 'forest', 'woods', 'bamboo', 'mist', 'fog', 'wilderness', 'canyon'],
        'base_hum': {
            'desc': '远山峡谷开阔低频风底与雾气漫射声床',
            'catIds': ['AMBAlpn', 'WIND', 'AMBAir'],
            'queries': ['cold mountain valley wind', 'open canyon air ambience', 'misty river quiet air'],
            'avoid': ['traffic hum', 'microphone wind rumble'],
            'mixHint': {'gainDb': -4.0, 'lpHz': 3600.0},
        },
        'primary_texture': {
            'desc': '近中景树叶/竹叶随风沙沙起伏与潺潺流水纹理',
            'catIds': ['WINDVege', 'AMBForst', 'WATRLap'],
            'queries': ['wind through bamboo leaves', 'forest leaves rustle breeze', 'calm river water lap'],
            'avoid': ['chainsaw', 'heavy storm'],
            'mixHint': {'gainDb': 0.0, 'lpHz': 9600.0},
        },
        'spot_life': {
            'desc': '幽谷林鸟间歇清啼、飞鸟振翅或枯枝微响',
            'catIds': ['BIRDSong', 'AMBBird', 'ANMLInsc'],
            'queries': ['single forest bird call', 'distant mountain bird song', 'subtle twig creak forest'],
            'avoid': ['tropical jungle monkey', 'traffic'],
            'mixHint': {'gainDb': -2.5, 'intervalSec': (2.8, 6.0)},
        },
    },
    'rainy_eaves_alley': {
        'title': '雨巷屋檐 / 连绵雨夜街景',
        'triggers': ['雨', '雨夜', '雨巷', '屋檐', '细雨', '暴雨', '积水',
                     'rain', 'rainy', 'drizzle', 'downpour', 'eaves', 'wet alley'],
        'base_hum': {
            'desc': '远景连绵雨幕漫射底噪与潮湿夜色空气床',
            'catIds': ['RAIN', 'AMBAir', 'AMBTown'],
            'queries': ['steady gentle rain background', 'distant rain curtain ambience', 'wet night street hum'],
            'avoid': ['white noise static', 'frying bacon'],
            'mixHint': {'gainDb': -4.5, 'lpHz': 4500.0},
        },
        'primary_texture': {
            'desc': '近中景雨滴敲打屋檐木瓦/石板纹理',
            'catIds': ['RAINWood', 'RAINConc', 'WATRFlow'],
            'queries': ['rain on wooden roof eaves', 'rain hitting stone pavement', 'gentle gutter water trickle'],
            'avoid': ['shower bathroom', 'faucet'],
            'mixHint': {'gainDb': 0.0, 'lpHz': 10500.0},
        },
        'spot_life': {
            'desc': '间歇屋檐水珠滴落水洼与极远处低沉闷雷',
            'catIds': ['WATRDrip', 'BIRDSong'],
            'queries': ['single water drop puddle', 'eaves water drip resonant'],
            'avoid': ['loud close thunder crack'],
            'mixHint': {'gainDb': -2.0, 'intervalSec': (1.8, 4.2)},
        },
    },
    'summer_countryside_dusk': {
        'title': '夏日乡野 / 黄昏田园 / 河堤暮色',
        'triggers': ['夏日', '夏天', '黄昏', '暮色', '夕阳', '傍晚', '乡野', '田野', '河堤', '草地',
                     'summer', 'dusk', 'sunset', 'evening', 'countryside', 'meadow', 'rural', 'riverbank'],
        'base_hum': {
            'desc': '黄昏原野温暖微风与远村隐约生活声床',
            'catIds': ['AMBRurl', 'AMBAir', 'WIND'],
            'queries': ['quiet countryside evening ambience', 'warm sunset meadow air', 'distant village hum'],
            'avoid': ['highway truck', 'tractor engine'],
            'mixHint': {'gainDb': -4.5, 'lpHz': 4000.0},
        },
        'primary_texture': {
            'desc': '草浪拂动与河水轻拍堤岸呼吸纹理',
            'catIds': ['WINDVege', 'WATRLap', 'AMBInsc'],
            'queries': ['tall grass breeze rustle', 'gentle riverbank water lap', 'evening summer insects soft'],
            'avoid': ['harsh cicada buzz clipping'],
            'mixHint': {'gainDb': 0.0, 'lpHz': 9500.0},
        },
        'spot_life': {
            'desc': '暮蝉短鸣、远处犬吠或归巢飞鸟点缀',
            'catIds': ['ANMLInsc', 'ANMLDog', 'BIRDCrow'],
            'queries': ['evening cicada call japan', 'distant dog bark countryside', 'evening bird call single'],
            'avoid': ['close aggressive dog growl'],
            'mixHint': {'gainDb': -2.5, 'intervalSec': (2.5, 5.5)},
        },
    },
    'quiet_interior_room': {
        'title': '安静室内 / 书房工坊 / 教室桌面',
        'triggers': ['室内', '房间', '书房', '教室', '工坊', '桌面', '工作室', '卧室',
                     'indoor', 'interior', 'room', 'studio', 'classroom', 'workshop', 'desk'],
        'base_hum': {
            'desc': '干净建筑室温空气底床（Room Tone）',
            'catIds': ['AMBRoom', 'AMBAir'],
            'queries': ['quiet room tone clean', 'warm indoor studio air bed', 'silent room presence'],
            'avoid': ['loud hvac fan', 'refrigerator buzz', 'hum 60hz'],
            'mixHint': {'gainDb': -5.0, 'lpHz': 3600.0},
        },
        'primary_texture': {
            'desc': '窗边极轻空气流动与木质室内暖感空间呼吸',
            'catIds': ['AMBRoom', 'AMBHome'],
            'queries': ['quiet wooden room ambience', 'soft window air presence'],
            'avoid': ['people talking', 'television'],
            'mixHint': {'gainDb': -1.0, 'lpHz': 7800.0},
        },
        'spot_life': {
            'desc': '窗外隐约远鸟或极轻钟表秒针呼吸点缀',
            'catIds': ['CLOCKTick', 'BIRDSong'],
            'queries': ['soft wall clock tick distant', 'muffled outdoor bird through window'],
            'avoid': ['cuckoo alarm', 'loud door slam'],
            'mixHint': {'gainDb': -4.0, 'intervalSec': (3.5, 7.0)},
        },
    },
    'ancient_courtyard_temple': {
        'title': '古建庭院 / 山寺禅院 / 东方水墨意境',
        'triggers': ['庭院', '古寺', '寺庙', '禅院', '水墨', '宣纸', '亭台', '古风',
                     'courtyard', 'temple', 'shrine', 'zen', 'pavilion', 'ink'],
        'base_hum': {
            'desc': '幽静山院开阔空气留白与远谷微风',
            'catIds': ['AMBAir', 'AMBAlpn', 'WIND'],
            'queries': ['quiet temple courtyard air', 'calm mountain mist breeze', 'open zen garden room tone'],
            'avoid': ['city traffic', 'motor'],
            'mixHint': {'gainDb': -5.0, 'lpHz': 3800.0},
        },
        'primary_texture': {
            'desc': '庭前修竹轻拂与细微檐下气流纹理',
            'catIds': ['WINDVege', 'WATRDrip'],
            'queries': ['bamboo leaves gentle wind', 'calm garden water trickle'],
            'avoid': ['heavy rainstorm'],
            'mixHint': {'gainDb': -0.5, 'lpHz': 9000.0},
        },
        'spot_life': {
            'desc': '远处古钟余韵、檐角风铃轻碰或孤鸟单鸣',
            'catIds': ['BELLGong', 'BELLHand', 'BIRDSong'],
            'queries': ['distant temple bell chime soft', 'small bronze wind chime gentle', 'single mountain bird call'],
            'avoid': ['bicycle bell', 'alarm'],
            'mixHint': {'gainDb': -3.0, 'intervalSec': (3.5, 7.5)},
        },
    },
    'scifi_cabin_lab': {
        'title': '科幻舱室 / 飞船舰桥 / 高科技精密实验室',
        'triggers': ['太空舱', '飞船', '舰桥', '机甲舱', '控制室', '实验室', '数据中心', '科幻舱',
                     'spaceship', 'cabin', 'cockpit', 'bridge', 'control room', 'lab', 'datacenter'],
        'base_hum': {
            'desc': '舱体深层生命维持气流与稳态低频空间底床',
            'catIds': ['SCIShip', 'AIRBlow', 'AMBAir'],
            'queries': ['sci-fi spaceship cabin hum', 'deep airlock ventilation clean', 'clean lab room tone air'],
            'avoid': ['alarm siren', 'harsh distortion'],
            'mixHint': {'gainDb': -4.5, 'lpHz': 3400.0},
        },
        'primary_texture': {
            'desc': '精密仪器微弱冷风与洁净空间电磁静谧纹理',
            'catIds': ['AMBTech', 'CMPTMisc', 'AMBRoom'],
            'queries': ['futuristic control room quiet air', 'clean server lab subtle air'],
            'avoid': ['retro 8bit', 'loud fan whine'],
            'mixHint': {'gainDb': -1.0, 'lpHz': 8500.0},
        },
        'spot_life': {
            'desc': '间歇极轻遥测状态微脉冲或远处气阀微呼吸',
            'catIds': ['CMPTMisc', 'AIRHiss'],
            'queries': ['subtle telemetry status blip quiet', 'soft pneumatic micro release'],
            'avoid': ['loud laser pew', 'klaxon'],
            'mixHint': {'gainDb': -3.5, 'intervalSec': (3.2, 6.5)},
        },
    },
}


def decompose_scene_ambience(scene_desc, world: str = 'realistic') -> dict:
    """将场景描述拆解为三层立体声环境构成方案：
    · base_hum（远景底床）：如都市/小镇远景底噪、山谷远风；
    · primary_texture（主环境纹理）：如近岸海浪呼吸、雨打屋檐、树叶微风；
    · spot_life（间歇生机点缀）：如天空海鸥啼叫、暮蝉、林鸟、远犬；
    自动按 world 过滤 WORLD_PALETTES 禁入大类，供 fetch_sfx 检索与 editorial.build_layered_ambience 合成。"""
    w = _resolve_world(world)
    palette = WORLD_PALETTES[w]
    forb_set = set(palette['forbidden_cats'])
    by_cid = {e['catId']: e for e in load_ucs()['entries']}
    text = str(scene_desc or '').strip()
    tl = text.lower()

    _TIME_MODIFIERS = {'夏日', '夏天', '黄昏', '暮色', '夕阳', '傍晚', 'summer', 'dusk', 'sunset', 'evening'}
    best_key = None
    best_score = 0.0
    for k, spec in SCENE_AMBIENCE_LAYERS.items():
        sc = 0.0
        for trig in spec['triggers']:
            trl = trig.lower()
            w_mult = 0.22 if trl in _TIME_MODIFIERS else 1.0
            if trl == tl and tl:
                sc += 60.0 * w_mult
            elif trl in tl:
                sc += (28.0 if len(trl) >= 2 else 14.0) * w_mult
        if sc > best_score:
            best_score = sc
            best_key = k

    if best_key is None:
        default_by_world = {
            'scifi': 'scifi_cabin_lab',
            'hitech': 'quiet_interior_room',
            'poetic': 'ancient_courtyard_temple',
            'semi_realistic': 'quiet_interior_room',
            'cartoon': 'summer_countryside_dusk',
            'realistic': 'mountain_valley_forest',
        }
        best_key = default_by_world[w]

    spec = SCENE_AMBIENCE_LAYERS[best_key]

    def _clean_layer(role_key: str, raw_layer: dict) -> dict:
        cids = [c for c in raw_layer['catIds'] if c in by_cid and by_cid[c]['catShort'] not in forb_set]
        enabled = True
        desc_out = raw_layer['desc']
        qs_out = list(raw_layer['queries'])
        if role_key == 'spot_life' and not palette['foley_enabled']:
            # hitech 纯无生命体调性自动抑制鸟虫犬等生物点缀，改为洁净微空气/遥测呼吸或静默留白
            bio_cids = [c for c in raw_layer['catIds'] if c in by_cid and (by_cid[c]['catShort'] in ('BIRD', 'ANML') or c == 'AMBInsc')]
            if bio_cids:
                enabled = False
                cids = list(palette['default_amb']['catIds'][:2])
                desc_out = 'hitech 纯无生命体调性：跳过生物鸣叫点缀，保持洁净空间留白'
                qs_out = []
        if not cids:
            cids = [c for c in palette['default_amb']['catIds'] if c in by_cid and by_cid[c]['catShort'] not in forb_set]
            if not cids:
                cids = ['AMBAir']
        avoid_out = list(dict.fromkeys([*raw_layer['avoid'], *palette['avoid'][:4]]))
        return {
            'role': role_key,
            'desc': desc_out,
            'catIds': cids,
            'queries': qs_out,
            'avoid': avoid_out,
            'enabled': enabled,
            'mixHint': dict(raw_layer['mixHint']),
        }

    layers = {
        'base_hum': _clean_layer('base_hum', spec['base_hum']),
        'primary_texture': _clean_layer('primary_texture', spec['primary_texture']),
        'spot_life': _clean_layer('spot_life', spec['spot_life']),
    }

    # 若海岸/街区场景同时出现黄昏/暮色语义且允许生物层，补充暮蝉点缀词
    if (
        best_key in ('coastal_town', 'suburban_railway')
        and layers['spot_life']['enabled']
        and re.search(r'黄昏|暮|夕阳|傍晚|sunset|dusk|evening', tl)
    ):
        if 'evening cicada coastal' not in [q.lower() for q in layers['spot_life']['queries']]:
            layers['spot_life']['queries'].append('evening cicada coastal')

    union_queries = []
    seen_q = set()
    for lk in ('base_hum', 'primary_texture', 'spot_life'):
        lay = layers[lk]
        if not lay['enabled']:
            continue
        for q_item in lay['queries']:
            if q_item.lower() not in seen_q:
                seen_q.add(q_item.lower())
                union_queries.append(q_item)

    return {
        'scene': text or palette['default_amb']['desc'],
        'world': w,
        'worldLabel': palette['label'],
        'sceneType': best_key,
        'sceneTitle': spec['title'],
        'matched': best_score > 0.0,
        'layers': layers,
        'queries': union_queries,
    }


def plan_film_sound_pool(spec_or_events, *, world: str = 'realistic') -> dict:
    """输入 film.json（路径、目录或解析后的 dict）或事件描述列表，生成结构化全片三干线候选音效池检索方案：
    amb_pool（按场景切分）、fx_pool（按物件机关与调性拆出 identity / detail / avoid）、foley_pool（按角色动作拆词），
    每项均附带 UCS CatID、sfx_judge archetype 与 power 动力源本体守卫。"""
    w = _resolve_world(world)
    palette = WORLD_PALETTES[w]

    film_id, title, route = 'custom-events', '事件列表规划', None
    fps = 24
    dur_s = 0.0
    raw_shots = []
    raw_events = []

    if isinstance(spec_or_events, (str, Path)):
        from . import filmspec as FSPEC
        loaded = FSPEC.load(str(spec_or_events))
        raw = loaded.get('raw') or {}
        film_id = loaded.get('id') or 'film'
        title = loaded.get('title') or film_id
        route = loaded.get('route')
        fps = int(loaded.get('fps') or 24)
        dur_s = float(loaded.get('seconds') or 0.0)
        raw_shots = list(raw.get('shots') or loaded.get('shots') or [])
        raw_events = list(loaded.get('events') or [])
        if not raw_events:
            raw_events = _cues_dict_to_events(raw, fps)
    elif isinstance(spec_or_events, dict):
        raw = spec_or_events.get('raw') if isinstance(spec_or_events.get('raw'), dict) else spec_or_events
        film_id = str(spec_or_events.get('id') or raw.get('id') or 'film')
        title = str(spec_or_events.get('title') or raw.get('title') or film_id)
        route = spec_or_events.get('route') or raw.get('route')
        out_cfg = raw.get('output') or {}
        fps = int(spec_or_events.get('fps') or out_cfg.get('fps') or raw.get('fps') or 24)
        if spec_or_events.get('seconds'):
            dur_s = float(spec_or_events['seconds'])
        elif out_cfg.get('frameCount'):
            dur_s = float(out_cfg['frameCount']) / float(fps)
        elif raw.get('dur'):
            dur_s = float(raw['dur'])
        raw_shots = list(raw.get('shots') or spec_or_events.get('shots') or [])
        raw_events = list(spec_or_events.get('events') or raw.get('events') or [])
        if not raw_events:
            raw_events = _cues_dict_to_events(raw, fps)
    elif isinstance(spec_or_events, (list, tuple)):
        for idx, item in enumerate(spec_or_events):
            if isinstance(item, dict):
                raw_events.append(dict(item))
            elif str(item or '').strip():
                raw_events.append({'id': f'ev_{idx + 1:02d}', 'frame': idx * fps, 'desc': str(item).strip()})
        dur_s = max(1.0, len(raw_events) * 1.0)
    else:
        raise TypeError(f'spec_or_events 需为 film.json 路径、dict 或事件列表，收到 {type(spec_or_events).__name__}')

    amb_pool, fx_pool, foley_pool = [], [], []
    suppressed_foley, skipped_events = [], []
    amb_events_by_shot = {}
    loose_amb_events = []

    # 1. 遍历事件并按三干线分流（过滤纯配乐 music 与母带淡出 mix 事件）
    for idx, ev in enumerate(raw_events):
        ev_id = str(ev.get('id') or ev.get('audio') or f'ev_{idx + 1:02d}')
        dom = str(ev.get('domain') or '').strip().lower()
        if dom in ('music', 'mix'):
            skipped_events.append({'id': ev_id, 'domain': dom, 'reason': f'非音效事件（domain={dom}）'})
            continue
        if dom == 'picture' and not ev.get('audio'):
            skipped_events.append({'id': ev_id, 'domain': dom, 'reason': '纯画面表演标记（无独立 audio 键）'})
            continue

        desc_parts = [
            str(ev.get('desc') or '').strip(),
            str(ev.get('visual') or '').strip(),
            str(ev.get('note') or '').strip(),
            str(ev.get('audio') or '').strip(),
        ]
        cue_text = ' · '.join(dict.fromkeys(p for p in desc_parts if p)) or ev_id
        shot_id = str(ev.get('shot') or ('FULL' if not raw_shots else (raw_shots[0].get('id') or 'S1')))
        frame = ev.get('frame')
        t_s = (float(frame) / float(fps)) if isinstance(frame, (int, float)) else (float(ev['t']) if 't' in ev else 0.0)
        end_f = ev.get('end')
        out_s = (float(end_f) / float(fps)) if isinstance(end_f, (int, float)) else None

        cls = classify_stem(ev, world=w)
        if cls['rawStem'] == 'amb':
            if raw_shots and any(str(s.get('id')) == shot_id for s in raw_shots):
                amb_events_by_shot.setdefault(shot_id, []).append((ev_id, cue_text, t_s, out_s))
            else:
                loose_amb_events.append((ev_id, shot_id, cue_text, t_s, out_s))
            continue

        if not cls['enabled']:
            suppressed_foley.append({
                'id': ev_id,
                'shot': shot_id,
                't_s': round(t_s, 3),
                'desc': cue_text,
                'action': cls['action'],
                'suggestion': cls['suggestion'],
            })
            continue

        target_stem = cls['stem']
        note_str = cls['suggestion'] if cls['action'] == 'downgrade_to_fx' else None
        entry = _build_pool_entry(
            item_id=ev_id,
            stem=target_stem,
            shot_id=shot_id,
            desc=cue_text,
            world=w,
            t_s=t_s,
            out_s=out_s,
            note=note_str,
        )
        if target_stem == 'foley':
            foley_pool.append(entry)
        else:
            fx_pool.append(entry)

    # 2. 按场景镜头切分构建 amb_pool
    if raw_shots:
        for s_idx, sh in enumerate(raw_shots):
            sid = str(sh.get('id') or f'S{s_idx + 1}')
            s_in = float(sh.get('in', 0)) / float(fps)
            s_out = float(sh.get('out', dur_s * fps)) / float(fps)
            dur_s = max(dur_s, s_out)
            persp = ((sh.get('sound') or {}).get('perspective') if isinstance(sh.get('sound'), dict) else None) or ''
            sh_name = str(sh.get('name') or '').strip()
            sh_note = str(sh.get('note') or '').strip()
            linked = amb_events_by_shot.get(sid, [])
            linked_desc = '；'.join(x[1] for x in linked)
            scene_desc_parts = [p for p in (sh_name, linked_desc, persp, sh_note) if p]
            scene_desc = ' · '.join(scene_desc_parts) if scene_desc_parts else palette['default_amb']['desc']
            tr_raw = str(sh.get('transition') or 'cut').lower()
            tr_mode = 'hard_cut' if tr_raw in ('cut', 'hard_cut', '') else 'montage'
            amb_entry = _build_pool_entry(
                item_id=f'amb:{sid}',
                stem='amb',
                shot_id=sid,
                desc=scene_desc,
                world=w,
                in_s=s_in,
                out_s=s_out,
                perspective=persp or None,
                transition=tr_mode,
            )
            if linked:
                amb_entry['eventIds'] = [x[0] for x in linked]
            amb_pool.append(amb_entry)

    for ev_id, shot_id, cue_text, t_s, out_s in loose_amb_events:
        amb_pool.append(_build_pool_entry(
            item_id=ev_id,
            stem='amb',
            shot_id=shot_id,
            desc=cue_text,
            world=w,
            in_s=t_s,
            out_s=out_s if out_s is not None else max(dur_s, t_s + 2.0),
            transition='hard_cut',
        ))

    if not amb_pool:
        d_amb = palette['default_amb']
        amb_pool.append({
            'id': 'amb:FULL',
            'stem': 'amb',
            'shot': 'FULL',
            'in_s': 0.0,
            'out_s': round(max(dur_s, 1.0), 3),
            'transition': 'hard_cut',
            'desc': d_amb['desc'],
            'catId': d_amb['catIds'][0],
            'catIds': list(d_amb['catIds']),
            'archetype': 'ambience',
            'power': 'passive',
            'identity': list(d_amb['identity']),
            'detail': list(d_amb['detail']),
            'avoid': list(palette['avoid']),
            'queries': [*d_amb['identity'], *d_amb['detail']][:5],
        })

    # 为每条环境池条目注入三层复合环境拆解（Base Hum + Primary Texture + Spot Life），防止只搜单条环境白噪漏掉画面生机元素
    for amb_it in amb_pool:
        decomp = decompose_scene_ambience(amb_it['desc'], world=w)
        amb_it['sceneType'] = decomp['sceneType']
        amb_it['sceneTitle'] = decomp['sceneTitle']
        amb_it['layers'] = decomp['layers']
        merged_q = list(amb_it['queries'][:3])
        seen_aq = {x.lower() for x in merged_q}
        for lk in ('base_hum', 'primary_texture', 'spot_life'):
            lay = decomp['layers'][lk]
            if not lay['enabled']:
                continue
            for q_lay in lay['queries'][:2]:
                if q_lay.lower() not in seen_aq:
                    seen_aq.add(q_lay.lower())
                    merged_q.append(q_lay)
        for q_old in amb_it['queries'][3:]:
            if q_old.lower() not in seen_aq:
                seen_aq.add(q_old.lower())
                merged_q.append(q_old)
        amb_it['queries'] = merged_q[:10]
        merged_cids = list(amb_it['catIds'])
        for lk in ('base_hum', 'primary_texture', 'spot_life'):
            if decomp['layers'][lk]['enabled']:
                for cid in decomp['layers'][lk]['catIds'][:1]:
                    if cid not in merged_cids:
                        merged_cids.append(cid)
        amb_it['catIds'] = merged_cids[:6]

    unique_queries = []
    seen_uq = set()
    for pool in (amb_pool, fx_pool, foley_pool):
        for it in pool:
            for q_str in it['queries']:
                if q_str.lower() not in seen_uq:
                    seen_uq.add(q_str.lower())
                    unique_queries.append(q_str)

    return {
        'filmId': film_id,
        'title': title,
        'route': route,
        'world': w,
        'worldLabel': palette['label'],
        'fps': fps,
        'durationSec': round(dur_s, 3),
        'stemsLufs': dict(palette['stems_lufs']),
        'foleyEnabled': bool(palette['foley_enabled']),
        'amb_pool': amb_pool,
        'fx_pool': fx_pool,
        'foley_pool': foley_pool,
        'suppressed_foley': suppressed_foley,
        'skipped_events': skipped_events,
        'summary': {
            'ambCount': len(amb_pool),
            'fxCount': len(fx_pool),
            'foleyCount': len(foley_pool),
            'suppressedFoleyCount': len(suppressed_foley),
            'uniqueQueries': unique_queries,
        },
    }


def format_sound_pool_plan(plan: dict) -> str:
    """将 plan_film_sound_pool 的返回字典格式化为终端可读的三干线检索方案报告。"""
    st_lufs = plan['stemsLufs']
    foley_lufs = f"{st_lufs['foley']} LUFS" if st_lufs['foley'] is not None else '关闭 (foley_enabled=False)'
    lines = [
        f"=== 全片三干线候选音效池规划：{plan['title']} ({plan['filmId']}) ===",
        f"调性世界观 : {plan['world']} · {plan['worldLabel']}",
        f"时长 / 帧率: {plan['durationSec']:.2f}s @ {plan['fps']} fps | 目标干线配比: AMB={st_lufs['amb']} LUFS, SFX={st_lufs['fx']} LUFS, Foley={foley_lufs}",
    ]

    def _fmt_pool(header: str, items: list, is_amb: bool = False):
        lines.append(f"\n{header}（共 {len(items)} 项）：")
        if not items:
            lines.append("  （无）")
            return
        for it in items:
            span = f"[{it.get('in_s', 0.0):.2f}s..{it.get('out_s', 0.0):.2f}s {it.get('transition', 'hard_cut')}]" if is_amb else f"@{it.get('t_s', 0.0):.2f}s (shot={it['shot']})"
            lines.append(f"  ● {it['id']} {span} | UCS: {', '.join(it['catIds'])} | judge={it['archetype']} · power={it['power']}")
            lines.append(f"    描述     : {it['desc']}")
            if is_amb and it.get('layers'):
                lays = it['layers']
                lines.append(f"    Base Hum : {', '.join(lays['base_hum']['queries'])} ({lays['base_hum']['desc']})")
                lines.append(f"    Texture  : {', '.join(lays['primary_texture']['queries'])} ({lays['primary_texture']['desc']})")
                if lays['spot_life']['enabled']:
                    lines.append(f"    Spot Life: {', '.join(lays['spot_life']['queries'])} ({lays['spot_life']['desc']})")
            lines.append(f"    Identity : {', '.join(it['identity'])}")
            lines.append(f"    Detail   : {', '.join(it['detail'])}")
            lines.append(f"    Avoid    : {', '.join(it['avoid'][:6])}")
            if it.get('note'):
                lines.append(f"    调性建议 : {it['note']}")

    _fmt_pool("[1] AMB 环境氛围干线池 (amb_pool)", plan['amb_pool'], is_amb=True)
    _fmt_pool("[2] SFX 硬效与设计音效干线池 (fx_pool)", plan['fx_pool'])
    _fmt_pool("[3] Foley 人物生物动作拟音干线池 (foley_pool)", plan['foley_pool'])

    if plan.get('suppressed_foley'):
        lines.append(f"\n[附] 已按 {plan['world']} 调性抑制的非必要生命体拟音（{len(plan['suppressed_foley'])} 项）：")
        for sf_it in plan['suppressed_foley']:
            lines.append(f"  ○ {sf_it['id']} @{sf_it['t_s']:.2f}s ({sf_it['action']}): {sf_it['desc']} —— {sf_it['suggestion']}")
    return '\n'.join(lines)


def expand_for_freesound(query: str, max_queries: int = 6, *, world: str = None) -> dict:
    """将任意中文意图、UCS CatID 或泛词扩展为可直接用于 Freesound CC0 检索的英文短语与本体守卫配置。
    传入 world 时自动按 WORLD_PALETTES 过滤禁入声族并重排偏好检索词。"""
    q = str(query or '').strip()
    if world is not None:
        sbw = search_by_world(q, world=world, top_n=max(8, int(max_queries)))
        return {
            'input': q,
            'world': sbw['world'],
            'worldLabel': sbw['worldLabel'],
            'isChinese': bool(CJK_RE.search(q)),
            'power': sbw['power'],
            'archetype': sbw['archetype'],
            'queries': sbw['queries'][:max(1, int(max_queries))],
            'identityQueries': sbw['identityQueries'],
            'detailQueries': sbw['detailQueries'],
            'avoid': sbw['avoid'],
            'excludedCats': sbw['excludedCats'],
            'recipes': sbw['recipes'],
            'ucs': sbw['ucs'][:8],
        }

    recipes = match_recipes(q, top_n=3)
    raw_ucs = search_ucs(q, top_n=8)
    by_cid = {e['catId']: e for e in load_ucs()['entries']}
    ucs_hits, seen_cids = [], set()
    for rec in recipes[:2]:
        if rec['score'] >= 45.0:
            for cid in rec['catIds']:
                if cid in by_cid and cid not in seen_cids:
                    e = by_cid[cid]
                    seen_cids.add(cid)
                    ucs_hits.append({
                        'score': round(rec['score'] + 10.0, 1),
                        'catId': e['catId'],
                        'catShort': e['catShort'],
                        'category': e['category'],
                        'subCategory': e['subCategory'],
                        'categoryZh': e['categoryZh'],
                        'subCategoryZh': e['subCategoryZh'],
                        'explanation': e['explanation'],
                        'matchedEn': [],
                        'matchedZh': [],
                        'synonymsEn': e['synonymsEn'],
                        'synonymsZh': e['synonymsZh'],
                    })
    for u in raw_ucs:
        if u['catId'] not in seen_cids:
            seen_cids.add(u['catId'])
            ucs_hits.append(u)
    ucs_hits = ucs_hits[:8]

    queries = []
    seen = set()

    def _add(phr):
        p = re.sub(r'\s+', ' ', str(phr or '')).strip()
        if p and p.lower() not in seen:
            seen.add(p.lower())
            queries.append(p)

    top_free_avoid = [a.lower() for a in recipes[0]['avoid']] if recipes else []
    q_clean = re.sub(r'\s+', ' ', q).strip()
    if q_clean and not CJK_RE.search(q_clean):
        rec_pool_low = {
            p.lower()
            for r in recipes[:1]
            for p in (*r['identityQueries'], *r['detailQueries'])
        }
        if q_clean.lower() in rec_pool_low:
            _add(q_clean)

    for r_idx, rec in enumerate(recipes[:2]):
        if r_idx > 0 and rec['score'] < recipes[0]['score'] * 0.55:
            continue
        for iq in rec['identityQueries'][:4 if r_idx == 0 else 3]:
            if r_idx == 0 or not any(av in iq.lower() for av in top_free_avoid):
                _add(iq)
        for dq in rec['detailQueries'][:3]:
            if r_idx == 0 or not any(av in dq.lower() for av in top_free_avoid):
                _add(dq)

    if not recipes or recipes[0]['score'] < 45.0:
        for u in ucs_hits[:3]:
            sub_words = u['subCategory'].lower().replace('&', ' ').strip()
            cat_words = u['category'].lower().replace('&', ' ').strip()
            if u['matchedEn']:
                for m in u['matchedEn'][:2]:
                    _add(f"{m.lower()} {sub_words}" if m.lower() not in sub_words else m.lower())
            else:
                for syn in u['synonymsEn'][:3]:
                    sl = syn.lower()
                    if cat_words in ('user interface', 'beeps', 'lasers'):
                        _add(f"hitech {sl} {sub_words}".strip())
                    elif cat_words in ('mechanical', 'clocks'):
                        _add(f"{sl} {sub_words}".strip())
                    else:
                        _add(f"{sl} {cat_words}".strip() if sl != cat_words else sl)

    if not CJK_RE.search(q) and q:
        _add(q)

    primary_rec = recipes[0] if recipes else None
    return {
        'input': q,
        'isChinese': bool(CJK_RE.search(q)),
        'power': primary_rec['power'] if primary_rec else 'passive',
        'archetype': primary_rec['archetype'] if primary_rec else (ucs_hits[0]['category'].lower() if ucs_hits else 'generic'),
        'queries': queries[:max(1, int(max_queries))],
        'recipes': recipes,
        'ucs': ucs_hits,
    }


def format_vocab_report(query: str, top_n: int = 8, *, world: str = None) -> str:
    """生成终端可读的中英词表与音效师配方反查报告（支持可选 world 调性过滤与重排）。"""
    exp = expand_for_freesound(query, max_queries=max(6, int(top_n)), world=world)
    lines = [f"=== 音效库检索词表反查：{query!r} ==="]
    if world is not None:
        pal = WORLD_PALETTES[exp['world']]
        lines.append(f"调性世界观：{exp['world']} · {pal['label']} （优先: {', '.join(pal['preferred_cats'][:7])} | 禁入: {', '.join(pal['forbidden_cats'])}）")
        if exp.get('excludedCats'):
            lines.append(f"已自动剔除违和声族：{', '.join(exp['excludedCats'])}")
    if exp['recipes']:
        lines.append("\n[1] 北冥音效师复合检索配方（按物理机制与叠层拆词）：")
        for r in exp['recipes'][:3]:
            lines.append(f"  ● {r['title']} [{r['layer']} · power={r['power']} · judge={r['archetype']}]  UCS: {', '.join(r['catIds'])}")
            lines.append(f"    认知锚点词 (Identity) : {', '.join(r['identityQueries'])}")
            lines.append(f"    高频精密层 (Detail)   : {', '.join(r['detailQueries'])}")
            lines.append(f"    严禁混入项 (Avoid)    : {', '.join(r['avoid'])}")
    if exp['ucs']:
        shown_ucs = exp['ucs'][:max(1, int(top_n))]
        lines.append(f"\n[2] UCS v8.2.1 行业标准分类词表命中（Top {len(shown_ucs)} / 753 CatID）：")
        for u in shown_ucs:
            en_preview = ', '.join(u['synonymsEn'][:14])
            zh_preview = '、'.join(u['synonymsZh'][:12])
            lines.append(f"  ● {u['catId']:10s} | {u['category']} > {u['subCategory']} （{u['categoryZh']} > {u['subCategoryZh']}）")
            lines.append(f"    定义: {u['explanation']}")
            lines.append(f"    英文检索词 ({len(u['synonymsEn']):2d}): {en_preview}{' ...' if len(u['synonymsEn']) > 14 else ''}")
            lines.append(f"    中文同义词 ({len(u['synonymsZh']):2d}): {zh_preview}{' ...' if len(u['synonymsZh']) > 12 else ''}")
    if exp['queries']:
        w_flag = f' --world {exp["world"]}' if world is not None else ''
        lines.append("\n[3] 推荐直接送入 fetch_sfx.py 的英文检索短语：")
        for q_en in exp['queries'][:6]:
            lines.append(f'    node tools/env/py.mjs tools/fetch_sfx.py --search "{q_en}"{w_flag} --probe-audio')
    if not exp['recipes'] and not exp['ucs']:
        lines.append("  （未命中；可尝试更具体的动作/材质词，如「齿轮」「棘轮」「菜单」「圆珠笔」「衣袂」「拔剑」，或加 --list-categories 查看全部 82 大类）")
    return '\n'.join(lines)


def main():
    import argparse
    import sys
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser(description='UCS v8.2.1 音效库中英检索词表、世界观调性路由与全片三干线声族池规划工具')
    ap.add_argument('query', nargs='?', help='中文或英文动作/材质/物件词，或 UCS CatID（如 MECHGear）')
    ap.add_argument('--world', choices=tuple(WORLD_PALETTES), default=None,
                    help='按影片世界观调性过滤禁入大类并重排偏好检索词')
    ap.add_argument('--plan', metavar='FILM_JSON', help='读取 film.json（或作品目录）输出全片 AMB / SFX / Foley 三干线检索方案')
    ap.add_argument('--list-categories', action='store_true', help='列出全部 82 个 UCS 顶层大类')
    ap.add_argument('--cat', help='按 CatID 或大类前缀查看完整词条（如 MECH、UI、CLOCK、MECHGear）')
    ap.add_argument('-n', type=int, default=8, help='最多显示的 UCS 子类条数')
    ap.add_argument('--json', action='store_true', help='输出 JSON 格式')
    args = ap.parse_args()

    if args.plan:
        plan = plan_film_sound_pool(args.plan, world=args.world or 'realistic')
        if args.json:
            print(json.dumps(plan, ensure_ascii=False, indent=2))
        else:
            print(format_sound_pool_plan(plan))
        return

    if args.list_categories:
        cats = list_categories()
        if args.json:
            print(json.dumps(cats, ensure_ascii=False, indent=2))
        else:
            u = load_ucs()['stats']
            print(f"UCS v8.2.1 音效库分类总表：{u['categories']} 大类 · {u['subCategories']} 子类 · {u['uniqueSynonymsEn']} 英文词 · {u['uniqueSynonymsZh']} 中文词\n")
            for idx, c in enumerate(cats, 1):
                print(f"{idx:2d}. {c['category']:18s} [{c['catShort']:5s}] {c['categoryZh']:10s} ({c['subCount']:2d} 子类) 例: {', '.join(c['sampleCatIds'])}")
        return

    if args.cat:
        rows = get_cat(args.cat)
        if args.json:
            print(json.dumps(rows, ensure_ascii=False, indent=2))
        else:
            for e in rows:
                print(f"[{e['catId']}] {e['category']} > {e['subCategory']} （{e['categoryZh']} > {e['subCategoryZh']}）")
                print(f"  说明: {e['explanation']}")
                print(f"  EN ({len(e['synonymsEn'])}): {', '.join(e['synonymsEn'])}")
                print(f"  ZH ({len(e['synonymsZh'])}): {'、'.join(e['synonymsZh'])}\n")
        return

    if not args.query:
        ap.print_help()
        return

    if args.json:
        out = search_by_world(args.query, world=args.world, top_n=args.n) if args.world else expand_for_freesound(args.query, max_queries=args.n)
        print(json.dumps(out, ensure_ascii=False, indent=2))
    else:
        print(format_vocab_report(args.query, top_n=args.n, world=args.world))


if __name__ == '__main__':
    main()
