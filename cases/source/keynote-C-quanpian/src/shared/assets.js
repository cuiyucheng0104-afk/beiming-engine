// 资产表：全片用到的 IP 图与材质（文件都在工程 material/ 下，从 共用/ 复制而来）。
// 键名 = 页码 + 拼音短名；ch = 规范 §2 指定使用的章节/小段。IP 图规则见 ARCH.md §7：整张印成带白边的卡片，不改色、不变形、不抠图、不重画、不全屏。
export const IP = {
  // —— 开头已用（stage.js 用 IMG.* 加载；第二章可以接管开头的卡片对象，不必重新加载）——
  p02_wukong: { file: 'P02_孙悟空_大闹天宫海报.png', ch: 'ch1' },
  p02_heimao: { file: 'P02_黑猫警长_海报.png', ch: 'ch1' },
  p02_hulu: { file: 'P02_葫芦兄弟_海报.png', ch: 'ch1' },
  p05_still: { file: 'P05_孙悟空_大闹天宫剧照.png', ch: 'ch1 / ch2.a（续用：开头的剧照卡对象 = ctx.opening.stillG）' },
  // —— 第二章 角色叙事 ——
  p06_nezha: { file: 'P06_哪吒闹海_剧照.png', ch: 'ch2.b' },
  p06_hulu: { file: 'P06_葫芦兄弟_剧照.png', ch: 'ch2.b' },
  p07_heimao: { file: 'P07_黑猫警长_剧照.png', ch: 'ch2.c' },
  p08_xuehaizi: { file: 'P08_雪孩子_海报.png', ch: 'ch2.d' },
  p08_afanti: { file: 'P08_阿凡提_海报.png', ch: 'ch2.d' },
  p08_shuke: { file: 'P08_舒克和贝塔_海报.png', ch: 'ch2.d' },
  p08_tutu: { file: 'P08_大耳朵图图_形象.png', ch: 'ch2.d' },
  // —— 第三章 美术语言 ——
  p04_kedou: { file: 'P04_小蝌蚪找妈妈_水墨.png', ch: 'ch3.ink' },
  p10_mudi: { file: 'P10_牧笛_水墨.png', ch: 'ch3.ink' },
  p09_jiuselu: { file: 'P09_九色鹿_海报.png', ch: 'ch3.mural' },
  p09_tianshu: { file: 'P09_天书奇谭_剧照.png', ch: 'ch3.mural' },
  p11_hailuo: { file: 'P11_金色的海螺_剪纸.png', ch: 'ch3.paper' },
  p11_afanti_puppet: { file: 'P11_阿凡提的故事_木偶.png', ch: 'ch3.puppet' },
  // —— 第四章 新作品 ——
  p12_whale: { file: 'P12_中国奇谭_鲸鱼主视觉.png', ch: 'ch4.whale' },
  p13_sanlong: { file: 'P13_中国奇谭2_如何成为三条龙.png', ch: 'ch4.windows' },
  p13_erzhong: { file: 'P13_中国奇谭2_耳中人.png', ch: 'ch4.windows' },
  p13_xiaoxue: { file: 'P13_中国奇谭2_小雪.png', ch: 'ch4.windows' },
  p13_daguiren: { file: 'P13_中国奇谭2_大贵人.png', ch: 'ch4.windows' },
  p14_langlang: { file: 'P14_浪浪山小妖怪_海报.png', ch: 'ch4.forest' },
  p15_ranbiwa: { file: 'P15_燃比娃_宣纸手绘.png', ch: 'ch4.ranbiwa' },
  // —— 第五章 合作城 ——
  p17_starbucks: { file: 'P17_大闹天宫x星巴克.png', ch: 'ch5.fly（咖啡店）' },
  p17_guming: { file: 'P17_葫芦兄弟x古茗.png', ch: 'ch5.fly（茶饮店）' },
  p17_citic: { file: 'P17_中国奇谭x中信出版立体书.png', ch: 'ch5.fly（书店）' },
};
// 材质（共用/材质/，本地 Qwen-Image 生成；见 CREDITS）
export const MAT = {
  cloth: '书封布面.png',          // 书封群青布（开头已用）
  xuan: '宣纸.png',               // 第三章 水墨：宣纸纤维
  xuanBack: '宣纸_逆光.png',      // 第三章 水墨：逆光宣纸（透光层）
  mural: '壁画土墙.png',          // 第三章 壁画：土墙颗粒
  red: '红纸.png',                // 第三章 剪纸：红纸
  curtain: '棉布幕_透光.png',     // 第三章 木偶：棉布幕
  silk: '装裱绫绢.png',           // 可选：装裱绫绢
};
