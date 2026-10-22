import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function buildOffline(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split('\\').join('/'))
    .filter(
      (file) =>
        /\.(html|js|css|svg|png|webp|jpg|ico|woff2?|ttf)$/.test(file) && file !== 'offline-sw.js',
    )
    .sort();
  if (!files.includes('index.html')) throw new Error('Build Angular introuvable.');
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file);
    hash.update(await readFile(join(root, file)));
  }
  const template = await readFile(new URL('../src/offline-worker.js', import.meta.url), 'utf8');
  hash.update(template);
  const manifest = { version: hash.digest('hex').slice(0, 20), files };
  await writeFile(
    join(root, 'offline-sw.js'),
    template.replace('/* ECHO_MANIFEST */ null', JSON.stringify(manifest)),
  );
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../www');
  const manifest = await buildOffline(root);
  console.log(`Offline : ${manifest.files.length} ressources prêtes (${manifest.version}).`);
}
