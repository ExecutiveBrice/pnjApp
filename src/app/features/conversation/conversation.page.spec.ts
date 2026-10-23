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
import {
  Capabilities,
  ConnectionState,
  GmNpcListEvent,
  Npc,
  NpcState,
} from '../../core/models/protocol';

describe('ConversationPage speech cues', () => {
  const catalog = {
    type: 'gm_npc_list' as const,
    npcs: [
      { id: 'village/guide', name: 'Guide', active: true },
      { id: 'foret/guide', name: 'Guide', active: false },
    ],
  };
  let page: ConversationPage;
  let recording: BehaviorSubject<boolean>;
  let speaking: BehaviorSubject<boolean>;
  let pending: BehaviorSubject<boolean>;
  let state: BehaviorSubject<NpcState>;
  let connection: BehaviorSubject<ConnectionState>;
  let speechCatalog: BehaviorSubject<GmNpcListEvent>;
  let npcs: BehaviorSubject<Npc[]>;
  let active: BehaviorSubject<SavedConversation | undefined>;
  let switchNpc: ReturnType<typeof vi.fn>;
  let capabilities: BehaviorSubject<Capabilities>;
  let speakNpc: ReturnType<typeof vi.fn>;
  let start: ReturnType<typeof vi.fn>;
  let requestNpcSecrets: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    recording = new BehaviorSubject(false);
    speaking = new BehaviorSubject(false);
    pending = new BehaviorSubject(false);
    state = new BehaviorSubject<NpcState>('idle');
    connection = new BehaviorSubject<ConnectionState>('connected');
    speechCatalog = new BehaviorSubject<GmNpcListEvent>(catalog);
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
    requestNpcSecrets = vi.fn();
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
            disclosures$: new BehaviorSubject([]),
            speechCatalog$: speechCatalog,
            speechPending$: pending,
            connected: true,
            speakNpc,
            switchNpc,
            requestNpcSecrets,
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
            available: true,
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
    page.speakNpc('greeting');
    expect(speakNpc).toHaveBeenCalledWith('foret/guide', 'greeting');
    speechCatalog.next({ ...catalog, npcs: [catalog.npcs[0]] });
    expect(page.speechTarget()?.id).toBe('village/guide');
    speechCatalog.next({ ...catalog, npcs: [] });
    expect(page.speechDisabled()).toBe(true);
  });

  it('sends each speech action with only the selected NPC', () => {
    expect(page.speechActions.map((action) => action.label)).toEqual([
      'Présentation',
      'Meubler pour attendre',
      'Salutation',
    ]);
    for (const action of page.speechActions) {
      page.speakNpc(action.id);
      expect(speakNpc).toHaveBeenLastCalledWith('village/guide', action.id);
    }
    expect(page.hasSpeechControls()).toBe(true);
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

  it('displays the selected GM card and fetches its secrets by ID without triggering speech', () => {
    speechCatalog.next({
      ...catalog,
      npcs: catalog.npcs.map((npc, index) => ({
        ...npc,
        description: index ? 'Le guide de la forêt.' : 'Le guide du village.',
        gm_notes: index
          ? { scenario: 'Forêt', attitude: 'Méfiant', leverage: 'Du charbon', secret_count: 2 }
          : { scenario: 'Village', secret_count: 0 },
      })),
    });
    expect(page.gmNotes()?.scenario).toBe('Village');
    page.selectSpeechTarget('foret/guide');
    expect(page.displayedCharacter()?.description).toBe('Le guide de la forêt.');
    expect(page.gmNotes()).toEqual({
      scenario: 'Forêt',
      attitude: 'Méfiant',
      leverage: 'Du charbon',
      secret_count: 2,
    });
    page.toggleSecrets();
    expect(requestNpcSecrets).toHaveBeenCalledExactlyOnceWith('foret/guide');
    page.toggleSecrets();
    expect(requestNpcSecrets).toHaveBeenCalledTimes(1);
    expect(speakNpc).not.toHaveBeenCalled();
    connection.next('disconnected');
    page.toggleSecrets();
    expect(requestNpcSecrets).toHaveBeenCalledTimes(1);
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
      page.speakNpc('greeting');
      expect(page.speechDisabled()).toBe(true);
      blocker.next(false);
    }
    page.converting.set(true);
    page.speakNpc('greeting');
    page.converting.set(false);
    for (const busy of ['recording', 'processing', 'speaking'] as const) {
      state.next(busy);
      page.speakNpc('greeting');
    }
    state.next('idle');
    connection.next('disconnected');
    page.speakNpc('greeting');
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
    page.speakNpc('greeting');
    expect(speakNpc).not.toHaveBeenCalled();
    page.cancelRecording();
    grant(false);
    await capture;
    expect(page.speechDisabled()).toBe(false);
  });

  it('stops the NPC output before opening the microphone to avoid recording its voice', async () => {
    speaking.next(true);
    state.next('speaking');
    await page.startRecording();
    expect(page.audio.stop).toHaveBeenCalledOnce();
    expect(page.ws.stopSpeaking).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(vi.mocked(page.audio.stop).mock.invocationCallOrder[0]).toBeLessThan(
      start.mock.invocationCallOrder[0],
    );
    expect(vi.mocked(page.ws.stopSpeaking).mock.invocationCallOrder[0]).toBeLessThan(
      start.mock.invocationCallOrder[0],
    );
  });

  it('does not start a microphone capture while a cue awaits its server response', async () => {
    pending.next(true);
    await page.startRecording();
    expect(start).not.toHaveBeenCalled();
    expect(page.visualState()).toBe('processing');
  });
});
