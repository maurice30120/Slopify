# 02 — Spec: Spécification technique pour la correction des diagnostics Docker Sandbox

**What to build:** Documenter la spécification technique complète pour la correction de la méthode `assertSuccess` dans `acp-sandbox/src/runtime.ts`, incluant le format des messages d'erreur, les cas de test, et les contraintes d'implémentation.

**Blocked by:** 01-grill (décision sur le format du message)

**Status:** ready-for-agent

## Contexte
Basé sur la décision du grill (01-grill), ce ticket formalise la spécification technique pour l'implémentation.

## Spécification technique

### Format du message d'erreur
- Utiliser des labels explicites : `[stderr] <contenu>\n[stdout] <contenu>`
- Chaque flux est trimé et seulement les flux non-vides sont affichés
- Conserver le préfixe existant : `Unable to <action>: `
- Fallback : afficher `exit code N` quand aucun flux ne contient de contenu

### Modifications requises
- **Fichier cible** : `acp-sandbox/src/runtime.ts:679-683` (méthode `assertSuccess`)
- **Méthode** : `private assertSuccess(result: SubprocessResult, action: string): void`

### Logique de la nouvelle implémentation
```typescript
private assertSuccess(result: SubprocessResult, action: string): void {
  if (result.exitCode !== 0) {
    const parts: string[] = [];
    if (result.stderr.trim()) parts.push(`[stderr] ${result.stderr.trim()}`);
    if (result.stdout.trim()) parts.push(`[stdout] ${result.stdout.trim()}`);
    const detail = parts.length > 0 ? parts.join('\n') : `exit code ${result.exitCode}`;
    throw new Error(`Unable to ${action}: ${detail}`);
  }
}
```

## Contraintes
- **Interfaces publiques inchangées** : Pas de modification des interfaces exportées
- **Schéma des diagnostics inchangé** : Maintenir la compatibilité ascendante
- **Pas de dépendances supplémentaires** : Utiliser uniquement les fonctionnalités existantes

## Acceptance criteria
- [ ] Spécification technique validée et documentée
- [ ] Format du message d'erreur clairement défini
- [ ] Tous les cas d'utilisation identifiés et spécifiés
- [ ] Contraintes d'implémentation documentées

## Public seam
- Fichier source : `acp-sandbox/src/runtime.ts:679-683`
- Fichier de test : `acp-sandbox/test/runtime.test.ts`
- Validation : lecture de la spécification par les parties prenantes