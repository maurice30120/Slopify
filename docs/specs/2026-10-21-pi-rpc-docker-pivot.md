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
- **POC minimal** : commencer prudemment avec environ deux ou trois tâches simultanées, sans remettre en cause la borne configurable existante ; pas de renforcement avancé de sécurité à ce stade (mais ne pas monter l'intégralité du disque ni exposer inutilement des identifiants).

## Périmètre du premier lot — intention

1. Adapter le contrat `TaskExecutor` existant à un exécuteur Pi RPC utilisant `docker` classique ; **ne pas réécrire le scheduler**.
2. Définir l'image Pi, l'initialisation des extensions et des credentials, et l'échange JSON RPC via stdin/stdout. Conserver stderr/logs et le répertoire de preuves hors du clone Git produit.
3. Gérer correctement le démarrage, les événements de fin, les erreurs, l'arrêt et le nettoyage du conteneur. Empêcher qu'une reprise crée silencieusement un deuxième agent encore actif.
4. Préserver les checkpoints et validations Git existants, la revue finale et la compatibilité des résultats d'exécution.
5. Tests unitaires et d'intégration avec faux Pi RPC et vrais dépôts Git temporaires, sans fournisseur ni Docker en CI ; smoke réel Docker + Pi **manuel sur le Mac** avant validation produit.
6. Évaluer les états historiques issus des modes `local` et `sandbox` avant toute suppression ; ne pas déclarer les anciennes reprises compatibles sans preuve.

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