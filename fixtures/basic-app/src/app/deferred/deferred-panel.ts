import { Component } from '@angular/core';

/** 只在 @defer 块中使用：Angular 会生成动态 import，Rollup 把它拆成单独的 chunk。 */
@Component({
  selector: 'app-deferred-panel',
  template: `<p id="deferred-content">延迟块已加载</p>`,
})
export class DeferredPanel {}
