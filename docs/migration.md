# 迁移与回退说明

## 1. 并行接入（推荐的第一步）

保留现有 `build/serve`，新增两个目标（以 `my-app` 为例）：

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
    "polyfills": [],
    "baseHref": "/"
  },
  "configurations": {
    "production": {
      "optimization": true,
      "sourceMap": false,
      "fileReplacements": [{ "replace": "src/environments/environment.ts", "with": "src/environments/environment.prod.ts" }]
    },
    "development": { "optimization": false, "sourceMap": true }
  },
  "defaultConfiguration": "production"
},
"serve-rollup": {
  "builder": "@acme/angular-rollup-builder:dev-server",
  "options": { "host": "localhost", "port": 4200, "liveReload": true },
  "configurations": {
    "production": { "buildTarget": "my-app:build-rollup:production" },
    "development": { "buildTarget": "my-app:build-rollup:development" }
  },
  "defaultConfiguration": "development"
}
```

从官方配置迁移时逐项检查：

| 官方配置 | 迁移方式 |
| --- | --- |
| `outputPath: "dist/my-app"`（产物在 `dist/my-app/browser`） | 本构建器直接输出到 `outputPath`，不追加 `browser/`。部署脚本需调整 |
| `assets: [{ "glob": "**/*", "input": "public" }]` | 改为 `assets: ["public"]` |
| `styles` 中的 `.scss` | **阻断**：首版不支持预处理器 |
| `polyfills: ["zone.js"]` | 原样保留 |
| `optimization` / `sourceMap` 的对象形式 | 改为 boolean |
| `outputHashing` | 删除（生产模式总是带内容哈希） |
| `budgets`、`scripts`、`server`、`ssr`、`localize` 等 | **阻断**或删除，见 [compatibility.md](compatibility.md) |
| `.browserslistrc` 包含不支持 ES2022 的旧浏览器 | **阻断**：本构建器不做语法降级 |

## 2. 验证

```bash
ng run my-app:build-rollup:production
ng run my-app:serve-rollup:development
```

用与官方构建相同的浏览器用例对照（本仓库的 `e2e/build.e2e.test.mjs` 中 `exerciseApp` 就是这样对两种产物执行同一套检查）。
记录产物体积与耗时差异（`scripts/benchmark.mjs`）。

## 3. 切换默认目标

全部必需验收通过后：

1. 把 `build` 的 `builder` 改为 `@acme/angular-rollup-builder:build`，并用 `build-rollup` 的选项替换；
2. 把 `serve` 的 `builder` 改为 `@acme/angular-rollup-builder:dev-server`，并把 `buildTarget` 改为 `my-app:build:…`；
3. 把官方配置保存为 `build-official` / `serve-official`，在稳定前保留以便对照与回退；
4. 更新 CI 与部署脚本中的输出目录（去掉 `/browser`）。

## 4. 回退

回退只涉及 `angular.json`：

1. 把 `build`/`serve` 的 `builder` 与选项恢复为 `build-official`/`serve-official` 中保存的内容（或从版本控制恢复 `angular.json`）；
2. 恢复部署脚本中的 `/browser` 输出路径；
3. `@acme/angular-rollup-builder` 可以保留在 devDependencies 中，不影响官方构建。

本构建器不修改源码、不写入 `.angular/cache`，回退无需清理其它文件。
