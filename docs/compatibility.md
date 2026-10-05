# 兼容性说明

首版范围：**浏览器端 CSR 应用**，dev/prod 均为 AOT。它**不是**官方 `@angular/build:application` 的完全等价替代品。
不支持的配置会被 schema（未知字段）或归一化逻辑（不支持的值）**明确拒绝**，不会被静默忽略。

已验证环境：Angular 22.2.1 / TypeScript 6.0 / Node 24.18 / Rollup 4.64 / Windows 11（路径含空格与中文）。
Linux/macOS 未执行验证。

## build 选项

| 选项 | 状态 | 说明 |
| --- | --- | --- |
| `browser` `tsConfig` `index` `outputPath` | ✅ | 路径相对工作区根；`index` 必须显式包含 `<head>`、`<body>` |
| `styles` | ✅ 仅 `.css` | 有序合并为 `styles.css`；`.scss/.sass/.less/.styl` 被拒绝 |
| `assets` | ✅ 仅目录 | 目录内容整体复制到输出根；官方的 glob 对象写法不支持；同名冲突报错 |
| `polyfills` | ✅ | 模块说明符（`zone.js`）或工作区文件；按顺序打包为 `polyfills.js` |
| `baseHref` | ✅ 仅路径 | 必须以 `/` 开头；CDN 绝对地址被拒绝 |
| `fileReplacements` | ✅ | 同时作用于类型检查与打包 |
| `optimization` | ✅ boolean | 压缩、内容哈希、生产常量；不支持官方的对象形式 |
| `sourceMap` | ✅ boolean | 不支持官方的对象形式（`scripts/styles/hidden/vendor`） |
| `watch` | ✅ | |
| 其它官方选项（`scripts`、`budgets`、`extractLicenses`、`outputHashing`、`server`、`ssr`、`prerender`、`localize`、`i18n*`、`webWorkerTsConfig`、`serviceWorker`、`crossOrigin`、`subresourceIntegrity`、`deployUrl`、`namedChunks`、`inlineStyleLanguage`、`stylePreprocessorOptions`、`externalDependencies`、`loader`、`define` …） | ❌ 拒绝 | schema `additionalProperties: false` |

## dev-server 选项

| 选项 | 状态 | 说明 |
| --- | --- | --- |
| `buildTarget` | ✅ | 只接受本包的 build Builder（防止递归或服务其它工具的产物） |
| `host` `port` `liveReload` | ✅ | 默认 `localhost:4200`；端口占用时报可操作错误 |
| `hmr` | ❌ `true` 被拒绝 | 只有整页刷新 |
| `proxyConfig` `ssl*` `headers` `open` `allowedHosts` `servePath` `prebundle` … | ❌ 拒绝 | schema 不包含 |

## 应用特性

| 特性 | 状态 | 验证 |
| --- | --- | --- |
| standalone 组件、DI、信号、表单 | ✅ | e2e A04 |
| NgModule 应用 | ⚪ 未验证 | 编译链路相同，但没有 NgModule fixture，未执行验收 |
| 外部/内联模板、外部/内联组件样式 | ✅ | e2e A07 |
| 路由懒加载、深层路由直接打开 | ✅ | e2e A05 |
| `@defer` | ✅ | e2e A06 |
| zone.js 与 zoneless | ✅ | e2e A13（两种都验证） |
| partial-Ivy 库（自建 + Angular 官方包） | ✅ | e2e A03 |
| 工作区链接库（npm workspaces 符号链接） | ✅ | e2e A19，单一 Angular 运行时 |
| TS `paths` 指向库源码 | ✅ 设计支持 | 模块解析使用 `ts.resolveModuleName`；无专门 fixture |
| TS `paths` 指向已构建库（`.d.ts` + `.js`） | ⚠ 有限 | 取 `.d.ts` 旁边的 `.mjs/.js`；若该 JS 是 partial 编译会被 Linker 处理 |
| CommonJS 依赖 | ⚠ 未专门验证 | 已接入 `@rollup/plugin-commonjs` |
| JSON 导入 | ❌ | 未接入 `@rollup/plugin-json` |
| 组件样式 `url()` 相对路径 | ✅ | 输出到 `media/`（官方 CLI 行为类似） |
| SCSS/Less/PostCSS/Tailwind | ❌ 拒绝 | 见 architecture.md「动手扩展」 |
| 全局 `scripts` | ❌ 拒绝 | |
| SSR / 预渲染 / 水合、i18n、Web Worker、Service Worker | ❌ 拒绝 | 后续独立阶段 |
| HMR、CSS 热替换、持久缓存 | ❌ | 后续独立阶段 |
| CSP nonce / SRI / budgets / license 提取 / CDN 前缀 | ❌ | 后续独立阶段 |

## 与官方构建的行为差异

| 方面 | 官方 application Builder | 本构建器 |
| --- | --- | --- |
| 输出目录 | `outputPath/browser/` | `outputPath/`（不追加 `browser`） |
| 打包器 | esbuild | Rollup 4 |
| 开发服务器 | Vite（按需编译、HMR） | 自有 Node http（完整重建、整页刷新） |
| 生产 JS 体积 | 基线 | +9.8% 原始 / +3.0% gzip（本示例） |
| 全局 CSS | 压缩 | 不压缩 |
| 目标语法 | 按 browserslist 降级 | 固定 ES2022，依赖代码不降级 |
| 文件名哈希 | `main-XXXXXXXX.js` | `main-xxxxxxxx.js`（Rollup 哈希格式） |
| 许可证 | 提取到 `3rdpartylicenses.txt` | 仅保留 `@license` / `/*!` 注释 |
| 持久缓存 | `.angular/cache` | 无（仅进程内存缓存） |

### 浏览器范围

TypeScript 输出 ES2022，依赖代码不做语法降级，也不自动注入 Web 平台 polyfill。
适用于支持 ES2022 与 ES 模块的常青浏览器（Chrome/Edge/Firefox/Safari 近期版本）。
需要更旧的浏览器时，这是**迁移阻断项**。
