import { Component, Input } from '@angular/core';
import { ConnectionState } from '../../core/models/protocol';
@Component({
  selector: 'app-connection-status',
  standalone: true,
  template: `<span class="connection-status" [attr.data-state]="state" role="status"
    ><i></i>{{ label }}</span
  >`,
})
export class ConnectionStatusComponent {
  @Input() state: ConnectionState = 'disconnected';
  get label(): string {
    return {
      connected: 'Connecté',
      disconnected: 'Déconnecté',
      connecting: 'Connexion…',
      reconnecting: 'Reconnexion…',
    }[this.state];
  }
}
