# Slopify

## Agent skills

### Issue tracker

Issues et specs trackées dans GitHub Issues du repo (CLI `gh`). Voir `docs/agents/issue-tracker.md`.

### Triage labels

Les cinq rôles canoniques, libellés par défaut. Voir `docs/agents/triage-labels.md`.

### Domain docs

Single-context : glossaire dans `CONTEXT.md` (section Language), ADR dans `docs/adr/`. Voir `docs/agents/domain.md`.

### Lancement de lots Slopify

Préparer, lancer, suivre et reprendre un lot d'implémentation passe par le guide du coordinateur. Voir `docs/agents/coordinator-pi.md`.

### Sécurité des tests et smoke tests

Voir `docs/testing.md`. Exécuter en priorité des tests ciblés puis `npm test`.
Chaque processus lancé dans un test doit être attendu/nettoyé (enregistrer `t.after`).
La CI reste sans Docker ni appels fournisseurs. Les smoke réels Pi/Codex
(`npm run smoke:local` ou `npm run smoke:docker`) se lancent seulement manuellement
sur le poste du développeur. Face à `Cannot fork`/`pthread_create` : arrêter les
relances, pousser la PR et utiliser ses contrôles CI.
