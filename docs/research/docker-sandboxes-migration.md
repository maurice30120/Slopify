# Docker Sandboxes face au contrat `acp-sandcastle`

Date de vérification : 2026-07-24.

## Synthèse

Docker Sandboxes peut remplacer le moteur d'exécution actuel par une isolation plus forte : chaque sandbox est une microVM avec son propre noyau, son propre système de fichiers, son propre réseau et son propre daemon Docker. En revanche, il ne remplace pas à lui seul le contrat métier de `acp-sandcastle` : il n'offre aucune opération native équivalente à `preview`, `apply`, `reject`, ni les résultats `applied`, `no_changes`, `rejected`, `cancelled`.

La cible crédible est donc :

1. utiliser `sbx --clone` comme frontière d'isolation du dépôt ;
2. piloter `sbx` comme un processus externe ;
3. conserver dans Slopify une couche Git explicite pour produire l'aperçu, promouvoir atomiquement ou rejeter les changements ;
4. ne pas utiliser le montage direct par défaut, car les changements de l'agent atteignent alors immédiatement le workspace hôte.

## Comparaison

| Sujet | Contrat actuel du dépôt | Docker Sandboxes | Conséquence de migration |
|---|---|---|---|
| Isolation d'exécution | Conteneur Docker créé par `@ai-hero/sandcastle` | Une microVM par sandbox, noyau séparé, agent avec `sudo`, daemon Docker privé | Isolation système plus forte ; le daemon Docker hôte reste inaccessible. |
| Isolation du code | Worktree Git jetable monté en écriture ; workspace principal non modifié avant promotion | Montage direct RW par défaut, ou clone privé avec `--clone` | `--clone` est obligatoire pour préserver la garantie actuelle. Le mode direct la viole. |
| Git | Branche `sandcastle/acp/...`, worktree et métadonnées Git montés dans le conteneur | Le clone reprend la ref hôte courante ; aucune branche n'est créée automatiquement ; un remote `sandbox-<name>` est ajouté côté hôte | Il faut imposer la création d'une branche et de commits dans le sandbox, ou construire une extraction de diff indépendante. |
| Aperçu/promotion/rejet | `sandcastle/preview`, `sandcastle/apply`, `sandcastle/reject`; patch binaire appliqué au workspace, puis destruction | Pas de primitive de promotion. En clone mode : `git fetch sandbox-<name>`, puis checkout/cherry-pick/merge, ou push/PR par l'agent | Garder un orchestrateur Git métier. Ne pas assimiler `sbx rm` à une promotion ; il ne fait que supprimer l'environnement. |
| Atomicité de l'application | Le contrat exige qu'un échec d'apply ne mute pas partiellement l'hôte | Non fournie par `sbx` | L'application atomique reste une responsabilité Slopify. |
| Persistance | Session/worktree conservés jusqu'à apply, reject, close ou dispose | VM, paquets, images, conteneurs, configuration et historique persistent après `stop` et redémarrage ; `rm` efface l'état interne | Cycle de vie compatible, mais il faut nommer, retrouver et nettoyer les sandboxes. |
| Montages | Worktree RW, `.agents`, métadonnées Git, homes Codex/Vibe | Workspace principal au même chemin absolu ; chemins supplémentaires montables, avec suffixe `:ro` | Éviter les montages RW additionnels. Le mode clone ne protège que le dépôt principal ; les workspaces supplémentaires restent des montages directs. |
| Réseau | Dépend du conteneur Docker et de sa configuration | HTTP/HTTPS via proxy et règles ; posture documentée deny-by-default ; TCP/UDP/ICMP bruts, IP privées, loopback et link-local bloqués | Sécurité améliorée, mais les domaines requis par agents, registries et outils doivent être déclarés. Les ports entrants se publient après création avec `sbx ports`. |
| Secrets/auth | Copie de `~/.codex/auth.json` vers `.sandcastle/codex-home`, homes Codex/Vibe montés RW, variables d'environnement | Secrets stockés côté hôte et injectés par proxy sans révéler leur valeur ; OAuth hôte pour certains agents ; agent SSH forwardé | Supprimer les copies de credentials Codex est souhaitable. Attention : les credentials de registry rendus disponibles dans la VM sont lisibles par l'agent. |
| Agents | Codex, Pi, Vibe, Cursor via les providers Sandcastle | Claude, Codex, Copilot, Cursor, Droid, Gemini, Kiro, OpenCode, Docker Agent et Shell | Codex/Cursor sont directs. Pi et Vibe ne sont pas intégrés ; un kit ou le mode Shell serait nécessaire, avec davantage de code et une surface expérimentale. |
| Pilotage | API TypeScript `createSandbox`/`Sandbox.run`, encapsulée derrière un bridge ACP | CLI `sbx` (`run`, `create`, `exec`, `cp`, `ls`, `stop`, `rm`, `ports`, `secret`, `policy`), dont certaines sorties JSON | Aucun SDK/API public de lifecycle n'est documenté. Prévoir un adaptateur de subprocess robuste, pas un simple remplacement d'import npm. |
| Plateformes | Docker disponible pour l'implémentation actuelle | macOS 14+ Apple Silicon ; Windows 11 x86_64 avec Windows Hypervisor Platform ; Ubuntu 24.04+ x86_64/aarch64 avec KVM | Ce n'est pas une compatibilité « macOS/Linux » générique : Mac Intel et distributions Linux autres qu'Ubuntu ne sont pas officiellement couvertes. |

## Détails déterminants

### Frontière de sécurité

La microVM constitue la frontière principale. L'agent dispose de privilèges élevés à l'intérieur, mais ne peut pas accéder au système de fichiers hôte hors workspaces, au daemon Docker hôte, au réseau/localhost hôte ni aux autres sandboxes. Le Docker Engine intégré permet néanmoins à l'agent de construire et lancer des conteneurs dans la VM. Sources : [Security model](https://docs.docker.com/ai/sandboxes/security/) et [Default security posture](https://docs.docker.com/ai/sandboxes/security/defaults/).

Cette isolation ne protège pas automatiquement le code. En mode direct, le workspace est un passthrough RW : l'agent peut modifier ou supprimer les fichiers, y compris les hooks Git, scripts et fichiers cachés, et les changements sont visibles immédiatement sur l'hôte. En mode clone, le dépôt source est monté en lecture seule sous `/run/sandbox/source` et l'agent travaille dans un clone privé. Sources : [Isolation layers](https://docs.docker.com/ai/sandboxes/security/isolation/) et [Usage](https://docs.docker.com/ai/sandboxes/usage/).

### Git et promotion

Le clone mode est fixé à la création, exige que le workspace principal soit un dépôt Git, reprend la ref actuellement checkoutée et ne crée aucune branche automatiquement. Il est refusé si `sbx` est lancé depuis un worktree secondaire. Supprimer le sandbox détruit les changements ou commits qui n'ont pas été récupérés ou poussés. Source : [Usage — Git workspace modes](https://docs.docker.com/ai/sandboxes/usage/).

Docker documente trois workflows Git : direct, clone et worktree hôte. Le clone privé est le seul qui conserve une séparation forte tout en laissant Git utilisable par l'agent. Le worktree hôte isole une branche, mais l'agent ne peut pas résoudre le fichier pointeur `.git`, donc il ne peut ni consulter le statut, ni créer une branche, ni committer. En clone mode, le transfert passe par le remote `sandbox-<name>` ; celui-ci n'est joignable que lorsque le sandbox fonctionne et il est supprimé avec `sbx rm`. Source : [Workflow patterns — Git workflows](https://docs.docker.com/ai/sandboxes/workflows/).

Il n'existe pas de bouton ou commande Docker « accepter/rejeter ». Une migration fidèle doit donc garder les quatre résultats du domaine actuel et implémenter : génération d'un diff depuis la branche/commit sandbox, validation, application contrôlée au workspace cible, puis nettoyage. Un rejet peut ensuite supprimer le sandbox sans transfert.

### Réseau et accès locaux

La posture documentée bloque par défaut les destinations HTTP/HTTPS non autorisées et tous les protocoles bruts, notamment TCP, UDP, DNS direct et ICMP. Les plages privées, loopback et link-local sont bloquées. Des règles locales ou organisationnelles peuvent autoriser des domaines ; la gouvernance centralisée est payante. Les services lancés dans la sandbox ne sont accessibles depuis l'hôte qu'après publication explicite avec `sbx ports`. Sources : [Default security posture](https://docs.docker.com/ai/sandboxes/security/defaults/), [Usage — Publish ports](https://docs.docker.com/ai/sandboxes/usage/) et [Workflow patterns](https://docs.docker.com/ai/sandboxes/workflows/).

### Secrets

Pour les services déclarés, un proxy hôte remplace une valeur sentinelle par le vrai secret dans les requêtes sortantes. Le secret reste dans le trousseau du système — ou dans un fichier chiffré sur Linux sans Secret Service — et n'entre pas dans la VM. OAuth pour Codex et certains autres agents suit également un flux côté hôte ; l'agent SSH peut être forwardé sans exposer la clé privée. À l'inverse, les credentials de registry configurés pour être utilisables dans le sandbox sont écrits dans son `~/.docker/config.json` et sont donc lisibles par l'agent. Source : [Credentials](https://docs.docker.com/ai/sandboxes/security/credentials/).

### Agents et extension

Les agents disponibles directement sont Claude Code, Codex, Copilot, Cursor, Droid, Gemini, Kiro, OpenCode, Docker Agent et Shell. Des templates personnalisent une image d'agent existante ; les kits peuvent définir ou étendre un agent, mais leurs formats et commandes sont signalés comme susceptibles d'évoluer. Sources : [Supported agents](https://docs.docker.com/ai/sandboxes/agents/), [Templates](https://docs.docker.com/ai/sandboxes/customize/templates/) et [Build your own agent kit](https://docs.docker.com/ai/sandboxes/customize/build-an-agent/).

### CLI, automatisation et cycle de vie

La surface publique documentée est la CLI autonome `sbx`, distincte de `docker sandbox`. Elle permet notamment `create`, `run`, `exec`, `cp`, `ls --json`, `stop`, `rm`, `ports`, `policy` et `secret`. `stop` conserve l'état ; `run --name` réattache une sandbox ; `rm` détruit la VM et son contenu. Docker documente une utilisation CI/headless, mais aucune API ni SDK public de création/exécution n'est présenté ; l'API de gouvernance concerne les politiques d'organisation, pas le lifecycle des sandboxes. Sources : [référence CLI `sbx`](https://docs.docker.com/reference/cli/sbx/), [`sbx run`](https://docs.docker.com/reference/cli/sbx/run/), [`sbx exec`](https://docs.docker.com/reference/cli/sbx/exec/) et [Workflow patterns](https://docs.docker.com/ai/sandboxes/workflows/).

## Disponibilité locale vérifiée

L'environnement courant possède `sbx` version `0.35.0`. Le binaire Docker est en version `29.1.2` (build `890dcca877`), mais `docker sandbox --help` affiche l'aide générale : Docker Sandboxes n'est pas une sous-commande disponible via ce binaire. L'intégration doit donc détecter et invoquer `sbx`, et vérifier sa version/capacité indépendamment de la présence de Docker.

Cette distinction correspond à la documentation : Docker présente Sandboxes sous la commande `sbx`, installée séparément, et non comme une garantie liée à une version donnée du Docker CLI. Sources : [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) et [Get started](https://docs.docker.com/ai/sandboxes/get-started/).

## Limites et risques de migration

- Le mode direct ne satisfait pas l'ADR actuelle : la mutation hôte précède toute décision de promotion.
- Le clone mode rapproche le niveau de sûreté attendu, mais change la mécanique : il faut des commits/branches récupérables ou une nouvelle couche de diff.
- Aucune atomicité d'application n'est fournie par Docker Sandboxes.
- Pi et Vibe exigent une intégration personnalisée ; leur compatibilité réelle doit être prototypée avant de supprimer l'ancien runtime.
- Le pilotage par subprocess doit gérer timeouts, annulation, streaming, processus interrompus, versions de CLI et nettoyage idempotent.
- Un sandbox persistant accumule packages, images et état entre sessions ; cette propriété peut améliorer les performances mais réduire la reproductibilité.
- Les dossiers supplémentaires sont des montages directs : monter `.agents` en RW recréerait une voie de mutation hôte hors promotion.
- Les workspaces sur SMB/NFS ou dossiers synchronisés cloud sont déconseillés par Docker pour des raisons de latence et de cohérence de cache. Source : [Architecture](https://docs.docker.com/ai/sandboxes/architecture/).
- La plateforme est récente et évolutive ; les [release notes](https://docs.docker.com/ai/sandboxes/release-notes/) doivent être surveillées et une version minimale de `sbx` doit être fixée.

## Recommandation

Ne pas concevoir la migration comme « remplacer `@ai-hero/sandcastle` par Docker ». La simplification pertinente consiste à séparer deux modules profonds :

- un adaptateur `DockerSandboxRuntime` étroit, responsable uniquement de `sbx create/run/exec/stop/rm`, des événements et de la détection de capacités ;
- un `GitPromotion` indépendant, responsable de l'aperçu, des quatre résultats métier, de l'application atomique et du nettoyage.

Le premier prototype doit valider un parcours Codex minimal en `--clone` : créer une sandbox nommée, faire créer et committer une branche, récupérer le remote `sandbox-<name>`, produire un aperçu sans mutation hôte, appliquer ou rejeter, puis supprimer la sandbox. La prise en charge Pi/Vibe et les kits ne devrait venir qu'après validation de ce contrat de sécurité.

## Sources primaires

- [Docker Sandboxes — vue d'ensemble](https://docs.docker.com/ai/sandboxes/)
- [Get started et prérequis](https://docs.docker.com/ai/sandboxes/get-started/)
- [Usage](https://docs.docker.com/ai/sandboxes/usage/)
- [Architecture](https://docs.docker.com/ai/sandboxes/architecture/)
- [Security model](https://docs.docker.com/ai/sandboxes/security/)
- [Isolation layers](https://docs.docker.com/ai/sandboxes/security/isolation/)
- [Default security posture](https://docs.docker.com/ai/sandboxes/security/defaults/)
- [Credentials](https://docs.docker.com/ai/sandboxes/security/credentials/)
- [Supported agents](https://docs.docker.com/ai/sandboxes/agents/)
- [Workflow patterns](https://docs.docker.com/ai/sandboxes/workflows/)
- [Référence CLI `sbx`](https://docs.docker.com/reference/cli/sbx/)
- [Release notes](https://docs.docker.com/ai/sandboxes/release-notes/)
