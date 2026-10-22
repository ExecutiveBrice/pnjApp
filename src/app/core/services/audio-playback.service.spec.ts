import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Subject } from 'rxjs';
import { AudioPlaybackService } from './audio-playback.service';
import { NpcWebSocketService } from './npc-websocket.service';
import { SettingsService } from './settings.service';
import { AudioPacket } from '../models/protocol';

class FakeContext {
  static instances: FakeContext[] = [];
  state = 'running';
  currentTime = 10;
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
  constructor(readonly options?: AudioContextOptions) {
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
  const start = (rate = 22050): void =>
    packets.next({
      type: 'audio_start',
      npc: 'Test',
      sample_rate: rate,
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
    expect(context.options?.sampleRate).toBe(24000);
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
    expect(context.sources).toHaveLength(2);
    expect(context.sources[0].start).toHaveBeenCalledWith(10.16);
    expect(context.sources[1].start.mock.calls[0][0]).toBeCloseTo(10.16 + 1 / 22050, 10);
    context.sources[0].onended?.();
    await Promise.resolve();
    expect(context.sources).toHaveLength(2);
  });
  it('keeps more than four Pocket chunks and schedules every sample without gaps', async () => {
    settings.update({ autoPlayAudio: false });
    for (let index = 0; index < 10; index++) {
      start(24000);
      packets.next({ type: 'chunk', data: new ArrayBuffer(1920 * 2) });
      end();
    }
    await audio.playPending();
    const context = FakeContext.instances[0];
    expect(context.sources).toHaveLength(10);
    context.sources.forEach((source, index) => {
      expect(source.start.mock.calls[0][0]).toBeCloseTo(10.16 + index * 0.08, 10);
    });
  });
  it('absorbs packet jitter without moving the existing playback timeline', async () => {
    await audio.unlock();
    const context = FakeContext.instances[0];
    for (const arrival of [10, 10.087, 10.171, 10.255]) {
      context.currentTime = arrival;
      start(24000);
      packets.next({ type: 'chunk', data: new ArrayBuffer(1920 * 2) });
      end();
      await Promise.resolve();
    }
    expect(context.sources).toHaveLength(4);
    context.sources.forEach((source, index) => {
      expect(source.start.mock.calls[0][0]).toBeCloseTo(10.16 + index * 0.08, 10);
    });
  });
  it('cancels every source already scheduled ahead when interrupted', async () => {
    await audio.unlock();
    for (let index = 0; index < 3; index++) {
      start(24000);
      packets.next({ type: 'chunk', data: new ArrayBuffer(1920 * 2) });
      end();
    }
    await Promise.resolve();
    const context = FakeContext.instances[0];
    expect(context.sources).toHaveLength(3);
    packets.next({ type: 'reset' });
    context.sources.forEach((source) => {
      expect(source.stop).toHaveBeenCalledOnce();
      expect(source.disconnect).toHaveBeenCalledOnce();
    });
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
