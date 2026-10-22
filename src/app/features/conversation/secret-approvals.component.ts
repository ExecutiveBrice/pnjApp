import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { IonButton } from '@ionic/angular';
import { NpcWebSocketService } from '../../core/services/npc-websocket.service';

@Component({
  selector: 'app-secret-approvals',
  standalone: true,
  imports: [IonButton],
  templateUrl: './secret-approvals.component.html',
  styleUrl: './secret-approvals.component.scss',
})
export class SecretApprovalsComponent {
  readonly ws = inject(NpcWebSocketService);
  readonly capabilities = toSignal(this.ws.capabilities$, {
    initialValue: this.ws.currentCapabilities,
  });
  readonly connection = toSignal(this.ws.connectionState$, { initialValue: this.ws.state });
  readonly disclosures = toSignal(this.ws.disclosures$, { initialValue: [] });
  readonly synced = toSignal(this.ws.disclosuresSynced$, { initialValue: false });
  readonly pending = computed(() =>
    this.disclosures().filter((item) => item.status === 'pending' || item.status === 'sending'),
  );
  readonly history = computed(() =>
    this.disclosures()
      .filter((item) => item.status === 'approved' || item.status === 'rejected')
      .slice()
      .reverse(),
  );
}
