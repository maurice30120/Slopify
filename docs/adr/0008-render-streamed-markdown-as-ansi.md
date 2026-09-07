# Rendre le Markdown streamé de l'agent en ANSI dans le terminal

Le mode `--verbose` de `slopify run` stream en direct le contenu des `agent_thought_chunk` et `agent_message_chunk` via `writeErrorRaw` — du texte brut sans aucune mise en forme. Le Markdown produit par l'agent (titres, gras, listes, blocs de code) arrive tel quel, illisible dans un terminal. Nous intégrons `markstream-cli` pour rendre ce Markdown en ANSI incrémentalement pendant le streaming, uniquement quand le flux d'erreur est un TTY. Sur un flux non-TTY (pipe, CI, tests), le texte brut est écrit inchangé pour préserver les consumers existants.

`markstream-cli` expose `createMarkdownStreamRenderer({ strategy: 'smart', render: { streaming: true } })` qui consomme des chunks Markdown incomplets et produit des patches ANSI (delta avec cursor save/restore/erase). Le renderer est instancié par phase (pensée/réponse) et par nœud, détruit à la transition de phase ou au `node_completed`. La sortie reste sur stderr (`writeErrorRaw`). Les séquences de contrôle terminal venant du texte de l'agent sont sanitized par défaut (`allowControlSequences: false`), ce qui protège contre l'injection de codes ESC/BEL dans un contenu non fiable.

**Considered Options:**
- *`markdansi`* : rejeté. Markdown→ANSI avec streaming, plus léger, mais moins mature (v0.x) et l'API de streaming append-only est moins documentée. `markstream-cli` exposait explicitement le mode `smart` avec patches incrémentaux et la sanitization, critères décisifs pour du contenu LLM non fiable streamé chunk par chunk.
- *`marked` + `marked-terminal`* : rejeté. Établi (~1500 dépendants) mais pensé comme un renderer Markdown→terminal classique, pas pour le streaming incomplet. Ne gère pas nativement un bloc ` ```ts ` ouvert ou une liste en cours ; il faudrait bufferiser tout le contenu puis rendre à la fin, ce qui tue le live-streaming.
- *Texte brut inchangé* : rejeté. Le Markdown brut est illisible dans un terminal (syntaxe `#`, `**`, ` ``` ` visible) et nuit à l'expérience verbose que l'ADR 0007 a introduite.
- *Shiki (highlighting des blocs de code)* : différée. `markstream-cli` supporte `createShikiHighlightCode` mais l'option `highlightCode` est asynchrone (`flush()` retourne `Promise<string[]>`). Les callbacks `onSessionUpdate` / `onEvent` du runtime sont actuellement synchrones ; intégrer l'async nécessiterait de repenser le cycle de vie du renderer. Le highlighting sera ajouté si le besoin se confirme.

**Consequences:**
- `CliTerminal` gagne deux membres en lecture seule : `supportsAnsi` (bool, `errorStream.isTTY`) et `columns` (nombre, `errorStream.columns ?? 80`). Les 4 mocks `FakeTerminal` des tests implémentent ces membres (`supportsAnsi = false` par défaut).
- Le bundle `dist/bin/cli.js` passe de ~1.1M à ~1.5M. Shiki est tree-shaken par esbuild (1 référence résiduelle = un chemin en commentaire).
- `markstream-cli` exige Node 22+ ; le repo exige déjà Node 22.19+ (`engines`), donc compatible.
- Le rendu ANSI est limité au mode `--verbose` et s’active explicitement avec `SLOPIFY_ANSI_STREAM=1`. Sans cette variable, le streaming reste en texte brut afin d’éviter que les patches de curseur soient répétés par les terminaux intégrés qui ne les interprètent pas correctement.
- `markstream-cli` est déclaré comme dépendance de `slopify/package.json`. Le workspace hoiste le paquet pendant le développement, tandis que le bundle esbuild l’embarque dans la CLI publiée.
- La sanitization par défaut (`allowControlSequences: false`) neutralise les séquences ESC/BEL du texte LLM ; les rendre visibles au lieu de les exécuter. Si un cas légitime nécessite des séquences de contrôle, il faudra activer `allowControlSequences` explicitement.
