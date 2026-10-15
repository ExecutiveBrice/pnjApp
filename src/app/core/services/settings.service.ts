import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';

export interface AppSettings {
  host: string;
  port: number;
  autoReconnect: boolean;
  autoPlayAudio: boolean;
  showTranscript: boolean;
  volume: number;
}
const defaults: AppSettings = {
  host: '',
  port: 8766,
  autoReconnect: true,
  autoPlayAudio: true,
  showTranscript: true,
  volume: 0.85,
};
@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly state = new BehaviorSubject<AppSettings>(this.load());
  readonly settings$ = this.state.asObservable();
  readonly errors$ = new Subject<string>();
  get value(): AppSettings {
    return this.state.value;
  }
  update(patch: Partial<AppSettings>): void {
    const next = { ...this.value, ...patch };
    this.state.next(next);
    try {
      localStorage.setItem('npc.settings.v1', JSON.stringify(next));
    } catch {
      this.errors$.next(
        'Les préférences sont appliquées, mais leur stockage local est indisponible.',
      );
    }
  }
  private load(): AppSettings {
    try {
      const raw: unknown = JSON.parse(localStorage.getItem('npc.settings.v1') ?? 'null');
      if (!raw || typeof raw !== 'object') return { ...defaults };
      const value = raw as Record<string, unknown>;
      return {
        host: typeof value['host'] === 'string' ? value['host'] : defaults.host,
        port:
          typeof value['port'] === 'number' &&
          Number.isInteger(value['port']) &&
          value['port'] > 0 &&
          value['port'] <= 65535
            ? value['port']
            : defaults.port,
        autoReconnect:
          typeof value['autoReconnect'] === 'boolean'
            ? value['autoReconnect']
            : defaults.autoReconnect,
        autoPlayAudio:
          typeof value['autoPlayAudio'] === 'boolean'
            ? value['autoPlayAudio']
            : defaults.autoPlayAudio,
        showTranscript:
          typeof value['showTranscript'] === 'boolean'
            ? value['showTranscript']
            : defaults.showTranscript,
        volume:
          typeof value['volume'] === 'number' && value['volume'] >= 0 && value['volume'] <= 1
            ? value['volume']
            : defaults.volume,
      };
    } catch {
      return { ...defaults };
    }
  }
}
