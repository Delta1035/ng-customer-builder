# @acme/angular-rollup-builder

Angular CLI 自定义 Builder：**Angular AOT 编译 + Rollup 打包 + 自有开发服务器**。
编译、打包、开发服务链路不使用 esbuild、Vite 或官方 application/dev-server Builder。

- `@acme/angular-rollup-builder:build` —— 生产/开发构建，可 `watch`
- `@acme/angular-rollup-builder:dev-server` —— watch + 内存产物 + SSE 整页刷新

首版范围是浏览器端 CSR 应用，**不是**官方 Builder 的完全替代品。不支持的选项会被明确拒绝。
完整列表见仓库 `docs/compatibility.md`，设计说明见 `docs/architecture.md`。

## 安装

```bash
npm install -D @acme/angular-rollup-builder
```

peerDependencies：`@angular/compiler-cli ^22`、`@angular-devkit/architect 0.22xx`、`typescript >=6.0 <6.1`（由 Angular CLI 工作区提供）。
Node `^22.22.3 || ^24.15.0 || >=26`。

## 配置

```json
"build-rollup": {
  "builder": "@acme/angular-rollup-builder:build",
  "options": {
    "browser": "src/main.ts",
    "tsConfig": "tsconfig.app.json",
    "index": "src/index.html",
    "outputPath": "dist/my-app-rollup",
    "styles": ["src/styles.css"],
    "assets": ["public"],
    "polyfills": ["zone.js"],
    "baseHref": "/"
  },
  "configurations": {
    "production": { "optimization": true, "sourceMap": false },
    "development": { "optimization": false, "sourceMap": true }
  }
},
"serve-rollup": {
  "builder": "@acme/angular-rollup-builder:dev-server",
  "options": { "port": 4200 },
  "configurations": {
    "development": { "buildTarget": "my-app:build-rollup:development" }
  },
  "defaultConfiguration": "development"
}
```

### build 选项

| 字段 | 类型 | 默认 | 语义 |
| --- | --- | --- | --- |
| `browser` | string，必填 | | 应用入口（工作区相对路径） |
| `tsConfig` | string，必填 | | 应用 tsconfig |
| `index` | string，必填 | | HTML 模板，需显式 `<head>`、`<body>` |
| `outputPath` | string，必填 | | 最终产物目录（**不**追加 `browser/`）；拒绝工作区根、包含源码的目录、符号链接 |
| `styles` | string[] | `[]` | 有序全局 CSS（仅 `.css`），合并为 `styles.css` |
| `assets` | string[] | `[]` | 资源目录，内容复制到输出根；冲突报错 |
| `polyfills` | string[] | `[]` | 有序；`.ts` / `./` 开头 / 工作区存在的文件视为文件，其余视为模块（如 `zone.js`） |
| `baseHref` | string | `/` | 以 `/` 开头的部署路径 |
| `fileReplacements` | `{replace, with}[]` | `[]` | 同时作用于类型检查与打包 |
| `optimization` | boolean | `false` | 压缩、内容哈希、`ngDevMode` 等常量、纯函数标记 |
| `sourceMap` | boolean | `true` | |
| `watch` | boolean | `false` | 持续构建；失败不改动输出目录 |

### dev-server 选项

| 字段 | 类型 | 默认 | 语义 |
| --- | --- | --- | --- |
| `buildTarget` | string，必填 | | 必须使用本包的 build Builder |
| `host` | string | `localhost` | |
| `port` | number | `4200` | 占用时报错 |
| `liveReload` | boolean | `true` | 构建成功后整页刷新 |
| `hmr` | boolean | `false` | `true` 会被拒绝（首版不支持 HMR） |

## 行为要点

- 生产构建：入口、chunk、样式带内容哈希；HTML 根据 Rollup 实际输出生成；polyfills 在 main 之前执行。
- 构建失败：不改动输出目录；单次构建以非 0 退出码结束；诊断包含源文件行列。
- 开发服务器：产物在内存中，首次构建前/首次失败返回 503 状态页；之后失败时保留最后成功版本并在页面显示错误浮层；
  SPA fallback 只针对页面导航（缺失的 `.js`/`.css`、API 请求返回 404）。
- 修改 `tsconfig*.json` 会重新初始化编译器；修改 `angular.json`/`package.json`/锁文件需要重启命令。
