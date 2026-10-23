import { describe, expect, it } from 'vitest';
import { parseServerEvent } from './protocol';

describe('NPC summaries in the character list', () => {
  it.each([
    undefined,
    null,
    'obsolete',
    [null],
    [{ id: 'joyeux', label: 42 }],
    [
      { id: 'joyeux', label: 'Joyeux' },
      { id: 'joyeux', label: 'Joyeux' },
    ],
  ])('ignores obsolete tone fields regardless of their shape: %j', (speech_attitudes) => {
    const npcs = [{ id: 'guide', name: 'Guide', active: true }];
    expect(parseServerEvent({ type: 'gm_npc_list', npcs, speech_attitudes })).toEqual({
      type: 'gm_npc_list',
      npcs,
    });
  });

  it('reads the real server’s flat GM cards and maps negotiation to the displayed leverage', () => {
    expect(
      parseServerEvent({
        type: 'gm_npc_list',
        npcs: [
          {
            id: 'smith',
            name: 'Smith',
            active: false,
            scenario: 'Forge',
            attitude: 'Méfiant',
            motivation: 'Protéger sa forge',
            negotiation: 'Du charbon',
            secret_count: 2,
          },
        ],
      }),
    ).toEqual({
      type: 'gm_npc_list',
      npcs: [
        {
          id: 'smith',
          name: 'Smith',
          active: false,
          gm_notes: {
            scenario: 'Forge',
            attitude: 'Méfiant',
            motivation: 'Protéger sa forge',
            leverage: 'Du charbon',
            secret_count: 2,
          },
        },
      ],
    });
  });

  it('keeps valid GM card details when optional fields are malformed', () => {
    expect(
      parseServerEvent({
        type: 'gm_npc_list',
        npcs: [
          {
            id: 'smith',
            name: 'Smith',
            active: true,
            scenario: 42,
            attitude: ' Prudent ',
            negotiation: {},
            secret_count: -1,
          },
        ],
      }),
    ).toMatchObject({ npcs: [{ gm_notes: { attitude: 'Prudent' } }] });
  });

  it('validates targeted GM secret responses including an empty list', () => {
    const event = {
      type: 'gm_npc_secrets',
      id: 'smith',
      name: 'Smith',
      secrets: [{ body: 'Une confidence.', hint: '', status: 'locked' }],
    };
    expect(parseServerEvent(event)).toEqual(event);
    expect(parseServerEvent({ ...event, secrets: [] })).toEqual({ ...event, secrets: [] });
    for (const secrets of [
      null,
      [null],
      [{ body: 42 }],
      [{ body: 'Secret', hint: 1, status: 'local' }],
    ])
      expect(parseServerEvent({ ...event, secrets })).toBeNull();
  });
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

  it('preserves the character description together with the latest GM notes', () => {
    const event = {
      type: 'npc_list',
      npcs: [
        {
          id: 'guide',
          name: 'Le Guide',
          description: 'Un voyageur.',
          gm_notes: { behavior: 'Prudent', secrets: ['Cache une clé.'] },
        },
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
