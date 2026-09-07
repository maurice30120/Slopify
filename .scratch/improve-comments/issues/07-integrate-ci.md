# 07: Intégrer l'audit en CI et vérifier le workspace complet

**What to build:** Le script d'audit devient bloquant à la racine : un npm script root l'exécute sur tout le workspace et le workflow CI existant le lance à chaque push/PR, faisant échouer le pipeline dès qu'un symbole exporté d'un package en scope a été ajouté sans JSDoc. L'audit passe vert sur les cinq packages réunis, ce qui clôt la feature.

**Blocked by:** 02, 03, 04, 05, 06

**Status:** ready-for-agent

- [ ] Un npm script root (ex. `audit:docs`) exécute `scripts/audit-docs.mjs` sur tout le workspace
- [ ] `scripts/audit-docs.mjs` est branché au workflow CI existant et s'exécute lors de chaque push/PR
- [ ] Le pipeline CI échoue si l'audit détecte un symbole exporté non documenté, et passe quand la couverture est complète
- [ ] L'audit passe sans erreur sur l'ensemble des cinq packages réunis
- [ ] Le repo documente l'exigence JSDoc pour les symboles exportés là où il liste ses checks
- [ ] Aucun ESLint n'est introduit ; le script d'audit reste le seul garde-fou automatisé, la qualité rédactionnelle relevant de la revue manuelle