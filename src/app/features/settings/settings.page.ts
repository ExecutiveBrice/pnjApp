import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonTitle,
  IonToggle,
  IonToolbar,
  ToastController,
} from '@ionic/angular';
import { addIcons } from 'ionicons';
import { arrowBackOutline } from 'ionicons/icons';
import { AppSettings, SettingsService } from '../../core/services/settings.service';
import { NpcWebSocketService } from '../../core/services/npc-websocket.service';
import { AudioPlaybackService } from '../../core/services/audio-playback.service';
import { buildEndpoint } from '../../shared/utils/endpoint';
@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [
    FormsModule,
    RouterLink,
    IonButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonIcon,
    IonTitle,
    IonToggle,
    IonToolbar,
  ],
  templateUrl: './settings.page.html',
  styles: [
    `
      .settings-main {
        max-width: 560px;
        margin: auto;
        padding: 28px 24px calc(32px + env(safe-area-inset-bottom));
      }
      h1 {
        font:
          34px Georgia,
          serif;
        margin: 0 0 10px;
      }
      .lead {
        color: var(--muted);
        font-size: 13px;
        line-height: 1.7;
        margin-bottom: 30px;
      }
      h2 {
        font-size: 10px;
        color: var(--gold);
        letter-spacing: 2px;
        margin: 30px 0 18px;
      }
      .settings-card {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 14px;
        padding: 22px;
      }
      .toggle-row {
        padding: 18px 0;
        border-bottom: 1px solid var(--line);
      }
      .toggle-row:first-child {
        padding-top: 0;
      }
      .toggle-row:last-child {
        border: 0;
        padding-bottom: 0;
      }
      .toggle-row p {
        font-size: 11px;
        color: var(--muted);
        line-height: 1.6;
        margin: 8px 0 0;
        max-width: 85%;
      }
      ion-toggle {
        width: 100%;
        font-size: 13px;
        --track-background: #3b443c;
        --track-background-checked: #bda16d;
        --handle-background: #dadfd1;
        --handle-background-checked: #fff0ce;
      }
      .volume {
        width: 100%;
        accent-color: var(--gold);
        padding: 0;
        margin-top: 15px;
        min-height: 44px;
      }
      output {
        float: right;
        color: var(--gold);
      }
      .save-button {
        margin-top: 26px;
        height: 48px;
      }
      .back-button {
        min-width: 44px;
      }
      .muted {
        font-size: 12px;
        line-height: 1.7;
      }
    `,
  ],
})
export class SettingsPage {
  private readonly settings = inject(SettingsService);
  readonly ws = inject(NpcWebSocketService);
  private readonly audio = inject(AudioPlaybackService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastController);
  form: AppSettings = { ...this.settings.value };
  error = '';
  constructor() {
    addIcons({ arrowBackOutline });
  }
  ionViewWillEnter(): void {
    this.form = { ...this.settings.value };
  }
  save(): void {
    try {
      if (this.form.host.trim()) buildEndpoint(this.form.host, Number(this.form.port));
      else if (
        !Number.isInteger(Number(this.form.port)) ||
        Number(this.form.port) < 1 ||
        Number(this.form.port) > 65535
      )
        throw new Error('Port invalide.');
      this.error = '';
      const endpointChanged =
        this.form.host.trim() !== this.settings.value.host ||
        Number(this.form.port) !== this.settings.value.port;
      this.settings.update({
        ...this.form,
        host: this.form.host.trim(),
        port: Number(this.form.port),
        volume: Number(this.form.volume),
      });
      if (!this.form.autoPlayAudio) this.audio.stop();
      if (endpointChanged && this.ws.state !== 'disconnected') {
        this.ws.disconnect();
        void this.router.navigateByUrl('/connection');
      }
      void this.toast
        .create({ message: 'Préférences enregistrées.', duration: 2200, position: 'bottom' })
        .then((t) => t.present());
    } catch (error: unknown) {
      this.error = error instanceof Error ? error.message : 'Configuration invalide.';
    }
  }
}
