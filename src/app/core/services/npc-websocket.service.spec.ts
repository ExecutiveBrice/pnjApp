import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NpcWebSocketService } from './npc-websocket.service';
import { SettingsService } from './settings.service';
import { ConversationStore } from './conversation.store';
import { AudioPacket, Capabilities, NpcState, SecretDisclosure } from '../models/protocol';

class FakeSocket {
  binaryType = 'blob';
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  sent: (string | ArrayBuffer)[] = [];
  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  receive(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
  hello(capabilities?: Partial<Capabilities>): void {
    this.open();
    this.receive({
      type: 'hello',
      protocol: 1,
      npc: 'Serveur',
      state: 'idle',
      ...(capabilities ? { capabilities } : {}),
    });
  }
}
describe('NpcWebSocketService', () => {
  let ws: NpcWebSocketService;
  let settings: SettingsService;
  let store: ConversationStore;
  let sockets: FakeSocket[];
  let factory: ReturnType<typeof vi.fn<(url: string) => WebSocket>>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    settings = new SettingsService();
    store = new ConversationStore();
    sockets = [];
    factory = vi.fn(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    });
    ws = new NpcWebSocketService(settings, store, factory);
    ws.connect('ws://localhost:8766/ws');
  });
  afterEach(() => {
    ws.ngOnDestroy();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  it('opens native binary transport and waits for hello', () => {
    expect(factory).toHaveBeenCalledWith('ws://localhost:8766/ws');
    expect(sockets[0].binaryType).toBe('arraybuffer');
    sockets[0].open();
    expect(ws.state).toBe('connecting');
    ws.say('Trop tôt');
    expect(sockets[0].sent).toEqual([]);
    sockets[0].hello();
    expect(ws.connected).toBe(true);
    expect(sockets[0].sent).toContain('{"type":"status"}');
  });
  it('uses legacy capability defaults and restores NPC state', () => {
    let name = '';
    let state: NpcState = 'idle';
    ws.npc$.subscribe((value) => (name = value));
    ws.npcState$.subscribe((value) => (state = value));
    sockets[0].hello();
    expect(name).toBe('Serveur');
    expect(ws.currentCapabilities).toEqual({
      text_input: true,
      audio_input: false,
      audio_output: false,
      npc_switch: false,
      secret_approval: false,
    });
    sockets[0].receive({ type: 'state', state: 'processing' });
    expect(state).toBe('processing');
  });
  it('rejects unsupported protocol without retrying', () => {
    const error = vi.fn();
    ws.errors$.subscribe(error);
    sockets[0].open();
    sockets[0].receive({ type: 'hello', protocol: 99, npc: 'Test', state: 'idle' });
    expect(ws.state).toBe('disconnected');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('99'));
    vi.advanceTimersByTime(60000);
    expect(sockets).toHaveLength(1);
  });
  it('validates JSON, unknown events and malformed known events without disconnecting', () => {
    sockets[0].hello();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    sockets[0].onmessage?.({ data: '{bad' });
    sockets[0].receive({ type: 'future_event' });
    sockets[0].receive({ type: 'state', state: 'broken' });
    sockets[0].receive({ type: 'npc_list', npcs: [null] });
    expect(warn).toHaveBeenCalledWith('[NPC WS] Unknown server event: future_event');
    expect(ws.connected).toBe(true);
    expect(ws.currentNpcState).toBe('idle');
  });
  it('sends say and avoids duplicate echoed player bubbles', () => {
    sockets[0].hello();
    ws.say(' Bonjour ');
    expect(sockets[0].sent).toContain('{"type":"say","text":"Bonjour"}');
    sockets[0].receive({ type: 'player_spoke', text: 'Bonjour' });
    expect(store.value).toHaveLength(1);
  });
  it('blocks commands hidden by capabilities', () => {
    sockets[0].hello({ text_input: false });
    ws.say('Non');
    ws.switchNpc('a');
    expect(ws.sendAudio(new ArrayBuffer(2))).toBe(false);
    expect(sockets[0].sent).toEqual(['{"type":"status"}']);
  });
  it('sends switch_npc and applies switch and npc_list', () => {
    sockets[0].hello({ npc_switch: true });
    ws.switchNpc('guide');
    expect(sockets[0].sent).toContain('{"type":"switch_npc","npc":"guide"}');
    sockets[0].receive({ type: 'npc_reply_chunk', npc: 'Serveur', text: 'Début' });
    sockets[0].receive({ type: 'npc_switched', npc: 'Guide' });
    let npc = '';
    ws.npc$.subscribe((value) => (npc = value));
    expect(npc).toBe('Guide');
    expect(store.value[0].streaming).toBe(false);
    let list: unknown;
    ws.npcs$.subscribe((value) => (list = value));
    sockets[0].receive({ type: 'npc_list', npcs: [{ id: 'guide', name: 'Guide' }] });
    expect(list).toEqual([{ id: 'guide', name: 'Guide' }]);
  });
  it('parses streaming responses and finalizes a single bubble', () => {
    sockets[0].hello();
    sockets[0].receive({ type: 'player_spoke', text: 'Bonjour' });
    sockets[0].receive({ type: 'npc_reply_chunk', npc: 'Serveur', text: 'Bon' });
    sockets[0].receive({ type: 'npc_reply_chunk', npc: 'Serveur', text: 'jour' });
    expect(store.value.at(-1)?.text).toBe('Bonjour');
    sockets[0].receive({ type: 'npc_replied', npc: 'Serveur', text: 'Bonjour !' });
    expect(store.value).toHaveLength(2);
    expect(store.value.at(-1)?.streaming).toBe(false);
  });
  it('reconnects at 1, 2, 5, 10, 10 seconds and requires a new hello', () => {
    sockets[0].hello();
    sockets[0].close();
    expect(ws.state).toBe('reconnecting');
    for (const [index, delay] of [1000, 2000, 5000, 10000, 10000].entries()) {
      vi.advanceTimersByTime(delay - 1);
      expect(sockets).toHaveLength(index + 1);
      vi.advanceTimersByTime(1);
      expect(sockets).toHaveLength(index + 2);
      expect(ws.connected).toBe(false);
      if (index < 4) sockets.at(-1)?.close();
    }
    sockets.at(-1)?.hello();
    expect(ws.connected).toBe(true);
  });
  it('stops retrying on explicit disconnect and closes the socket', () => {
    sockets[0].hello();
    sockets[0].close();
    ws.disconnect();
    vi.advanceTimersByTime(60000);
    expect(sockets).toHaveLength(1);
    expect(ws.state).toBe('disconnected');
  });
  it('honors automatic reconnection changes', () => {
    sockets[0].hello();
    sockets[0].close();
    settings.update({ autoReconnect: false });
    vi.advanceTimersByTime(60000);
    expect(sockets).toHaveLength(1);
    expect(ws.state).toBe('disconnected');
  });
  it('times out a missing hello and ignores stale socket callbacks', () => {
    const stale = sockets[0].onmessage;
    vi.advanceTimersByTime(10000);
    expect(ws.state).toBe('reconnecting');
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
    stale?.({ data: '{"type":"hello","protocol":1,"npc":"Old","state":"idle"}' });
    expect(ws.connected).toBe(false);
  });
  it('routes binary audio only inside an envelope and resets on barge-in', () => {
    sockets[0].hello();
    const packets: AudioPacket[] = [];
    ws.audio$.subscribe((packet) => packets.push(packet));
    sockets[0].onmessage?.({ data: new ArrayBuffer(4) });
    expect(packets).toHaveLength(0);
    sockets[0].receive({
      type: 'audio_start',
      npc: 'Serveur',
      sample_rate: 22050,
      channels: 1,
      format: 'pcm_s16le',
    });
    sockets[0].onmessage?.({ data: new ArrayBuffer(4) });
    ws.stopSpeaking();
    sockets[0].onmessage?.({ data: new ArrayBuffer(4) });
    sockets[0].receive({ type: 'audio_end' });
    expect(packets.map((packet) => packet.type)).toEqual(['audio_start', 'chunk', 'reset']);
    expect(sockets[0].sent).toContain('{"type":"stop_speaking"}');
  });
  it('sends player PCM in binary frames between typed markers', () => {
    sockets[0].hello({ audio_input: true });
    const pcm = new ArrayBuffer(64000);
    expect(ws.sendAudio(pcm)).toBe(true);
    expect(sockets[0].sent[1]).toBe(
      '{"type":"audio_input_start","sample_rate":16000,"channels":1,"format":"pcm_s16le"}',
    );
    expect((sockets[0].sent[2] as ArrayBuffer).byteLength).toBe(32768);
    expect((sockets[0].sent[3] as ArrayBuffer).byteLength).toBe(31232);
    expect(sockets[0].sent[4]).toBe('{"type":"audio_input_end"}');
  });
  it('forwards nonblocking server errors', () => {
    sockets[0].hello();
    const error = vi.fn();
    ws.errors$.subscribe(error);
    sockets[0].receive({ type: 'error', message: 'Indisponible' });
    expect(error).toHaveBeenCalledWith('Indisponible');
    expect(ws.connected).toBe(true);
  });
  const request = {
    request_id: 'secret-1',
    npc: 'Guide',
    secret: 'Le duc est un espion.',
    context: 'Le joueur interroge le guide sur le duc.',
  };
  const requested = { type: 'secret_disclosure_requested', ...request };
  const snapshot = { type: 'secret_disclosure_list', requests: [request] };

  it('keeps secrets out of conversation and waits for server confirmation, preventing double decisions', () => {
    sockets[0].hello({ secret_approval: true });
    let disclosures: SecretDisclosure[] = [];
    ws.disclosures$.subscribe((value) => (disclosures = value));
    sockets[0].receive(requested);
    sockets[0].receive(requested);
    expect(disclosures).toEqual([{ ...requested, status: 'pending' }]);
    expect(store.value).toHaveLength(0);
    ws.resolveDisclosure(request.request_id, 'approved');
    ws.resolveDisclosure(request.request_id, 'rejected');
    expect(sockets[0].sent.slice(1)).toEqual([
      JSON.stringify({
        type: 'resolve_secret_disclosure',
        request_id: request.request_id,
        decision: 'approved',
      }),
    ]);
    expect(disclosures[0].status).toBe('sending');
    sockets[0].receive({
      type: 'secret_disclosure_resolved',
      request_id: 'unknown',
      decision: 'approved',
    });
    expect(disclosures[0].status).toBe('sending');
    sockets[0].receive({
      type: 'secret_disclosure_resolved',
      request_id: request.request_id,
      decision: 'approved',
    });
    expect(disclosures[0].status).toBe('approved');
    expect(store.value).toHaveLength(0);
    const error = vi.fn();
    ws.errors$.subscribe(error);
    vi.advanceTimersByTime(10000);
    expect(error).not.toHaveBeenCalled();
  });
  it('accepts a refusal from another MJ and preserves requests across NPC switches', () => {
    sockets[0].hello({ secret_approval: true });
    let disclosures: SecretDisclosure[] = [];
    ws.disclosures$.subscribe((value) => (disclosures = value));
    sockets[0].receive(snapshot);
    sockets[0].receive({ type: 'npc_switched', npc: 'Aubergiste' });
    expect(disclosures[0].npc).toBe('Guide');
    sockets[0].receive({
      type: 'secret_disclosure_resolved',
      request_id: request.request_id,
      decision: 'rejected',
    });
    expect(disclosures[0].status).toBe('rejected');
    ws.resolveDisclosure(request.request_id, 'approved');
    expect(sockets[0].sent).toEqual(['{"type":"status"}']);
  });
  it('requires the server capability and a known pending request', () => {
    sockets[0].hello();
    let disclosures: SecretDisclosure[] = [];
    ws.disclosures$.subscribe((value) => (disclosures = value));
    sockets[0].receive(requested);
    sockets[0].receive(snapshot);
    ws.resolveDisclosure(request.request_id, 'approved');
    expect(disclosures).toEqual([]);
    sockets[0].hello({ secret_approval: true });
    ws.resolveDisclosure('unknown', 'approved');
    expect(sockets[0].sent).toEqual(['{"type":"status"}', '{"type":"status"}']);
  });
  it('uses authoritative snapshots and resynchronizes after reconnecting', () => {
    sockets[0].hello({ secret_approval: true });
    let disclosures: SecretDisclosure[] = [];
    let synced = false;
    ws.disclosures$.subscribe((value) => (disclosures = value));
    ws.disclosuresSynced$.subscribe((value) => (synced = value));
    sockets[0].receive(snapshot);
    expect(synced).toBe(true);
    ws.resolveDisclosure(request.request_id, 'approved');
    sockets[0].receive(snapshot);
    expect(disclosures[0].status).toBe('sending');
    sockets[0].receive({ type: 'secret_disclosure_list', requests: [] });
    expect(disclosures).toEqual([]);
    sockets[0].receive(requested);
    sockets[0].close();
    expect(disclosures).toEqual([]);
    expect(synced).toBe(false);
    ws.resolveDisclosure(request.request_id, 'approved');
    vi.advanceTimersByTime(1000);
    sockets[1].hello({ secret_approval: true });
    expect(sockets[1].sent).toEqual(['{"type":"status"}']);
    sockets[1].receive(snapshot);
    expect(disclosures[0].status).toBe('pending');
  });
  it('allows retry and requests status when a decision is not confirmed, without approving on error', () => {
    sockets[0].hello({ secret_approval: true });
    let disclosures: SecretDisclosure[] = [];
    ws.disclosures$.subscribe((value) => (disclosures = value));
    sockets[0].receive(snapshot);
    ws.resolveDisclosure(request.request_id, 'approved');
    sockets[0].receive({ type: 'error', message: 'Décision refusée par le serveur.' });
    expect(disclosures[0].status).toBe('sending');
    vi.advanceTimersByTime(10000);
    expect(disclosures[0].status).toBe('pending');
    expect(sockets[0].sent.at(-1)).toBe('{"type":"status"}');
    ws.resolveDisclosure(request.request_id, 'rejected');
    expect(disclosures[0].status).toBe('sending');
  });
  it('leaves a request pending if sending the decision fails and cancels timers on disconnect', () => {
    sockets[0].hello({ secret_approval: true });
    let disclosures: SecretDisclosure[] = [];
    ws.disclosures$.subscribe((value) => (disclosures = value));
    sockets[0].receive(snapshot);
    vi.spyOn(sockets[0], 'send').mockImplementationOnce(() => {
      throw new Error('closed');
    });
    ws.resolveDisclosure(request.request_id, 'approved');
    expect(disclosures[0].status).toBe('pending');
    ws.resolveDisclosure(request.request_id, 'approved');
    ws.disconnect();
    const error = vi.fn();
    ws.errors$.subscribe(error);
    vi.advanceTimersByTime(10000);
    expect(disclosures).toEqual([]);
    expect(error).not.toHaveBeenCalled();
  });
});
