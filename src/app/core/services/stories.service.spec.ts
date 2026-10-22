import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BehaviorSubject, Subject } from 'rxjs';
import { StudioCatalogEvent, StudioStory } from '../models/protocol';
import { NpcWebSocketService } from './npc-websocket.service';
import { StoriesService, storyUrl, validateStoryAudio } from './stories.service';
import { StoryLibrary, StoryStorageService, storyAudioKey } from './story-storage.service';

const server = 'ws://localhost:8766/ws';
const campaign = 'a'.repeat(32);
const other = 'b'.repeat(32);
const story: StudioStory = {
  id: '1'.repeat(32),
  title: 'La forêt',
  text: 'Il était une fois…',
  description: '',
  language: 'French',
  created_at: '2026-10-22T12:00:00Z',
  duration: 1,
  audio_url: `/studio/audio/${'1'.repeat(32)}.wav`,
};
function wav(): Blob {
  const data = new ArrayBuffer(48);
  const view = new DataView(data);
  new Uint8Array(data).set(new TextEncoder().encode('RIFF'));
  view.setUint32(4, 40, true);
  new Uint8Array(data, 8).set(new TextEncoder().encode('WAVE'));
  return new Blob([data], { type: 'audio/wav' });
}
class MemoryStorage extends StoryStorageService {
  libraries: StoryLibrary[] = [];
  blobs = new Map<string, Blob>();
  selected?: string;
  fail = false;
  override async load() {
    return { libraries: structuredClone(this.libraries), selected: this.selected };
  }
  override async save(library: StoryLibrary, audio?: { id: string; blob: Blob }, remove?: string) {
    if (this.fail) throw new Error('Quota');
    this.libraries = [
      ...this.libraries.filter((item) => item.key !== library.key),
      structuredClone(library),
    ];
    if (audio) this.blobs.set(storyAudioKey(library.key, audio.id), audio.blob);
    if (remove) this.blobs.delete(storyAudioKey(library.key, remove));
  }
  override async select(key: string) {
    this.selected = key;
  }
  override async audio(key: string, id: string) {
    return this.blobs.get(storyAudioKey(key, id));
  }
}

describe('campaign story library', () => {
  let storage: MemoryStorage;
  let ws: {
    connectionState$: BehaviorSubject<string>;
    studioCatalog$: Subject<{ server: string; catalog: StudioCatalogEvent }>;
    connected: boolean;
    serverEndpoint: string;
  };
  let service: StoriesService;
  const flush = async () => {
    for (let i = 0; i < 15; i++) await Promise.resolve();
  };
  const catalog = async (id = campaign, stories = [story]) => {
    ws.studioCatalog$.next({
      server,
      catalog: { type: 'studio_catalog', campaign_id: id, stories },
    });
    await flush();
  };
  beforeEach(() => {
    storage = new MemoryStorage();
    ws = {
      connectionState$: new BehaviorSubject('connected'),
      studioCatalog$: new Subject(),
      connected: true,
      serverEndpoint: server,
    };
    vi.stubGlobal('navigator', { storage: { persist: vi.fn().mockResolvedValue(false) } });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(
          async () => new Response(wav(), { headers: { 'Content-Type': 'audio/wav' } }),
        ),
    );
    service = new StoriesService(storage, ws as unknown as NpcWebSocketService);
  });
  afterEach(() => {
    service.ngOnDestroy();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('lists stories even without a synthesis model and plays from the matching server', async () => {
    await catalog();
    expect(service.selected()?.stories).toEqual([story]);
    expect(service.online()).toBe(true);
    expect(await service.audio(story)).toEqual({
      url: 'http://localhost:8766' + story.audio_url,
      local: false,
    });
  });
  it('restores text and downloaded audio after a restart without any server', async () => {
    await catalog();
    await service.download(story);
    expect(service.selected()?.downloaded).toEqual([story.id]);
    service.ngOnDestroy();
    ws.connected = false;
    ws.connectionState$.next('disconnected');
    service = new StoriesService(storage, ws as unknown as NpcWebSocketService);
    await flush();
    const url = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:saved-story');
    expect(service.selected()?.stories[0].text).toBe(story.text);
    expect(await service.audio(story)).toEqual({ url: 'blob:saved-story', local: true });
    expect(url).toHaveBeenCalledWith(storage.blobs.values().next().value);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('isolates identical story IDs across campaigns and keeps removed downloaded stories', async () => {
    await catalog();
    await service.download(story);
    const firstKey = service.selectedKey();
    await catalog(campaign, []);
    expect(service.selected()?.stories).toEqual([story]);
    await catalog(other);
    expect(service.selected()?.downloaded).toEqual([]);
    await service.select(firstKey);
    expect(service.online()).toBe(false);
    expect(service.selected()?.downloaded).toEqual([story.id]);
    await service.remove(story);
    expect(storage.blobs.size).toBe(0);
    expect(service.selected()?.stories).toEqual([story]);
  });
  it('does not advertise failed, partial or quota-exceeding downloads as offline', async () => {
    await catalog();
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(wav(), { status: 206, headers: { 'Content-Type': 'audio/wav' } }),
    );
    await service.download(story);
    expect(service.selected()?.downloaded).toEqual([]);
    storage.fail = true;
    await service.download(story);
    expect(service.selected()?.downloaded).toEqual([]);
    expect(service.error()).not.toBe('');
    expect(service.downloading().size).toBe(0);
  });
  it('finishes a download in its original campaign when the user changes campaign', async () => {
    await catalog();
    const key = service.selectedKey();
    let complete!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const download = service.download(story);
    await catalog(other);
    complete(new Response(wav(), { headers: { 'Content-Type': 'audio/wav' } }));
    await download;
    expect(service.selected()?.campaignId).toBe(other);
    expect(service.selected()?.downloaded).toEqual([]);
    expect(service.libraries().find((library) => library.key === key)?.downloaded).toEqual([
      story.id,
    ]);
  });
  it('never uses a stale campaign catalog for online playback after reconnecting', async () => {
    await catalog();
    ws.connected = false;
    ws.connectionState$.next('disconnected');
    ws.connected = true;
    ws.connectionState$.next('connected');
    expect(service.online()).toBe(false);
    await expect(service.audio(story)).rejects.toThrow('Téléchargez');
  });
  it('keeps online playback usable when IndexedDB is blocked', async () => {
    storage.fail = true;
    await catalog();
    expect(service.online()).toBe(true);
    expect((await service.audio(story)).local).toBe(false);
    expect(service.error()).toContain('enregistrement');
  });
});

describe('story download validation', () => {
  it('converts WSS to HTTPS and discards WebSocket path/query', () => {
    expect(storyUrl('wss://example.org:123/proxy/ws?token=x', story)).toBe(
      'https://example.org:123' + story.audio_url,
    );
    expect(() =>
      storyUrl(server, { ...story, audio_url: 'https://evil.example/audio.wav' }),
    ).toThrow();
  });
  it('rejects error pages and WAVs whose declared size is truncated', async () => {
    await expect(validateStoryAudio(new Response('<html>error</html>'))).rejects.toThrow();
    const truncated = (await wav().arrayBuffer()).slice(0, 44);
    await expect(
      validateStoryAudio(new Response(truncated, { headers: { 'Content-Type': 'audio/wav' } })),
    ).rejects.toThrow('incomplet');
  });
});
