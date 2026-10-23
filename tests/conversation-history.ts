import {
  ConversationHistoryService,
  SavedConversation,
} from '../src/app/core/services/conversation-history.service';

export class MemoryHistory extends ConversationHistoryService {
  readonly saved = new Map<string, SavedConversation>();
  override async clear(): Promise<void> {
    this.saved.clear();
  }
  override async load(): Promise<SavedConversation[]> {
    return structuredClone([...this.saved.values()]);
  }
  override async save(conversation: SavedConversation): Promise<void> {
    this.saved.set(conversation.key, structuredClone(conversation));
  }
}
