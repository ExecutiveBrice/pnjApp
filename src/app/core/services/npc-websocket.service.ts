import { Inject, Injectable, InjectionToken, OnDestroy } from '@angular/core';
import { BehaviorSubject, Subject, distinctUntilChanged, map } from 'rxjs';
import {
  AudioPacket,
  Capabilities,
  ClientCommand,
  ConnectionState,
  DEFAULT_CAPABILITIES,
  GmNpcListEvent,
  Npc,
  NpcState,
  ServerEvent,
  StudioCatalogEvent,
  DisclosureDecision,
  SecretDisclosure,
  eventType,
  parseServerEvent,
} from '../models/protocol';
import { SettingsService } from './settings.service';
import { ConversationStore } from './conversation.store';
import { logger } from '../../shared/utils/logger';

export const WS_FACTORY = new InjectionToken<(url: string) => WebSocket>('WS_FACTORY', {
  providedIn: 'root',
  factory: () => (url) => new WebSocket(url),
});
@Injectable({ providedIn: 'root' })
export class NpcWebSocketService implements OnDestroy {
  private readonly connection = new BehaviorSubject<ConnectionState>('disconnected');
  private readonly npcState = new BehaviorSubject<NpcState>('idle');
  private readonly capabilities = new BehaviorSubject<Capabilities>({ ...DEFAULT_CAPABILITIES });
  private readonly npcs = new BehaviorSubject<Npc[]>([]);
  private readonly disclosures = new BehaviorSubject<SecretDisclosure[]>([]);
  private readonly disclosuresSynced = new BehaviorSubject(false);
  private readonly disclosureTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly audio = new Subject<AudioPacket>();
  private readonly speechCatalog = new BehaviorSubject<GmNpcListEvent>({
    type: 'gm_npc_list',
    npcs: [],
    speech_attitudes: [],
  });
  private readonly speechPending = new BehaviorSubject(false);
  readonly connectionState$ = this.connection.asObservable();
  readonly npc$;
  readonly npcState$ = this.npcState.asObservable();
  readonly capabilities$ = this.capabilities.asObservable();
  readonly npcs$ = this.npcs.asObservable();
  readonly disclosures$ = this.disclosures.asObservable();
  readonly disclosuresSynced$ = this.disclosuresSynced.asObservable();
  readonly audio$ = this.audio.asObservable();
  readonly speechCatalog$ = this.speechCatalog.asObservable();
  readonly speechPending$ = this.speechPending.asObservable();
  readonly messages$;
  readonly errors$ = new Subject<string>();
  readonly studioCatalog$ = new Subject<{ server: string; catalog: StudioCatalogEvent }>();
  private socket?: WebSocket;
  private endpoint = '';
  private stopped = true;
  private attempts = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private helloTimer?: ReturnType<typeof setTimeout>;
  private audioReceiving = false;
  private readonly settingsSubscription;

  constructor(
    private readonly settings: SettingsService,
    private readonly store: ConversationStore,
    @Inject(WS_FACTORY) private readonly socketFactory: (url: string) => WebSocket,
  ) {
    this.messages$ = store.messages$;
    this.npc$ = store.active$.pipe(
      map((conversation) => conversation?.npc ?? ''),
      distinctUntilChanged(),
    );
    this.settingsSubscription = settings.settings$.subscribe((value) => {
      if (!value.autoReconnect && this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
        this.connection.next('disconnected');
      }
    });
  }
  get connected(): boolean {
    return this.connection.value === 'connected';
  }
  get serverEndpoint(): string {
    return this.endpoint;
  }
  requestStories(): void {
    this.send({ type: 'studio_list' });
  }
  get state(): ConnectionState {
    return this.connection.value;
  }
  get currentNpcState(): NpcState {
    return this.npcState.value;
  }
  get currentCapabilities(): Capabilities {
    return this.capabilities.value;
  }
  connect(url: string): void {
    this.disconnect();
    this.endpoint = url;
    this.stopped = false;
    this.attempts = 0;
    this.open(false);
  }
  disconnect(): void {
    this.stopped = true;
    this.clearTimers();
    this.releaseSocket();
    this.resetSession();
    this.connection.next('disconnected');
  }
  say(text: string): void {
    const trimmed = text.trim();
    if (!trimmed || !this.capabilities.value.text_input) return;
    if (this.send({ type: 'say', text: trimmed })) this.store.player(trimmed, true);
  }
  speakNpc(npc: string, attitude: string): boolean {
    if (
      !this.connected ||
      !this.capabilities.value.secret_approval ||
      this.npcState.value !== 'idle' ||
      this.speechPending.value ||
      !this.speechCatalog.value.npcs.some((item) => item.id === npc) ||
      !this.speechCatalog.value.speech_attitudes.some((item) => item.id === attitude)
    )
      return false;
    this.speechPending.next(true);
    const sent = this.send({ type: 'speak_npc', npc, attitude });
    if (!sent) this.speechPending.next(false);
    return sent;
  }
  switchNpc(id: string): void {
    if (this.capabilities.value.npc_switch && id.trim())
      this.send({ type: 'switch_npc', npc: id.trim() });
  }
  stopSpeaking(): void {
    this.audioReceiving = false;
    this.audio.next({ type: 'reset' });
    this.store.interrupt();
    this.send({ type: 'stop_speaking' });
  }
  requestStatus(): void {
    this.send({ type: 'status' });
  }
  resolveDisclosure(requestId: string, decision: DisclosureDecision): void {
    if (!this.connected || !this.capabilities.value.secret_approval) return;
    if (decision !== 'approved' && decision !== 'rejected') return;
    const request = this.disclosures.value.find((item) => item.request_id === requestId);
    if (request?.status !== 'pending') return;
    if (!this.send({ type: 'resolve_secret_disclosure', request_id: requestId, decision })) return;
    this.disclosures.next(
      this.disclosures.value.map((item) =>
        item.request_id === requestId ? { ...item, status: 'sending' } : item,
      ),
    );
    this.disclosureTimers.set(
      requestId,
      setTimeout(() => {
        this.disclosureTimers.delete(requestId);
        this.disclosures.next(
          this.disclosures.value.map((item) =>
            item.request_id === requestId && item.status === 'sending'
              ? { ...item, status: 'pending' }
              : item,
          ),
        );
        this.errors$.next(
          'La décision n’a pas été confirmée. Actualisation des demandes ; vous pouvez réessayer.',
        );
        this.requestStatus();
      }, 10000),
    );
  }
  sendAudio(pcm: ArrayBuffer): boolean {
    if (!this.capabilities.value.audio_input || !pcm.byteLength || pcm.byteLength % 2) return false;
    const recordingId = this.store.playerRecording(pcm);
    if (
      !this.send({
        type: 'audio_input_start',
        sample_rate: 16000,
        channels: 1,
        format: 'pcm_s16le',
      })
    ) {
      this.store.forgetPlayerTranscription(recordingId);
      return false;
    }
    try {
      for (let offset = 0; offset < pcm.byteLength; offset += 32768) {
        if (!this.connected || !this.socket) throw new Error('Connexion interrompue.');
        this.socket.send(pcm.slice(offset, offset + 32768));
      }
      const sent = this.send({ type: 'audio_input_end' });
      if (!sent) this.store.forgetPlayerTranscription(recordingId);
      return sent;
    } catch {
      this.store.forgetPlayerTranscription(recordingId);
      this.errors$.next('L’envoi audio a été interrompu. Reconnectez-vous avant de réessayer.');
      this.socket?.close();
      return false;
    }
  }
  ngOnDestroy(): void {
    this.disconnect();
    this.settingsSubscription.unsubscribe();
  }
  private open(reconnecting: boolean): void {
    this.connection.next(reconnecting ? 'reconnecting' : 'connecting');
    this.resetSession();
    let socket: WebSocket;
    try {
      socket = this.socketFactory(this.endpoint);
    } catch {
      this.failed('Impossible d’ouvrir cette adresse WebSocket.');
      return;
    }
    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    // Covers both an unreachable host and a server which never sends hello.
    this.helloTimer = setTimeout(() => {
      if (this.socket !== socket) return;
      this.releaseSocket();
      this.failed('Le serveur n’a pas envoyé hello dans les 10 secondes.');
    }, 10000);
    socket.onopen = () => logger.debug('WS', 'connected; waiting for hello');
    socket.onmessage = (event) => {
      if (this.socket === socket) this.receive(event.data as unknown);
    };
    socket.onerror = () => logger.warn('WS', 'network error');
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.failed('Connexion au serveur perdue. Vérifiez son adresse et votre réseau Wi-Fi.');
    };
  }
  private receive(data: unknown): void {
    if (data instanceof ArrayBuffer) {
      if (this.connected && this.audioReceiving) this.audio.next({ type: 'chunk', data });
      return;
    }
    if (typeof data !== 'string') return;
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      logger.warn('WS', 'Invalid JSON from server');
      return;
    }
    const event = parseServerEvent(raw);
    if (!event) {
      const known = [
        'hello',
        'state',
        'status',
        'gm_npc_list',
        'player_spoke',
        'npc_reply_chunk',
        'npc_replied',
        'npc_switched',
        'error',
        'audio_start',
        'audio_end',
        'npc_list',
        'studio_catalog',
        'secret_disclosure_requested',
        'secret_disclosure_list',
        'secret_disclosure_resolved',
      ];
      logger.warn(
        'WS',
        `${known.includes(eventType(raw)) ? 'Invalid server event' : 'Unknown server event'}: ${eventType(raw)}`,
      );
      return;
    }
    logger.debug('WS', `<- ${event.type}`);
    if (event.type === 'hello') {
      if (event.protocol !== 1) {
        this.disconnect();
        this.errors$.next(
          `Version du protocole non prise en charge : ${event.protocol}. Version attendue : 1.`,
        );
        return;
      }
      if (this.helloTimer) clearTimeout(this.helloTimer);
      this.helloTimer = undefined;
      this.attempts = 0;
      this.store.select(this.endpoint, event.npc, event.gm_notes);
      this.npcState.next(event.state);
      this.capabilities.next({ ...DEFAULT_CAPABILITIES, ...event.capabilities });
      this.connection.next('connected');
      this.requestStatus();
      // A false generation capability still allows listening to existing WAVs.
      if (
        event.capabilities?.voice_design !== undefined ||
        event.capabilities?.story_generation !== undefined
      )
        this.requestStories();
      return;
    }
    if (!this.connected) return;
    this.handle(event);
  }
  private handle(event: Exclude<ServerEvent, { type: 'hello' }>): void {
    switch (event.type) {
      case 'studio_catalog':
        this.studioCatalog$.next({ server: this.endpoint, catalog: event });
        break;
      case 'state':
      case 'status':
        this.speechPending.next(false);
        this.npcState.next(event.state);
        if (event.state === 'idle') this.store.interrupt();
        break;
      case 'gm_npc_list':
        if (this.capabilities.value.secret_approval) this.speechCatalog.next(event);
        break;
      case 'player_spoke':
        this.store.player(event.text);
        break;
      case 'npc_reply_chunk':
        this.store.reply(event.npc, event.text, false);
        break;
      case 'npc_replied':
        this.store.reply(event.npc, event.text, true);
        break;
      case 'npc_switched':
        this.audioReceiving = false;
        this.audio.next({ type: 'reset' });
        this.store.interrupt();
        this.store.select(
          this.endpoint,
          event.npc,
          event.gm_notes ?? this.npcs.value.find((npc) => npc.name === event.npc)?.gm_notes,
        );
        this.npcState.next('idle');
        this.store.system(`Vous parlez maintenant avec ${event.npc}.`);
        break;
      case 'npc_list':
        this.npcs.next(event.npcs);
        {
          const notes = event.npcs.find((npc) => npc.name === this.store.current?.npc)?.gm_notes;
          if (notes !== undefined) this.store.setGmNotes(notes);
        }
        break;
      case 'secret_disclosure_requested':
        if (
          this.capabilities.value.secret_approval &&
          !this.disclosures.value.some((item) => item.request_id === event.request_id)
        ) {
          this.disclosures.next([...this.disclosures.value, { ...event, status: 'pending' }]);
        }
        break;
      case 'secret_disclosure_list': {
        if (!this.capabilities.value.secret_approval) break;
        this.disclosuresSynced.next(true);
        const ids = new Set(event.requests.map((item) => item.request_id));
        for (const [id, timer] of this.disclosureTimers) {
          if (!ids.has(id)) {
            clearTimeout(timer);
            this.disclosureTimers.delete(id);
          }
        }
        // The server snapshot is authoritative, including after reconnecting.
        const history = this.disclosures.value
          .filter(
            (item) =>
              !ids.has(item.request_id) &&
              (item.status === 'approved' || item.status === 'rejected'),
          )
          .slice(-100);
        this.disclosures.next([
          ...history,
          ...event.requests.map((request) => ({
            ...request,
            status: this.disclosureTimers.has(request.request_id)
              ? ('sending' as const)
              : ('pending' as const),
          })),
        ]);
        break;
      }
      case 'secret_disclosure_resolved': {
        if (!this.capabilities.value.secret_approval) break;
        const request = this.disclosures.value.find((item) => item.request_id === event.request_id);
        if (!request || (request.status !== 'pending' && request.status !== 'sending')) break;
        clearTimeout(this.disclosureTimers.get(event.request_id));
        this.disclosureTimers.delete(event.request_id);
        const updated = this.disclosures.value.map((item) =>
          item.request_id === event.request_id ? { ...item, status: event.decision } : item,
        );
        this.disclosures.next([
          ...updated
            .filter((item) => item.status === 'approved' || item.status === 'rejected')
            .slice(-100),
          ...updated.filter((item) => item.status === 'pending' || item.status === 'sending'),
        ]);
        break;
      }
      case 'error':
        this.speechPending.next(false);
        this.errors$.next(event.message);
        break;
      case 'audio_start':
        // Output is accepted even with legacy hello (capabilities absent).
        this.audioReceiving = event.npc === this.store.current?.npc;
        if (this.audioReceiving) this.audio.next(event);
        break;
      case 'audio_end':
        if (this.audioReceiving) this.audio.next(event);
        this.audioReceiving = false;
        break;
    }
  }
  private send(command: ClientCommand): boolean {
    if (!this.connected || this.socket?.readyState !== 1) {
      this.errors$.next('Connectez-vous au serveur avant d’envoyer un message.');
      return false;
    }
    try {
      this.socket.send(JSON.stringify(command));
      logger.debug('WS', `-> ${command.type}`);
      return true;
    } catch {
      this.errors$.next('Impossible d’envoyer la commande.');
      return false;
    }
  }
  private failed(message: string): void {
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = undefined;
    this.resetSession();
    this.errors$.next(message);
    if (!this.stopped && this.settings.value.autoReconnect) {
      this.connection.next('reconnecting');
      const delay = [1000, 2000, 5000, 10000][Math.min(this.attempts++, 3)];
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        this.open(true);
      }, delay);
    } else this.connection.next('disconnected');
  }
  private resetSession(): void {
    this.speechPending.next(false);
    this.speechCatalog.next({ type: 'gm_npc_list', npcs: [], speech_attitudes: [] });
    this.audioReceiving = false;
    this.audio.next({ type: 'reset' });
    this.npcState.next('idle');
    this.capabilities.next({ ...DEFAULT_CAPABILITIES });
    this.npcs.next([]);
    for (const timer of this.disclosureTimers.values()) clearTimeout(timer);
    this.disclosureTimers.clear();
    this.disclosures.next([]);
    this.disclosuresSynced.next(false);
    this.store.interrupt();
  }
  private releaseSocket(): void {
    if (!this.socket) return;
    const socket = this.socket;
    this.socket = undefined;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.close();
  }
  private clearTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.retryTimer = undefined;
    this.helloTimer = undefined;
  }
}
