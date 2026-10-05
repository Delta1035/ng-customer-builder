# 实现思路与学习指南

本文解释 `@acme/angular-rollup-builder` **为什么这样设计**。建议边读边打开对应源码，
每一节都标注了文件位置。源码中的注释回答「这段代码做什么」，本文回答「为什么要这样做」。

## 0. 一句话概括

> Angular CLI 只负责调度；我们用 **@angular/compiler-cli 的公开 API** 做真正的 AOT 编译，
> 把编译结果**放在内存里**交给 **Rollup** 打包（途中用 **Angular Linker** 处理 npm 上的 Angular 库），
> 再生成 HTML/CSS/资源，得到一个**不可变的构建代次**。
> build 把代次原子地写到磁盘，dev-server 把代次原子地换上线并通知浏览器刷新。

## 1. 全景图

```text
 ng run app:build-rollup            ng run app:serve-rollup
        │                                   │
 build/index.ts                     dev-server/index.ts          ← Architect 适配层（很薄）
        │  normalizeBuildOptions()          │  读取 buildTarget，强制 watch
        └──────────────┬────────────────────┘
                       ▼
             session/build-session.ts  ← 共享核心：一次 build() = 一条完整流水线
   ┌───────────────────┼─────────────────────────────────────────┐
   │ ① compiler/angular-compilation.ts   .ts/.html/.css ──AOT──▶ 内存 JS
   │ ② rollup/bundler.ts                 内存 JS + node_modules ─▶ chunks
   │      ├ angular-plugin   读取内存中的编译结果
   │      ├ node-resolve / commonjs
   │      ├ linker-plugin    partial-Ivy ─▶ 完整定义
   │      ├ define-globals   (prod) ngDevMode → false
   │      └ pure-annotations (prod) 框架顶层调用标记为纯
   │ ③ resources/global-styles.ts + css-processor.ts   styles.css + media/*
   │ ④ resources/assets.ts                             public/** 
   │ ⑤ resources/index-html.ts                         index.html
   └───────────────────┬─────────────────────────────────────────┘
                       ▼
            BuildResult { success, generation, files: Map<路径, 内容> }
             │                                   │
  session/output-writer.ts                 server/dev-server.ts
  临时目录 → 原子替换 outputPath              内存中切换代次 → SSE 通知 → 浏览器刷新
```

watch 模式下，`session/watch-loop.ts` 用一个 `FileWatcher` 驱动同一个 `BuildSession` 反复 `build(changes)`。

## 2. 推荐阅读顺序

| 顺序 | 文件 | 读完应理解 |
| --- | --- | --- |
| 1 | `build/index.ts`、`dev-server/index.ts` | Builder 只是入口；两者共享核心 |
| 2 | `config/options.ts`、`config/normalize.ts` | 原始选项 vs 归一化选项；尽早拒绝不支持的配置 |
| 3 | `session/build-session.ts` | 五步流水线；失败时不产生任何文件 |
| 4 | `compiler/angular-compilation.ts`、`compiler/compiler-host.ts` | 如何用公开 API 做增量 AOT |
| 5 | `rollup/bundler.ts` 及各插件 | 编译结果如何进入 Rollup；Linker；生产优化 |
| 6 | `resources/*` | CSS/HTML/资源处理 |
| 7 | `session/watch-loop.ts`、`session/file-watcher.ts`、`compiler/dependency-graph.ts` | 增量与串行调度 |
| 8 | `server/dev-server.ts`、`server/live-reload-client.ts` | 开发服务器与刷新协议 |
| 9 | `utils/load-esm.ts`、`compiler/compiler-cli-api.ts` | CJS/ESM 与版本隔离 |

## 3. 关键设计决策

### 3.1 Builder 很薄，核心不依赖 Architect

`build/index.ts` 和 `dev-server/index.ts` 只做三件事：把 `BuilderContext` 转成普通参数、调用核心、把结果转成 `BuilderOutput`。
核心模块只认识 `NormalizedBuildOptions` 和一个最小 `Logger` 接口（`utils/logger.ts`）。

**好处**：核心可以脱离 Angular CLI 测试；Architect API 变化只影响两个文件；
两个 Builder 不会各自维护一套编译逻辑（规格要求「不维护两套 dev/prod 编译逻辑」）。

### 3.2 真正的 AOT：用 compiler-cli 的 Program API，而不是转译单个文件

很多「自制 Angular 打包」的尝试会对每个 `.ts` 调 `ts.transpileModule`，这只是去掉类型，**不是 AOT**：
没有模板类型检查，装饰器不会被编译成 `ɵcmp` 定义。

`compiler/angular-compilation.ts` 使用与 `ngc` 相同的公开 API：

```text
readConfiguration(tsconfig)            读取 tsconfig + angularCompilerOptions（含 extends）
createProgram({ rootNames, options, host, oldProgram })
await program.loadNgStructureAsync()   分析所有组件，读取/转换模板和样式（可异步）
defaultGatherDiagnostics(program)      TS + Angular 模板诊断，顺序与 ngc 一致
program.emit()                         通过 host.writeFile 输出 JS
```

`oldProgram` 让 TypeScript 和 Angular 都能复用上一次的分析结果（增量编译）。
注意 Angular 的增量 emit 会**跳过未变化文件**，所以内存中的编译结果 `emitted` 必须跨构建保留，
并在文件删除后显式清理（`pruneStaleOutputs`），否则已删除的模块会继续被打包。

### 3.3 CompilerHost 是编译器的「插槽」

编译器所有文件读写都经过宿主。`compiler/compiler-host.ts` 覆盖其中几个方法，就把构建器能力插进了编译过程：

| 宿主方法 | 用途 |
| --- | --- |
| `getSourceFile` / `readFile` | **文件替换** + SourceFile 缓存 |
| `readResource` | 读取 templateUrl/styleUrl，拒绝 .scss 等不支持格式 |
| `transformResource` | 组件样式处理（@import 内联、url() 改写） |
| `getModifiedResourceFiles` | 告诉 Angular 哪些 HTML/CSS 变了 |
| `writeFile` | 编译产物写入内存 |

**文件替换为什么在宿主层做？** 如果只在 Rollup 的 `resolveId` 里替换，类型检查用旧文件、打包用新文件，
两者会不一致（规格 6.3）。在宿主层替换后，编译器眼中 `environment.ts` 的内容就是 `environment.prod.ts`，
类型检查、代码生成、Rollup 加载的都是同一份结果。e2e 测试 A11 专门验证了「替换文件有额外导出」的情况。

### 3.4 编译结果放内存，而不是中间目录

规格允许两种方式。选择内存的原因：

- 没有「两个工具读写同一个中间目录」的协调问题，也没有过期中间文件需要清理；
- 并发的 dev/prod 构建天然隔离（A20）；
- Windows 上没有文件占用问题。

代价是无法直接「看」中间产物——调试时可以在 `recordEmit` 打断点，或临时把 `emitted` 写到磁盘。

### 3.5 让编译与打包使用同一套模块解析

`rollup/angular-plugin.ts` 的 `resolveId` 对「已编译的 .ts 发出的 import」调用 `ts.resolveModuleName`，
用 tsconfig 的 `paths/baseUrl/moduleResolution` 解析。这样 TypeScript 认为 `@app/x` 指向哪个文件，
Rollup 就打包哪个文件。npm 包则交给 `node-resolve`（浏览器条件、exports 字段）。

### 3.6 Linker：npm 上的 Angular 库需要「链接」

Angular 库（包括 `@angular/core`、`@angular/router` 本身）以 partial 模式发布，代码里是
`ɵɵngDeclareComponent(...)`。`rollup/linker-plugin.ts` 用 Babel + `@angular/compiler-cli/linker/babel`
把它们转成完整定义。

- 处理范围不排除 node_modules —— 需求恰恰来自 node_modules；
- `needsLinking()` 是 Linker 自带的文本预检，未命中的文件不进 Babel，所以全量检查很便宜；
- `linkerJitMode: false`：产物不能依赖浏览器 JIT 补救；
- watch 模式下 Rollup 的 `cache` 会复用链接结果。

`fixtures/partial-ivy-library` 是一个真正以 partial 模式编译的库，用来覆盖这条链路（A03）。

### 3.7 生产体积：一个 tree-shaking 的故事

第一版生产构建 `main.js` 有 **392 kB**（官方 265 kB）。排查过程很有代表性：

1. 用 Rollup 的 `output[].modules[].renderedLength` 统计各模块贡献，发现 `@angular/core` 占了 500 kB；
2. 在未压缩输出中搜索未使用的类（`DatePipe`），发现它被这段代码保留：
   ```js
   (() => { (typeof ngDevMode === "undefined" || ngDevMode) && setClassMetadata(DatePipe, …) })();
   ```
   Rollup tree-shaking 时 `ngDevMode` 是未知全局变量，这段代码被视为有副作用。terser 稍后才把它当作 false，
   但那时 tree-shaking 早已结束。→ **`rollup/define-globals-plugin.ts`**：在 Rollup 分析之前，
   基于 AST 把 `ngDevMode/ngJitMode/ngI18nClosureMode/ngServerMode` 的读取替换成常量（只替换全局读取，
   不碰属性名和赋值；文件自己声明同名变量就整体跳过）。
3. 体积只降到 386 kB。继续看，发现 JIT 指令表（`'ɵɵsetNgModuleScope': ɵɵsetNgModuleScope` …）被保留，
   源头是 `const Component = makeDecorator(...)` 这类顶层调用——Rollup 无法证明它们无副作用。
   → **`rollup/pure-annotations-plugin.ts`**：对 `sideEffects: false` 的 `@angular/*` 包，给顶层变量初始化调用
   加 `/*@__PURE__*/`（与 Angular CLI 的思路一致，范围同样保守）。
4. 结果：**285 kB / gzip 84 kB**，与官方相差 +9.8% / +3.0%（见 [benchmarks.md](benchmarks.md)）。

教训：**tree-shaking 的输入必须在 Rollup 分析之前就是「可证明无副作用」的**，压缩器做的常量折叠来得太晚。

### 3.8 资源处理：一套 CSS 逻辑，两处使用

`resources/css-processor.ts` 同时服务全局样式和组件样式：

- 内联本地 `@import`（递归、检测循环、媒体查询包进 `@media`）；
- 相对 `url()` 输出为 `media/<名字>-<内容哈希>.<扩展名>`，相对「声明所在的原始文件」解析；
- 返回 `dependencies`，供 watch 模式建立依赖图。

`url()` 改写成 `media/x` 对两类样式都正确：全局样式输出在根目录，组件样式以 `<style>` 注入文档、
相对 `<base href>` 解析，两者都落到 `<输出根>/media/x`。

全局样式的合并用了一个小技巧（`resources/global-styles.ts`）：构造一个按顺序 `@import` 所有全局样式的虚拟入口，
交给同一个 `processCss`，于是「顺序合并」不需要第二份实现。

`resources/index-html.ts` 不用正则改 HTML，而是用 parse5 拿到 `<head>`、`</body>`、`<base href>` 的**字符偏移**，
只在这些位置插入文本，模板其余部分（CSP、业务 meta、注释）原样保留。

### 3.9 构建代次与原子发布

`BuildSession.build()` 要么返回完整的文件集合，要么返回错误且文件集合为空。消费方因此永远不会看到半成品：

- **build**：`session/output-writer.ts` 先写到同级临时目录，再「旧目录改名 → 临时目录改名」，最后删除旧目录。
  Windows 上目录被占用时重试，仍失败则退化为清空后复制并给出警告。写盘前 `config/output-path-safety.ts`
  已拒绝盘符根、工作区根、包含源码的目录和符号链接。
- **dev-server**：切换代次只是替换一个对象引用。上一代保留一次，仅用于 JS chunk 回退——尚未刷新的页面
  可能还在按需加载旧 chunk；图片/样式不回退，删除的资源在下一次构建后立即 404（A08）。

### 3.10 watch：一个 watcher、串行构建、按代价分类

`session/watch-loop.ts` 是一个 async generator：

```text
初次构建 → yield → 等待下一批变化 → build(changes) → yield → …
```

- 整个系统只有一个 watcher（`session/file-watcher.ts`），编译器和 Rollup 都不自己监听，避免两条流水线互相踩踏；
- 构建期间到达的事件只累积，下一次 `next()` 时一次性取走 → **构建天然串行**，旧构建不可能覆盖新构建；
- 先启动 watcher 再做初次构建，初次构建期间的修改不会丢；
- 变化按代价分类（`session/changes.ts`）：普通文件 → 增量；新增/删除 → 重算 tsconfig include；
  `tsconfig*.json` → 丢弃编译器状态完整重建；`angular.json`/`package.json`/锁文件 → 明确提示重启。

**依赖图**（`compiler/dependency-graph.ts`）解决「Angular 不知道的传递依赖」：组件 CSS 里 `url()` 引用的 SVG 变了，
需要让该 CSS 重新处理。处理样式时登记 `owner → 依赖`，文件变化时反查 owner，把它作为「已修改资源」告诉 Angular。
一个细节：如果某次分析中途失败，已修改资源集合要保留到下一次成功分析为止，否则 Angular 会复用过期结果
（e2e 中「组件样式引用缺失资源 → 补上资源后恢复」专门覆盖了这一点）。

### 3.11 开发服务器

`server/dev-server.ts` 基于 Node `http`，产物来自内存：

- 请求路径只用于查 Map，永远不碰文件系统 → 不存在目录穿越泄露（A18）；
- SPA fallback 只给「页面导航」（`Accept` 含 `text/html` 且最后一段无扩展名），缺失的 `.js`、API 请求一律 404；
- 首次构建完成前返回 503 状态页（构建中/错误详情），不返回任何未知的旧产物（A14）；
- 通知用 SSE：服务器推送 `{status, buildId}`，客户端（`server/live-reload-client.ts`）在 `buildId` 变化时整页刷新，
  错误时用 `textContent` 显示浮层。`buildId` 包含随机的服务器实例 id，所以服务器重启后旧页面重连也会刷新；
- 首版明确拒绝 `hmr: true`，不把整页刷新称为 HMR。

### 3.12 生命周期

Architect 停止任务（Ctrl+C、取消订阅、`run.stop()`）时调用 `addTeardown` 注册的函数。
`architect/builder-utils.ts` 把它转换成标准 `AbortSignal`，watch 循环的等待会立即结束，`finally` 中关闭 watcher；
dev-server 额外注册了 `server.close()`（幂等，并调用 `closeAllConnections()` 让端口立即可复用，A17）。

为什么不能直接 `await` 某个 Promise 再退出？因为 Architect 对 async iterable 的取消是通过 `iterator.return()`，
而生成器在 `await` 中挂起时 `return()` 要排队等到下一个 `yield`——所以需要 AbortSignal 主动打断等待。

### 3.13 CJS/ESM 与版本隔离

- Architect 用 `require()` 加载 Builder（见 `node-modules-architect-host.js`），所以本包编译为 CommonJS；
- compiler-cli、Babel 8、chokidar 5、parse5 8 是纯 ESM，统一由 `utils/load-esm.ts` 动态 `import()`；
- compiler-cli 的 `.d.ts` 使用无扩展名 re-export，在 `nodenext` 下解析为空类型，
  因此 `compiler/compiler-cli-api.ts` 显式声明本工具依赖的 API 子集，并在加载时检查导出是否齐全。
  升级 Angular 时先跑契约测试（`test/rollup-plugins.test.mjs`）。

## 4. 调试技巧

- **看编译结果**：在 `AngularCompilation.recordEmit` 打断点，或临时把 `this.emitted` 写到磁盘。
- **看谁占体积**：对 `bundle.generate()` 的输出遍历 `chunk.modules`，按 `renderedLength` 排序。
- **看为什么没被 tree-shake**：用开发配置（不压缩）构建，在输出里搜索类名，看它被哪段顶层代码引用。
- **看 watch 收到什么**：在 `FileWatcher.record` 打日志。
- **用真实调度跑 Builder**：`e2e/helpers.mjs` 中的 `scheduleTarget()` 与 `ng run` 使用同一套 Architect API。

## 5. 动手扩展（练习方向）

| 想加的能力 | 从哪里入手 |
| --- | --- |
| SCSS | `compiler-host.ts` 的 `readResource/transformResource` 与 `normalize.ts` 的扩展名检查；`global-styles.ts`。依赖图要登记 `@use` 的文件 |
| 代理 `/api` | `server/dev-server.ts` 的请求处理顺序中，在 SPA fallback 之前转发 |
| 持久缓存 | Linker 结果按「内容 + 版本 + 选项」做键存盘（`linker-plugin.ts`）；Rollup `cache` 序列化 |
| 更快的开发重建 | 开发模式关闭 tree-shaking 或预打包 Angular 包；先用 `timings` 测量 |
| CSS 热替换 | 让 live-reload 协议区分「只有 CSS 变化」，客户端替换 `<link>` 而不刷新 |
