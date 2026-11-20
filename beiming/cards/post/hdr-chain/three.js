// post.hdr-chain 在 three 帧源里的实现：后期链上的一个全屏通道。这一版只有直通。
// 和帧源的约定（卡文件的 ports.requires 里也写了）：Handle.object 是一张全屏网格，材质的 uniforms.tInput 是上一遍的颜色
// （场景线性 Rec.709，预乘透明度，32 位浮点）；帧源每一遍把它渲进另一个同样大小的浮点目标。

const VERTEX = 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }';
// 按整数像素坐标取，不经过采样器的过滤：输出和输入逐位相同
const FRAGMENT = 'uniform sampler2D tInput; void main() { gl_FragColor = texelFetch(tInput, ivec2(gl_FragCoord.xy), 0); }';

/** ctx 用到 THREE。params：ao 开不开环境光遮蔽，bloom 开不开泛光；这一版两样都没有，开了就报错，不装成开了 */
export function create(ctx, params) {
  const on = ['ao', 'bloom'].filter((k) => params[k]);
  if (on.length) throw new Error(`post.hdr-chain 这一版只有直通，${on.join('、')} 还没有`);
  const { THREE } = ctx;
  const geometry = new THREE.PlaneGeometry(2, 2);
  const material = new THREE.ShaderMaterial({
    uniforms: { tInput: { value: null } }, vertexShader: VERTEX, fragmentShader: FRAGMENT,
    blending: THREE.NoBlending, depthTest: false, depthWrite: false, toneMapped: false,
  });
  const pass = new THREE.Mesh(geometry, material);
  pass.name = 'post.hdr-chain';
  pass.frustumCulled = false;
  return {
    object: pass,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
