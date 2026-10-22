import { Component, DestroyRef, inject } from '@angular/core';
import { Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { IonApp, IonRouterOutlet, ToastController } from '@ionic/angular';
import { merge } from 'rxjs';
import { NpcWebSocketService } from './core/services/npc-websocket.service';
import { AudioPlaybackService } from './core/services/audio-playback.service';
import { MicrophoneService } from './core/services/microphone.service';
import { SettingsService } from './core/services/settings.service';
import { ConversationStore } from './core/services/conversation.store';
import { StoriesService } from './core/services/stories.service';
import { OfflineAppService } from './core/services/offline-app.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [IonApp, IonRouterOutlet],
  template: '<ion-app><ion-router-outlet /></ion-app>',
})
export class AppComponent {
  constructor() {
    inject(StoriesService);
    inject(OfflineAppService);
    const ws = inject(NpcWebSocketService);
    const audio = inject(AudioPlaybackService);
    const microphone = inject(MicrophoneService);
    const settings = inject(SettingsService);
    const conversations = inject(ConversationStore);
    const router = inject(Router);
    const toast = inject(ToastController);
    const destroy = inject(DestroyRef);
    merge(ws.errors$, audio.errors$, settings.errors$, conversations.errors$)
      .pipe(takeUntilDestroyed(destroy))
      .subscribe((message) => {
        void toast
          .create({
            message,
            duration: 5500,
            position: 'top',
            buttons: [{ text: 'Fermer', role: 'cancel' }],
            cssClass: 'npc-toast',
          })
          .then((t) => t.present());
      });
    ws.connectionState$.pipe(takeUntilDestroyed(destroy)).subscribe((state) => {
      if (state !== 'connected') {
        microphone.cancel();
      }
      if (state === 'connected' && router.url.startsWith('/connection'))
        void router.navigateByUrl('/conversation', { replaceUrl: true });
    });
  }
}
