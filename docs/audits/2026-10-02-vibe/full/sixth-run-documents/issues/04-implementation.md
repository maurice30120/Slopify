# 04 — Implementation: Corriger assertSuccess dans DockerSandboxRuntime

**What to build:** Implémenter la correction de la méthode `assertSuccess` dans `acp-sandbox/src/runtime.ts` pour préserver les deux flux (stdout et stderr) dans les messages d'erreur quand les commandes Docker Sandbox échouent.

**Blocked by:** 03-tickets (structure des tickets validée)

**Status:** ready-for-agent

## Contexte
La méthode `assertSuccess` actuelle (ligne 679-683) utilise `result.stderr.trim() || result.stdout.trim()` qui masque stdout quand stderr est présent. Ce ticket implémente la solution pour afficher les deux flux.

## What it delivers
- Méthode `assertSuccess` modifiée pour inclure les deux flux dans les messages d'erreur
- Format des messages : `[stderr] <contenu>\n[stdout] <contenu>` avec labels explicites
- Comportement de fallback : `exit code N` quand aucun flux n'a de contenu
- Conservation du préfixe existant : `Unable to <action>: `

## Implementation details

### Fichier à modifier
- `acp-sandbox/src/runtime.ts:679-683`

### Nouvelle implémentation
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
- Ne pas modifier les interfaces publiques
- Ne pas changer le schéma des diagnostics
- Maintenir la compatibilité ascendante
- Utiliser uniquement les dépendances existantes

## Acceptance criteria
- [ ] Méthode `assertSuccess` modifiée selon la spécification
- [ ] Tous les cas d'erreur gèrent correctement stdout et stderr
- [ ] Le préfixe `Unable to <action>: ` est conservé
- [ ] Fallback vers `exit code N` fonctionne quand les deux flux sont vides
- [ ] Code compile sans erreurs TypeScript

## Validation command
```bash
cd /Users/dhuyet/Documents/POC/Slopify/acp-sandbox
npm run build
```

## Public seam
- Méthode : `DockerSandboxRuntime.assertSuccess()` (private)
- Fichier : `acp-sandbox/src/runtime.ts:679-683`
- Impact : Tous les appels à `assertSuccess` dans la classe