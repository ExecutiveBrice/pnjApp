import { WebSocketServer, WebSocket } from 'ws';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const port = Number(process.env['PORT'] ?? 8766);
// Fixtures belong to the mock only; the mobile client has no campaign data.
const npcs = process.env['NPC_FIXTURES']
  ? JSON.parse(await readFile(process.env['NPC_FIXTURES'], 'utf8'))
  : [
      { id: 'mordrek', name: 'Mordrek' },
      { id: 'sentinelle', name: 'La Sentinelle' },
    ];
const audioInput = process.env['MOCK_AUDIO_INPUT'] === '1';
const audioOutput = process.env['MOCK_AUDIO_OUTPUT'] === '1';
const legacy = process.env['MOCK_LEGACY'] === '1';
const server = new WebSocketServer({
  host: '0.0.0.0',
  port,
  path: '/ws',
  maxPayload: 2 * 1024 * 1024,
});
server.on('listening', () =>
  console.log(`[MOCK] ws://localhost:${port}/ws (LAN: utilisez l’IP de ce PC)`),
);
server.on('error', (error) => {
  console.error(`[MOCK] ${error.message}`);
  process.exitCode = 1;
});

server.on('connection', (socket) => {
  let npc = npcs[0];
  let state = 'idle';
  let turn = 0;
  let inputBytes = null;
  const send = (event) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
  };
  const setState = (next) => {
    state = next;
    send({ type: 'state', state });
  };
  const hello = { type: 'hello', protocol: 1, npc: npc.name, state };
  if (!legacy)
    hello.capabilities = {
      text_input: true,
      audio_input: audioInput,
      audio_output: audioOutput,
      npc_switch: true,
    };
  send(hello);
  if (!legacy) send({ type: 'npc_list', npcs });

  const respond = async (text) => {
    const current = ++turn;
    send({ type: 'player_spoke', text });
    setState('processing');
    await delay(500);
    const reply = `Bienvenue à la table. Vous me dites « ${text} »… Prenez place, je vous écoute.`;
    for (const chunk of reply.match(/.{1,16}/gs) ?? []) {
      if (turn !== current || socket.readyState !== WebSocket.OPEN) return;
      send({ type: 'npc_reply_chunk', npc: npc.name, text: chunk });
      await delay(100);
    }
    send({ type: 'npc_replied', npc: npc.name, text: reply });
    if (audioOutput) {
      setState('speaking');
      const rate = 22050;
      const pcm = Buffer.alloc(rate * 2);
      // A soft test tone, explicitly not synthetic speech or Piper.
      for (let i = 0; i < rate; i++)
        pcm.writeInt16LE(
          Math.round(
            Math.sin((2 * Math.PI * 330 * i) / rate) * 3000 * Math.sin((Math.PI * i) / rate),
          ),
          i * 2,
        );
      send({
        type: 'audio_start',
        npc: npc.name,
        sample_rate: rate,
        channels: 1,
        format: 'pcm_s16le',
      });
      // Deliberately split an Int16 sample across frames to exercise buffering.
      socket.send(pcm.subarray(0, 4095));
      socket.send(pcm.subarray(4095));
      send({ type: 'audio_end' });
      await delay(1000);
    }
    if (turn === current) setState('idle');
  };
  socket.on('message', (data, binary) => {
    if (binary) {
      if (inputBytes !== null) {
        inputBytes += data.length;
        if (inputBytes > 16000 * 2 * 61) {
          inputBytes = null;
          send({ type: 'error', message: 'Audio trop long (60 secondes maximum).' });
        }
      }
      return;
    }
    let command;
    try {
      command = JSON.parse(data.toString());
    } catch {
      send({ type: 'error', message: 'JSON invalide.' });
      return;
    }
    switch (command.type) {
      case 'say':
        if (typeof command.text === 'string' && command.text.trim())
          void respond(command.text.trim().slice(0, 8000));
        break;
      case 'status':
        setState(state);
        if (!legacy) send({ type: 'npc_list', npcs });
        break;
      case 'stop_speaking':
        ++turn;
        inputBytes = null;
        setState('idle');
        break;
      case 'switch_npc': {
        const next = npcs.find((item) => item.id === command.npc);
        if (!next) {
          send({ type: 'error', message: 'Personnage inconnu.' });
          break;
        }
        ++turn;
        inputBytes = null;
        npc = next;
        send({ type: 'npc_switched', npc: npc.name });
        setState('idle');
        break;
      }
      case 'audio_input_start':
        if (!audioInput) {
          send({ type: 'error', message: 'Entrée audio non prise en charge.' });
          break;
        }
        if (
          command.sample_rate !== 16000 ||
          command.channels !== 1 ||
          command.format !== 'pcm_s16le'
        ) {
          send({ type: 'error', message: 'Format audio invalide.' });
          break;
        }
        inputBytes = 0;
        break;
      case 'audio_input_end':
        if (inputBytes !== null) {
          const bytes = inputBytes;
          inputBytes = null;
          void respond(`[Audio reçu : ${bytes} octets PCM ; le mock ne fait pas de transcription]`);
        }
        break;
      default:
        send({ type: 'error', message: `Commande inconnue : ${command.type}` });
    }
  });
  socket.on('close', () => {
    ++turn;
  });
  socket.on('error', (error) => console.warn(`[MOCK] ${error.message}`));
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    for (const client of server.clients) client.terminate();
    server.close(() => process.exit(0));
  });
