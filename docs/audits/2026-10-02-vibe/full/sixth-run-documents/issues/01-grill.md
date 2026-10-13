# 01 — Grill: Format du message d'erreur pour les diagnostics Docker Sandbox

**What to build:** Décider du format optimal pour les messages d'erreur quand les commandes Docker Sandbox échouent, en particulier comment présenter stdout et stderr de manière claire et utile pour le débogage.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

## Contexte
La méthode `assertSuccess` actuelle dans `acp-sandbox/src/runtime.ts:679-683` utilise `result.stderr.trim() || result.stdout.trim()` qui masque stdout quand stderr est présent.

## Question matérielle
Quel format utiliser pour le message d'erreur quand les deux flux (stdout et stderr) sont présents ?

Options à discuter :
- **Labels explicites** : `[stderr] <contenu>\n[stdout] <contenu>`
- **Simple concaténation** : `<stderr>\n<stdout>`
- **Format structuré** : JSON ou autre format machine-readable

## Décision attendue
Le pilote doit répondre avec le format préféré, en tenant compte de :
- Lisibilité humaine pour le débogage
- Consistance avec les messages d'erreur existants
- Facilité d'analyse automatique si nécessaire

## Acceptance criteria
- [ ] Format du message d'erreur validé par le pilote
- [ ] Décision documentée dans la spécification
- [ ] Impact sur l'interface publique confirmé comme nul

## Public seam
- Fichier : `acp-sandbox/src/runtime.ts:679-683` (méthode `assertSuccess`)
- Validation : vérification manuelle du format dans les tests unitaires