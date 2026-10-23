import { Injector, runInInjectionContext } from '@angular/core';
import { Router } from '@angular/router';
import { AlertController, ToastController } from '@ionic/angular';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioPlaybackService } from '../../core/services/audio-playback.service';
import { MicrophoneService } from '../../core/services/microphone.service';
import { NpcWebSocketService } from '../../core/services/npc-websocket.service';
import { SettingsService } from '../../core/services/settings.service';
import { SettingsPage } from './settings.page';

describe('SettingsPage session reset', () => {
  let page: SettingsPage;
  let role: string;
  let ws: { connected: boolean; resetCampaignSession: ReturnType<typeof vi.fn> };
  let alerts: { create: ReturnType<typeof vi.fn> };
  let stop: ReturnType<typeof vi.fn>;
  let cancel: ReturnType<typeof vi.fn>;
  let navigate: ReturnType<typeof vi.fn>;
  let toast: { create: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    role = 'destructive';
    ws = { connected: true, resetCampaignSession: vi.fn().mockResolvedValue(undefined) };
    stop = vi.fn();
    cancel = vi.fn();
    navigate = vi.fn().mockResolvedValue(true);
    alerts = {
      create: vi.fn().mockResolvedValue({
        present: vi.fn(),
        onDidDismiss: async () => ({ role }),
      }),
    };
    toast = { create: vi.fn().mockResolvedValue({ present: vi.fn() }) };
    const injector = Injector.create({
      providers: [
        { provide: SettingsService, useValue: { value: { host: 'localhost', port: 8766 } } },
        { provide: NpcWebSocketService, useValue: ws },
        { provide: AudioPlaybackService, useValue: { stop } },
        { provide: MicrophoneService, useValue: { cancel } },
        { provide: AlertController, useValue: alerts },
        { provide: Router, useValue: { navigateByUrl: navigate } },
        { provide: ToastController, useValue: toast },
      ],
    });
    page = runInInjectionContext(injector, () => new SettingsPage());
  });

  it('does nothing when confirmation is cancelled or the server is disconnected', async () => {
    role = 'cancel';
    await page.confirmSessionReset();
    expect(ws.resetCampaignSession).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(page.resetting).toBe(false);
    ws.connected = false;
    await page.confirmSessionReset();
    expect(alerts.create).toHaveBeenCalledOnce();
  });

  it('stops playback and capture, waits for reset, then returns to the connection', async () => {
    let finish!: () => void;
    ws.resetCampaignSession.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    const reset = page.confirmSessionReset();
    await vi.waitFor(() => expect(ws.resetCampaignSession).toHaveBeenCalledOnce());
    expect(stop).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
    await page.confirmSessionReset();
    expect(alerts.create).toHaveBeenCalledOnce();
    finish();
    await reset;
    expect(navigate).toHaveBeenCalledWith('/connection');
    expect(toast.create).toHaveBeenCalledOnce();
    expect(page.resetting).toBe(false);
  });

  it('shows the failure and allows retry without announcing success', async () => {
    ws.resetCampaignSession.mockRejectedValue(new Error('Nettoyage refusé par PNJ.'));
    await page.confirmSessionReset();
    expect(page.resetError).toBe('Nettoyage refusé par PNJ.');
    expect(page.resetting).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    expect(toast.create).not.toHaveBeenCalled();
  });
});
