# Roadmap Slopify

> Dernière mise à jour : 24 juillet 2026

## Vision

Slopify doit devenir un moteur de workflows de développement multi-agents, autonome et observable, capable de :

- compiler et exécuter des pipelines ACP v3 sous forme de DAG ;
- déléguer chaque nœud à un agent ACP natif ou isolé ;
- faire circuler des artefacts structurés et validés entre les agents ;
- exécuter en parallèle les tâches indépendantes ;
- isoler chaque implémentation dans un environnement jetable ;
- conserver un contrôle humain explicite aux étapes sensibles ;
- reprendre un run interrompu sans perdre son état ;
- exposer dans la CLI les actions, messages, réflexions et résultats des agents.

Le socle actuel est déjà bien découpé :

- `@acp-client/pipeline` compile et exécute les DAG ;
- `@acp-client/runtime` porte le protocole et les processus ACP ;
- `@acp-client/sandcastle` porte l’isolation et la promotion ;
- `@acp-client/workspace` charge et compose la configuration du projet ;
- `slopify` adapte le moteur au terminal.

Cette roadmap vise principalement à consolider cette architecture, puis à rendre les workflows multi-agents réellement parallèles, persistants et observables.

---

## Principes directeurs

### 1. Le moteur de pipeline reste indépendant des hôtes

`@acp-client/pipeline` ne doit pas dépendre :

- du terminal ;
- de VS Code ;
- d’un fournisseur d’agents ;
- de Sandcastle ;
- de Docker ;
- du format de stockage concret des runs.

Toutes ces responsabilités doivent rester injectées par des adaptateurs.

### 2. Les artefacts sont les contrats entre agents

Les échanges entre nœuds doivent privilégier des artefacts typés plutôt que des chaînes de texte implicites.

Les contrats existants constituent la base du workflow cible :

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

La CLI ne doit pas réimplémenter l’orchestration. Elle doit traduire proprement :

- les événements runtime ;
- les interactions humaines ;
- les messages et réflexions des agents ;
- les artefacts produits ;
- les erreurs et diagnostics ;
- les opérations de reprise et d’annulation.

---

# Jalons prioritaires

## M0 — Stabiliser le dépôt et les contrats

**Priorité : immédiate**

### Objectifs

- supprimer les incohérences de documentation et d’outillage ;
- homogénéiser le monorepo ;
- rendre les conventions explicites avant d’ajouter de nouvelles capacités.

### Travaux

#### Harmoniser le système de modules

Le monorepo utilise actuellement un mélange de CommonJS et d’ESM.

Actions :

- migrer `@acp-client/pipeline` vers ESM ;
- ajouter `"type": "module"` à son `package.json` ;
- passer son `tsconfig.json` à `module: NodeNext` et `moduleResolution: NodeNext` ;
- garantir la compatibilité des imports internes avec les extensions `.js` ;
- vérifier les exports publics des cinq workspaces ;
- supprimer les entrées `require` trompeuses si les packages ne fournissent plus réellement de build CommonJS ;
- documenter clairement la politique ESM du monorepo.

Critères d’acceptation :

- tous les packages utilisent la même stratégie ESM ;
- `npm run build` réussit à la racine ;
- `npm test` réussit à la racine ;
- aucun consommateur interne n’utilise `require()` pour charger un workspace ESM.

#### Aligner les versions TypeScript et Node

Actions :

- utiliser une version unique de TypeScript dans tous les workspaces ;
- utiliser une version cohérente de `@types/node` ;
- centraliser autant que possible les options TypeScript communes ;
- conserver Node.js `>=22.19.0` comme prérequis global tant qu’une autre cible n’est pas décidée.

Critères d’acceptation :

- une seule version de TypeScript apparaît dans le lockfile pour les workspaces du projet ;
- les configurations TypeScript ne divergent que pour des raisons documentées.

#### Synchroniser la documentation avec le contrat v3

Actions :

- remplacer les références à `promptFile` par `instructionsFile` dans la documentation ;
- conserver `promptFile` uniquement comme alias de migration documenté ;
- ajouter un exemple complet de pipeline v3 ;
- documenter les politiques, retries, inputs, outputs, pauses et interactions ;
- expliquer clairement la différence entre tâche, instructions et skills.

Critères d’acceptation :

- aucun exemple récent ne recommande `promptFile` ;
- le README racine renvoie vers cette roadmap ;
- chaque workspace possède une description exacte de ses responsabilités.

#### Ajouter une intégration continue minimale

Actions :

- ajouter un workflow GitHub Actions ;
- installer les dépendances avec `npm ci` ;
- exécuter le build complet ;
- exécuter tous les tests ;
- vérifier les versions minimales de Node supportées ;
- publier les résultats de test en cas d’échec.

Critères d’acceptation :

- chaque pull request est validée automatiquement ;
- aucun merge ne doit pouvoir masquer un échec de build ou de test.

---

## M1 — Rendre les agents observables dans la CLI

**Priorité : haute**

### Constat

Les notifications ACP remontent déjà jusqu’au host. La CLI détecte notamment :

- `agent_thought_chunk` ;
- `agent_message_chunk` ;
- les changements de statut ;
- les débuts et fins de nœuds ;
- les erreurs.

Cependant, l’interface affiche principalement qu’un agent « réfléchit » ou « répond » sans projeter le contenu reçu.

### Objectifs

- afficher en temps réel ce que chaque agent produit ;
- rester lisible lorsque plusieurs agents travaillent en parallèle ;
- proposer une sortie humaine et une sortie machine stable.

### Travaux

#### Afficher les chunks ACP

Actions :

- afficher le contenu des `agent_message_chunk` ;
- rendre l’affichage des `agent_thought_chunk` configurable ;
- associer chaque sortie au `runId`, au `nodeId`, au rôle et au nom de l’agent ;
- fusionner correctement les chunks successifs ;
- éviter de répéter les préfixes pour chaque fragment de texte.

#### Introduire des niveaux d’affichage

Proposition :

- mode normal : étapes, interactions et résultats ;
- `--verbose` : statuts, appels importants et diagnostics ;
- `--trace` : événements complets, chunks et métadonnées ;
- `--show-thoughts` : affichage explicite des réflexions lorsque le fournisseur les expose ;
- `--json` ou `--jsonl` : événements structurés consommables par une autre interface.

#### Gérer le parallélisme visuel

Actions :

- préfixer chaque ligne avec un identifiant court du nœud ;
- conserver un buffer par nœud ;
- ne jamais mélanger deux chunks sur une même ligne ;
- permettre un mode compact et un mode détaillé ;
- préparer une future interface TUI sans coupler le runtime à cette TUI.

#### Améliorer les commandes de diagnostic

Commandes candidates :

```text
slopify runs
slopify inspect <run-id>
slopify logs <run-id>
slopify logs <run-id> --node <node-id>
slopify artifacts <run-id>
```

Critères d’acceptation :

- le contenu des messages d’agents est visible pendant un run ;
- deux agents parallèles restent distinguables ;
- la sortie JSONL contient un événement par ligne avec un schéma documenté ;
- les logs d’un nœud peuvent être consultés sans lire manuellement les fichiers JSONL.

---

## M2 — Persister et reprendre les runs

**Priorité : haute**

### Constat

Le moteur possède déjà :

- `InMemoryPipelineRunStore` ;
- `FilePipelineRunStore` ;
- des snapshots JSON ;
- des événements NDJSON ;
- `listResumable()` ;
- des helpers de stockage dans `.acp/runs-v3`.

La CLI instancie néanmoins le runtime sans store persistant.

### Objectifs

- reprendre un run après fermeture de la CLI ;
- inspecter les runs historiques ;
- éviter la perte d’une pause, d’une interview ou d’un diagnostic.

### Travaux

#### Brancher `FilePipelineRunStore` dans la CLI

Actions :

- injecter `workspacePipelineRunStore(workspaceCwd)` dans `PipelineRuntime` ;
- restaurer les programmes nécessaires à la reprise ;
- reconstruire les sessions uniquement lorsque cela est possible ;
- distinguer les runs réellement reprenables des runs seulement inspectables.

#### Ajouter des commandes de cycle de vie

Commandes candidates :

```text
slopify runs --resumable
slopify resume <run-id>
slopify cancel <run-id>
slopify inspect <run-id>
slopify clean-runs
```

#### Définir la sémantique de reprise

La documentation doit préciser :

- ce qui est rejoué ;
- ce qui est restauré ;
- ce qui ne peut pas être repris après l’arrêt d’un processus agent ;
- comment sont traités les nœuds en statut `running` au redémarrage ;
- comment éviter de rejouer deux fois une promotion déjà appliquée.

Critères d’acceptation :

- un run interrompu sur une pause peut être repris après redémarrage de la CLI ;
- les artefacts déjà produits sont conservés ;
- les nœuds terminés ne sont pas exécutés une seconde fois ;
- une promotion appliquée ne peut pas être rejouée accidentellement ;
- les erreurs de reprise sont explicites et diagnostiquées.

---

## M3 — Exécuter les tickets en parallèle sous forme de DAG

**Priorité : très haute**

### Constat

Le moteur `PipelineRuntime` sait déjà démarrer en parallèle tous les nœuds dont les dépendances sont satisfaites.

En revanche, le workflow de livraison actuel exécute les tickets de manière séquentielle dans une boucle, puis lance la revue finale.

### Objectif cible

Transformer la livraison en un graphe dynamique :

```text
                    ┌─ ticket-A ─┐
specification ──────┼─ ticket-B ─┼─ intégration ─ vérification
                    └─ ticket-C ─┘
```

Les tickets qui ne dépendent pas les uns des autres doivent être exécutés simultanément, chacun dans son propre environnement isolé.

### Travaux

#### Enrichir `acp.ticket-graph/v1`

Le contrat doit représenter explicitement :

- l’identifiant du ticket ;
- son périmètre ;
- ses dépendances ;
- les fichiers ou modules concernés ;
- ses critères de validation ;
- l’agent conseillé ;
- les risques de conflit avec les autres tickets.

Actions :

- valider que toutes les dépendances référencent un ticket existant ;
- détecter les cycles ;
- détecter les identifiants dupliqués ;
- produire un ordre topologique stable ;
- identifier les groupes parallélisables.

#### Remplacer `sequential-delivery`

Options d’architecture à étudier :

1. compiler dynamiquement le graphe de tickets en `CompiledPipelineProgram` ;
2. créer un orchestrateur de sous-runs concurrents ;
3. introduire un type de nœud dynamique capable de développer un artefact en sous-DAG.

La solution retenue doit préserver :

- la persistance ;
- les événements runtime ;
- l’annulation ;
- les retries ;
- les artefacts typés ;
- les interactions humaines ;
- la capacité à limiter la concurrence.

#### Un worktree isolé par ticket

Chaque ticket d’implémentation doit avoir :

- un worktree ou sandbox distinct ;
- une branche dédiée ;
- un résultat `acp.implementation-result/v1` ;
- la liste de ses commits ;
- ses validations locales ;
- un diff consultable avant intégration.

#### Ajouter un contrôle de concurrence

Configuration candidate :

```yaml
execution:
  maxParallelNodes: 4
  maxParallelImplementations: 3
  failurePolicy: fail-fast
```

Politiques à prévoir :

- `fail-fast` : annuler les travaux restants au premier échec bloquant ;
- `continue-independent` : poursuivre les branches indépendantes ;
- `collect-all` : terminer tous les nœuds possibles avant de produire le diagnostic global.

#### Introduire une étape d’intégration explicite

L’intégrateur doit :

- recevoir tous les `implementation-result` ;
- appliquer ou fusionner les branches dans un ordre déterministe ;
- détecter les conflits ;
- produire `acp.merge-result/v1` ;
- ne jamais modifier partiellement la branche d’intégration en cas d’échec ;
- permettre une reprise ou une intervention humaine lorsque nécessaire.

#### Vérifier le résultat intégré

Le vérificateur doit produire `acp.verification-report/v1` avec au minimum :

- build ;
- tests unitaires ;
- tests d’intégration ;
- lint ou analyse statique ;
- conformité à la spécification ;
- vérification des non-objectifs ;
- contrôle des modifications inattendues.

Critères d’acceptation :

- deux tickets indépendants s’exécutent réellement en parallèle ;
- deux tickets dépendants s’exécutent dans le bon ordre ;
- chaque ticket possède son propre environnement isolé ;
- un échec n’entraîne pas de mutation partielle du workspace principal ;
- les résultats d’implémentation sont intégrés de manière déterministe ;
- la vérification finale porte sur la branche intégrée, pas sur les worktrees individuels.

---

## M4 — Abstraire le fournisseur de sandbox

**Priorité : haute après M3**

### Objectifs

- ne pas coupler la sécurité du projet à une seule bibliothèque ;
- pouvoir comparer Sandcastle avec Docker AI Sandboxes ;
- conserver un contrat commun de preview, promotion, rejet et nettoyage.

### Travaux

#### Introduire une interface de sandbox générique

Interface conceptuelle :

```ts
interface SandboxProvider {
  create(input: SandboxCreateInput): Promise<SandboxSession>;
  execute(session: SandboxSession, input: AgentExecutionInput): Promise<AgentExecutionResult>;
  preview(session: SandboxSession): Promise<SandboxPreview>;
  apply(session: SandboxSession): Promise<SandboxApplyResult>;
  reject(session: SandboxSession): Promise<void>;
  dispose(session: SandboxSession): Promise<void>;
}
```

Le contrat ne doit pas exposer des détails propres à Sandcastle.

#### Séparer le bridge ACP du cycle de vie du sandbox

Aujourd’hui, le transport Sandcastle et le sandbox sont étroitement liés.

Actions :

- isoler la création du processus ACP ;
- isoler la création de l’environnement ;
- isoler les mécanismes de preview et promotion ;
- permettre à un même agent ACP de fonctionner avec plusieurs fournisseurs de sandbox.

#### Évaluer Docker AI Sandboxes

Créer une matrice de comparaison couvrant :

- isolation filesystem ;
- isolation réseau ;
- gestion des secrets ;
- montage ou copie du workspace ;
- création de branches et worktrees ;
- récupération du diff ;
- application atomique ;
- nettoyage ;
- compatibilité macOS, Linux et Windows ;
- performances de démarrage ;
- parallélisme ;
- observabilité ;
- stabilité de l’API ;
- dépendance à Docker Desktop.

Critères d’acceptation :

- `@acp-client/workspace` sélectionne un fournisseur via configuration ;
- Sandcastle continue de fonctionner via l’interface générique ;
- un second fournisseur peut être ajouté sans modifier `@acp-client/pipeline` ;
- les mêmes tests de promotion sont exécutés contre chaque fournisseur.

---

## M5 — Durcir la sécurité, les tests et la résilience

**Priorité : continue**

### Tests de sécurité

Ajouter des tests couvrant :

- les chemins sortant du workspace ;
- les liens symboliques ;
- les variables d’environnement interdites ;
- les écritures concurrentes ;
- l’échec pendant une promotion ;
- l’annulation pendant une application ;
- le nettoyage d’un sandbox abandonné ;
- le redémarrage après un crash ;
- l’absence de mutation partielle.

### Tests du moteur DAG

Ajouter ou renforcer les cas suivants :

- parallélisme de plusieurs racines ;
- dépendances en diamant ;
- détection de cycle ;
- deadlock ;
- retry d’un seul nœud ;
- annulation d’un batch concurrent ;
- pause alors que d’autres nœuds sont actifs ;
- reprise après pause ;
- échec d’une branche indépendante ;
- ordre déterministe des artefacts finaux.

### Tests d’intégration réels

Créer des fixtures exécutant :

- un agent ACP factice ;
- un pipeline complet ;
- plusieurs nœuds parallèles ;
- une promotion ;
- une reprise depuis disque ;
- une vérification finale.

### Gestion des logs

Le dossier `.acp/logs` ne doit plus être supprimé systématiquement au démarrage d’un run.

Actions :

- conserver un répertoire par run ;
- ajouter une politique de rétention ;
- ajouter une commande de nettoyage ;
- distinguer logs runtime, logs agent et artefacts ;
- éviter toute fuite de secrets dans les logs.

Critères d’acceptation :

- un nouveau run ne supprime pas les logs précédents ;
- la politique de rétention est configurable ;
- les secrets connus sont filtrés ;
- les tests de promotion atomique couvrent les principaux scénarios d’échec.

---

## M6 — Améliorer l’expérience développeur

**Priorité : moyenne**

### Initialisation de projet

Commande candidate :

```text
slopify init
```

Elle pourrait créer :

- `.acp/acp-agents.json` ;
- `.acp/.sandcastle/config.json` ;
- `.acp/pipelines/` ;
- `.agents/skills/` ;
- un pipeline d’exemple minimal.

### Validation de configuration

Commandes candidates :

```text
slopify validate
slopify validate --pipeline <name>
slopify graph <pipeline>
```

La commande `graph` pourrait produire :

- un résumé texte ;
- du Mermaid ;
- du JSON ;
- l’ordre topologique ;
- les groupes exécutables en parallèle.

### Exemples officiels

Ajouter des exemples pour :

- planification simple ;
- interview puis approbation ;
- spécification puis tickets ;
- implémentation parallèle ;
- intégration et vérification ;
- agent ACP natif ;
- agent sandboxé ;
- promotion manuelle et automatique.

### Publication

Décider quels packages doivent rester privés et lesquels doivent être publiés.

Avant publication :

- définir une stratégie de versionnement ;
- ajouter des changelogs ;
- stabiliser les exports publics ;
- documenter la compatibilité Node ;
- éviter les dépendances `file:` dans les artefacts publiés.

---

# Roadmap par workspace

## `@acp-client/pipeline`

Priorités :

1. migration ESM complète ;
2. validation renforcée de `acp.ticket-graph/v1` ;
3. support explicite des limites de concurrence ;
4. politiques d’échec pour les branches parallèles ;
5. génération ou expansion dynamique d’un sous-DAG ;
6. persistance et reprise testées avec des runs concurrents ;
7. schéma versionné des événements runtime ;
8. déterminisme des résultats et de l’ordre d’intégration.

## `@acp-client/runtime`

Priorités :

1. meilleure remontée des événements ACP ;
2. séparation claire entre processus agent et environnement d’exécution ;
3. reprise robuste après arrêt de processus ;
4. filtrage des secrets dans logs et erreurs ;
5. couverture des timeouts, annulations et sorties anormales ;
6. contrat stable pour les connecteurs natifs et sandboxés.

## `@acp-client/sandcastle`

Priorités :

1. implémenter l’interface générique de sandbox ;
2. conserver la promotion atomique comme invariant ;
3. documenter précisément le cycle de vie d’un worktree ;
4. tester plusieurs sessions concurrentes ;
5. fournir des diagnostics exploitables en cas d’échec provider ;
6. préparer la comparaison avec Docker AI Sandboxes.

## `@acp-client/workspace`

Priorités :

1. brancher le store persistant ;
2. remplacer le delivery séquentiel par un workflow DAG ;
3. sélectionner le fournisseur de sandbox par configuration ;
4. exposer une API d’inspection des runs et artefacts ;
5. séparer clairement politiques workspace, runtime et sandbox ;
6. valider les configurations avant lancement.

## `slopify`

Priorités :

1. afficher les messages des agents en temps réel ;
2. proposer un mode JSONL stable ;
3. gérer proprement plusieurs agents simultanés ;
4. ajouter les commandes `runs`, `resume`, `inspect`, `logs` et `artifacts` ;
5. conserver les logs historiques ;
6. ajouter `init`, `validate` et `graph` ;
7. préparer une TUI optionnelle sans déplacer la logique métier dans la CLI.

---

# Ordre d’implémentation recommandé

## Phase 1 — Fondations

- M0 : ESM, versions, documentation et CI ;
- schéma stable des événements ;
- conservation des logs par run.

## Phase 2 — Visibilité et reprise

- M1 : streaming des sorties agents ;
- M2 : persistance et commandes de reprise ;
- inspection des artefacts et diagnostics.

## Phase 3 — Parallélisme multi-worktrees

- validation complète du ticket graph ;
- compilation dynamique ou orchestration concurrente ;
- un sandbox par ticket ;
- contrôle de concurrence ;
- intégration puis vérification finale.

## Phase 4 — Sandboxing interchangeable

- interface générique ;
- adaptation Sandcastle ;
- prototype Docker AI Sandboxes ;
- tests de conformité communs.

## Phase 5 — Industrialisation

- tests de résilience ;
- commandes d’initialisation et validation ;
- exemples ;
- versionnement et publication éventuelle.

---

# Risques principaux

## Promotion concurrente

Plusieurs agents ne doivent jamais promouvoir directement leurs modifications vers le même workspace en parallèle.

La promotion doit être sérialisée ou remplacée par une étape d’intégration dédiée.

## Conflits entre tickets

Le découpage en tickets doit minimiser les zones de fichiers communes. Le ticket graph doit pouvoir signaler les risques de conflit avant exécution.

## Reprise non idempotente

Les actions externes, commits et promotions doivent posséder des identifiants et des marqueurs permettant d’éviter une double application après redémarrage.

## Volume des événements

Le streaming de plusieurs agents peut produire beaucoup de données. La CLI doit distinguer affichage, persistance et sortie machine sans ralentir le runtime.

## Couplage au fournisseur de sandbox

Les concepts de branche, worktree, preview et apply ne doivent pas être codés uniquement sous forme de méthodes d’extension Sandcastle dans les couches supérieures.

---

# Indicateurs de réussite

Le projet pourra être considéré comme ayant atteint son objectif principal lorsque :

- un utilisateur lance un pipeline depuis un terminal ;
- un agent produit une spécification ;
- un agent transforme cette spécification en graphe de tickets ;
- les tickets indépendants sont exécutés en parallèle ;
- chaque ticket travaille dans un sandbox distinct ;
- les messages et statuts sont visibles en temps réel ;
- les résultats sont intégrés dans une branche dédiée ;
- une vérification complète est exécutée ;
- les modifications ne rejoignent le workspace principal qu’après promotion ;
- le run peut être inspecté et repris après redémarrage de la CLI ;
- toutes les étapes, décisions, artefacts et erreurs restent traçables.
