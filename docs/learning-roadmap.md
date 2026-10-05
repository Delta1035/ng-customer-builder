# 学习路线图

本路线图以这个仓库为教材，目标是让你能**独立读懂、修改、扩展**一个 Angular 自定义构建器，
并把其中的思路迁移到其它构建工具上（Vite 插件、webpack loader、esbuild 插件等）。

- 配套文档：[architecture.md](architecture.md) 讲「为什么这样设计」，本文讲「按什么顺序学、怎么练」。
- 时间是参考值，按每天 1–2 小时估算。可以跳过已经熟悉的阶段，但建议每个阶段末尾的自测都做一遍。

```text
阶段 0 准备（半天）
  └─ 阶段 1 把它跑起来，观察现象（1 天）
       └─ 阶段 2 Builder 与配置：入口在哪里（1–2 天）
            └─ 阶段 3 Angular AOT 编译：最核心的一环（3–4 天）
                 └─ 阶段 4 Rollup 与 Linker：打包与体积（3–4 天）
                      └─ 阶段 5 资源：CSS / HTML / 静态文件（1–2 天）
                           └─ 阶段 6 watch 与增量：状态管理的难点（2–3 天）
                                └─ 阶段 7 开发服务器与生命周期（2 天）
                                     └─ 阶段 8 测试、发布与工程化（2 天）
                                          └─ 阶段 9 毕业项目：独立扩展一个能力（1–2 周）
```

---

## 阶段 0：准备

**前置知识自查**（不熟悉的先补，后面会顺很多）：

| 知识点 | 够用的标准 |
| --- | --- |
| TypeScript | 能读懂泛型、类型导入、`tsconfig` 的 `paths/module/target` |
| ES 模块 | 知道静态 `import` 与动态 `import()` 的区别，知道 CommonJS 与 ESM 不能随意互相 `require` |
| Node.js | `fs`、`path`、`http`、`async/await`、async generator（`async function*`） |
| Angular 使用 | 写过组件、路由懒加载、依赖注入；知道 `@Component` 装饰器 |
| 构建工具常识 | 知道「打包」「tree-shaking」「Source Map」「内容哈希」大致是什么 |

**环境**：`npm install && npm run prepare:all`，确认 `npm run test:unit` 通过。

---

## 阶段 1：把它跑起来，先观察现象

**目标**：在读任何源码之前，先知道它「对外表现」是什么样的。

**动手**：

1. 分别运行 `npm run build:rollup` 和 `npm run build:official`，对比 `dist/basic-app-rollup` 与 `dist/basic-app-official/browser`：
   文件名、文件数量、`index.html` 被插入了什么。
2. `npm run build:rollup:dev`，打开 `dist/basic-app-rollup/main.js`（未压缩），搜索 `ɵɵdefineComponent`、`App_Template`，
   看你写的模板最终变成了什么样的 JavaScript。
3. `npm run serve:rollup`，打开 http://localhost:4300/，然后：
   - 改 `fixtures/basic-app/src/app/app.html` 的标题 → 观察页面自动刷新；
   - 在 `app.ts` 里制造一个类型错误 → 观察终端输出和页面上的错误浮层；
   - 修复错误 → 观察自动恢复；
   - 浏览器开发者工具 Network 面板里找到 `__ng-rollup/events`，看推送了什么消息。

**自测**：

- 生产构建和开发构建的产物有哪 3 处明显不同？
- 页面是怎么知道「该刷新了」的？

---

## 阶段 2：Builder 与配置——入口在哪里

**目标**：理解 Angular CLI 如何找到并调用我们的代码，以及「配置」是如何变成内部参数的。

**阅读**（按顺序）：

1. `angular.json` 中的 `build-rollup` / `serve-rollup`
2. `packages/angular-rollup-builder/package.json` 的 `builders` 字段 → `builders.json`
3. `src/build/index.ts`、`src/dev-server/index.ts`
4. `src/build/schema.json` ↔ `src/config/options.ts`
5. `src/config/normalize.ts`、`src/config/output-path-safety.ts`
6. `src/architect/builder-utils.ts`

**关键概念**：Architect 只是任务调度器；schema 负责校验与默认值；`additionalProperties: false` 让未知选项报错；
「原始选项 → 归一化选项」把路径、默认值、分类问题一次解决，核心模块不再关心。

**动手**：

1. 在 `angular.json` 的 `build-rollup.options` 里加一个不存在的字段，运行构建，看报错来自哪里（schema 还是我们的代码？）。
2. 把 `outputPath` 改成 `"fixtures"`，看 `assertSafeOutputPath` 的拒绝理由。改回来。
3. **练习**：给 build 增加一个 `verbose: boolean` 选项，为 `true` 时打印归一化后的选项。
   需要改哪几个文件？（答案：`schema.json`、`options.ts`、`normalize.ts`、`build/index.ts`）

**自测**：

- 为什么 dev-server 要检查 `buildTarget` 使用的 Builder 名称？
- 为什么核心模块使用自定义的 `Logger` 接口，而不是直接用 `context.logger`？

---

## 阶段 3：Angular AOT 编译（重点）

**目标**：理解「AOT 编译」到底做了什么，以及如何用 compiler-cli 的 API 驱动它。这是整个项目最有价值的部分。

**阅读**：

1. `src/compiler/compiler-cli-api.ts` —— 先看「我们用到了哪些 API」
2. `src/compiler/angular-compilation.ts` 的 `compile()` —— 主流程只有 50 行
3. `src/compiler/compiler-host.ts` —— 每个被覆盖的宿主方法
4. 对照阅读 [architecture.md](architecture.md) 3.2–3.5

**关键概念**：

| 概念 | 一句话 |
| --- | --- |
| Program | TypeScript 对「整个项目」的语义模型，类型检查的基础 |
| CompilerHost | 编译器读写文件的唯一通道，也是我们插入能力的地方 |
| `loadNgStructureAsync` | Angular 分析所有组件、读取模板和样式的阶段 |
| oldProgram | 增量编译的关键：复用上一次的分析结果 |
| emit | 把分析结果输出成 JS；增量模式下未变化的文件会被跳过 |

**动手**：

1. 在 `recordEmit` 里临时加一行 `console.log(sourceFile)`，开发构建一次，看哪些文件被输出了。
   再在 serve 模式下改一个模板，看第二次构建输出了哪些文件（体会增量 emit）。
2. 对比 `fixtures/basic-app/src/app/app.ts` 与它的编译结果（`dist/basic-app-rollup/main.js` 中 `class App`）：
   找到 `ɵfac`、`ɵcmp`、`App_Template` 函数，理解装饰器去哪了。
3. 对比 partial 编译：看 `fixtures/partial-ivy-library/dist/greeting-card.js` 中的 `ɵɵngDeclareComponent`，
   与应用代码的 `ɵɵdefineComponent` 有什么不同。
4. **实验**：在 `applyCompilerOverrides` 里把 `compilationMode` 改成 `'partial'`，构建后在浏览器运行，观察报错。理解为什么应用必须 full 编译。改回来。
5. **实验**：把 `customizeCompilerHost` 中的文件替换逻辑注释掉，重新 `npm run build:builder` 后运行 `node --test --test-name-pattern="A11" e2e/build.e2e.test.mjs`，看哪个断言失败，并解释原因。

**自测**：

- 为什么 `emitted` 这个 Map 必须跨构建保留？什么时候要删除其中的条目？
- 为什么文件替换要在 CompilerHost 里做，而不是在 Rollup 的 `resolveId` 里做？
- `performCompilation` 更简单，为什么没有用它？（提示：异步 `transformResource`）
- 分析阶段失败时，为什么「已修改资源」集合不能清空？

**延伸阅读**：Angular 官方 [Compiler options](https://angular.dev/reference/configs/angular-compiler-options)；
`node_modules/@angular/compiler-cli/src/transformers/api.d.ts`（宿主接口的权威定义）。

---

## 阶段 4：Rollup 与 Linker——打包与体积

**目标**：掌握 Rollup 插件模型，理解 Linker 的作用，并通过「体积优化」理解 tree-shaking 的真实工作方式。

**阅读**：

1. `src/rollup/bundler.ts`（重点看插件顺序和注释）
2. `src/rollup/angular-plugin.ts` —— 最小的 `resolveId` + `load` 插件，适合作为 Rollup 插件入门
3. `src/rollup/polyfills-plugin.ts` —— 虚拟模块（`\0` 前缀）
4. `src/rollup/linker-plugin.ts` —— `transform` 钩子 + Babel
5. `src/rollup/define-globals-plugin.ts`、`src/rollup/pure-annotations-plugin.ts` —— 基于 AST 的代码改写
6. [architecture.md](architecture.md) 3.7「一个 tree-shaking 的故事」

**关键概念**：`resolveId → load → transform` 的钩子顺序；虚拟模块；副作用与 `/*@__PURE__*/`；
为什么常量替换必须发生在 tree-shaking **之前**。

**动手**：

1. **复现体积问题**：在 `bundler.ts` 里暂时移除 `defineGlobalsPlugin` 和 `angularPureAnnotationsPlugin`，
   运行生产构建，记录 `main-*.js` 大小；逐个加回，记录变化（应接近 392 → 386 → 285 kB）。
2. **写一个分析脚本**：用 Rollup API 打包，遍历 `chunk.modules`，按 `renderedLength` 输出前 10 个模块。
   （architecture.md「调试技巧」一节有思路）
3. **实验 Linker**：在 `linker-plugin.ts` 里让 `transform` 直接返回 `null`，开发构建并在浏览器打开，
   阅读报错信息，理解「partial 声明需要 JIT 编译器」意味着什么。改回来。
4. **练习（入门）**：写一个 `@rollup/plugin-json` 风格的小插件，让应用支持 `import data from './data.json'`。
   注意：TypeScript 侧也需要 `resolveJsonModule`，并思考 `angular-plugin.ts` 的 `resolveId` 会不会拦截它。
5. **练习（进阶）**：在开发模式下关闭 tree-shaking（`treeshake: !options.optimization`），
   用 `npm run benchmark` 的热重建数据对比前后差异，判断这个改动是否值得。

**自测**：

- `angular-plugin.ts` 为什么只处理「已编译 .ts 文件发出的 import」？
- `needsLinking()` 为什么能让「检查所有 node_modules 文件」变得很便宜？
- `define-globals-plugin` 为什么在遇到 `let ngDevMode = …` 时要跳过整个文件？
- 为什么 `pure-annotations-plugin` 只处理 `sideEffects: false` 的 `@angular/*` 包，而不是所有依赖？

**延伸阅读**：[Rollup 插件开发](https://rollupjs.org/plugin-development/)、
[Angular 库在 CLI 之外的使用（Linker）](https://angular.dev/tools/libraries/creating-libraries#consuming-partial-ivy-code-outside-the-angular-cli)。

---

## 阶段 5：资源——CSS、HTML、静态文件

**目标**：理解「非 JS 资源」如何进入产物，以及 URL 在不同部署路径下如何保持正确。

**阅读**：`src/resources/css-processor.ts` → `global-styles.ts` → `index-html.ts` → `assets.ts`；
`src/session/build-session.ts` 中的 `addGlobalStyles / addMediaFiles / addAssets`。

**关键概念**：`url()` 要相对「声明所在的原始文件」解析；组件样式最终以 `<style>` 注入，URL 相对 `<base href>`；
用 parse5 的源码偏移做「外科手术式」HTML 修改，而不是正则替换。

**动手**：

1. 在 `theme.css` 里加一个 `url('./assets/stripe.svg')`，构建后看输出 CSS 中的 URL，理解为什么相对的是 `theme.css` 而不是 `styles.css`。
2. 运行 `npx ng run basic-app:build-rollup:subpath`，
   查看 `dist/basic-app-rollup-demo/index.html`，再思考：如果没有 `<base href>`，懒加载 chunk 和图片会从哪里加载？
3. **练习**：给生产模式的全局 CSS 增加压缩（可用 `postcss` 生态的 `cssnano`，或自己去掉注释和空白），
   并补一个单元测试到 `test/resources.test.mjs`。

**自测**：

- 为什么全局样式的合并要构造一个「按顺序 @import 所有文件」的虚拟入口？
- 无法解析的 `@import` 为什么要报错而不是原样保留？（提示：这是一个真实踩过的坑，见 acceptance.md）

---

## 阶段 6：watch 与增量——状态管理的难点

**目标**：理解长时间运行的构建进程中，「哪些状态要保留、哪些要失效、何时失效」。这是构建工具 bug 的主要来源。

**阅读**：`src/session/watch-loop.ts` → `src/session/file-watcher.ts` → `src/session/changes.ts` →
`src/compiler/dependency-graph.ts` → `AngularCompilation.invalidate()`。

**关键概念**：

| 问题 | 本项目的解法 |
| --- | --- |
| 编辑器一次保存产生多个事件 | 去抖：安静 120 ms 后才算一批 |
| 构建中又有修改 | 事件只累积，下一轮一次取走 → 构建天然串行 |
| 样式引用的图片变了，Angular 不知道 | 反向依赖图 `ownersOf()` |
| 不同变化代价不同 | `ChangeSet` 分类：增量 / 重算 include / 重新初始化 / 要求重启 |

**动手**：

1. 在 `FileWatcher.record` 里打印事件，用编辑器保存一次文件，看收到几个事件、合并成几批。
2. 在 serve 模式下修改 `src/assets/dot.svg`，跟踪：watcher 事件 → `ownersOf` 找到 `lazy-page.css` →
   `modifiedResources` → Angular 重新处理该组件样式 → 新哈希的 URL。
3. **实验**：把 `invalidate()` 里对 `resourceGraph.ownersOf` 的调用去掉，重新 `npm run build:builder` 后运行 `node --test --test-name-pattern="A08" e2e/dev-server.e2e.test.mjs`，看失败表现。
4. **思考题**：如果把 watcher 换成「编译器自己 watch + Rollup 自己 watch」两个独立监听器，会出现哪些问题？

**自测**：

- `watchBuilds` 为什么先创建 watcher 再做初次构建？
- 为什么 `angular.json` 变化不自动生效，而 `tsconfig` 变化可以？

---

## 阶段 7：开发服务器与生命周期

**目标**：理解一个最小但正确的开发服务器需要处理哪些边界情况，以及长任务如何被正确停止。

**阅读**：`src/server/dev-server.ts`（从 `handle()` 开始）→ `src/server/live-reload-client.ts` →
`src/architect/builder-utils.ts` 的 `createAbortSignal` → `dev-server/index.ts` 的 `finally`。

**动手**：

1. 用 curl 验证请求处理顺序（服务运行时）：
   ```bash
   curl -i -H "Accept: text/html" http://localhost:4300/lazy/detail   # SPA fallback → 200
   curl -i -H "Accept: text/html" http://localhost:4300/nope.js       # 404
   curl -i -H "Accept: application/json" http://localhost:4300/api/x  # 404
   curl -N http://localhost:4300/__ng-rollup/events                   # SSE 消息流
   ```
2. 在构建出错时打开页面，再重启 serve 进程，观察页面为什么能自动刷新（`buildId` 中的服务器实例 id）。
3. **练习（推荐）**：实现 `proxyConfig` 选项，把 `/api` 转发到另一个端口。
   想清楚它在 `handle()` 中应放在哪一步（必须在 SPA fallback 之前），并补充 e2e 测试。
4. **练习（进阶）**：实现「只有 CSS 变化时不整页刷新」：服务器推送 `{status:'css-update'}`，客户端替换 `<link>` 的 `href`。

**自测**：

- 为什么开发服务器从内存服务产物后，就不存在目录穿越泄露的问题？
- 上一代产物为什么只对 JS chunk 回退，而不对图片回退？
- Architect 停止任务时，为什么需要 AbortSignal 才能及时结束 `await`？

---

## 阶段 8：测试、发布与工程化

**目标**：学会验证构建工具——它的正确性只能在真实运行中证明。

**阅读**：`e2e/helpers.mjs`（`scheduleTarget`、`createTempWorkspace`）→ 两个 e2e 文件 →
`scripts/pack-install-test.mjs` → `packages/angular-rollup-builder/scripts/build.mjs` → `src/utils/load-esm.ts`。

**关键概念**：

- 断言**可观察结果**（页面内容、HTTP 状态），而不是 mock 调用；等待用轮询，不依赖事件到达顺序；
- 临时工作区路径故意包含空格和中文，让路径问题在测试中暴露；
- `npm pack` 后在干净目录安装，才能发现「只在源码仓库里能跑」的问题（本项目就因此发现过发布包缺少 `dist/`）；
- 版本隔离：`compiler-cli-api.ts` + 契约测试，升级 Angular 时第一时间知道 API 是否变化。

**动手**：

1. 阅读 [acceptance.md](acceptance.md)「发现并修复的问题」一表，挑一个问题，故意把修复改回去，确认对应测试会失败。
2. **练习**：为 NgModule 应用补一个 fixture 和 e2e 用例（acceptance.md 中标记为未验证的项）。
3. **练习**：模拟升级：假设 `createProgram` 改名了，`loadCompilerCli` 会给出什么错误？契约测试会怎样失败？

---

## 阶段 9：毕业项目（任选其一）

完成标准：功能实现 + 单元测试 + e2e 测试 + 更新 compatibility.md，并且所有已有测试仍然通过。

| 项目 | 难度 | 会用到的阶段 | 提示 |
| --- | --- | --- | --- |
| JSON 导入 | ★ | 4 | 一个 Rollup 插件 + tsconfig |
| 代理 `/api` | ★★ | 2、7 | schema 新字段 + `handle()` 中的位置 |
| 全局 CSS 压缩 + 内容哈希的 media 复用 | ★★ | 5 | |
| SCSS 支持 | ★★★ | 3、5、6 | `readResource/transformResource` + 依赖图登记 `@use` 文件 + 全局样式 |
| 开发模式提速 | ★★★ | 4、6 | 先用 `timings` 测量，再尝试关闭 tree-shaking / 预打包 Angular |
| Linker 持久缓存 | ★★★ | 4、6 | 缓存键：文件内容 + Angular/Babel 版本 + Linker 选项 + 构建模式 |
| CSS 热替换 | ★★★ | 6、7 | 协议设计 + 客户端 |
| 组件 HMR | ★★★★ | 全部 | 先研究 Angular 官方 `_enableHmr` 相关编译选项与运行时 API，独立立项 |

---

## 学习建议

**方法**

1. **先观察再读码**：每个阶段先运行、先看现象，再去找对应代码。带着问题读，比从头读到尾效率高得多。
2. **用「破坏实验」验证理解**：注释掉一段代码，预测会发生什么，再运行测试验证。预测对了说明你真懂了；预测错了，正好是学习点。
3. **画数据流**：每读完一个阶段，自己画一遍「文件 → 哪个模块 → 变成什么」的图，和 architecture.md 第 1 节对照。
4. **小步改、常跑测试**：`npm run build:builder` 之后再跑测试（测试使用的是 `dist/` 中的编译结果）。
   单个 e2e 用例可以用 `--test-name-pattern` 过滤，例如 `node --test --test-name-pattern="A08" e2e/dev-server.e2e.test.mjs`。
5. **记录「为什么」**：自己扩展功能时，像源码注释那样写下设计理由，三个月后的你会感谢现在的你。

**常见误区**

| 误区 | 正解 |
| --- | --- |
| 「去掉类型就是编译 Angular」 | `transpileModule` 不做模板检查也不生成组件定义，不是 AOT |
| 「压缩器会帮我删掉没用的代码」 | tree-shaking 在打包阶段完成，常量必须在那之前确定 |
| 「watch 模式就是文件变了再跑一遍」 | 难点在缓存失效：漏了会用旧结果，多了会很慢 |
| 「本地能跑就行」 | 路径（空格/中文/盘符）、发布包内容、Windows 文件占用都只在特定环境下暴露 |
| 「测试只要断言函数被调用」 | 构建工具要断言真实产物和真实浏览器行为 |

**遇到问题时的排查顺序**

1. 终端里的诊断信息（文件:行:列）；
2. 开发构建的未压缩产物（`dist/basic-app-rollup/main.js`）；
3. 在 `recordEmit`、Rollup 插件钩子、`FileWatcher.record` 打日志；
4. 用 `e2e/helpers.mjs` 的 `scheduleTarget` 写一个最小复现脚本。

**推荐资料**

- Angular：[Builder API](https://angular.dev/tools/cli/cli-builder)、[编译器选项](https://angular.dev/reference/configs/angular-compiler-options)、[自定义构建流水线](https://angular.dev/ecosystem/custom-build-pipeline)、[版本兼容矩阵](https://angular.dev/reference/versions)
- Rollup：[JavaScript API](https://rollupjs.org/javascript-api/)、[插件开发](https://rollupjs.org/plugin-development/)、[配置选项](https://rollupjs.org/configuration-options/)
- 对照学习：Angular CLI 官方 `@angular/build` 源码（esbuild/Vite 实现）；社区的 Vite/Rspack Angular 集成。
  用同样的问题（AOT 怎么接入、Linker 放在哪、watch 怎么失效）去读，对比不同实现的取舍。

## 进度清单

- [ ] 阶段 1：跑通 build / serve，能说出产物中的 3 处 dev/prod 差异
- [ ] 阶段 2：完成 `verbose` 选项练习
- [ ] 阶段 3：完成 partial 编译实验与文件替换实验，回答全部自测
- [ ] 阶段 4：复现 392 → 285 kB 的体积变化；完成 JSON 插件
- [ ] 阶段 5：完成全局 CSS 压缩练习
- [ ] 阶段 6：跟踪一次 `dot.svg` 修改的完整链路
- [ ] 阶段 7：完成代理练习
- [ ] 阶段 8：完成一次「改回修复 → 测试失败」验证
- [ ] 阶段 9：完成一个毕业项目
