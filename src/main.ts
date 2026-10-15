import { provideZoneChangeDetection } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter, RouteReuseStrategy, withComponentInputBinding } from '@angular/router';
import { IonicRouteStrategy, provideIonicAngular } from '@ionic/angular';
import { AppComponent } from './app/app.component';
import { routes } from './app/app.routes';

bootstrapApplication(AppComponent, {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideIonicAngular({ mode: 'md' }),
    { provide: RouteReuseStrategy, useClass: IonicRouteStrategy },
    provideRouter(routes, withComponentInputBinding()),
  ],
}).catch((error: unknown) => console.error(error));
