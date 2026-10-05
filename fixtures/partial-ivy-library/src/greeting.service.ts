import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class GreetingService {
  greet(name: string): string {
    return `Hello, ${name}! (from partial-Ivy lib)`;
  }
}
