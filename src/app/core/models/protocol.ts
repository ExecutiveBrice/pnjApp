export type NpcState = 'idle' | 'recording' | 'processing' | 'speaking';
export type ConnectionState = 'disconnected' | 'connecting' | 'reconnecting' | 'connected';
export interface Capabilities {
  text_input: boolean;
  audio_input: boolean;
  audio_output: boolean;
  npc_switch: boolean;
  secret_approval?: boolean;
  voice_design?: boolean;
  story_generation?: boolean;
}
export interface StudioStory {
  id: string;
  title: string;
  text: string;
  description: string;
  language: string;
  created_at: string;
  duration: number;
  audio_url: string;
}
export interface StudioCatalogEvent {
  type: 'studio_catalog';
  campaign_id: string;
  stories: StudioStory[];
}

export function parseStudioStory(value: unknown): StudioStory | null {
  if (!isRecord(value)) return null;
  const id = value['id'];
  if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) return null;
  if (
    !['title', 'text', 'description', 'language', 'created_at'].every(
      (key) => typeof value[key] === 'string',
    )
  )
    return null;
  return typeof value['duration'] === 'number' &&
    Number.isFinite(value['duration']) &&
    value['duration'] >= 0 &&
    value['audio_url'] === `/studio/audio/${id}.wav`
    ? (value as unknown as StudioStory)
    : null;
}
export const DEFAULT_CAPABILITIES: Capabilities = {
  text_input: true,
  audio_input: false,
  audio_output: false,
  npc_switch: false,
};
export interface Npc {
  id: string;
  name: string;
  gm_notes?: NpcGmNotes;
}
export interface NpcGmNotes {
  behavior?: string;
  attitude?: string;
  motivation?: string;
  leverage?: string;
  secret_count?: number;
  secrets?: string[];
}
export interface HelloEvent {
  type: 'hello';
  protocol: number;
  npc: string;
  state: NpcState;
  capabilities?: Partial<Capabilities>;
  gm_notes?: NpcGmNotes;
}
export interface StateEvent {
  type: 'state' | 'status';
  state: NpcState;
}
export interface SpeechAttitude {
  id: string;
  label: string;
}
export interface SpeechNpc {
  id: string;
  name: string;
  active: boolean;
}
export interface GmNpcListEvent {
  type: 'gm_npc_list';
  npcs: SpeechNpc[];
  speech_attitudes: SpeechAttitude[];
}
export interface PlayerSpokeEvent {
  type: 'player_spoke';
  text: string;
}
export interface NpcReplyChunkEvent {
  type: 'npc_reply_chunk';
  npc: string;
  text: string;
}
export interface NpcRepliedEvent {
  type: 'npc_replied';
  npc: string;
  text: string;
}
export interface NpcSwitchedEvent {
  type: 'npc_switched';
  npc: string;
  gm_notes?: NpcGmNotes;
}
export interface ErrorEvent {
  type: 'error';
  message: string;
}
export interface AudioStartEvent {
  type: 'audio_start';
  npc: string;
  sample_rate: number;
  channels: 1;
  format: 'pcm_s16le';
}
export interface AudioEndEvent {
  type: 'audio_end';
}
export interface NpcListEvent {
  type: 'npc_list';
  npcs: Npc[];
}
export type ServerEvent =
  | HelloEvent
  | StateEvent
  | PlayerSpokeEvent
  | NpcReplyChunkEvent
  | NpcRepliedEvent
  | NpcSwitchedEvent
  | ErrorEvent
  | AudioStartEvent
  | AudioEndEvent
  | StudioCatalogEvent
  | GmNpcListEvent
  | NpcListEvent;
export type ClientCommand =
  | { type: 'studio_list' }
  | { type: 'say'; text: string }
  | { type: 'speak_npc'; npc: string; attitude: string }
  | { type: 'switch_npc'; npc: string }
  | { type: 'stop_speaking' }
  | { type: 'status' }
  | { type: 'audio_input_start'; sample_rate: 16000; channels: 1; format: 'pcm_s16le' }
  | { type: 'audio_input_end' };
export type AudioPacket =
  AudioStartEvent | AudioEndEvent | { type: 'chunk'; data: ArrayBuffer } | { type: 'reset' };
export interface ConversationMessage {
  id: string;
  speaker: 'player' | 'npc' | 'system';
  text: string;
  npc?: string;
  timestamp: Date;
  streaming?: boolean;
  audio?: ConversationAudio[];
}
export interface ConversationAudio {
  data: ArrayBuffer;
  rate: number;
}

const states: readonly unknown[] = ['idle', 'recording', 'processing', 'speaking'];
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Optional GM details must never prevent a legacy or otherwise valid handshake. */
export function parseNpcGmNotes(value: unknown): NpcGmNotes | undefined {
  if (!isRecord(value)) return undefined;
  const notes: NpcGmNotes = {};
  for (const key of ['behavior', 'attitude', 'motivation', 'leverage'] as const) {
    const text = value[key];
    if (typeof text === 'string' && text.trim()) notes[key] = text.trim();
  }
  const count = value['secret_count'];
  if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)
    notes.secret_count = count;
  if (Array.isArray(value['secrets'])) {
    notes.secrets = value['secrets']
      .filter((secret): secret is string => typeof secret === 'string' && !!secret.trim())
      .map((secret) => secret.trim());
  }
  return notes;
}
export function eventType(value: unknown): string {
  return isRecord(value) && typeof value['type'] === 'string' ? value['type'] : '(absent)';
}

/** Validate the untrusted wire format before it enters application state. */
export function parseServerEvent(value: unknown): ServerEvent | null {
  if (!isRecord(value)) return null;
  const text = typeof value['text'] === 'string';
  const npc = typeof value['npc'] === 'string';
  switch (value['type']) {
    case 'hello': {
      const caps = value['capabilities'];
      if (
        caps !== undefined &&
        (!isRecord(caps) ||
          [
            'text_input',
            'audio_input',
            'audio_output',
            'npc_switch',
            'secret_approval',
            'voice_design',
            'story_generation',
          ].some((key) => caps[key] !== undefined && typeof caps[key] !== 'boolean'))
      )
        return null;
      return typeof value['protocol'] === 'number' && npc && states.includes(value['state'])
        ? ({ ...value, gm_notes: parseNpcGmNotes(value['gm_notes']) } as unknown as HelloEvent)
        : null;
    }
    case 'state':
    case 'status':
      return states.includes(value['state']) ? (value as unknown as StateEvent) : null;
    case 'gm_npc_list': {
      if (
        !Array.isArray(value['npcs']) ||
        !value['npcs'].every(
          (item) =>
            isRecord(item) &&
            typeof item['id'] === 'string' &&
            item['id'].trim() &&
            typeof item['name'] === 'string' &&
            item['name'].trim() &&
            typeof item['active'] === 'boolean',
        )
      )
        return null;
      const attitudes = value['speech_attitudes'] ?? [];
      if (
        !Array.isArray(attitudes) ||
        !attitudes.every(
          (item) =>
            isRecord(item) &&
            typeof item['id'] === 'string' &&
            item['id'].trim() &&
            typeof item['label'] === 'string' &&
            item['label'].trim(),
        )
      )
        return null;
      const npcs = value['npcs'] as SpeechNpc[];
      const speechAttitudes = attitudes as SpeechAttitude[];
      if (
        new Set(npcs.map((item) => item.id)).size !== npcs.length ||
        new Set(speechAttitudes.map((item) => item.id)).size !== speechAttitudes.length
      )
        return null;
      return {
        type: 'gm_npc_list',
        npcs: npcs.map(({ id, name, active }) => ({ id, name, active })),
        speech_attitudes: speechAttitudes.map(({ id, label }) => ({ id, label })),
      };
    }
    case 'player_spoke':
      return text ? (value as unknown as PlayerSpokeEvent) : null;
    case 'npc_reply_chunk':
    case 'npc_replied':
      return text && npc ? (value as unknown as NpcReplyChunkEvent | NpcRepliedEvent) : null;
    case 'npc_switched':
      return npc
        ? ({
            ...value,
            gm_notes: parseNpcGmNotes(value['gm_notes']),
          } as unknown as NpcSwitchedEvent)
        : null;
    case 'error':
      return typeof value['message'] === 'string' ? (value as unknown as ErrorEvent) : null;
    case 'audio_start':
      return npc &&
        typeof value['sample_rate'] === 'number' &&
        Number.isInteger(value['sample_rate']) &&
        value['sample_rate'] >= 8000 &&
        value['sample_rate'] <= 192000 &&
        value['channels'] === 1 &&
        value['format'] === 'pcm_s16le'
        ? (value as unknown as AudioStartEvent)
        : null;
    case 'audio_end':
      return { type: 'audio_end' };
    case 'studio_catalog': {
      if (
        typeof value['campaign_id'] !== 'string' ||
        !/^[a-f0-9]{32}$/.test(value['campaign_id']) ||
        !Array.isArray(value['stories'])
      )
        return null;
      const stories = value['stories'].map(parseStudioStory);
      if (stories.some((story) => story === null)) return null;
      return {
        type: 'studio_catalog',
        campaign_id: value['campaign_id'],
        stories: stories as StudioStory[],
      };
    }
    case 'npc_list':
      return Array.isArray(value['npcs']) &&
        value['npcs'].every(
          (item) =>
            isRecord(item) && typeof item['id'] === 'string' && typeof item['name'] === 'string',
        )
        ? {
            type: 'npc_list',
            npcs: (value['npcs'] as Record<string, unknown>[]).map((item) => ({
              id: item['id'] as string,
              name: item['name'] as string,
              gm_notes: parseNpcGmNotes(item['gm_notes']),
            })),
          }
        : null;
    default:
      return null;
  }
}
