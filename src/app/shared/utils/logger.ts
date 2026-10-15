import { environment } from '../../../environments/environment';
export const logger = {
  debug(scope: string, message: string): void {
    if (!environment.production) console.debug(`[NPC ${scope}] ${message}`);
  },
  warn(scope: string, message: string): void {
    console.warn(`[NPC ${scope}] ${message}`);
  },
};
