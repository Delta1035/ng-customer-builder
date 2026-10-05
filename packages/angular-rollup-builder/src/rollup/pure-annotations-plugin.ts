/**
 * Rollup 插件：为 Angular 框架包的顶层初始化调用补充 /*@__PURE__*\/ 标记（仅生产优化模式）。
 *
 * 问题：@angular/core 中有大量这样的顶层代码：
 *
 *   const Component = makeDecorator('Component', …, (type, meta) => compileComponent(type, meta));
 *
 * Rollup 无法证明 makeDecorator() 没有副作用，只能保留它——连带保留 JIT 编译器与
 * 整张指令表（实测约 220 kB 未压缩代码），即使应用是 AOT 编译、从不使用 JIT。
 *
 * 做法（与 Angular CLI 的 pure-toplevel-functions 思路一致，范围同样保守）：
 *   - 只处理 node_modules/@angular/* 下、且 package.json 声明 "sideEffects": false 的包；
 *   - 只标记「顶层变量声明的初始化调用」（const X = f() / new X()），
 *     顶层表达式语句（真正的注册、全局修改）一律不动。
 * 标记为纯函数只表示「结果没被使用时可以删除」，被使用的代码不受影响。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import MagicString from 'magic-string';
import type { Plugin } from 'rollup';

type Node = { type: string; start: number; end: number; [key: string]: unknown };

const ANGULAR_PACKAGE = /[\\/]node_modules[\\/]@angular[\\/]([^\\/]+)[\\/]/;

export function angularPureAnnotationsPlugin(): Plugin {
  const sideEffectFreeCache = new Map<string, boolean>();

  const isSideEffectFreeAngularFile = (id: string): boolean => {
    const match = ANGULAR_PACKAGE.exec(id);
    if (!match) {
      return false;
    }
    const packageJson = path.join(id.slice(0, match.index + match[0].length - 1), 'package.json');
    let result = sideEffectFreeCache.get(packageJson);
    if (result === undefined) {
      try {
        result = JSON.parse(readFileSync(packageJson, 'utf8')).sideEffects === false;
      } catch {
        result = false;
      }
      sideEffectFreeCache.set(packageJson, result);
    }
    return result;
  };

  return {
    name: 'ng-rollup:angular-pure-annotations',

    transform(code, id) {
      if (!/\.m?js$/.test(id) || !isSideEffectFreeAngularFile(id)) {
        return null;
      }
      const program = this.parse(code) as unknown as { body: Node[] };
      const magic = new MagicString(code);
      let changed = false;

      for (const statement of program.body) {
        const declaration = statement.type === 'ExportNamedDeclaration' ? (statement['declaration'] as Node | null) : statement;
        if (declaration?.type !== 'VariableDeclaration') {
          continue;
        }
        for (const declarator of declaration['declarations'] as Node[]) {
          const init = declarator['init'] as Node | null;
          if (init && (init.type === 'CallExpression' || init.type === 'NewExpression') && !isAnnotated(code, init.start)) {
            magic.appendLeft(init.start, '/*@__PURE__*/ ');
            changed = true;
          }
        }
      }

      return changed ? { code: magic.toString(), map: magic.generateMap({ hires: true, source: id }).toString() } : null;
    },
  };
}

function isAnnotated(code: string, start: number): boolean {
  return /\/\*\s*[@#]__PURE__\s*\*\/\s*$/.test(code.slice(Math.max(0, start - 20), start));
}
