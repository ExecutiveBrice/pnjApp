import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { buildOffline } from './build-offline.mjs';

const folders = [];
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

async function build() {
  const folder = await mkdtemp(join(tmpdir(), 'pnj-shell-test-'));
  folders.push(folder);
  await mkdir(join(folder, 'assets'));
  await writeFile(join(folder, 'index.html'), '<main>Écho</main>');
  await writeFile(join(folder, 'lazy-stories.js'), 'story route');
  await writeFile(join(folder, 'styles.css'), 'body{}');
  await writeFile(join(folder, 'assets/sigil.svg'), '<svg/>');
  const manifest = await buildOffline(folder);
  return { folder, manifest, source: await readFile(join(folder, 'offline-sw.js'), 'utf8') };
}

function worker(source) {
  const handlers = {};
  const cache = {
    addAll: vi.fn().mockResolvedValue(undefined),
    match: vi.fn().mockResolvedValue('saved-shell'),
  };
  const caches = {
    open: vi.fn().mockResolvedValue(cache),
    keys: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(true),
  };
  const fetch = vi.fn().mockRejectedValue(new Error('offline'));
  const self = {
    registration: { scope: 'https://echo.example/app/' },
    location: { origin: 'https://echo.example' },
    clients: { claim: vi.fn() },
    addEventListener: (type, handler) => {
      handlers[type] = handler;
    },
  };
  runInNewContext(source, { self, caches, fetch, URL });
  return { handlers, cache, caches, fetch };
}

describe('offline production shell', () => {
  it('includes lazy routes and assets and changes version with content', async () => {
    const { folder, manifest } = await build();
    expect(manifest.files).toEqual([
      'assets/sigil.svg',
      'index.html',
      'lazy-stories.js',
      'styles.css',
    ]);
    const same = await buildOffline(folder);
    expect(same.version).toBe(manifest.version);
    await writeFile(join(folder, 'lazy-stories.js'), 'updated route');
    expect((await buildOffline(folder)).version).not.toBe(manifest.version);
  });
  it('installs every resource under the deployment base path and serves a deep link without network', async () => {
    const { source } = await build();
    const { handlers, cache, fetch } = worker(source);
    let pending;
    handlers.install({
      waitUntil: (promise) => {
        pending = promise;
      },
    });
    await pending;
    expect(cache.addAll).toHaveBeenCalledWith([
      'https://echo.example/app/assets/sigil.svg',
      'https://echo.example/app/index.html',
      'https://echo.example/app/lazy-stories.js',
      'https://echo.example/app/styles.css',
    ]);
    const respondWith = vi.fn();
    handlers.fetch({
      request: { url: 'https://echo.example/app/stories', method: 'GET', mode: 'navigate' },
      respondWith,
    });
    expect(await respondWith.mock.calls[0][0]).toBe('saved-shell');
    expect(cache.match).toHaveBeenCalledWith('https://echo.example/app/index.html');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('never caches server audio, WebSocket requests or other applications', async () => {
    const { source } = await build();
    const { handlers } = worker(source);
    for (const url of [
      'https://echo.example/studio/audio/123.wav',
      'https://echo.example/app/studio/audio/123.wav',
      'https://echo.example/app/ws',
      'https://server.example/audio.wav',
    ]) {
      const respondWith = vi.fn();
      handlers.fetch({ request: { url, method: 'GET', mode: 'cors' }, respondWith });
      expect(respondWith).not.toHaveBeenCalled();
    }
    const respondWith = vi.fn();
    handlers.fetch({
      request: {
        url: 'https://echo.example/app/studio/audio/123.wav',
        method: 'GET',
        mode: 'navigate',
      },
      respondWith,
    });
    expect(respondWith).not.toHaveBeenCalled();
  });
  it('only removes older shell versions within its own scope', async () => {
    const { source, manifest } = await build();
    const { handlers, caches } = worker(source);
    caches.keys.mockResolvedValue([
      'pnj-shell:https://echo.example/app/:old',
      `pnj-shell:https://echo.example/app/:${manifest.version}`,
      'pnj-shell:https://echo.example/other/:old',
      'unrelated-cache',
    ]);
    let pending;
    handlers.activate({
      waitUntil: (promise) => {
        pending = promise;
      },
    });
    await pending;
    expect(caches.delete).toHaveBeenCalledExactlyOnceWith(
      'pnj-shell:https://echo.example/app/:old',
    );
  });
});
