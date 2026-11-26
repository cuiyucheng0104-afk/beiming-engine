// src/timeline.js —《北冥》的镜头表：三个镜头的起点和片长，全片只在这里写一次。
// 切镜头（main.js 的 shots / dur）、镜头 A 的推镜长度（shotA.js）、镜头 B 的人物时间（girl.js 的 GIRL_SHOT）、
// 镜头 C 的起点（shotC.js 的 C_START）、显示层与片名的时间（hud.js 的 HUD_T）都从这里取。
//
// 镜头内部的编排（云墙何时拉开、鲲何时转身、显示层各元素何时出场、片名何时写……）按设计稿写成全局秒，
// 设计稿的镜头表是 DESIGN（A 0、B 3、C 5、片尾 10）。改了 TIMELINE 里某个镜头的起点，
// 那个镜头的编排整体平移 shiftOf(镜头)，镜头 B、C 的局部时钟从新起点开始走，不会在新旧起点之间冻帧。
// 镜头 C 之后的显示层、片尾日光和片名跟着镜头 C 一起平移；片长 end 不跟着变，改完起点要核对片尾。
// 镜头起点最好落在整帧上（1/24 秒的整数倍）：一拍二、一拍三按整数帧号量化。
//
// 要改镜头表就改下面 TIMELINE 这一行。它是冻结的：各模块在载入时取值（有几处在函数里现读，冻结后两者一样），
// 运行中给它赋值会直接抛 TypeError，不会出现显示层跟着平移、镜头 C 却没动这种各走各的情况。
export const TIMELINE = Object.freeze({ A: 0, B: 3, C: 5, end: 10 });
export const DESIGN = Object.freeze({ A: 0, B: 3, C: 5, end: 10 });
export const shiftOf = k => TIMELINE[k] - DESIGN[k];   // 镜头 k 的编排相对设计稿平移了多少秒
