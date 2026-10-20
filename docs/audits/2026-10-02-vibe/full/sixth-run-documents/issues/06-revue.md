# 06 — Revue: Revue de code et validation finale pour la correction Docker Sandbox

**What to build:** Effectuer une revue complète de l'implémentation, des tests, et valider que tous les critères de la spécification sont satisfaits, que les tests passent, et que la solution est prête pour la production.

**Blocked by:** 05-tests (tests unitaires implémentés et passants)

**Status:** ready-for-agent

## Contexte
Ce ticket finalise le processus en effectuant une revue complète de tous les changements, en validant que l'implémentation répond à la spécification, et en s'assurant que la solution est robuste et prête.

## What it delivers
- Revue de code complète de l'implémentation
- Validation que tous les tests passent
- Vérification de la conformité avec la spécification
- Validation de la compatibilité ascendante
- Approbation finale pour fusion

## Checklist de revue

### 1. Revue de l'implémentation
- [ ] La méthode `assertSuccess` est correctement modifiée
- [ ] Le format des messages d'erreur correspond à la spécification
- [ ] Tous les cas de figure sont gérés (both, stdout only, stderr only, neither)
- [ ] Le préfixe `Unable to <action>: ` est conservé
- [ ] Le fallback vers `exit code N` fonctionne correctement

### 2. Revue des tests
- [ ] Tous les 5 cas de test sont implémentés
- [ ] Les tests utilisent correctement `fakeExecutor`
- [ ] Les tests valident le format exact des messages
- [ ] Les tests couvrent tous les scénarios spécifiés
- [ ] Les tests existants continuent de passer

### 3. Validation technique
- [ ] Le code compile sans erreurs TypeScript
- [ ] Tous les tests unitaires passent (`npm test`)
- [ ] Aucune régression dans le comportement existant
- [ ] Les interfaces publiques sont inchangées
- [ ] Le schéma des diagnostics est inchangé

### 4. Validation de la spécification
- [ ] L'implémentation correspond à la spécification technique
- [ ] Tous les critères d'acceptation sont satisfaits
- [ ] Les contraintes sont respectées
- [ ] La compatibilité ascendante est maintenue

## Validation commands
```bash
# Validation de la compilation
cd /Users/dhuyet/Documents/POC/Slopify/acp-sandbox
npm run build

# Exécution des tests
npm test

# Vérification des changements
cd /Users/dhuyet/Documents/POC/Slopify
git diff acp-sandbox/src/runtime.ts
```

## Public seam
- Fichiers modifiés : `acp-sandbox/src/runtime.ts`, `acp-sandbox/test/runtime.test.ts`
- Méthode : `DockerSandboxRuntime.assertSuccess()`
- Tests : Suite complète dans `runtime.test.ts`
- Validation : `npm test` dans `acp-sandbox`

## Critères de succès final
- [ ] Tous les tickets précédents sont complétés
- [ ] Revue de code approuvée
- [ ] Tous les tests passent
- [ ] Solution prête pour la fusion