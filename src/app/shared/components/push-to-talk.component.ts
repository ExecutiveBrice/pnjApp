import {
  Component,
  EventEmitter,
  HostListener,
  Input,
  OnChanges,
  OnDestroy,
  Output,
} from '@angular/core';
import { IonIcon } from '@ionic/angular';
import { addIcons } from 'ionicons';
import { micOutline, hourglassOutline, volumeHighOutline } from 'ionicons/icons';
import { NpcState } from '../../core/models/protocol';

@Component({
  selector: 'app-push-to-talk',
  standalone: true,
  imports: [IonIcon],
  template: ` <div
    class="ptt"
    [attr.data-state]="disabled ? 'disabled' : holding ? 'recording' : state"
  >
    <button
      class="ptt-button"
      type="button"
      [disabled]="disabled || state === 'processing'"
      [attr.aria-label]="label"
      [attr.aria-pressed]="holding"
      (pointerdown)="pointerDown($event)"
      (pointerup)="pointerUp($event)"
      (pointercancel)="cancel()"
      (lostpointercapture)="cancel()"
      (pointermove)="pointerMove($event)"
      (keydown)="keyDown($event)"
      (keyup)="keyUp($event)"
      (blur)="cancel()"
      (contextmenu)="$event.preventDefault()"
    >
      <ion-icon
        [name]="
          holding
            ? 'mic-outline'
            : state === 'processing'
              ? 'hourglass-outline'
              : state === 'speaking'
                ? 'volume-high-outline'
                : 'mic-outline'
        "
        aria-hidden="true"
      />
    </button>
    <strong>{{ label }}</strong>
    @if (disabled) {
    <p class="disabled-reason" role="status">{{ disabledReason }}</p>
    } @else {
    <span>{{
      holding
        ? 'Relâchez pour envoyer · Glissez pour annuler'
        : 'Votre voix, de l’autre côté de la table'
    }}</span>
    }
  </div>`,
  styles: [
    `
      :host {
        display: block;
      }
      .ptt {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 9px;
        text-align: center;
        padding: 16px 8px 8px;
      }
      .ptt-button {
        position: relative;
        display: grid;
        place-items: center;
        width: 100px;
        height: 100px;
        border-radius: 50%;
        background: linear-gradient(145deg, #cdb580, #a98a54);
        color: #191b16;
        border: 5px solid #282d25;
        outline: 1px solid #6b6047;
        box-shadow:
          0 0 0 12px #c8ac7508,
          0 8px 32px #0005;
        touch-action: none;
        user-select: none;
        -webkit-user-select: none;
        -webkit-touch-callout: none;
      }
      ion-icon {
        font-size: 36px;
      }
      .ptt strong {
        font-size: 14px;
        font-weight: 600;
        margin-top: 8px;
      }
      .ptt span,
      .disabled-reason {
        font-size: 11px;
        color: var(--muted);
      }
      .disabled-reason {
        margin: 0;
        max-width: 340px;
      }
      [data-state='recording'] .ptt-button {
        background: #df8779;
        animation: breathe 1.2s ease-in-out infinite;
      }
      [data-state='recording'] strong {
        color: #eea295;
      }
      [data-state='processing'] .ptt-button {
        background: #555b4a;
      }
      [data-state='speaking'] .ptt-button {
        background: #93b9a0;
      }
      button:disabled {
        opacity: 0.42;
        box-shadow: none;
      }
      button:focus-visible {
        outline: 3px solid #fff;
        outline-offset: 5px;
      }
      @keyframes breathe {
        50% {
          box-shadow:
            0 0 0 15px #df877918,
            0 0 0 26px #df877908;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .ptt-button {
          animation: none !important;
        }
      }
      @media (max-height: 700px) {
        .ptt {
          padding-top: 8px;
          gap: 5px;
        }
        .ptt-button {
          width: 76px;
          height: 76px;
        }
        .ptt span {
          display: none;
        }
      }
    `,
  ],
})
export class PushToTalkComponent implements OnChanges, OnDestroy {
  @Input() state: NpcState = 'idle';
  @Input() disabled = false;
  @Input() disabledReason = 'La saisie texte reste disponible si autorisée';
  @Input() npc = 'Le personnage';
  @Output() pressed = new EventEmitter<void>();
  @Output() released = new EventEmitter<void>();
  @Output() cancelled = new EventEmitter<void>();
  holding = false;
  private pointerId?: number;
  private timeout?: ReturnType<typeof setTimeout>;
  constructor() {
    addIcons({ micOutline, hourglassOutline, volumeHighOutline });
  }
  get label(): string {
    if (this.disabled) return 'Micro non disponible';
    if (this.holding || this.state === 'recording') return 'Je vous écoute…';
    if (this.state === 'processing') return `${this.npc} réfléchit…`;
    if (this.state === 'speaking') return `${this.npc} parle · Appuyez pour interrompre`;
    return 'Maintenir pour parler';
  }
  ngOnChanges(): void {
    if (this.disabled) this.cancel();
  }
  pointerDown(event: PointerEvent): void {
    if (event.button !== 0 || this.holding) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    this.pointerId = event.pointerId;
    this.start();
  }
  pointerUp(event: PointerEvent): void {
    if (event.pointerId === this.pointerId) this.finish();
  }
  pointerMove(event: PointerEvent): void {
    if (!this.holding || event.pointerId !== this.pointerId) return;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    if (
      event.clientX < rect.left - 20 ||
      event.clientX > rect.right + 20 ||
      event.clientY < rect.top - 20 ||
      event.clientY > rect.bottom + 20
    )
      this.cancel();
  }
  keyDown(event: KeyboardEvent): void {
    if ([' ', 'Enter'].includes(event.key)) {
      event.preventDefault();
      if (!event.repeat) this.start();
    }
  }
  keyUp(event: KeyboardEvent): void {
    if ([' ', 'Enter'].includes(event.key)) {
      event.preventDefault();
      this.finish();
    }
  }
  @HostListener('window:blur')
  cancel(): void {
    if (this.holding) {
      this.cleanup();
      this.cancelled.emit();
    }
  }
  @HostListener('document:visibilitychange')
  visibilityChanged(): void {
    if (document.hidden) this.cancel();
  }
  ngOnDestroy(): void {
    this.cancel();
  }
  private start(): void {
    if (this.disabled || this.holding || this.state === 'processing') return;
    this.holding = true;
    this.pressed.emit();
    this.timeout = setTimeout(() => this.finish(), 60000);
  }
  private finish(): void {
    if (this.holding) {
      this.cleanup();
      this.released.emit();
    }
  }
  private cleanup(): void {
    this.holding = false;
    this.pointerId = undefined;
    clearTimeout(this.timeout);
  }
}
