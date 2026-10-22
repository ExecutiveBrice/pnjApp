import { Component, DestroyRef, ViewChild, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonFooter,
  IonHeader,
  IonIcon,
  IonToolbar,
  ModalController,
  ToastController,
} from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
  arrowUpOutline,
  chatbubbleOutline,
  chevronDownOutline,
  optionsOutline,
  powerOutline,
  stopOutline,
  volumeHighOutline,
} from 'ionicons/icons';
import { NpcWebSocketService } from '../../core/services/npc-websocket.service';
import { AudioPlaybackService } from '../../core/services/audio-playback.service';
import { MicrophoneService } from '../../core/services/microphone.service';
import { SettingsService } from '../../core/services/settings.service';
import { PushToTalkComponent } from '../../shared/components/push-to-talk.component';
import { ConnectionStatusComponent } from '../../shared/components/connection-status.component';
import { NpcPickerComponent } from './npc-picker.component';
import { SecretApprovalsComponent } from './secret-approvals.component';

@Component({
  selector: 'app-conversation',
  standalone: true,
  imports: [
    DatePipe,
    FormsModule,
    RouterLink,
    IonButton,
    IonButtons,
    IonContent,
    IonFooter,
    IonHeader,
    IonIcon,
    IonToolbar,
    PushToTalkComponent,
    ConnectionStatusComponent,
    SecretApprovalsComponent,
  ],
  templateUrl: './conversation.page.html',
  styleUrl: './conversation.page.scss',
})
export class ConversationPage {
  @ViewChild(IonContent) private content?: IonContent;
  readonly ws = inject(NpcWebSocketService);
  readonly audio = inject(AudioPlaybackService);
  readonly microphone = inject(MicrophoneService);
  private readonly settingsService = inject(SettingsService);
  private readonly modal = inject(ModalController);
  private readonly toast = inject(ToastController);
  readonly npc = toSignal(this.ws.npc$, { initialValue: '' });
  readonly npcs = toSignal(this.ws.npcs$, { initialValue: [] });
  readonly selectedNpc = computed(() =>
    this.npcs().find((character) => character.id === this.npc() || character.name === this.npc()),
  );
  readonly npcName = computed(() => this.selectedNpc()?.name || this.npc());
  readonly connection = toSignal(this.ws.connectionState$, { initialValue: this.ws.state });
  readonly npcState = toSignal(this.ws.npcState$, { initialValue: 'idle' });
  readonly capabilities = toSignal(this.ws.capabilities$, {
    initialValue: this.ws.currentCapabilities,
  });
  readonly messages = toSignal(this.ws.messages$, { initialValue: [] });
  readonly disclosures = toSignal(this.ws.disclosures$, { initialValue: [] });
  readonly pendingDisclosures = computed(
    () =>
      this.disclosures().filter((item) => item.status === 'pending' || item.status === 'sending')
        .length,
  );
  readonly settings = toSignal(this.settingsService.settings$, {
    initialValue: this.settingsService.value,
  });
  readonly recording = toSignal(this.microphone.recording$, { initialValue: false });
  readonly speaking = toSignal(this.audio.speaking$, { initialValue: false });
  readonly pendingAudio = toSignal(this.audio.pending$, { initialValue: false });
  readonly converting = signal(false);
  readonly reviewingDisclosures = signal(false);
  readonly microphoneDisabledReason = computed(() => {
    if (this.connection() !== 'connected') return 'Connectez-vous au serveur pour parler.';
    if (!this.microphone.available)
      return 'La capture micro n’est pas prise en charge sur cet appareil.';
    if (!this.capabilities().audio_input)
      return 'Le serveur n’a pas activé l’entrée vocale. Vérifiez sa configuration puis reconnectez-vous.';
    return '';
  });
  readonly visualState = computed(() =>
    this.recording()
      ? 'recording'
      : this.converting()
        ? 'processing'
        : this.speaking()
          ? 'speaking'
          : this.npcState(),
  );
  readonly stateLabel = computed(
    () =>
      ({
        idle: 'À votre écoute',
        recording: 'Je vous écoute…',
        processing: 'Réfléchit…',
        speaking: 'Prend la parole',
      })[this.visualState()],
  );
  text = '';
  textOpen = false;
  private gesture = 0;
  private active = false;
  constructor() {
    addIcons({
      arrowUpOutline,
      chatbubbleOutline,
      chevronDownOutline,
      optionsOutline,
      powerOutline,
      stopOutline,
      volumeHighOutline,
    });
    this.ws.messages$.pipe(takeUntilDestroyed(inject(DestroyRef))).subscribe(() => {
      if (this.active && !this.reviewingDisclosures())
        requestAnimationFrame(() => {
          void this.content?.scrollToBottom(180);
        });
    });
  }
  ionViewDidEnter(): void {
    this.active = true;
    if (this.pendingDisclosures()) this.showDisclosures();
    else void this.content?.scrollToBottom(0);
  }
  showDisclosures(): void {
    this.cancelRecording();
    this.reviewingDisclosures.set(true);
    requestAnimationFrame(() => void this.content?.scrollToTop(180));
  }
  ionViewWillLeave(): void {
    this.active = false;
    this.cancelRecording();
  }
  sendText(): void {
    if (!this.text.trim() || !this.ws.connected || !this.capabilities().text_input) return;
    void this.audio.unlock().catch(() => undefined);
    if (this.speaking() || this.npcState() === 'speaking') this.stopSpeaking();
    this.ws.say(this.text);
    this.text = '';
  }
  async startRecording(): Promise<void> {
    const gesture = ++this.gesture;
    if (!this.ws.connected || !this.capabilities().audio_input) return;
    void this.audio.unlock().catch(() => undefined);
    if (this.speaking() || this.npcState() === 'speaking') this.stopSpeaking();
    try {
      await this.microphone.start();
    } catch (error: unknown) {
      if (gesture === this.gesture) this.notify(error);
    }
  }
  async finishRecording(): Promise<void> {
    const gesture = ++this.gesture;
    this.converting.set(true);
    try {
      const pcm = await this.microphone.finish();
      if (pcm && gesture === this.gesture && this.ws.connected) this.ws.sendAudio(pcm);
    } catch (error: unknown) {
      if (gesture === this.gesture) this.notify(error);
    } finally {
      if (gesture === this.gesture) this.converting.set(false);
    }
  }
  cancelRecording(): void {
    ++this.gesture;
    this.microphone.cancel();
    this.converting.set(false);
  }
  stopSpeaking(): void {
    this.audio.stop();
    this.ws.stopSpeaking();
  }
  async selectNpc(): Promise<void> {
    this.cancelRecording();
    const modal = await this.modal.create({
      component: NpcPickerComponent,
      initialBreakpoint: 0.65,
      breakpoints: [0, 0.65, 1],
    });
    await modal.present();
  }
  private notify(error: unknown): void {
    const message = error instanceof Error ? error.message : 'Le microphone est indisponible.';
    void this.toast
      .create({ message, duration: 5500, position: 'top', buttons: ['Fermer'] })
      .then((toast) => toast.present());
  }
}
