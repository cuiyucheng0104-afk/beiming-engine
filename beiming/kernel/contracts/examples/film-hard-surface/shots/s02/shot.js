// 片名落版镜头的入口文件。写法照镜头契约 3.5 的示意。
// 卡的参数只从片子描述来：这里只带实例名 title，文字写在片子描述这个镜头的 cards 里。
export async function build(ctx) {
  const { THREE } = ctx
  const scene = new THREE.Scene()
  const title = ctx.cards.use('title')
  scene.add(title.object)
  const camera = new THREE.PerspectiveCamera(35, ctx.size[0] / ctx.size[1], 0.1, 100)
  camera.position.set(0, 0, 6)
  return {
    scene, camera,
    entities: { title: title.object },
    state(f, sub) { title.apply(f, sub) },
    meta(f) { return title.meta(f) },
    dispose() { title.dispose() },
  }
}
