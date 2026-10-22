import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NpcWebSocketService } from './npc-websocket.service';
import { SettingsService } from './settings.service';
import { ConversationStore } from './conversation.store';
import { MemoryHistory } from '../../../../tests/conversation-history';
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
    store = new ConversationStore(new MemoryHistory());
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
  it('requests campaign stories even when voice generation is unavailable and validates their URLs', () => {
    const catalog = vi.fn();
    ws.studioCatalog$.subscribe(catalog);
    sockets[0].hello({ voice_design: false, story_generation: false });
    expect(sockets[0].sent).toContain('{"type":"studio_list"}');
    const event = { type: 'studio_catalog', campaign_id: 'a'.repeat(32), stories: [] };
    sockets[0].receive(event);
    expect(catalog).toHaveBeenCalledWith({ server: 'ws://localhost:8766/ws', catalog: event });
    sockets[0].receive({ ...event, stories: [{ id: '../secret', audio_url: '/private.wav' }] });
    expect(catalog).toHaveBeenCalledTimes(1);
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
  const speechCatalog = {
    type: 'gm_npc_list',
    npcs: [
      { id: 'village/guide', name: 'Guide', active: true },
      { id: 'foret/guide', name: 'Guide', active: false },
    ],
    speech_attitudes: [
      { id: 'agacement', label: 'Agacement' },
      { id: 'amusant', label: 'Amusant' },
      { id: 'rude', label: 'Rude' },
      { id: 'complaisant', label: 'Complaisant' },
    ],
  };
  it.each(['agacement', 'amusant', 'rude', 'complaisant'])(
    'sends the exact NPC ID and %s cue without adding a player turn or switching first',
    (attitude) => {
      sockets[0].hello({ secret_approval: true, text_input: false });
      sockets[0].receive(speechCatalog);
      expect(ws.speakNpc('foret/guide', attitude)).toBe(true);
      expect(sockets[0].sent).toEqual([
        '{"type":"status"}',
        JSON.stringify({ type: 'speak_npc', npc: 'foret/guide', attitude }),
      ]);
      expect(store.value).toEqual([]);
      sockets[0].receive({ type: 'npc_switched', npc: 'Guide' });
      sockets[0].receive({ type: 'state', state: 'processing' });
      sockets[0].receive({ type: 'npc_replied', npc: 'Guide', text: 'Bonjour !' });
      expect(store.current?.npc).toBe('Guide');
      expect(store.value.filter((message) => message.speaker === 'player')).toEqual([]);
      expect(store.value.at(-1)?.text).toBe('Bonjour !');
    },
  );
  it('requires authorized GM catalog targets and attitudes, including on legacy connections', () => {
    expect(ws.speakNpc('foret/guide', 'rude')).toBe(false);
    sockets[0].hello();
    const catalog = vi.fn();
    ws.speechCatalog$.subscribe(catalog);
    sockets[0].receive(speechCatalog);
    expect(catalog).toHaveBeenCalledTimes(1);
    expect(ws.speakNpc('foret/guide', 'rude')).toBe(false);
    ws.connect('ws://gm:8766/ws');
    sockets[1].hello({ secret_approval: true });
    expect(ws.speakNpc('foret/guide', 'rude')).toBe(false);
    sockets[1].receive(speechCatalog);
    expect(ws.speakNpc('Guide', 'rude')).toBe(false);
    expect(ws.speakNpc('foret/guide', 'unknown')).toBe(false);
    expect(sockets[1].sent).toEqual(['{"type":"status"}']);
  });
  it('locks double taps immediately and unlocks on server states, status and errors', () => {
    sockets[0].hello({ secret_approval: true });
    sockets[0].receive(speechCatalog);
    expect(ws.speakNpc('foret/guide', 'rude')).toBe(true);
    expect(ws.speakNpc('village/guide', 'amusant')).toBe(false);
    sockets[0].receive({ type: 'error', message: 'NPC speech cue rejected' });
    expect(ws.speakNpc('village/guide', 'amusant')).toBe(true);
    for (const state of ['processing', 'recording', 'speaking']) {
      sockets[0].receive({ type: 'state', state });
      expect(ws.speakNpc('foret/guide', 'rude')).toBe(false);
    }
    sockets[0].receive({ type: 'status', state: 'idle', npc: 'Serveur' });
    expect(ws.currentNpcState).toBe('idle');
    expect(ws.speakNpc('foret/guide', 'rude')).toBe(true);
  });
  it('clears GM lists and pending cues on reconnection and releases failed sends', () => {
    sockets[0].hello({ secret_approval: true });
    sockets[0].receive(speechCatalog);
    const pending = vi.fn();
    ws.speechPending$.subscribe(pending);
    vi.spyOn(sockets[0], 'send').mockImplementationOnce(() => {
      throw new Error('network');
    });
    expect(ws.speakNpc('foret/guide', 'rude')).toBe(false);
    expect(pending).toHaveBeenLastCalledWith(false);
    expect(ws.speakNpc('foret/guide', 'rude')).toBe(true);
    expect(pending).toHaveBeenLastCalledWith(true);
    sockets[0].close();
    expect(pending).toHaveBeenLastCalledWith(false);
    const catalog = vi.fn();
    ws.speechCatalog$.subscribe(catalog);
    expect(catalog).toHaveBeenLastCalledWith({
      type: 'gm_npc_list',
      npcs: [],
      speech_attitudes: [],
    });
    vi.advanceTimersByTime(1000);
    sockets[1].hello({ secret_approval: true });
    expect(ws.speakNpc('foret/guide', 'rude')).toBe(false);
    sockets[1].receive(speechCatalog);
    expect(ws.speakNpc('foret/guide', 'rude')).toBe(true);
  });
  it('ignores malformed catalogs and supports older GM catalogs with no speech buttons', () => {
    sockets[0].hello({ secret_approval: true });
    const catalog = vi.fn();
    ws.speechCatalog$.subscribe(catalog);
    for (const invalid of [
      { ...speechCatalog, npcs: [null] },
      { ...speechCatalog, npcs: [{ id: 'npc', name: 'NPC' }] },
      { ...speechCatalog, speech_attitudes: [{ id: 'rude', label: 42 }] },
      { ...speechCatalog, speech_attitudes: [null] },
      { ...speechCatalog, npcs: [speechCatalog.npcs[0], speechCatalog.npcs[0]] },
    ])
      sockets[0].receive(invalid);
    expect(catalog).toHaveBeenCalledTimes(1);
    sockets[0].receive({ type: 'gm_npc_list', npcs: speechCatalog.npcs });
    expect(catalog).toHaveBeenLastCalledWith({ ...speechCatalog, speech_attitudes: [] });
    expect(ws.speakNpc('foret/guide', 'rude')).toBe(false);
    expect(ws.connected).toBe(true);
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
    expect(store.value.every((message) => message.npc !== 'Serveur')).toBe(true);
    let list: unknown;
    ws.npcs$.subscribe((value) => (list = value));
    sockets[0].receive({ type: 'npc_list', npcs: [{ id: 'guide', name: 'Guide' }] });
    expect(list).toEqual([{ id: 'guide', name: 'Guide' }]);
  });
  it('uses GM notes from hello, list and switch without leaking them to other NPCs', () => {
    sockets[0].receive({
      type: 'hello',
      protocol: 1,
      npc: 'Serveur',
      state: 'idle',
      gm_notes: { behavior: 'Discret', secret_count: 0 },
    });
    expect(store.current?.gmNotes).toEqual({ behavior: 'Discret', secret_count: 0 });
    sockets[0].receive({
      type: 'npc_list',
      npcs: [{ id: 'guide', name: 'Guide', gm_notes: { attitude: 'Amical', secret_count: 2 } }],
    });
    expect(store.current?.gmNotes?.behavior).toBe('Discret');
    sockets[0].receive({ type: 'npc_switched', npc: 'Guide' });
    expect(store.current?.gmNotes).toEqual({ attitude: 'Amical', secret_count: 2 });
    sockets[0].receive({ type: 'npc_switched', npc: 'Inconnu' });
    expect(store.current?.gmNotes).toBeUndefined();
    sockets[0].receive({ type: 'npc_switched', npc: 'Serveur', gm_notes: {} });
    expect(store.current?.gmNotes).toEqual({});
  });
  it('accepts secret details without a GM capability and sanitizes malformed entries', () => {
    sockets[0].receive({
      type: 'hello',
      protocol: 1,
      npc: 'Serveur',
      state: 'idle',
      gm_notes: { secrets: ['  Cache une clé.  ', null, 42, '', '  ', 'Protège un fugitif.'] },
    });
    expect(ws.connected).toBe(true);
    expect(store.current?.gmNotes?.secrets).toEqual(['Cache une clé.', 'Protège un fugitif.']);
    sockets[0].receive({ type: 'npc_switched', npc: 'Guide', gm_notes: { secrets: 'invalide' } });
    expect(store.current?.gmNotes).toEqual({});
    sockets[0].receive({
      type: 'npc_list',
      npcs: [{ id: 'guide', name: 'Guide', gm_notes: { secrets: [] } }],
    });
    expect(store.current?.gmNotes?.secrets).toEqual([]);
  });
  it('ignores malformed optional GM fields while accepting the handshake', () => {
    sockets[0].receive({
      type: 'hello',
      protocol: 1,
      npc: 'Serveur',
      state: 'idle',
      gm_notes: { behavior: 42, attitude: '  Prudent  ', secret_count: -1 },
    });
    expect(ws.connected).toBe(true);
    expect(store.current?.gmNotes).toEqual({ attitude: 'Prudent' });
    for (const secret_count of [1.5, '3', null, Number.MAX_SAFE_INTEGER + 1]) {
      sockets[0].receive({ type: 'npc_switched', npc: 'Serveur', gm_notes: { secret_count } });
      expect(store.current?.gmNotes?.secret_count).toBeUndefined();
    }
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
  it('restores only the selected PNJ conversation across switches and reconnection', () => {
    sockets[0].hello({ npc_switch: true });
    ws.say('Bonjour');
    sockets[0].receive({ type: 'npc_replied', npc: 'Serveur', text: 'Bienvenue' });
    sockets[0].receive({ type: 'npc_switched', npc: 'Guide' });
    expect(store.value.some((message) => message.text === 'Bonjour')).toBe(false);
    sockets[0].receive({ type: 'npc_replied', npc: 'Serveur', text: 'Ancienne réponse' });
    expect(store.value.some((message) => message.text === 'Ancienne réponse')).toBe(false);
    sockets[0].receive({ type: 'npc_switched', npc: 'Serveur' });
    expect(store.value.slice(0, 2).map((message) => message.text)).toEqual([
      'Bonjour',
      'Bienvenue',
    ]);
    sockets[0].close();
    expect(store.value[0].text).toBe('Bonjour');
    vi.advanceTimersByTime(1000);
    sockets[1].hello();
    expect(store.value[0].text).toBe('Bonjour');
    ws.connect('ws://other:8766/ws');
    sockets[2].hello();
    expect(store.value).toEqual([]);
  });
  it('ignores audio from a PNJ who is no longer selected', () => {
    sockets[0].hello();
    const packets: AudioPacket[] = [];
    ws.audio$.subscribe((packet) => packets.push(packet));
    sockets[0].receive({
      type: 'audio_start',
      npc: 'Old',
      sample_rate: 22050,
      channels: 1,
      format: 'pcm_s16le',
    });
    sockets[0].onmessage?.({ data: new ArrayBuffer(4) });
    sockets[0].receive({ type: 'audio_end' });
    expect(packets).toEqual([]);
  });
  it('saves the original player PCM and merges its transcription without duplicating messages', () => {
    sockets[0].hello({ audio_input: true });
    const pcm = new Uint8Array([0, 128, 255, 127]).buffer;
    expect(ws.sendAudio(pcm)).toBe(true);
    expect(store.value).toHaveLength(1);
    expect(store.value[0].audio?.[0]).toEqual({ data: pcm, rate: 16000 });
    sockets[0].receive({ type: 'player_spoke', text: 'Bonjour' });
    expect(store.value).toHaveLength(1);
    expect(store.value[0].text).toBe('Bonjour');
    ws.disconnect();
    expect(store.value[0].audio?.[0].data).toEqual(pcm);
  });
  it('retains the player recording when audio input cannot be started on the server', () => {
    sockets[0].hello({ audio_input: true });
    vi.spyOn(sockets[0], 'send').mockImplementation(() => {
      throw new Error('offline');
    });
    expect(ws.sendAudio(new ArrayBuffer(4))).toBe(false);
    expect(store.value[0].audio).toHaveLength(1);
    sockets[0].receive({ type: 'player_spoke', text: 'Autre phrase' });
    expect(store.value).toHaveLength(2);
    expect(store.value[0].text).toBe('');
  });
  it('retains the player recording if the transport fails during the binary upload', () => {
    sockets[0].hello({ audio_input: true });
    vi.spyOn(sockets[0], 'send')
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error('network');
      });
    expect(ws.sendAudio(new ArrayBuffer(64000))).toBe(false);
    expect(store.value[0].audio?.[0].data.byteLength).toBe(64000);
    expect(ws.connected).toBe(false);
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
