// 北冥仓库 · JavaScript 静态检查（ESLint 扁平配置，ESLint ≥ 9）。
// 现阶段只报告、不阻塞：npm run lint（= node tools/check-all.mjs --only lint）列出错误与警告的数量和最多的规则；
// CI 的 check job 跑同一步，结果进报告，不让 PR 变红。存量告警按目录逐步清理，不为了过 lint 去改别的工作包的代码。
// 需要的开发依赖（package.json 的 devDependencies，由集成负责人登记）：eslint、@eslint/js、globals。
//
// 规则：@eslint/js 的 recommended（未定义变量、重复声明、恒真条件、不可达代码等真错误），未使用变量降为警告。
// 运行环境按目录区分：
//   浏览器端  engine/ 各层、src/、lab/、routes/*/template/、site/、films/，以及资产桥里在无头 Chromium 里跑的模块
//   Node 端   tools/、tests/、engine/render/、engine/native/ 的入口脚本、examples/raea/tools/ 的命令行脚本、各种 *.config.js
//   engine/render 的脚本也会把回调交给 page.evaluate 在页面里执行，所以两种全局都给。
// 不检查：cases/（第三方快照与历史归档，只读）、各类产物目录、测试夹具（里面有故意写坏的文件）、TypeScript（.ts / .tsx 由 B 路线的原生运行时自己校验）。
import js from '@eslint/js';
import globals from 'globals';

const BROWSER = [
  'engine/**/*.{js,mjs}', 'src/**/*.js', 'lab/**/*.js', 'routes/**/template/**/*.js', 'site/**/*.js', 'films/**/*.js',
  'examples/raea/tools/*-browser.mjs',
];
const NODE = [
  'tools/**/*.{js,mjs}', 'tests/**/*.{js,mjs}', 'engine/render/**/*.mjs',
  'engine/native/*.mjs', 'engine/native/bridge/export.mjs', 'engine/native/bridge/validate.mjs',
  'examples/raea/tools/*.mjs', '*.config.{js,mjs}',
];

export default [
  {
    ignores: [
      'cases/**', 'out/**', 'films/*/out/**', '_site/**', '_previews/**', '.venv/**',
      'examples/raea/media/**', 'examples/raea/delivery/**', '**/*.min.js', '**/fixtures/**', '**/__fixtures__/**',
    ],
  },
  js.configs.recommended,
  {
    linterOptions: { reportUnusedDisableDirectives: 'warn' },
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  { files: BROWSER, languageOptions: { globals: { ...globals.browser } } },
  { files: NODE, languageOptions: { globals: { ...globals.node } } },
  { files: ['**/*.cjs'], languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } } },
];
