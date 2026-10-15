export function buildEndpoint(host: string, port: number): string {
  const address = host.trim();
  if (!address) throw new Error('Indiquez l’adresse IP locale ou le nom du serveur.');
  if (/^wss?:\/\//i.test(address)) {
    const url = new URL(address);
    if (!url.hostname || url.username || url.password || url.hash)
      throw new Error('URL WebSocket invalide.');
    if (url.pathname === '/') url.pathname = '/ws';
    return url.toString();
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Le port doit être compris entre 1 et 65535.');
  if (/[\s/?#@]/.test(address) || address.includes('://'))
    throw new Error('Saisissez un hôte seul ou une URL ws:// / wss:// complète.');
  const hostname = address.includes(':') && !address.startsWith('[') ? `[${address}]` : address;
  const url = new URL(`ws://${hostname}:${port}/ws`);
  if (url.port && Number(url.port) !== port) throw new Error('Adresse invalide.');
  return url.toString();
}
