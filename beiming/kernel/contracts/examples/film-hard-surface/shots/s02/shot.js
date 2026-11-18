// 片名落版镜头的入口文件。写法照镜头契约 3.5 的示意。
export async function build(ctx) {
  const { THREE } = ctx
  const scene = new THREE.Scene()
  const title = ctx.cards.use('overlay.title@1', { text: ctx.params.text })
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
