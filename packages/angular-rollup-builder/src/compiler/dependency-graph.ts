/**
 * 反向依赖图：「被依赖的文件」→「依赖它的文件（owner）」。
 *
 * Angular 编译器自己知道 组件 → templateUrl/styleUrl 的关系，但不知道样式里
 * `@import` 的 CSS 和 `url()` 引用的图片。这些「传递依赖」由我们在处理样式时登记：
 *
 *   lazy-page.css ──url()──▶ assets/dot.svg
 *   setDependencies('lazy-page.css', ['assets/dot.svg'])
 *
 * 当 dot.svg 变化时，ownersOf(['dot.svg']) 返回 lazy-page.css，
 * 编译器就会把 lazy-page.css 当作「已修改的资源」重新处理所属组件。
 */
import { pathKey } from '../utils/paths';

export class DependencyGraph {
  /** owner → 它当前的依赖（用于更新时撤销旧边） */
  private readonly dependenciesByOwner = new Map<string, Set<string>>();
  /** 依赖 → owner 原始路径集合 */
  private readonly ownersByDependency = new Map<string, Map<string, string>>();
  /** 依赖的规范键 → 原始路径 */
  private readonly dependencyPaths = new Map<string, string>();

  /** 用新的依赖列表整体替换 owner 的旧依赖。 */
  setDependencies(owner: string, dependencies: Iterable<string>): void {
    const ownerKey = pathKey(owner);
    for (const dependencyKey of this.dependenciesByOwner.get(ownerKey) ?? []) {
      this.ownersByDependency.get(dependencyKey)?.delete(ownerKey);
    }

    const keys = new Set<string>();
    for (const dependency of dependencies) {
      const dependencyKey = pathKey(dependency);
      keys.add(dependencyKey);
      this.dependencyPaths.set(dependencyKey, dependency);
      let owners = this.ownersByDependency.get(dependencyKey);
      if (!owners) {
        owners = new Map();
        this.ownersByDependency.set(dependencyKey, owners);
      }
      owners.set(ownerKey, owner);
    }
    this.dependenciesByOwner.set(ownerKey, keys);
  }

  /** 返回受 changed 影响的所有 owner（传递闭包，不含 changed 自身）。 */
  ownersOf(changed: Iterable<string>): Set<string> {
    const result = new Map<string, string>();
    const queue = [...changed].map(pathKey);
    while (queue.length) {
      for (const [ownerKey, owner] of this.ownersByDependency.get(queue.pop()!) ?? []) {
        if (!result.has(ownerKey)) {
          result.set(ownerKey, owner);
          queue.push(ownerKey);
        }
      }
    }
    return new Set(result.values());
  }

  /** 所有被登记过的依赖文件（供 watcher 监听工作区外的文件）。 */
  allDependencies(): string[] {
    return [...this.ownersByDependency.entries()]
      .filter(([, owners]) => owners.size > 0)
      .map(([key]) => this.dependencyPaths.get(key)!);
  }

  clear(): void {
    this.dependenciesByOwner.clear();
    this.ownersByDependency.clear();
    this.dependencyPaths.clear();
  }
}
