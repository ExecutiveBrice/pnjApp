import { describe, expect, it } from 'vitest';
import { parseServerEvent } from './protocol';

describe('NPC summaries in the character list', () => {
  it('accepts characters with or without a description', () => {
    const event = {
      type: 'npc_list',
      npcs: [
        { id: 'guide', name: 'Le Guide', description: 'Un voyageur qui connaît la région.' },
        { id: 'guard', name: 'La Sentinelle' },
      ],
    };
    expect(parseServerEvent(event)).toEqual(event);
  });

  it('rejects descriptions that cannot be displayed as text', () => {
    for (const description of [null, 42, {}, []]) {
      expect(
        parseServerEvent({
          type: 'npc_list',
          npcs: [{ id: 'guide', name: 'Le Guide', description }],
        }),
      ).toBeNull();
    }
  });
});

describe('secret disclosure wire validation', () => {
  const request = { request_id: 'r1', npc: 'Guide', secret: 'Un passage caché.', context: '' };
  it('accepts requests, snapshots and both decisions', () => {
    for (const event of [
      { type: 'secret_disclosure_requested', ...request },
      { type: 'secret_disclosure_list', requests: [request] },
      { type: 'secret_disclosure_list', requests: [] },
      { type: 'secret_disclosure_resolved', request_id: 'r1', decision: 'approved' },
      { type: 'secret_disclosure_resolved', request_id: 'r1', decision: 'rejected' },
    ])
      expect(parseServerEvent(event)).toEqual(event);
  });
  it('rejects malformed or ambiguous requests before they reach the MJ', () => {
    for (const invalid of [
      null,
      { ...request, request_id: ' ' },
      { ...request, npc: 7 },
      { ...request, secret: '' },
      { ...request, context: null },
    ]) {
      expect(parseServerEvent({ type: 'secret_disclosure_requested', ...invalid })).toBeNull();
      expect(parseServerEvent({ type: 'secret_disclosure_list', requests: [invalid] })).toBeNull();
    }
    expect(
      parseServerEvent({ type: 'secret_disclosure_list', requests: [request, request] }),
    ).toBeNull();
    expect(
      parseServerEvent({ type: 'secret_disclosure_resolved', request_id: 'r1', decision: true }),
    ).toBeNull();
    expect(
      parseServerEvent({
        type: 'hello',
        protocol: 1,
        npc: 'Guide',
        state: 'idle',
        capabilities: { secret_approval: 'yes' },
      }),
    ).toBeNull();
  });
});
