import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject, Subject, Subscription } from 'rxjs';
import { AudioPacket, AudioStartEvent } from '../models/protocol';
import { NpcWebSocketService } from './npc-websocket.service';
import { SettingsService } from './settings.service';
import { pcm16ToFloat32 } from '../../shared/utils/pcm';
import { logger } from '../../shared/utils/logger';

@Injectable({ providedIn: 'root' })
export class AudioPlaybackService implements OnDestroy {
  private context?: AudioContext;
  private gain?: GainNode;
  private header?: AudioStartEvent;
  private chunks: ArrayBuffer[] = [];
  private bytes = 0;
  private queue: { data: ArrayBuffer; rate: number }[] = [];
  private source?: AudioBufferSourceNode;
  private playing = false;
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
  ) {
    this.subscriptions.add(ws.audio$.subscribe((packet) => this.receive(packet)));
    this.subscriptions.add(
      settings.settings$.subscribe((value) => {
        if (this.gain) this.gain.gain.value = value.volume;
      }),
    );
  }
  /** Must be invoked directly from a tap/click to unlock mobile audio. */
  async unlock(): Promise<void> {
    this.context ??= new AudioContext();
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
  stop(): void {
    this.generation++;
    if (this.source) {
      this.source.onended = null;
      this.source.stop();
      this.source.disconnect();
    }
    this.source = undefined;
    this.playing = false;
    this.queue = [];
    this.chunks = [];
    this.bytes = 0;
    this.header = undefined;
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
        this.stop();
        break;
      case 'audio_start':
        this.header = packet;
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
          return;
        }
        const data = new Uint8Array(this.bytes);
        let offset = 0;
        for (const chunk of this.chunks) {
          data.set(new Uint8Array(chunk), offset);
          offset += chunk.byteLength;
        }
        // Limit unplayed replies as well as the in-flight buffer.
        if (this.queue.length >= 4) this.queue.shift();
        this.queue.push({ data: data.buffer, rate: this.header.sample_rate });
        this.header = undefined;
        this.chunks = [];
        this.bytes = 0;
        this.pending.next(true);
        if (this.settings.value.autoPlayAudio) void this.playNext(false);
        break;
      }
    }
  }
  private async playNext(manual: boolean): Promise<void> {
    if (this.playing || !this.queue.length) return;
    if (!manual && (!this.context || this.context.state !== 'running')) return;
    const generation = this.generation;
    // Reserve the playback slot before awaiting resume; two audio_end events
    // in the same tick must never start overlapping sources.
    this.playing = true;
    try {
      await this.unlock();
      if (generation !== this.generation || !this.context || !this.gain) return;
      const item = this.queue.shift();
      if (!item) {
        this.playing = false;
        return;
      }
      const samples = pcm16ToFloat32(item.data);
      const buffer = this.context.createBuffer(1, samples.length, item.rate);
      buffer.copyToChannel(samples, 0);
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.gain);
      this.source = source;
      this.playing = true;
      this.speaking.next(true);
      this.pending.next(this.queue.length > 0);
      source.onended = () => {
        if (generation !== this.generation) return;
        source.disconnect();
        this.source = undefined;
        this.playing = false;
        this.speaking.next(false);
        if (manual || this.settings.value.autoPlayAudio) void this.playNext(manual);
      };
      source.start();
    } catch {
      this.playing = false;
      this.speaking.next(false);
      this.pending.next(this.queue.length > 0);
      this.errors$.next(
        'Impossible de lire cette réponse audio. Touchez « Écouter » pour réessayer.',
      );
    }
  }
}
