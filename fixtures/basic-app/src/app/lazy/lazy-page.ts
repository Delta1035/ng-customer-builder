import { Component, inject } from '@angular/core';
import { GreetingService } from '@acme/greeting-lib';

@Component({
  selector: 'app-lazy-page',
  templateUrl: './lazy-page.html',
  styleUrl: './lazy-page.css',
})
export class LazyPage {
  protected readonly message = inject(GreetingService).greet('lazy');
}
