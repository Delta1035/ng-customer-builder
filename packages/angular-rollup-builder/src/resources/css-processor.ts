/**
 * CSS 处理（全局样式与组件样式共用）。
 *
 * 做两件事：
 *   1. 内联本地 @import：把 `@import './theme.css'` 替换为该文件内容（递归）。
 *   2. 改写相对 url()：把引用的图片/字体输出为 media/<名字>-<内容哈希>.<扩展名>，
 *      并把 url() 改成这个输出路径。
 *
 * 为什么 url 改写成 "media/xxx" 对两类样式都正确：
 *   - 全局样式输出为根目录下的 styles.css，url 相对 CSS 文件解析 → <输出根>/media/xxx
 *   - 组件样式被 Angular 内联进 JS，最终以 <style> 注入文档，url 相对文档的 <base href>
 *     解析 → 同样是 <输出根>/media/xxx
 *
 * 返回值中的 dependencies 是「这段 CSS 依赖的所有文件」（被 import 的 CSS + 被引用的资源），
 * watch 模式据此判断哪些样式需要重新处理。
 */
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import postcss, { type AtRule, type Root } from 'postcss';
import { contentHash } from '../utils/hash';
import { toOutputPath } from '../utils/paths';

export interface CssAsset {
  /** 相对输出根的路径，例如 media/logo-1a2b3c4d.svg */
  outputPath: string;
  sourcePath: string;
}

export interface ProcessedCss {
  css: string;
  dependencies: Set<string>;
  assets: CssAsset[];
}

export class CssProcessingError extends Error {}

/**
 * @param css   样式源码
 * @param from  样式所在文件（内联样式传其所属的 .ts 文件），用于解析相对路径
 */
export function processCss(css: string, from: string): ProcessedCss {
  const dependencies = new Set<string>();
  const assets = new Map<string, CssAsset>();

  const root = postcss.parse(css, { from });
  inlineImports(root, from, dependencies, [from]);
  rewriteUrls(root, from, dependencies, assets);
  hoistRemainingImports(root);

  return { css: root.toString(), dependencies, assets: [...assets.values()] };
}

// ---------------------------------------------------------------------------
// @import 内联
// ---------------------------------------------------------------------------

function inlineImports(root: Root, from: string, dependencies: Set<string>, stack: string[]): void {
  root.walkAtRules('import', (rule) => {
    const parsed = parseImportParams(rule.params);
    if (!parsed) {
      // 无法识别就报错，而不是原样保留——否则浏览器会去请求一个不存在的地址，问题被静默掩盖
      throw new CssProcessingError(`${rule.source?.input.file ?? from}: 无法解析 @import ${rule.params}`);
    }
    if (isExternalUrl(parsed.url)) {
      return; // 远程 @import 原样保留（稍后提升到顶部）
    }

    const baseFile = rule.source?.input.file ?? from;
    const importedFile = path.resolve(path.dirname(baseFile), parsed.url);
    if (!existsSync(importedFile)) {
      throw new CssProcessingError(`${baseFile}: @import "${parsed.url}" 指向的文件不存在`);
    }
    if (stack.includes(importedFile)) {
      throw new CssProcessingError(`检测到循环 @import：${[...stack, importedFile].join(' → ')}`);
    }
    dependencies.add(importedFile);

    const importedRoot = postcss.parse(readFileSync(importedFile, 'utf8'), { from: importedFile });
    inlineImports(importedRoot, importedFile, dependencies, [...stack, importedFile]);
    replaceImportRule(rule, importedRoot, parsed.condition);
  });
}

function replaceImportRule(rule: AtRule, imported: Root, condition: string): void {
  if (!condition) {
    rule.replaceWith(imported.nodes);
    return;
  }
  if (/^(layer|supports)\b/.test(condition)) {
    throw new CssProcessingError(`暂不支持带 layer()/supports() 条件的 @import：@import ${rule.params}`);
  }
  // 带媒体查询的 @import 等价于包在 @media 中
  const media = postcss.atRule({ name: 'media', params: condition });
  media.append(imported.nodes);
  rule.replaceWith(media);
}

/**
 * 支持的写法：
 *   @import "a.css";   @import 'a.css';   @import url(a.css);   @import url("a b.css") screen;
 * 引号内允许空格（路径可能包含空格）。
 */
function parseImportParams(params: string): { url: string; condition: string } | null {
  const match = /^\s*(?:"([^"]*)"|'([^']*)'|url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\))\s*(.*)$/s.exec(params);
  if (!match) {
    return null;
  }
  const url = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5];
  return url ? { url, condition: match[6].trim() } : null;
}

/** CSS 规范要求 @import 位于其它规则之前；内联后剩余的远程 @import 需要移到最前面。 */
function hoistRemainingImports(root: Root): void {
  const imports: AtRule[] = [];
  root.walkAtRules('import', (rule) => {
    imports.push(rule);
  });
  for (const rule of imports.reverse()) {
    rule.remove();
    root.prepend(rule);
  }
}

// ---------------------------------------------------------------------------
// url() 改写
// ---------------------------------------------------------------------------

const URL_PATTERN = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")\s]+))\s*\)/g;

function rewriteUrls(root: Root, from: string, dependencies: Set<string>, assets: Map<string, CssAsset>): void {
  root.walkDecls((decl) => {
    if (!decl.value.includes('url(')) {
      return;
    }
    // 关键：相对路径要相对「声明所在的原始文件」解析，而不是最外层文件——
    // 被内联的 theme.css 里的 url 应相对 theme.css。
    const baseFile = decl.source?.input.file ?? from;

    decl.value = decl.value.replace(URL_PATTERN, (whole, double?: string, single?: string, bare?: string) => {
      const url = (double ?? single ?? bare ?? '').trim();
      if (!url || isExternalUrl(url) || url.startsWith('/') || url.startsWith('#')) {
        return whole; // data:、远程地址、根路径、片段引用保持原样
      }

      // 保留 ?query 与 #hash（例如 font.woff2?#iefix）
      const suffixIndex = url.search(/[?#]/);
      const filePart = suffixIndex === -1 ? url : url.slice(0, suffixIndex);
      const suffix = suffixIndex === -1 ? '' : url.slice(suffixIndex);

      const sourcePath = path.resolve(path.dirname(baseFile), decodeURI(filePart));
      if (!existsSync(sourcePath)) {
        throw new CssProcessingError(`${baseFile}: url(${url}) 指向的文件不存在`);
      }
      dependencies.add(sourcePath);

      const ext = path.extname(sourcePath);
      const name = path.basename(sourcePath, ext);
      const outputPath = toOutputPath('media', `${name}-${contentHash(readFileSync(sourcePath))}${ext}`);
      assets.set(outputPath, { outputPath, sourcePath });
      return `url("${outputPath}${suffix}")`;
    });
  });
}

function isExternalUrl(url: string): boolean {
  // data:、http:、https:、以及 //cdn 这类协议相对地址。
  // 注意排除 Windows 盘符（D:/…）：单字母后跟冒号不是 URL 协议。
  return /^[a-z][a-z0-9+.-]+:/i.test(url) || url.startsWith('//');
}
