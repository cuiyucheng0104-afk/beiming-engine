// 测试里「有没有无头浏览器」的唯一判据：直接用 tools/run-tests.mjs 里 suite.json 的 requires: browser 的同一个探测。
// 不用 chromium.executablePath：它指向完整 Chromium，而渲染器与 CI 装的是 chromium-headless-shell，
// 拿它判断会让整组浏览器测试在 CI 里静默跳过（只显示「跳过」，不会红）。
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 北冥引擎 Beiming Engine
import { probeCapability, ROOT } from '../../tools/run-tests.mjs';

export const browserOk = probeCapability('browser', { root: ROOT }).ok;
