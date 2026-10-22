import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Subject } from 'rxjs';
import { AudioPlaybackService } from './audio-playback.service';
import { NpcWebSocketService } from './npc-websocket.service';
import { SettingsService } from './settings.service';
import { AudioPacket } from '../models/protocol';
import { ConversationStore } from './conversation.store';
import { MemoryHistory } from '../../../../tests/conversation-history';

class FakeContext {
  static instances: FakeContext[] = [];
  state = 'running';
  destination = {};
  sources: {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    onended: (() => void) | null;
    buffer?: unknown;
    connect: ReturnType<typeof vi.fn>;
  }[] = [];
  createBuffer = vi.fn(() => ({ copyToChannel: vi.fn() }));
  gain = { gain: { value: 1 }, connect: vi.fn() };
  constructor() {
    FakeContext.instances.push(this);
  }
  createGain(): typeof this.gain {
    return this.gain;
  }
  async resume(): Promise<void> {
    this.state = 'running';
  }
  async close(): Promise<void> {
    this.state = 'closed';
  }
  createBufferSource(): (typeof this.sources)[number] {
    const source = {
      start: vi.fn(),
      stop: vi.fn(),
      disconnect: vi.fn(),
      connect: vi.fn(),
      onended: null,
    };
    this.sources.push(source);
    return source;
  }
}
describe('AudioPlaybackService', () => {
  let audio: AudioPlaybackService;
  let settings: SettingsService;
  let packets: Subject<AudioPacket>;
  let store: ConversationStore;
  let history: MemoryHistory;
  const start = (): void =>
    packets.next({
      type: 'audio_start',
      npc: 'Test',
      sample_rate: 22050,
      channels: 1,
      format: 'pcm_s16le',
    });
  const chunk = (bytes: number[]): void =>
    packets.next({ type: 'chunk', data: new Uint8Array(bytes).buffer });
  const end = (): void => packets.next({ type: 'audio_end' });
  beforeEach(() => {
    vi.stubGlobal('AudioContext', FakeContext);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    FakeContext.instances = [];
    packets = new Subject();
    settings = new SettingsService();
    history = new MemoryHistory();
    store = new ConversationStore(history);
    store.select('ws://table/ws', 'Test');
    audio = new AudioPlaybackService(
      { audio$: packets.asObservable() } as NpcWebSocketService,
      settings,
      store,
    );
  });
  afterEach(() => {
    audio.ngOnDestroy();
    vi.unstubAllGlobals();
  });
  it('buffers until audio_end, joins odd frame boundaries and preserves the sample rate', async () => {
    await audio.unlock();
    start();
    chunk([0]);
    chunk([128, 255, 127]);
    const context = FakeContext.instances[0];
    expect(context.sources).toHaveLength(0);
    end();
    await Promise.resolve();
    expect(context.createBuffer).toHaveBeenCalledWith(1, 2, 22050);
    const buffer = context.createBuffer.mock.results[0].value;
    expect([...buffer.copyToChannel.mock.calls[0][0]]).toEqual([-1, 32767 / 32768]);
    expect(context.sources[0].start).toHaveBeenCalledOnce();
  });
  it('retains a pending reply when autoplay is off', async () => {
    settings.update({ autoPlayAudio: false });
    let pending = false;
    audio.pending$.subscribe((value) => (pending = value));
    start();
    chunk([0, 0]);
    end();
    expect(pending).toBe(true);
    expect(FakeContext.instances).toHaveLength(0);
    await audio.playPending();
    expect(FakeContext.instances[0].sources).toHaveLength(1);
    expect(pending).toBe(false);
  });
  it('serializes responses that arrive in the same tick', async () => {
    await audio.unlock();
    start();
    chunk([0, 0]);
    end();
    start();
    chunk([0, 0]);
    end();
    await Promise.resolve();
    const context = FakeContext.instances[0];
    expect(context.sources).toHaveLength(1);
    context.sources[0].onended?.();
    await Promise.resolve();
    expect(context.sources).toHaveLength(2);
  });
  it('stops current playback and discards partial and queued audio on interruption', async () => {
    await audio.unlock();
    start();
    chunk([0, 0]);
    end();
    await Promise.resolve();
    start();
    chunk([0, 0]);
    end();
    start();
    chunk([0, 0]);
    packets.next({ type: 'reset' });
    end();
    await Promise.resolve();
    expect(FakeContext.instances[0].sources[0].stop).toHaveBeenCalledOnce();
    expect(FakeContext.instances[0].sources).toHaveLength(1);
  });
  it('ignores a queued playback cancelled while awaiting resume', async () => {
    await audio.unlock();
    start();
    chunk([0, 0]);
    end();
    audio.stop();
    await Promise.resolve();
    expect(FakeContext.instances[0].sources).toHaveLength(0);
  });
  it('reports invalid final PCM without throwing through the transport', async () => {
    await audio.unlock();
    const error = vi.fn();
    audio.errors$.subscribe(error);
    start();
    chunk([0]);
    end();
    await Promise.resolve();
    expect(error).toHaveBeenCalledOnce();
  });
  it('replays a saved reply repeatedly after transport reset with no network access', async () => {
    settings.update({ autoPlayAudio: false });
    store.reply('Test', 'Une voix', true);
    start();
    chunk([0, 128, 255, 127]);
    end();
    const reply = store.value[0];
    packets.next({ type: 'reset' });
    await audio.replay(reply);
    await audio.replay(reply);
    const context = FakeContext.instances[0];
    expect(context.sources).toHaveLength(2);
    expect(context.sources[0].stop).toHaveBeenCalledOnce();
    expect(context.createBuffer).toHaveBeenLastCalledWith(1, 2, 22050);
    expect(reply.audio).toHaveLength(1);
  });
  it('replays persisted audio after service recreation and serializes sentence clips', async () => {
    settings.update({ autoPlayAudio: false });
    await store.ready;
    store.reply('Test', 'Deux phrases', true);
    start();
    chunk([0, 0]);
    end();
    start();
    chunk([255, 127]);
    end();
    await vi.waitFor(() => expect(history.saved.size).toBe(1));
    audio.ngOnDestroy();
    const restored = new ConversationStore(history);
    await restored.ready;
    audio = new AudioPlaybackService(
      { audio$: new Subject<AudioPacket>().asObservable() } as NpcWebSocketService,
      settings,
      restored,
    );
    await audio.replay(restored.value[0]);
    const context = FakeContext.instances.at(-1)!;
    expect(context.sources).toHaveLength(1);
    context.sources[0].onended?.();
    await Promise.resolve();
    expect(context.sources).toHaveLength(2);
  });
  it('keeps a recording on its original reply when a later message arrives', () => {
    settings.update({ autoPlayAudio: false });
    store.reply('Test', 'Première réplique', true);
    start();
    chunk([0, 0]);
    store.player('Deuxième question');
    store.reply('Test', 'Deuxième réplique', true);
    end();
    expect(store.value[0].audio).toHaveLength(1);
    expect(store.value[2].audio).toBeUndefined();
  });
  it('keeps saved audio when an unfinished recording is cancelled', () => {
    settings.update({ autoPlayAudio: false });
    store.reply('Test', 'Complète', true);
    start();
    chunk([0, 0]);
    end();
    store.player('Suite');
    start();
    chunk([0, 0]);
    packets.next({ type: 'reset' });
    end();
    expect(store.value[0].audio).toHaveLength(1);
    expect(store.value.at(-1)?.audio).toBeUndefined();
  });
  it('does not cut offline replays during automatic reconnection attempts', async () => {
    settings.update({ autoPlayAudio: false });
    store.reply('Test', 'Une longue réplique', true);
    start();
    chunk([0, 0]);
    end();
    await audio.replay(store.value[0]);
    const context = FakeContext.instances[0];
    packets.next({ type: 'reset' });
    packets.next({ type: 'reset' });
    expect(context.sources[0].stop).not.toHaveBeenCalled();
    store.select('ws://table/ws', 'Other');
    expect(context.sources[0].stop).toHaveBeenCalledOnce();
  });
  it('replays the persisted player voice offline after closing and reopening the application', async () => {
    settings.update({ autoPlayAudio: false });
    await store.ready;
    store.playerRecording(new Uint8Array([0, 128, 255, 127]).buffer);
    store.player('La phrase du joueur');
    await vi.waitFor(() => expect(history.saved.size).toBe(1));
    audio.ngOnDestroy();
    const restored = new ConversationStore(history);
    await restored.ready;
    audio = new AudioPlaybackService(
      { audio$: new Subject<AudioPacket>().asObservable() } as NpcWebSocketService,
      settings,
      restored,
    );
    await audio.replay(restored.value[0]);
    await audio.replay(restored.value[0]);
    const context = FakeContext.instances.at(-1)!;
    expect(context.sources).toHaveLength(2);
    expect(context.sources[0].stop).toHaveBeenCalledOnce();
    expect(context.createBuffer).toHaveBeenLastCalledWith(1, 2, 16000);
    expect([...context.createBuffer.mock.results[0].value.copyToChannel.mock.calls[0][0]]).toEqual([
      -1,
      32767 / 32768,
    ]);
    expect(restored.value[0].text).toBe('La phrase du joueur');
  });
});
