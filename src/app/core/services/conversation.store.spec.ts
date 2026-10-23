import { describe, it, expect, vi } from 'vitest';
import { ConversationStore } from './conversation.store';
import { MemoryHistory } from '../../../../tests/conversation-history';

const createStore = (): ConversationStore => {
  const store = new ConversationStore(new MemoryHistory());
  store.select('ws://table/ws', 'Guide');
  return store;
};
describe('ConversationStore', () => {
  it('deletes every history and PCM after draining an in-flight write', async () => {
    const history = new MemoryHistory();
    const store = new ConversationStore(history);
    await store.ready;
    let finishSave!: () => void;
    const saving = new Promise<void>((resolve) => (finishSave = resolve));
    vi.spyOn(history, 'save').mockImplementation(async (conversation) => {
      await saving;
      history.saved.set(conversation.key, structuredClone(conversation));
    });
    store.select('ws://table/ws', 'Guide', { secrets: ['Une clé cachée'] });
    store.playerRecording(new ArrayBuffer(4));
    store.select('ws://other/ws', 'Sentinelle');
    store.player('Autre serveur');
    await vi.waitFor(() => expect(history.save).toHaveBeenCalled());
    const cleared = store.clearAll();
    finishSave();
    await cleared;
    expect(store.current).toBeUndefined();
    expect(store.value).toEqual([]);
    expect(store.hasHistory).toBe(false);
    expect(history.saved.size).toBe(0);
    const restored = new ConversationStore(history);
    await restored.ready;
    expect(restored.hasHistory).toBe(false);
  });
  it('waits for history restoration before clearing and reports a failed deletion', async () => {
    const history = new MemoryHistory();
    let restore!: (value: Awaited<ReturnType<MemoryHistory['load']>>) => void;
    vi.spyOn(history, 'load').mockReturnValue(new Promise((resolve) => (restore = resolve)));
    const store = new ConversationStore(history);
    const cleared = store.clearAll();
    restore([{ key: 'old', server: 'ws://table/ws', npc: 'Guide', updatedAt: 1, messages: [] }]);
    await cleared;
    expect(store.hasHistory).toBe(false);
    vi.spyOn(history, 'clear').mockRejectedValue(new Error('Stockage indisponible'));
    await expect(store.clearAll()).rejects.toThrow('Stockage indisponible');
  });
  it('persists GM notes without messages, isolates servers and restores them offline', async () => {
    const history = new MemoryHistory();
    const store = new ConversationStore(history);
    await store.ready;
    const notes = { behavior: 'Observe les issues', secret_count: 1, secrets: ['Cache une clé.'] };
    store.select('ws://table/ws', 'Guide', notes);
    await vi.waitFor(() => expect(history.saved.size).toBe(1));
    store.select('ws://other/ws', 'Guide');
    expect(store.current?.gmNotes).toBeUndefined();
    store.select('ws://table/ws', 'Guide');
    expect(store.current?.gmNotes).toEqual(notes);
    const restored = new ConversationStore(history);
    await restored.ready;
    expect(restored.current?.gmNotes).toEqual(notes);
    expect(restored.value).toEqual([]);
  });
  it('retains cached GM notes when a legacy server connects before history loads', async () => {
    const history = new MemoryHistory();
    const key = JSON.stringify(['ws://table/ws', 'Guide']);
    history.saved.set(key, {
      key,
      server: 'ws://table/ws',
      npc: 'Guide',
      updatedAt: 1,
      messages: [],
      gmNotes: { motivation: 'Protéger sa famille', secret_count: 2 },
    });
    const store = new ConversationStore(history);
    store.select('ws://table/ws', 'Guide');
    await store.ready;
    expect(store.current?.gmNotes).toEqual({ motivation: 'Protéger sa famille', secret_count: 2 });
  });
  it('keeps fresh GM notes over cached notes while restoring history', async () => {
    const history = new MemoryHistory();
    const key = JSON.stringify(['ws://table/ws', 'Guide']);
    history.saved.set(key, {
      key,
      server: 'ws://table/ws',
      npc: 'Guide',
      updatedAt: 1,
      messages: [],
      gmNotes: { secret_count: 3 },
    });
    const store = new ConversationStore(history);
    store.select('ws://table/ws', 'Guide', { secret_count: 0 });
    await store.ready;
    await vi.waitFor(() => expect(history.saved.get(key)?.gmNotes).toEqual({ secret_count: 0 }));
    expect(store.current?.gmNotes).toEqual({ secret_count: 0 });
  });
  it('adds timestamped player messages', () => {
    const store = createStore();
    store.player('Bonjour');
    expect(store.value[0]).toMatchObject({
      speaker: 'player',
      text: 'Bonjour',
      timestamp: expect.any(Date),
    });
  });
  it('creates and concatenates one streaming reply then replaces it with final text', () => {
    const store = createStore();
    store.reply('Guide', 'Pre', false);
    const id = store.value[0].id;
    store.reply('Guide', 'nez place', false);
    expect(store.value).toHaveLength(1);
    expect(store.value[0].text).toBe('Prenez place');
    expect(store.value[0].streaming).toBe(true);
    store.reply('Guide', 'Prenez place !', true);
    expect(store.value[0]).toMatchObject({ id, text: 'Prenez place !', streaming: false });
    store.reply('Guide', 'Autre réponse', true);
    expect(store.value).toHaveLength(2);
  });
  it('keeps different speakers and interrupted turns separate', () => {
    const store = createStore();
    store.reply('Guide', 'A', false);
    store.interrupt();
    store.reply('Guide', 'B', false);
    expect(store.value).toHaveLength(2);
    store.reply('Other', 'C', true);
    expect(store.value).toHaveLength(2);
  });
  it('deduplicates only the pending optimistic echo', () => {
    const store = createStore();
    store.player('Oui', true);
    store.player('Oui');
    store.reply('Guide', 'D’accord', true);
    store.player('Oui');
    expect(store.value.filter((message) => message.speaker === 'player')).toHaveLength(2);
  });
  it('restores the complete conversation when returning to a PNJ and isolates servers', () => {
    const store = createStore();
    store.player('Bonjour', true);
    store.reply('Guide', 'Bienvenue', true);
    const original = [...store.value];
    store.select('ws://table/ws', 'Sentinelle');
    expect(store.value).toEqual([]);
    store.player('Qui va là ?');
    store.select('ws://other/ws', 'Guide');
    expect(store.value).toEqual([]);
    store.select('ws://table/ws', 'Guide');
    expect(store.value).toEqual(original);
  });
  it('retains PCM and timestamps after closing and reopening the store', async () => {
    const history = new MemoryHistory();
    const store = new ConversationStore(history);
    await store.ready;
    store.select('ws://table/ws', 'Guide');
    store.player('Bonjour');
    store.reply('Guide', 'Bienvenue', true);
    const id = store.audioMessage('Guide')!;
    store.attachAudio(id, { data: new Uint8Array([0, 128, 255, 127]).buffer, rate: 22050 });
    await vi.waitFor(() => expect(history.saved.size).toBe(1));
    const restored = new ConversationStore(history);
    await restored.ready;
    expect(restored.current?.npc).toBe('Guide');
    expect(restored.value).toEqual(store.value);
    expect(restored.value[1].audio?.[0].rate).toBe(22050);
    expect(restored.value[1].timestamp).toBeInstanceOf(Date);
  });
  it('binds audio arriving before text to the same reply and retains multiple clips', () => {
    const store = createStore();
    store.player('Bonjour');
    const id = store.audioMessage('Guide')!;
    const clip = { data: new ArrayBuffer(4), rate: 24000 };
    store.attachAudio(id, clip);
    store.reply('Guide', 'Bien', false);
    store.reply('Guide', 'Bienvenue', true);
    store.attachAudio(store.audioMessage('Guide')!, { ...clip, rate: 22050 });
    expect(store.value).toHaveLength(2);
    expect(store.value[1]).toMatchObject({ id, text: 'Bienvenue', streaming: false });
    expect(store.value[1].audio).toHaveLength(2);
  });
  it('does not attach late or malformed audio to another conversation', () => {
    const store = createStore();
    store.reply('Guide', 'Bienvenue', true);
    const id = store.audioMessage('Guide')!;
    store.attachAudio(id, { data: new ArrayBuffer(1), rate: 22050 });
    expect(store.value[0].audio).toBeUndefined();
    store.select('ws://table/ws', 'Sentinelle');
    store.attachAudio(id, { data: new ArrayBuffer(4), rate: 22050 });
    expect(store.value).toEqual([]);
    expect(store.audioMessage('Guide')).toBeUndefined();
  });
  it('merges incoming messages with history still loading before saving', async () => {
    const history = new MemoryHistory();
    const key = JSON.stringify(['ws://table/ws', 'Guide']);
    history.saved.set(key, {
      key,
      server: 'ws://table/ws',
      npc: 'Guide',
      updatedAt: 1,
      messages: [{ id: 'old', speaker: 'player', text: 'Hier', timestamp: new Date() }],
    });
    const store = new ConversationStore(history);
    store.select('ws://table/ws', 'Guide');
    store.player('Aujourd’hui');
    await store.ready;
    await vi.waitFor(() => expect(history.saved.get(key)?.messages).toHaveLength(2));
    expect(store.value.map((message) => message.text)).toEqual(['Hier', 'Aujourd’hui']);
  });
  it('reports persistence failure once while preserving session history', async () => {
    const history = new MemoryHistory();
    vi.spyOn(history, 'save').mockRejectedValue(new Error('quota'));
    const store = new ConversationStore(history);
    await store.ready;
    const error = vi.fn();
    store.errors$.subscribe(error);
    store.select('ws://table/ws', 'Guide');
    store.player('Bonjour');
    store.reply('Guide', 'Bienvenue', true);
    await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
    expect(store.value).toHaveLength(2);
  });
  it('creates unique messages on LAN HTTP origins without randomUUID', () => {
    vi.stubGlobal('crypto', undefined);
    try {
      const store = createStore();
      store.player('Bonjour');
      store.player('Encore');
      expect(store.value).toHaveLength(2);
      expect(store.value[0].id).not.toBe(store.value[1].id);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('keeps the player recording and updates its bubble with the server transcription', () => {
    const store = createStore();
    const pcm = new Uint8Array([0, 128, 255, 127]).buffer;
    const id = store.playerRecording(pcm);
    expect(store.value[0]).toMatchObject({ id, speaker: 'player', text: '' });
    expect(store.value[0].audio?.[0]).toEqual({ data: pcm, rate: 16000 });
    expect(store.value[0].audio?.[0].data).not.toBe(pcm);
    store.player('Bonjour à vous');
    expect(store.value).toHaveLength(1);
    expect(store.value[0]).toMatchObject({ id, text: 'Bonjour à vous' });
    expect(store.value[0].audio).toHaveLength(1);
  });
  it('matches player transcripts in order without confusing a typed message echo', () => {
    const store = createStore();
    const first = store.playerRecording(new ArrayBuffer(4));
    const second = store.playerRecording(new ArrayBuffer(6));
    store.player('Un message écrit', true);
    store.player('Un message écrit');
    store.player('Première phrase');
    store.player('Deuxième phrase');
    expect(store.value).toHaveLength(3);
    expect(store.value[0]).toMatchObject({ id: first, text: 'Première phrase' });
    expect(store.value[1]).toMatchObject({ id: second, text: 'Deuxième phrase' });
    expect(store.value[2].text).toBe('Un message écrit');
    expect(store.value[2].audio).toBeUndefined();
  });
  it('restores player audio even without a server transcription', async () => {
    const history = new MemoryHistory();
    const store = new ConversationStore(history);
    await store.ready;
    store.select('ws://table/ws', 'Guide');
    const id = store.playerRecording(new Uint8Array([0, 128]).buffer);
    store.interrupt();
    await vi.waitFor(() => expect(history.saved.size).toBe(1));
    const restored = new ConversationStore(history);
    await restored.ready;
    expect(restored.value[0]).toMatchObject({ id, speaker: 'player', text: '' });
    expect([...new Uint8Array(restored.value[0].audio![0].data)]).toEqual([0, 128]);
    expect(restored.value[0].audio![0].rate).toBe(16000);
  });
  it('keeps player recordings in their PNJ conversation when switching characters', () => {
    const store = createStore();
    store.playerRecording(new ArrayBuffer(4));
    store.select('ws://table/ws', 'Sentinelle');
    store.player('Bonjour Sentinelle');
    expect(store.value[0].audio).toBeUndefined();
    store.select('ws://table/ws', 'Guide');
    expect(store.value[0].audio).toHaveLength(1);
    expect(store.value[0].text).toBe('');
    store.player('Une nouvelle phrase');
    expect(store.value).toHaveLength(2);
  });
  it('rejects empty or invalid player PCM and stops awaiting failed uploads', () => {
    const store = createStore();
    expect(store.playerRecording(new ArrayBuffer(0))).toBeUndefined();
    expect(store.playerRecording(new ArrayBuffer(1))).toBeUndefined();
    expect(store.value).toEqual([]);
    const id = store.playerRecording(new ArrayBuffer(4));
    store.forgetPlayerTranscription(id);
    store.player('Un autre message');
    expect(store.value).toHaveLength(2);
    expect(store.value[0].text).toBe('');
  });
});
