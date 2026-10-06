---
status: accepted
---

# Garder un même agent pour la préparation et isoler les implémenteurs

**Note V2:** Pour la cible V2, l’agent de préparation est **Pi** (remplaçant Vibe). Voir [ADR 0011 : Remplacer Vibe par Pi/Codex pour la V2](../0011-replace-vibe-with-pi-codex-for-v2.md).

Pour la cible V2, un même agent enchaîne `grill-with-docs` → `to-spec` → `to-tickets`, afin de conserver les nuances de l’entretien lors de la rédaction de la spec et du découpage du travail. Chaque tâche d’implémentation est ensuite confiée à un agent dans son propre environnement isolé. Ce choix privilégie la continuité du contexte pendant la préparation et l’isolation des changements pendant l’implémentation, plutôt qu’un nouvel agent à chaque étape ou un agent unique pour tout le travail.

La préparation se déroule dans une conversation externe, conformément à [Limiter Slopify V2 à l’exécution des tâches d’implémentation](0007-limit-v2-to-implementation-tasks.md). La reprise après interruption et le format transmis aux implémenteurs restent ouverts. Aucun changement de code n’est effectué à ce stade.
