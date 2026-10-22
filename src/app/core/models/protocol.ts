export type NpcState = 'idle' | 'recording' | 'processing' | 'speaking';
export type ConnectionState = 'disconnected' | 'connecting' | 'reconnecting' | 'connected';
export interface Capabilities {
  text_input: boolean;
  audio_input: boolean;
  audio_output: boolean;
  npc_switch: boolean;
  secret_approval: boolean;
}
export const DEFAULT_CAPABILITIES: Capabilities = {
  text_input: true,
  audio_input: false,
  audio_output: false,
  npc_switch: false,
  secret_approval: false,
};
export interface Npc {
  id: string;
  name: string;
  description?: string;
}
export interface HelloEvent {
  type: 'hello';
  protocol: number;
  npc: string;
  state: NpcState;
  capabilities?: Partial<Capabilities>;
}
export interface StateEvent {
  type: 'state';
  state: NpcState;
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
export type DisclosureDecision = 'approved' | 'rejected';
export interface SecretDisclosureRequest {
  request_id: string;
  npc: string;
  secret: string;
  context: string;
}
export interface SecretDisclosure extends SecretDisclosureRequest {
  status: 'pending' | 'sending' | DisclosureDecision;
}
export type SecretDisclosureEvent =
  | ({ type: 'secret_disclosure_requested' } & SecretDisclosureRequest)
  | { type: 'secret_disclosure_list'; requests: SecretDisclosureRequest[] }
  | { type: 'secret_disclosure_resolved'; request_id: string; decision: DisclosureDecision };
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
  | NpcListEvent
  | SecretDisclosureEvent;
export type ClientCommand =
  | { type: 'say'; text: string }
  | { type: 'switch_npc'; npc: string }
  | { type: 'stop_speaking' }
  | { type: 'status' }
  | { type: 'resolve_secret_disclosure'; request_id: string; decision: DisclosureDecision }
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
}

const states: readonly unknown[] = ['idle', 'recording', 'processing', 'speaking'];
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
const isDisclosureRequest = (value: unknown): value is SecretDisclosureRequest =>
  isRecord(value) &&
  nonEmptyString(value['request_id']) &&
  nonEmptyString(value['npc']) &&
  nonEmptyString(value['secret']) &&
  typeof value['context'] === 'string';
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
          ['text_input', 'audio_input', 'audio_output', 'npc_switch', 'secret_approval'].some(
            (key) => caps[key] !== undefined && typeof caps[key] !== 'boolean',
          ))
      )
        return null;
      return typeof value['protocol'] === 'number' && npc && states.includes(value['state'])
        ? (value as unknown as HelloEvent)
        : null;
    }
    case 'state':
      return states.includes(value['state']) ? (value as unknown as StateEvent) : null;
    case 'player_spoke':
      return text ? (value as unknown as PlayerSpokeEvent) : null;
    case 'npc_reply_chunk':
    case 'npc_replied':
      return text && npc ? (value as unknown as NpcReplyChunkEvent | NpcRepliedEvent) : null;
    case 'npc_switched':
      return npc ? (value as unknown as NpcSwitchedEvent) : null;
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
    case 'npc_list':
      return Array.isArray(value['npcs']) &&
        value['npcs'].every(
          (item) =>
            isRecord(item) &&
            typeof item['id'] === 'string' &&
            typeof item['name'] === 'string' &&
            (item['description'] === undefined || typeof item['description'] === 'string'),
        )
        ? (value as unknown as NpcListEvent)
        : null;
    case 'secret_disclosure_requested':
      return isDisclosureRequest(value) ? (value as unknown as SecretDisclosureEvent) : null;
    case 'secret_disclosure_list': {
      const requests = value['requests'];
      return Array.isArray(requests) &&
        requests.every(isDisclosureRequest) &&
        new Set(requests.map((request) => request.request_id)).size === requests.length
        ? (value as unknown as SecretDisclosureEvent)
        : null;
    }
    case 'secret_disclosure_resolved':
      return nonEmptyString(value['request_id']) &&
        (value['decision'] === 'approved' || value['decision'] === 'rejected')
        ? (value as unknown as SecretDisclosureEvent)
        : null;
    default:
      return null;
  }
}
