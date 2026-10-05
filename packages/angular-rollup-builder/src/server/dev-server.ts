/**
 * 自有开发 HTTP 服务器（Node 内置 http 模块，不使用 Vite / webpack-dev-server）。
 *
 * 产物来源：内存中的构建代次（BuildResult.files），不读磁盘。因此：
 *   - 发布新代次 = 替换一个引用，天然原子，不会读到写了一半的文件；
 *   - 不存在目录穿越问题：请求路径只用来查 Map，永远碰不到文件系统。
 *
 * 保留「上一个成功代次」：页面在刷新前可能仍在按需加载旧代次的懒加载 chunk，
 * 新代次里没有这个文件时回退到上一代，避免立即 404。
 *
 * 请求处理顺序：
 *   1. 内部端点：<baseHref>__ng-rollup/events（SSE）、client.js
 *   2. 不在 baseHref 之下 → 404（访问 baseHref 去掉末尾斜杠时重定向）
 *   3. 还没有成功构建 → 503 状态页（构建中 / 错误详情），构建成功后自动刷新
 *   4. 命中构建产物 → 返回文件
 *   5. 页面导航（Accept: text/html 且路径无扩展名）→ index.html（SPA fallback）
 *   6. 其它（缺失的 .js/.css、API 请求等）→ 404，绝不返回 index.html
 */
import { randomUUID } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { injectBeforeBodyEnd } from '../resources/index-html';
import type { BuildResult } from '../session/build-session';
import type { Logger } from '../utils/logger';
import { LIVE_RELOAD_CLIENT } from './live-reload-client';
import { mimeTypeFor } from './mime';

export interface DevServerOptions {
  host: string;
  port: number;
  baseHref: string;
  liveReload: boolean;
  logger: Logger;
}

type BuildState =
  | { status: 'building'; buildId: string | null }
  | { status: 'success'; buildId: string }
  | { status: 'error'; buildId: string | null; errors: string[] };

interface Generation {
  buildId: string;
  files: ReadonlyMap<string, Uint8Array>;
  /** 注入了 live-reload 客户端的 index.html */
  indexHtml: Uint8Array;
}

const INTERNAL_PREFIX = '__ng-rollup/';

export class DevServer {
  /** 每次启动不同：服务器重启后，旧页面重连时 buildId 必然不同 → 自动刷新 */
  private readonly serverId = randomUUID().slice(0, 8);
  private readonly server: http.Server;
  private readonly sseClients = new Set<http.ServerResponse>();
  private current?: Generation;
  private previous?: Generation;
  private state: BuildState = { status: 'building', buildId: null };
  private keepAlive?: NodeJS.Timeout;
  private closed = false;

  constructor(private readonly options: DevServerOptions) {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        options.logger.error(`请求处理失败 ${req.url}: ${error}`);
        if (!res.headersSent) {
          res.writeHead(500).end();
        }
      });
    });
  }

  /** 开始监听；端口占用等错误以可操作的消息抛出 */
  async listen(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        reject(
          error.code === 'EADDRINUSE'
            ? new Error(`端口 ${this.options.port} 已被占用。请关闭占用该端口的进程，或使用 --port 指定其它端口。`)
            : error,
        );
      };
      this.server.once('error', onError);
      this.server.listen(this.options.port, this.options.host, () => {
        this.server.off('error', onError);
        resolve();
      });
    });
    // SSE 保活注释，防止代理或浏览器因长时间无数据断开
    this.keepAlive = setInterval(() => this.sseClients.forEach((client) => client.write(': ping\n\n')), 30_000);

    const { port } = this.server.address() as AddressInfo;
    const host = this.options.host.includes(':') ? `[${this.options.host}]` : this.options.host;
    return `http://${host}:${port}${this.options.baseHref}`;
  }

  notifyBuildStart(): void {
    this.setState({ status: 'building', buildId: this.current?.buildId ?? null });
  }

  /** 发布一个构建结果。成功 → 原子切换代次；失败 → 保留最后成功版本，并广播错误 */
  async publish(result: BuildResult): Promise<void> {
    if (!result.success) {
      this.setState({ status: 'error', buildId: this.current?.buildId ?? null, errors: result.errors });
      return;
    }
    const buildId = `${this.serverId}-${result.generation}`;
    const indexHtml = await this.renderIndex(result.files.get('index.html'), buildId);
    this.previous = this.current;
    this.current = { buildId, files: result.files, indexHtml };
    this.setState({ status: 'success', buildId });
  }

  /** 幂等：多次调用安全 */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    clearInterval(this.keepAlive);
    this.sseClients.forEach((client) => client.end());
    this.sseClients.clear();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      // 立即断开所有 keep-alive 连接，端口才能马上被下一次启动复用
      this.server.closeAllConnections();
    });
  }

  // -------------------------------------------------------------------------

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const { baseHref } = this.options;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }

    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    } catch {
      res.writeHead(400).end('Bad Request');
      return;
    }

    if (!pathname.startsWith(baseHref)) {
      if (pathname === baseHref.slice(0, -1)) {
        res.writeHead(302, { location: baseHref }).end();
      } else {
        this.sendText(res, 404, `Not Found（应用部署在 ${baseHref} 之下）`);
      }
      return;
    }

    const relative = pathname.slice(baseHref.length);
    if (relative.startsWith(INTERNAL_PREFIX)) {
      this.handleInternal(relative.slice(INTERNAL_PREFIX.length), req, res);
      return;
    }

    // 路径只用于查 Map；这里仍然拒绝明显异常的路径，让行为更可预期
    if (relative.split('/').some((segment) => segment === '..' || segment === '.') || /[\\\0]/.test(relative)) {
      this.sendText(res, 400, 'Bad Request');
      return;
    }

    const generation = this.current;
    if (!generation) {
      this.sendStatusPage(res);
      return;
    }

    if (relative === '' || relative === 'index.html') {
      this.send(res, 200, 'index.html', generation.indexHtml);
      return;
    }

    const file = generation.files.get(relative) ?? (isScriptChunk(relative) ? this.previous?.files.get(relative) : undefined);
    if (file) {
      this.send(res, 200, relative, file);
      return;
    }

    if (isPageNavigation(req, relative)) {
      this.send(res, 200, 'index.html', generation.indexHtml);
      return;
    }
    this.sendText(res, 404, 'Not Found');
  }

  private handleInternal(name: string, req: http.IncomingMessage, res: http.ServerResponse): void {
    if (name === 'client.js') {
      this.send(res, 200, 'client.js', Buffer.from(LIVE_RELOAD_CLIENT));
      return;
    }
    if (name === 'events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(this.formatState());
      this.sseClients.add(res);
      req.on('close', () => this.sseClients.delete(res));
      return;
    }
    this.sendText(res, 404, 'Not Found');
  }

  private setState(state: BuildState): void {
    this.state = state;
    const message = this.formatState();
    this.sseClients.forEach((client) => client.write(message));
  }

  private formatState(): string {
    return `event: state\ndata: ${JSON.stringify(this.state)}\n\n`;
  }

  private async renderIndex(indexHtml: Uint8Array | undefined, buildId: string): Promise<Uint8Array> {
    if (!indexHtml) {
      throw new Error('构建结果缺少 index.html');
    }
    const html = Buffer.from(indexHtml).toString('utf8');
    return Buffer.from(this.options.liveReload ? await injectBeforeBodyEnd(html, this.clientScriptTag(buildId)) : html);
  }

  private clientScriptTag(buildId: string | null): string {
    const prefix = `${this.options.baseHref}${INTERNAL_PREFIX}`;
    return `<script src="${prefix}client.js" data-events-url="${prefix}events" data-build-id="${buildId ?? ''}"></script>`;
  }

  /** 首次构建完成前（或首次即失败）的状态页：503，不返回任何未知的旧产物 */
  private sendStatusPage(res: http.ServerResponse): void {
    const body =
      this.state.status === 'error'
        ? `<h1>构建失败</h1><pre>${escapeHtml(this.state.errors.join('\n\n'))}</pre><p>修复后页面将自动刷新。</p>`
        : '<h1>正在构建…</h1><p>构建完成后页面将自动刷新。</p>';
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>ng-rollup dev server</title></head><body>${body}${this.clientScriptTag(null)}</body></html>`;
    res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '1' });
    res.end(html);
  }

  private send(res: http.ServerResponse, status: number, fileName: string, body: Uint8Array): void {
    res.writeHead(status, {
      'content-type': mimeTypeFor(fileName),
      'content-length': body.byteLength,
      // 开发模式：每次都向服务器确认，避免浏览器使用过期产物
      'cache-control': 'no-cache',
    });
    res.end(res.req.method === 'HEAD' ? undefined : body);
  }

  private sendText(res: http.ServerResponse, status: number, text: string): void {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }).end(text);
  }
}

/**
 * 只有「浏览器地址栏导航」才回退到 index.html：
 *   - Accept 头包含 text/html（fetch/XHR 的 API 请求通常不包含）
 *   - 最后一段路径没有扩展名（/lazy/detail 是页面，/main.js、/missing.css 不是）
 */
function isPageNavigation(req: http.IncomingMessage, relativePath: string): boolean {
  const accept = req.headers.accept ?? '';
  const lastSegment = relativePath.split('/').pop() ?? '';
  return accept.includes('text/html') && !lastSegment.includes('.');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 只有 JS chunk（及其 Source Map）会回退到上一代：尚未刷新的页面可能还在按需加载旧 chunk。
 * 图片、样式等资源不回退，删除的资源在下一次构建后立即 404。
 */
function isScriptChunk(relativePath: string): boolean {
  return /\.(m?js|map)$/.test(relativePath);
}
