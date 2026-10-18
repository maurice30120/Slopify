# Cahier des charges — Slopify POC : contrôleur IA et réconciliation des tickets

Statut : **spécification de travail validée en discussion** (18 octobre 2026).  
Branche de référence : **feature/implementation-task-orchestrator** (PR #73).  
Nature : **évolution minimale de la V2 existante**, sans réécriture du moteur.

## 1. Objectif

Faire évoluer Slopify, factory d'agents IA, vers une exécution des tickets inspirée de la **réconciliation Kubernetes** : le résultat souhaité est défini à l'avance, le système observe l'état réel, décide de la prochaine intervention puis converge vers le résultat attendu.

**Principe impératif : réutiliser au maximum le code de la V2**. Le POC doit prouver le comportement avec le moins de modifications possible. Les notions de contrôleur, scheduler et worker désignent des responsabilités logiques dans le monolithe TypeScript, **pas des microservices ni des processus permanents distincts**.

La préparation des demandes est totalement **hors périmètre**. Le workflow existant est conservé :

**grill-with-docs → doc / décisions → to-spec → to-tickets → Slopify**.

Slopify reçoit les tickets déjà cadrés, leurs critères d'acceptation et leurs dépendances explicites. Il ne les redécoupe pas et ne modifie pas leurs objectifs métier.

## 2. Socle existant à conserver

Lecture de la branche V2 au 18 octobre 2026 :

| Existant | Décision POC |
| --- | --- |
| Entrée JSON (specFile, tasks, dependsOn, agent, source) | **Conserver** ; enrichir seulement si indispensable |
| TaskBatchService, graphe de dépendances, sélection des tickets prêts | **Réutiliser** |
| Exécution par vagues de 10 tickets au maximum | **Conserver pour le POC**, malgré l'inoccupation temporaire possible |
| DockerTaskExecutor et adaptateurs Pi/Codex | **Réutiliser pour les deux profils** |
| Sandboxes Docker, commits/checkpoints, branche d'intégration séparée | **Conserver** |
| Stockage durable JSON et API status/resume existantes | **Réutiliser**, pas de SQLite |
| Reprise manuelle après incident | **Conserver**, aucune relance automatique après crash |
| Revue finale synthétique du lot actuellement ajoutée par TaskBatchService | **Adapter** : elle ne remplace pas la review obligatoire de chaque ticket |

Fichiers candidats pour les changements : slopify/src/taskBatch.ts, taskExecution.ts, dockerTaskExecutor.ts, éventuellement le branchement du contrôleur IA et les tests associés. Minimiser les nouveaux fichiers et les changements dans acp-pipeline, acp-runtime, acp-sandbox et acp-workspace.

Le code actuel attribue le statut succeeded après **checkpoint et intégration Git** sans attendre une review indépendante par ticket ; le POC doit faire évoluer **ce point de validation**. Les tâches dépendantes ne doivent pas être libérées par un simple exit code 0 ou un checkpoint.

## 3. Répartition des responsabilités

### 3.1 Contrôleur IA — décideur à la demande

- Reçoit le ticket, les dépendances, les critères, **un état synthétique** et les comptes rendus de missions.
- **N'est invoqué que lorsqu'une décision nouvelle est nécessaire** : mission initiale, contrat de preuves, échec de review, correction, arrêt, ou arbitrage de priorité.
- Décide d'une mission parmi un ensemble borné : **IMPLEMENT, REVIEW, CORRECT, ACCEPT, STOP** (noms indicatifs, pas un schéma imposé).
- À partir des critères d'acceptation, **définit les preuves que le reviewer devra apporter**. Il ne peut ni modifier le ticket ni ignorer ses critères.
- Peut décider d'arrêter avant le nombre maximal de corrections si les informations montrent une impasse.
- Émet des décisions structurées avec une justification **courte et explicite**.
- Conserve un historique durable des décisions et de leurs raisons. À chaque réveil, récupère l'état courant et les décisions utiles ; **ne suppose pas qu'une session LLM reste ouverte**.
- Ne reçoit pas les transcriptions détaillées, traces internes ou raisonnements de tous les agents. Les logs volumineux sont stockés à part et accessibles par référence pour investigation.

Le contrôleur **n'exécute ni les tests ni les requêtes HTTP**. Il exige des preuves et se fonde sur le verdict du reviewer et sur des références vérifiables. Les règles de sécurité, les statuts et les budgets ne dépendent pas uniquement de sa parole.

### 3.2 Scheduler — mécanique, sans LLM

- Lit l'état persistant, les priorités proposées par le contrôleur et les dépendances définies par to-tickets.
- Sélectionne **uniquement** des tickets prêts ; un descendant ne devient prêt que lorsque ses dépendances sont **implémentées, relues, prouvées et intégrées**.
- Gère le parallélisme existant et la limite **un seul worker principal à la fois par ticket**, plusieurs tickets pouvant avancer simultanément.
- À priorité égale, préfère simplement le ticket qui **débloque le plus de descendants directs** ; à nouvelle égalité, conserve l'ordre stable du JSON.
- Garde **les vagues actuelles** pour le POC : le passage à un pool continuellement alimenté et l'optimisation complète de l'occupation sont **hors périmètre**.
- N'appelle jamais lui-même un modèle pour trancher une égalité.

### 3.3 Workers — exécutants éphémères

- Conserver **un moteur d'exécution générique** et lui associer des profils de mission : **implémentation/correction** et **review/vérification**.
- Chaque mission correspond à une session d'agent éphémère, éventuellement dans une sandbox existante ou un nouveau clone isolé selon les garanties Git nécessaires.
- **Les sous-agents restent autorisés** dans une mission (recherche, exploration, développement partiel, etc.).
- Le worker n'ordonnance pas d'autres tickets et ne déclenche pas lui-même une review **indépendante de validation**.
- Adapter localement le skill/prompt d'implémentation pour retirer la review finale qu'il orchestre aujourd'hui ; conserver l'écriture de tests et les petites vérifications techniques nécessaires au développement/TDD.
- Retour minimal au contrôleur : **ticketId, mission, outcome (success/failure), résumé très court, éventuel blocage, références vers rapport/preuves/checkpoint**. Les logs complets restent hors contexte LLM.

## 4. Contrat de review et preuves

Le reviewer reçoit **le ticket et les preuves exigées par le contrôleur**, ainsi que le code/checkpoint candidat à valider. Son travail est double :

1. **Review de code** : conformité au ticket et à la spec, erreurs, qualité, impacts, problèmes de sécurité évidents, tests.
2. **Vérification concrète** : fournir les preuves attendues. Par exemple, pour une API : démarrer le serveur dans la sandbox, appeler les endpoints pertinents, conserver commande, statut HTTP, assertions et sorties ; exécuter les tests/unit tests demandés.

Il rend un verdict structuré **PASS ou FAIL**, avec références vers les preuves et findings précis. Une affirmation « ça marche » n'est pas une preuve.

**Invariants de validation :**
- Le ticket n'est **ACCEPTED/succeeded** qu'après une review PASS explicite, preuves requises présentes et état Git intégré avec succès.
- Le contrôleur/système vérifie au minimum la présence et la cohérence des références attendues ; une sortie de modèle, un exit code 0 ou un checkpoint seul ne suffit pas.
- Une review FAIL retourne au contrôleur qui peut demander une correction ciblée. Le reviewer ne corrige pas silencieusement le code qu'il valide.
- Une nouvelle session d'implémentation/correction doit recevoir **les modifications candidates issues de la tentative précédente** (checkpoint ou branche isolée), **pas repartir de zéro** sur l'ancien commit d'intégration.
- En cas de review négative, les tickets dépendants restent bloqués, les indépendants peuvent continuer tant que l'arrêt critique n'est pas atteint.
- Préserver l'isolation : aucune mutation implicite de la branche de travail utilisateur.
- La review du lot intégrée déjà présente ne doit **pas être confondue** avec cette validation par ticket. Son maintien éventuel en contrôle final de cohérence doit éviter de répéter inutilement la même revue LLM ; ne pas conserver deux validations redondantes sans justification.

Le **contrat de preuves est déduit par le contrôleur IA**, à partir des critères des tickets existants, sans exiger de modifications du workflow to-tickets.

## 5. Cycle souhaité et réconciliation

1. Entrée : spec, tickets approuvés et dépendances.
2. État initial durable ; scheduler détecte les tickets prêts.
3. Le contrôleur IA, **si une nouvelle décision est nécessaire**, définit la mission d'implémentation et les preuves exigées.
4. Le scheduler attribue la mission à une place disponible dans la vague.
5. Worker IMPLEMENT : code, tests, sous-agents éventuels, checkpoint et résultat synthétique.
6. Worker REVIEW : code review indépendante, tests fonctionnels adaptés au ticket, PASS/FAIL et preuves référencées.
7. **PASS** : le système intègre de façon sûre le changement validé, marque le ticket succeeded et débloque ses descendants.
8. **FAIL** : le contrôleur décide CORRECT ou STOP. Le worker de correction repart du travail candidat avec les findings puis une nouvelle review intervient.
9. Répéter jusqu'à satisfaction des critères ou arrêt. Le scheduler applique les décisions avec des règles déterministes.

Une nouvelle décision ne nécessite **pas forcément** un appel LLM si elle résulte directement d'une règle codée (par exemple dépendances validées, égalité de priorité ou plafond atteint). Éviter la consultation du contrôleur LLM à chaque simple transition d'état.

### Exemple de dépendances

- Ticket A : créer une API.
- Ticket B : client consommant l'API ; dépend de A.
- Ticket C : indépendant.

A et C peuvent être implémentés en parallèle. Si A a été codé mais sa review échoue, B reste bloqué tandis que C peut continuer. Si A est corrigé, revu et accepté, B devient prêt. Si A épuise ses corrections, **arrêt critique global** du run, pas seulement de B.

## 6. Erreurs, garde-fous et reprise

- **Maximum trois tentatives de CORRECTION par ticket** (en plus de son implémentation initiale), valeur configurable ; compteur et historique conservés dans le store actuel.
- Le contrôleur peut **arrêter avant** les trois corrections.
- Après trois corrections infructueuses : **CRITICAL_FAILURE global**. Aucun **nouveau** worker/ticket/retry ne doit être lancé ; enregistrer le ticket déclencheur, les findings, les preuves et les décisions. Les missions déjà en cours doivent finir ou être interrompues de manière contrôlée, sans perte de preuve ; le détail est à choisir selon la mécanique existante la moins invasive.
- Attente d'une **intervention humaine explicite** pour débloquer et reprendre.
- Après crash/incident technique : sauvegarder et exposer l'état ; **pas de relance automatique au redémarrage**. Reprise manuelle via les capacités CLI existantes, après vérification que les anciens processus sont arrêtés. Un crash ne doit pas consommer une correction métier par erreur.
- Conflit d'intégration Git : conserver la suspension et la résolution explicite existantes, **sans résolution autonome obligatoire**.
- **Budget-cible : 10 € par ticket**, configurable, avec avertissement souhaité à 80 % ; englobe contrôleur, workers et sous-agents. **Ne pas inventer de coûts** : si l'usage/pricing fiable n'est pas exposé par Pi/Codex/providers, documenter la limitation et reporter le contrôle monétaire strict à une étape ultérieure. Le POC ne doit pas introduire un système complexe de facturation.

## 7. Persistance minimale

**Réutiliser** le snapshot JSON et l'écriture durable existants. Ajouts envisagés seulement si nécessaires :
- Pour le ticket : phase logique (implementation, review, correction, accepted, blocked), compteur de corrections, priorité facultative, liens vers artefacts.
- Pour le run : statut critical_failure si indispensable à l'interface, journal compact des décisions (date, ticket, action, motivation courte, résultat, références), rapport d'arrêt.
- Les traces de modèles et preuves détaillées restent dans les répertoires de tentatives ; **aucune obligation de conserver les raisonnements internes des agents**.
- Préférer des champs additionnels à une refonte du schéma. Maintenir les sécurités de persistance atomique déjà présentes.

Les transitions doivent rester contrôlées par le code : un LLM ne peut pas marquer seul un ticket comme intégré et accepté si les préconditions objectives échouent.

## 8. Périmètre minimal et exclusions

**Inclure dans le POC :**
- Réutilisation des adaptateurs d'agent et des sandboxes existants pour les deux profils.
- Contrôleur IA interrogé à la demande, décisions et mémoire persistées.
- Review par ticket avec contrat de preuves, échec et correction.
- Respect du graphe, priorités simples et vagues V2.
- Limite des trois corrections, critical failure global, reprise manuelle.
- Tests reproductibles avec faux agent/reviewer et événements contrôlés, sans dépenser de tokens.

**Ne pas ajouter au POC :**
- Kubernetes réel, CRD, pods, cluster, Redis, bus d'événements, microservices, framework d'orchestration supplémentaire.
- SQLite ou second mécanisme de stockage.
- Pool de workers permanents, reprise automatique après crash ou récupération de conversations d'agents.
- Scheduler sophistiqué (chemin critique, coût prédit, optimiseur global).
- Réécriture des skills de préparation ou du graphe des tickets.
- Refonte générale des packages historiques.
- Un orchestrateur LLM qui redécoupe librement les tickets.
- Évaluation monétaire fictive ou sur-ingénierie pour les budgets.

## 9. Tests d'acceptation (déterministes)

Exiger au minimum ces scénarios avec exécutants simulés injectés dans les seams existants :

1. **DAG** : A et C prêts ; B dépend de A. A est implémenté mais non revu ; B ne démarre pas. Après review PASS de A et intégration, B devient prêt.
2. **Vérification réelle simulée** : le contrat demande tests + preuve HTTP. Reviewer renvoie rapport de code et références vers sorties factices vérifiables. Si une preuve requise manque, le ticket ne passe pas.
3. **Échec et correction** : review FAIL puis correction qui réutilise le code candidat, puis review PASS ; une seule correction comptée ; les descendants ne démarrent qu'après PASS/intégration.
4. **Arrêt anticipé** : contrôleur IA décide STOP dès le premier échec ; arrêt persistant sans nouvelle mission.
5. **Plafond** : trois corrections infructueuses → arrêt global, aucun nouveau ticket planifié, diagnostic et reprise humaine nécessaires.
6. **Tickets indépendants** : A en erreur n'empêche pas C déjà autorisé de terminer avant le critical failure ; B reste bloqué.
7. **Priorité** : à priorité égale, compter les descendants directs débloqués, puis ordre JSON stable ; aucune requête LLM pour départager.
8. **Mémoire** : simulation de nouvelle session du contrôleur après une transition : il récupère les décisions et le statut utiles sans transcript de workers.
9. **Crash** : snapshot retrouvé à la relance ; aucune reprise automatique ni consommation indue de tentatives.
10. **Contrôle Git** : worktree utilisateur intact, sandbox/clone isolé, résultat vérifié puis intégré, conflit traité par le mécanisme explicite existant.
11. **Non-régression** : tests V2 existants conservés ou adaptés au nouveau gate ; build et suite npm test verts.

Une exécution réelle Pi/Codex + Docker Sandboxes sur un lot miniature est **un smoke test complémentaire**, distinct des tests reproductibles. Ne pas la présenter comme validée tant qu'elle n'a pas été exécutée.

## 10. Stratégie d'implémentation minimale

1. **D'abord** introduire des tests de caractérisation du fonctionnement actuel des vagues, dépendances, intégration et sorties worker.
2. Faire émerger le **gate review** au point où la V2 convertit aujourd'hui un checkpoint intégré en succeeded, **sans refaire le moteur Git**.
3. Réutiliser **TaskExecutor** pour la mission reviewer et la mission corrective ; le contexte du candidat à corriger doit être préservé.
4. Ajouter un petit adaptateur de décision LLM injectable, avec un **fake déterministe** pour les tests ; réutiliser Pi/Codex si possible sans créer de dépendance cyclique.
5. Enrichir très modestement le snapshot JSON ; conserver les commandes status et reprise.
6. Ajouter les règles simples du scheduler et les garde-fous, puis le smoke test.
7. Modifier le minimum de skills/prompts, uniquement pour retirer la review indépendante de l'implémenteur et imposer le contrat de preuves au reviewer.

**Règle de décision :** si la modification d'un point impose une grosse abstraction ou une refonte d'un package, revenir à une solution locale plus simple et documenter l'arbitrage dans la PR.

## 11. Livrable attendu

Une **PR de code distincte** du présent cahier des charges (aucune modification directe de la branche cible) contenant :
- le diff le plus restreint permettant ces scénarios ;
- les tests déterministes de réconciliation et des dépendances ;
- un exemple de batch A/B/C et un reviewer avec preuves ;
- un bilan clair : déjà existant, ajouté, volontairement reporté ;
- les résultats de build/test et, s'il est effectué, du smoke test réel.

**Critère de réussite :** un ticket ne libère ses descendants qu'après implémentation, review indépendante PASS étayée par des preuves et intégration Git ; Slopify choisit des missions à la demande, garde ses décisions, respecte les dépendances et s'arrête proprement au plafond d'échecs, **sans nouvelle usine à gaz**.

## 12. Points à confirmer pendant l'implémentation (sans élargir le POC)

- Comment invoquer le LLM du contrôleur avec l'adaptateur Pi/Codex existant, sans processus permanent et avec une réponse typée fiable.
- Comment exposer une mission de review non-mutante sur un checkpoint candidat avec le **plus petit diff** possible.
- Que faire exactement des workers déjà actifs lorsqu'un CRITICAL_FAILURE survient (laisser terminer ou annuler proprement).
- Garder ou réduire la revue globale existante une fois les reviews par ticket en place, sans double travail inutile.
- Disponibilité effective de la télémétrie de tokens/coûts (ne pas prétendre respecter un plafond non mesurable).

Ces points demandent des décisions techniques locales, **pas une nouvelle phase de conception de l'ensemble de Slopify**.
