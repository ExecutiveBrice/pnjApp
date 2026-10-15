import { describe, expect, it } from 'vitest';
import { monoToPcm16, pcm16ToFloat32 } from './pcm';
describe('PCM conversion', () => {
  it('decodes little endian signed Int16 with the exact scale', () => {
    const data = new ArrayBuffer(8);
    const view = new DataView(data);
    [-32768, -16384, 0, 32767].forEach((value, index) => view.setInt16(index * 2, value, true));
    expect([...pcm16ToFloat32(data)]).toEqual([-1, -0.5, 0, 32767 / 32768]);
  });
  it('rejects partial samples after all chunks are joined', () => {
    expect(() => pcm16ToFloat32(new ArrayBuffer(3))).toThrow('incomplet');
  });
  it('downsamples 48 kHz to 16 kHz mono and clamps amplitudes', () => {
    const data = monoToPcm16(new Float32Array([-2, -2, -2, 0, 0, 0, 2, 2, 2]), 48000);
    const view = new DataView(data);
    expect(data.byteLength).toBe(6);
    expect([0, 2, 4].map((offset) => view.getInt16(offset, true))).toEqual([-32768, 0, 32767]);
  });
  it('produces exactly one second for common device sample rates', () => {
    for (const rate of [16000, 22050, 44100, 48000])
      expect(monoToPcm16(new Float32Array(rate), rate).byteLength).toBe(32000);
  });
});
