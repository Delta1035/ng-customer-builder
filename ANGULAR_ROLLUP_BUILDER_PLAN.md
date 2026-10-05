# Angular 自定义 Rollup 构建器实施方案与交接清单

日期：2026-10-05。交接对象：Claude。状态：设计与遗漏审查已完成，尚未实现或验证代码。

## 1. 目标与执行边界

实现可被 Angular CLI 调用的自定义 build 和 dev-server Builder：应用使用 Angular AOT 编译及 Rollup 打包；开发服务由自有 HTTP 服务提供，取代当前应用构建链中的 esbuild 和 Vite。

本方案是独立交接文档。目标目录存在多个子项目，尚未指定要改造哪一个，因此未对任何子项目作兼容性结论。实施时先检查实际仓库、AGENTS.md、package.json、锁文件、angular.json 和 tsconfig，再决定版本与路径。不要自动修改目录下所有项目。

默认实施策略：在选定仓库增加独立构建器包和示例应用；保留已有 build/serve，以 build-rollup/serve-rollup 并行验证。全部验收通过后再迁移默认目标。

“替代”指实际编译、打包和开发服务链路不调用 esbuild、Vite 或官方 application/dev-server Builder。原仓库保留它们作为对照或测试工具的间接依赖，不等于替代失败。若要求依赖树完全不含它们，另行审计测试工具与传递依赖，不在首版默认范围。

## 2. 已核实的技术边界

- Architect Builder 是 CLI 任务入口，不是 Angular 编译器或 bundler。自定义 build 与 serve 可各自实现并共享内部流水线。[Angular Builder API](https://angular.dev/tools/cli/cli-builder)
- Angular 提供 ngc 及编译器配置；应用 AOT 和普通 TypeScript 转译不能混为一谈。编译器适配层须依照锁定版本的实际导出与类型实现。[编译器选项](https://angular.dev/reference/configs/angular-compiler-options)
- 消费 partial-Ivy Angular 库需要 Linker，可通过 @angular/compiler-cli/linker/babel 接入。不能把所有 node_modules 排除在处理范围外。[Linker 文档](https://angular.dev/tools/libraries/creating-libraries#consuming-partial-ivy-code-outside-the-angular-cli)
- Rollup 提供打包、插件和 watch API；开发 HTTP 服务、浏览器刷新与 Angular HMR 需要另外组合实现。[Rollup API](https://rollupjs.org/javascript-api/)
- 官方列出的社区自定义构建方案包含 Vite 与 Rspack 集成。这些可作为设计参考，不代表存在官方支持的纯 Rollup 即插即用适配器，也不能直接用 Vite 插件冒充纯 Rollup 方案。[自定义构建流水线](https://angular.dev/ecosystem/custom-build-pipeline)

以下架构、接口和验收项是本项目的设计要求，不是对 Angular 官方 Builder 功能的完整复刻声明。

## 3. 实施前盘点与版本策略（P0）

先输出一份基线记录，至少包含：

| 项目 | 要记录的内容 |
| --- | --- |
| 版本 | Angular core/compiler/compiler-cli、CLI/DevKit、Node、TypeScript、RxJS、Rollup、包管理器及锁文件 |
| 构建配置 | build/serve targets、命名配置、文件替换、入口、样式、脚本、资源、部署路径 |
| 应用特性 | standalone/NgModule、路由、@defer、zone/zoneless、国际化、SSR、Worker、Service Worker |
| 依赖 | partial-Ivy 库、CommonJS、TS paths、工作区库、链接包、特殊包 exports |
| 工程环境 | Windows/Linux、路径含空格或中文、浏览器目标、现有 CI 与测试 |
| 对照数据 | 官方构建能否成功；启动、构建、常见重建耗时；原始与 gzip 产物大小 |

采用实际项目版本，不为了套用示例升级 Angular。按照官方矩阵匹配 Node、TS 与 RxJS；Angular 编译器和运行时保持匹配。不要假定 DevKit Architect 的版本号与 Angular major 字面相同。依赖范围以实际验证为准，不使用星号 peerDependencies。[版本矩阵](https://angular.dev/reference/versions)、[Angular 包格式](https://angular.dev/tools/libraries/angular-package-format)

优先使用导出的 API；不得从 @angular/build 的私有目录直接搬用 esbuild/Vite 适配器。确实需要版本相关编译器接口时，隔离到 adapter，注明风险、版本范围与替换点，并建立契约测试。

## 4. 首版能力范围

### 必须交付

- 浏览器端 CSR 应用；dev/prod 均采用 AOT。
- standalone 示例；既有应用为 NgModule 时增加对应验收。
- TS 和模板诊断；第三方 partial-Ivy 库链接；静态与动态 import。
- 路由懒加载；目标 Angular 版本存在 @defer 时验证延迟块加载。
- 外部及内联模板、组件 CSS、全局 CSS、静态资源、index.html。
- development/production 配置、Source Map、基础文件替换、baseHref、polyfills。
- 自有开发服务器、SPA fallback、文件监听、整页刷新、失败后修复恢复。
- 构建器包安装测试、真实浏览器测试、Windows 路径验证。

### 由现有项目决定是否提升为首版阻断项

- SCSS/Sass、PostCSS/Tailwind、全局脚本、JSON 导入、CommonJS、TS paths、链接库、代理、HTTPS。
- 只要目标应用已使用其中某项，就必须实现或明确报告迁移受阻，不能忽略后宣称该应用已兼容。

### 独立后续阶段

- Angular 组件 HMR、CSS 热替换、跨启动持久缓存。
- SSR/预渲染/水合、i18n 提取与多语言构建、Web Worker、Service Worker/PWA。
- Module Federation、CSP nonce/SRI 自动处理、完整 CLI budgets 与 license 提取兼容、CDN 独立资源前缀。

后续能力不得以静默跳过方式处理：拒绝不支持的相关配置，或者在兼容性报告中明确列为阻断项。首版不是官方 application Builder 的完全等价替代品。

## 5. 架构与目录建议

```text
Angular CLI / Architect
  ├─ build Builder ─────────────┐
  └─ dev-server Builder ────────┤
                              ↓
                       配置归一化与校验
                              ↓
                  共享 BuildSession / 调度器
                   ├─ Angular AOT + 资源处理
                   ├─ partial-Ivy Linker
                   ├─ Rollup 模块图与打包
                   └─ HTML/CSS/assets 产物整理
                              ↓
                    完整成功的构建 generation
                     ├─ 生产输出目录
                     └─ 开发服务 + 刷新通知
```

```text
packages/angular-rollup-builder/
  package.json
  builders.json
  src/build/{index.ts,schema.json}
  src/dev-server/{index.ts,schema.json}
  src/config/                 # 解析、归一化、约束
  src/compiler/               # Angular API 适配、诊断、依赖图
  src/rollup/                 # Linker、模块解析、输出配置
  src/resources/              # 样式、HTML、assets
  src/session/                # 编译调度、缓存、构建代次
  src/server/                 # HTTP、通知客户端、fallback
  test/                      # Architect 与打包安装测试
fixtures/basic-app/
fixtures/partial-ivy-library/
e2e/
docs/{compatibility.md,benchmarks.md}
```

目录和包名可顺应现有仓库调整。两个 Builder 共享同一个核心，不维护两套 dev/prod 编译逻辑。开发服务通过内部 BuildSession API 消费构建事件，避免依赖官方 Builder 的内部输出格式。

## 6. Angular 编译适配

### 6.1 分两步实现

第一步 PoC：ngc 输出到专用中间目录，再由 Rollup 打包。先限定普通 CSS 和可控示例，验证 AOT、Linker、路由与资源链路。CLI 调用必须使用项目依赖，跨平台启动不能依赖全局 ngc。

第二步工程化：根据实测决定继续维护有序的分阶段构建，或通过编译器 API 管理 Program、增量状态和内存输出。两者都允许，先保证正确性。不得把单文件 TS transpile 或简单 Rollup transform 当作完整 Angular AOT 集成。

### 6.2 编译要求

- 读取 tsconfig extends、compilerOptions、angularCompilerOptions；处理配置错误和 TS/Angular 诊断，保留源码文件、行列与消息。
- 应用输出完整 AOT；分发的测试 Angular 库采用 partial 编译，以便真实覆盖 Linker。
- 建立 TS → 外部 HTML、样式及其传递依赖关系；模板或样式变化必须使所属组件失效。
- 样式预处理发生在 Angular 消费组件样式的正确阶段；不能把 SCSS 原文当作 CSS 塞进组件。
- 保留 Angular 自身的样式封装语义；全局 CSS 与组件 CSS 分开处理。
- 编译结果保留动态 import，以便 Rollup 拆包；诊断失败不得发布新产物。
- 若编译发射路径影响相对 import、baseUrl/paths、资源 URL，建立显式源码到输出的映射，不靠猜测字符串替换。
- 新增、删除、重命名文件及 tsconfig/include 改动需要重建正确的程序图，并清除过期中间输出。

### 6.3 文件替换一致性

fileReplacements 必须同时作用于 Angular 类型检查/编译与 Rollup 模块解析。只在 Rollup resolveId 替换可能造成模板检查使用旧定义、最终包使用新实现。路径归一化与替换映射纳入缓存键，并用含类型差异的 fixture 验证。

## 7. Linker 与模块解析

- 通过 Babel 接入 Angular Linker；覆盖需要处理的 .js/.mjs 依赖，保留 Source Map 链。
- 优化 Linker 扫描范围可以后做；先保证 partial-Ivy 不会漏处理，也不会让产物依赖浏览器 JIT 补救。
- 缓存键至少覆盖文件内容、Angular/Linker/Babel 版本、Linker 选项与构建模式。
- 解析 npm package exports、browser 条件、ESM/CommonJS，并验证插件顺序；不得把 Node 专用入口错误引入浏览器。
- TS paths 必须与编译器解析保持一致；区分指向库源码与已构建库的情况，不宣称两者自动等价。
- 链接包与符号链接须避免出现两份 Angular runtime，并纳入监听。
- 普通浏览器应用默认把 Angular 运行时打入包；除非明确设计了 import map/CDN 加载，不将 @angular/* 一律 external。
- 不全局设置 moduleSideEffects: false；避免删除 polyfills、全局样式、初始化脚本等副作用。

Rollup 插件可使用 node-resolve、commonjs、babel 等组件，具体版本与配置由 P0 验证。[Rollup 插件钩子](https://rollupjs.org/plugin-development/)

## 8. 资源与生产产物

### 8.1 输出契约

首版 outputPath 表示最终浏览器产物目录，不自动追加 browser；此差异要写入迁移说明。

- ESM 输出到目录，保留动态 chunk；生产入口/chunk/资源采用内容哈希。
- 根据 Rollup 实际输出 manifest 生成 HTML 引用，禁止硬编码猜测哈希文件名。
- polyfills 的执行顺序先于应用；zone.js 是否加载由应用配置决定，不强行破坏 zoneless 应用。
- 处理 CSS 的相对 url()、@import、字体/图片输出；保留 data:、远程 URL 和片段语义。
- assets 首版可采用目录整体复制，例如 public/ → outputPath；如需官方复杂 glob 配置，再实现对应 schema。
- baseHref 至少验证 / 与 /demo/；明确 HTML、路由、懒加载块和资源在子路径部署的行为。独立 CDN 前缀是另一个能力。
- 合并 Source Map 时保留到原 TS/模板可定位的信息；至少验证 TS 断点及报错堆栈。
- 从源 index.html 保留业务 meta、已有必要脚本与 CSP 设置，新增引用避免重复，不用脆弱正则重写整个文档。

### 8.2 生产模式

optimization 至少包括压缩及与锁定 Angular 版本一致的开发模式处理。验证生产运行时状态，而非仅根据文件变小推断成功。必要时评估显式 enableProdMode 或适当的编译期定义，记录选择；不要不加判断地把所有 ng* 标识符替换为 false。[enableProdMode](https://angular.dev/api/core/enableProdMode)

Rollup 本身不提供通用目标语法降级与全套 Web 平台 polyfills；根据浏览器范围配置 TS/Babel/CSS 处理，确保依赖代码也适配。不要把 Rollup 的输出包装语法配置误认为整个应用的浏览器兼容转换。[Rollup 输出配置](https://rollupjs.org/configuration-options/)

首版用已有副作用与纯函数标记进行保守 tree-shaking；产物可能比官方构建大，这应以基线比较量化，不承诺未经验证的性能收益。

### 8.3 文件系统行为

- 中间目录、最终输出、缓存各自隔离，并按项目/配置区分；并发 dev/prod 不互相覆盖。
- 新 generation 完整成功后才作为可访问产物；开发服务可保留最后成功版本，但必须明确显示最新编译错误。
- 首次构建失败时提供错误页或 503，不能把未知旧目录当作成功结果。
- 清理前校验绝对路径与允许的输出根，拒绝工作区根、源码目录、盘符根；清理不得跟随越界符号链接。
- 兼顾 Windows 文件占用与重命名失败；回收过期 generation，不能无限积累，也不能使仍被页面引用的 chunk 立即消失。

## 9. 开发服务、watch 与生命周期

### 9.1 最小服务能力

- 默认仅监听 localhost；port 明确且占用时报出可操作错误。
- 提供 JS/CSS/图片/字体正确 MIME；禁止通过目录穿越读取输出根之外的源码或凭据。
- SPA fallback 只处理合适的页面导航；缺失 .js/.css 返回 404，API 不返回 index.html。
- SSE 或 WebSocket 推送 build-start/build-success/build-error，只有完整成功后触发整页刷新。
- 客户端断线重连；通知 URL 和页面部署子路径兼容。开发客户端只注入开发 HTML。
- 错误至少输出终端；浏览器可显示编译错误页或轻量 overlay，错误文本按文本渲染。
- 首版 hmr 不支持，明确拒绝 hmr: true，不能把整页刷新称为 HMR。

### 9.2 构建调度

单个 BuildSession 串行提交构建；快速连续修改合并为 pending change set。允许当前构建结束后处理下一批，或取消旧任务，但过期 generation 不得覆盖较新成功结果。

ngc 和 Rollup 不可两个互不协调的 watcher 同时读写中间目录。所有阶段通过明确的成功事件衔接。资源依赖可注册至 Rollup watch 图或统一 watcher，避免同一变化触发两个独立流水线。

区分：源码/模板变化、资源变化、配置变化、锁文件/依赖变化。配置变化可以明确要求重启，或实现完整重初始化；禁止声称自动生效却复用错误缓存。

### 9.3 Architect 生命周期

- build 单次执行成功/失败后结束；watch/serve 持续发出 BuilderOutput，修改出错后继续监听。
- 区分可恢复编译错误与无法启动的配置/端口错误。
- Ctrl+C、取消订阅和任务 stop 都清理 Rollup bundle/watcher、HTTP server、客户端连接和子进程；清理幂等。
- 不能照搬前例 await run.result 后立即 stop 的单次任务实现作为开发服务。
- 若 serve 使用 buildTarget，必须读取并校验对应目标的配置、Builder 身份及 overrides，避免递归调用自身；限定为本包 build Builder。

## 10. Builder 配置契约与接入

建议首版 build schema 支持以下字段，未知字段报错，细节写入 README：

| 字段 | 类型 | 语义 |
| --- | --- | --- |
| browser | string，必填 | 工作区相对应用入口 |
| tsConfig | string，必填 | 工作区相对应用编译配置 |
| index | string，必填 | HTML 模板 |
| outputPath | string，必填 | 最终浏览器产物目录 |
| styles | string[]，默认 [] | 有序全局样式 |
| assets | string[]，默认 [] | 复制其内容到输出根的资源目录；冲突报错 |
| polyfills | string[]，默认 [] | 有序模块说明符或明确的工作区相对文件路径 |
| baseHref | string，默认 / | 基础部署路径 |
| fileReplacements | {replace, with}[] | 编译与打包共同应用的替换 |
| optimization | boolean，默认 false | 生产优化开关 |
| sourceMap | boolean，默认 true | 首版仅 boolean，不冒充官方复杂对象支持 |
| watch | boolean，默认 false | 持续构建；serve 强制使用持续模式 |

serve schema：buildTarget（必填）、host（localhost）、port（4200）、liveReload（true）。代理、HTTPS 等按第 4 节提升并扩展 schema。CLI 名称映射、配置覆盖顺序通过 Architect 集成测试验证。

迁移验证阶段，将以下目标片段合并到 projects.<项目名>.architect。my-app 为占位项目名；以下配置是待实现接口，不是现成工具。

```json
{
  "build-rollup": {
    "builder": "@your-org/angular-rollup-builder:build",
    "options": {
      "browser": "src/main.ts",
      "tsConfig": "tsconfig.app.json",
      "index": "src/index.html",
      "outputPath": "dist/my-app-rollup",
      "styles": ["src/styles.css"],
      "assets": ["public"],
      "baseHref": "/"
    },
    "configurations": {
      "development": {"optimization": false, "sourceMap": true},
      "production": {"optimization": true, "sourceMap": false}
    },
    "defaultConfiguration": "production"
  },
  "serve-rollup": {
    "builder": "@your-org/angular-rollup-builder:dev-server",
    "configurations": {
      "development": {"buildTarget": "my-app:build-rollup:development"},
      "production": {"buildTarget": "my-app:build-rollup:production"}
    },
    "defaultConfiguration": "development",
    "options": {"host": "localhost", "port": 4200, "liveReload": true}
  }
}
```

```bash
ng run my-app:build-rollup:production
ng run my-app:build-rollup:development
ng run my-app:serve-rollup:development
```

资源不存在时调整示例，polyfills 根据应用补充。production serve 只用于本地验证，不作为部署服务器。迁移为 build/serve 后，才使用常规 ng build/ng serve，并同步修改 buildTarget 引用。

## 11. 打包与可安装性

- package.json 的 builders 字段、builders.json 的 implementation/schema 指向发布包内真实文件。
- 构建本包时复制 schema；不得只在源码工作区能跑，发布包缺配置文件。
- 明确 Node ESM/CJS 策略，验证 Architect 实际加载方式；需要加载 ESM 依赖时采用兼容方案，不假定 require 可加载所有依赖。
- Angular 编译相关 peer 依赖由消费工作区提供兼容版本；内部实现依赖按实际归属声明，不能依赖偶然 hoist。
- 通过 npm pack 或包管理器等效方式生成压缩包，在干净 fixture 安装后运行两个 Builder。
- 保留包管理器锁文件，不混用 npm/pnpm/yarn 生成多个竞争锁文件。

## 12. 分阶段交付与停止条件

| 阶段 | 交付 | 通过条件 |
| --- | --- | --- |
| P0 盘点 | 版本/特性矩阵、接口适配调查、基线 | 选定实际目标与版本，现有问题单独记录 |
| P1 编译 PoC | ngc → Linker → Rollup → HTML | 浏览器启动、DI、模板绑定、partial 库及懒路由正常 |
| P2 build Builder | schema、资源、dev/prod、安装包 | 从干净安装运行构建；错误退出码、子路径部署正确 |
| P3 dev-server | watch、HTTP、刷新、错误恢复 | TS/HTML/CSS/资源修改生效；首次失败及后续恢复通过 |
| P4 迁移验收 | 测试报告、兼容性说明、性能比较、迁移说明 | 必需特性全通过，无静默回退，才替换原默认目标 |
| P5 增强 | HMR/SSR 等独立工作项 | 各自单独定义并通过验收，不阻塞已限定的 CSR 首版 |

阶段受阻时提交可复現命令、诊断和未完成项；不得用运行时 JIT、官方 Builder 或 Vite 回退来掩盖 AOT/Rollup 链路缺失。

## 13. 验收用例矩阵

测试关注运行行为和失败恢复，不能只断言配置对象或 mock 函数被调用。使用真实 Angular fixture、真实 Architect 调度、真实浏览器；已有测试框架能用就复用。

| 编号 | 用例 | 预期 |
| --- | --- | --- |
| A01 | 干净安装后 prod 构建 | 成功输出，可由普通静态服务器访问 |
| A02 | TS 错误、模板类型错误 | 单次构建失败退出，定位到源码，无新成功产物 |
| A03 | 引用自建 partial-Ivy 库与典型第三方库 | 浏览器运行正常，无需要 JIT 补救的错误 |
| A04 | standalone 启动、DI、事件与表单/信号更新 | 页面状态正确；已有 NgModule 项目另测 |
| A05 | 路由懒加载、直接打开深层路由 | chunk 可加载，导航 fallback 正确 |
| A06 | @defer（版本支持时） | 触发条件后正确加载，验证实际输出行为 |
| A07 | 修改外部 HTML、内联模板、组件 CSS | 重建后页面更新，无仅 TS 变化才生效的问题 |
| A08 | 全局 CSS、图片、字体；修改/删除资源 | URL 有效，删除资源不被旧文件长期掩盖 |
| A09 | SCSS 传递 import（项目使用时） | 依赖变动触发正确组件重建 |
| A10 | baseHref=/demo/ | 入口、刷新、路由、chunk、资源、通知连接均正常 |
| A11 | dev/prod 文件替换含类型与值变化 | 编译检查与浏览器实际值使用同一替换 |
| A12 | dev Source Map | 浏览器断点/堆栈能定位到源 TS |
| A13 | prod 模式与 polyfills | Angular 生产状态正确；zone/zoneless 按配置启动 |
| A14 | 首次编译失败 → 修复 | 开发服务可恢复，不必手工重启 |
| A15 | 正常运行 → 编译失败 → 修复 | 错误可见；最后成功版本策略一致；修复后更新 |
| A16 | 快速连续保存、新增/删除/重命名文件 | 最新代码生效，无旧构建覆盖、无过期模块残留 |
| A17 | Ctrl+C、取消、端口冲突 | 资源释放、错误明确，下次启动可复用端口 |
| A18 | 缺失 JS 请求、API 请求、越界路径 | 不返回 SPA HTML；无输出根之外文件泄露 |
| A19 | 空格/中文路径、Windows 分隔符、链接包 | 路径解析正确，不出现重复 Angular runtime |
| A20 | dev/prod 并发构建 | 中间与最终产物不互相污染 |
| A21 | 缓存启用/禁用及配置变化 | 页面与产物语义一致，失效或重启策略明确 |
| A22 | npm pack 后干净 fixture 安装 | schema、实现文件和运行时依赖齐全 |
| A23 | 不支持的官方配置或功能 | 明确拒绝或列出阻断项，不假装已支持 |
| A24 | 与官方构建对照 | 核心浏览器行为一致；体积和耗时差异有记录 |

持久缓存未交付时 A21 只覆盖已有内存/编译缓存，不额外承诺跨启动缓存。Windows 是当前环境必验项；Linux CI 在可用环境执行并说明未验证范围。性能记录区分冷启动与热重建，并注明机器、版本、缓存状态及测量方法，不设置未经讨论的绝对毫秒承诺。

## 14. 遗漏审查结论

原讨论已覆盖 Builder、AOT、Linker、Rollup、开发服务的主要分层，但尚不足以直接实施。本次新增并纳入上文的要点如下：

| 原先未展开的点 | 可能后果 | 本文对应 |
| --- | --- | --- |
| 目标仓库与版本未锁定 | API/依赖不兼容，误改项目 | 1、3 |
| 首版与完整 CLI 等价未区分 | 实施范围无限扩大或虚报完成 | 4、12 |
| 编译器宿主、外部资源与程序图 | 模板样式更新丢失 | 6 |
| 文件替换跨阶段一致性 | 类型检查与运行代码不一致 | 6.3 |
| Linker 缓存、依赖范围与解析条件 | 库运行失败或加载 Node 入口 | 7 |
| 生产模式、目标浏览器、polyfills | 看似打包成功但行为错误 | 8 |
| HTML/资源 URL 与子路径部署 | 本地正常，部署白屏 | 8、13 |
| 原子发布、旧 generation 与错误恢复 | 半成品、旧包覆盖新包 | 8.3、9 |
| watcher 协作与 teardown | 死锁、重复构建、端口残留 | 9 |
| 自定义 schema 与官方选项边界 | 配置被静默忽略 | 10 |
| Builder 发布包与 ESM/CJS | 本地可跑、安装后失败 | 11 |
| 真浏览器与安装级验收 | 测试全绿但应用不能启动 | 13 |
| 性能与兼容性维护责任 | 未证实的速度承诺、升级失效 | 3、12、13 |

仍需从实际仓库确定的事项：具体 Angular 版本、目标子项目、包管理器、浏览器范围、应用必需扩展特性。文档给出了默认推进方式，但这些不能替代仓库盘点。尤其不能提前承诺 Angular Material、SSR、i18n 或全部 CLI 参数兼容。

## 15. 给 Claude 的执行指令

请以本文件为实施规格，先完成 P0，再依次完成 P1–P4。当前文件是设计，所有代码和验收仍待实施。

1. 阅读目标仓库指令并检查已有改动；先确定目标项目。若目录下只有一个明确匹配的 Angular 工作区，可记录依据后推进；多个候选且无法判断时再询问用户。
2. 给出版本与必需特性矩阵，然后实现最小真实浏览器闭环。复用现有工具，避免启动时就重写整个 Angular CLI。
3. 开发和生产共享核心。不要仅包装官方 application Builder，不要引入 Vite 来实现本任务的 dev-server，也不要把 Rollup 换成 Rolldown 后宣称符合本规格。
4. 以 build-rollup/serve-rollup 并行接入，保留原目标用于行为与性能对照。完成阶段验收再迁移默认目标。
5. 遇到编译器接口问题，检查锁定版本的导出、类型和官方源码；不要编造通用稳定 API，也不要依赖不受控的深层私有导入。
6. 每个阶段记录实现、验证命令、结果和剩余限制。测试失败时给出可复现材料；没有执行的测试标记未执行。
7. 最终提交构建器源码、示例/测试、可安装包验证、README、兼容性表、性能对照、迁移及回退说明。
8. 尚未支持的高级能力保留为明确任务，不把待办标成完成。实现中如需缩小首版必需范围，先说明具体阻断与影响。

完成定义：一个符合声明能力范围的真实 Angular 应用，通过两个自定义 Builder 完成 AOT/Rollup 生产构建和自有开发服务；必需验收通过、限制可见、无静默回退，并能从干净安装复现。
