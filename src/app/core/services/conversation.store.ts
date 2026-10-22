import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import {
  ConversationAudio,
  ConversationMessage,
  NpcGmNotes,
  parseNpcGmNotes,
} from '../models/protocol';
import { ConversationHistoryService, SavedConversation } from './conversation-history.service';

@Injectable({ providedIn: 'root' })
export class ConversationStore {
  private readonly state = new BehaviorSubject<ConversationMessage[]>([]);
  private readonly selection = new BehaviorSubject<SavedConversation | undefined>(undefined);
  private readonly histories = new BehaviorSubject<SavedConversation[]>([]);
  private readonly conversations = new Map<string, SavedConversation>();
  readonly messages$ = this.state.asObservable();
  readonly active$ = this.selection.asObservable();
  readonly histories$ = this.histories.asObservable();
  readonly errors$ = new Subject<string>();
  readonly ready: Promise<void>;
  private pendingPlayerId?: string;
  private pendingPlayerRecordings: string[] = [];
  private storageErrorReported = false;
  private sequence = 0;

  constructor(private readonly history: ConversationHistoryService) {
    this.ready = this.restore();
  }
  get current(): SavedConversation | undefined {
    return this.selection.value;
  }
  get value(): readonly ConversationMessage[] {
    return this.state.value;
  }
  get hasHistory(): boolean {
    return this.conversations.size > 0;
  }
  select(server: string, npc: string, gmNotes?: NpcGmNotes): void {
    this.interrupt();
    const key = JSON.stringify([server, npc]);
    const conversation = this.conversations.get(key) ?? {
      key,
      server,
      npc,
      updatedAt: Date.now(),
      messages: [],
    };
    this.conversations.set(key, conversation);
    this.selection.next(conversation);
    this.publish();
    if (gmNotes !== undefined) this.setGmNotes(gmNotes);
  }
  setGmNotes(gmNotes: NpcGmNotes): void {
    if (!this.current) return;
    const conversation = { ...this.current, gmNotes };
    this.conversations.set(conversation.key, conversation);
    this.selection.next(conversation);
    this.update(conversation.messages);
  }
  openHistory(key: string): void {
    const conversation = this.conversations.get(key);
    if (conversation) this.select(conversation.server, conversation.npc);
  }
  player(text: string, optimistic = false): void {
    if (!this.current) return;
    if (!optimistic && this.pendingPlayerId) {
      const pending = this.value.find((m) => m.id === this.pendingPlayerId);
      this.pendingPlayerId = undefined;
      if (pending?.text === text) return;
    }
    if (!optimistic) {
      const recordingId = this.pendingPlayerRecordings.shift();
      if (recordingId && this.value.some((message) => message.id === recordingId)) {
        this.update(
          this.value.map((message) =>
            message.id === recordingId ? { ...message, text } : message,
          ),
        );
        return;
      }
    }
    const id = this.add({ speaker: 'player', text });
    if (optimistic) this.pendingPlayerId = id;
  }
  /** Keep the player's own PCM before sending it, even when the upload fails. */
  playerRecording(pcm: ArrayBuffer): string | undefined {
    if (!this.current || !pcm.byteLength || pcm.byteLength % 2) return undefined;
    const id = this.add({
      speaker: 'player',
      text: '',
      audio: [{ data: pcm.slice(0), rate: 16000 }],
    });
    this.pendingPlayerRecordings.push(id);
    return id;
  }
  forgetPlayerTranscription(id: string | undefined): void {
    this.pendingPlayerRecordings = this.pendingPlayerRecordings.filter((pending) => pending !== id);
  }
  reply(npc: string, text: string, final: boolean): void {
    if (this.current?.npc !== npc) return;
    this.pendingPlayerId = undefined;
    const current = this.value.at(-1);
    if (current?.speaker === 'npc' && current.streaming && current.npc === npc) {
      this.update(
        [
          ...this.value.slice(0, -1),
          { ...current, text: final ? text : current.text + text, streaming: !final },
        ],
        final,
      );
    } else {
      this.add({ speaker: 'npc', npc, text, streaming: !final }, final);
    }
  }
  /** Bind at audio_start so later text/player events cannot steal this recording. */
  audioMessage(npc: string): string | undefined {
    if (this.current?.npc !== npc) return undefined;
    const current = this.value.at(-1);
    if (current?.speaker === 'npc' && current.npc === npc) return current.id;
    return this.add({ speaker: 'npc', npc, text: '', streaming: true }, false);
  }
  attachAudio(id: string, clip: ConversationAudio): void {
    if (!clip.data.byteLength || clip.data.byteLength % 2) return;
    this.update(
      this.value.map((message) =>
        message.id === id ? { ...message, audio: [...(message.audio ?? []), clip] } : message,
      ),
    );
  }
  system(text: string): void {
    this.add({ speaker: 'system', text });
  }
  interrupt(): void {
    this.pendingPlayerId = undefined;
    this.pendingPlayerRecordings = [];
    if (this.value.some((message) => message.streaming)) {
      this.update(this.value.map((m) => (m.streaming ? { ...m, streaming: false } : m)));
    }
  }
  clear(): void {
    this.pendingPlayerId = undefined;
    this.pendingPlayerRecordings = [];
    this.update([]);
  }
  private add(message: Omit<ConversationMessage, 'id' | 'timestamp'>, persist = true): string {
    // randomUUID is unavailable on plain HTTP LAN origins.
    const id =
      globalThis.crypto?.randomUUID?.() ??
      `${Date.now()}-${++this.sequence}-${Math.random().toString(36).slice(2)}`;
    this.update([...this.value.slice(-499), { ...message, id, timestamp: new Date() }], persist);
    return id;
  }
  private update(messages: ConversationMessage[], persist = true): void {
    if (!this.current) return;
    const conversation = { ...this.current, messages, updatedAt: Date.now() };
    this.conversations.set(conversation.key, conversation);
    this.selection.next(conversation);
    this.publish();
    if (persist) {
      void this.ready
        .then(() => this.history.save(this.conversations.get(conversation.key)!))
        .catch(() => this.storageError());
    }
  }
  private publish(): void {
    this.state.next(this.current?.messages ?? []);
    this.histories.next([...this.conversations.values()].sort((a, b) => b.updatedAt - a.updatedAt));
  }
  private async restore(): Promise<void> {
    try {
      for (const saved of await this.history.load()) {
        const messages = saved.messages.slice(-500).map((message) => ({
          ...message,
          timestamp: new Date(message.timestamp),
          ...(message.streaming ? { streaming: false } : {}),
        }));
        const live = this.conversations.get(saved.key);
        const conversation = live
          ? {
              ...live,
              gmNotes: live.gmNotes ?? parseNpcGmNotes(saved.gmNotes),
              messages: [...messages, ...live.messages].slice(-500),
            }
          : { ...saved, gmNotes: parseNpcGmNotes(saved.gmNotes), messages };
        this.conversations.set(saved.key, conversation);
        if (this.current?.key === saved.key) this.selection.next(conversation);
      }
      if (!this.current) {
        this.selection.next(
          [...this.conversations.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0],
        );
      }
      this.publish();
    } catch {
      this.storageError();
    }
  }
  private storageError(): void {
    if (this.storageErrorReported) return;
    this.storageErrorReported = true;
    this.errors$.next(
      'Le stockage local est indisponible ou plein. Les nouveaux échanges restent accessibles pendant cette session, mais ne seront pas conservés après fermeture.',
    );
  }
}
