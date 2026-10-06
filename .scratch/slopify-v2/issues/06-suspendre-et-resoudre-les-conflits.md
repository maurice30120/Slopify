# 06: Suspendre et résoudre les conflits sur action explicite

**Ticket ID:** T06

**What to build:** Un conflit arrête les nouveaux lancements et l’intégration en conservant tous les résultats ; Pi peut présenter le conflit et, après autorisation de l’utilisateur, déclencher une résolution isolée puis reprendre.

**Blocked by:** 05 — Persister, diagnostiquer et reprendre explicitement.

**Status:** ready-for-agent

- [ ] Le run publie les tâches, bases et fichiers en conflit et conserve les checkpoints, logs et résultats en attente.
- [ ] Les tâches déjà lancées finissent ; aucun résultat supplémentaire n’est fusionné et aucune nouvelle vague ne part tant que le conflit subsiste.
- [ ] Une commande explicite de résolution crée un sandbox dédié depuis le contexte de conflit ; aucune résolution automatique.
- [ ] Un résultat non valide ou une résolution échouée laisse le run suspendu et les preuves inspectables.
- [ ] Après résolution validée, les résultats en attente sont intégrés et la frontière recalculée sans refaire les tâches réussies.
- [ ] Une interruption pendant la résolution reste récupérable et ne modifie pas le dépôt utilisateur.

**Public seam:** lancement/état, résolution et reprise du lot sur de vrais commits Git incompatibles.

**Validation:** deux tâches modifiant la même ligne, résolution autorisée réussie/échouée, résultats indépendants conservés et redémarrage ; build et tests ciblés.
