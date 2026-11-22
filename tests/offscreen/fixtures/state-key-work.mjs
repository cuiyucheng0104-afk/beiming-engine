// WP2.3 对拍夹具：每两帧同一灰度，stateKey 完整描述会影响画面的状态。
export function build({ TSL, pipeline }) {
  const { uniform, vec4 } = TSL, level = uniform(0), post = pipeline(vec4(level, level, level, 1));
  return {
    stateKey: f => String(Math.floor(f / 2)),
    render(f) { level.value = Math.floor(f / 2) / 4; post.render(); },
  };
}
