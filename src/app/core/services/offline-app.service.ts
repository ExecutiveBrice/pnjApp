import { Injectable, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { environment } from '../../../environments/environment';

@Injectable({ providedIn: 'root' })
export class OfflineAppService {
  readonly ready = signal(Capacitor.isNativePlatform());
  readonly unavailable = signal(false);

  constructor() {
    if (this.ready()) return;
    if (!environment.production || !window.isSecureContext || !('serviceWorker' in navigator)) {
      this.unavailable.set(true);
      return;
    }
    void this.register().catch(() => this.unavailable.set(true));
  }

  private async register(): Promise<void> {
    await navigator.serviceWorker.register(new URL('offline-sw.js', document.baseURI), {
      scope: new URL('./', document.baseURI).href,
    });
    await navigator.serviceWorker.ready;
    this.ready.set(true);
  }
}
