# Écho · Client mobile NPC

Application Ionic 9 / Angular 22 standalone, TypeScript strict, Capacitor 8, RxJS et SCSS. Écho est le compagnon du **maître du jeu** : suivi des interactions joueurs/PNJ, transmission des répliques et validation des divulgations de secrets via le WebSocket du serveur `npc`, sans IA ni service cloud côté téléphone. Les ressources visuelles et les polices sont locales. Le client reste utilisable sur le réseau local sans accès Internet après installation.

## Installation

Node **24.15+** recommandé (Node 22.22.3+ également compatible avec Angular 22), npm récent.

```bash
npm install
```

Le registre officiel npm est défini dans `.npmrc` pour ne pas dépendre d’un registre d’entreprise. `package-lock.json` fige les versions effectivement installées.

## Développement

```bash
npm start
```

Ouvrir <http://localhost:4200>. Le serveur Angular écoute sur toutes les interfaces pour permettre les essais LAN. Le premier écran demande l’adresse du PC qui exécute `npc` et son port, initialement `8766`. Une URL complète `ws://hote:8766/ws` ou `wss://hote/chemin` est aussi acceptée. Une URL complète conserve son port et son chemin ; si son chemin est vide, `/ws` est ajouté.

Dans un deuxième terminal :

```bash
npm run mock-server
```

Dans l’application, entrer **localhost**, **8766**, puis « Entrer en scène ». Le PNJ vient du `hello`. Écrire **Bonjour !** : l’état passe à `processing`, les fragments enrichissent la même bulle, le texte final la remplace, puis l’état revient à `idle`.

Le mock écoute `ws://0.0.0.0:8766/ws`, accessible dans le navigateur via `ws://localhost:8766/ws`. Il s’agit uniquement d’un outil de développement, pas d’un backend intermédiaire à déployer.

Pour tester la validation MJ, transmettre **Quel est ton secret ?** : une demande apparaît dans l’espace « Divulgation des secrets » au-dessus du personnage. Le mock attend la décision avant de produire une réponse. **Autoriser** laisse le PNJ dévoiler le secret ; **Refuser** produit une réponse qui le garde confidentiel. Le secret proposé apparaît seulement dans l’espace MJ avant autorisation. Les demandes de tous les PNJ restent accessibles lors d’un changement de personnage, même si la transcription est masquée.

Le bouton **Secrets** dans la barre supérieure affiche le nombre de demandes en attente et ouvre leur consultation en repliant les commandes vocales et de saisie. **Reprendre les interactions** réaffiche ces commandes ; l’arrêt d’une voix en cours reste accessible pendant la consultation.

Sur un téléphone, utiliser **l’IP locale du PC**, par exemple `192.168.1.20`, port `8766` : `localhost` désigne le téléphone. Les deux appareils doivent être sur le même réseau Wi-Fi ; le serveur réel doit écouter sur son interface LAN et le pare-feu du PC doit autoriser le port. Les réseaux invités peuvent isoler les appareils. L’émulateur Android peut joindre le PC via `10.0.2.2`.

## Mock : options

Par défaut, le mock annonce le texte et la sélection de PNJ. Les personnages de démonstration sont des **fixtures du mock seulement** ; aucun personnage n’est codé en dur dans le client.

```bash
# Accepter les enregistrements PCM, sans faire de reconnaissance vocale
MOCK_AUDIO_INPUT=1 npm run mock-server

# Générer un signal sonore PCM à 22050 Hz, pas une voix Piper
MOCK_AUDIO_OUTPUT=1 npm run mock-server

# Les deux fonctionnalités
MOCK_AUDIO_INPUT=1 MOCK_AUDIO_OUTPUT=1 npm run mock-server

# Compatibilité avec un ancien hello sans capabilities
MOCK_LEGACY=1 npm run mock-server

# Port différent, ou liste de PNJ personnalisée
PORT=8767 npm run mock-server
NPC_FIXTURES=./mes-pnj.json npm run mock-server
```

Format de `mes-pnj.json` : tableau de `{ "id": "identifiant-cote-serveur", "name": "Nom affiché" }` non vide. Arrêter le mock existant avant d’en lancer un autre sur le même port. Les commandes de variables d’environnement ci-dessus sont destinées à macOS/Linux ; sous PowerShell, utiliser par exemple `$env:MOCK_AUDIO_INPUT="1"`.

### Repères pour le Maître du Jeu

L’écran commence par un seul encart « Derrière l’écran » : nom du personnage, sélecteur, comportement, attitude envers les PJ, motivation, levier de négociation et nombre de secrets. Les boutons de prise de parole restent sous ces informations, puis viennent directement les transcriptions. La navigation vers les histoires, les réglages et la connexion est accessible en bas de l’écran. Le serveur peut fournir un objet optionnel `gm_notes` dans `hello`, `npc_switched` ou chaque entrée de `npc_list` (également dans les fixtures du mock) :

```json
{
  "behavior": "Parle à voix basse et surveille les issues.",
  "attitude": "Méfiant, mais sensible aux marques de respect.",
  "motivation": "Retrouver son frère disparu.",
  "leverage": "Une piste fiable ou une promesse de protection.",
  "secret_count": 1,
  "secrets": ["Son frère est retenu dans les caves de l’ancienne douane."]
}
```

Tous les champs sont facultatifs. Le nombre de secrets doit être un entier positif ou nul ; zéro signifie aucun secret, tandis qu’une valeur absente utilise la longueur de `secrets`, ou affiche « Non renseigné » si la liste est également absente. Les champs invalides sont ignorés sans bloquer la connexion. Un appui sur le nombre ouvre ou referme la liste `secrets` (tableau de textes non vides). Si le serveur fournit uniquement le nombre, l’encart indique que le contenu n’a pas été transmis. Ces repères sont conservés avec l’historique local du PNJ et du serveur pour rester consultables hors connexion. Ils restent inchangés si un ancien serveur ne les envoie pas ; envoyer `gm_notes: {}` permet de les effacer. Les repères sont destinés à une interface consultée par le MJ, sans contrôle d’accès distinct.

### Faire parler un PNJ

Dans l’encart « Derrière l’écran », le sélecteur sous le nom permet au MJ de choisir un personnage, de consulter immédiatement ses informations, puis de déclencher **Agacement**, **Amusant**, **Rude** ou **Complaisant**. Le serveur fournit les personnages et les attitudes disponibles ; l’attitude vaut pour cette seule réplique. Choisir un autre personnage affiche immédiatement ses informations et sélectionne sa conversation si le serveur prend en charge `npc_switch`. La prise de parole se déclenche uniquement avec un bouton. La commande `speak_npc` cible son identifiant exact et laisse le serveur sélectionner le PNJ, sans demander d’accueil supplémentaire ni ajouter de message joueur. Sa réponse et son audio suivent l’historique et la réécoute habituels.

Cette zone apparaît uniquement si le `hello` annonce `capabilities.secret_approval: true` et si `gm_npc_list` fournit `npcs` (`id`, `name`, `active`) et `speech_attitudes` (`id`, `label`). Activer l’accès MJ mobile (`mobile.secret_approval`) sur le serveur PNJ pour l’utiliser. Un ancien serveur ou une connexion joueur conserve les commandes habituelles. Les boutons attendent la fin d’une réplique, d’un enregistrement ou de sa conversion ; un verrou immédiat évite les doubles appuis avant la réponse du serveur. Une erreur libère ce verrou et s’affiche dans le Toast habituel. Les listes MJ sont vidées à la déconnexion.

Le mock propose ces quatre boutons par défaut, y compris avec `MOCK_AUDIO_OUTPUT=1` pour tester le transport audio. `MOCK_GM=0 npm run mock-server` simule une connexion joueur sans ces commandes, et `MOCK_LEGACY=1` garde le comportement ancien.

## Build et vérifications

```bash
npm run build
npm test
npm run lint
```

Le build de production sort dans `www/`, directement utilisable par Capacitor. Les tests Vitest n’ont besoin ni de Chrome ni de périphérique audio. Le lint utilise ESLint et vérifie aussi les types des tests ; la compilation Angular vérifie les templates strictement. Les logs de développement n’incluent ni contenu de conversation ni buffers audio et sont désactivés en production, sauf les avertissements.

## Android

Installer Android Studio et les SDK/JDK requis par Capacitor 8. Le dépôt ne contient pas les projets natifs générés, pour garder la base lisible.

```bash
npx cap add android
npm run build
npx cap sync android
# Remplacer l’adresse par l’IP du PC exécutant npc
NPC_LAN_HOSTS=192.168.1.20,localhost,10.0.2.2 npm run native:configure
# Autorise le contenu ws:// depuis l’origine https://localhost de la WebView
NPC_LAN_DEV=1 npx cap sync android
npx cap open android
```

Lancer ensuite une variante **debug** sur l’appareil ou l’émulateur.

`native:configure` ajoute :

- `android.permission.RECORD_AUDIO` et `android.permission.MODIFY_AUDIO_SETTINGS` dans `android/app/src/main/AndroidManifest.xml`. Capacitor exige les deux pour autoriser la capture dans la WebView. Seule `RECORD_AUDIO` déclenche une demande à l’utilisateur, au moment de `getUserMedia`.
- `android/app/src/debug/AndroidManifest.xml`, qui référence `@xml/npc_network_security`.
- `android/app/src/debug/res/xml/npc_network_security.xml` : politique de base interdisant le cleartext, avec exceptions **uniquement pour les hôtes fournis** par `NPC_LAN_HOSTS`. Aucun joker ni exception globale. Rerun la commande si l’IP du PC change. Une politique debug préexistante différente n’est pas écrasée : fusionner les `domain-config` manuellement.

`NPC_LAN_DEV=1` active `android.allowMixedContent` dans la configuration copiée par `cap sync`. C’est nécessaire car les assets embarqués gardent une origine HTTPS, compatible microphone, tandis que le serveur LAN utilise `ws://`. La politique réseau Android reste limitée aux hôtes listés et à la variante debug. `server.cleartext` et les certificats TLS ne sont pas modifiés.

Pour une distribution/release, utiliser un serveur **wss:// avec certificat valide** puis lancer `npx cap sync android` **sans** `NPC_LAN_DEV`. La politique debug n’est pas incluse dans une release. La configuration ne permet pas un `ws://` arbitraire sur tous les réseaux.

## iOS

macOS, Xcode et les outils requis par Capacitor 8 sont nécessaires. La signature d’un appareil se configure dans Xcode.

```bash
npx cap add ios
npm run build
npx cap sync ios
npm run native:configure
npx cap open ios
```

Sur macOS, `native:configure` utilise l’outil Apple `PlistBuddy` pour ajouter ces clés à `ios/App/App/Info.plist` de façon idempotente, sans remplacer les autres réglages :

```xml
<key>NSMicrophoneUsageDescription</key>
<string>Votre voix est envoyée au serveur NPC de votre table de jeu.</string>
<key>NSLocalNetworkUsageDescription</key>
<string>Écho rejoint le serveur NPC sur votre réseau local.</string>
<key>NSAppTransportSecurity</key>
<dict>
  <key>NSAllowsLocalNetworking</key>
  <true/>
</dict>
```

Autoriser le micro et le réseau local lors des demandes iOS. `NSAllowsLocalNetworking` permet le réseau local (IP, noms locaux) sans ajouter `NSAllowsArbitraryLoads` ni désactiver globalement ATS. Pour un nom public ou un serveur distant, utiliser `wss://`. Les modifications restent dans les projets natifs générés ; les conserver dans votre dépôt si vous décidez ensuite de versionner `android/` ou `ios/` (retirer alors les lignes correspondantes de `.gitignore`).

## Microphone et limites de cette première version

- `MicrophoneService` utilise `getUserMedia` et `MediaRecorder` : Opus/WebM si disponible, MP4 sur les appareils qui le demandent, puis le format par défaut. Au relâchement, Web Audio décode le fichier complet, mixe les canaux en mono, rééchantillonne en **16000 Hz** et encode en **PCM signé 16 bits little endian**. Aucun moteur de transcription ne tourne sur le téléphone.
- L’appui maintenu capture localement ; le relâchement envoie `audio_input_start`, les frames binaires de 32 Kio maximum, puis `audio_input_end`. Le flux micro n’est donc **pas encore envoyé en temps réel**. Ce choix évite une dépendance native ou audio supplémentaire ; la capture est isolée pour pouvoir être remplacée ultérieurement.
- Le micro reste désactivé sans `capabilities.audio_input: true`. Pas d’envoi audio expérimental à un ancien serveur. Un refus serveur apparaît dans un Toast et la connexion reste utilisable.
- Capture limitée à **60 secondes**. Glisser hors du bouton annule. Le clavier (Espace/Entrée), la perte de focus, le passage en arrière-plan, la navigation et la déconnexion sont gérés. Une autorisation qui arrive après le relâchement ferme aussitôt les pistes. Au premier usage, maintenir le bouton après l’autorisation ou recommencer l’appui.
- Dans un navigateur, le micro exige **localhost ou HTTPS**. `http://192.168.x.x:4200` permet de tester le texte sur téléphone mais n’offre généralement pas `getUserMedia`. Une page HTTPS bloque habituellement `ws://` : utiliser `wss://` dans ce cas, ou l’application native configurée pour le LAN.
- Les WebViews récentes Android/iOS doivent fournir MediaRecorder et un décodeur pour le format qu’elles enregistrent. En cas d’API, d’autorisation ou de codec indisponible, un message explique l’erreur et la saisie texte reste disponible si le serveur l’autorise. La capture et la lecture en arrière-plan ne sont pas prises en charge.
- Le rééchantillonnage moyenne les échantillons dans chaque intervalle (suffisant pour cette V1 vocale), sans filtre haute fidélité spécialisé.

### Micro grisé sur le téléphone

Le message sous le bouton indique ce qui bloque : connexion au serveur, API de capture indisponibles ou entrée vocale désactivée côté serveur. L’installation en debug et la permission Android ne suffisent pas à activer le bouton : le serveur doit annoncer `capabilities.audio_input: true` dans son message `hello` et traiter `audio_input_start`, les données PCM binaires et `audio_input_end`. Sans cette capacité, l’application ne demande pas encore l’autorisation du microphone.

Le mock désactive l’entrée vocale par défaut. Pour tester la capture sous PowerShell, arrêter le mock existant puis lancer :

```powershell
$env:MOCK_AUDIO_INPUT="1"
npm run mock-server
```

Reconnecter ensuite l’application. Le mock accepte le PCM mais ne transcrit pas la voix. Pour le serveur NPC réel, activer ou implémenter la réception vocale côté serveur ; annoncer la capacité seule ne suffit pas à traiter le son.

Si le bouton est actif mais que la capture est refusée malgré l’autorisation Android, vérifier que le manifeste contient aussi `MODIFY_AUDIO_SETTINGS` : Capacitor refuse la requête WebView si cette permission manque, même avec `RECORD_AUDIO` accordée. Relancer `native:configure` avec les mêmes `NPC_LAN_HOSTS`, reconstruire l’APK et le réinstaller après correction du manifeste. Cette permission n’ajoute pas de dialogue Android. Les erreurs affichées distinguent un accès bloqué, un micro impossible à ouvrir et un périphérique absent.

## Lecture de la voix

`AudioPlaybackService` reçoit `audio_start`, les frames binaires et `audio_end`. Il assemble les octets, y compris lorsqu’une frame coupe un échantillon en deux, puis convertit `int16 / 32768` en Float32. Le `AudioBuffer` utilise **le sample_rate fourni par le serveur**, jamais une fréquence codée en dur. Mono / `pcm_s16le` uniquement ; les formats non conformes sont ignorés avec avertissement.

Chaque `audio_end` clôt un segment, pas nécessairement une réponse : Pocket TTS envoie notamment des blocs de 80 ms à 24 kHz. Les segments sont programmés à l’avance sur une même horloge Web Audio, avec un tampon initial de 160 ms. Le lecteur n’attend pas les callbacks `onended` pour démarrer le bloc suivant, ce qui évite les microcoupures dues au thread JavaScript. Le contexte audio privilégie 24 kHz pour éviter de réinitialiser le rééchantillonnage à chaque petit bloc Pocket ; les fréquences annoncées par les autres voix restent respectées, et un contexte par défaut sert de repli si nécessaire.

Le tampon courant reste limité à 32 Mio et l’ensemble du son en attente à 120 secondes. Un dépassement arrête la lecture avec un message ; aucun bloc n’est supprimé silencieusement au milieu d’une réplique. Sans geste utilisateur préalable, ou si la lecture automatique est désactivée, le bouton **Écouter la réponse** permet de lancer la lecture. Le réglage de volume agit sur un `GainNode`. L’arrêt annule toutes les sources déjà programmées, y compris celles dont la lecture n’a pas encore commencé.

Chaque réplique de PNJ et chaque message vocal du joueur dispose aussi d’un bouton **haut-parleur** pour la réécouter. Les clips PCM complets reçus du serveur sont associés à leur bulle dès `audio_start`, puis enregistrés avec leur fréquence dans **IndexedDB**. Plusieurs clips d’une même réplique sont relus dans l’ordre. La réécoute reste disponible après lecture, changement de PNJ, déconnexion et réouverture de l’application installée. Le bouton reste désactivé si aucun audio n’a été reçu : le client ne synthétise pas de voix à partir du texte. Un audio PNJ interrompu avant `audio_end` n’est pas sauvegardé.

La voix du joueur est conservée localement en PCM mono **16000 Hz** dès la fin de sa capture, avant l’envoi au serveur. Elle reste réécoutable si cet envoi échoue et même si aucune transcription n’est reçue (bulle **Message vocal**). Quand le serveur envoie `player_spoke`, le texte complète la même bulle sans dupliquer le message ni perdre son audio. Ces enregistrements suivent la conversation du PNJ sélectionné et persistent après fermeture, comme les voix des PNJ. Les messages saisis au clavier restent conservés sous forme de texte ; leur haut-parleur est désactivé faute d’enregistrement vocal.

Pendant `speaking` ou une lecture locale, appuyer sur le micro envoie d’abord `stop_speaking`, arrête et vide l’audio local, puis demande le micro. L’arrêt, le changement de PNJ et la déconnexion invalident aussi les lectures en attente. Le protocole n’ayant pas d’identifiant de tour, le serveur doit cesser de produire l’ancienne réponse après `stop_speaking` ; un nouvel `audio_start` est considéré comme une nouvelle réponse.

Le mock sonore valide le transport PCM, **pas l’intelligibilité d’une voix Piper**. La lecture d’un vrai flux Piper et les permissions sur appareils physiques Android/iOS restent à valider avec votre serveur et vos appareils.

## Histoires de campagne et écoute hors connexion

Depuis la conversation, ouvrir **Histoires** ; depuis l’accueil, utiliser **Histoires de la campagne · Écoute hors connexion**. Le catalogue est demandé au serveur après connexion et peut être actualisé. Il fonctionne même si Qwen3-TTS n’est pas installé : la synthèse n’est pas nécessaire pour écouter les fichiers existants.

Le serveur PNJ fournit les histoires déjà narrées dans `histoires/` (WAV et texte Markdown associé), ainsi que les anciennes bibliothèques `voice_studio/`. Les textes sans WAV doivent d’abord être narrés dans le studio du serveur. **Écouter / Lire** ouvre le texte et le lecteur audio : lecture, pause et déplacement dans l’enregistrement. Le texte s’affiche comme texte brut. Une seule histoire est lue à la fois et quitter l’écran arrête sa lecture.

**Télécharger** conserve le WAV complet et ses métadonnées dans IndexedDB. Le statut **Disponible hors connexion** apparaît après validation du fichier et confirmation de son stockage. Les téléchargements interrompus, les erreurs HTTP, les réponses partielles et les WAV tronqués ne sont pas enregistrés. **Supprimer le téléchargement** efface uniquement la copie de cet appareil. Chaque bibliothèque est isolée par adresse serveur et `campaign_id` ; le sélecteur permet de retrouver les campagnes conservées, même sans serveur. Les histoires téléchargées restent conservées si elles disparaissent du catalogue du PC.

Pour préparer le hors-ligne :

1. Ouvrir le build de production via **HTTPS ou localhost** (ou installer l’application Capacitor), puis se connecter au serveur PNJ.
2. Télécharger les histoires souhaitées et attendre **Disponible hors connexion**. Dans le navigateur, attendre aussi **L’application est prête à être rouverte hors connexion**.
3. L’application peut ensuite être rechargée sans serveur web ni serveur PNJ. Les histoires téléchargées se lisent depuis leur copie locale ; le texte du catalogue reste consultable pour les autres.

`npm run build` génère `www/offline-sw.js` avec la liste et l’empreinte des ressources compilées, y compris les routes chargées à la demande. Le service worker conserve l’interface et sert les navigations vers les écrans sans réseau. Une nouvelle version prend la relève après fermeture des onglets de l’ancienne version. Le développement (`npm start`) ne l’active pas ; en HTTP sur une IP LAN, garder la page ouverte ou utiliser l’application native pour l’écoute hors connexion. Le stockage reste propre à l’origine du site et peut être supprimé par le navigateur ou l’utilisateur.

Le protocole utilise `studio_list` → `studio_catalog` (`campaign_id`, `stories`) et `GET /studio/audio/<id>.wav`. Les téléchargements depuis une autre origine nécessitent les en-têtes CORS des réponses WAV du serveur PNJ. Avec un proxy, exposer ce chemin HTTP sur la même origine que l’adresse WebSocket ; une page HTTPS requiert un serveur WSS/HTTPS. Le mock fournit une histoire de démonstration avec un signal WAV de deux secondes pour vérifier téléchargement, persistance et lecture sans moteur vocal.

## Validation MJ des secrets : extension du protocole

Cette extension est implémentée dans le client et le mock de ce dépôt. **Le serveur NPC réel, absent de ce dépôt, doit implémenter le contrat ci-dessous** pour rendre la validation opérationnelle. Sans `capabilities.secret_approval: true` dans `hello`, l’application affiche que la fonction n’est pas disponible et n’envoie aucune décision.

Le serveur crée un `request_id` unique et stable pour chaque proposition, puis envoie au MJ :

```json
{
  "type": "secret_disclosure_requested",
  "request_id": "disclosure-42",
  "npc": "Mordrek",
  "secret": "Le passage sous la tour mène au trésor.",
  "context": "Le joueur demande comment entrer dans la tour."
}
```

`request_id`, `npc` et `secret` sont des chaînes non vides ; `context` est une chaîne, éventuellement vide. À chaque commande `status`, y compris après reconnexion, le serveur envoie une liste **complète** des demandes en attente de tous les PNJ : `{ "type": "secret_disclosure_list", "requests": [...] }`. Chaque élément contient les quatre champs ci-dessus, sans `type`. Une liste vide retire les demandes devenues obsolètes ; une décision prise depuis un autre poste MJ est diffusée aux clients concernés.

Le bouton MJ envoie :

```json
{ "type": "resolve_secret_disclosure", "request_id": "disclosure-42", "decision": "approved" }
```

`decision` vaut `approved` ou `rejected`. Le serveur applique la décision puis confirme :

```json
{ "type": "secret_disclosure_resolved", "request_id": "disclosure-42", "decision": "approved" }
```

Le client désactive les deux boutons pendant l’envoi et attend cette confirmation avant d’afficher « Autorisée » ou « Refusée ». Sans confirmation après 10 secondes, il redemande `status` et permet de réessayer ; une erreur ou une déconnexion ne vaut jamais autorisation. Le serveur doit arbitrer les décisions concurrentes et empêcher qu’une nouvelle commande modifie une décision déjà appliquée. Une répétition de la même décision doit pouvoir renvoyer sa confirmation sans reproduire la divulgation.

**Le blocage de la divulgation appartient au serveur** : aucun fragment texte, réponse finale ni audio contenant le secret ne doit être produit pour les joueurs avant autorisation. Sur refus, le serveur poursuit avec une réponse qui préserve le secret. Les événements MJ et leur contenu doivent être réservés aux connexions autorisées comme MJ ; la capacité annoncée au client n’est pas un mécanisme d’authentification. Le mock est réservé aux essais locaux et considère ses connexions comme des postes MJ.

Les secrets ne sont ni injectés dans le fil de conversation par le client ni enregistrés dans `localStorage`. Les 100 dernières décisions confirmées sont consultables en mémoire jusqu’à la déconnexion. Les demandes en attente sont restaurées depuis le serveur après reconnexion ; le mock les conserve entre connexions, jusqu’à son arrêt. Son secret de démonstration est une fixture, comme ses PNJ.

## Protocole et état

- WebSocket natif exclusivement dans `NpcWebSocketService`, `binaryType = 'arraybuffer'`, envoi et réception JSON typés. Les JSON invalides, types inconnus et champs invalides sont ignorés sans couper la connexion.
- Attente de `hello` avant d’exposer `connected` ou d’envoyer des commandes ; timeout de 10 s. Seul `protocol: 1` est accepté ; une autre version affiche une erreur et arrête la reconnexion.
- Capacités absentes : texte oui, entrée audio non, sortie audio non, sélection PNJ non, validation des secrets non. Les sorties PCM reçues restent lisibles même avec un ancien `hello`. Les fonctions d’entrée, de sélection et de validation sont conditionnées aux capacités.
- `say`, `switch_npc`, `stop_speaking`, `status`, états et événements texte/audio du cahier des charges sont implémentés. `status` est demandé après chaque `hello`.
- Reconnexion après 1, 2, 5, 10 puis 10 secondes ; attente d’un nouveau `hello`, réinitialisation des capacités et de la liste. L’arrêt explicite ou la désactivation du réglage interrompt les tentatives.
- La modal utilise `npc_list`. En l’absence de liste, un identifiant fourni par le MJ peut être saisi si `npc_switch` est autorisé. Le nom actif change à réception de `npc_switched`.
- Le PNJ actif reste visible dans l’en-tête de conversation ; cliquer sur sa fiche ouvre la sélection si `npc_switch` est autorisé. Chaque entrée de `npc_list` peut inclure une `description` textuelle facultative, affichée comme résumé sous son nom.
- Historique séparé par **adresse WebSocket et PNJ confirmé par le serveur**, limité aux 500 dernières bulles par conversation. Changer de PNJ affiche uniquement ses échanges ; revenir au PNJ précédent retrouve son historique. Le protocole V1 identifie le PNJ par le champ `npc` de `hello` / `npc_switched` (nom dans le mock) : deux noms identiques sur un même serveur ne sont pas distinguables sans enrichir le protocole.
- Conversations et enregistrements conservés localement dans **IndexedDB**, sans transfert cloud. Ajout immédiat du texte joueur, dédoublonnage de son écho `player_spoke`, puis concaténation des chunks PNJ dans une bulle. Une réponse finale sans chunks est également acceptée. Les fichiers audio restent soumis à l’espace disponible sur l’appareil ; une erreur de stockage est signalée et les échanges restent accessibles en mémoire pendant la session.
- Une perte de connexion laisse la conversation ouverte avec la réécoute disponible et les envois désactivés. Depuis l’écran de connexion, **Consulter les conversations hors connexion** ouvre les historiques sauvegardés ; **Changer de personnage** permet de choisir une conversation locale. Dans l’application Capacitor installée ou le build web de production préparé pour le hors-ligne, ces écrans fonctionnent sans réseau. Le serveur de développement web doit rester accessible pour recharger les fichiers de l’application dans le navigateur.
- `SettingsService` encapsule `localStorage` et valide les préférences relues. Adresse, port, reconnexion, lecture automatique, transcription et volume y sont stockés. L’interface continue de fonctionner si le stockage est indisponible et informe de l’échec de sauvegarde.

## Organisation

```text
src/app/
  core/
    models/protocol.ts              Types discriminés et validation à réception
    services/
      npc-websocket.service.ts     Transport, handshake, capacités, reconnexion
      conversation.store.ts        Historiques par PNJ et réponses progressives
      conversation-history.service.ts Persistance IndexedDB du texte et des voix
      stories.service.ts           Bibliothèques, téléchargements et lecture des histoires
      story-storage.service.ts     Catalogue et WAV par campagne dans IndexedDB
      offline-app.service.ts       Préparation de l’interface web hors connexion
      audio-playback.service.ts    Tampons PCM, file, volume, interruption
      microphone.service.ts        Capture locale, décodage et PCM 16 kHz
      settings.service.ts          Préférences locales
    guards/connection.guard.ts     Accès à la conversation après hello
  features/
    connection/                    Adresse et connexion au serveur
    conversation/                  Espace MJ, secrets, bulles, voix et sélection PNJ
    stories/                       Catalogue, lecteur et téléchargements de campagne
    settings/                      Préférences utilisateur
  shared/
    components/                    Push-to-talk et statut de connexion
    utils/                         Endpoint, conversions PCM et logger
  app.component.ts                 Routage après connexion/coupure et Toasts
  app.routes.ts                    Routes chargées à la demande
src/assets/                        Ressources SVG locales (emblème)
scripts/mock-npc-server.mjs         Mock facultatif (seule dépendance : ws)
scripts/configure-native.mjs        Permissions natives et exceptions LAN ciblées
scripts/build-offline.mjs           Manifeste du build et génération du service worker
src/offline-worker.js               Cache de l’interface de production
```

Tous les composants de l’application sont standalone ; `FormsModule` est utilisé uniquement pour les directives de formulaires Angular. Avec Ionic 9, les composants standalone s’importent depuis `@ionic/angular` (le sous-chemin `/standalone` d’Ionic 8 a été supprimé).

## Références vérifiées

- [Compatibilité Angular / Node / TypeScript](https://angular.dev/reference/versions)
- [Ionic 9 : imports standalone et compatibilité Angular](https://ionic.io/blog/announcing-ionic-framework-9)
- [Configuration Capacitor](https://capacitorjs.com/docs/config)
- [MDN : getUserMedia et contextes sécurisés](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
- [MDN : frames binaires WebSocket](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/binaryType)
- [Apple : NSAllowsLocalNetworking](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking)
