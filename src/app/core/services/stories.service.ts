import { Injectable, OnDestroy, computed, signal } from '@angular/core';
import { Subscription } from 'rxjs';
import { StudioCatalogEvent, StudioStory } from '../models/protocol';
import { NpcWebSocketService } from './npc-websocket.service';
import { StoryLibrary, StoryStorageService, storyAudioKey } from './story-storage.service';

export function storyUrl(server: string, story: StudioStory): string {
  // Never fetch a URL supplied by catalog metadata outside the studio audio route.
  if (!/^[a-f0-9]{32}$/.test(story.id) || story.audio_url !== `/studio/audio/${story.id}.wav`)
    throw new Error('Adresse audio invalide.');
  const url = new URL(server);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = story.audio_url;
  url.search = '';
  url.hash = '';
  return url.href;
}

export async function validateStoryAudio(response: Response): Promise<Blob> {
  if (
    response.status !== 200 ||
    !response.headers.get('Content-Type')?.toLowerCase().startsWith('audio/wav')
  )
    throw new Error('Téléchargement audio incomplet.');
  const blob = await response.blob();
  const bytes = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const signature = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  if (
    blob.size < 44 ||
    signature(0, 4) !== 'RIFF' ||
    signature(8, 12) !== 'WAVE' ||
    new DataView(bytes.buffer).getUint32(4, true) + 8 !== blob.size
  )
    throw new Error('Le fichier WAV est invalide ou incomplet.');
  return blob;
}

@Injectable({ providedIn: 'root' })
export class StoriesService implements OnDestroy {
  readonly libraries = signal<StoryLibrary[]>([]);
  readonly selectedKey = signal('');
  readonly selected = computed(() =>
    this.libraries().find((library) => library.key === this.selectedKey()),
  );
  readonly downloading = signal<Set<string>>(new Set());
  readonly error = signal('');
  readonly restored = signal(false);
  private readonly connection = signal(false);
  private readonly liveKey = signal('');
  readonly online = computed(() => this.connection() && this.selectedKey() === this.liveKey());
  private pending: Promise<void>;
  private readonly subscriptions = new Subscription();
  private readonly controllers = new Set<AbortController>();
  private session = 0;

  constructor(
    private readonly storage: StoryStorageService,
    private readonly ws: NpcWebSocketService,
  ) {
    this.pending = this.restore();
    this.subscriptions.add(
      ws.connectionState$.subscribe((state) => {
        this.connection.set(state === 'connected');
        if (state !== 'connected') {
          this.liveKey.set('');
          ++this.session;
        }
      }),
    );
    this.subscriptions.add(
      ws.studioCatalog$.subscribe(({ server, catalog }) => {
        const session = this.session;
        void this.enqueue(() => this.catalog(server, catalog, session)).catch(() => undefined);
      }),
    );
  }

  async select(key: string): Promise<void> {
    if (!this.libraries().some((library) => library.key === key)) return;
    this.selectedKey.set(key);
    try {
      await this.storage.select(key);
    } catch {
      this.error.set(
        'La campagne reste accessible, mais sa sélection n’a pas pu être enregistrée.',
      );
    }
  }

  isDownloading(id: string): boolean {
    return this.downloading().has(storyAudioKey(this.selectedKey(), id));
  }

  async download(story: StudioStory): Promise<void> {
    const library = this.selected();
    if (!library || !this.online() || library.downloaded.includes(story.id)) return;
    const key = storyAudioKey(library.key, story.id);
    if (this.downloading().has(key)) return;
    const controller = new AbortController();
    this.controllers.add(controller);
    this.downloading.update((keys) => new Set([...keys, key]));
    this.error.set('');
    try {
      const response = await fetch(storyUrl(library.server, story), {
        cache: 'no-store',
        signal: controller.signal,
      });
      const blob = await validateStoryAudio(response);
      await this.enqueue(async () => {
        const current = this.libraries().find((item) => item.key === library.key);
        if (!current) return;
        const updated = {
          ...current,
          stories: current.stories.some((item) => item.id === story.id)
            ? current.stories.map((item) => (item.id === story.id ? story : item))
            : [...current.stories, story],
          downloaded: [...new Set([...current.downloaded, story.id])],
        };
        await this.storage.save(updated, { id: story.id, blob });
        this.update(updated);
      });
      // Persistence refusal is harmless; browsers may still evict local data.
      if (navigator.storage?.persist) void navigator.storage.persist().catch(() => false);
    } catch {
      this.error.set(
        'Impossible d’enregistrer l’histoire. Vérifiez la connexion au serveur et l’espace de stockage.',
      );
    } finally {
      this.controllers.delete(controller);
      this.downloading.update((keys) => {
        const next = new Set(keys);
        next.delete(key);
        return next;
      });
    }
  }

  async remove(story: StudioStory): Promise<void> {
    const key = this.selectedKey();
    await this.enqueue(async () => {
      const library = this.libraries().find((item) => item.key === key);
      if (!library) return;
      const updated = {
        ...library,
        downloaded: library.downloaded.filter((id) => id !== story.id),
      };
      await this.storage.save(updated, undefined, story.id);
      this.update(updated);
    });
  }

  async audio(story: StudioStory): Promise<{ url: string; local: boolean }> {
    const library = this.selected();
    if (!library) throw new Error('Sélectionnez une campagne.');
    if (library.downloaded.includes(story.id)) {
      const blob = await this.storage.audio(library.key, story.id);
      if (blob) return { url: URL.createObjectURL(blob), local: true };
      throw new Error(
        'L’enregistrement local est introuvable. Téléchargez à nouveau cette histoire.',
      );
    }
    if (this.online()) return { url: storyUrl(library.server, story), local: false };
    throw new Error(
      'Téléchargez cette histoire lorsque le serveur est connecté pour l’écouter hors ligne.',
    );
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe();
    for (const controller of this.controllers) controller.abort();
  }

  private async restore(): Promise<void> {
    try {
      const saved = await this.storage.load();
      this.libraries.set(saved.libraries);
      this.selectedKey.set(saved.selected ?? saved.libraries[0]?.key ?? '');
    } catch {
      this.error.set(
        'Le stockage local est indisponible. La lecture depuis le serveur reste possible.',
      );
    } finally {
      this.restored.set(true);
    }
  }

  private async catalog(
    server: string,
    catalog: StudioCatalogEvent,
    session: number,
  ): Promise<void> {
    const key = JSON.stringify([server, catalog.campaign_id]);
    const previous = this.libraries().find((library) => library.key === key);
    const downloaded = previous?.downloaded ?? [];
    // Keep downloaded stories even if they were removed from the PC's library.
    const stories = [
      ...catalog.stories.filter((story) => !downloaded.includes(story.id)),
      ...(previous?.stories.filter((story) => downloaded.includes(story.id)) ?? []),
    ];
    const library = { key, server, campaignId: catalog.campaign_id, stories, downloaded };
    this.update(library);
    if (this.ws.connected && this.ws.serverEndpoint === server && session === this.session) {
      this.liveKey.set(key);
      this.selectedKey.set(key);
    }
    try {
      await this.storage.save(library);
      await this.storage.select(this.selectedKey());
    } catch {
      this.error.set('Le catalogue est disponible, mais son enregistrement local a échoué.');
    }
  }

  private update(library: StoryLibrary): void {
    this.libraries.update((libraries) => [
      ...libraries.filter((item) => item.key !== library.key),
      library,
    ]);
  }

  private enqueue(action: () => Promise<void>): Promise<void> {
    const result = this.pending.then(action);
    this.pending = result.catch(() => {
      this.error.set('Impossible de mettre à jour la bibliothèque locale.');
    });
    return result;
  }
}
