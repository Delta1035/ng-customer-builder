import { Routes } from '@angular/router';
import { Home } from './home';

export const routes: Routes = [
  { path: '', component: Home },
  // 懒加载路由：编译结果必须保留动态 import()，由 Rollup 拆成独立 chunk
  { path: 'lazy', loadChildren: () => import('./lazy/lazy.routes').then((m) => m.LAZY_ROUTES) },
  { path: '**', redirectTo: '' },
];
