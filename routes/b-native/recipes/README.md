# 画面配方样张（北冥原生 · BNE）

同一个道具（模版的浮标灯，`../template/prop.js`）在四种配方下各一秒：Toon 三渲二、PBR 风格化、绘画卡片合成、水墨线描。配方的灯光、色板、材质与后期顺序写在 `film.tsx` 开头与 [B 路线手册](../README.md)「画面工艺」的配方表；要哪一种就把对应分支抄进自己的作品。

```sh
node engine/native/prepare.mjs routes/b-native/recipes
node engine/render/native.mjs routes/b-native/recipes --at 12,36,60,84   # 四张样张：out/<run-id>/stills/f000012.png …
```

样张是现渲的，不入库（`media/`、`out/` 已忽略）。踩过的坑：同一个模型在不同镜头换材质覆盖时，每个镜头给不同的 `name`——运行时按名字跨帧沿用实体，同名时后面镜头的覆盖不生效；全局卡通覆盖只换明暗处理、不换各材质自己的颜色，要换色就按材质名逐个给（`parts`）。
