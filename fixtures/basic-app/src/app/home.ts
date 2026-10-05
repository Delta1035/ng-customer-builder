import { Component, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { GreetingCard } from '@acme/greeting-lib';
import { DeferredPanel } from './deferred/deferred-panel';

/** 内联模板 + 内联样式：验证 inline 资源、信号、表单与 partial-Ivy 库组件。 */
@Component({
  selector: 'app-home',
  imports: [FormsModule, GreetingCard, DeferredPanel],
  template: `
    <section class="home">
      <lib-greeting-card [name]="name()" />
      <label>名字：<input id="name-input" [ngModel]="name()" (ngModelChange)="name.set($event)" /></label>
      <button id="increment" (click)="count.update((c) => c + 1)">+1</button>
      <span id="count">{{ count() }}</span>
      <span id="double">{{ double() }}</span>

      @defer (on interaction(deferTrigger)) {
        <app-deferred-panel />
      } @placeholder {
        <span>点击按钮加载延迟块</span>
      }
      <button id="defer-trigger" #deferTrigger>加载延迟块</button>
    </section>
  `,
  styles: `
    .home {
      padding: 16px;
      border-left: 4px solid rgb(0, 150, 136);
    }
  `,
})
export class Home {
  protected readonly name = signal('Angular');
  protected readonly count = signal(0);
  protected readonly double = computed(() => this.count() * 2);
}
