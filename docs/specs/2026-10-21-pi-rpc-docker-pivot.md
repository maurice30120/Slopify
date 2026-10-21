# Slopify V2 — pivot Pi RPC sur Docker classique (brouillon)

Date : 21 octobre 2026. **État : décisions d'orientation et questions ouvertes, pas encore une spécification d'implémentation approuvée.**

Branche de réflexion : `feature/pi-rpc-docker-pivot`, issue du commit `2f9d8159d18de42315a983fae69f69f5703ec5c5` de la PR #177. Ne pas modifier ni fusionner la PR #177 dans le cadre de ces notes.

## Orientation retenue

- **Un seul agent principal : Pi.** Retirer à terme le chemin Codex propre à Slopify.
- **Un seul environnement d'exécution : Docker classique** (ni Docker Sandboxes/`sbx` ni exécution de l'agent directement sur l'hôte).
- **Un processus Pi en mode RPC par tentative de tâche**, dans un conteneur Docker distinct ; Slopify communique via les flux du processus RPC, sans serveur HTTP ajouté.
- **Sous-agents Pi conservés** : Pi reste libre de déléguer explorations, recherches et revues à l'intérieur de son conteneur. La version et le contrat de l'extension choisie doivent être vérifiés par un test d'intégration.
- **Ordonnanceur Slopify conservé** : dépendances, admission dynamique des tickets prêts, parallélisme borné (jusqu'à dix actuellement), état durable, blocage des descendants en échec, reprises explicites, suivi, preuves, checkpoints, résolution de conflits et revue finale.
- **Git reste sous responsabilité de Slopify** : clones par tentative basés sur un commit épinglé, intégration sérialisée des checkpoints et branche d'intégration par run. Aucun changement implicite dans l'arbre de travail de l'utilisateur.
- **POC minimal** : commencer avec deux tâches simultanées par défaut, sans remettre en cause la borne configurable existante ; pas de renforcement avancé de sécurité à ce stade (mais ne pas monter l'intégralité du disque ni exposer inutilement des identifiants).

## Décisions validées — entretien Grill with Docs, tour 1 (Q1 à Q6)

Les six recommandations du premier tour ont été acceptées. Elles cadrent le POC sans autoriser encore l'implémentation.

1. **Q1 — Désignation explicite de l'environnement projet.** Le projet fournit dans `.slopify/runtime.yaml` une référence explicite à son **image de développement** ou au Dockerfile à construire. Slopify n'infère pas arbitrairement quel Dockerfile choisir ; il produit ensuite automatiquement l'**image d'exécution assemblée**, sans modifier la définition du projet.
2. **Q2 — Configuration fournisseur Pi réutilisée.** Réutiliser la configuration Pi existante, avec passage sélectif des seuls paramètres et identifiants nécessaires au conteneur ; pas de second gestionnaire de fournisseurs dans Slopify. Ne pas embarquer de secrets dans l'image, ni monter aveuglément toute la configuration personnelle. Les modalités exactes de sélection et de transfert des identifiants restent à préciser.
3. **Q3 — Capacité initiale de deux agents principaux.** Deux conteneurs Pi simultanés par défaut pour le POC, plafond configurable de dix. La consommation en mémoire et les sous-agents concurrents restent à mesurer sur le Mac M4 ; ne pas confondre nombre de tâches et nombre total de processus Pi.
4. **Q4 — Revue obligatoire bloquante.** Une revue requise qui échoue, n'a pas pu démarrer ou fournit un verdict non vérifiable interdit de marquer la tâche comme réussie. Retenir les modifications, événements, logs et preuves pour diagnostic/reprise ; formaliser ensuite le protocole de verdict observable.
5. **Q5 — Pas de migration complexe des anciens runs.** Préserver la consultation des preuves historiques existantes selon les données disponibles, mais ne pas promettre de reprise automatique d'exécutions `local` et `sandbox` avec le nouveau runtime. Aucun effacement automatique des preuves.
6. **Q6 — Compatibilité limitée et explicite.** Cibles initiales : images Linux compatibles glibc, architectures ARM64 et x64 ; refuser proprement une base incompatible au lieu de promettre l'assemblage universel de toutes les images Docker (notamment Alpine/musl, Windows ou distroless sans prérequis).

## Périmètre du premier lot — intention

1. Adapter le contrat `TaskExecutor` existant à un exécuteur Pi RPC utilisant `docker` classique ; **ne pas réécrire le scheduler**.
2. Définir l'image Pi, l'initialisation des extensions et des credentials, et l'échange JSON RPC via stdin/stdout. Conserver stderr/logs et le répertoire de preuves hors du clone Git produit.
3. Gérer correctement le démarrage, les événements de fin, les erreurs, l'arrêt et le nettoyage du conteneur. Empêcher qu'une reprise crée silencieusement un deuxième agent encore actif.
4. Préserver les checkpoints et validations Git existants, la revue finale et la compatibilité des résultats d'exécution.
5. Tests unitaires et d'intégration avec faux Pi RPC et vrais dépôts Git temporaires, sans fournisseur ni Docker en CI ; smoke réel Docker + Pi **manuel sur le Mac** avant validation produit.
6. Évaluer les états historiques issus des modes `local` et `sandbox` avant toute suppression ; ne pas déclarer les anciennes reprises compatibles sans preuve.

## Composition des environnements Docker — décision de conception à prototyper

L'utilisateur souhaite **deux définitions réellement indépendantes** :

1. Une image `slopify/pi` minimale, possédée par Slopify : exécutable Pi, runtime éventuellement embarqué suivant la variante A/B ci-dessous, extension de sous-agents validée, Git et outils communs. Les binaires et ressources à injecter doivent être regroupés dans un préfixe autonome (par exemple `/opt/slopify-pi`).
2. Un Dockerfile de développement propre au projet : par exemple image .NET SDK correspondant à `global.json`, ou environnement Python/Java/Rust, **sans connaissance de Pi ni de Slopify**.

**Slopify réalise la composition automatiquement** au démarrage ou lors de la préparation du run : construire/résoudre l'image du projet, puis générer un Dockerfile d'assemblage multi-stage qui prend l'image projet comme base et **copie le bundle Pi** depuis l'image Slopify. Le résultat est une troisième image `slopify/run-<digest>`, mise en cache, à partir de laquelle plusieurs conteneurs de tâches indépendants sont lancés.

Exemple conceptuel du Dockerfile généré (illustration, non encore exécutable sans packaging adapté) :

```dockerfile
FROM slopify/pi:VERSION AS pi-tools
FROM projet-dev:VERSION
COPY --from=pi-tools /opt/slopify-pi/ /opt/slopify-pi/
# Slopify lance Pi depuis son emplacement privé, sans modifier le PATH du projet.
WORKDIR /workspace
```

Lancer Pi avec `--mode rpc` dans chaque conteneur final ; le code C# est compilé avec les outils du projet, pas par `docker build` à chaque ticket.

### Variantes d'exécution Pi à comparer avant de choisir

**Ne pas trancher par hypothèse : prototyper et tester les deux possibilités sur la même image de développement (.NET SDK + éventuellement Node.js 20).** Garder la version de Node et le `PATH` du projet inchangés dans les deux cas.

- **Variante A — Pi npm + Node privé.** Copier Pi et une version de Node.js compatible avec Pi (actuellement >= 22.19) sous `/opt/slopify-pi`. Lancer explicitement le point d'entrée de Pi avec **son** Node ; l'agent et les sous-agents n'écrasent jamais le `node` du projet. Plus classique, mais bundle plus volumineux et deux runtimes Node possibles.
- **Variante B — binaire Pi officiel compilé avec Bun.** Copier l'exécutable officiel Linux adapté à l'architecture, avec les assets dont il dépend, dans `/opt/slopify-pi`. Démarrer directement ce binaire en `--mode rpc`. Il n'exige normalement ni installation séparée de Node.js ni de Bun pour Pi. Risque particulier : chargement de l'extension de sous-agents, imports dynamiques, extensions et sous-processus. Il ne s'agit **pas** de lancer arbitrairement la distribution npm sous Bun.

**Recette comparative minimale, obligatoire pour les deux variantes :** démarrage RPC, prompt et événements, exécution d'une commande du projet, délégation à un sous-agent, collecte d'erreurs de sous-agents, annulation/arrêt sans processus orphelin, résultat et checkpoint Git, ainsi que le maintien du `node --version` propre au projet. Tester sur l'architecture du Mac M4 (conteneurs Linux ARM64) ; vérifier les contraintes de libc/dépendances natives et le fonctionnement des sous-agents. Retenir la solution **la plus simple parmi celles qui passent l'ensemble des tests** ; en cas d'échec du binaire Bun, conserver Node privé. Aucun choix définitif avant preuve.

Références : https://github.com/earendil-works/pi/releases ; https://github.com/earendil-works/pi/issues/6085 ; https://github.com/earendil-works/pi/issues/10031 .

### Extension Pi nécessaire au POC

**Une seule extension explicitement requise : les sous-agents.** L'adaptateur Pi actuel (`packages/agent-pi/src/index.ts`) charge explicitement `examples/extensions/subagent/index.ts`. Garder une seule extension de délégation choisie et sa version épinglée ; s'assurer que ses sous-agents (notamment les rôles de revue Standards/Spec) fonctionnent sous RPC dans les **deux** variantes ci-dessus.

Les outils ordinaires de Pi (lecture, édition, shell), le protocole RPC et les skills `implement`, `tdd`, `code-review` **ne sont pas des extensions supplémentaires**. Conserver ces skills et leurs ressources si la recette en dépend, sans charger d'extensions additionnelles. Les outils de diagnostic facultatifs comme Pi Lens ne constituent pas un prérequis du POC. Une configuration Pi utilisateur pouvant charger d'autres extensions ne doit pas être requise pour la reproductibilité.

**Limites importantes :** Docker ne fusionne pas arbitrairement deux images avec leurs métadonnées ni toutes leurs dépendances. `COPY --from` transfère des **fichiers**, pas automatiquement les variables d'environnement, services, bibliothèques système et points d'entrée. Vérifier la compatibilité Linux/architecture (`arm64` sur Mac M4), libc et des binaires copiés. Si l'image projet n'est pas compatible, refuser avec un message explicite plutôt que prétendre qu'une fusion universelle fonctionne. Prévoir un smoke de composition .NET SDK + Pi, un test du cache et un test d'exécution du SDK depuis un conteneur assemblé.

Conserver les Dockerfiles du projet **inchangés**. Réutiliser les images construites à identité/digest égale : aucune reconstruction d'image par ticket. Ne pas imposer Docker-in-Docker, monter le socket Docker dans l'agent ou ajouter un deuxième conteneur d'outils pour le POC.

Documentation Docker de référence : https://docs.docker.com/build/building/multi-stage/ (image externe comme source de `COPY --from`).

## Remarque — capacités RPC à garder en tête, **hors périmètre pour l'instant**

L'intérêt de RPC dépasse le simple lancement d'un agent ; ces fonctionnalités sont des **pistes futures**, et **ne doivent ni bloquer ni complexifier le premier lot** :

- Exploiter les événements d'outils et de messages pour un suivi d'activité en temps réel et un diagnostic plus fin.
- Réorienter un agent actif via le mécanisme de *steering* ; prévoir ultérieurement une politique d'intervention humaine explicite.
- Suivre tokens, coût, contexte et modèle ; envisager plus tard des garde-fous de budget ou un changement de modèle, selon les capacités réelles du fournisseur.
- Relayer les demandes interactives d'extensions Pi (confirmation, choix, saisie) ; définir au préalable le comportement en mode non interactif.
- Conserver les sessions Pi hors du conteneur pour une reprise de **contexte conversationnel**, sans confondre cela avec la reprise d'un processus ou d'une action interrompue.
- Observer les sous-agents lorsqu'une extension fournit des événements exploitables, sans supposer que RPC contrôle individuellement tous les sous-agents.

**Principe directeur :** Slopify orchestre les tickets et Git ; Pi exécute les tickets et gère librement ses propres sous-agents. Ne pas ajouter de nouvelle couche d'orchestration de sous-agents.

## Questions à discuter avant d'arrêter la spec

- Images Pi, extension de sous-agents et stratégie de configuration/identification des fournisseurs à retenir.
- Concurrence par défaut (2 ou 3), ressources Docker et persistance minimale requise pour les smokes.
- Contrat exact des événements/erreurs RPC et critère de succès fiable en présence d'échecs de sous-agents.
- Politique de migration ou d'archivage des anciens runs des modes supprimés.

Aucun code produit n'est modifié par ce document.