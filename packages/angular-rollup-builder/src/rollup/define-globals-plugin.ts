/**
 * Rollup 插件：编译期常量（仅生产优化模式）。
 *
 * 为什么不能只交给 terser？
 * Angular 产物中大量代码受全局标记保护，例如：
 *
 *   (() => { (typeof ngDevMode === "undefined" || ngDevMode) && setClassMetadata(DatePipe, …) })();
 *
 * Rollup 做 tree-shaking 时 ngDevMode 是未知全局变量，这段代码被视为有副作用，
 * 它引用的 DatePipe 等类也就都被保留下来。等 terser 把 ngDevMode 当作 false 时，
 * tree-shaking 早已结束。所以必须在 Rollup 分析之前把这些标记替换成常量。
 *
 * 实现：用 Rollup 自带的解析器得到 AST，只替换「对全局变量的读取」：
 *   typeof ngDevMode  → "boolean"
 *   ngDevMode         → false
 * 不替换：属性名（obj.ngDevMode / { ngDevMode: … }）、赋值目标、声明；
 * 如果某个文件自己声明了同名变量，整个文件跳过（保守处理，不做作用域分析）。
 */
import MagicString from 'magic-string';
import type { Plugin } from 'rollup';

type Node = { type: string; start: number; end: number; [key: string]: unknown };

export function defineGlobalsPlugin(definitions: Record<string, boolean>): Plugin {
  const names = Object.keys(definitions);
  const quickCheck = new RegExp(`\\b(${names.join('|')})\\b`);

  return {
    name: 'ng-rollup:define-globals',

    transform(code, id) {
      if (!quickCheck.test(code)) {
        return null;
      }
      const ast = this.parse(code) as unknown as Node;
      const replacements: { start: number; end: number; text: string }[] = [];
      let declaresName = false;

      walk(ast, null, (node, parent) => {
        if (node.type !== 'Identifier' || !names.includes(node['name'] as string)) {
          return;
        }
        const name = node['name'] as string;
        const usage = classify(node, parent);
        if (usage === 'declaration') {
          declaresName = true;
        } else if (usage === 'typeof') {
          replacements.push({ start: parent!.start, end: parent!.end, text: JSON.stringify(typeof definitions[name]) });
        } else if (usage === 'shorthand') {
          replacements.push({ start: node.start, end: node.end, text: `${name}: ${definitions[name]}` });
        } else if (usage === 'read') {
          replacements.push({ start: node.start, end: node.end, text: String(definitions[name]) });
        }
      });

      if (declaresName || replacements.length === 0) {
        return null;
      }
      const magic = new MagicString(code);
      const done = new Set<number>();
      for (const { start, end, text } of replacements) {
        // 简写属性 { ngDevMode } 的 key 与 value 是同一段源码，只替换一次
        if (!done.has(start)) {
          done.add(start);
          magic.overwrite(start, end, text);
        }
      }
      return { code: magic.toString(), map: magic.generateMap({ hires: true, source: id }).toString() };
    },
  };
}

type Usage = 'read' | 'typeof' | 'shorthand' | 'declaration' | 'ignore';

function classify(node: Node, parent: Node | null): Usage {
  if (!parent) {
    return 'read';
  }
  switch (parent.type) {
    case 'UnaryExpression':
      return parent['operator'] === 'typeof' ? 'typeof' : 'read';
    case 'MemberExpression':
      // obj.ngDevMode 中的属性名不是变量；ngDevMode.x 中的对象才是
      return parent['property'] === node && !parent['computed'] ? 'ignore' : 'read';
    case 'Property':
      if (parent['shorthand']) {
        return 'shorthand';
      }
      return parent['key'] === node && !parent['computed'] ? 'ignore' : 'read';
    case 'PropertyDefinition':
    case 'MethodDefinition':
      return parent['key'] === node && !parent['computed'] ? 'ignore' : 'read';
    case 'AssignmentExpression':
    case 'AssignmentPattern':
      return parent['left'] === node ? 'declaration' : 'read';
    case 'UpdateExpression':
    case 'VariableDeclarator':
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
    case 'ClassDeclaration':
    case 'CatchClause':
    case 'ImportSpecifier':
    case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier':
      // 被赋值、被声明为变量/参数/导入：文件里存在同名绑定，保守跳过整个文件
      return parent['init'] === node || parent['body'] === node ? 'read' : 'declaration';
    case 'ExportSpecifier':
    case 'LabeledStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
      return 'ignore';
    default:
      return 'read';
  }
}

function walk(node: unknown, parent: Node | null, visit: (node: Node, parent: Node | null) => void): void {
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, parent, visit));
    return;
  }
  if (!node || typeof node !== 'object' || typeof (node as Node).type !== 'string') {
    return;
  }
  visit(node as Node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (key !== 'type' && value && typeof value === 'object') {
      walk(value, node as Node, visit);
    }
  }
}
