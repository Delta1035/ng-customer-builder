# 阶段交付与验收报告

日期：2026-10-05。环境见 [baseline.md](baseline.md)（Windows 11、Node 24.18、Angular 22.2.1、Edge）。

## 验证命令与最终结果

| 命令 | 结果 |
| --- | --- |
| `npm run prepare:all` | 构建器包与 partial-Ivy 库构建成功 |
| `npm run test:unit` | 21 / 21 通过 |
| `npm run test:e2e` | 20 / 20 通过（约 73 s） |
| `npm run test:pack` | 通过：干净目录安装，依赖树中无 `@angular/build`/esbuild/Vite，两个 Builder 均运行 |
| `npm run benchmark` | 已执行，结果见 [benchmarks.md](benchmarks.md) |

dev-server e2e 在最终修改前连续两次全部通过；最终版本完整执行一次全部通过。

## 阶段记录

| 阶段 | 交付 | 结果 |
| --- | --- | --- |
| P0 盘点 | [baseline.md](baseline.md)：目录现状、版本矩阵、接口事实、官方基线 | 目标目录无既有工作区 → 按默认策略新建示例与构建器 |
| P1 编译 PoC | 采用规格允许的「编译器 API + 内存产物」方案（未经过 ngc 中间目录） | 浏览器中 DI、模板绑定、partial 库、懒路由正常 |
| P2 build Builder | schema、资源、dev/prod、原子写盘、安装包 | 干净安装构建通过；错误退出码与子路径部署正确 |
| P3 dev-server | watch、HTTP、SSE 刷新、错误恢复、生命周期 | TS/HTML/CSS/资源修改生效；首次失败与运行中失败均可恢复 |
| P4 迁移验收 | 本报告、[compatibility.md](compatibility.md)、[benchmarks.md](benchmarks.md)、[migration.md](migration.md) | 示例应用以 `build-rollup/serve-rollup` 并行接入；**未替换默认 `build/serve`**（保留对照） |
| P5 增强 | 未开始 | HMR、SSR、i18n、SCSS 等保留为独立任务 |

## A01–A24

图例：✅ 自动化测试通过 · ⚠ 部分覆盖（说明见备注） · ⚪ 未执行

| 编号 | 用例 | 状态 | 测试位置 / 备注 |
| --- | --- | --- | --- |
| A01 | 干净安装后 prod 构建，普通静态服务器访问 | ✅ | `build.e2e` A01；`test:pack` |
| A02 | TS 错误、模板类型错误 | ✅ | `build.e2e` A02：真实 `ng` 进程非 0 退出、`app.ts:行:列 TS2322`、`app.html:行:列`，输出目录未被改动 |
| A03 | 自建 partial-Ivy 库与典型第三方库 | ⚠ | 自建库 + Angular 官方包（common/router/forms 均为 partial 发布）通过；未引入 Angular 之外的第三方组件库 |
| A04 | standalone 启动、DI、事件、表单、信号 | ✅ | `build.e2e` `exerciseApp`；**NgModule 应用未验证**（无此 fixture） |
| A05 | 路由懒加载、直接打开深层路由 | ✅ | 静态服务器与 dev-server 均验证 |
| A06 | `@defer` | ✅ | 交互触发后加载独立 chunk |
| A07 | 修改外部 HTML、内联模板、组件 CSS | ✅ | `dev-server.e2e` A07 |
| A08 | 全局 CSS、图片；修改/删除资源 | ✅ | `dev-server.e2e` A08/A09：删除 `public` 资源后立即 404；字体未单独测试（与图片同一路径，单元测试覆盖 `woff2` 改写） |
| A09 | SCSS 传递 import | ⚪ 不适用 | 首版拒绝 SCSS（A23 验证拒绝）；CSS 传递 `@import` 与 `url()` 依赖变化触发重建已验证 |
| A10 | `baseHref=/demo/` | ✅ | build（静态服务器）与 dev-server（入口、深层路由、chunk、资源、通知连接） |
| A11 | 文件替换含类型与值变化 | ✅ | 替换文件带额外导出：prod 类型检查通过且页面显示其值；dev 无替换时 TS2305 |
| A12 | dev Source Map | ⚠ | 验证 `main.js.map` 的 sources 指向源 `app.ts` 且含原始源码；**未在 DevTools 中实际打断点** |
| A13 | prod 模式与 polyfills；zone/zoneless | ✅ | `devMode=false`、polyfills 先于 main 执行；zoneless 与 `zone.js` 两种启动均验证 |
| A14 | 首次编译失败 → 修复 | ✅ | 503 错误页（错误文本转义）→ 修复后页面自动变为应用 |
| A15 | 运行中失败 → 修复 | ✅ | 错误浮层、最后成功版本仍可访问、修复后刷新；另含「样式引用缺失资源」恢复用例 |
| A16 | 快速连续保存、新增/删除/重命名 | ✅ | 5 次连续保存只显示最终内容；新增、重命名后生效；删除被引用文件立即报错而非复用旧编译结果 |
| A17 | Ctrl+C、取消、端口冲突 | ⚠ | `run.stop()`（Architect teardown）后同端口立即可复用；端口冲突给出可操作错误。**Ctrl+C 未自动化**：CLI 收到 SIGINT 后进程退出，资源随进程释放 |
| A18 | 缺失 JS、API 请求、越界路径 | ✅ | 均为 404/400，且响应不含工作区文件内容 |
| A19 | 空格/中文路径、Windows、链接包 | ✅ | 所有临时工作区与 pack 测试路径含空格和中文；npm workspace 链接库只打包一份 Angular 运行时 |
| A20 | dev/prod 并发构建 | ✅ | 互不污染，无残留临时目录 |
| A21 | 缓存与配置变化 | ⚠ | 仅进程内存缓存（规格允许）；tsconfig 修改后重新初始化、angular.json 修改明确要求重启。无持久缓存可测 |
| A22 | npm pack 后干净安装 | ✅ | `test:pack`：检查发布包文件清单，在仓库外安装并运行两个 Builder |
| A23 | 不支持的配置 | ✅ | 未知选项、`.scss`、不安全 `outputPath`、`hmr: true`、非本包 buildTarget 均被明确拒绝 |
| A24 | 与官方构建对照 | ✅ | 同一套浏览器检查对官方产物通过；体积 +9.8%/gzip +3.0%，冷构建慢约 3 倍（见 benchmarks.md） |

## 实施过程中发现并修复的问题

这些问题都是测试发现的，修复后有对应的回归测试：

| 问题 | 发现方式 | 修复 |
| --- | --- | --- |
| Windows 盘符 `D:` 被当作 URL 协议，全局样式 `@import` 被原样保留 | 生产产物检查 | `css-processor.ts` 的外部 URL 判断排除单字母协议 |
| 路径含空格时 `@import "…"` 无法解析且被**静默**保留 | e2e（中文/空格路径） | 支持引号内空格；无法解析的 `@import` 改为报错 |
| `polyfills: ["zone.js"]` 被当作文件 | 单元测试 | 新的文件/模块判定规则 + zone.js e2e |
| 生产包体积比官方大 47% | 基线对照 | `define-globals-plugin` + `pure-annotations-plugin`（见 architecture.md 3.7） |
| 删除的资源在下一代仍被上一代回退掩盖 | e2e A08 | 上一代回退只用于 JS chunk |
| 样式分析中途失败后，已修改资源集合丢失 | 代码审查 | 保留到下一次成功分析；新增回归测试 |
| 测试库发布包缺少 `dist/` | `test:pack` | 声明 `files`，pack 脚本检查必需文件 |

## 剩余限制（未完成，未标为完成）

- SCSS/Less/PostCSS/Tailwind、全局 `scripts`、JSON 导入、代理、HTTPS：未实现，配置时被拒绝。
- HMR、CSS 热替换、持久缓存、SSR/预渲染、i18n、Web Worker、Service Worker、CSP nonce/SRI、budgets、license 提取：未实现。
- 目标语法固定为 ES2022，不做依赖降级。
- Linux/macOS、NgModule 应用、DevTools 实际断点、Ctrl+C 信号：未执行验证。
- 开发模式热重建约 1.1 s（本示例），主要耗时在 Rollup 重新分析整张模块图。
- 示例仓库中未把默认 `build/serve` 切换为自定义 Builder：规格要求「全部验收通过后再迁移」，上表仍有 ⚠/⚪ 项，且保留官方目标用于对照。
