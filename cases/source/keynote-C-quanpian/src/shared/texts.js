// 全片画面文字白名单（唯一来源：共用/方案C全片规范.md §2 与 共用/方案C开头规范.md §4）。
// 用途：① tools/fonts.sh 按这里的字做字体子集；② tools/textcheck.mjs 逐帧核对 window.TEXTS，清单外的字一律报错。
// 改动这里 = 改动规范，只有架构负责人可以改；分章导演只引用 TEXT.chX.*，不要在模块里手写字符串。
export const TEXT = {
  ch1: { nums: ['1960', '25', '477', '8', '9', '12'], title: '上美影 IP 全景', label: '角色，是进入内容的入口' },
  ch2: {
    a: { title: '自由与勇气' },
    b: { left: '担当', right: '协作', leftSub: '面对选择的个体担当', rightSub: '各有本领的伙伴协作' },
    c: { title: '守护', sub: '正义与责任' },
    d: { title: '陪伴与成长', items: ['友情', '智慧', '伙伴', '生活'] },
  },
  ch3: {
    title: '美术语言',
    ink: { name: '水墨', year: '1960', films: ['《小蝌蚪找妈妈》', '《牧笛》'] },
    mural: { name: '壁画', sub: '色彩与纹样', films: ['《九色鹿》', '《天书奇谭》'] },
    paper: { name: '剪纸', films: ['《金色的海螺》'] },
    puppet: { name: '木偶', films: ['《阿凡提的故事》'] },
  },
  ch4: {
    qitan: { title: '中国奇谭', sub: '当代视角里的中式想象' },
    qitan2: { title: '中国奇谭 2', facts: '9 部独立短片｜12 位导演｜2026.1.1', windows: ['如何成为三条龙', '耳中人', '小雪', '大贵人'] },
    langlang: { title: '浪浪山小妖怪', sub: '无名小妖，自己的故事｜2025.8.2' },
    ranbiwa: { title: '燃比娃', sub: '宣纸手绘的长片表达｜2026.4.28 内地公映' },
  },
  ch5: {
    title: '已公开的合作案例',
    cases: ['大闹天宫 × 星巴克｜饮品联名', '葫芦兄弟 × 古茗｜茶饮联名', '中国奇谭 × 中信出版｜立体书'],
    doors: ['01 角色叙事｜这个角色为什么适合场景？', '02 美术语言｜哪些视觉特点值得保留？', '03 内容共创｜有什么故事值得一起讲？'],
  },
  ch6: {
    steps: ['目标场景', 'IP 与版本', '权利范围', '样稿与提案'],
    stepSubs: ['项目与受众，希望表达什么', '具体作品，具体角色造型', '媒介与地域，使用期限', '应用示意，共创形式'],
    folder: { title: '首轮讨论方向', rows: ['孙悟空｜突破与探索', '九色鹿｜壁画色彩与纹样', '中国奇谭｜一个当代主题'] },
  },
  ch7: { tan: '谈', cover: '选定方向 · 开始洽谈', footer: '合作方向为内部讨论建议，具体作品、版本与使用范围另行沟通｜资料口径 2026-10-31' },
};

// 占位卡上的字（只在骨架阶段出现；成片前必须为 0 —— tools/textcheck.mjs 会把它们列为 PLACEHOLDER）
export const PLACEHOLDER = { ch2a: '二 角色叙事 · 2a', ch2b: '二 角色叙事 · 2b', ch2c: '二 角色叙事 · 2c', ch2d: '二 角色叙事 · 2d', ch3: '三 美术语言', ch4: '四 新作品', ch5: '五 合作城', ch6: '六 洽谈', ch7: '七 尾声' };

function flat(o, out = []) { if (typeof o === 'string') out.push(o); else if (Array.isArray(o)) o.forEach(x => flat(x, out)); else if (o && typeof o === 'object') Object.values(o).forEach(x => flat(x, out)); return out; }
export const ALLOWED = new Set(flat(TEXT));
export const PLACEHOLDERS = new Set(flat(PLACEHOLDER));
export const allChars = () => [...new Set([...flat(TEXT).join(''), ...flat(PLACEHOLDER).join('')])].join('');
