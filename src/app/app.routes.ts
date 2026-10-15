import { Routes } from '@angular/router';
import { connectionGuard } from './core/guards/connection.guard';
export const routes: Routes = [
  {
    path: 'connection',
    loadComponent: () =>
      import('./features/connection/connection.page').then((m) => m.ConnectionPage),
  },
  {
    path: 'conversation',
    canActivate: [connectionGuard],
    loadComponent: () =>
      import('./features/conversation/conversation.page').then((m) => m.ConversationPage),
  },
  {
    path: 'settings',
    loadComponent: () => import('./features/settings/settings.page').then((m) => m.SettingsPage),
  },
  { path: '**', redirectTo: 'connection' },
];
