import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { NpcWebSocketService } from '../services/npc-websocket.service';
export const connectionGuard: CanActivateFn = () =>
  inject(NpcWebSocketService).connected || inject(Router).createUrlTree(['/connection']);
