import { Routes } from '@angular/router';
import { LazyPage } from './lazy-page';
import { LazyDetail } from './lazy-detail';

export const LAZY_ROUTES: Routes = [
  { path: '', component: LazyPage },
  { path: 'detail', component: LazyDetail },
];
