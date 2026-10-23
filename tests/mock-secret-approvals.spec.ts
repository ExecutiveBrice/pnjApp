import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type WireEvent = Record<string, unknown>;
class MockClient {
  readonly events: WireEvent[] = [];
  private readonly listeners = new Set<() => void>();
  readonly socket: WebSocket;
  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.addEventListener('message', (event: MessageEvent<unknown>) => {
      if (typeof event.data !== 'string') return;
      this.events.push(JSON.parse(event.data) as WireEvent);
      for (const listener of this.listeners) listener();
    });
  }
  send(command: WireEvent): void {
    this.socket.send(JSON.stringify(command));
  }
  wait(type: string, after = 0): Promise<WireEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(check);
        reject(new Error(`Missing mock event: ${type}`));
      }, 4000);
      const check = () => {
        const event = this.events.slice(after).find((item) => item['type'] === type);
        if (!event) return;
        clearTimeout(timer);
        this.listeners.delete(check);
        resolve(event);
      };
      this.listeners.add(check);
      check();
    });
  }
}

describe('mock MJ secret approvals over a real WebSocket', () => {
  let server: ChildProcess;
  let url: string;
  const clients: MockClient[] = [];
  beforeAll(async () => {
    server = spawn(process.execPath, ['scripts/mock-npc-server.mjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: '0',
        MOCK_LEGACY: '0',
        MOCK_AUDIO_OUTPUT: '0',
        NPC_FIXTURES: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Mock startup timed out')), 5000);
      server.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      server.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Mock exited: ${code}`));
      });
      server.stdout?.on('data', (data: Buffer) => {
        const match = /ws:\/\/localhost:\d+\/ws/.exec(data.toString());
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      });
    });
  });
  afterAll(async () => {
    for (const client of clients) client.socket.close();
    if (server && server.exitCode === null) {
      const closed = once(server, 'exit');
      server.kill();
      await closed;
    }
  });
  async function connect(): Promise<MockClient> {
    const client = new MockClient(url);
    clients.push(client);
    const hello = await client.wait('hello');
    expect(hello['capabilities']).toMatchObject({ secret_approval: true });
    return client;
  }
  it('acknowledges session reset, cancels replies and clears shared secret requests', async () => {
    const client = await connect();
    const observer = await connect();
    client.send({ type: 'say', text: 'Quel est ton secret ?' });
    await client.wait('secret_disclosure_requested');
    client.send({ type: 'say', text: 'Une réponse à interrompre' });
    await client.wait('state');
    const after = client.events.length;
    client.send({ type: 'reset_session' });
    await client.wait('session_reset', after);
    client.send({ type: 'status' });
    expect(await client.wait('secret_disclosure_list', after)).toMatchObject({ requests: [] });
    expect(await client.wait('status', after)).toMatchObject({ state: 'idle' });
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(client.events.slice(after).some((event) => event['type'] === 'npc_reply_chunk')).toBe(
      false,
    );
    observer.send({ type: 'status' });
    const marker = observer.events.length;
    expect(await observer.wait('secret_disclosure_list', marker)).toMatchObject({ requests: [] });
  });
  it('sends flat GM cards and returns secrets only when requested for a specific NPC', async () => {
    const client = await connect();
    const cards = await client.wait('gm_npc_list');
    expect(cards).not.toHaveProperty('speech_attitudes');
    expect(cards['npcs']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'sentinelle',
          active: false,
          secret_count: 1,
          scenario: expect.any(String),
          negotiation: expect.any(String),
        }),
      ]),
    );
    expect(JSON.stringify(cards)).not.toContain('Elle laisse passer les familles');
    const hello = await client.wait('hello');
    expect(hello['gm_notes']).toBeUndefined();
    client.send({ type: 'get_npc_secrets', npc: 'sentinelle' });
    expect(await client.wait('gm_npc_secrets')).toMatchObject({
      id: 'sentinelle',
      secrets: [{ body: expect.any(String), hint: '', status: 'locked' }],
    });
    expect(client.events.some((event) => event['type'] === 'npc_switched')).toBe(false);
    expect(client.events.some((event) => event['type'] === 'npc_replied')).toBe(false);
  });
  it('switches NPC silently and speaks only after an explicit action', async () => {
    const client = await connect();
    const after = client.events.length;
    client.send({ type: 'switch_npc', npc: 'sentinelle', silent: true });
    expect(await client.wait('npc_switched', after)).toMatchObject({ npc: 'La Sentinelle' });
    await client.wait('state', after);
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(
      client.events
        .slice(after)
        .filter((event) =>
          ['player_spoke', 'npc_reply_chunk', 'npc_replied', 'audio_start'].includes(
            String(event['type']),
          ),
        ),
    ).toEqual([]);
    client.send({
      type: 'speak_npc',
      npc: 'sentinelle',
      action: 'presentation',
    });
    expect(await client.wait('npc_replied', after)).toMatchObject({
      npc: 'La Sentinelle',
      text: 'Je m’appelle La Sentinelle.',
    });
    expect(client.events.some((event) => event['type'] === 'player_spoke')).toBe(false);
  });
  it.each([
    { action: 'presentation', text: 'Je m’appelle Mordrek.' },
    { action: 'fill_wait', text: 'Attendons ici.' },
    { action: 'greeting', text: 'Bonjour, voyageurs.' },
  ])('distinguishes $action without a tone', async ({ action, text }) => {
    const client = await connect();
    client.send({ type: 'speak_npc', npc: 'mordrek', action });
    expect((await client.wait('npc_replied'))['text']).toContain(text);
    client.socket.close();
  });
  it.each(['joyeux', 'unknown', null, { obsolete: true }])(
    'ignores the obsolete tone field: %j',
    async (attitude) => {
      const client = await connect();
      client.send({ type: 'speak_npc', npc: 'mordrek', action: 'greeting', attitude });
      expect((await client.wait('npc_replied'))['text']).toBe('Bonjour, voyageurs.');
      client.socket.close();
    },
  );
  it('rejects unknown or missing actions without generating a reply', async () => {
    const client = await connect();
    for (const cue of [
      { action: 'unknown', attitude: 'joyeux' },
      { action: 'constructor', attitude: 'joyeux' },
      { attitude: 'joyeux' },
    ]) {
      const after = client.events.length;
      client.send({ type: 'speak_npc', npc: 'mordrek', ...cue });
      await client.wait('error', after);
    }
    expect(client.events.some((event) => event['type'] === 'npc_replied')).toBe(false);
  });
  it.each(['approved', 'rejected'])(
    'holds the reply until a %s decision is received',
    async (decision) => {
      const client = await connect();
      client.send({ type: 'say', text: 'Quel est ton secret ?' });
      const request = await client.wait('secret_disclosure_requested');
      await client.wait('state');
      await new Promise((resolve) => setTimeout(resolve, 650));
      expect(
        client.events.filter((event) =>
          ['npc_reply_chunk', 'npc_replied', 'audio_start'].includes(String(event['type'])),
        ),
      ).toEqual([]);
      const after = client.events.length;
      client.send({
        type: 'resolve_secret_disclosure',
        request_id: request['request_id'],
        decision,
      });
      expect(await client.wait('secret_disclosure_resolved', after)).toMatchObject({ decision });
      const reply = await client.wait('npc_replied', after);
      if (decision === 'approved') expect(reply['text']).toBe(request['secret']);
      else {
        expect(reply['text']).toBe('Je préfère garder cela pour moi.');
        expect(
          client.events
            .filter((event) => event['type'] === 'npc_reply_chunk')
            .map((event) => event['text'])
            .join(''),
        ).not.toContain(request['secret']);
      }
      const retryAfter = client.events.length;
      client.send({
        type: 'resolve_secret_disclosure',
        request_id: request['request_id'],
        decision,
      });
      expect(await client.wait('secret_disclosure_resolved', retryAfter)).toMatchObject({
        decision,
      });
      expect(client.events.filter((event) => event['type'] === 'npc_replied')).toHaveLength(1);
      client.socket.close();
    },
  );
  it('resynchronizes all NPC requests after reconnecting and broadcasts a single decision to other MJs', async () => {
    const first = await connect();
    first.send({ type: 'say', text: 'Un secret ?' });
    const request = await first.wait('secret_disclosure_requested');
    first.socket.close();
    const second = await connect();
    const observer = await connect();
    second.send({ type: 'switch_npc', npc: 'sentinelle' });
    await second.wait('npc_switched');
    second.send({ type: 'status' });
    expect(await second.wait('secret_disclosure_list')).toMatchObject({
      requests: [{ request_id: request['request_id'], npc: 'Mordrek' }],
    });
    second.send({
      type: 'resolve_secret_disclosure',
      request_id: request['request_id'],
      decision: 'rejected',
    });
    expect(await observer.wait('secret_disclosure_resolved')).toMatchObject({
      decision: 'rejected',
    });
    expect(await second.wait('npc_replied')).toMatchObject({
      npc: 'Mordrek',
      text: 'Je préfère garder cela pour moi.',
    });
    second.send({
      type: 'resolve_secret_disclosure',
      request_id: request['request_id'],
      decision: 'approved',
    });
    await second.wait('error');
    expect(
      await second.wait(
        'secret_disclosure_list',
        second.events.findIndex((event) => event['type'] === 'error'),
      ),
    ).toMatchObject({ requests: [] });
    expect(
      second.events.filter((event) => event['type'] === 'secret_disclosure_resolved'),
    ).toHaveLength(1);
  });
});
