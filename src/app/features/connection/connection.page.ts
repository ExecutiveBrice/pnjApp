import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { IonButton, IonContent, IonIcon, IonSpinner } from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
  arrowForwardOutline,
  optionsOutline,
  radioOutline,
  shieldCheckmarkOutline,
} from 'ionicons/icons';
import { SettingsService } from '../../core/services/settings.service';
import { NpcWebSocketService } from '../../core/services/npc-websocket.service';
import { AudioPlaybackService } from '../../core/services/audio-playback.service';
import { buildEndpoint } from '../../shared/utils/endpoint';
import { ConnectionStatusComponent } from '../../shared/components/connection-status.component';

@Component({
  selector: 'app-connection',
  standalone: true,
  imports: [
    FormsModule,
    RouterLink,
    IonContent,
    IonButton,
    IonIcon,
    IonSpinner,
    ConnectionStatusComponent,
  ],
  templateUrl: './connection.page.html',
  styleUrl: './connection.page.scss',
})
export class ConnectionPage {
  readonly settings = inject(SettingsService);
  readonly ws = inject(NpcWebSocketService);
  private readonly audio = inject(AudioPlaybackService);
  readonly state = toSignal(this.ws.connectionState$, { initialValue: this.ws.state });
  host = this.settings.value.host;
  port = this.settings.value.port;
  error = '';
  constructor() {
    addIcons({ arrowForwardOutline, optionsOutline, radioOutline, shieldCheckmarkOutline });
  }
  ionViewWillEnter(): void {
    this.host = this.settings.value.host;
    this.port = this.settings.value.port;
  }
  get busy(): boolean {
    return this.state() === 'connecting' || this.state() === 'reconnecting';
  }
  connect(): void {
    try {
      const endpoint = buildEndpoint(this.host, Number(this.port));
      this.error = '';
      this.settings.update({ host: this.host.trim(), port: Number(this.port) });
      void this.audio.unlock().catch(() => undefined);
      this.ws.connect(endpoint);
    } catch (error: unknown) {
      this.error = error instanceof Error ? error.message : 'Adresse invalide.';
    }
  }
}
