# Roadmap Slopify

> Dernière mise à jour : 24 juillet 2026

## Vision

Slopify doit devenir un moteur de workflows de développement multi-agents, autonome, observable et sûr, capable de :

- compiler et exécuter des pipelines ACP v3 sous forme de DAG ;
- déléguer chaque nœud à un agent ACP natif ou isolé ;
- faire circuler des artefacts structurés et validés entre les agents ;
- exécuter en parallèle les tâches indépendantes ;
- isoler chaque implémentation dans un environnement jetable ;
- conserver un contrôle humain explicite aux étapes sensibles ;
- reprendre un run interrompu sans perdre son état ;
- exposer dans la CLI les actions, messages, réflexions et résultats des agents ;
- ne modifier le workspace principal qu’à travers une promotion explicite, atomique et traçable.

Le socle actuel est déjà correctement séparé :

- `@acp-client/pipeline` compile et exécute les DAG ;
- `@acp-client/runtime` porte le protocole et les processus ACP ;
- `@acp-client/sandcastle` porte actuellement l’isolation et la promotion ;
- `@acp-client/workspace` charge et compose la configuration du projet ;
- `slopify` adapte le moteur au terminal.

---

## Principes directeurs

### 1. Le moteur de pipeline reste indépendant des hôtes

`@acp-client/pipeline` ne doit dépendre ni :

- du terminal ;
- de VS Code ;
- d’un fournisseur d’agents ;
- de Sandcastle ;
- de Docker ;
- du format de stockage concret des runs.

Toutes ces responsabilités doivent être injectées par des adaptateurs.

### 2. Les artefacts sont les contrats entre agents

Les échanges entre nœuds doivent privilégier des artefacts typés plutôt que des chaînes de texte implicites.

Contrats existants à conserver et faire évoluer :

- `acp.grill-decision/v1` ;
- `acp.specification/v1` ;
- `acp.ticket-graph/v1` ;
- `acp.implementation-result/v1` ;
- `acp.merge-result/v1` ;
- `acp.verification-report/v1`.

### 3. L’autonomie est limitée par une frontière d’isolation

Un agent d’implémentation peut recevoir des permissions larges uniquement lorsque ses effets sont confinés dans un environnement isolé.

Le workspace principal ne doit être modifié que par une opération de promotion explicite, atomique et traçable.

### 4. La CLI est une projection du runtime

La CLI ne doit pas réimplémenter l’orchestration. Elle traduit :

- les événements runtime ;
- les interactions humaines ;
- les messages et réflexions des agents ;
- les artefacts produits ;
- les erreurs et diagnostics ;
- les opérations de reprise et d’annulation.

### 5. Une migration de backend ne doit pas modifier le contrat pipeline

Le remplacement de Sandcastle par Docker Sandboxes ne doit pas obliger à réécrire :

- les définitions YAML des pipelines, hors configuration explicite du backend ;
- le moteur de DAG ;
- les contrats d’artefacts ;
- le protocole ACP ;
- les statuts de promotion.

---

# Jalons prioritaires

## M0 — Stabiliser le dépôt et les contrats

**Priorité : immédiate**

### Actions

- [ ] terminer la migration ESM de tous les workspaces ;
- [ ] uniformiser TypeScript et `@types/node` ;
- [ ] supprimer les exports `require` qui ne correspondent pas à un build CommonJS réel ;
- [ ] centraliser les options TypeScript communes ;
- [ ] synchroniser la documentation avec `instructionsFile` ;
- [ ] ajouter un exemple complet de pipeline ACP v3 ;
- [ ] ajouter une CI exécutant `npm ci`, `npm run build` et `npm test` ;
- [ ] documenter les responsabilités et les frontières de chaque workspace.

### Critères d’acceptation

- [ ] tous les packages suivent la même stratégie ESM ;
- [ ] `npm run build` réussit à la racine ;
- [ ] `npm test` réussit à la racine ;
- [ ] chaque pull request est validée automatiquement ;
- [ ] aucun exemple récent ne recommande `promptFile`.

---

## M1 — Rendre les agents observables dans la CLI

**Priorité : haute**

### Actions

- [ ] afficher le contenu des `agent_message_chunk` ;
- [ ] rendre l’affichage des `agent_thought_chunk` configurable ;
- [ ] associer chaque sortie au `runId`, `nodeId`, rôle et nom d’agent ;
- [ ] fusionner correctement les chunks successifs ;
- [ ] ne jamais mélanger deux agents sur la même ligne ;
- [ ] ajouter les modes :
  - normal ;
  - `--verbose` ;
  - `--trace` ;
  - `--show-thoughts` ;
  - `--jsonl` ;
- [ ] conserver un buffer d’affichage par nœud ;
- [ ] préparer une future TUI sans déplacer la logique métier dans la CLI.

### Commandes cibles

```text
slopify runs
slopify inspect <run-id>
slopify logs <run-id>
slopify logs <run-id> --node <node-id>
slopify artifacts <run-id>
```

### Critères d’acceptation

- [ ] le contenu des messages est visible pendant le run ;
- [ ] deux agents parallèles restent distinguables ;
- [ ] la sortie JSONL possède un schéma documenté ;
- [ ] les logs d’un nœud sont consultables sans lire manuellement les fichiers NDJSON.

---

## M2 — Persister et reprendre les runs

**Priorité : haute**

### Actions

- [ ] brancher `FilePipelineRunStore` dans la CLI ;
- [ ] utiliser un stockage par workspace dans `.acp/runs-v3` ;
- [ ] conserver snapshots, événements et artefacts ;
- [ ] distinguer les runs reprenables des runs seulement inspectables ;
- [ ] restaurer les pauses et interactions humaines ;
- [ ] définir le traitement d’un nœud `running` après crash ;
- [ ] empêcher le rejeu d’une promotion déjà appliquée ;
- [ ] ajouter des identifiants idempotents aux actions externes.

### Commandes cibles

```text
slopify runs --resumable
slopify resume <run-id>
slopify cancel <run-id>
slopify inspect <run-id>
slopify clean-runs
```

### Critères d’acceptation

- [ ] un run interrompu sur une pause peut être repris ;
- [ ] les artefacts déjà produits sont conservés ;
- [ ] les nœuds terminés ne sont pas rejoués ;
- [ ] une promotion appliquée ne peut pas être rejouée ;
- [ ] les erreurs de reprise sont explicites.

---

## M3 — Exécuter les tickets en parallèle sous forme de DAG

**Priorité : très haute**

### Cible

```text
                    ┌─ ticket-A ─┐
specification ──────┼─ ticket-B ─┼─ intégration ─ vérification
                    └─ ticket-C ─┘
```

### Actions

- [ ] enrichir `acp.ticket-graph/v1` avec :
  - identifiant ;
  - périmètre ;
  - dépendances ;
  - fichiers ou modules concernés ;
  - critères de validation ;
  - agent conseillé ;
  - risques de conflit ;
- [ ] vérifier les références de dépendances ;
- [ ] détecter cycles et identifiants dupliqués ;
- [ ] produire un ordre topologique stable ;
- [ ] identifier les groupes parallélisables ;
- [ ] remplacer le workflow séquentiel par un sous-DAG dynamique ou un orchestrateur concurrent ;
- [ ] donner à chaque ticket une branche et un environnement isolé ;
- [ ] produire un `acp.implementation-result/v1` par ticket ;
- [ ] limiter la concurrence ;
- [ ] ajouter une étape d’intégration explicite ;
- [ ] lancer la vérification finale sur le résultat intégré.

### Configuration candidate

```yaml
execution:
  maxParallelNodes: 4
  maxParallelImplementations: 3
  failurePolicy: continue-independent
```

Politiques prévues :

- `fail-fast` ;
- `continue-independent` ;
- `collect-all`.

### Critères d’acceptation

- [ ] deux tickets indépendants s’exécutent réellement en parallèle ;
- [ ] deux tickets dépendants respectent l’ordre du DAG ;
- [ ] chaque ticket possède son propre environnement isolé ;
- [ ] aucun échec n’entraîne de mutation partielle du workspace principal ;
- [ ] l’intégration est déterministe ;
- [ ] la vérification finale porte sur la branche intégrée.

---

# M4 — Remplacer Sandcastle par Docker Sandboxes

**Priorité : haute après validation du POC**

## Décision recommandée

Ne pas remplacer directement les appels Sandcastle dans `@acp-client/workspace`.

La migration doit suivre cet ordre :

1. réaliser un POC bloquant ;
2. extraire un contrat générique de sandbox ;
3. encapsuler Sandcastle comme backend historique ;
4. ajouter Docker Sandboxes comme second backend ;
5. migrer Codex en premier ;
6. conserver Sandcastle pour les providers non encore compatibles ;
7. supprimer Sandcastle seulement après parité fonctionnelle et sécurité validées.

## Contraintes Docker Sandboxes à intégrer

- Docker Sandboxes exécute les agents dans des microVM isolées ;
- chaque sandbox possède son propre filesystem, réseau et Docker Engine ;
- le mode workspace direct monte les fichiers hôte en lecture-écriture ;
- le mode direct ne respecte donc pas la frontière de promotion de Slopify ;
- le mode clone `--clone` doit être obligatoire pour les agents d’implémentation ;
- le mode clone travaille dans un clone privé et expose le dépôt source en lecture seule ;
- le mode clone ne crée pas automatiquement une branche ;
- le mode clone doit être créé depuis le checkout principal, pas depuis un worktree secondaire ;
- un sandbox persiste jusqu’à `sbx rm` ;
- les secrets doivent être gérés par `sbx`, pas copiés dans la microVM ;
- Docker Desktop n’est pas requis, mais la plateforme doit supporter l’hyperviseur ou KVM ;
- les microVM ont un coût supérieur à de simples conteneurs, donc la concurrence doit être limitée.

## Invariants à préserver

- [ ] aucune écriture dans le workspace hôte avant promotion ;
- [ ] `sideEffects: workspace` signifie « changements promouvables » ;
- [ ] rejet et annulation ne modifient rien ;
- [ ] une promotion échouée ne laisse aucune mutation partielle ;
- [ ] les statuts restent :
  - `applied` ;
  - `no_changes` ;
  - `rejected` ;
  - `cancelled` ;
- [ ] le streaming ACP reste temps réel ;
- [ ] l’agent reste annulable ;
- [ ] chaque ticket parallèle possède un sandbox distinct.

---

## Graphe de travail M4

```text
P0 — POC sbx + ACP
  ├── P1 — Contrats génériques
  │     ├── P2 — Adaptateur Sandcastle
  │     └── P3 — Backend Docker Sandboxes
  │             ├── P4 — Agent ACP dans la microVM
  │             ├── P5 — Preview et promotion Git
  │             └── P6 — Cycle de vie et nettoyage
  ├── P7 — Configuration et migration
  ├── P8 — CLI et observabilité
  └── P9 — Tests de parité et sécurité
```

Travaux parallélisables :

- P2 et P3 après P1 ;
- P4 et P6 après le squelette de P3 ;
- P7 et P8 dès que les contrats de P1 sont figés ;
- P5 dépend du POC Git en mode clone ;
- la suppression de Sandcastle dépend de P9.

---

## P0 — POC bloquant `sbx`

### Emplacement conseillé

```text
experiments/docker-sandbox-poc/
```

Le POC ne doit pas modifier immédiatement le chemin de production.

### Prérequis à vérifier

- [ ] macOS Sonoma 14+ sur Apple silicon ;
- [ ] Windows 11 x86_64 avec Windows Hypervisor Platform ;
- [ ] Ubuntu 24.04+ avec KVM ;
- [ ] utilisateur Linux membre du groupe `kvm` ;
- [ ] binaire `sbx` installé ;
- [ ] utilisateur authentifié via `sbx login` ;
- [ ] secret du provider configuré ;
- [ ] politique réseau compatible avec OpenAI, Git et npm.

### Scénario obligatoire

- [ ] vérifier la version de `sbx` de manière non interactive ;
- [ ] créer un sandbox nommé de manière déterministe ;
- [ ] utiliser obligatoirement `--clone` ;
- [ ] lancer un agent ACP dans le sandbox via `sbx exec` ;
- [ ] ne pas utiliser de pseudo-terminal ;
- [ ] transporter ACP en NDJSON sur stdin/stdout ;
- [ ] créer une session avec `AcpRunner` ;
- [ ] recevoir les `session/update` en streaming ;
- [ ] modifier un fichier suivi ;
- [ ] créer un fichier non suivi ;
- [ ] supprimer et renommer des fichiers ;
- [ ] tester un fichier binaire ;
- [ ] vérifier que le workspace hôte reste inchangé ;
- [ ] calculer le preview ;
- [ ] récupérer un commit depuis le clone du sandbox ;
- [ ] tester une promotion ;
- [ ] tester un rejet ;
- [ ] tester une annulation pendant le prompt ;
- [ ] lancer deux sandboxes en parallèle sur le même dépôt ;
- [ ] supprimer les sandboxes et vérifier le nettoyage des remotes temporaires.

### Questions à trancher

- [ ] `sbx exec` préserve-t-il exactement le flux NDJSON ACP ?
- [ ] stdout est-il exempt de messages parasites ?
- [ ] l’annulation termine-t-elle réellement le processus agent ?
- [ ] le remote `sandbox-<name>` est-il créé et exploitable de façon stable ?
- [ ] la récupération des commits fonctionne-t-elle sur les trois OS ?
- [ ] quelles commandes proposent une sortie structurée stable ?
- [ ] comment distinguer sandbox absent, arrêté, actif ou incompatible ?
- [ ] comment lancer depuis un worktree secondaire tout en créant le clone depuis le checkout principal ?
- [ ] comment récupérer les changements avant `sbx rm` sans risque de perte ?

### Critères GO

- [ ] ACP fonctionne de bout en bout ;
- [ ] les chunks arrivent en temps réel ;
- [ ] le mode clone garantit l’absence d’écriture hôte ;
- [ ] les changements sont récupérables sans perte ;
- [ ] la promotion peut être atomique ;
- [ ] deux sandboxes sont réellement isolés ;
- [ ] annulation et nettoyage sont fiables ;
- [ ] aucun credential brut n’est copié dans le sandbox.

### Critères NO-GO

Conserver Sandcastle si :

- [ ] `sbx exec` ne peut pas transporter ACP proprement ;
- [ ] l’intégration impose de parser une interface interactive ;
- [ ] le mode clone ne permet pas une récupération automatisable ;
- [ ] la promotion nécessite une écriture hôte avant validation ;
- [ ] le cycle de vie n’est pas suffisamment contrôlable ;
- [ ] le parallélisme laisse des collisions ou des ressources impossibles à nettoyer.

---

## P1 — Créer un contrat générique de sandbox

### Nouveau workspace conseillé

```text
acp-sandbox
```

### Contrats proposés

```ts
export interface SandboxBackend {
  readonly kind: string;

  checkAvailability(): Promise<SandboxAvailability>;
  prepare(input: SandboxPrepareInput): Promise<SandboxSession>;
  clearLogs(workspaceCwd: string): Promise<void>;
}

export interface SandboxSession {
  readonly id: string;
  readonly backend: string;
  readonly processConfig: ProcessAgentConfig;

  preview(): Promise<SandboxPreview>;
  apply(): Promise<SandboxPromotionResult>;
  reject(): Promise<void>;
  dispose(): Promise<void>;
}

export interface SandboxPreview {
  diff: string;
  filesChanged: number;
  branch: string;
  baseRef: string;
  isolatedWorkspacePath?: string;
}

export type SandboxPromotionStatus =
  | "applied"
  | "no_changes"
  | "rejected"
  | "cancelled";
```

### Actions

- [ ] ajouter `acp-sandbox` aux npm workspaces ;
- [ ] créer les types génériques ;
- [ ] déplacer la politique de promotion dans le contrat générique ;
- [ ] remplacer dans `acp-workspace` :
  - `SandcastlePreview` par `SandboxPreview` ;
  - `SandcastlePromotionRequest` par `SandboxPromotionRequest` ;
  - `SandcastlePromotionDecision` par `SandboxPromotionDecision` ;
  - `finishSandcastleRun` par `finishSandboxRun` ;
- [ ] supprimer les appels d’extension Sandcastle de la couche supérieure ;
- [ ] appeler `preview`, `apply` et `reject` via `SandboxSession` ;
- [ ] permettre l’injection d’un backend fake dans les tests ;
- [ ] conserver des aliases dépréciés si des consommateurs externes existent.

### Critères d’acceptation

- [ ] `acp-pipeline` ne dépend d’aucun sandbox ;
- [ ] `acp-runtime` ne dépend d’aucun backend concret ;
- [ ] `acp-workspace` ne contient plus de protocole `sandcastle/*` ;
- [ ] les quatre statuts de promotion restent identiques ;
- [ ] les tests utilisent un contrat commun.

---

## P2 — Encapsuler Sandcastle comme backend historique

### Actions

- [ ] implémenter `SandcastleBackend` derrière `SandboxBackend` ;
- [ ] réutiliser le bridge existant ;
- [ ] conserver la promotion actuelle comme oracle de comportement ;
- [ ] conserver `transport: "sandcastle"` pendant la transition ;
- [ ] conserver `.acp/.sandcastle/config.json` pendant au moins une version de migration ;
- [ ] ajouter des tests de non-régression ;
- [ ] documenter ce backend comme historique, sans le supprimer immédiatement.

### Critères d’acceptation

- [ ] les pipelines existants fonctionnent sans modification ;
- [ ] tous les tests existants passent ;
- [ ] les statuts et messages de promotion restent identiques.

---

## P3 — Implémenter `DockerSandboxBackend`

### Modules conseillés

```text
acp-sandbox/src/docker/
├── DockerSandboxBackend.ts
├── DockerSandboxSession.ts
├── SbxCli.ts
├── SbxCommandRunner.ts
├── SbxAvailability.ts
├── SbxNaming.ts
├── SbxLifecycle.ts
├── DockerSandboxAgentProcess.ts
├── DockerSandboxGit.ts
├── DockerSandboxLogs.ts
└── errors.ts
```

### Actions

- [ ] centraliser tous les appels `sbx` dans `SbxCli` ;
- [ ] utiliser `spawn` ou `execFile`, jamais une chaîne shell concaténée ;
- [ ] transmettre les arguments sous forme de tableau ;
- [ ] séparer stdout, stderr, code de sortie et signal ;
- [ ] définir une version minimale de `sbx` ;
- [ ] ajouter des timeouts distincts pour :
  - disponibilité ;
  - création ;
  - démarrage ;
  - agent ACP ;
  - preview ;
  - promotion ;
  - arrêt ;
  - suppression ;
- [ ] produire des erreurs spécifiques :
  - binaire absent ;
  - version incompatible ;
  - utilisateur non connecté ;
  - hyperviseur/KVM absent ;
  - politique réseau bloquante ;
  - sandbox existant incompatible ;
  - création échouée ;
  - nettoyage échoué ;
- [ ] générer un nom sûr et déterministe :

```text
slopify-<repoHash>-<runId>-<nodeId>
```

- [ ] stocker le manifeste dans `.acp/runs/<runId>/sandboxes.json` ;
- [ ] interdire le mode direct pour `sideEffects: workspace` ;
- [ ] utiliser `--clone` ;
- [ ] limiter le nombre de microVM parallèles.

---

## P4 — Exécuter un agent ACP dans la microVM

### Stratégie initiale

Commencer par **Codex uniquement**.

Ne pas annoncer la parité Cursor, Pi ou Vibe avant validation d’un agent ACP fiable pour chaque provider.

### Actions

- [ ] créer un template ou kit Docker Sandbox versionné pour Slopify ;
- [ ] épingler Node.js, l’agent ACP, Git et les outils système ;
- [ ] tester `@zed-industries/codex-acp` ou l’agent ACP retenu ;
- [ ] lancer l’agent par `sbx exec` sans TTY ;
- [ ] réserver stdin/stdout au protocole ACP ;
- [ ] envoyer les logs techniques sur stderr ou dans des fichiers ;
- [ ] mapper modèle, effort, env, skills et instructions ;
- [ ] vérifier que le `cwd` ACP pointe vers le clone interne ;
- [ ] propager `AbortSignal` ;
- [ ] lors d’une annulation :
  1. envoyer `session/cancel` ;
  2. attendre un délai court ;
  3. terminer `sbx exec` ;
  4. nettoyer selon la politique ;
- [ ] conserver `PipelineAgentRunner` inchangé.

### Authentification

- [ ] utiliser les secrets Docker Sandboxes ;
- [ ] documenter `sbx secret set -g openai --oauth` ou la clé API ;
- [ ] ne plus copier `~/.codex/auth.json` pour ce backend ;
- [ ] ne jamais journaliser les secrets ;
- [ ] tester qu’aucun secret brut n’est volontairement injecté dans la microVM.

### Critères d’acceptation

- [ ] `AcpRunner` initialise l’agent normalement ;
- [ ] messages et tool calls remontent en temps réel ;
- [ ] une annulation ne laisse aucun agent actif ;
- [ ] l’agent peut installer des dépendances et utiliser son Docker Engine isolé.

---

## P5 — Implémenter preview et promotion Git atomique

### Stratégie recommandée

Utiliser une promotion basée sur un commit, pas uniquement `git diff | git apply`.

### Cycle dans le sandbox

1. enregistrer le SHA de base ;
2. créer une branche dédiée ;
3. laisser l’agent travailler ;
4. collecter les changements suivis et non suivis ;
5. créer un commit technique ;
6. exposer le SHA résultat ;
7. récupérer ce commit sur l’hôte ;
8. tester l’application dans un worktree d’intégration temporaire ;
9. appliquer seulement après validation complète.

### Branche candidate

```text
slopify/run/<runId>/<nodeId>
```

### Actions sandbox

- [ ] enregistrer `baseSha` avant le prompt ;
- [ ] collecter `git status --porcelain=v1 -z` ;
- [ ] collecter les diffs binary-safe ;
- [ ] inclure les fichiers non suivis ;
- [ ] détecter suppressions, renommages et changements de mode ;
- [ ] refuser les chemins hors dépôt et liens dangereux ;
- [ ] créer un commit avec auteur technique Slopify ;
- [ ] exposer `baseSha`, `resultSha`, branche et statistiques.

### Actions hôte

- [ ] vérifier que le HEAD attendu n’a pas changé ;
- [ ] détecter un workspace sale ;
- [ ] récupérer le commit depuis le remote du sandbox ;
- [ ] calculer le preview de `baseSha..resultSha` ;
- [ ] appliquer d’abord dans un worktree d’intégration ;
- [ ] exécuter les contrôles Git ;
- [ ] appliquer dans la cible uniquement après succès ;
- [ ] rollback complet en cas d’erreur ;
- [ ] produire une erreur structurée en cas de conflit ;
- [ ] sérialiser les promotions concurrentes.

### Cas de test obligatoires

- [ ] aucun changement ;
- [ ] modification texte ;
- [ ] fichier créé ;
- [ ] fichier supprimé ;
- [ ] renommage ;
- [ ] fichier binaire ;
- [ ] changement de permissions ;
- [ ] lien symbolique ;
- [ ] nom avec espaces ou Unicode ;
- [ ] workspace sale ;
- [ ] branche hôte avancée pendant le run ;
- [ ] conflit ;
- [ ] échec avant application ;
- [ ] échec pendant application ;
- [ ] rejet ;
- [ ] annulation ;
- [ ] deux promotions concurrentes.

### Critères d’acceptation

- [ ] réussite totale ou aucune mutation ;
- [ ] rejet et annulation ne modifient rien ;
- [ ] fichiers non suivis et binaires sont conservés ;
- [ ] les conflits sont visibles ;
- [ ] le sandbox n’est supprimé qu’après sécurisation du résultat à conserver.

---

## P6 — Cycle de vie, nettoyage et ressources

### Politique conseillée

- succès appliqué : suppression immédiate ;
- rejet : suppression immédiate ;
- annulation : suppression immédiate ;
- échec : conservation optionnelle pour diagnostic ;
- debug explicite : conservation avec TTL.

### Actions

- [ ] ajouter un TTL aux sandboxes conservés ;
- [ ] nettoyer les remotes Git temporaires ;
- [ ] nettoyer les manifestes terminés ;
- [ ] limiter les sandboxes simultanés ;
- [ ] détecter les sandboxes orphelins après crash ;
- [ ] rendre le nettoyage idempotent ;
- [ ] mesurer création, prompt, preview, promotion et suppression ;
- [ ] ne pas masquer l’erreur principale par une erreur de cleanup.

### Commandes cibles

```text
slopify sandbox list
slopify sandbox inspect <id>
slopify sandbox cleanup
slopify sandbox cleanup --older-than <duration>
```

---

## P7 — Configuration et compatibilité

### Configuration cible candidate

```json
{
  "agents": {
    "codex-docker": {
      "transport": "sandbox",
      "backend": "docker",
      "provider": "codex",
      "model": "gpt-5-codex",
      "effort": "high",
      "workspaceMode": "clone",
      "template": "slopify/codex-acp:1",
      "networkPolicy": "locked-down",
      "cleanup": "always",
      "skills": true
    }
  }
}
```

Le schéma exact doit être figé après le POC.

### Actions

- [ ] ajouter `transport: "sandbox"` ;
- [ ] ajouter temporairement `backend: "docker" | "sandcastle"` ;
- [ ] refuser `workspaceMode: "direct"` pour les implémentations ;
- [ ] continuer à lire `transport: "sandcastle"` avec avertissement ;
- [ ] continuer à lire `.acp/.sandcastle/config.json` pendant la transition ;
- [ ] proposer une migration automatique ou guidée ;
- [ ] valider strictement les clés inconnues ;
- [ ] documenter les domaines réseau nécessaires ;
- [ ] ajouter `slopify doctor`.

### `slopify doctor` doit vérifier

- [ ] Node.js ;
- [ ] Git ;
- [ ] présence et version de `sbx` ;
- [ ] connexion Docker ;
- [ ] hyperviseur ou KVM ;
- [ ] secrets provider ;
- [ ] politique réseau ;
- [ ] template requis ;
- [ ] capacité à créer un clone depuis le dépôt courant ;
- [ ] détection d’un worktree secondaire.

---

## P8 — CLI et observabilité du sandbox

### Événements conseillés

```text
sandbox.checking
sandbox.creating
sandbox.ready
agent.starting
agent.running
agent.cancelling
promotion.previewing
promotion.waiting
promotion.applying
promotion.applied
sandbox.cleaning
sandbox.retained
```

### Actions

- [ ] afficher backend, sandbox et nœud en mode verbose ;
- [ ] séparer message utilisateur et diagnostic technique ;
- [ ] conserver `--json` et `--jsonl` strictement machine-readable ;
- [ ] ne jamais envoyer de logs parasites sur stdout ACP ;
- [ ] afficher fichiers modifiés, branche, base SHA, result SHA et décision ;
- [ ] corréler les logs par `runId`, `nodeId` et `sandboxId` ;
- [ ] permettre de retrouver un sandbox conservé après échec.

---

## P9 — Tests de parité et de sécurité

### Tests unitaires

- [ ] faux exécutable `sbx` ;
- [ ] parsing des sorties ;
- [ ] erreurs et codes de sortie ;
- [ ] timeouts ;
- [ ] annulation ;
- [ ] génération des noms ;
- [ ] validation de configuration ;
- [ ] politique de nettoyage ;
- [ ] politique de promotion.

### Tests de contrat communs

Exécuter la même suite contre :

- [ ] `SandcastleBackend` ;
- [ ] `DockerSandboxBackend` ;
- [ ] backend fake en mémoire.

La suite couvre :

- [ ] préparation ;
- [ ] exécution ;
- [ ] preview ;
- [ ] apply ;
- [ ] reject ;
- [ ] cancel ;
- [ ] dispose ;
- [ ] cleanup idempotent.

### Tests d’intégration

Les runners GitHub standards peuvent ne pas disposer de la virtualisation requise.

- [ ] exécuter les tests unitaires sur runners standards ;
- [ ] utiliser un runner self-hosted pour les tests réels `sbx` ;
- [ ] tester macOS Apple silicon ;
- [ ] tester Windows 11 x86_64 ;
- [ ] tester Ubuntu 24.04 x86_64 avec KVM ;
- [ ] ajouter arm64 Linux uniquement si officiellement ciblé.

### Matrice de parité

| Capacité | Sandcastle | Docker Sandboxes | Obligatoire avant bascule |
|---|---:|---:|---:|
| Isolation du workspace | Oui | Oui avec `--clone` | Oui |
| Agent ACP | Oui via bridge | À valider via `sbx exec` | Oui |
| Streaming | Oui | À valider | Oui |
| Permissions autonomes | Oui | Oui dans la microVM | Oui |
| Preview Git | Oui | À implémenter | Oui |
| Promotion atomique | Oui | À implémenter | Oui |
| Rejet sans mutation | Oui | À valider | Oui |
| Annulation | Oui | À valider | Oui |
| Parallélisme | Oui | Oui, coût microVM | Oui |
| Credentials isolés | Montage local | Proxy/secrets hôte | Oui |
| Docker isolé | Selon image | Daemon privé | Souhaité |
| Codex | Oui | ACP à valider | Oui |
| Cursor | Oui | ACP à étudier | Non pour v1 |
| Pi | Oui | À étudier | Non pour v1 |
| Vibe | Oui | À étudier | Non pour v1 |

---

## Sécurité réseau Docker Sandboxes

- [ ] ne pas sélectionner automatiquement une politique ouverte ;
- [ ] recommander `Locked Down` pour les contextes sensibles ;
- [ ] autoriser uniquement les domaines nécessaires ;
- [ ] documenter les accès observés pendant les tests ;
- [ ] diagnostiquer clairement un provider ou npm bloqué ;
- [ ] ne pas contourner les règles avec du raw TCP ;
- [ ] ne pas supposer l’accès au `localhost` hôte ;
- [ ] publier explicitement les ports nécessaires aux serveurs de développement.

---

## Stratégie de déploiement M4

### Étape A — Expérimental

- activation explicite ;
- Codex uniquement ;
- Sandcastle reste le défaut ;
- conservation des sandboxes en cas d’échec possible.

### Étape B — Bêta

- Docker proposé par `slopify doctor` lorsque les prérequis sont satisfaits ;
- comparaison des résultats, performances et erreurs ;
- logs et mesures sans secrets.

### Étape C — Défaut Codex

- Docker devient le backend conseillé pour Codex ;
- Sandcastle reste un fallback.

### Étape D — Dépréciation

- avertissement sur `transport: "sandcastle"` ;
- outil de migration ;
- documentation de rollback.

### Étape E — Suppression

Supprimer `@acp-client/sandcastle` uniquement lorsque :

- [ ] tous les usages maintenus ont une alternative ;
- [ ] la promotion est validée sur les OS supportés ;
- [ ] concurrence et sécurité sont stables ;
- [ ] une version de transition a été publiée ;
- [ ] aucun consommateur externe connu ne dépend encore des exports.

### Définition de terminé M4

- [ ] `@ai-hero/sandcastle` n’est plus une dépendance ;
- [ ] `acp-pipeline` et `acp-runtime` restent indépendants ;
- [ ] Codex fonctionne via ACP dans Docker Sandboxes ;
- [ ] le streaming CLI est conservé ;
- [ ] aucune écriture hôte avant promotion ;
- [ ] promotion atomique ;
- [ ] rejet et annulation sans mutation ;
- [ ] sandboxes parallèles isolés ;
- [ ] credentials bruts non copiés ;
- [ ] ressources nettoyées ou conservées explicitement ;
- [ ] `slopify doctor` diagnostique les prérequis ;
- [ ] documentation et dépannage à jour ;
- [ ] tests unitaires, contractuels et d’intégration validés.

---

## M5 — Durcir la sécurité, les tests et la résilience

**Priorité : continue**

### Actions

- [ ] tester les chemins sortant du workspace ;
- [ ] tester les liens symboliques ;
- [ ] filtrer les variables sensibles ;
- [ ] tester les écritures concurrentes ;
- [ ] tester un échec pendant promotion ;
- [ ] tester une annulation pendant application ;
- [ ] nettoyer les sandboxes abandonnés ;
- [ ] reprendre après crash ;
- [ ] garantir l’absence de mutation partielle ;
- [ ] renforcer les tests DAG :
  - racines parallèles ;
  - diamant ;
  - cycle ;
  - deadlock ;
  - retry d’un nœud ;
  - annulation concurrente ;
  - pause avec nœuds actifs ;
  - reprise ;
  - branche indépendante en échec ;
  - ordre déterministe des artefacts ;
- [ ] conserver un dossier de logs par run ;
- [ ] ajouter une politique de rétention ;
- [ ] filtrer les secrets dans logs et erreurs.

### Critères d’acceptation

- [ ] un nouveau run ne supprime pas les logs précédents ;
- [ ] la rétention est configurable ;
- [ ] les secrets connus sont filtrés ;
- [ ] les tests de promotion atomique couvrent les scénarios principaux.

---

## M6 — Améliorer l’expérience développeur

**Priorité : moyenne**

### Commandes cibles

```text
slopify init
slopify validate
slopify validate --pipeline <name>
slopify graph <pipeline>
slopify doctor
```

### Actions

- [ ] initialiser `.acp/acp-agents.json` ;
- [ ] créer `.acp/pipelines/` ;
- [ ] créer `.agents/skills/` ;
- [ ] générer un pipeline d’exemple ;
- [ ] produire un graphe texte, Mermaid ou JSON ;
- [ ] afficher l’ordre topologique ;
- [ ] afficher les groupes parallélisables ;
- [ ] fournir des exemples :
  - planification ;
  - interview ;
  - approbation ;
  - ticket graph ;
  - implémentation parallèle ;
  - intégration ;
  - vérification ;
  - agent natif ;
  - agent sandboxé ;
  - promotion manuelle et automatique ;
- [ ] définir stratégie de versions et publication des packages.

---

# Priorités par workspace

## `@acp-client/pipeline`

1. migration ESM complète ;
2. validation de `acp.ticket-graph/v1` ;
3. limites de concurrence ;
4. politiques d’échec ;
5. sous-DAG dynamique ;
6. persistance et reprise concurrente ;
7. schéma versionné des événements ;
8. déterminisme de l’intégration.

## `@acp-client/runtime`

1. remontée complète des événements ACP ;
2. séparation processus agent / environnement ;
3. connecteur ou processus compatible Docker Sandboxes ;
4. reprise après arrêt de processus ;
5. filtrage des secrets ;
6. couverture timeouts et annulations ;
7. contrat stable pour connecteurs natifs et sandboxés.

## `@acp-client/sandcastle`

1. devenir un adaptateur du contrat générique ;
2. conserver la promotion atomique ;
3. servir d’oracle de comportement pendant la migration ;
4. rester disponible pour les providers non migrés ;
5. être supprimé uniquement après la période de transition.

## `@acp-client/sandbox` à créer

1. contrats génériques ;
2. politiques de promotion ;
3. backend Docker Sandboxes ;
4. gestion du cycle de vie ;
5. preview et promotion Git ;
6. diagnostics et nettoyage ;
7. tests de conformité communs.

## `@acp-client/workspace`

1. brancher le store persistant ;
2. remplacer le delivery séquentiel par un DAG ;
3. sélectionner le backend par configuration ;
4. ne plus connaître les méthodes d’extension Sandcastle ;
5. exposer l’inspection des runs et artefacts ;
6. séparer politiques workspace, runtime et sandbox ;
7. valider la configuration avant lancement.

## `slopify`

1. afficher les messages en temps réel ;
2. proposer JSONL ;
3. gérer les agents simultanés ;
4. ajouter `runs`, `resume`, `inspect`, `logs`, `artifacts` ;
5. ajouter les commandes `sandbox` ;
6. ajouter `doctor` ;
7. conserver les logs historiques ;
8. ajouter `init`, `validate`, `graph` ;
9. préparer une TUI optionnelle.

---

# Ordre global d’implémentation

## Phase 1 — Fondations

- M0 : ESM, versions, documentation et CI ;
- schéma stable des événements ;
- logs par run.

## Phase 2 — Visibilité et reprise

- M1 : streaming des sorties ;
- M2 : persistance et reprise ;
- inspection des artefacts et diagnostics.

## Phase 3 — Parallélisme

- validation du ticket graph ;
- sous-DAG ou orchestrateur concurrent ;
- un environnement par ticket ;
- contrôle de concurrence ;
- intégration ;
- vérification finale.

## Phase 4 — Sandboxing interchangeable

- POC Docker Sandboxes ;
- contrat générique ;
- adaptateur Sandcastle ;
- backend Docker Codex ;
- preview et promotion ;
- tests de conformité.

## Phase 5 — Industrialisation

- sécurité et résilience ;
- commandes développeur ;
- exemples ;
- stratégie de versions ;
- dépréciation progressive de Sandcastle.

---

# Risques principaux

## Promotion concurrente

Plusieurs agents ne doivent jamais promouvoir vers le même workspace en parallèle.

Réponse : promotion sérialisée ou étape d’intégration dédiée.

## Conflits entre tickets

Le ticket graph doit signaler les zones communes et risques de conflit avant exécution.

## Reprise non idempotente

Les commits, promotions et actions externes doivent avoir des identifiants empêchant une double application.

## Volume des événements

L’affichage, la persistance et la sortie machine doivent être séparés pour ne pas ralentir le runtime.

## Couplage au fournisseur de sandbox

Les couches supérieures ne doivent connaître ni les méthodes `sandcastle/*`, ni les détails de `sbx`.

## Flux ACP via `sbx exec`

Le remplacement est bloqué si stdout ou stdin ne permettent pas un protocole NDJSON fiable.

## Mode clone et worktrees

Docker Sandboxes refuse le mode clone depuis un worktree secondaire. Slopify doit résoudre le checkout principal et transmettre explicitement la référence cible.

## Ressources microVM

Une limite de concurrence, un TTL et un nettoyage automatique sont obligatoires.

## Parité providers

Codex doit être migré en premier. Sandcastle reste disponible tant que Cursor, Pi ou Vibe n’ont pas de chemin ACP fiable.

---

# Indicateurs de réussite

Le projet atteint son objectif principal lorsque :

- [ ] un utilisateur lance un pipeline depuis le terminal ;
- [ ] un agent produit une spécification ;
- [ ] un agent produit un graphe de tickets ;
- [ ] les tickets indépendants s’exécutent en parallèle ;
- [ ] chaque ticket travaille dans un sandbox distinct ;
- [ ] les messages et statuts sont visibles en temps réel ;
- [ ] les résultats sont intégrés dans une branche dédiée ;
- [ ] une vérification complète est exécutée ;
- [ ] les modifications ne rejoignent le workspace qu’après promotion ;
- [ ] la promotion est atomique ;
- [ ] le run peut être inspecté et repris ;
- [ ] toutes les étapes, décisions, artefacts et erreurs sont traçables ;
- [ ] Docker Sandboxes peut remplacer Sandcastle sans modifier le moteur de DAG.

---

# Références Docker Sandboxes

- Get started : https://docs.docker.com/ai/sandboxes/get-started/
- Usage et mode clone : https://docs.docker.com/ai/sandboxes/usage/
- Architecture : https://docs.docker.com/ai/sandboxes/architecture/
- Security model : https://docs.docker.com/ai/sandboxes/security/
- Codex : https://docs.docker.com/ai/sandboxes/agents/codex/
