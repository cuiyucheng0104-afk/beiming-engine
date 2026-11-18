# 音效库检索词表速查（UCS v8.2.1 + 复合检索配方）

> **怎么用**：
> 1. 按画面动作查 **§2 二十四类高频场景复合搜索词表**（直接拿到「认知锚点词 + 跨界精密叠层词 + 污染排除词」）；
> 2. 查商业音效库（Soundminer / BaseHead / Soundly）或跨品类找词时，看 **§3 UCS v8.2.1 八十二大类总表**，或跑命令行一键反查全部 753 个子类：
>    `node tools/env/py.mjs tools/fetch_sfx.py --vocab "<中文或英文词>"`
> 3. 音效设计的九步工作流与分层法则见 [sound.md](sound.md)。

---

## 1. 词表结构与音效师拆词公式

全量机器可读词表位于 `engine/audio/ucs_vocab.json`【仓库实证·代码】，由 `engine/audio/sfx_vocab.py` 与 `tools/fetch_sfx.py` 调用：
- **行业标准分类层（UCS v8.2.1）**：覆盖 **82 个顶层大类**、**753 个标准子类（`CatID`）**、**9973 个不重复英文检索词**、**3020 个不重复中文同义词**。
- **音效师复合短语层（`DESIGNER_RECIPES`）**：UCS 原表提供的是单个分类名词（如 `Gear`、`Beep`、`Laser`）；在 Freesound 等开放库直接搜单个大词极易召回 8-bit 复古合成器或重工业电机噪音。实战检索遵循三段式组合公式：

```text
有效搜索短语 = [具体物理机制/借代物名词] + [尺度/录音修饰词] + [领域放行词（仅界面层）]
```

| 修饰词组 | 常用英文检索词（Tokens） | 适用场景与引擎联动机制 |
|---|---|---|
| **微型精密机械提纯词** | `micro`, `miniature`, `pocket watch`, `camera`, `caliper`, `detent`, `crisp`, `close-mic` | 搜细小齿轮、卡扣、转轴时追加，跨界借用怀表擒纵、相机快门拨盘与千分尺棘轮 |
| **高科技界面（HUD/UI）放行与提纯词** | `hitech`, `hud`, `telemetry`, `micro beep`, `readout`, `scanner`, `clean`, `pulse` | 显式触发 fetch_sfx.is_hitech_query 电子标签放行，避免误落入复古 8-bit 街机音效 |
| **近场干净拟音录音提纯词** | `foley`, `close-mic`, `isolated`, `dry`, `single`, `clean`, `field-recording` | 优先召回消声/近讲单次干声，避开大混响与嘈杂环境录音 |
| **无源机械防电机污染排除词** | `-motor`, `-servo`, `-drill`, `-engine`, `-fan`, `-synth`, `-loop` | 圆珠笔、发条钟表、木石机关、积木等无电机物件必加，防止窄带伺服嗡鸣混入 |
| **自然材质防电子/音乐污染排除词** | `-synth`, `-8bit`, `-chiptune`, `-loop`, `-music`, `-vocal` | 搜风、水、木、石、布料、刀剑等自然实录时排除合成器与配乐循环 |

---

## 2. 二十四类高频场景复合搜索词表（北冥配方库）

每一行区分 **认知锚点词（Identity，搜本尊）** 与 **高频精密/质感叠层词（Detail，跨界借声）**，并绑定 `sfx_judge` 声学原型与动力源守卫：

| 场景 | 层级 / 动力源 | UCS `CatID` | 认知锚点检索词（Identity） | 跨界精密/质感叠层词（Detail） | 严禁混入（Avoid） |
|---|---|---|---|---|---|
| **圆珠笔按压 / 精密按钮开关** | 物理本体 · `passive` (`mechanical`) | `OBJWrite`, `MECHClik`, `MECHSwtc` | `ballpoint pen click`<br>`retractable pen button`<br>`clicker pen press`<br>`plastic button click` | `micro switch click`<br>`camera shutter button`<br>`precision ratchet click`<br>`small metal latch` | `servo`, `electric motor`, `bed spring`, `8bit` |
| **精密齿轮咬合 / 步进棘轮 / 擒纵机构** | 物理本体 · `passive` (`mechanical`) | `MECHGear`, `CLOCKMech`, `CLOCKTick`, `TOOLHand` | `pocket watch escapement`<br>`clockwork gear wind`<br>`ratchet wrench fine`<br>`safe combination dial` | `camera shutter dial`<br>`micrometer ratchet click`<br>`watch crown wind`<br>`rotary detent switch` | `industrial factory motor`, `power drill`, `car transmission`, `loop` |
| **卡扣锁合 / 积木拼插 / 硬塑脆响** | 物理本体 · `passive` (`impact`) | `MECHLtch`, `MECHLock`, `PLASImpt`, `TOYMech` | `lego brick click`<br>`plastic snap latch`<br>`toy block clack`<br>`buckle clasp snap` | `camera lens lock click`<br>`cassette case snap`<br>`hard plastic tap dry` | `hollow drum`, `cartoon boing`, `synth` |
| **螺纹旋松旋紧 / 金属管套滑擦** | 物理本体 · `passive` (`scrape`) | `METLFric`, `PLASFric`, `OBJCont`, `TOOLHand` | `metal cap unscrew`<br>`flashlight battery cap thread`<br>`thermos lid twist`<br>`jar lid unscrew` | `fine metal slide scrape`<br>`caliper metal slide`<br>`pen barrel unscrew` | `electric screwdriver`, `cordless drill`, `impact driver` |
| **微型弹簧压缩与受抑回弹** | 物理本体 · `passive` (`mechanical`) | `METLMvmt`, `MECHMisc`, `CLOCKMech` | `small metal spring release`<br>`watch mainspring wind`<br>`ballpoint spring clink` | `thin wire pluck`<br>`stapler spring slide`<br>`metal clip snap` | `cartoon boing`, `mattress bed spring`, `trampoline` |
| **制图划线 / 钢笔铅笔纸面刮擦 / 卡尺测量** | 物理本体 · `passive` (`paper`) | `OBJWrite`, `PAPRFric`, `TOOLHand` | `fountain pen paper write`<br>`pencil sketch stroke dry`<br>`drafting compass draw`<br>`chalk stroke blackboard` | `caliper slide click`<br>`watch tick single crisp`<br>`wooden ruler set down` | `keyboard typing`, `printer motor` |
| **高科技菜单弹出 / 微提示音（HUD Beep）** | 编码界面 · `digital` (`ui`) | `UIBeep`, `UIClick`, `UIAlert`, `EQUIPTech` | `hitech micro beep`<br>`hud telemetry blip`<br>`clean sci-fi ui button`<br>`futuristic interface confirm` | `digital micro click clean`<br>`medical monitor soft beep`<br>`camera focus confirm beep` | `8bit arcade`, `retro game coin`, `loud alarm siren` |
| **高科技细线绘制 / 镭射脉冲扫描（Laser Trace）** | 编码界面 · `digital` (`ui`) | `LASRBeam`, `UIData`, `SCICmpt`, `UIMvmt` | `hitech laser scan`<br>`hud telemetry pulse`<br>`barcode laser scanner clean`<br>`digital scanner sweep` | `ui data tick fast`<br>`high frequency micro pulse`<br>`holoscreen line draw` | `star wars blaster pew`, `laser gun explosion`, `harsh feedback` |
| **数据跳字 / 遥测读数流 / 终端打印** | 编码界面 · `digital` (`ui`) | `UIData`, `SCICmpt`, `CMPTMisc` | `hud telemetry data readout`<br>`hitech text scroll ticks`<br>`digital counter readout`<br>`sci-fi computer data` | `geiger counter single click`<br>`micro relay tick` | `dialup modem screech`, `loud glitch noise` |
| **界面报错 / 信号闪烁故障（Glitch / Alert）** | 编码界面 · `digital` (`ui`) | `UIGlitch`, `UIAlert`, `ELECSprk` | `ui interaction error beep`<br>`hitech subtle glitch`<br>`hud warning double beep`<br>`digital cancel tone` | `short static zap micro`<br>`clean low blip` | `harsh white noise blast`, `air raid siren` |
| **刀剑出鞘 / 兵刃交击 / 金属清鸣** | 物理本体 · `passive` (`metal`) | `WEAPSwrd`, `WEAPKnif`, `METLImpt`, `METLTonl` | `sword unsheath metal`<br>`katana draw scabbard`<br>`sword blade clang`<br>`knife blade slide ring` | `tuning fork high ring`<br>`leather scabbard slide`<br>`bamboo stick whoosh` | `kitchen fork plate`, `hollow tin can` |
| **衣袂翻飞 / 披风抖动 / 布料摩擦** | 物理本体 · `passive` (`cloth`) | `CLOTHFlp`, `CLOTHMvmt`, `FOLYClth` | `heavy cloth flap foley`<br>`coat movement rustle close`<br>`canvas flag snap`<br>`silk fabric swish` | `leather belt creak subtle`<br>`soft air swish` | `plastic raincoat crinkle`, `mic handling wind rumble` |
| **挥动破空 / 镜头甩镜转场（Whoosh / Swish）** | 意象转译 · `passive` (`whoosh`) | `SWSH`, `WHSH`, `DSGNWhsh`, `FIREWhsh` | `bamboo stick whoosh`<br>`wooden dowel fast swish`<br>`organic air whoosh`<br>`heavy rope swing whoosh` | `cloth whip snap`<br>`soft breath air rush` | `edm synth white noise riser`, `jet plane flyby` |
| **木质敲击 / 榫卯扣合 / 竹木梆声** | 物理本体 · `passive` (`impact`) | `WOODImpt`, `WOODFric`, `WOODHndl`, `DOORWood` | `hardwood block hit dry`<br>`bamboo clack foley`<br>`wooden mallet tap`<br>`heavy wood chest close` | `wood creak subtle`<br>`wooden drawer slide` | `snare drum`, `reverb hall` |
| **石材落定 / 金石篆刻印章 / 陶瓷碰撞** | 物理本体 · `passive` (`impact`) | `ROCKImpt`, `ROCKFric`, `CERMImpt`, `GLASImpt` | `stone block thud dry`<br>`marble slab slide`<br>`ceramic cup clink`<br>`heavy rock impact` | `gravel grit crunch`<br>`thick paper stamp press` | `explosion debris`, `avalanche` |
| **画卷展开 / 宣纸翻页 / 卡纸滑擦** | 物理本体 · `passive` (`paper`) | `PAPRFric`, `PAPRFltr`, `PAPRHndl`, `OBJBook` | `paper scroll unroll`<br>`thick book page turn`<br>`cardstock paper slide`<br>`parchment paper handle` | `wooden scroll rod tap`<br>`soft brush paper sweep` | `paper shredder machine`, `crumpling trash ball` |
| **脚步拟音（石板 / 木地板 / 碎石 / 雪地）** | 物理本体 · `passive` (`footstep`) | `FEETHmn`, `FOLYFeet`, `SNOWCrsh`, `DIRTCrsh` | `footsteps stone single dry`<br>`footsteps wood floor foley`<br>`footsteps gravel walk`<br>`snow footsteps crunch` | `cloth movement step`<br>`leather boot creak` | `crowd marching`, `echoing stairwell` |
| **水花破浪 / 水墨晕染 / 深水潜流** | 物理本体 · `passive` (`water`) | `WATRSplsh`, `WATRPlng`, `WATRDrip`, `WATRFlow`, `WATRUwtr` | `water plunge splash`<br>`calm lake water lap`<br>`single water drop resonant`<br>`underwater cave rumble` | `water bubbles rise`<br>`wet brush stroke` | `toilet flush`, `kitchen sink faucet` |
| **旷野山风 / 晨雾空气底噪（Ambience Bed）** | 物理本体 · `passive` (`ambience`) | `WIND`, `WINDGust`, `AMBAir`, `AMBAlpn`, `AMBRoom` | `cold mountain wind`<br>`gentle breeze open field`<br>`quiet room tone air`<br>`wind through trees` | `dry leaves rustle wind`<br>`distant reed flute air` | `microphone wind buffeting distortion`, `traffic highway hum` |
| **火焰燃烧 / 火把呼啸 / 炭火噼啪** | 物理本体 · `passive` (`scrape`) | `FIREBurn`, `FIRECrkl`, `FIREBrst`, `FIREWhsh` | `campfire wood crackle close`<br>`fire torch whoosh`<br>`fireplace steady burn` | `match strike flare`<br>`charcoal ember pop` | `rain mistaken for fire`, `vinyl dust crackle` |
| **飞鸟振翅 / 群鸽起飞 / 巨翼拍击** | 物理本体 · `passive` (`whoosh`) | `WINGBird`, `WINGCrea`, `BIRDFowl`, `BIRDSong` | `pigeon wing flap close`<br>`bird wings takeoff`<br>`large leather wing flap` | `heavy cloth snap`<br>`feather rustle` | `city traffic background`, `cage rattle` |
| **古钟长鸣 / 铜锣重音 / 颂钵泛音** | 意象转译 · `passive` (`tonal`) | `BELLGong`, `BELLLrg`, `BELLHand`, `HORNFog` | `temple bronze bell strike`<br>`deep tam-tam gong`<br>`tibetan singing bowl resonant`<br>`distant harbor foghorn` | `wooden bell striker hit`<br>`metal shimmer tail` | `doorbell buzzer`, `bicycle bell` |
| **机器人关节伺服 / 步进电机（有源动力专用）** | 物理本体 · `motorized` (`motorized`) | `MOTRSrvo`, `MOTRElec`, `ROBTMvmt`, `COMCam` | `robotic servo movement`<br>`camera lens autofocus motor`<br>`small stepper motor whine`<br>`precision linear actuator` | `metallic gear stop click`<br>`hydraulic hiss short` | `lawnmower engine`, `vacuum cleaner` |
| **气动泄压阀门 / 液压舱门（有源气液专用）** | 物理本体 · `motorized` (`whoosh`) | `MECHHydr`, `AIRBrst`, `AIRHiss`, `SCIDoor` | `pneumatic air release hiss`<br>`compressed air burst valve`<br>`hydraulic cylinder press`<br>`heavy airlock seal` | `heavy metal latch clunk`<br>`pressure gauge tick` | `white noise static` |

---

## 3. UCS v8.2.1 全部 82 大类中英对照与高频检索词总表

需要展开某一大类的全部子类与完整同义词时，执行 `node tools/env/py.mjs tools/fetch_sfx.py --cat <简称或CatID>`（如 `--cat MECH`、`--cat UI`、`--cat CLOCK`）。

| # | 英文大类 (`Category`) | 简称 | 中文大类 | 子类数 | 代表 `CatID`（中文子类） | 代表英文检索同义词（节选） |
|---:|---|---|---|---:|---|---|
| 1 | **AIR** | `AIR` | 气体 | 5 | `AIRBlow`(吹)、`AIRBrst`(爆发)、`AIRHiss`(嘶嘶声)、`AIRMisc`(其它) … | `Aerate`, `Aerosol`, `Air`, `Airhose`, `Balloon`, `Beat`, `Bellows`, `Blast` |
| 2 | **AIRCRAFT** | `AERO` | 航空器 | 10 | `AERODoor`(门)、`AEROHeli`(直升机)、`AEROInt`(航空舱)、`AEROJet`(喷气式飞机) … | `Airplane`, `Aviation`, `Boarding`, `Cabin`, `Cargo`, `Cockpit`, `Emergency`, `Entrance` |
| 3 | **ALARMS** | `ALRM` | 警报 | 6 | `ALRMBell`(警铃)、`ALRMBuzr`(蜂鸣器)、`ALRMClok`(钟表)、`ALRMElec`(电器) … | `Alarms`, `Alert`, `Bank`, `Burglar`, `Caution`, `Clanger`, `Clock`, `Crossing` |
| 4 | **AMBIENCE** | `AMB` | 环境 | 47 | `AMBAir`(空气)、`AMBAlpn`(高山)、`AMBAmus`(娱乐)、`AMBBird`(鸟鸣) … | `Atmos`, `Atmosphere`, `Ambience`, `Ambiance`, `BG`, `Background`, `Calm`, `Cave` |
| 5 | **ANIMALS** | `ANML` | 动物 | 15 | `ANMLAmph`(两栖动物)、`ANMLAqua`(水生动物)、`ANMLBat`(蝙蝠)、`ANMLCat`(家猫) … | `American`, `Amniotes`, `Amphibia`, `Axolotl`, `Axolotls`, `Bullfrog`, `Caecilian`, `Cane` |
| 6 | **ARCHIVED** | `ADR` | 归档 | 15 | `ADR`(ADR)、`ASSET`(资源)、`BNCE`(导出)、`IR`(卷积混响素材) … | `Additional`, `Automated`, `Dialog`, `Dubbing`, `Loop`, `Recording`, `Replacement`, `Voiceover` |
| 7 | **BEEPS** | `BEEP` | 提示音 | 6 | `BEEPAppl`(电器)、`BEEP`(通用)、`BEEPLofi`(低保真)、`BEEPMed`(医疗器械) … | `Air`, `Blender`, `Bread`, `Cleaner`, `Coffee`, `Conditioner`, `Cooker`, `Cooktop` |
| 8 | **BELLS** | `BELL` | 钟铃 | 6 | `BELLAnml`(动物)、`BELLDoor`(门铃)、`BELLGong`(锣)、`BELLHand`(手铃) … | `Bell`, `Collar`, `Cowbell`, `Hawkbell`, `Sheep`, `Sleigh`, `Chime`, `Ding` |
| 9 | **BIRDS** | `BIRD` | 鸟类 | 8 | `BIRDPrey`(猛禽)、`BIRDCrow`(乌鸦)、`BIRDFowl`(家禽)、`BIRDMisc`(其它) … | `Avivore`, `Bald`, `Birdlover`, `Birdseye`, `Birdtrap`, `Buzzard`, `Caracara`, `Condor` |
| 10 | **BOATS** | `BOAT` | 船舶 | 18 | `BOATAir`(汽艇)、`BOATWash`(船浪)、`BOATDoor`(门)、`BOATElec`(电动船) … | `Air`, `Amphibious`, `Boat`, `Fan`, `Hovercraft`, `Swamp`, `Bow`, `Propeller` |
| 11 | **BULLETS** | `BLLT` | 子弹 | 5 | `BLLTBy`(飞过)、`BLLTImpt`(击中)、`BLLTMisc`(其它)、`BLLTRico`(弹跳) … | `Bullet`, `Fwip`, `Graze`, `Subsonic`, `Supersonic`, `Whiz-By`, `Whizby`, `Armor` |
| 12 | **CARTOON** | `TOON` | 卡通 | 22 | `TOONAnml`(动物)、`TOONBoing`(弹簧音)、`TOONClang`(咣当)、`TOONCreak`(嘎吱) … | `Animal`, `Animated`, `Call`, `Cartoony`, `Comic`, `Duck`, `Fake`, `Hanna` |
| 13 | **CERAMICS** | `CERM` | 陶瓷 | 8 | `CERMBrk`(打破)、`CERMCrsh`(碎片)、`CERMFric`(挤压)、`CERMHndl`(抓取) … | `Apart`, `Break`, `Burst`, `Ceramic`, `Ceramics`, `China`, `Chip`, `Clay` |
| 14 | **CHAINS** | `CHAIN` | 链条 | 5 | `CHAINBrk`(打破)、`CHAINHndl`(抓取)、`CHAINImpt`(打中)、`CHAINMisc`(其它) … | `Bend`, `Break`, `Burst`, `Crack`, `Fracture`, `Links`, `Rupture`, `Sever` |
| 15 | **CHEMICALS** | `CHEM` | 化学 | 3 | `CHEMAcid`(腐蚀)、`CHEMMisc`(其它)、`CHEMReac`(反应) | `Acetic`, `Acidic`, `Acrid`, `Biting`, `Caustic`, `Citric`, `Corrosive`, `Erosive` |
| 16 | **CLOCKS** | `CLOCK` | 钟表 | 4 | `CLOCKChim`(报时钟声)、`CLOCKMech`(机械)、`CLOCKMisc`(其它)、`CLOCKTick`(嘀嗒) | `Bell`, `Chime`, `Clock`, `Dong`, `Grandfather`, `Peal`, `Ring`, `Sound` |
| 17 | **CLOTH** | `CLOTH` | 布料 | 6 | `CLOTHFlp`(抖动)、`CLOTHHndl`(抓取)、`CLOTHImpt`(打击)、`CLOTHMisc`(其它) … | `Apparel`, `Apron`, `Banner`, `Bib`, `Blanket`, `Burlap`, `Canvas`, `Cape` |
| 18 | **COMMUNICATIONS** | `COM` | 通讯 | 13 | `COMAv`(影视设备)、`COMCam`(照相机)、`COMCell`(手机)、`COMMic`(麦克风) … | `16mm`, `8mm`, `Amplification`, `Amplifier`, `Audio`, `Audiovisual`, `Aural`, `AV` |
| 19 | **COMPUTERS** | `CMPT` | 电脑 | 3 | `CMPTDriv`(硬盘)、`CMPTKey`(键鼠)、`CMPTMisc`(其它) | `Boot`, `Data`, `Disc`, `Disk`, `Firewire`, `Floppy`, `Gigabytes`, `Grind` |
| 20 | **CREATURES** | `CREA` | 生物 | 15 | `CREAAqua`(水生)、`CREAAvian`(奇幻禽类)、`CREABeast`(野兽)、`CREABlob`(黏体生物) … | `Aquatic`, `Creature`, `Cthulhu`, `Giant`, `Hydra`, `Kelpie`, `Kraken`, `Leviathan` |
| 21 | **CROWDS** | `CRWD` | 人群 | 16 | `CRWDAngr`(愤怒)、`CRWDApls`(喝彩)、`CRWDBatl`(打斗)、`CRWDCele`(庆祝) … | `Agitated`, `Audience`, `Congregation`, `Demonstrators`, `Enraged`, `Furious`, `Gathering`, `Hooligan` |
| 22 | **DESIGNED** | `DSGN` | 声音设计 | 20 | `DSGNBass`(低频下潜)、`DSGNBoom`(低频轰鸣)、`DSGNBram`(低频号角)、`DSGNDist`(失真) … | `Bass`, `Descending`, `Dive`, `Downer`, `Drop`, `Fall`, `Low-Frequency`, `Pitch` |
| 23 | **DESTRUCTION** | `DESTR` | 拆除 | 3 | `DESTRClpse`(倒塌)、`DESTRCrsh`(碎片)、`DESTRMisc`(其它) | `Break`, `Cave`, `Collapse`, `Crumble`, `Crumple`, `Demolish`, `Demolition`, `Disintegrate` |
| 24 | **DIRT & SAND** | `DIRT` | 沙土 | 7 | `DIRTCrsh`(碎屑)、`DIRTDust`(灰尘)、`DIRTHndl`(抓取)、`DIRTImpt`(碰撞) … | `Airborne`, `Ashes`, `Cinder`, `Cinders`, `Clay`, `Cloud`, `Crumble`, `Crumbs` |
| 25 | **DOORS** | `DOOR` | 门 | 22 | `DOORAntq`(古董)、`DOORAppl`(家电)、`DOORCab`(箱柜)、`DOORComp`(特殊材料) … | `Abbey`, `Aged`, `Ancient`, `Antiquated`, `Antique`, `Barn`, `Cabin`, `Castle` |
| 26 | **DRAWERS** | `DRWR` | 抽屉 | 4 | `DRWRMetl`(金属)、`DRWRMisc`(其它)、`DRWRPlas`(塑料)、`DRWRWood`(木制) | `Cabinet`, `Cash`, `Chest`, `Filing`, `Rack`, `Register`, `Security`, `Toolbox` |
| 27 | **ELECTRICITY** | `ELEC` | 电流 | 6 | `ELECArc`(电弧)、`ELECBuzz`(电流噪声)、`ELECEmf`(电磁)、`ELECMisc`(其它) … | `Arc`, `Arch`, `Ark`, `Carbon`, `Coil`, `Discharge`, `Electrocute`, `Flash` |
| 28 | **EQUIPMENT** | `EQUIP` | 器具 | 6 | `EQUIPBridle`(挽具)、`EQUIPTech`(高科技)、`EQUIPMisc`(其它)、`EQUIPRec`(户外装备) … | `Bit`, `Bits`, `Bridle`, `Bridles`, `Chains`, `Curb`, `Dog`, `Guards` |
| 29 | **EXPLOSIONS** | `EXPL` | 爆炸 | 3 | `EXPLDsgn`(声音设计)、`EXPLMisc`(其它)、`EXPLReal`(真实) | `Atomic`, `Bangs`, `Blast`, `Blasted`, `Blasting`, `Blasts`, `Blazes`, `Blowup` |
| 30 | **FARTS** | `FART` | 放屁 | 3 | `FARTDsgn`(声音设计)、`FARTMisc`(其它)、`FARTReal`(真实) | `Armpit`, `Balloon`, `Cushion`, `Fart`, `Fartbag`, `Flarp`, `Flatulence`, `Poot` |
| 31 | **FIGHT** | `FGHT` | 打斗 | 5 | `FGHTBf`(跌倒)、`FGHTClth`(衣服)、`FGHTGrab`(抓握)、`FGHTImpt`(击打) … | `Body`, `Bodyfall`, `Collapse`, `Dive`, `Drag`, `Drop`, `Fall`, `Falling` |
| 32 | **FIRE** | `FIRE` | 火 | 10 | `FIREBurn`(燃烧)、`FIREBrst`(爆燃)、`FIRECrkl`(爆裂)、`FIREGas`(气体) … | `Afire`, `Aflare`, `Alight`, `Arson`, `Blaze`, `Blazing`, `Bonfire`, `Brush` |
| 33 | **FIREWORKS** | `FRWK` | 烟花 | 3 | `FRWKComr`(商业表演)、`FRWKMisc`(其它)、`FRWKRec`(自娱) | `Aerial`, `Boom`, `Display`, `Firework`, `Independence`, `Kaboom`, `Mortar`, `Pyrotechnic` |
| 34 | **FOLEY** | `FOLY` | 拟音 | 5 | `FOLYClth`(布料/衣服)、`FOLYFeet`(脚步)、`FOLYHand`(手)、`FOLYMisc`(其它) … | `Cape`, `Clothing`, `Dress`, `Fabric`, `Flap`, `Flutter`, `Jacket`, `Movement` |
| 35 | **FOOD & DRINK** | `FOOD` | 食物 | 9 | `FOODCook`(烹饪)、`FOODDrnk`(喝)、`FOODEat`(吃东西)、`FOODGware`(玻璃器皿) … | `Baked`, `Baking`, `Barbecuing`, `Blending`, `Boil`, `Boiled`, `Boiling`, `Broiling` |
| 36 | **FOOTSTEPS** | `FEET` | 脚步 | 5 | `FEETAnml`(动物)、`FEETCrea`(怪物)、`FEETHors`(马)、`FEETHmn`(人类) … | `Bolt`, `Buck`, `Clack`, `Claws`, `Clomp`, `Footfall`, `Footprints`, `Hoof` |
| 37 | **GAMES** | `GAME` | 游戏 | 5 | `GAMEArcd`(街机游戏)、`GAMEBoard`(桌游)、`GAMECas`(赌场)、`GAMEMisc`(其它) … | `Air`, `Claw`, `Coin-Op`, `Crane`, `Dance`, `Foosball`, `Gallery`, `Game` |
| 38 | **GEOTHERMAL** | `GEO` | 地热 | 5 | `GEOFuma`(热浆)、`GEOGeyser`(间歇泉)、`GEOLava`(岩浆)、`GEOMisc`(其它) … | `Fissure`, `Fumarole`, `Fumarolic`, `Gaseous`, `Geothermal`, `Hydrothermal`, `Solfatara`, `Steam` |
| 39 | **GLASS** | `GLAS` | 玻璃 | 8 | `GLASBrk`(打破)、`GLASCrsh`(碎片)、`GLASFric`(挤压)、`GLASHndl`(抓取) … | `Break`, `Bulletproof`, `Burst`, `Chip`, `Crack`, `Crush`, `Demolish`, `Destroy` |
| 40 | **GORE** | `GORE` | 血 | 10 | `GOREBlood`(血流)、`GOREBone`(骨头)、`GOREBurn`(燃烧)、`GOREFlsh`(血肉) … | `Artery`, `Bleed`, `Bleeding`, `Blood`, `Bloodborne`, `Bloodshed`, `Bloody`, `Cells` |
| 41 | **GUNS** | `GUN` | 枪械 | 12 | `GUNAntq`(古董枪)、`GUNArtl`(火炮)、`GUNAuto`(自动化武器)、`GUNCano`(加农炮) … | `Arquebus`, `Arquebuses`, `Black`, `Blunderbuss`, `Breechloader`, `Breechloaders`, `Breechloading`, `Caplock` |
| 42 | **HORNS** | `HORN` | 号角 | 4 | `HORNAir`(气压式)、`HORNCele`(欢庆用)、`HORNMisc`(其它)、`HORNTrad`(传统) | `Air`, `Factory`, `Fog`, `Bugle`, `Ceremonial`, `Fanfare`, `Festive`, `Heraldic` |
| 43 | **HUMAN** | `HMN` | 人 | 14 | `HMNBlow`(吹)、`HMNBrth`(呼吸)、`HMNBurp`(打嗝)、`HMNCough`(咳嗽) … | `Adult`, `Blow`, `Child`, `Female`, `Male`, `Man`, `Person`, `Woman` |
| 44 | **ICE** | `ICE` | 冰 | 8 | `ICEBrk`(打碎)、`ICECrsh`(碎片)、`ICEFric`(挤压)、`ICEHndl`(抓取) … | `Apart`, `Break`, `Burst`, `Chip`, `Crack`, `Crumble`, `Crunch`, `Crush` |
| 45 | **LASERS** | `LASR` | 激光 | 4 | `LASRBeam`(光束)、`LASRGun`(武器)、`LASRImpt`(打击)、`LASRMisc`(其它) | `Beam`, `Blast`, `Bolt`, `Emission`, `Energy`, `Flash`, `Gamma`, `Glare` |
| 46 | **LEATHER** | `LETHR` | 皮革 | 5 | `LETHRCreak`(嘎吱)、`LETHRHndl`(抓取)、`LETHRImpt`(打击)、`LETHRMisc`(其它) … | `Cowhide`, `Creak`, `Deerskin`, `Groan`, `Hide`, `Nubuck`, `Pigskin`, `Saddle` |
| 47 | **LIQUID & MUD** | `LIQ` | 液体与流体 | 5 | `LIQBubl`(气泡)、`LIQImpt`(打击)、`LIQMisc`(其它)、`LIQMvmt`(移动) … | `Boiling`, `Bubble`, `Bubbles`, `Burbling`, `Carbonation`, `Cavitation`, `Effervesce`, `Effervescence` |
| 48 | **MACHINES** | `MACH` | 机器 | 17 | `MACHAmus`(游乐)、`MACHAntq`(老式)、`MACHAppl`(家电)、`MACHCnst`(施工) … | `Apparatus`, `Bumper`, `Carousel`, `Carrousel`, `Cars`, `Coaster`, `Contraption`, `Device` |
| 49 | **MAGIC** | `MAG` | 魔法 | 7 | `MAGAngl`(天使)、`MAGElem`(元素)、`MAGEvil`(邪恶)、`MAGMisc`(其它) … | `Angelic`, `Appearance`, `Aura`, `Beatific`, `Blessed`, `Blessedness`, `Blessings`, `Bliss` |
| 50 | **MECHANICAL** | `MECH` | 机械 | 12 | `MECHClik`(咔哒)、`MECHGear`(齿轮)、`MECHHydr`(液压与气动)、`MECHLtch`(插销) … | `Button`, `Clack`, `Click`, `Clicker`, `Snap`, `Tick`, `Toggle`, `Axle` |
| 51 | **METAL** | `METL` | 金属 | 8 | `METLBrk`(断裂)、`METLCrsh`(碎片)、`METLFric`(挤压)、`METLHndl`(抓取) … | `Aluminum`, `Apart`, `Beryllium`, `Brass`, `Break`, `Bronze`, `Burst`, `Bust` |
| 52 | **MOTORS** | `MOTR` | 马达 | 6 | `MOTRAntq`(老式)、`MOTRComb`(内燃机)、`MOTRElec`(电动)、`MOTRMisc`(其它) … | `Aged`, `Ancient`, `Antiquated`, `Bygone`, `Classic`, `Engine`, `Historic`, `Kerosene` |
| 53 | **MOVEMENT** | `MOVE` | 移动 | 8 | `MOVEActv`(活动)、`MOVEAnml`(动物)、`MOVECrea`(生物)、`MOVECrwd`(人群) … | `Activity`, `Cleaning`, `Moving`, `Shopping`, `Unpacking`, `Charge`, `Flock`, `Herd` |
| 54 | **MUSICAL** | `MUSC` | 乐句 | 21 | `MUSCBell`(钟铃)、`MUSCBrass`(铜管)、`MUSCChim`(排铃)、`MUSCChor`(合唱) … | `Agogo`, `Agung`, `Babendil`, `Belldom`, `Bells`, `Bianzhong`, `Bonsho`, `Bourdon` |
| 55 | **NATURAL DISASTER** | `NATD` | 自然灾害 | 7 | `NATDAval`(雪崩)、`NATDQuak`(地震)、`NATDMisc`(其它)、`NATDTorn`(龙卷风) … | `Cascades`, `Crevasse`, `Earth`, `Earthslide`, `Icefall`, `Icefalls`, `Landslide`, `Landslides` |
| 56 | **OBJECTS** | `OBJ` | 物件 | 21 | `OBJBag`(袋子)、`OBJBook`(书籍)、`OBJCoin`(硬币)、`OBJCont`(箱盒) … | `Back`, `Backpack`, `Briefcase`, `Camera`, `Carryall`, `Clutch`, `Courier`, `Drawstring` |
| 57 | **PAPER** | `PAPR` | 纸张 | 7 | `PAPRFltr`(抖动)、`PAPRFric`(摩擦)、`PAPRHndl`(手持噪音)、`PAPRImpt`(打击) … | `Cardboard`, `Confetti`, `Crinkling`, `Fall`, `Flap`, `Flapping`, `Flittering`, `Flutter` |
| 58 | **PLASTIC** | `PLAS` | 塑料 | 8 | `PLASBrk`(断裂)、`PLASCrsh`(碎片)、`PLASFric`(挤压)、`PLASHndl`(抓取) … | `ABS`, `Acetate`, `Acrylic`, `Break`, `Burst`, `Chloride`, `Crack`, `Crunch` |
| 59 | **RAIN** | `RAIN` | 雨 | 10 | `RAINClth`(布料)、`RAINConc`(水泥)、`RAIN`(通用)、`RAINGlas`(玻璃) … | `Awning`, `Cloth`, `Cotton`, `Drizzle`, `Jacket`, `Precipitation`, `Rain`, `Raincoat` |
| 60 | **ROBOTS** | `ROBT` | 机器人 | 3 | `ROBTMisc`(其它)、`ROBTMvmt`(运动)、`ROBTVox`(语音) | `AI`, `Android`, `Androids`, `Artificial`, `Automatons`, `Beings`, `Bionic`, `Bot` |
| 61 | **ROCKS** | `ROCK` | 岩石 | 8 | `ROCKBrk`(断裂)、`ROCKCrsh`(碎片)、`ROCKFric`(挤压)、`ROCKHndl`(抓取) … | `Apart`, `Basalt`, `Boulders`, `Break`, `Breaks`, `Burst`, `Chip`, `Cobblestones` |
| 62 | **ROPE** | `ROPE` | 绳索 | 5 | `ROPECreak`(拉扯)、`ROPEHndl`(抓取)、`ROPEImpt`(打击)、`ROPEMisc`(其它) … | `Cable`, `Cord`, `Creak`, `Extend`, `Lengthen`, `Line`, `Paracord`, `Pull` |
| 63 | **RUBBER** | `RUBR` | 橡胶 | 7 | `RUBRCrsh`(碎片)、`RUBRFric`(挤压)、`RUBRHndl`(抓取)、`RUBRImpt`(打击) … | `Collision`, `Debris`, `Elastic`, `Fragments`, `Latex`, `Neoprene`, `Pieces`, `Plop` |
| 64 | **SCIFI** | `SCI` | 科幻 | 12 | `SCIAlrm`(警报)、`SCICmpt`(电脑)、`SCIDoor`(门)、`SCIEnrg`(能量) … | `Alarm`, `Alert`, `Buzzer`, `Fiction`, `Indicator`, `Notification`, `Sci-Fi`, `Science` |
| 65 | **SNOW** | `SNOW` | 雪 | 6 | `SNOWCrsh`(碎片)、`SNOWFric`(挤压)、`SNOWHndl`(抓取)、`SNOWImpt`(打击) … | `Blizzard`, `Collision`, `Crash`, `Debris`, `Drift`, `Flurry`, `Fragments`, `Powder` |
| 66 | **SPORTS** | `SPRT` | 运动 | 9 | `SPRTCourt`(球类运动)、`SPRTField`(户外运动)、`SPRTGym`(健身)、`SPRTIndor`(室内运动) … | `Badminton`, `Basketball`, `Dodgeball`, `Dribbling`, `Fencing`, `Futsal`, `Handball`, `Netball` |
| 67 | **SWOOSHES** | `SWSH` | 呼啸与挥动 | 2 | `SWSH`(嗖嗖声)、`WHSH`(呼呼声) | `By`, `Dart`, `Flash`, `Flutter`, `Fly`, `Glide`, `Kungfu`, `Pass` |
| 68 | **TOOLS** | `TOOL` | 工具 | 5 | `TOOLGrdn`(园林工具)、`TOOLHand`(手持)、`TOOLMisc`(其它)、`TOOLPneu`(气动) … | `Broom`, `Cultivator`, `Edger`, `Fork`, `Garden`, `Hand`, `Hedge`, `Hoe` |
| 69 | **TOYS** | `TOY` | 玩具 | 3 | `TOYElec`(电动)、`TOYMech`(机械)、`TOYMisc`(其它) | `Car`, `Controlled`, `Device`, `Digital`, `Entertainment`, `Furby`, `Gadget`, `Game` |
| 70 | **TRAINS** | `TRN` | 火车 | 13 | `TRNBrake`(刹车)、`TRNClak`(哐当)、`TRNDoor`(门)、`TRNDiesl`(内燃机车) … | `Bake`, `Brake`, `Brakes`, `Braking`, `Breaks`, `Grind`, `Halting`, `Pads` |
| 71 | **USER INTERFACE** | `UI` | 用户界面 | 7 | `UIAlert`(警告)、`UIBeep`(提示音)、`UIClick`(点击)、`UIData`(数据) … | `Advisory`, `Alarm`, `Alert`, `Alertness`, `Attention`, `Blip`, `Caution`, `GUI` |
| 72 | **VEGETATION** | `VEGE` | 植物 | 4 | `VEGEGras`(草)、`VEGELeaf`(叶)、`VEGEMisc`(其它)、`VEGETree`(树) | `Flora`, `Foliage`, `Grass`, `Grassland`, `Green`, `Greenery`, `Hay`, `Lawn` |
| 73 | **VEHICLES** | `VEH` | 车辆 | 30 | `VEHAlrm`(警报)、`VEHAntq`(古董车)、`VEHAtv`(全地形车)、`VEHBike`(自行车) … | `Alarm`, `Anti-Theft`, `Arm`, `Auto`, `Automobile`, `Car`, `Chirp`, `Disarm` |
| 74 | **VOICES** | `VOX` | 语音 | 16 | `VOXAlien`(外星人)、`VOXBaby`(婴儿)、`VOXCheer`(欢呼)、`VOXChld`(儿童) … | `Alien`, `Chewbacca`, `Cosmic`, `ET`, `Extraterrestrial`, `Language`, `Vocal`, `Vocalization` |
| 75 | **WATER** | `WATR` | 水 | 20 | `WATRBubl`(气泡)、`WATRDran`(排水)、`WATRDrip`(滴)、`WATRFizz`(气泡) … | `Aerate`, `Aerated`, `Aeration`, `Aqua`, `Blub`, `Boil`, `Boiling`, `Boils` |
| 76 | **WEAPONS** | `WEAP` | 武器 | 11 | `WEAPArmr`(护甲)、`WEAPArro`(箭)、`WEAPAxe`(斧)、`WEAPBlnt`(钝器) … | `Armor`, `Armorer`, `Armory`, `Armour`, `Armoured`, `Armourer`, `Armoury`, `Bracers` |
| 77 | **WEATHER** | `HAIL` | 天气 | 4 | `HAIL`(冰雹)、`WTHR`(其它)、`STORM`(风暴)、`THUN`(雷) | `Balls`, `Frozen`, `Graupel`, `Hail`, `Hailstones`, `Hailstorm`, `Ice`, `Pellets` |
| 78 | **WHISTLES** | `WHST` | 哨音 | 3 | `WHSTHmn`(人)、`WHSTMech`(机械设备)、`WHSTMisc`(其它) | `Cheering`, `Human`, `Signal`, `Whistle`, `Wolf`, `Bird`, `Call`, `Coach` |
| 79 | **WIND** | `WIND` | 风 | 7 | `WINDDsgn`(声音设计)、`WIND`(通用)、`WINDGust`(阵风)、`WINDInt`(室内) … | `Artificial`, `Designed`, `Machine`, `Simulated`, `Synthetic`, `Tonal`, `Wind`, `Air` |
| 80 | **WINDOWS** | `WNDW` | 窗户 | 7 | `WNDWCover`(遮挡物)、`WNDWHdwr`(窗具)、`WNDWKnck`(敲窗)、`WNDWMetl`(金属) … | `Awnings`, `Blackout`, `Blind`, `Blinds`, `Curtain`, `Curtains`, `Drapes`, `Mini-Blinds` |
| 81 | **WINGS** | `WING` | 翅膀 | 4 | `WINGBird`(鸟)、`WINGCrea`(生物)、`WINGInsc`(昆虫)、`WINGMisc`(其它) | `Avian`, `Bird`, `Feather`, `Feathered`, `Flap`, `Flapping`, `Flight`, `Flutter` |
| 82 | **WOOD** | `WOOD` | 木头 | 8 | `WOODBrk`(断裂)、`WOODCrsh`(碎片)、`WOODFric`(挤压)、`WOODHndl`(抓取) … | `2x4`, `Apart`, `Beam`, `Board`, `Break`, `Breaks`, `Burst`, `Chip` |

---

## 4. 命令行速查

```sh
# 1. 按中文或英文意图反查 UCS 分类 + 音效师复合检索短语
node tools/env/py.mjs tools/fetch_sfx.py --vocab "精密齿轮"
node tools/env/py.mjs tools/fetch_sfx.py --vocab "菜单弹出"
node tools/env/py.mjs tools/fetch_sfx.py --vocab "圆珠笔"

# 2. 展开某个 UCS 大类或具体 CatID 的全部中英同义词
node tools/env/py.mjs tools/fetch_sfx.py --cat MECH
node tools/env/py.mjs tools/fetch_sfx.py --cat UIBeep

# 3. 直接用中文或英文搜 Freesound CC0 录音并联动 sfx_judge 物理形态初筛
node tools/env/py.mjs tools/fetch_sfx.py --search "pocket watch escapement" --probe-audio
node tools/env/py.mjs tools/fetch_sfx.py --search "精密齿轮" --probe-audio
```

---

## 5. 来源与许可

- **Universal Category System (UCS) v8.2.1**：由 Tim Nielsen、Justin Drury、Kai Paquin 等发起的公有领域（Public Domain / `CC0-1.0`）音效分类标准（`https://universalcategorysystem.com/`），原始文件 `UCS v8.2.1 Full Translations.xlsx`（SHA-256: `caca08099b40203897365c02b6a52f5556ada7beb695adce2a6c64640aa9e195`）。
- **上游中文译表勘误（已写入 `engine/audio/ucs_vocab.json` 的 `fixes` 字段）**：修正了官方译表中 `OBJECTS` 四行错位（`OBJFash` 时尚服饰、`OBJFurn` 家具、`OBJGrdn` 园艺、`OBJGym` 健身器材）、`PAPER` 两行互换（`PAPRFric` 摩擦、`PAPRImpt` 打击）、`AERORadio`（遥控飞行器）与 `CLOCKChim`（报时钟声），并统一了 `BOATS` / `GUNS` / `SWOOSHES` 的大类中文名。
