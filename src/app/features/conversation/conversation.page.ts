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
  IonIcon,
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
import { ConversationStore } from '../../core/services/conversation.store';
import {
  ConversationMessage,
  SpeechNpc,
  NpcSpeechAction,
  NPC_SPEECH_ACTIONS,
} from '../../core/models/protocol';
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
    IonIcon,
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
  readonly conversations = inject(ConversationStore);
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
  readonly histories = toSignal(this.conversations.histories$, { initialValue: [] });
  readonly activeConversation = toSignal(this.conversations.active$, {
    initialValue: this.conversations.current,
  });
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
  readonly requestingMicrophone = signal(false);
  readonly speechCatalog = toSignal(this.ws.speechCatalog$, {
    initialValue: { type: 'gm_npc_list' as const, npcs: [] },
  });
  readonly speechPending = toSignal(this.ws.speechPending$, { initialValue: false });
  readonly speechTargetId = signal('');
  readonly speechActions = NPC_SPEECH_ACTIONS;
  readonly speechNpcGroups = computed(() => {
    const groups = new Map<string, SpeechNpc[]>();
    for (const npc of this.speechCatalog().npcs) {
      const separator = npc.id.lastIndexOf('/');
      const zone = separator > 0 ? npc.id.slice(0, separator) : '';
      const group = groups.get(zone);
      if (group) group.push(npc);
      else groups.set(zone, [npc]);
    }
    return Array.from(groups, ([zone, npcs]) => ({ zone, label: zone || 'Sans zone', npcs }));
  });
  readonly speechTarget = computed<SpeechNpc | undefined>(() => {
    const npcs = this.speechCatalog().npcs;
    return (
      npcs.find((npc) => npc.id === this.speechTargetId()) ??
      npcs.find((npc) => npc.active) ??
      npcs[0]
    );
  });
  readonly hasSpeechControls = computed(
    () => !!this.capabilities().secret_approval && !!this.speechCatalog().npcs.length,
  );
  readonly displayedNpc = computed(() =>
    this.hasSpeechControls() ? (this.speechTarget()?.name ?? this.npc()) : this.npcName(),
  );
  readonly displayedCharacter = computed(() => {
    const target = this.hasSpeechControls() ? this.speechTarget() : undefined;
    return target
      ? { ...this.npcs().find((npc) => npc.id === target.id), ...target }
      : this.selectedNpc();
  });
  readonly gmNotes = computed(() => {
    const target = this.hasSpeechControls() ? this.speechTarget() : undefined;
    if (!target) return this.activeConversation()?.gmNotes;
    return (
      target.gm_notes ??
      (target.active ? this.activeConversation()?.gmNotes : undefined) ??
      this.displayedCharacter()?.gm_notes
    );
  });
  readonly secretCount = computed(
    () => this.gmNotes()?.secret_count ?? this.gmNotes()?.secrets?.length,
  );
  private readonly expandedSecrets = signal<string | null>(null);
  private readonly characterKey = computed(() =>
    JSON.stringify([
      this.activeConversation()?.key,
      this.hasSpeechControls() ? this.speechTarget()?.id : this.npc(),
    ]),
  );
  readonly secretsOpen = computed(() => this.expandedSecrets() === this.characterKey());
  toggleSecrets(): void {
    const opening = !this.secretsOpen();
    this.expandedSecrets.set(opening ? this.characterKey() : null);
    const target = this.hasSpeechControls()
      ? this.speechTarget()
      : this.speechCatalog().npcs.find((npc) => npc.active);
    if (opening && this.connection() === 'connected' && target)
      this.ws.requestNpcSecrets(target.id);
  }
  readonly speechDisabled = computed(
    () =>
      this.connection() !== 'connected' ||
      !this.capabilities().secret_approval ||
      !this.speechTarget() ||
      this.speechPending() ||
      this.npcState() !== 'idle' ||
      this.recording() ||
      this.requestingMicrophone() ||
      this.converting() ||
      this.speaking(),
  );
  readonly reviewingDisclosures = signal(false);
  readonly microphoneDisabledReason = computed(() => {
    if (this.connection() !== 'connected') return 'Connectez-vous au serveur pour parler.';
    if (!this.microphone.available)
      return 'La capture micro n’est pas prise en charge sur cet appareil.';
    if (this.speechPending()) return 'Attendez la fin de la demande de parole du PNJ.';
    if (!this.capabilities().audio_input)
      return 'Le serveur n’a pas activé l’entrée vocale. Vérifiez sa configuration puis reconnectez-vous.';
    return '';
  });
  readonly visualState = computed(() =>
    this.recording()
      ? 'recording'
      : this.converting() || this.speechPending()
        ? 'processing'
        : this.speaking()
          ? 'speaking'
          : this.npcState(),
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
    if (
      !this.text.trim() ||
      !this.ws.connected ||
      !this.capabilities().text_input ||
      this.speechPending()
    )
      return;
    void this.audio.unlock().catch(() => undefined);
    if (this.speaking() || this.npcState() === 'speaking') this.stopSpeaking();
    this.ws.say(this.text);
    this.text = '';
  }
  selectSpeechTarget(id: string): void {
    if (this.speechDisabled() || !this.speechCatalog().npcs.some((npc) => npc.id === id)) return;
    this.speechTargetId.set(id);
    if (this.capabilities().npc_switch) {
      this.cancelRecording();
      this.stopSpeaking();
      this.ws.switchNpc(id);
    }
  }
  speakNpc(action: NpcSpeechAction): void {
    const target = this.speechTarget();
    if (this.speechDisabled() || !target) return;
    void this.audio.unlock().catch(() => undefined);
    this.ws.speakNpc(target.id, action);
  }
  async startRecording(): Promise<void> {
    const gesture = ++this.gesture;
    if (!this.ws.connected || !this.capabilities().audio_input || this.speechPending()) return;
    void this.audio.unlock().catch(() => undefined);
    if (this.speaking() || this.npcState() === 'speaking') this.stopSpeaking();
    this.requestingMicrophone.set(true);
    try {
      await this.microphone.start();
    } catch (error: unknown) {
      if (gesture === this.gesture) this.notify(error);
    } finally {
      if (gesture === this.gesture) this.requestingMicrophone.set(false);
    }
  }
  async finishRecording(): Promise<void> {
    const gesture = ++this.gesture;
    this.requestingMicrophone.set(false);
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
    this.requestingMicrophone.set(false);
    this.converting.set(false);
  }
  stopSpeaking(): void {
    this.audio.stop();
    if (this.ws.connected) this.ws.stopSpeaking();
  }
  replay(message: ConversationMessage): void {
    this.cancelRecording();
    if (this.ws.connected) this.ws.stopSpeaking();
    void this.audio.replay(message);
  }
  async selectNpc(): Promise<void> {
    this.cancelRecording();
    this.stopSpeaking();
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
