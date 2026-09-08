# 02: Les runs en pause survivent à la sortie du CLI, avec guide de reprise

**What to build:** quitter le CLI pendant qu'un Pipeline Run attend une réponse (EOF, Ctrl-D, erreur d'entrée) laisse le run dans son état persisté et indique à l'utilisateur comment le reprendre ; un nouveau processus CLI retrouve le run et rejoue la question sans perte.

**Blocked by:** 01 (l'ADR fixe la formulation de l'invariant que les tests de ce ticket encodent).

**Status:** ready-for-agent

- [ ] À la sortie sur erreur ou EOF pendant une Pause (question), le snapshot persisté conserve le statut « paused » et sa pause en attente ; aucun événement « cancelled » n'est émis.
- [ ] Même comportement pour un run interrompu en cours de nœud : le snapshot reste « running » (un recover rejouera le nœud), aucun cancel implicite.
- [ ] Chaque run laissé vivant fait l'objet d'un guide sur stderr, du type : `Run <id> paused and resumable — resume with: slopify resume <id>` (variante « interrupted mid-node » pour un run running).
- [ ] Test de régression à froid : après la sortie du premier hôte, un second hôte (simulant un nouveau processus) retrouve le run et son recover rejoue la question — la régression du bug P2 (un tour d'interview complet d'agent perdu sur un simple EOF).
- [ ] La Cancellation explicite de l'utilisateur reste terminale (l'invariant ne l'atténue pas).
- [ ] Suite complète verte sur les cinq packages.
