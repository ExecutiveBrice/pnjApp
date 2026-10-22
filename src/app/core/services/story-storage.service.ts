import { Injectable } from '@angular/core';
import { StudioStory } from '../models/protocol';

export interface StoryLibrary {
  key: string;
  server: string;
  campaignId: string;
  stories: StudioStory[];
  downloaded: string[];
}
export const storyAudioKey = (library: string, id: string): string => JSON.stringify([library, id]);

/** WAV and metadata commit together: incomplete downloads never appear as saved. */
@Injectable({ providedIn: 'root' })
export class StoryStorageService {
  private database?: Promise<IDBDatabase>;

  async load(): Promise<{ libraries: StoryLibrary[]; selected?: string }> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['libraries', 'settings'], 'readonly');
      const libraries = tx.objectStore('libraries').getAll();
      const selected = tx.objectStore('settings').get('selected');
      tx.oncomplete = () => resolve({ libraries: libraries.result, selected: selected.result });
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
  }

  async save(
    library: StoryLibrary,
    audio?: { id: string; blob: Blob },
    remove?: string,
  ): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['libraries', 'audio'], 'readwrite');
      tx.objectStore('libraries').put(library);
      if (audio) tx.objectStore('audio').put(audio.blob, storyAudioKey(library.key, audio.id));
      if (remove) tx.objectStore('audio').delete(storyAudioKey(library.key, remove));
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
  }

  async select(key: string): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('settings', 'readwrite');
      tx.objectStore('settings').put(key, 'selected');
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
  }

  async audio(library: string, id: string): Promise<Blob | undefined> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('audio', 'readonly');
      const request = tx.objectStore('audio').get(storyAudioKey(library, id));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
  }

  private open(): Promise<IDBDatabase> {
    this.database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open('npc.stories.v1', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('libraries', { keyPath: 'key' });
        request.result.createObjectStore('audio');
        request.result.createObjectStore('settings');
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Stockage local occupé.'));
    });
    return this.database;
  }
}
