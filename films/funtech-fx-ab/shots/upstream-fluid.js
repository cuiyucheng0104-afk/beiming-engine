// 流体片元来自 use-shader-fx，按 MIT 使用，许可见 USE-SHADER-FX-LICENSE.txt。邻接纹素由北冥的 vUv 推算。
// @provenance use-shader-fx@338e63427310a6b13947f68c5863e4cf4bbb62f1:packages/use-shader-fx/src/fxs/simulations/useFluid/shaders/
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
// SPDX-FileCopyrightText: 2024 HASHIMOTO Takuma

export const shaders = {
  advection: `precision highp float;

varying vec2 vUv;
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 texelSize;
uniform float dt;
uniform float dissipation;

void main () {
	vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
	gl_FragColor = vec4(dissipation * texture2D(uSource, coord).rgb,1.);
}`,
  splat: `precision highp float;

varying vec2 vUv;
uniform sampler2D uTarget;
uniform float aspectRatio;
uniform vec3 color;
uniform vec2 point;
uniform float radius;

void main () {
	vec2 nPoint = (point + vec2(1.0)) * 0.5;
	vec2 p = vUv - nPoint.xy;
	p.x *= aspectRatio;
	vec3 splat = exp(-dot(p, p) / radius) * color;
	vec3 base = texture2D(uTarget, vUv).xyz;
	gl_FragColor = vec4(base + splat, 1.0);
}`,
  divergence: `uniform vec2 texelSize;
#define vL (vUv + vec2(-texelSize.x, 0.))
#define vR (vUv + vec2(texelSize.x, 0.))
#define vT (vUv + vec2(0., texelSize.y))
#define vB (vUv + vec2(0., -texelSize.y))
precision highp float;

varying vec2 vUv;




uniform sampler2D uVelocity;

vec2 sampleVelocity(in vec2 uv) {
	vec2 clampedUV = clamp(uv, 0.0, 1.0);
	vec2 multiplier = vec2(1.0, 1.0);
	multiplier.x = uv.x < 0.0 || uv.x > 1.0 ? -1.0 : 1.0;
	multiplier.y = uv.y < 0.0 || uv.y > 1.0 ? -1.0 : 1.0;
	return multiplier * texture2D(uVelocity, clampedUV).xy;
}

void main () {
	float L = sampleVelocity(vL).x;
	float R = sampleVelocity(vR).x;
	float T = sampleVelocity(vT).y;
	float B = sampleVelocity(vB).y;
	float div = 0.5 * (R - L + T - B);
	gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
}`,
  pressure: `uniform vec2 texelSize;
#define vL (vUv + vec2(-texelSize.x, 0.))
#define vR (vUv + vec2(texelSize.x, 0.))
#define vT (vUv + vec2(0., texelSize.y))
#define vB (vUv + vec2(0., -texelSize.y))
precision highp float;

varying vec2 vUv;




uniform sampler2D uPressure;
uniform sampler2D uDivergence;

void main () {
	float L = texture2D(uPressure, clamp(vL,0.,1.)).x;
	float R = texture2D(uPressure, clamp(vR,0.,1.)).x;
	float T = texture2D(uPressure, clamp(vT,0.,1.)).x;
	float B = texture2D(uPressure, clamp(vB,0.,1.)).x;
	float C = texture2D(uPressure, vUv).x;
	float divergence = texture2D(uDivergence, vUv).x;
	float pressure = (L + R + B + T - divergence) * 0.25;
	gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
}`,
  gradientSubtract: `uniform vec2 texelSize;
#define vL (vUv + vec2(-texelSize.x, 0.))
#define vR (vUv + vec2(texelSize.x, 0.))
#define vT (vUv + vec2(0., texelSize.y))
#define vB (vUv + vec2(0., -texelSize.y))
precision highp float;

varying vec2 vUv;




uniform sampler2D uPressure;
uniform sampler2D uVelocity;

void main () {
	float L = texture2D(uPressure, clamp(vL,0.,1.)).x;
	float R = texture2D(uPressure, clamp(vR,0.,1.)).x;
	float T = texture2D(uPressure, clamp(vT,0.,1.)).x;
	float B = texture2D(uPressure, clamp(vB,0.,1.)).x;
	vec2 velocity = texture2D(uVelocity, vUv).xy;
	velocity.xy -= vec2(R - L, T - B);
	gl_FragColor = vec4(velocity, 0.0, 1.0);
}`,
  curl: `uniform vec2 texelSize;
#define vL (vUv + vec2(-texelSize.x, 0.))
#define vR (vUv + vec2(texelSize.x, 0.))
#define vT (vUv + vec2(0., texelSize.y))
#define vB (vUv + vec2(0., -texelSize.y))
precision highp float;

varying vec2 vUv;




uniform sampler2D uVelocity;

void main () {
	float L = texture2D(uVelocity, vL).y;
	float R = texture2D(uVelocity, vR).y;
	float T = texture2D(uVelocity, vT).x;
	float B = texture2D(uVelocity, vB).x;
	float vorticity = R - L - T + B;
	gl_FragColor = vec4(vorticity, 0.0, 0.0, 1.0);
}`,
  vorticity: `uniform vec2 texelSize;
#define vT (vUv + vec2(0., texelSize.y))
#define vB (vUv + vec2(0., -texelSize.y))
precision highp float;

varying vec2 vUv;


uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform float curl;
uniform float dt;

void main () {
	float T = texture2D(uCurl, vT).x;
	float B = texture2D(uCurl, vB).x;
	float C = texture2D(uCurl, vUv).x;
	vec2 force = vec2(abs(T) - abs(B), 0.0);
	force *= 1.0 / length(force + 0.00001) * curl * C;
	vec2 vel = texture2D(uVelocity, vUv).xy;
	gl_FragColor = vec4(vel + force * dt, 0.0, 1.0);
}`,
  clear: `precision highp float;

varying vec2 vUv;
uniform sampler2D uTexture;
uniform float value;

void main () {
	gl_FragColor = value * texture2D(uTexture, vUv);
}`,
};
