---
status: accepted
---

# Remplacer Vibe par Pi/Codex pour la V2

## Contexte

La conception initiale de Slopify V2 (ADR 0007-0010) mentionnait Vibe comme agent possible pour la coordination et l'implémentation. Cependant, après évaluation pratique et décision utilisateur, **Vibe est sorti du périmètre cible V2**.

Les ADR historiques 0008 ([Garder un même agent pour la préparation et isoler les implémenteurs](../0008-share-preparation-agent-isolate-implementers.md)) et 0009 ([Confier le lot à Slopify depuis Vibe](../0009-submit-task-batch-from-vibe.md)) décrivent un parcours où Vibe était envisagé comme coordinateur et implémenteur. Ces documents **restent valides comme historique** mais ne reflètent plus la cible V2.

## Décision

Pour la **cible V2** :

- **Pi** est le **seul coordinateur** : il prépare le lot, suit le run et présente le bilan
- **Pi et Codex** sont les **seuls agents d'implémentation** autorisés
- **Vibe est hors du périmètre V2** : il n'est ni coordinateur ni implémenteur dans la version cible

## Conséquences

### Ce qui change

1. **Coordinateur** : Pi (pas Vibe)
   - Pi lit les fichiers locaux ou les issues normalisées
   - Pi construit le lot JSON complet
   - Pi valide les prérequis avant soumission
   - Pi suit l'exécution et présente le bilan

2. **Implémenteurs** : Pi et Codex uniquement
   - Pas de support Vibe dans l'exécution V2
   - Les tests et l'intégration ne couvrent que Pi/Codex

3. **Documentation** :
   - Les références à Vibe dans les documents de conception sont marquées comme **historiques**
   - Les nouveaux documents (ex: [Guide du coordinateur Pi](../agents/coordinator-pi.md)) ne mentionnent pas Vibe

### Ce qui reste

1. **ADR 0007-0010** : Ces ADR restent **inchangées** comme documents historiques
   - Leur formulation mentionnant Vibe est conservée pour la traçabilité
   - Une note est ajoutée dans les documents de haut niveau pour clarifier la décision finale

2. **Essais Vibe** : Les essais historiques avec Vibe (ex: prototype) peuvent rester comme **historique**
   - Ils ne font pas partie de la validation V2
   - Ils ne sont pas utilisés pour les tests automatiques V2

3. **Fonctionnalités existantes** : Aucune modification du code existant n'est requise
   - Le code V1 peut continuer à fonctionner avec Vibe
   - La coexistence transitoire V1/V2 est maintenue

## Alternatives envisagées

1. **Conserver Vibe comme option** : Rejeté car l'utilisateur a explicitement retiré Vibe du périmètre V2
2. **Réécrire les ADR historiques** : Rejeté pour préserver la traçabilité des décisions
3. **Créer une nouvelle ADR qui annule les précédentes** : Rejeté car les ADR 0007-0010 restent valides pour leur contexte historique

## Justification

- **Simplicité** : Limiter à Pi/Codex réduit la complexité de test et de validation
- **Alignement utilisateur** : L'utilisateur a explicitement choisi Pi comme point d'entrée
- **Pratique** : Le prototype a montré que Pi avec kit Mistral fonctionne correctement
- **Historique** : Conserver les ADR originales permet de comprendre l'évolution du design

## Statut

**Accepté** - Décision utilisateur du 6 octobre 2026. Vibe reste historique, Pi/Codex sont les seuls agents V2.
