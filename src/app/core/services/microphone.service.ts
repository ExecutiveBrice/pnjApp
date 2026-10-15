import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { monoToPcm16 } from '../../shared/utils/pcm';

@Injectable({ providedIn: 'root' })
export class MicrophoneService implements OnDestroy {
  private recorder?: MediaRecorder;
  private stream?: MediaStream;
  private chunks: Blob[] = [];
  private captureId = 0;
  private completion?: Promise<Blob>;
  private readonly recording = new BehaviorSubject(false);
  readonly recording$ = this.recording.asObservable();
  get available(): boolean {
    return (
      !!globalThis.navigator?.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined'
    );
  }

  async start(): Promise<boolean> {
    this.cancel();
    if (!this.available)
      throw new Error(
        'Micro indisponible. Utilisez localhost, HTTPS ou l’application native et autorisez le microphone.',
      );
    const id = ++this.captureId;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        video: false,
      });
    } catch {
      throw new Error(
        'Accès au microphone refusé ou indisponible. Vérifiez les autorisations de votre appareil.',
      );
    }
    if (id !== this.captureId) {
      stream.getTracks().forEach((track) => track.stop());
      return false;
    }
    try {
      this.stream = stream;
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(
        (type) => MediaRecorder.isTypeSupported(type),
      );
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      this.recorder = recorder;
      this.chunks = [];
      this.completion = new Promise<Blob>((resolve, reject) => {
        recorder.ondataavailable = (event) => {
          if (id === this.captureId && event.data.size) this.chunks.push(event.data);
        };
        recorder.onstop = () => resolve(new Blob(this.chunks, { type: recorder.mimeType }));
        recorder.onerror = () => reject(new Error('L’enregistrement a échoué.'));
      });
      // Prevent an unhandled rejection if the recorder fails before release.
      void this.completion.catch(() => undefined);
      recorder.start(250);
      this.recording.next(true);
      return true;
    } catch {
      this.cancel();
      throw new Error('Impossible de démarrer l’enregistrement sur cet appareil.');
    }
  }
  async finish(): Promise<ArrayBuffer | null> {
    const recorder = this.recorder;
    if (!recorder || recorder.state === 'inactive') {
      this.cancel();
      return null;
    }
    const id = this.captureId;
    const completed = this.completion;
    // Create/resume within the release gesture, before awaiting onstop.
    let context: AudioContext | undefined;
    try {
      context = new AudioContext();
      void context.resume().catch(() => undefined);
      recorder.stop();
      this.releaseTracks();
      this.recording.next(false);
      const blob = await completed;
      if (!blob?.size || id !== this.captureId) return null;
      if (blob.size > 16 * 1024 * 1024) throw new Error('Enregistrement trop volumineux.');
      const decoded = await context.decodeAudioData(await blob.arrayBuffer());
      if (id !== this.captureId) return null;
      const mono = new Float32Array(decoded.length);
      for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
        const samples = decoded.getChannelData(channel);
        for (let i = 0; i < mono.length; i++) mono[i] += samples[i] / decoded.numberOfChannels;
      }
      return monoToPcm16(mono, decoded.sampleRate);
    } catch {
      if (id === this.captureId) this.cancel();
      throw new Error(
        'Impossible de convertir cet enregistrement en PCM. Essayez la saisie texte.',
      );
    } finally {
      if (id === this.captureId) {
        this.recorder = undefined;
        this.chunks = [];
      }
      await context?.close();
    }
  }
  cancel(): void {
    this.captureId++;
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    this.recorder = undefined;
    this.releaseTracks();
    this.chunks = [];
    this.recording.next(false);
  }
  ngOnDestroy(): void {
    this.cancel();
  }
  private releaseTracks(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
  }
}
