import { afterEach, describe, expect, it, vi } from 'vitest';
import { MicrophoneService } from './microphone.service';
describe('MicrophoneService', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('fails explicitly when capture APIs are unavailable', async () => {
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('MediaRecorder', undefined);
    const microphone = new MicrophoneService();
    expect(microphone.available).toBe(false);
    await expect(microphone.start()).rejects.toThrow('localhost');
  });
  it('stops a permission request that resolves after pointer release', async () => {
    const stop = vi.fn();
    let resolve: (stream: MediaStream) => void = () => undefined;
    const pending = new Promise<MediaStream>((done) => (resolve = done));
    vi.stubGlobal('MediaRecorder', class {});
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => pending } });
    const microphone = new MicrophoneService();
    const started = microphone.start();
    expect(await microphone.finish()).toBeNull();
    resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    expect(await started).toBe(false);
    expect(stop).toHaveBeenCalledOnce();
  });
});
