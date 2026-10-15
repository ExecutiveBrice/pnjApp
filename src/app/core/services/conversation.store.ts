import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { ConversationMessage } from '../models/protocol';

@Injectable({ providedIn: 'root' })
export class ConversationStore {
  private readonly state = new BehaviorSubject<ConversationMessage[]>([]);
  readonly messages$ = this.state.asObservable();
  private sequence = 0;
  private pendingPlayerId?: string;
  get value(): readonly ConversationMessage[] {
    return this.state.value;
  }
  player(text: string, optimistic = false): void {
    if (!optimistic && this.pendingPlayerId) {
      const pending = this.state.value.find((m) => m.id === this.pendingPlayerId);
      this.pendingPlayerId = undefined;
      if (pending?.text === text) return;
    }
    const id = this.add({ speaker: 'player', text });
    if (optimistic) this.pendingPlayerId = id;
  }
  reply(npc: string, text: string, final: boolean): void {
    this.pendingPlayerId = undefined;
    const messages = this.state.value;
    const current = messages.at(-1);
    if (current?.speaker === 'npc' && current.streaming && current.npc === npc) {
      this.state.next([
        ...messages.slice(0, -1),
        { ...current, text: final ? text : current.text + text, streaming: !final },
      ]);
    } else {
      this.add({ speaker: 'npc', npc, text, streaming: !final });
    }
  }
  system(text: string): void {
    this.add({ speaker: 'system', text });
  }
  interrupt(): void {
    this.pendingPlayerId = undefined;
    this.state.next(this.state.value.map((m) => (m.streaming ? { ...m, streaming: false } : m)));
  }
  clear(): void {
    this.pendingPlayerId = undefined;
    this.state.next([]);
  }
  private add(message: Omit<ConversationMessage, 'id' | 'timestamp'>): string {
    const id = String(++this.sequence);
    // Bound session memory; history is deliberately never persisted.
    this.state.next([...this.state.value.slice(-499), { ...message, id, timestamp: new Date() }]);
    return id;
  }
}
