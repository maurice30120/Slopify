# Guide du coordinateur Pi pour Slopify V2

Ce document décrit comment Pi, en tant que coordinateur, prépare et suit un lot complet d'implémentation avec Slopify V2, depuis les fichiers locaux ou les issues normalisées, jusqu'à la vérification finale et la clôture des tickets.

## Rôle du coordinateur Pi

Pi est l'agent unique qui interagit avec l'utilisateur pour :

1. **Préparer** le lot complet à partir des sources approuvées
2. **Valider** la complétude et les prérequis avant lancement
3. **Suivre** l'exécution du run jusqu'à son terme
4. **Présenter** le bilan final avec les preuves et les limitations
5. **Proposer** les interventions nécessaires (reprise, résolution de conflits, correction)

Slopify exécute les tâches dans des sandboxes Docker isolés. Pi ne pilote pas les lancements tâche par tâche, mais reçoit les résultats et les transmet à l'utilisateur.

---

## 1. Préparation du lot

### 1.1 Sources des tickets

Pi peut construire un lot à partir de **deux origines** :

#### A. Fichiers locaux (`.scratch/<feature>/issues/`)

Structure attendue :
```
.scratch/slopify-v2/
├── spec.md                    # Spécification approuvée
└── issues/
    ├── 01-implementer-add.md   # Ticket avec description, critères, interfaces
    ├── 02-implementer-multiply.md
    └── 03-implementer-total.md
```

Chaque fichier de ticket contient :
- **Description** du travail à réaliser
- **Critères d'acceptation** vérifiables
- **Interfaces de test approuvées** (pour TDD)
- **Dépendances** explicites vers d'autres tickets

#### B. Issues normalisées (fixtures)

Une issue normalisée est un fichier structuré qui représente une issue distante, mais **Slopify ne se connecte jamais à un tracker externe**. Pi normalise les issues en fichiers locaux avant de les soumettre.

Format minimal d'une issue normalisée :
```markdown
# [Issue] Implémenter la fonction add

**ID:** org/repo#42
**Status:** approved
**Assignee:** pi

## Description
Implémenter la fonction add(left, right) selon la spec.

## Critères d'acceptation
- add(2, 3) = 5
- add(-2, 3) = 1
- add(0, 0) = 0

## Interfaces de test
- add(number, number): number

## Dépendances
Aucune
```

### 1.2 Construction du lot JSON

Pi construit un **fichier JSON unique** (`batch.json`) contenant :

```json
{
  "specFile": "context/spec.md",
  "inputFiles": ["data/source-manifest.json"],
  "defaults": {
    "agent": "codex",
    "model": "gpt-6-luna",
    "effort": "medium"
  },
  "tasks": [
    {
      "id": "task-add",
      "prompt": "/skill:implement Consulte context/spec.md.\n\nDescription du ticket...\nCritères d'acceptation...\nInterfaces de test approuvées...",
      "dependsOn": [],
      "agent": "pi",
      "source": ".scratch/slopify-v2/issues/01-implementer-add.md"
    },
    {
      "id": "task-multiply",
      "prompt": "$implement Consulte context/spec.md.\n\nDescription...",
      "dependsOn": [],
      "agent": "codex",
      "source": "https://github.com/org/repo/issues/43"
    },
    {
      "id": "task-total",
      "prompt": "/skill:implement Consulte context/spec.md...",
      "dependsOn": ["task-add", "task-multiply"],
      "agent": "pi",
      "source": ".scratch/slopify-v2/issues/03-implementer-total.md"
    },
    {
      "id": "task-verify",
      "prompt": "/skill:code-review Effectue typechecking, suite complète et revue Standards/Spec depuis le commit de base du run.\n\nContexte: résultat intégré de toutes les tâches d'implémentation.",
      "dependsOn": ["task-add", "task-multiply", "task-total"],
      "agent": "pi",
      "source": "batch.json"
    }
  ]
}
```

**Règles de construction :**

1. **`specFile`** : Chemin relatif depuis le fichier batch vers la spec approuvée
2. **`tasks[i].id`** : Identifiant unique dans le lot (format libre, non vide)
3. **`tasks[i].prompt`** : **Texte complet** du ticket + invocation du skill adapté à l'agent
   - Pour Pi : `/skill:implement` ou `/skill:code-review`
   - Pour Codex : `$implement` ou `$code-review`
   - **Ne pas recopier** les instructions des skills officiels (ils sont montés en lecture seule)
   - Inclure **toujours** : la description, les critères, les interfaces de test approuvées
4. **`tasks[i].dependsOn`** : Liste des identifiants de tâches **du même lot**
5. **`defaults` et choix de l'Agent Host** : `init` prépare les valeurs de base `agent: "codex"`, `model: "gpt-6-luna"`, `effort: "medium"`. L'Agent Host doit choisir le runner, le modèle et l'effort adaptés à chaque tâche, puis écrire les champs tâche par tâche pour surcharger ces valeurs si nécessaire.
6. **`tasks[i].agent`** : `"pi"` ou `"codex"`. Le champ sélectionne le runner et peut hériter de `defaults.agent`. Les tâches Codex transmettent `model` avec `--model` et `effort` avec `-c model_reasoning_effort=...`; les champs de tâche remplacent les valeurs par défaut. Les tâches Pi utilisent le modèle configuré `zai-glm-5-3` et rejettent les surcharges `model` ou `effort` au niveau de la tâche.
7. **`tasks[i].source`** : Référence d'origine **non vide** (fichier local ou URL d'issue)
8. **`inputFiles`** (facultatif) : chemins des manifests et fichiers locaux lus par les tâches. Les déclarer ici permet à Slopify de vérifier qu'ils sont suivis dans le commit de base du run et donc présents dans les sandboxes.

### 1.3 Validation par Pi avant soumission

Avant de soumettre le lot à Slopify, Pi **doit** vérifier :

1. **Complétude de la spec** : Toutes les user stories de la spec sont couvertes par au moins un ticket
2. **Prérequis externes** : Aucun ticket du lot ne dépend d'un travail **non inclus** dans le lot
   - Si un prérequis externe est inachevé → **bloquer le lancement** et signaler à l'utilisateur
   - Exemple : Si `task-total` dépend de `org/repo#44` (non dans le lot) → refus
3. **Cohérence des dépendances** : Le graphe est acyclique et toutes les dépendances référencent des tâches du lot
4. **Attribution des agents** : Chaque tâche résout un agent valide (`pi` ou `codex`) depuis son champ ou `defaults.agent`; pour Codex, choisir explicitement un modèle et un effort adaptés si les valeurs de base ne conviennent pas
5. **Interfaces de test** : Les interfaces approuvées sont incluses dans chaque prompt
6. **Sources du lot** : Lire les manifests réellement utilisés, vérifier la provenance et la licence, et confirmer que chaque partition demandée dispose des sources attendues. Déclarer tous les fichiers locaux dans `inputFiles`; Slopify refuse le lancement si un fichier déclaré n'existe pas dans le commit de base. Si le manifeste ou une autorisation de collecte manque, bloquer le lancement et demander les sources ou l'accord explicite avant toute collecte.

**Exemple de blocage sur prérequis externe :**
```
Pi : "Le ticket task-total dépend de org/repo#44 qui n'est pas dans le lot approuvé. 
      Je ne peux pas élargir automatiquement le périmètre. 
      Souhaitez-vous inclure cette dépendance ou reporter task-total ?"
```

### 1.4 Tâche finale de vérification

Le prompt exige les sorties réelles des validations et les résultats des deux reviewers. Il doit demander de signaler toute preuve de TDD ou de délégation manquante comme non vérifiée, sans la déduire des commits.

Pi **ajoute toujours** une tâche finale dépendant de **toutes** les tâches d'implémentation :

```json
{
  "id": "task-final-verify",
  "prompt": "/skill:code-review Effectue les vérifications suivantes sur le résultat intégré :\n\n1. Typechecking complet (npm run typecheck ou équivalent)\n2. Suite de tests complète (npm test)\n3. Revue Standards/Spec depuis le commit de base du run (${runBaseCommit})\n\nContexte : résultat combiné de toutes les tâches d'implémentation.\nSpécification : voir context/spec.md",
  "dependsOn": ["task-add", "task-multiply", "task-total"],
  "agent": "pi",
  "source": "batch.json"
}
```

Cette tâche :
- Est une tâche **ordinaire** (pas de traitement spécial par Slopify)
- **Bloque la réussite du run** si elle échoue
- Utilise le skill `code-review` avec la baseline officielle
- Reçoit le commit de base du run pour la comparaison

---

## 2. Soumission à Slopify

### 2.1 Appel de l'API publique

```bash
# Depuis le dépôt de l'utilisateur
slopify tasks run batch.json \
  --cwd /chemin/vers/depot \
  --store /chemin/vers/stockage \
  --base HEAD \
  --json
```

**Paramètres :**
- `batch.json` : Chemin vers le fichier de lot
- `--cwd` : Répertoire du dépôt Git (obligatoire)
- `--store` : Répertoire de stockage des runs (optionnel, défaut : `~/.local/share/slopify/task-runs/<hash-du-dépôt>/` — un sous-répertoire par dépôt hôte : SHA-256 du chemin absolu du dépôt, tronqué à 16 caractères)
- `--base` : Commit de base du run (optionnel, défaut : `HEAD`)
- `--json` : Sortie machine-readable

### 2.2 Ce que Slopify valide

Slopify rejette le lot **avant toute exécution** si :

| Code | Condition | Message |
|------|-----------|---------|
| `invalid_json` | JSON invalide | "Batch must contain valid JSON." |
| `invalid_batch` | Pas un objet | "Expected a batch object." |
| `invalid_spec_file` | `specFile` vide | "Expected a nonempty spec file path." |
| `invalid_tasks` | `tasks` vide ou non tableau | "Expected a nonempty task list." |
| `invalid_id` | ID de tâche vide | "Expected a nonempty task ID." |
| `duplicate_id` | ID dupliqué | "Duplicate task ID \"X\"." |
| `invalid_prompt` | Prompt vide | "Expected the complete nonempty task prompt." |
| `invalid_dependencies` | `dependsOn` invalide | "Expected a list of nonempty task IDs." |
| `invalid_agent` | Agent inconnu | "Agent must be pi or codex." |
| `invalid_source` | Source vide | "Expected a nonempty file or issue reference." |
| `invalid_input_files` / `invalid_input_file` / `duplicate_input_file` | Liste mal formée, chemin absolu/hors dépôt ou dupliqué, ou source qui n'est pas un fichier régulier (symlink, dossier, sous-module) | Diagnostic sur `inputFiles` |
| `missing_input_file` | Fichier déclaré absent du commit de base | "Input file ... is not present in run base ...; commit it before launching the batch." |
| `self_dependency` | Auto-dépendance | "Task \"X\" depends on itself." |
| `missing_dependency` | Dépendance manquante | "Dependency \"Y\" is absent from this batch." |
| `dependency_cycle` | Cycle détecté | "Dependency cycle: A -> B -> A." |
| `unreadable_batch` | Fichier illisible | Erreur système |
| `unreadable_spec` | Spec illisible | Erreur système |
| `invalid_base` | Base Git invalide | Erreur système |

### 2.3 Ce que Slopify fige

Avant tout lancement, Slopify :

1. Crée une **copie figée** de `spec.md` et `batch.json` dans `<store>/<runId>/context/`
2. Résout `specFile` relativement au batch et lit son contenu
3. Crée une **branche d'intégration** : `feature/slopify-<runId>`
4. Enregistre le **commit de base du run** (`runBaseCommit`), qui fixe aussi la version des `inputFiles`
5. Persiste l'état initial dans `<store>/<runId>/state.json`

**Conséquence** : Les modifications apportées aux sources après le lancement **n'affectent pas** le run en cours.

---

## 3. Exécution et suivi

### 3.1 Ordonnancement au fil de l’eau

Slopify affecte chaque capacité libre à la première tâche prête dans l’ordre du JSON,
avec au plus **dix tâches actives** par lot, y compris après reprise.

- Une tâche devient prête après l’intégration réussie de tous ses prérequis.
- Chaque tâche conserve le commit de base épinglé à son démarrage ; les nouvelles
  tâches partent du dernier commit intégré.
- Un seul intégrateur traite les checkpoints au fil de leur disponibilité. L’ordre
  JSON départage les checkpoints prêts dans le même tour.
- Une tâche lente ne retarde pas les tâches indépendantes. Un échec bloque ses
  descendants, sans relance automatique.
- Un conflit suspend l’admission et les intégrations ; les tâches déjà actives
  terminent et leurs résultats restent disponibles pour une résolution explicite.

### 3.2 États des tâches

| État | Signification | Transition |
|------|--------------|------------|
| `pending` | En attente de dépendances | → `running` quand dépendances réussies |
| `running` | En cours d'exécution | → `completed`/`failed`/`interrupted` |
| `completed` | Exécution terminée, résultat à intégrer | → `succeeded` après intégration |
| `succeeded` | Intégration réussie | Terminal |
| `failed` | Échec d'exécution ou d'intégration | Terminal (bloque les descendants) |
| `interrupted` | Interrompu (pas de résultat) | → `running` sur reprise explicite |
| `blocked` | Bloqué par échec d'un ancêtre | Terminal (jusqu'à correction) |
| `conflicted` | Conflit d'intégration | Attend résolution explicite |

### 3.3 Suivre l'état du run

```bash
# Lire l'état complet
slopify tasks status <run-id> --cwd /chemin/vers/depot --store /chemin/vers/stockage --json
```

**Sortie (extraits) :**
```json
{
  "runId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "running",
  "runBaseCommit": "dbb62124b0e8f1a2b3c4d5e6f7a8b9c0d1e2f3a4",
  "integrationBranch": "feature/slopify-550e8400-e29b-41d4-a716-446655440000",
  "integrationCommit": "dbb62124b0e8f1a2b3c4d5e6f7a8b9c0d1e2f3a4",
  "tasks": [
    {
      "id": "task-add",
      "status": "succeeded",
      "attempts": [
        {
          "attemptId": "abc123",
          "status": "succeeded",
          "exitCode": 0,
          "checkpoint": "a1b2c3d4...",
          "stdoutPath": "/store/.../attempts/abc123/stdout.jsonl",
          "stderrPath": "/store/.../attempts/abc123/stderr.jsonl",
          "reportPath": "/store/.../attempts/abc123/report.md",
          "resource": {
            "sandboxName": "slopify-abc123",
            "inspectCommand": ["sbx", "exec", "slopify-abc123", "bash"]
          },
          "resourceState": "removed"
        }
      ]
    },
    {
      "id": "task-multiply",
      "status": "running",
      "attempts": [...]
    }
  ],
  "conflict": null,
  "diagnostics": []
}
```

Le `runId` est annoncé dès le lancement sur stderr, sans attendre la fin. Avec `--json`, les changements d’avancement sont des lignes JSON `type: "progress"` sur stderr ; pendant l’exécution, un tick minute ajoute des Signaux d’activité, lignes JSON dédiées `type: "activity-signal"` (phrases préfixées `[run <id>] <tâche(s)> : <phrase>` en mode texte) ; stdout reste un seul résultat final. Lire ensuite `tasks status` avec les mêmes `--cwd` et `--store`.

Le statut JSON conserve le snapshot et ajoute `progress` (phase, compteurs, tâches actives, checkpoints à intégrer, tâches prêtes et dépendances attendues), `issues` (causes des problèmes, avec tâche et tentative), `nextActions` (commandes en tableaux d’arguments et préconditions) et `activitySignals` (les dix derniers Signaux d’activité du run, absents quand aucun n’a été émis). Le texte expose les mêmes informations avec les rapports, logs, commits et sandboxes inspectables. Les diagnostics historiques sont marqués `historical: true` : ils ne constituent pas un nouveau problème de la reprise.

Pour suivre un run long sans relire son état complet à répétition, `slopify tasks watch <run-id>` émet une ligne par changement d'état ou nouveau Signal d’activité, puis se termine quand le run atteint un état final. `--interval <ms>` règle la fréquence de lecture (100 à 60 000 ms, 5 000 ms par défaut). `Ctrl-C` arrête uniquement le suivi; le run continue.

`running` indique l’état enregistré, sans prouver que le processus travaille encore. Utiliser la date de dernière sauvegarde et l’inspection du sandbox pour diagnostiquer un arrêt ; vérifier que l’ancien processus Slopify et l’agent précédent ont terminé avant de relancer. Une tâche `completed` attend l’intégration et ne doit pas être relancée.

### 3.4 Comprendre les diagnostics

Les diagnostics décrivent le contexte et les problèmes observés. Consulter aussi ceux de la dernière tentative de chaque tâche ; un code de sortie agent 0 peut accompagner un verdict d’échec explicite. Les codes ci-dessous peuvent informer ou expliquer un échec :

| Code | Signification |
|------|--------------|
| `host_changes_excluded` | Les modifications non commitées de l'utilisateur sont exclues |
| `integration_failed` | Échec lors de l'intégration Git |
| `pi_provider_error` | Erreur de fournisseur Pi (ex: permissions Mistral manquantes) |
| `codex_provider_error` | Erreur de fournisseur Codex |

---

## 4. Gestion des échecs et des conflits

### 4.1 Échec d'une tâche

**Comportement :**
- La tâche passe en état `failed`
- **Seuls les descendants** sont bloqués (`blocked`)
- Les tâches indépendantes **continuent** normalement
- Le run passe en état `failed` si des tâches échouent à la fin

**Preuves conservées :**
- Sortie stdout/stderr complète dans `<store>/<runId>/attempts/<attemptId>/`
- Commit de checkpoint (si créé)
- Rapport de l'agent (`report.md`)
- **Sandbox conservé** pour inspection (`resourceState: "retained"`)

**Exemple de diagnostic :**
```json
{
  "code": "task_failed",
  "message": "Task task-add failed with exit code 1",
  "path": "tasks[0]"
}
```

### 4.2 Conflit d'intégration

**Détection :**
Quand Slopify tente d'intégrer une tâche réussie et que Git signale un conflit :

1. Le run passe en état `conflicted`
2. **Aucun nouveau lancement** de tâche (suspension)
3. Les tâches **déjà en cours** terminent leur exécution
4. Les résultats **déjà obtenus** sont conservés (non intégrés)

**Structure du conflit :**
```json
{
  "conflict": {
    "taskId": "task-total",
    "attemptId": "xyz789",
    "taskBaseCommit": "a1b2c3d4...",
    "currentCommit": "e5f6g7h8...",
    "incomingCommit": "i9j0k1l2...",
    "files": ["src/add.js", "src/multiply.js"],
    "output": "Auto-merging src/add.js\nCONFLICT (content): Merge conflict..."
  }
}
```

### 4.3 Résolution de conflit

Pi **propose** une résolution, mais **ne résout jamais automatiquement** :

```bash
# Lister les conflits
slopify tasks conflict <run-id> --cwd /depot --store /store

# Résoudre avec une stratégie
slopify tasks resolve-conflict <run-id> --strategy use-current  # Garde la version actuelle
slopify tasks resolve-conflict <run-id> --strategy use-incoming  # Accepte la version entrante
slopify tasks resolve-conflict <run-id> --strategy manual      # Résolution manuelle requise
```

**Stratégie `manual` :**
1. Crée un sandbox dédié : `slopify-resolution-<runId>-<attemptId>-<uuid>`
2. Contient les fichiers en conflit et le contexte
3. Pi demande à l'utilisateur d'autoriser une tentative de résolution
4. Après validation, Slopify intègre les résultats en attente

**Preuves conservées en cas d'échec de résolution :**
- Sandbox de résolution **conservé**
- Commande d'inspection disponible
- État du run reste `conflicted`

---

## 5. Reprise et correction

### 5.1 Reprise d'une tâche interrompue

Une tâche `interrupted` (pas de résultat enregistré) peut être relancée :

```bash
slopify tasks resume-task <run-id> <task-id> --cwd /depot --store /store
```

**Comportement :**
- Crée un **nouveau sandbox** avec un nouvel `attemptId`
- Part du **commit intégré courant** (pas de la conversation de l'ancien agent)
- Les tâches déjà réussies **ne sont pas refaites**
- Une tâche restée `running` après l’arrêt du processus peut aussi être reprise explicitement avec `resume-task`, après avoir vérifié que son ancien agent ne travaille plus. Les ressources de la tentative précédente restent inspectables.

### 5.2 Lot de correction

Si la vérification finale échoue :

1. Pi **présente le problème** à l'utilisateur avec les preuves
2. Pi **attend l'accord explicite** pour un nouveau lot
3. Le nouveau lot :
   - Est basé sur la **branche d'intégration obtenue**
   - Contient une **nouvelle tâche finale de vérification**
   - Le lot initial **reste figé et auditable**

**Exemple :**
```
Pi : "La vérification finale a échoué : test de total(0,3,1) attend 1, obtenu 0. 
      La tâche task-total n'a pas implémenté la logique correcte. 
      Souhaitez-vous autoriser un lot de correction basé sur 
      feature/slopify-550e8400-e29b-41d4-a716-446655440000 ?"
```

---

## 6. Bilan final

### 6.1 Contenu du bilan

Quand le run est terminé (`succeeded` ou `failed`), Pi présente :

1. **Branche** : Nom de la branche d'intégration (`feature/slopify-<runId>`)
2. **Tâches** : Liste des tâches avec leur état final
3. **Commits** : Tous les commits créés pendant le run
4. **Rapports** : Chemins vers les rapports de chaque tâche
5. **Ressources retenues** : Sandboxes conservés (échecs, conflits, interruptions)
6. **Ressources supprimées** : Sandboxes réussis (après sauvegarde des résultats)
7. **Interventions** : Actions manuelles requises ou effectuées

**Hygiène des sandboxes** : les sandboxes retenues et arrêtées s’accumulent d’un run à l’autre (`sbx ls`). Nettoyer périodiquement avec `sbx prune`, mais seulement après avoir sauvegardé le travail utile : une tentative sans checkpoint n’existe que dans sa sandbox, et le prune détruit définitivement ce travail.

### 6.2 Format du rapport

```markdown
## Bilan du run 550e8400-e29b-41d4-a716-446655440000

**Statut:** succeeded
**Date:** 2026-10-06T17:00:00.000Z
**Branche d'intégration:** feature/slopify-550e8400-e29b-41d4-a716-446655440000
**Commit de base:** dbb62124b0e8f1a2b3c4d5e6f7a8b9c0d1e2f3a4
**Commit final:** a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0

### Tâches
| ID | Agent | État | Attempts | Commit |
|----|-------|------|----------|--------|
| task-add | pi | succeeded | 1 | b2c3d4e5 |
| task-multiply | codex | succeeded | 1 | f6g7h8i9 |
| task-total | pi | succeeded | 1 | j0k1l2m3 |
| task-verify | pi | succeeded | 1 | a1b2c3d4 |

### Ressources
- **Retenues:** Aucune (toutes réussies)
- **Supprimées:** slopify-abc123, slopify-def456, slopify-ghi789, slopify-jkl012

### Preuves
- Logs: /private/tmp/slopify-runs/550e8400.../attempts/*/{stdout,stderr}.jsonl
- Rapports: /private/tmp/slopify-runs/550e8400.../attempts/*/report.md
- Checkpoints: git log feature/slopify-550e8400...

### Limitations
- La revue Standards/Spec dépend de la qualité des preuves fournies par les agents
- Aucune garantie que les agents suivent parfaitement TDD
```

### 6.3 Récupération par l'hôte

La branche d'intégration est **accessible depuis le dépôt hôte** :

```bash
# Depuis le dépôt de l'utilisateur
git show-ref --verify refs/heads/feature/slopify-550e8400-e29b-41d4-a716-446655440000

# Inspecter les changements
git log dbb62124b..feature/slopify-550e8400...
git diff dbb62124b..feature/slopify-550e8400...
```

**Garanties :**
- La branche de travail de l'utilisateur **n'est jamais modifiée**
- Les fichiers non commités (dirty) **ne sont jamais inclus**
- Les modifications locales **restent intactes**

### 6.4 Clôture des tickets

Pi **ne clôture jamais automatiquement** les tickets. La clôture est **explicite** :

```
Pi : "Le run a réussi. Toutes les tâches sont intégrées dans 
      feature/slopify-550e8400-e29b-41d4-a716-446655440000. 
      Souhaitez-vous que je clôture les tickets T01-T04 dans le tracker ?"

Utilisateur : "Oui, clôture les tickets."

Pi : [Clôture les tickets selon les règles du tracker]
```

---

## 7. Exemples complets

### 7.1 Exemple : Lot depuis fichiers locaux

**Contexte :**
- Dépôt : `/private/tmp/slopify-v2-smoke-run`
- Spec : `.scratch/slopify-v2/spec.md`
- Tickets : `.scratch/slopify-v2/issues/01-add.md`, `02-multiply.md`, `03-total.md`

**Étape 1 : Pi lit la spec et les tickets**
```
Pi : [Lit .scratch/slopify-v2/spec.md]
Pi : [Lit .scratch/slopify-v2/issues/01-add.md]
Pi : [Lit .scratch/slopify-v2/issues/02-multiply.md]
Pi : [Lit .scratch/slopify-v2/issues/03-total.md]
```

**Étape 2 : Pi vérifie les prérequis**
```
Pi : "Vérification des dépendances... OK (aucune dépendance externe)"
Pi : "Vérification de la complétude... OK (3/3 user stories couvertes)"
```

**Étape 3 : Pi construit le lot**
```json
{
  "specFile": ".scratch/slopify-v2/spec.md",
  "tasks": [
    {
      "id": "task-add",
      "prompt": "/skill:implement Consulte .scratch/slopify-v2/spec.md.\n\nImplémenter add(left, right)...",
      "dependsOn": [],
      "agent": "pi",
      "source": ".scratch/slopify-v2/issues/01-add.md"
    },
    {
      "id": "task-multiply",
      "prompt": "$implement Consulte .scratch/slopify-v2/spec.md...",
      "dependsOn": [],
      "agent": "codex",
      "source": ".scratch/slopify-v2/issues/02-multiply.md"
    },
    {
      "id": "task-total",
      "prompt": "/skill:implement...",
      "dependsOn": ["task-add", "task-multiply"],
      "agent": "pi",
      "source": ".scratch/slopify-v2/issues/03-total.md"
    },
    {
      "id": "task-verify",
      "prompt": "/skill:code-review...",
      "dependsOn": ["task-add", "task-multiply", "task-total"],
      "agent": "pi",
      "source": "batch.json"
    }
  ]
}
```

**Étape 4 : Pi soumet à Slopify**
```bash
slopify tasks run batch.json --cwd /private/tmp/slopify-v2-smoke-run --store /tmp/slopify-store
```

**Étape 5 : Pi suit le run**
```bash
# Démarrage : task-add (pi) + task-multiply (codex) en parallèle
slopify tasks status 550e8400...  # status: running, 2 tasks running

# Chaque checkpoint est intégré dès sa disponibilité
slopify tasks status 550e8400...  # status: running, 1 task completed, 1 task pending

# Les deux prérequis intégrés : task-total démarre
slopify tasks status 550e8400...  # status: running, 1 task running

# task-total intégré : task-verify démarre
slopify tasks status 550e8400...  # status: running, 1 task running

# Fin : toutes les tâches réussissent
slopify tasks status 550e8400...  # status: succeeded
```

**Étape 6 : Pi présente le bilan**
```
Pi : "Run 550e8400 terminé avec succès. 
      Branche : feature/slopify-550e8400-e29b-41d4-a716-446655440000
      Tâches : 4/4 réussies
      Vérification finale : OK
      Souhaitez-vous récupérer la branche ?"
```

### 7.2 Exemple : Lot avec issue normalisée

**Contexte :**
- Issue distante : `org/repo#42` (Implémenter add)
- Pi normalise en fichier local : `/tmp/normalized-issues/01-add.md`

**Contenu de l'issue normalisée :**
```markdown
# [Issue] Implémenter la fonction add

**ID:** org/repo#42
**Status:** approved
**Assignee:** pi

## Description
Implémenter la fonction add(left, right) selon la spec approuvée.

## Critères d'acceptation
- add(2, 3) = 5
- add(-2, 3) = 1
- add(0, 0) = 0

## Interfaces de test
- add(number, number): number

## Dépendances
Aucune
```

**Lot construit par Pi :**
```json
{
  "specFile": "spec.md",
  "tasks": [
    {
      "id": "task-add",
      "prompt": "/skill:implement Consulte spec.md.\n\n[Issue] Implémenter la fonction add\n\n**ID:** org/repo#42...",
      "dependsOn": [],
      "agent": "pi",
      "source": "https://github.com/org/repo/issues/42"
    }
  ]
}
```

**Note importante :** Le champ `source` conserve la référence d'origine (URL), mais le `prompt` contient le **texte complet** de l'issue normalisée. Slopify n'a **jamais besoin** de récupérer l'issue distante.

### 7.3 Exemple : Blocage sur prérequis externe

**Contexte :**
- `task-total` dépend de `org/repo#44` (non dans le lot)
- `org/repo#44` n'est pas dans le lot soumis

**Comportement de Pi :**
```
Pi : "Analyse des dépendances..."
Pi : "ERREUR : task-total dépend de org/repo#44 qui n'est pas dans le lot."
Pi : "Le périmètre approuvé ne peut pas être élargi automatiquement."
Pi : "Options :"
Pi : "  1. Inclure org/repo#44 dans le lot (nécessite approbation utilisateur)"
Pi : "  2. Reporter task-total jusqu'à ce que org/repo#44 soit terminé"
Pi : "  3. Supprimer la dépendance si elle est incorrecte"
Pi : "Que souhaitez-vous faire ?"
```

---

## 8. Contrat avec les implémenteurs

### 8.1 Ce que reçoit chaque implémenteur

Dans son sandbox, l'agent reçoit :

1. **Le prompt complet** (champ `prompt` du lot)
2. **La spec figée** (`context/spec.md` monté en lecture seule)
3. **Le commit de base de la tâche** (`taskBaseCommit`)
4. **Le commit de base du run** (`runBaseCommit`)
5. **Le magasin de skills** monté en lecture seule
6. **Les capabilities vérifiées** (Pi : Mistral via proxy, Codex : natif)

### 8.2 Ce que l'implémenteur doit faire

Suivre le parcours du skill `implement` :

1. **Lire** le ticket et la spec locale
2. **Travailler en cycles TDD** : rouge → vert par comportement
3. **Utiliser les interfaces de test approuvées**
4. **Exécuter** typechecking et tests ciblés régulièrement
5. **Faire un commit provisoire** avant la revue
6. **Exécuter la suite complète** (`npm run build`, `npm test`)
7. **Effectuer la revue** (`code-review` depuis le commit de départ)
8. **Corriger** si nécessaire
9. **Faire un commit final**
10. **Produire un compte rendu** avec preuves et limitations

### 8.3 Preuves attendues

Le harness exige aussi un verdict explicite dans le dernier message de l’agent : `SLOPIFY_RESULT={"status":"succeeded"}` ou `SLOPIFY_RESULT={"status":"failed","reason":"blocage restant"}`. Un code de sortie 0 du CLI signifie seulement que le processus a terminé. Un verdict failed, absent ou invalide empêche le checkpoint et l’intégration ; le sandbox et les traces sont conservés. Les tests rouges intermédiaires TDD ne constituent pas un échec final. Ce verdict reste une déclaration de l’agent : le coordinateur doit examiner les validations et les revues réelles.

L'implémenteur **doit conserver** :

- **Sorties brutes** : stdout/stderr des commandes
- **Commandes exécutées** avec leurs codes de sortie
- **Résultats de tests** (pass/fail, durée)
- **Checkpoints Git** (commits provisoires et finaux)
- **Rapports de revue** (Standards/Spec)
- **Limitations** honnêtement déclarées

**À ne pas faire :**
- ❌ Inférer le respect de TDD à partir du diff final
- ❌ Présenter des preuves reconstruites
- ❌ Cacher les échecs ou les limitations

---

## 9. Configuration requise

### 9.1 Pour Pi (coordinateur)

Aucune configuration spéciale. Pi fonctionne dans la session de l'utilisateur.

### 9.2 Pour Pi (implémenteur)

- **Image** : Pi avec kit Mistral
- **Fournisseur** : Mistral configuré via proxy Docker
- **Domaine autorisé** : `api.mistral.ai:443`
- **Skills** : Montage explicite du magasin en lecture seule (`--skill <racine>`)
- **Extensions** : `subagent` pour la délégation des revues

**Exemple de kit Pi :**
```json
{
  "image": "ghcr.io/earendil-works/pi:latest",
  "provider": {
    "type": "mistral",
    "apiKey": "${MISTRAL_API_KEY}"
  },
  "permissions": {
    "network": {
      "allow": ["api.mistral.ai:443"]
    }
  },
  "skills": {
    "mount": "/Users/dhuyet/.agents/skills",
    "readonly": true
  }
}
```

### 9.3 Pour Codex

- **Skills** : Découverte gérée par `sbx` (`~/.agents/skills`)
- **Délégation native** : Support intégré pour les sous-agents

---

## 10. Résumé des commandes Slopify V2

La CLI expose uniquement les commandes `tasks`. `list`, `run <pipeline> <prompt>` et `resume --agent` sont retirées. Les commandes d’exécution et de reprise retournent 0 si le run réussit, 2 s’il échoue, est interrompu ou en conflit, et 1 pour une erreur d’entrée ou de commande. Les consultations réussies retournent 0.

`slopify tasks resume <run-id>` reprend explicitement les échecs/interruption et les tâches en attente sans réexécuter les réussites. Arrêter les anciens agents avant de reprendre les tentatives encore marquées `running` avec `resume-task`. Une reprise isolée attend qu’une place soit disponible si dix autres tâches sont encore en cours.

| Commande | Description |
|----------|-------------|
| `slopify tasks run <batch> [--cwd <repo>] [--store <dir>] [--base <ref>]` | Lancer un nouveau run |
| `slopify tasks status <run-id> [--cwd <repo>] [--store <dir>]` | Lire l'état d'un run |
| `slopify tasks watch <run-id> [--cwd <repo>] [--store <dir>] [--interval <ms>]` | Suivre les changements d'état d'un run |
| `slopify tasks resume <run-id> [--cwd <repo>] [--store <dir>]` | Reprendre le lot |
| `slopify tasks validate-resolution <run-id> <resolution-id> [--cwd <repo>] [--store <dir>]` | Valider une résolution manuelle et reprendre |
| `slopify tasks resolution <run-id> [--cwd <repo>] [--store <dir>]` | Consulter la résolution |
| `slopify tasks resume-task <run-id> <task-id> [--cwd <repo>] [--store <dir>]` | Reprendre une tâche |
| `slopify tasks conflict <run-id> [--cwd <repo>] [--store <dir>]` | Lister les conflits |
| `slopify tasks resolve-conflict <run-id> --strategy <use-current\|use-incoming\|manual> [--cwd <repo>] [--store <dir>]` | Résoudre un conflit |

---

## 11. Checklist du coordinateur

- [ ] Toutes les tâches de la spec sont incluses dans le lot
- [ ] Aucune dépendance externe non résolue
- [ ] Chaque tâche a un agent valide (`pi` ou `codex`)
- [ ] Chaque prompt contient le texte complet du ticket + invocation du skill
- [ ] Les interfaces de test approuvées sont incluses
- [ ] Les fichiers d'entrée locaux sont déclarés dans `inputFiles`, présents au commit de base et couvrent toutes les partitions avec une provenance et une licence vérifiées
- [ ] La tâche finale de vérification dépend de toutes les implémentations
- [ ] La spec et le batch sont figés avant lancement
- [ ] Le dépôt hôte est préservé (branche de travail inchangée)
- [ ] Les preuves sont conservées et accessibles
- [ ] Le bilan est complet et honnête sur les limitations

---

## 12. Limites et responsabilités

### 12.1 Limites de Slopify

Slopify **ne garantit pas** :
- Qu'un agent suit parfaitement TDD
- Qu'une revue est correcte
- Que le code est exempt de bugs
- Que les preuves sont complètes

Slopify **fournit** :
- Les capacités (sandboxes, isolation, intégration)
- Le contexte (spec, tickets, skills)
- Les traces brutes (logs, commits, rapports)
- Un bilan honnête des résultats

### 12.2 Responsabilités de Pi

Pi **doit** :
- Vérifier la complétude du lot avant soumission
- Bloquer sur les prérequis externes non résolus
- Suivre le run et expliquer les échecs
- Présenter les preuves et les limitations
- Attendre l'accord explicite pour les corrections

Pi **ne doit pas** :
- Modifier les skills officiels
- Copier les instructions des skills dans les prompts
- Falsifier les preuves ou les résultats
- Clôturer les tickets sans demande explicite
- Résoudre les conflits automatiquement

---

*Document version: 1.0 - Aligné sur Slopify V2 spec et ADR 0007-0011*

## Vérification et santé des processus de test

Sur une modification du moteur, commencer par les tests ciblés du package concerné,
puis lancer `npm test` avant livraison. Les tests automatiques emploient Git réel
dans des dépôts temporaires et des agents/`sbx` simulés : **pas de Docker réel
dans la CI**. Tout processus enfant créé par un test doit être attendu et nettoyé
avec `t.after`. Ne pas laisser de descendants ou de timers persistants.
Si le sandbox de développement signale `Cannot fork` ou `pthread_create`,
cesser immédiatement les relances, pousser la branche et consulter les résultats CI.

Les essais réels sont manuels, **sur le poste utilisateur uniquement** :
`npm run smoke:local` pour les agents natifs, `npm run smoke:docker` pour Docker
Sandboxes. Ils ne sont jamais déclenchés par `npm test` ni GitHub Actions.
Voir `docs/testing.md`.
