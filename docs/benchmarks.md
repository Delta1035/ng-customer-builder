# 性能与体积对照（A24）

测量脚本：`npm run benchmark`（`scripts/benchmark.mjs`）。测量日期 2026-10-05。

**环境**：Intel Core Ultra 7 270K Plus（24 线程）、31 GB 内存、Windows 11（10.0.26200）、Node v24.18.0、
Angular 22.2.1、Rollup 4.64.0、示例应用 `fixtures/basic-app`。

**方法**：新进程完整执行 `ng run` 的墙钟时间中位数（3 次，含 CLI 启动约 1 s）；体积为产物中 `.js/.css` 合计，gzip level 9。
自定义 Builder 没有持久缓存，每次都是冷构建。

## 生产构建

| 指标 | 官方 `@angular/build:application` | `@acme/angular-rollup-builder` | 差异 |
| --- | --- | --- | --- |
| 生产构建（清空 `.angular/cache`） | 1519 ms | 4746 ms | +212% |
| 生产构建（官方使用持久缓存） | 1398 ms | 4746 ms（无持久缓存） | +239% |
| JS/CSS 文件数 | 7 | 5 | |
| JS/CSS 原始体积 | 260.8 kB | 286.3 kB | +9.8% |
| JS/CSS gzip 体积 | 81.0 kB | 83.4 kB | +3.0% |

自定义构建器的阶段耗时（单次生产构建，Builder 内部计时）：编译约 0.7 s、Rollup 打包约 2.7–3.9 s、资源约 15 ms。
打包阶段的主要成本是 Babel 链接 Angular 的 FESM 包，以及 Rollup 对约 1 MB 框架代码的分析与 terser 压缩。

## 开发服务器（仅自定义 Builder）

| 场景 | 耗时 |
| --- | --- |
| 首次构建（服务启动后） | 3770 ms |
| 修改外部模板 → 新构建可用（中位数，5 次） | 1197 ms |
| 修改 TS 文件 → 新构建可用（中位数，5 次） | 1149 ms |

一次热重建的分解：Angular 增量编译约 170–220 ms，Rollup 约 900 ms。
关闭 Source Map 几乎没有差别（实测 ~860–945 ms），耗时主要是 Rollup 每次重新分析整张模块图
（模块 transform 结果——包括 Linker——已由 `cache` 复用）。
官方 dev-server 基于 Vite 按需编译，没有可比的「完整重建」事件，因此不做对比。

可能的改进方向（未实施，见 architecture.md「动手扩展」）：开发模式关闭 tree-shaking、预打包 Angular 包、持久缓存 Linker 结果。

## 体积差异来源

| 步骤 | main.js 原始体积 |
| --- | --- |
| 初版（只用 terser `global_defs`） | 392 kB |
| + Rollup 分析前替换 `ngDevMode` 等常量（`define-globals-plugin`） | 386 kB |
| + Angular 包顶层初始化调用标记为纯（`pure-annotations-plugin`） | **285 kB** |
| 官方构建（参考） | 265 kB（main + 共享 chunk） |

剩余差距主要来自官方 CLI 的额外 Babel 优化（如静态类成员包裹为纯 IIFE、TypeScript 枚举调整）
以及 esbuild 与 terser 压缩策略差异。首版按规格只使用保守的纯函数标记，不追求完全一致。
