import { WebSocketServer, WebSocket } from 'ws';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const port = Number(process.env['PORT'] ?? 8766);
// Fixtures belong to the mock only; the mobile client has no campaign data.
const npcs = process.env['NPC_FIXTURES']
  ? JSON.parse(await readFile(process.env['NPC_FIXTURES'], 'utf8'))
  : [
      {
        id: 'mordrek',
        name: 'Mordrek',
        gm_notes: {
          behavior: 'Parle à voix basse, observe les issues et répond rarement sans contrepartie.',
          attitude: 'Méfiant envers les inconnus, cordial avec ceux qui tiennent parole.',
          motivation: 'Retrouver son frère disparu sans attirer l’attention de la garde.',
          leverage: 'Une piste fiable ou une promesse de protection pour sa famille.',
          secret_count: 3,
          secrets: [
            'Son frère est retenu dans les caves de l’ancienne douane.',
            'Il transporte de faux laissez-passer pour les contrebandiers.',
            'Le capitaine de la garde lui doit une faveur.',
          ],
        },
      },
      {
        id: 'sentinelle',
        name: 'La Sentinelle',
        gm_notes: {
          behavior: 'Se tient droite, pose des questions précises et vérifie chaque réponse.',
          attitude: 'Neutre et professionnelle ; se ferme face aux menaces.',
          motivation: 'Garder la porte et protéger les habitants du quartier.',
          leverage: 'Un ordre officiel ou une preuve de danger imminent.',
          secret_count: 1,
          secrets: ['Elle laisse passer les familles recherchées à la relève de minuit.'],
        },
      },
    ];
const audioInput = process.env['MOCK_AUDIO_INPUT'] === '1';
const audioOutput = process.env['MOCK_AUDIO_OUTPUT'] === '1';
const legacy = process.env['MOCK_LEGACY'] === '1';
const gm = !legacy && process.env['MOCK_GM'] !== '0';
const speechAttitudes = [
  { id: 'agacement', label: 'Agacement' },
  { id: 'amusant', label: 'Amusant' },
  { id: 'rude', label: 'Rude' },
  { id: 'complaisant', label: 'Complaisant' },
];
const mockStory = {
  id: 'e'.repeat(32),
  title: 'Le feu de camp · Signal de démonstration',
  text: 'Le feu crépite. Les voyageurs se rassemblent pour écouter le récit.\n\nLe mock joue un signal sonore de deux secondes, sans synthèse vocale.',
  description: 'Signal sonore de test, sans narration.',
  language: 'French',
  created_at: '2026-10-22T12:00:00Z',
  duration: 2,
  audio_url: `/studio/audio/${'e'.repeat(32)}.wav`,
};
const storyWav = Buffer.alloc(44 + 24000 * 2 * 2);
storyWav.write('RIFF');
storyWav.writeUInt32LE(storyWav.length - 8, 4);
storyWav.write('WAVEfmt ', 8);
storyWav.writeUInt32LE(16, 16);
storyWav.writeUInt16LE(1, 20);
storyWav.writeUInt16LE(1, 22);
storyWav.writeUInt32LE(24000, 24);
storyWav.writeUInt32LE(48000, 28);
storyWav.writeUInt16LE(2, 32);
storyWav.writeUInt16LE(16, 34);
storyWav.write('data', 36);
storyWav.writeUInt32LE(storyWav.length - 44, 40);
for (let i = 0; i < 48000; i++)
  storyWav.writeInt16LE(Math.round(Math.sin((i * 2 * Math.PI * 220) / 24000) * 1000), 44 + i * 2);
const httpServer = createServer((request, response) => {
  if (request.method !== 'GET' || request.url !== mockStory.audio_url) {
    response.writeHead(404);
    response.end();
    return;
  }
  response.writeHead(200, {
    'Content-Type': 'audio/wav',
    'Content-Length': storyWav.length,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  response.end(storyWav);
});
// Shared by MJ connections and retained during reconnects for this mock process.
const disclosures = new Map();
const resolvedDisclosures = new Map();
const server = new WebSocketServer({
  server: httpServer,
  path: '/ws',
  maxPayload: 2 * 1024 * 1024,
});
server.on('listening', () =>
  console.log(`[MOCK] ws://localhost:${server.address().port}/ws (LAN: utilisez l’IP de ce PC)`),
);
server.on('error', (error) => {
  console.error(`[MOCK] ${error.message}`);
  process.exitCode = 1;
});
const broadcast = (event) => {
  for (const client of server.clients) {
    if (client.readyState === WebSocket.OPEN && client.secretApproval)
      client.send(JSON.stringify(event));
  }
};

server.on('connection', (socket) => {
  socket.secretApproval = gm;
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
  const sendSpeechCatalog = () => {
    if (gm)
      send({
        type: 'gm_npc_list',
        npcs: npcs.map((item) => ({ id: item.id, name: item.name, active: item.id === npc.id })),
        speech_attitudes: speechAttitudes,
      });
  };
  const hello = { type: 'hello', protocol: 1, npc: npc.name, state };
  if (!legacy && npc.gm_notes) hello.gm_notes = npc.gm_notes;
  if (!legacy)
    hello.capabilities = {
      text_input: true,
      audio_input: audioInput,
      audio_output: audioOutput,
      npc_switch: true,
      secret_approval: gm,
      voice_design: false,
      story_generation: false,
    };
  send(hello);
  if (!legacy) send({ type: 'npc_list', npcs });
  sendSpeechCatalog();

  const respond = async (text, resolvedReply, echo = true, speaker = npc.name) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    const current = ++turn;
    if (echo) send({ type: 'player_spoke', text });
    if (gm && resolvedReply === undefined && /\bsecret\b/i.test(text)) {
      const request = {
        request_id: randomUUID(),
        npc: speaker,
        secret: 'Le passage sous la vieille tour mène à la salle du trésor.',
        context: `Le joueur demande : « ${text} »`,
      };
      disclosures.set(request.request_id, {
        request,
        reply: (decision) => {
          if (socket.readyState !== WebSocket.OPEN) return false;
          void respond(
            text,
            decision === 'approved' ? request.secret : 'Je préfère garder cela pour moi.',
            false,
            speaker,
          );
          return true;
        },
      });
      broadcast({ type: 'secret_disclosure_requested', ...request });
      setState('idle');
      return;
    }
    setState('processing');
    await delay(500);
    const reply =
      resolvedReply ??
      `Bienvenue à la table. Vous me dites « ${text} »… Prenez place, je vous écoute.`;
    for (const chunk of reply.match(/.{1,16}/gs) ?? []) {
      if (turn !== current || socket.readyState !== WebSocket.OPEN) return;
      send({ type: 'npc_reply_chunk', npc: speaker, text: chunk });
      await delay(100);
    }
    if (turn !== current || socket.readyState !== WebSocket.OPEN) return;
    send({ type: 'npc_replied', npc: speaker, text: reply });
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
        npc: speaker,
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
      case 'speak_npc': {
        const target = npcs.find((item) => item.id === command.npc);
        const attitude = speechAttitudes.find((item) => item.id === command.attitude);
        if (!gm || !target || !attitude || state !== 'idle' || inputBytes !== null) {
          send({ type: 'error', message: 'Prise de parole indisponible ou invalide.' });
          break;
        }
        if (target.id !== npc.id) {
          npc = target;
          send({ type: 'npc_switched', npc: npc.name, gm_notes: npc.gm_notes });
          sendSpeechCatalog();
        }
        const replies = {
          agacement: 'Encore cette histoire ? Nous avons assez perdu de temps, venez-en au fait.',
          amusant: 'Avec une équipe pareille, même les ennuis vont demander un jour de congé !',
          rude: 'Assez bavardé. Dites ce que vous voulez et laissez-moi travailler.',
          complaisant: 'Bien sûr, prenez votre temps. Je vais faire de mon mieux pour vous aider.',
        };
        void respond('', replies[attitude.id], false);
        break;
      }
      case 'studio_list':
        send({
          type: 'studio_catalog',
          available: false,
          campaign_id: 'd'.repeat(32),
          voices: [],
          stories: [mockStory],
        });
        break;
      case 'say':
        if (typeof command.text === 'string' && command.text.trim())
          void respond(command.text.trim().slice(0, 8000));
        break;
      case 'status':
        send({ type: 'status', state });
        if (!legacy) send({ type: 'npc_list', npcs });
        sendSpeechCatalog();
        if (gm)
          send({
            type: 'secret_disclosure_list',
            requests: [...disclosures.values()].map((entry) => entry.request),
          });
        break;
      case 'resolve_secret_disclosure': {
        if (!gm || (command.decision !== 'approved' && command.decision !== 'rejected')) {
          send({
            type: 'error',
            message: 'Décision de divulgation invalide ou non prise en charge.',
          });
          break;
        }
        const previous = resolvedDisclosures.get(command.request_id);
        if (previous === command.decision) {
          send({
            type: 'secret_disclosure_resolved',
            request_id: command.request_id,
            decision: previous,
          });
          break;
        }
        const entry = disclosures.get(command.request_id);
        if (!entry) {
          send({ type: 'error', message: 'Cette demande n’est plus en attente.' });
          // Reconcile a stale client without treating the error as an approval.
          send({
            type: 'secret_disclosure_list',
            requests: [...disclosures.values()].map((item) => item.request),
          });
          break;
        }
        disclosures.delete(command.request_id);
        resolvedDisclosures.set(command.request_id, command.decision);
        broadcast({
          type: 'secret_disclosure_resolved',
          request_id: command.request_id,
          decision: command.decision,
        });
        if (!entry.reply(command.decision)) {
          // Continue the demo on the deciding MJ connection after a reconnect.
          void respond(
            '',
            command.decision === 'approved'
              ? entry.request.secret
              : 'Je préfère garder cela pour moi.',
            false,
            entry.request.npc,
          );
        }
        break;
      }
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
        send({ type: 'npc_switched', npc: npc.name, gm_notes: npc.gm_notes });
        sendSpeechCatalog();
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
httpServer.listen(port, '0.0.0.0');
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    for (const client of server.clients) client.terminate();
    server.close(() => httpServer.close(() => process.exit(0)));
  });
