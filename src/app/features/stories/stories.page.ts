import {
  Component,
  DestroyRef,
  ElementRef,
  ViewChild,
  effect,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { IonButton, IonButtons, IonContent, IonHeader, IonTitle, IonToolbar } from '@ionic/angular';
import { StudioStory } from '../../core/models/protocol';
import { StoriesService } from '../../core/services/stories.service';
import { NpcWebSocketService } from '../../core/services/npc-websocket.service';
import { AudioPlaybackService } from '../../core/services/audio-playback.service';
import { SettingsService } from '../../core/services/settings.service';
import { OfflineAppService } from '../../core/services/offline-app.service';

@Component({
  selector: 'app-stories',
  standalone: true,
  imports: [RouterLink, IonButton, IonButtons, IonContent, IonHeader, IonTitle, IonToolbar],
  templateUrl: './stories.page.html',
  styleUrl: './stories.page.scss',
})
export class StoriesPage {
  @ViewChild('player') player?: ElementRef<HTMLAudioElement>;
  readonly stories = inject(StoriesService);
  readonly offlineApp = inject(OfflineAppService);
  readonly ws = inject(NpcWebSocketService);
  private readonly audio = inject(AudioPlaybackService);
  private readonly settings = inject(SettingsService);
  readonly connection = toSignal(this.ws.connectionState$, { initialValue: this.ws.state });
  readonly capabilities = toSignal(this.ws.capabilities$, {
    initialValue: this.ws.currentCapabilities,
  });
  readonly volume = toSignal(this.settings.settings$, { initialValue: this.settings.value });
  readonly selectedStory = signal<StudioStory | undefined>(undefined);
  readonly source = signal('');
  readonly playbackError = signal('');
  private local = false;
  private playbackKey = '';
  private generation = 0;

  constructor() {
    effect(() => {
      const key = this.stories.selectedKey();
      const online = this.stories.online();
      if (
        this.playbackKey &&
        (this.playbackKey !== key || (!online && this.source() && !this.local))
      )
        this.close();
    });
    effect(() => {
      const volume = this.volume().volume;
      if (this.player) this.player.nativeElement.volume = volume;
    });
    this.audio.speaking$.pipe(takeUntilDestroyed()).subscribe((speaking) => {
      if (speaking) this.player?.nativeElement.pause();
    });
    inject(DestroyRef).onDestroy(() => this.close());
  }

  ionViewWillLeave(): void {
    this.close();
  }

  label(server: string, campaign: string): string {
    return `${new URL(server).host} · campagne ${campaign.slice(0, 8)}`;
  }

  duration(seconds: number): string {
    return `${Math.floor(seconds / 60)} min ${Math.floor(seconds % 60)
      .toString()
      .padStart(2, '0')} s`;
  }

  async open(story: StudioStory): Promise<void> {
    this.close();
    const generation = ++this.generation;
    this.playbackKey = this.stories.selectedKey();
    this.selectedStory.set(story);
    this.playbackError.set('');
    // Text remains readable even for stories which haven't been downloaded.
    if (!this.stories.online() && !this.stories.selected()?.downloaded.includes(story.id)) return;
    try {
      const audio = await this.stories.audio(story);
      if (generation !== this.generation) {
        if (audio.local) URL.revokeObjectURL(audio.url);
        return;
      }
      this.local = audio.local;
      this.source.set(audio.url);
    } catch (error) {
      if (generation === this.generation)
        this.playbackError.set(
          error instanceof Error ? error.message : 'Lecture audio indisponible.',
        );
    }
  }

  onPlay(): void {
    this.audio.stop();
    if (this.ws.connected && this.ws.currentNpcState !== 'idle') this.ws.stopSpeaking();
    if (this.player) this.player.nativeElement.volume = this.settings.value.volume;
  }

  async remove(story: StudioStory): Promise<void> {
    if (this.selectedStory()?.id === story.id) this.close();
    try {
      await this.stories.remove(story);
    } catch {
      this.stories.error.set('La copie locale n’a pas pu être supprimée.');
    }
  }

  close(): void {
    ++this.generation;
    const player = this.player?.nativeElement;
    if (player) {
      player.pause();
      player.removeAttribute('src');
      player.load();
    }
    if (this.local && this.source()) URL.revokeObjectURL(this.source());
    this.local = false;
    this.source.set('');
    this.selectedStory.set(undefined);
    this.playbackKey = '';
  }
}
