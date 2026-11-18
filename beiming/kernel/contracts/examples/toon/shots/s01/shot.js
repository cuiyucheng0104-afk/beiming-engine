// 卡通镜头的入口文件。色阶着色写在母语代码里，后期链和相机用卡。
export async function build(ctx) {
  const { THREE } = ctx
  const bands = ctx.params.bands
  const scene = new THREE.Scene()

  // 色阶表：bands 档，最近邻取样，所以明暗交界是硬边。
  const steps = new Uint8Array(bands).map((_, i) => Math.round((255 * (i + 1)) / bands))
  const ramp = new THREE.DataTexture(steps, bands, 1, THREE.RedFormat)
  ramp.minFilter = ramp.magFilter = THREE.NearestFilter
  ramp.needsUpdate = true

  // 令牌是显示空间的色值，THREE.Color 读入时转成场景线性。
  const material = new THREE.MeshToonMaterial({ color: new THREE.Color(ctx.tokens.accent), gradientMap: ramp })
  const hero = new THREE.Mesh(new THREE.SphereGeometry(0.5, 48, 24), material) // 半径 0.5 米
  hero.position.set(0, 0.5, 0)
  scene.add(hero)
  scene.add(new THREE.DirectionalLight(0xffffff, 3))

  // 只带实例名：post 是片子描述里这个镜头 cards 的一项，参数从那里来。
  const post = ctx.cards.use('post')

  return {
    scene,
    camera: ctx.tracks.camera,
    entities: { hero },
    state(f, sub) {
      ctx.tracks.apply(f, sub)
      post.apply?.(f, sub)
    },
    meta(f) {
      return { anchors: { 'hero#top': [0, 1, 0] } } // 世界坐标，米
    },
    dispose() {
      post.dispose()
      ramp.dispose()
      material.dispose()
      hero.geometry.dispose()
    },
  }
}
