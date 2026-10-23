import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

if (existsSync('android/app/src/main/AndroidManifest.xml')) {
  const path = 'android/app/src/main/AndroidManifest.xml';
  let manifest = await readFile(path, 'utf8');
  // Capacitor's WebChromeClient denies AUDIO_CAPTURE unless both are granted.
  for (const permission of ['RECORD_AUDIO', 'MODIFY_AUDIO_SETTINGS']) {
    if (!manifest.includes(`android.permission.${permission}`)) {
      manifest = manifest.replace(
        '</manifest>',
        `    <uses-permission android:name="android.permission.${permission}" />\n</manifest>`,
      );
    }
  }
  await writeFile(path, manifest);
  // Debug-only policy; release retains Android's default prohibition of HTTP.
  await mkdir('android/app/src/debug/res/xml', { recursive: true });
  const debugPath = 'android/app/src/debug/AndroidManifest.xml';
  let debug = existsSync(debugPath)
    ? await readFile(debugPath, 'utf8')
    : '<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n</manifest>\n';
  if (
    debug.includes('android:networkSecurityConfig=') &&
    !debug.includes('@xml/npc_network_security')
  )
    throw new Error(
      'Une politique réseau debug existe déjà. Fusionnez-la manuellement (voir README).',
    );
  if (!debug.includes('@xml/npc_network_security')) {
    debug = debug.includes('<application')
      ? debug.replace(
          '<application',
          '<application android:networkSecurityConfig="@xml/npc_network_security"',
        )
      : debug.replace(
          '</manifest>',
          '<application android:networkSecurityConfig="@xml/npc_network_security" />\n</manifest>',
        );
    await writeFile(debugPath, debug);
  }
  await writeFile(
    'android/app/src/debug/res/xml/npc_network_security.xml',
    `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="true" />
</network-security-config>
`,
  );
  console.log(
    'Android : permissions micro et connexions HTTP/WS autorisées vers tous les hôtes en debug.',
  );
}

if (existsSync('ios/App/App/Info.plist')) {
  if (process.platform !== 'darwin')
    throw new Error('Pour iOS, appliquez les clés Info.plist du README sur macOS.');
  const path = 'ios/App/App/Info.plist';
  const set = (key, type, value) => {
    let exists = true;
    try {
      execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path], { stdio: 'ignore' });
    } catch {
      exists = false;
    }
    execFileSync('/usr/libexec/PlistBuddy', [
      '-c',
      exists ? `Set :${key} ${value}` : `Add :${key} ${type} ${value}`,
      path,
    ]);
  };
  set(
    'NSMicrophoneUsageDescription',
    'string',
    'Votre voix est envoyée au serveur NPC de votre table de jeu.',
  );
  set(
    'NSLocalNetworkUsageDescription',
    'string',
    'Écho rejoint le serveur NPC sur votre réseau local.',
  );
  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :NSAppTransportSecurity', path], {
      stdio: 'ignore',
    });
  } catch {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Add :NSAppTransportSecurity dict', path]);
  }
  set('NSAppTransportSecurity:NSAllowsLocalNetworking', 'bool', 'true');
  console.log('iOS : autorisations micro, réseau local et NSAllowsLocalNetworking ajoutées.');
}
if (!existsSync('android') && !existsSync('ios'))
  console.log('Ajoutez d’abord une plateforme : npx cap add android / ios. Consultez le README.');
