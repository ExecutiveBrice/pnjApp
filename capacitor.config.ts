import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'fr.pnj.echo',
  appName: 'PNJ',
  webDir: 'www',
  // Local assets retain a secure origin for getUserMedia. LAN exceptions are
  // applied explicitly to generated native projects by native:configure.
  server: { androidScheme: 'https', iosScheme: 'capacitor' },
  android: { backgroundColor: '#101312', allowMixedContent: process.env['NPC_LAN_DEV'] === '1' },
  ios: { backgroundColor: '#101312', contentInset: 'automatic' },
};
export default config;
