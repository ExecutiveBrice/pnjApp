import { Injectable } from '@angular/core';
import { ConversationMessage, NpcGmNotes } from '../models/protocol';

export interface SavedConversation {
  key: string;
  server: string;
  npc: string;
  updatedAt: number;
  messages: ConversationMessage[];
  gmNotes?: NpcGmNotes;
}

/** IndexedDB keeps PCM as binary data, without localStorage's small string quota. */
@Injectable({ providedIn: 'root' })
export class ConversationHistoryService {
  private database?: Promise<IDBDatabase>;

  async load(): Promise<SavedConversation[]> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('conversations', 'readonly');
      const request = transaction.objectStore('conversations').getAll();
      transaction.oncomplete = () => resolve(request.result as SavedConversation[]);
      transaction.onabort = transaction.onerror = () => reject(transaction.error);
    });
  }

  async save(conversation: SavedConversation): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('conversations', 'readwrite');
      transaction.objectStore('conversations').put(conversation);
      transaction.oncomplete = () => resolve();
      transaction.onabort = transaction.onerror = () => reject(transaction.error);
    });
  }

  private open(): Promise<IDBDatabase> {
    this.database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open('npc.conversations.v1', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('conversations', { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Stockage local occupé.'));
    });
    return this.database;
  }
}
