import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Subject } from 'rxjs';
import { AudioPlaybackService } from './audio-playback.service';
import { NpcWebSocketService } from './npc-websocket.service';
import { SettingsService } from './settings.service';
import { AudioPacket } from '../models/protocol';

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
    audio = new AudioPlaybackService(
      { audio$: packets.asObservable() } as NpcWebSocketService,
      settings,
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
});
