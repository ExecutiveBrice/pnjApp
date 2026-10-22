import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject, Subject, Subscription, distinctUntilChanged, map } from 'rxjs';
import { AudioPacket, AudioStartEvent, ConversationMessage } from '../models/protocol';
import { NpcWebSocketService } from './npc-websocket.service';
import { SettingsService } from './settings.service';
import { pcm16ToFloat32 } from '../../shared/utils/pcm';
import { logger } from '../../shared/utils/logger';
import { ConversationStore } from './conversation.store';

@Injectable({ providedIn: 'root' })
export class AudioPlaybackService implements OnDestroy {
  private context?: AudioContext;
  private gain?: GainNode;
  private header?: AudioStartEvent;
  private messageId?: string;
  private chunks: ArrayBuffer[] = [];
  private bytes = 0;
  private queue: { data: ArrayBuffer; rate: number }[] = [];
  private replaying = false;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private scheduling = false;
  private manualPlayback = false;
  private nextStartTime = 0;
  private queuedSeconds = 0;
  private readonly startupBufferSeconds = 0.16;
  private readonly maxBufferedSeconds = 120;
  private generation = 0;
  private readonly pending = new BehaviorSubject(false);
  private readonly speaking = new BehaviorSubject(false);
  readonly pending$ = this.pending.asObservable();
  readonly speaking$ = this.speaking.asObservable();
  readonly errors$ = new Subject<string>();
  private readonly subscriptions = new Subscription();

  constructor(
    ws: NpcWebSocketService,
    private readonly settings: SettingsService,
    private readonly store: ConversationStore,
  ) {
    this.subscriptions.add(ws.audio$.subscribe((packet) => this.receive(packet)));
    this.subscriptions.add(
      store.active$
        .pipe(
          map((conversation) => conversation?.key),
          distinctUntilChanged(),
        )
        .subscribe(() => this.stop()),
    );
    this.subscriptions.add(
      settings.settings$.subscribe((value) => {
        if (this.gain) this.gain.gain.value = value.volume;
      }),
    );
  }
  /** Must be invoked directly from a tap/click to unlock mobile audio. */
  async unlock(): Promise<void> {
    if (!this.context) {
      try {
        // Pocket emits 24 kHz PCM. Resample the continuous context at the
        // device output, not each 80 ms source independently at its edges.
        this.context = new AudioContext({ sampleRate: 24000 });
      } catch {
        this.context = new AudioContext();
      }
    }
    if (!this.gain) {
      this.gain = this.context.createGain();
      this.gain.gain.value = this.settings.value.volume;
      this.gain.connect(this.context.destination);
    }
    if (this.context.state === 'suspended') await this.context.resume();
  }
  async playPending(): Promise<void> {
    try {
      await this.unlock();
      await this.playNext(true);
    } catch {
      this.errors$.next('La lecture audio est indisponible sur cet appareil.');
    }
  }
  async replay(message: ConversationMessage): Promise<void> {
    if (message.speaker === 'system' || !message.audio?.length) return;
    this.stop();
    this.replaying = true;
    this.queue = [...message.audio];
    this.queuedSeconds = this.queue.reduce(
      (total, clip) => total + clip.data.byteLength / 2 / clip.rate,
      0,
    );
    this.pending.next(true);
    await this.playPending();
  }
  stop(): void {
    this.replaying = false;
    this.generation++;
    for (const source of this.sources) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    this.sources.clear();
    this.scheduling = false;
    this.manualPlayback = false;
    this.nextStartTime = 0;
    this.queuedSeconds = 0;
    this.queue = [];
    this.chunks = [];
    this.bytes = 0;
    this.header = undefined;
    this.messageId = undefined;
    this.pending.next(false);
    this.speaking.next(false);
  }
  ngOnDestroy(): void {
    this.stop();
    this.subscriptions.unsubscribe();
    void this.context?.close();
  }
  private receive(packet: AudioPacket): void {
    switch (packet.type) {
      case 'reset':
        // Reconnection attempts reset the transport, but must not cut a local replay.
        if (!this.replaying) this.stop();
        break;
      case 'audio_start':
        if (this.replaying) this.stop();
        this.header = packet;
        this.messageId = this.store.audioMessage(packet.npc);
        this.chunks = [];
        this.bytes = 0;
        logger.debug('AUDIO', `started ${packet.sample_rate}Hz`);
        break;
      case 'chunk':
        if (!this.header) return;
        this.bytes += packet.data.byteLength;
        if (this.bytes > 32 * 1024 * 1024) {
          this.stop();
          this.errors$.next('Réponse audio trop longue.');
          return;
        }
        this.chunks.push(packet.data);
        break;
      case 'audio_end': {
        if (!this.header || !this.bytes) {
          this.header = undefined;
          this.messageId = undefined;
          return;
        }
        const data = new Uint8Array(this.bytes);
        let offset = 0;
        for (const chunk of this.chunks) {
          data.set(new Uint8Array(chunk), offset);
          offset += chunk.byteLength;
        }
        const rate = this.header.sample_rate;
        const messageId = this.messageId;
        this.messageId = undefined;
        this.header = undefined;
        this.chunks = [];
        this.bytes = 0;
        if (data.byteLength % 2 !== 0) {
          this.errors$.next('Le flux PCM contient un échantillon incomplet.');
          return;
        }
        const clip = { data: data.buffer, rate };
        if (messageId) this.store.attachAudio(messageId, clip);
        const duration = data.byteLength / 2 / rate;
        const scheduledSeconds = this.context
          ? Math.max(0, this.nextStartTime - this.context.currentTime)
          : 0;
        // Four Pocket segments are just 320 ms, not four whole replies.
        // Never silently remove PCM from the middle of an utterance.
        if (this.queuedSeconds + scheduledSeconds + duration > this.maxBufferedSeconds) {
          this.stop();
          this.errors$.next('Trop de son en attente. Relancez la lecture.');
          return;
        }
        this.queue.push({ data: data.buffer, rate });
        this.queuedSeconds += duration;
        this.pending.next(true);
        if (this.settings.value.autoPlayAudio || this.manualPlayback) void this.playNext(false);
        break;
      }
    }
  }
  private async playNext(manual: boolean): Promise<void> {
    if (this.scheduling || !this.queue.length) return;
    if (!manual && (!this.context || this.context.state !== 'running')) return;
    const generation = this.generation;
    // Serialize resume/scheduling, but enqueue sources before onended fires.
    // JavaScript callbacks cannot provide a gapless 80 ms playback clock.
    this.scheduling = true;
    try {
      await this.unlock();
      if (generation !== this.generation || !this.context || !this.gain) return;
      this.manualPlayback ||= manual;
      while (this.queue.length) {
        const item = this.queue[0];
        const samples = pcm16ToFloat32(item.data);
        const buffer = this.context.createBuffer(1, samples.length, item.rate);
        buffer.copyToChannel(samples, 0);
        const source = this.context.createBufferSource();
        source.buffer = buffer;
        source.connect(this.gain);
        if (this.nextStartTime <= this.context.currentTime) {
          // Rebuffer only on startup/underflow. Applying this margin to every
          // packet would accumulate network jitter into audible gaps again.
          this.nextStartTime = this.context.currentTime + this.startupBufferSeconds;
        }
        const when = this.nextStartTime;
        source.onended = () => {
          source.disconnect();
          this.sources.delete(source);
          if (generation !== this.generation) return;
          if (!this.sources.size) {
            this.speaking.next(false);
            if (!this.queue.length) {
              this.manualPlayback = false;
              this.replaying = false;
            }
          }
        };
        this.sources.add(source);
        try {
          source.start(when);
        } catch (error) {
          this.sources.delete(source);
          source.disconnect();
          throw error;
        }
        this.nextStartTime = when + samples.length / item.rate;
        this.queue.shift();
        this.queuedSeconds = Math.max(0, this.queuedSeconds - samples.length / item.rate);
      }
      this.speaking.next(this.sources.size > 0);
      this.pending.next(this.queue.length > 0);
    } catch {
      this.speaking.next(this.sources.size > 0);
      this.pending.next(this.queue.length > 0);
      this.errors$.next(
        'Impossible de lire cet enregistrement audio. Touchez « Écouter » pour réessayer.',
      );
    } finally {
      if (generation === this.generation) this.scheduling = false;
    }
  }
}
