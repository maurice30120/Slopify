# Brief de lancement v1

Exemple de fichier JSON ; remplacer toutes les valeurs par les décisions confirmées et la réponse réelle de `catalog --json` :

```json
{
  "contract": "slopify.launch-brief/v1",
  "objective": "Ajouter le contrôle d'expiration",
  "scope": ["Validation des jetons"],
  "constraints": [],
  "acceptanceCriteria": ["Un jeton expiré est rejeté"],
  "decisions": ["Conserver l'interface publique"],
  "confirmation": {"confirmed": true, "at": "2026-09-13T12:00:00Z"},
  "selection": {
    "pipeline": "quick",
    "criteria": ["Changement local", "Critère de validation explicite"],
    "catalogVersion": "1.0.0",
    "catalogDigest": "copier le digest retourné par catalog"
  }
}
```

Ajouter `selection.requestedPipeline` uniquement si l'utilisateur a imposé un pipeline ; sa valeur doit être identique à `selection.pipeline`. `confirmation.at` correspond à la confirmation réelle du brief. Le fichier est une attestation du skill, pas une preuve d'identité : ne jamais fabriquer cette confirmation. Les tableaux `constraints` et `decisions` peuvent être vides. Les critères de sélection sont une justification courte, sans raisonnement interne.
