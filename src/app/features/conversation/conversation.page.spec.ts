import { DestroyRef, Injector, runInInjectionContext } from '@angular/core';
import { ModalController, ToastController } from '@ionic/angular';
import { BehaviorSubject, map } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationPage } from './conversation.page';
import { NpcWebSocketService } from '../../core/services/npc-websocket.service';
import { AudioPlaybackService } from '../../core/services/audio-playback.service';
import { MicrophoneService } from '../../core/services/microphone.service';
import { ConversationStore } from '../../core/services/conversation.store';
import { SettingsService } from '../../core/services/settings.service';
import { SavedConversation } from '../../core/services/conversation-history.service';
import { Capabilities, ConnectionState, Npc, NpcState } from '../../core/models/protocol';

describe('ConversationPage speech cues', () => {
  const catalog = {
    type: 'gm_npc_list' as const,
    npcs: [
      { id: 'village/guide', name: 'Guide', active: true },
      { id: 'foret/guide', name: 'Guide', active: false },
    ],
    speech_attitudes: [{ id: 'amusant', label: 'Amusant' }],
  };
  let page: ConversationPage;
  let recording: BehaviorSubject<boolean>;
  let speaking: BehaviorSubject<boolean>;
  let pending: BehaviorSubject<boolean>;
  let state: BehaviorSubject<NpcState>;
  let connection: BehaviorSubject<ConnectionState>;
  let speechCatalog: BehaviorSubject<typeof catalog>;
  let npcs: BehaviorSubject<Npc[]>;
  let active: BehaviorSubject<SavedConversation | undefined>;
  let switchNpc: ReturnType<typeof vi.fn>;
  let capabilities: BehaviorSubject<Capabilities>;
  let speakNpc: ReturnType<typeof vi.fn>;
  let start: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    recording = new BehaviorSubject(false);
    speaking = new BehaviorSubject(false);
    pending = new BehaviorSubject(false);
    state = new BehaviorSubject<NpcState>('idle');
    connection = new BehaviorSubject<ConnectionState>('connected');
    speechCatalog = new BehaviorSubject(catalog);
    npcs = new BehaviorSubject<Npc[]>([
      { id: 'village/guide', name: 'Guide', gm_notes: { behavior: 'Accueillant' } },
      {
        id: 'foret/guide',
        name: 'Guide',
        gm_notes: { behavior: 'Méfiant', secrets: ['Cache une clé.'] },
      },
    ]);
    active = new BehaviorSubject<SavedConversation | undefined>({
      key: 'village',
      server: 'ws://table/ws',
      npc: 'Guide',
      updatedAt: 1,
      messages: [],
      gmNotes: { behavior: 'Accueillant', secret_count: 0, secrets: [] },
    });
    speakNpc = vi.fn();
    switchNpc = vi.fn();
    start = vi.fn().mockResolvedValue(true);
    capabilities = new BehaviorSubject<Capabilities>({
      secret_approval: true,
      text_input: true,
      audio_input: true,
      audio_output: false,
      npc_switch: false,
    });
    const injector = Injector.create({
      providers: [
        { provide: DestroyRef, useValue: { onDestroy: () => () => undefined } },
        {
          provide: NpcWebSocketService,
          useValue: {
            npc$: active.pipe(map((conversation) => conversation?.npc ?? '')),
            connectionState$: connection,
            state: 'connected',
            npcState$: state,
            npcs$: npcs,
            capabilities$: capabilities,
            currentCapabilities: capabilities.value,
            messages$: new BehaviorSubject([]),
            speechCatalog$: speechCatalog,
            speechPending$: pending,
            connected: true,
            speakNpc,
            switchNpc,
            stopSpeaking: vi.fn(),
          },
        },
        {
          provide: AudioPlaybackService,
          useValue: {
            speaking$: speaking,
            pending$: new BehaviorSubject(false),
            unlock: vi.fn().mockResolvedValue(undefined),
            stop: vi.fn(),
          },
        },
        {
          provide: MicrophoneService,
          useValue: {
            recording$: recording,
            start,
            cancel: vi.fn(),
            finish: vi.fn().mockResolvedValue(null),
          },
        },
        {
          provide: ConversationStore,
          useValue: {
            histories$: new BehaviorSubject([]),
            active$: active,
            current: active.value,
          },
        },
        { provide: SettingsService, useValue: { settings$: new BehaviorSubject({}), value: {} } },
        { provide: ModalController, useValue: {} },
        { provide: ToastController, useValue: {} },
      ],
    });
    page = runInInjectionContext(injector, () => new ConversationPage());
  });

  it('defaults to the active ID and lets the GM target a different NPC with the same name', () => {
    expect(page.speechTarget()?.id).toBe('village/guide');
    page.selectSpeechTarget('foret/guide');
    expect(speakNpc).not.toHaveBeenCalled();
    page.speakNpc('amusant');
    expect(speakNpc).toHaveBeenCalledWith('foret/guide', 'amusant');
    speechCatalog.next({ ...catalog, npcs: [catalog.npcs[0]] });
    expect(page.speechTarget()?.id).toBe('village/guide');
    speechCatalog.next({ ...catalog, npcs: [] });
    expect(page.speechDisabled()).toBe(true);
  });

  it('shows the selected NPC notes immediately and opens only that character’s secrets', () => {
    expect(page.displayedNpc()).toBe('Guide');
    expect(page.gmNotes()?.behavior).toBe('Accueillant');
    expect(page.secretCount()).toBe(0);
    page.toggleSecrets();
    expect(page.secretsOpen()).toBe(true);
    page.selectSpeechTarget('foret/guide');
    expect(page.secretsOpen()).toBe(false);
    expect(page.gmNotes()?.behavior).toBe('Méfiant');
    expect(page.secretCount()).toBe(1);
    page.toggleSecrets();
    expect(page.secretsOpen()).toBe(true);
    expect(page.gmNotes()?.secrets).toEqual(['Cache une clé.']);
    page.toggleSecrets();
    expect(page.secretsOpen()).toBe(false);
    npcs.next([]);
    expect(page.gmNotes()).toBeUndefined();
    expect(speakNpc).not.toHaveBeenCalled();
  });

  it('keeps the offline character’s notes and secrets available without speech controls', () => {
    page.selectSpeechTarget('foret/guide');
    connection.next('disconnected');
    speechCatalog.next({ ...catalog, npcs: [] });
    active.next({
      ...active.value!,
      key: 'offline',
      npc: 'Sentinelle',
      gmNotes: { secrets: ['Protège un fugitif.'] },
    });
    expect(page.displayedNpc()).toBe('Sentinelle');
    expect(page.secretCount()).toBe(1);
    page.toggleSecrets();
    expect(page.secretsOpen()).toBe(true);
    expect(page.gmNotes()?.secrets).toEqual(['Protège un fugitif.']);
    active.next({ ...active.value!, key: 'other-server', gmNotes: {} });
    expect(page.secretsOpen()).toBe(false);
    expect(page.secretCount()).toBeUndefined();
  });

  it('selects the matching conversation when the server supports NPC switching', () => {
    capabilities.next({ ...capabilities.value, npc_switch: true });
    page.selectSpeechTarget('foret/guide');
    expect(switchNpc).toHaveBeenCalledExactlyOnceWith('foret/guide');
    expect(page.gmNotes()?.behavior).toBe('Méfiant');
    expect(speakNpc).not.toHaveBeenCalled();
    page.selectSpeechTarget('unknown');
    pending.next(true);
    page.selectSpeechTarget('village/guide');
    expect(switchNpc).toHaveBeenCalledTimes(1);
  });

  it('prevents cues during capture, conversion, local playback and server activity', () => {
    const blockers = [recording, speaking, pending];
    for (const blocker of blockers) {
      blocker.next(true);
      page.speakNpc('amusant');
      expect(page.speechDisabled()).toBe(true);
      blocker.next(false);
    }
    page.converting.set(true);
    page.speakNpc('amusant');
    page.converting.set(false);
    for (const busy of ['recording', 'processing', 'speaking'] as const) {
      state.next(busy);
      page.speakNpc('amusant');
    }
    state.next('idle');
    connection.next('disconnected');
    page.speakNpc('amusant');
    expect(speakNpc).not.toHaveBeenCalled();
    connection.next('connected');
    expect(page.speechDisabled()).toBe(false);
  });

  it('blocks cues while the microphone permission is pending and releases the guard on cancel', async () => {
    let grant!: (value: boolean) => void;
    start.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          grant = resolve;
        }),
    );
    const capture = page.startRecording();
    expect(page.speechDisabled()).toBe(true);
    page.speakNpc('amusant');
    expect(speakNpc).not.toHaveBeenCalled();
    page.cancelRecording();
    grant(false);
    await capture;
    expect(page.speechDisabled()).toBe(false);
  });

  it('does not start a microphone capture while a cue awaits its server response', async () => {
    pending.next(true);
    await page.startRecording();
    expect(start).not.toHaveBeenCalled();
    expect(page.visualState()).toBe('processing');
  });
});
