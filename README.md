# Angular Rollup 自定义构建器

按 [ANGULAR_ROLLUP_BUILDER_PLAN.md](ANGULAR_ROLLUP_BUILDER_PLAN.md) 实现的 Angular CLI 自定义 Builder：

- **build**：Angular AOT（`@angular/compiler-cli` 公开 API）→ Angular Linker → Rollup → HTML/CSS/资源
- **dev-server**：同一套构建核心 + 自有 Node HTTP 服务 + SSE 整页刷新

编译、打包与开发服务链路不调用 esbuild、Vite 或官方 application/dev-server Builder（官方 Builder 仅作为对照目标保留）。

## 目录

```text
packages/angular-rollup-builder/   构建器包（发布单元）
  src/build/  src/dev-server/      两个 Builder 入口 + schema.json（很薄）
  src/config/                      选项归一化、校验、输出目录安全
  src/compiler/                    Angular AOT 编译、CompilerHost 定制、依赖图、compiler-cli 适配契约
  src/rollup/                      Rollup 打包与插件（编译结果、Linker、生产常量、纯函数标记、polyfills）
  src/resources/                   CSS 处理、全局样式、index.html、静态资源
  src/session/                     BuildSession（共享核心）、watch 循环、文件监听、原子写盘
  src/server/                      开发服务器与浏览器刷新客户端
  test/                            单元测试与 compiler-cli 契约测试
fixtures/basic-app/                示例应用（standalone、zoneless、懒加载、@defer、文件替换…）
fixtures/partial-ivy-library/      以 partial 模式编译的测试库（覆盖 Linker）
e2e/                               真实 Architect 调度 + 真实浏览器的验收测试
scripts/                           打包安装测试、性能对照
docs/                              设计说明与各类报告
```

## 快速开始

```bash
npm install
npm run prepare:all            # 构建构建器包与 partial-Ivy 测试库

npm run build:rollup           # ng run basic-app:build-rollup:production → dist/basic-app-rollup
npm run build:rollup:dev       # 开发构建（Source Map、无压缩）
npm run serve:rollup           # ng run basic-app:serve-rollup:development → http://localhost:4300/
npm run build:official         # 官方构建（对照）
```

## 测试

| 命令 | 内容 |
| --- | --- |
| `npm run test:unit` | 单元测试：CSS/HTML/资源、配置与输出目录安全、依赖图、Rollup 插件、compiler-cli 契约 |
| `npm run test:e2e` | 验收测试：真实 Architect 调度、真实浏览器（系统 Edge；`E2E_BROWSER_CHANNEL=chrome` 可切换） |
| `npm run test:pack` | `npm pack` 后在仓库外的干净目录安装并运行两个 Builder（A22） |
| `npm run benchmark` | 与官方构建的耗时/体积对照（A24） |

e2e 与 pack 测试会在路径中使用空格与中文，覆盖 Windows 路径场景（A19）。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/learning-roadmap.md](docs/learning-roadmap.md) | **学习路线图**：分阶段目标、阅读顺序、动手实验、自测题、毕业项目、学习建议 |
| [docs/architecture.md](docs/architecture.md) | **实现思路**：设计决策、推荐阅读顺序、调试技巧、扩展练习 |
| [docs/acceptance.md](docs/acceptance.md) | 各阶段交付、A01–A24 验收结果、验证命令、未执行项 |
| [docs/compatibility.md](docs/compatibility.md) | 支持/拒绝的选项与特性、与官方构建的差异 |
| [docs/benchmarks.md](docs/benchmarks.md) | 性能与体积对照 |
| [docs/baseline.md](docs/baseline.md) | P0 版本与特性盘点 |
| [docs/migration.md](docs/migration.md) | 迁移步骤与回退 |
| [packages/angular-rollup-builder/README.md](packages/angular-rollup-builder/README.md) | 构建器包的使用说明与选项 |
