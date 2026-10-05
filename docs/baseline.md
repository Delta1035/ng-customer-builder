# P0 基线盘点

记录日期：2026-10-05。

## 目标项目的确定

`D:\projects\vibe-coding\ng-customer-builder` 在开始实施时只包含 `ANGULAR_ROLLUP_BUILDER_PLAN.md`，
没有 Git 仓库、AGENTS.md、package.json 或任何 Angular 工作区。因此没有「需要改造的既有子项目」，
按规格第 1 节的默认策略新建了：构建器包 + 示例应用 + partial-Ivy 测试库，并以 `build-rollup/serve-rollup`
与官方 `build/serve` 并行接入。

## 版本矩阵

| 项目 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | 24.18.0 | 满足 compiler-cli 要求 `^22.22.3 \|\| ^24.15.0 \|\| >=26` |
| 包管理器 | npm 11.16.0 | 唯一锁文件 `package-lock.json`；npm workspaces |
| @angular/core / compiler / compiler-cli / common / router / forms / platform-browser | 22.2.1 | 当前最新稳定版，彼此严格一致 |
| @angular/cli | 22.2.1 | |
| @angular-devkit/architect | 0.2202.1 | 版本号与 Angular major 不同（0.22xx） |
| @angular/build（仅对照） | 22.2.1 | 只用于官方 `build/serve` 对照目标 |
| TypeScript | 6.0.3 | compiler-cli 22.2.1 要求 `>=6.0 <6.1` |
| RxJS | 7.8.2 | |
| zone.js | 0.16.3 | 示例默认 zoneless；仅 zone 场景测试使用 |
| Rollup | 4.64.0 | |
| @babel/core | 8.0.x | compiler-cli 22 自身依赖 Babel 8；Linker 以 Babel 插件形式使用 |
| 浏览器（测试） | Microsoft Edge（系统已安装），通过 playwright-core 驱动 | 无需下载浏览器 |
| 操作系统 | Windows 11 Pro 10.0.26200 | Linux 未验证 |

## 示例应用特性

| 特性 | 选择 |
| --- | --- |
| 组件模型 | standalone（无 NgModule fixture） |
| 变更检测 | zoneless（另有 zone.js 场景测试） |
| 路由 | 懒加载子路由 + 深层路由 |
| `@defer` | 有（`on interaction`） |
| 样式 | 纯 CSS：全局样式 `@import`、组件外部/内联样式、`url()` 资源 |
| 文件替换 | `environment.ts` → `environment.prod.ts` |
| polyfills | 本地 `polyfills.ts`（验证执行顺序） |
| 资源 | `public/` 目录 |
| i18n / SSR / Worker / Service Worker | 无 |
| partial-Ivy 依赖 | 自建 `@acme/greeting-lib`（npm workspace 链接）+ Angular 官方包 |

## 已核实的接口事实

- `@angular/compiler-cli` 根入口导出 `readConfiguration`、`createCompilerHost`、`createProgram`、`defaultGatherDiagnostics`、`formatDiagnostics`、`isShim`；Linker 入口 `@angular/compiler-cli/linker`（`needsLinking`）与 `@angular/compiler-cli/linker/babel`（默认导出 Babel 插件）。均为纯 ESM。
- 其 `.d.ts` 使用无扩展名 re-export，在 `moduleResolution: nodenext` 的 CJS 包中解析为空类型 → 采用显式适配契约（`compiler/compiler-cli-api.ts`）。
- `NgtscProgram.emit()` 在增量模式下跳过未变化文件，并调用 `host.writeFile(…, sourceFiles)`。
- `performCompilation` 是同步的，无法使用异步 `transformResource`；因此改用 `createProgram + loadNgStructureAsync`。
- Architect 通过 `require()` 加载 Builder 实现；对 async iterable 的取消通过 `iterator.return()`，因此需要 `addTeardown` 驱动的 AbortSignal。

## 官方构建基线（同一示例）

`ng run basic-app:build:production`：成功，3.1 s（含首次缓存写入）。初始 chunk 合计 265.7 kB（估算传输 73.3 kB），
懒加载 chunk 2 个。详细对照见 [benchmarks.md](benchmarks.md)。

## 现有问题记录

- `npm install` 提示 `esbuild`、`lmdb` 等包的 install script 未被 `allowScripts` 允许（npm 11 默认行为）。
  这只影响官方对照目标；官方构建实测可以运行。自定义构建器的依赖不包含原生 install script。
