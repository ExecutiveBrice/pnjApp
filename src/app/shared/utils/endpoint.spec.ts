import { describe, expect, it } from 'vitest';
import { buildEndpoint } from './endpoint';
describe('Server endpoint', () => {
  it('supports local hostnames, IPv4, IPv6 and complete secure URLs', () => {
    expect(buildEndpoint(' 192.168.1.20 ', 8766)).toBe('ws://192.168.1.20:8766/ws');
    expect(buildEndpoint('localhost', 8766)).toBe('ws://localhost:8766/ws');
    expect(buildEndpoint('::1', 8766)).toBe('ws://[::1]:8766/ws');
    expect(buildEndpoint('wss://npc.example/custom', 8766)).toBe('wss://npc.example/custom');
  });
  it('rejects missing hosts, invalid ports and unrelated schemes', () => {
    expect(() => buildEndpoint('', 8766)).toThrow();
    for (const port of [0, 65536, NaN, 4.5])
      expect(() => buildEndpoint('localhost', port)).toThrow();
    expect(() => buildEndpoint('https://host', 8766)).toThrow();
    expect(() => buildEndpoint('ws://user:secret@host/ws', 8766)).toThrow();
  });
});
