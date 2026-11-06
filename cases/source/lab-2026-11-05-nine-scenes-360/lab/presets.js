// 40 个可复现组合。每行配色固定；每列只改变法线光照色阶与羽化。
export const palettes = [
 {id:'A',name:'黛青鎏金',sky:'#779c99',horizon:'#e2c697',fog:'#9cae9a',water:'#356066',rock:'#a09370',leaf:'#526e57',roof:'#52747a',wood:'#997046',paper:'#e3d4b1',accent:'#e5ac56',shadow:'#203e47',ink:'#152c31',light:'#ffe0a2',paperAmt:.08,inkWidth:1.15},
 {id:'B',name:'月白青瓷',sky:'#a8c8ca',horizon:'#e6e5cc',fog:'#b9d1c8',water:'#6a9da4',rock:'#b5c1b2',leaf:'#7aa795',roof:'#517d83',wood:'#b0a38a',paper:'#efefdc',accent:'#e4ba7e',shadow:'#446b80',ink:'#3b646d',light:'#f3f2d7',paperAmt:.10,inkWidth:.9},
 {id:'C',name:'松烟赭石',sky:'#c1baa1',horizon:'#ecd8ad',fog:'#b4ab8e',water:'#868d79',rock:'#b38d68',leaf:'#6b7050',roof:'#615d4b',wood:'#ac7651',paper:'#e5d5b0',accent:'#d68e43',shadow:'#51453e',ink:'#3c392f',light:'#ffe6b0',paperAmt:.17,inkWidth:1.65},
 {id:'D',name:'石青石绿',sky:'#75b4ba',horizon:'#d5d5a1',fog:'#83aaa3',water:'#308991',rock:'#6b998c',leaf:'#3e9b71',roof:'#286f88',wood:'#b66a44',paper:'#e4dca9',accent:'#edc260',shadow:'#17415d',ink:'#193946',light:'#f5e1a2',paperAmt:.10,inkWidth:1.35},
 {id:'E',name:'朱砂玄墨',sky:'#b9beb1',horizon:'#e9d0a9',fog:'#a6afa3',water:'#4c6868',rock:'#a9a697',leaf:'#475a50',roof:'#39494b',wood:'#a84031',paper:'#e3d5b8',accent:'#e9a45c',shadow:'#323842',ink:'#252f33',light:'#ffe1ba',paperAmt:.11,inkWidth:1.65},
 {id:'F',name:'雾紫霞金',sky:'#b1a4c0',horizon:'#f1c7a6',fog:'#b8a6ae',water:'#7c8fa8',rock:'#bd9eaa',leaf:'#6f8390',roof:'#635b89',wood:'#bf8d82',paper:'#efdbc3',accent:'#ffd18a',shadow:'#4e486b',ink:'#4b415d',light:'#ffe1bb',paperAmt:.12,inkWidth:1.1},
 {id:'G',name:'宣纸淡墨',sky:'#d7d6c8',horizon:'#f0e9d5',fog:'#d7d7ca',water:'#aeb9b1',rock:'#bdc0b3',leaf:'#87978a',roof:'#677a78',wood:'#9c9788',paper:'#f0e9d5',accent:'#b98555',shadow:'#68767b',ink:'#566363',light:'#f8f0da',paperAmt:.22,inkWidth:1.3},
 {id:'H',name:'夜蓝灯火',sky:'#364c75',horizon:'#8393a4',fog:'#617d91',water:'#264c64',rock:'#727f91',leaf:'#315e67',roof:'#3f5d7d',wood:'#947252',paper:'#cfb991',accent:'#ffc16b',shadow:'#17283f',ink:'#182c43',light:'#c4dded',paperAmt:.07,inkWidth:1.05}
];
export const profiles = [
 {id:1,name:'二阶硬切',bands:2,feather:.012,thresholds:[.54],levels:[.12,1],continuous:0},
 {id:2,name:'三阶硬切',bands:3,feather:.015,thresholds:[.34,.66],levels:[.08,.48,1],continuous:0},
 {id:3,name:'三阶柔边',bands:3,feather:.11,thresholds:[.34,.66],levels:[.08,.48,1],continuous:0},
 {id:4,name:'四阶叠色',bands:4,feather:.035,thresholds:[.24,.48,.73],levels:[.06,.29,.61,1],continuous:0},
 {id:5,name:'六阶塑形',bands:6,feather:.065,thresholds:[.16,.31,.47,.64,.81],levels:[.04,.18,.35,.55,.77,1],continuous:0}
];
export const presets=palettes.flatMap((p,row)=>profiles.map((s,col)=>({id:`${p.id}${s.id}`,number:row*5+col+1,name:`${p.name} · ${s.name}`,palette:p,profile:s,seed:1105})));
