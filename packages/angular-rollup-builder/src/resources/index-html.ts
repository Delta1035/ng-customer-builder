/**
 * index.html 生成。
 *
 * 不用正则重写整个文档，而是用 parse5 解析出各元素在源码中的「字符偏移」，
 * 然后只在这些位置插入/替换少量文本。源 HTML 的其余内容（业务 meta、CSP、已有脚本、
 * 注释、格式）全部原样保留。
 */
import { loadParse5 } from '../utils/load-esm';

export interface IndexHtmlOptions {
  baseHref: string;
  /** 按顺序执行的 module 脚本（polyfills 在前，main 在后） */
  scripts: string[];
  stylesheets: string[];
  /** 首屏静态依赖 chunk，用 modulepreload 提前并行下载 */
  modulePreloads: string[];
}

interface Insertion {
  offset: number;
  /** 被替换的原文长度；纯插入为 0 */
  deleteCount: number;
  text: string;
}

export async function generateIndexHtml(template: string, options: IndexHtmlOptions): Promise<string> {
  const doc = await locateDocument(template);
  const existing = new Set(doc.existingUrls);
  const insertions: Insertion[] = [];

  // <base href>：已有则只替换 href 属性，没有则插在 <head> 开头
  const baseTag = `href="${escapeAttribute(options.baseHref)}"`;
  if (doc.baseHrefAttr) {
    insertions.push({ offset: doc.baseHrefAttr.start, deleteCount: doc.baseHrefAttr.end - doc.baseHrefAttr.start, text: baseTag });
  } else {
    insertions.push({ offset: doc.headStartTagEnd, deleteCount: 0, text: `\n  <base ${baseTag}>` });
  }

  // 已在模板中出现的 URL 不重复注入
  const headTags = [
    ...options.stylesheets.filter((url) => !existing.has(url)).map((url) => `<link rel="stylesheet" href="${escapeAttribute(url)}">`),
    ...options.modulePreloads.filter((url) => !existing.has(url)).map((url) => `<link rel="modulepreload" href="${escapeAttribute(url)}">`),
  ];
  const bodyTags = options.scripts
    .filter((url) => !existing.has(url))
    .map((url) => `<script src="${escapeAttribute(url)}" type="module"></script>`);

  if (headTags.length) {
    insertions.push({ offset: doc.headEndTagStart, deleteCount: 0, text: formatTags(headTags) });
  }
  if (bodyTags.length) {
    insertions.push({ offset: doc.bodyEndTagStart, deleteCount: 0, text: formatTags(bodyTags) });
  }
  return applyInsertions(template, insertions);
}

/** 开发服务器使用：在 </body> 前插入一段 HTML（例如 live-reload 客户端脚本）。 */
export async function injectBeforeBodyEnd(html: string, snippet: string): Promise<string> {
  const doc = await locateDocument(html);
  return applyInsertions(html, [{ offset: doc.bodyEndTagStart, deleteCount: 0, text: formatTags([snippet]) }]);
}

// ---------------------------------------------------------------------------

interface DocumentLocations {
  headStartTagEnd: number;
  headEndTagStart: number;
  bodyEndTagStart: number;
  baseHrefAttr?: { start: number; end: number };
  existingUrls: string[];
}

type Parse5Node = {
  nodeName: string;
  attrs?: { name: string; value: string }[];
  childNodes?: Parse5Node[];
  sourceCodeLocation?: {
    startTag?: { startOffset: number; endOffset: number };
    endTag?: { startOffset: number; endOffset: number };
    attrs?: Record<string, { startOffset: number; endOffset: number }>;
  } | null;
};

async function locateDocument(html: string): Promise<DocumentLocations> {
  const { parse } = await loadParse5();
  const document = parse(html, { sourceCodeLocationInfo: true }) as unknown as Parse5Node;

  const htmlElement = document.childNodes?.find((n) => n.nodeName === 'html');
  const head = htmlElement?.childNodes?.find((n) => n.nodeName === 'head');
  const body = htmlElement?.childNodes?.find((n) => n.nodeName === 'body');

  // parse5 会为缺失的标签自动补全元素，但补全的元素没有源码位置。
  // 我们需要真实的插入点，所以要求模板显式书写 <head>…</head> 与 <body>…</body>。
  const headLoc = head?.sourceCodeLocation;
  const bodyLoc = body?.sourceCodeLocation;
  if (!headLoc?.startTag || !headLoc.endTag || !bodyLoc?.endTag) {
    throw new Error('index.html 必须包含显式的 <head>…</head> 与 <body>…</body> 标签');
  }

  const existingUrls: string[] = [];
  let baseHrefAttr: DocumentLocations['baseHrefAttr'];
  const visit = (node: Parse5Node) => {
    for (const attr of node.attrs ?? []) {
      if (attr.name === 'src' || attr.name === 'href') {
        existingUrls.push(attr.value);
      }
    }
    if (node.nodeName === 'base' && !baseHrefAttr) {
      const loc = node.sourceCodeLocation?.attrs?.['href'];
      if (loc) {
        baseHrefAttr = { start: loc.startOffset, end: loc.endOffset };
      }
    }
    node.childNodes?.forEach(visit);
  };
  visit(document);

  return {
    headStartTagEnd: headLoc.startTag.endOffset,
    headEndTagStart: headLoc.endTag.startOffset,
    bodyEndTagStart: bodyLoc.endTag.startOffset,
    baseHrefAttr,
    existingUrls,
  };
}

function applyInsertions(source: string, insertions: Insertion[]): string {
  // 从后往前应用，前面的偏移量就不会因为插入而失效
  let result = source;
  for (const { offset, deleteCount, text } of [...insertions].sort((a, b) => b.offset - a.offset)) {
    result = result.slice(0, offset) + text + result.slice(offset + deleteCount);
  }
  return result;
}

function formatTags(tags: string[]): string {
  return tags.map((tag) => `  ${tag}\n`).join('');
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
