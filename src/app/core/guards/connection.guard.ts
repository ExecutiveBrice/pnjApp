import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { NpcWebSocketService } from '../services/npc-websocket.service';
import { ConversationStore } from '../services/conversation.store';
export const connectionGuard: CanActivateFn = async () => {
  const ws = inject(NpcWebSocketService);
  const store = inject(ConversationStore);
  const router = inject(Router);
  await store.ready;
  return ws.connected || store.hasHistory || router.createUrlTree(['/connection']);
};
