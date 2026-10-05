/**
 * 核心流水线只依赖这个最小 Logger 接口，而不是 Architect 的 LoggerApi。
 * 这样 BuildSession 等核心模块可以脱离 Angular CLI 单独测试或复用。
 */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
