# Slopify V2

Slopify reçoit une spec et un lot JSON préparés à l’extérieur, puis exécute les
tâches avec Pi ou Codex dans des sandboxes Docker distincts. Dès qu’une place se
libère, la première tâche prête dans l’ordre du JSON démarre, avec au plus dix
tâches actives. Chaque tâche garde sa base épinglée au démarrage. Les checkpoints
s’intègrent un à un dès leur disponibilité ; leurs descendants deviennent alors
éligibles. Un échec bloque seulement ses descendants, sans relance automatique.

## Fonctionnement en images

Les trois planches ci-dessous illustrent le fonctionnement historique par vagues.
L’ordonnanceur actuel admet jusqu’à **10 tâches prêtes en parallèle**, chacune avec
son agent principal et sa sandbox. Les sous-agents de revue ne sont pas comptés
dans ce plafond.

### 1. Utilisateur, agent hôte, CLI et sous-agents

![Articulation entre utilisateur, agent hôte Pi ou Codex, CLI Slopify, agents de tâche et sous-agents de revue](docs/images/slopify/01-roles-et-delegation.png)

### 2. Du lot au résultat intégré

![Validation et contexte figé, exécution par vagues de dix tâches maximum, checkpoints et intégration Git dans l’ordre du lot](docs/images/slopify/02-cycle-et-vagues.png)

### 3. Suivi, reprises et conflits

![Commandes de suivi et de reprise, résolution des conflits, preuves conservées et limites des contrôles automatiques](docs/images/slopify/03-suivi-reprises-conflits.png)

Voir les [sources du code et les précisions de lecture](docs/images/slopify/README.md).

## Installation et utilisation

Prérequis : Node.js >= 22.19, npm, Docker Sandboxes (`sbx`), agents Pi/Codex
configurés et skills `implement`, `tdd`, `code-review` disponibles en lecture seule.

```bash
scripts/install.sh      # npm install si besoin + build + symlink slopify dans ~/.local/bin (PATH)
slopify --help
slopify init --host all --yes
slopify tasks run batch.json --cwd /chemin/du/depot --json
slopify tasks status <run-id> --cwd /chemin/du/depot --json
slopify tasks resume <run-id> --cwd /chemin/du/depot --json
```

`scripts/uninstall.sh` retire le symlink et le bloc PATH correspondant du fichier
rc du shell (dist/ est conservé ; `npm run clean` le supprime). L'install
expose un symlink vers le repo : le CLI résout ses assets (`plugin/`, `init/`)
relativement à sa propre position, donc le lien doit pointer dans le repo.

Sans installation globale : `npm run slopify -- tasks run batch.json --json`.

`slopify init` prépare uniquement le projet ciblé (`--cwd`) pour la V2 : exemples
dans `.scratch/slopify/`, conventions locales et skill hôte Pi/Codex. `--host`
accepte `pi`, `codex` ou `all`; `--yes` choisit `all` par défaut. Une relance
réécrit tous les fichiers possédés par init, sans sauvegarde, et préserve les autres.
Le choix d'hôte reste interactif sans `--host`, mais le pull project-scope de
`mattpocock/skills` est toujours automatique et non interactif. Il est géré par la
CLI `skills`; son échec est un avertissement. Init ne consulte ni ne modifie le
store global `sbx`.

Cette commande adapte l'intention de l'issue historique #45 au contrat V2 : aucun
asset `.acp`, Vibe ou Copilot et aucune restauration des anciennes commandes. Les
ADR historiques restent inchangées.

Le lot contient `specFile`, des `defaults` facultatifs et `tasks`. Init propose
`agent: "codex"`, `model: "gpt-6-luna"`, `effort: "medium"` comme base ; l'Agent
Host choisit les paramètres par tâche et peut les surcharger. `model` et `effort`
s'appliquent aux tâches Codex. Slopify valide tout le lot avant lancement et
transmet les prompts sans réécrire les instructions de skills.
Il conserve l’état durable, les rapports et la branche `feature/slopify-<run-id>`
sans modifier la branche de travail de l’utilisateur.

Codes : **0** pour une exécution ou consultation réussie, **2** pour une exécution
échouée, interrompue ou en conflit, **1** pour une erreur d’entrée ou de commande.
Les anciens `list`, `run <pipeline> <prompt>` et `resume --agent` sont retirés.

`run` annonce son identifiant et son avancement sur stderr. `tasks status` fournit
les compteurs, les causes d’échec et blocages, les rapports et les commandes utiles
pour la suite, en texte ou JSON.

Voir le [contrat JSON et les commandes V2](slopify/README.md) et le
[guide Pi](docs/agents/coordinator-pi.md) pour les reprises et conflits.

## Monorepo et validation

`slopify` expose uniquement les lots V2. Les bibliothèques `acp-pipeline`,
`acp-runtime`, `acp-sandbox`, `acp-workspace` et leurs tests hérités sont conservés.
Les configurations historiques nécessaires aux tests vivent dans leurs fixtures.

```bash
npm run build
npm test
node slopify/smoke/task-batch.mjs
```

L’essai Docker utilise un dépôt temporaire et conserve ses preuves dans le chemin
affiché. Il nécessite les accès aux fournisseurs des deux agents.
