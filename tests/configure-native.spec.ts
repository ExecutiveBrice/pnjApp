import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = resolve('scripts/configure-native.mjs');
const fixtureRoot = resolve('.angular/native-config-tests');
const fixtures: string[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    if (!fixture.startsWith(fixtureRoot + sep)) throw new Error('Invalid fixture path');
    await rm(fixture, { recursive: true, force: true });
  }
});

describe('native Android configuration', () => {
  it.each([false, true])(
    'adds both WebView audio permissions, including when RECORD_AUDIO already exists (%s)',
    async (alreadyHasRecordAudio) => {
      await mkdir(fixtureRoot, { recursive: true });
      const fixture = await mkdtemp(join(fixtureRoot, 'case-'));
      fixtures.push(fixture);
      const main = join(fixture, 'android/app/src/main');
      await mkdir(main, { recursive: true });
      const path = join(main, 'AndroidManifest.xml');
      await writeFile(
        path,
        `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <application android:label="Test" />
  <uses-permission android:name="android.permission.INTERNET" />
  ${alreadyHasRecordAudio ? '<uses-permission android:name="android.permission.RECORD_AUDIO" />' : ''}
</manifest>`,
      );
      const configure = () =>
        execFileSync(process.execPath, [script], {
          cwd: fixture,
          env: { ...process.env, NPC_LAN_HOSTS: '192.168.1.152,localhost' },
        });
      configure();
      const manifest = await readFile(path, 'utf8');
      for (const permission of ['INTERNET', 'RECORD_AUDIO', 'MODIFY_AUDIO_SETTINGS']) {
        expect(
          manifest.match(new RegExp(`android\\.permission\\.${permission}`, 'g')),
        ).toHaveLength(1);
      }
      expect(manifest).toContain('<application android:label="Test" />');
      configure();
      expect(await readFile(path, 'utf8')).toBe(manifest);
      const policy = await readFile(
        join(fixture, 'android/app/src/debug/res/xml/npc_network_security.xml'),
        'utf8',
      );
      expect(policy).toContain('192.168.1.152');
      expect(policy).toContain('<base-config cleartextTrafficPermitted="false" />');
    },
  );
});
