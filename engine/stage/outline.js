// 北冥引擎 · 描边接线：把一棵模型树里要描边的网格接到后期的屏幕空间墨线（ID 图）上。
// 卡通材质若在顶点着色器里做了形变（userData.toonOpts 的 vertexPars / vertexMainStart / vertexBegin，如脊柱弯曲、草叶摆动），
// 原样交给 ID 图，墨线才能贴着形变后的轮廓走。只处理 userData.outline 为真的网格。
//
//   wireOutlines(root, { alpha, group })
//     alpha   这棵树的墨线不透明度（远景可以压淡）
//     group   { [outlineId]: 组名 }：按网格的 userData.outlineId（卡通材质的物体号）归组，同组部件相接处不出线；null = 不归组
//   写入网格的 userData：outlineVertex { head, body, uniforms }、outlineWidth（取 outlineWeight，缺省 1）、outlineAlpha、outlineGroup
export function wireOutlines(root, { alpha = 1, group = null } = {}) {
  root.traverse(o => {
    if (!o.isMesh || !o.userData.outline) return;
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    const op = mat?.userData?.toonOpts;
    if (op && (op.vertexPars || op.vertexBegin || op.vertexMainStart)) {
      o.userData.outlineVertex = {
        head: op.vertexPars || '',
        body: (op.vertexMainStart || '') + '\n' + (op.vertexBegin || ''),
        uniforms: mat.userData.toon,
      };
    }
    o.userData.outlineWidth = o.userData.outlineWeight ?? 1;
    o.userData.outlineAlpha = alpha;
    if (group && o.userData.outlineId !== undefined && group[o.userData.outlineId]) o.userData.outlineGroup = group[o.userData.outlineId];
  });
}
