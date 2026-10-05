import { Component, computed, inject, input } from '@angular/core';
import { GreetingService } from './greeting.service';

@Component({
  selector: 'lib-greeting-card',
  template: `<p class="greeting" id="lib-greeting">{{ text() }}</p>`,
  styles: `
    .greeting {
      color: rgb(0, 128, 0);
    }
  `,
})
export class GreetingCard {
  readonly name = input.required<string>();
  private readonly service = inject(GreetingService);
  protected readonly text = computed(() => this.service.greet(this.name()));
}
