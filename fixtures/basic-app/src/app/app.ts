import { Component, isDevMode } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';
import { environment } from '../environments/environment';

/** 外部模板 + 外部样式的根组件。 */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly envName = environment.name;
  protected readonly devMode = isDevMode();
}
