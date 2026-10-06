# 05: Persister, diagnostiquer et reprendre explicitement

**Ticket ID:** T05

**What to build:** Après échec ou interruption, Pi peut lire un état durable et demander explicitement une nouvelle tentative depuis la branche courante, sans refaire les résultats intégrés ni recharger un contexte modifié.

**Blocked by:** 04 — Exécuter les vagues et intégrer les dépendances.

**Status:** ready-for-agent

- [ ] L’état par run est écrit atomiquement et conserve bases, tentatives, commits, ressources, rapports et branche.
- [ ] La reprise après redémarrage réutilise les résultats intégrés et les résultats enregistrés encore à intégrer sans les dupliquer.
- [ ] Une tâche interrompue sans résultat devient `interrupted` ; sa reprise explicite crée une nouvelle identité et un nouveau sandbox depuis l’intégration courante.
- [ ] Une demande explicite peut relancer une tâche échouée ; aucune tentative n’est créée par simple lecture d’état ou retry automatique.
- [ ] Sources changées/supprimées après lancement n’affectent pas le contexte figé de la reprise.
- [ ] Les sandboxes échoués/interrompus restent inspectables ; les réussites sont nettoyées après sauvegarde et une erreur de nettoyage est signalée.
- [ ] Les commandes publiques de suivi et reprise produisent un bilan exploitable par Pi.

**Public seam:** lancement, lecture d’état et reprise d’un lot après reconstruction du service, avec vrai stockage/Git.

**Validation:** tests d’interruption aux transitions critiques, reprise sans répétition, sources modifiées et rétention ; build et tests ciblés.
