# 05: Revue finale Standards/Spec du lot

**What to build:** la vérification finale du lot : typechecking complet,
suite de tests complète du monorepo, et revue Standards/Spec du résultat
combiné des quatre tickets de génération de tests, depuis le commit de base
du run. Cette tâche bloque la réussite du run si elle échoue.

**Blocked by:** 01, 02, 03, 04

**Status:** ready-for-agent

- [ ] Le typechecking complet du monorepo passe.
- [ ] La suite de tests complète du monorepo passe.
- [ ] La revue Standards vérifie le respect des standards du repo depuis le
      commit de base du run, avec preuves des commandes réellement exécutées.
- [ ] La revue Spec vérifie la conformité à la spec approuvée (quatre
      fichiers de tests dédiés, aucun changement de code de production).
- [ ] Tout écart constaté est signalé explicitement comme échec vérifié,
      avec les preuves observées (sorties réelles, chemins d'évidence), sans
      déduction depuis les messages de commit.

**Interfaces de test approuvées :**

- Aucune interface nouvelle : cette tâche ne fait que vérifier ; tout écart
  est un échec signalé, pas une correction.
