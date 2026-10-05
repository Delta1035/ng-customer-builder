/**
 * 生产环境替换文件（fileReplacements 的 `with` 目标）。
 * 构建器必须让「类型检查」和「打包」同时看到这个文件的内容。
 */
export interface Environment {
  name: string;
  production: boolean;
}

export const environment: Environment = {
  name: 'production',
  production: true,
};
