import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonTitle,
  IonToolbar,
  ModalController,
} from '@ionic/angular';
import { NpcWebSocketService } from '../../core/services/npc-websocket.service';
import { ConversationStore } from '../../core/services/conversation.store';
@Component({
  selector: 'app-npc-picker',
  standalone: true,
  imports: [FormsModule, IonButton, IonButtons, IonContent, IonHeader, IonTitle, IonToolbar],
  template: ` <ion-header class="ion-no-border"
      ><ion-toolbar
        ><ion-title>Une nouvelle rencontre</ion-title
        ><ion-buttons slot="end"
          ><ion-button (click)="close()">Fermer</ion-button></ion-buttons
        ></ion-toolbar
      ></ion-header
    >
    <ion-content class="ion-padding">
      @if (!ws.connected) {
        <p class="muted">
          Retrouvez vos conversations et réécoutez les voix enregistrées sur cet appareil.
        </p>
        @for (conversation of histories(); track conversation.key) {
          <ion-button expand="block" fill="outline" (click)="openHistory(conversation.key)">
            {{ conversation.npc }} · {{ conversation.server }}
          </ion-button>
        }
      } @else {
        <p class="muted">Choisissez le personnage avec lequel poursuivre votre aventure.</p>
        @for (npc of npcs(); track npc.id) {
          <ion-button
            expand="block"
            fill="outline"
            [disabled]="!ws.connected"
            (click)="choose(npc.id)"
            >{{ npc.name }}</ion-button
          >
        } @empty {
          <div class="empty-card">
            <p>Le serveur n’a pas transmis de liste de personnages.</p>
            <p class="muted">Vous pouvez utiliser un identifiant fourni par votre meneur de jeu.</p>
          </div>
          <form (ngSubmit)="choose(id)">
            <label for="npc-id">Identifiant du PNJ</label
            ><input
              id="npc-id"
              name="npc-id"
              [(ngModel)]="id"
              placeholder="Identifiant côté serveur"
              required
            /><ion-button type="submit" expand="block" [disabled]="!id.trim() || !ws.connected"
              >Rencontrer ce personnage</ion-button
            >
          </form>
        }
      }
    </ion-content>`,
})
export class NpcPickerComponent {
  readonly ws = inject(NpcWebSocketService);
  private readonly modalController = inject(ModalController);
  private readonly conversations = inject(ConversationStore);
  readonly npcs = toSignal(this.ws.npcs$, { initialValue: [] });
  readonly histories = toSignal(this.conversations.histories$, { initialValue: [] });
  id = '';
  close(): void {
    void this.modalController.dismiss();
  }
  choose(id: string): void {
    if (id.trim() && this.ws.connected) {
      this.ws.switchNpc(id);
      this.close();
    }
  }
  openHistory(key: string): void {
    if (this.ws.connected) return;
    this.conversations.openHistory(key);
    this.close();
  }
}
