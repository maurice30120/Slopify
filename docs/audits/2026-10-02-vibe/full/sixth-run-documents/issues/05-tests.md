# 05 — Tests: Ajouter tests unitaires pour assertSuccess avec fakeExecutor

**What to build:** Ajouter des tests unitaires complets dans `acp-sandbox/test/runtime.test.ts` pour valider le comportement corrigé de la méthode `assertSuccess` en utilisant `fakeExecutor` pour simuler différents scénarios de résultats de sous-processus.

**Blocked by:** 04-implementation (implémentation corrigée)

**Status:** ready-for-agent

## Contexte
Ce ticket ajoute une suite de tests dédiée pour valider que la méthode `assertSuccess` gère correctement tous les cas de figure pour stdout et stderr, sans nécessiter d'exécution Docker réelle.

## What it delivers
- Suite de tests complète pour `assertSuccess` dans `acp-sandbox/test/runtime.test.ts`
- Tests utilisant `fakeExecutor` pour simuler différents scénarios
- Validation de tous les cas spécifiés dans la spécification technique

## Test cases à implémenter

### 1. Les deux flux présents (stdout et stderr)
- **Setup** : `fakeExecutor` retourne `{exitCode: 1, stdout: "output", stderr: "error"}`
- **Expected** : Message d'erreur contient `[stderr] error` et `[stdout] output`

### 2. Seulement stdout présent
- **Setup** : `fakeExecutor` retourne `{exitCode: 1, stdout: "output", stderr: ""}`
- **Expected** : Message d'erreur contient `[stdout] output` seulement

### 3. Seulement stderr présent
- **Setup** : `fakeExecutor` retourne `{exitCode: 1, stdout: "", stderr: "error"}`
- **Expected** : Message d'erreur contient `[stderr] error` seulement

### 4. Aucun flux présent (fallback)
- **Setup** : `fakeExecutor` retourne `{exitCode: 1, stdout: "", stderr: ""}`
- **Expected** : Message d'erreur contient `exit code 1`

### 5. Succès inchangé (pas d'erreur)
- **Setup** : `fakeExecutor` retourne `{exitCode: 0, stdout: "output", stderr: ""}`
- **Expected** : Pas d'erreur levée, exécution normale

## Implementation details

### Utilisation de l'infrastructure existante
- Utiliser la fonction `fakeExecutor` existante (ligne 38-47)
- Utiliser la fonction `result` existante (ligne 34-36)
- Créer une nouvelle suite de tests : `test('assertSuccess error message formatting', async (t) => {...})`

### Structure du test
```typescript
test('assertSuccess error message formatting', async (t) => {
  await t.test('includes both stdout and stderr when both present', async () => {
    // Implémentation du test
  });
  
  await t.test('includes only stdout when stderr is empty', async () => {
    // Implémentation du test
  });
  
  await t.test('includes only stderr when stdout is empty', async () => {
    // Implémentation du test
  });
  
  await t.test('falls back to exit code when both streams are empty', async () => {
    // Implémentation du test
  });
  
  await t.test('does not throw on success (exitCode 0)', async () => {
    // Implémentation du test
  });
});
```

## Acceptance criteria
- [ ] Tous les 5 cas de test implémentés et passent
- [ ] Tests utilisent `fakeExecutor` pour éviter Docker réel
- [ ] Tests valident le format exact des messages d'erreur
- [ ] Tests valident le comportement de fallback
- [ ] Tests valident que le succès ne lève pas d'erreur

## Validation command
```bash
cd /Users/dhuyet/Documents/POC/Slopify/acp-sandbox
npm test
```

## Public seam
- Fichier de test : `acp-sandbox/test/runtime.test.ts`
- Fonctions utilitaires : `fakeExecutor`, `result` (existantes)
- Méthode testée : `DockerSandboxRuntime.assertSuccess()`