import { bootstrapApplication } from '@angular/platform-browser';
import { App } from './app/app';
import { appConfig } from './app/app.config';

if (!('__polyfillLoadedAt' in globalThis)) {
  throw new Error('polyfills 未在应用之前执行');
}

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
