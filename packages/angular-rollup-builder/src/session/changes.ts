/**
 * 一批文件变化（由 watcher 合并、去抖后交给 BuildSession）。
 *
 * 不同类型的变化需要不同的处理代价：
 *   files           普通源码/模板/样式/资源变化 → 增量重建
 *   structural      有文件新增或删除 → 需要重新计算 tsconfig 的 include 结果
 *   tsconfigChanged tsconfig*.json 变化 → 丢弃编译器状态，完整重新初始化
 *   restartRequired angular.json / package.json / 锁文件变化 → Builder 选项或依赖变了，
 *                   进程内无法安全生效，明确提示用户重启
 */
export interface ChangeSet {
  files: Set<string>;
  structural: boolean;
  tsconfigChanged: boolean;
  restartRequired: string[];
}

export function emptyChangeSet(): ChangeSet {
  return { files: new Set(), structural: false, tsconfigChanged: false, restartRequired: [] };
}
