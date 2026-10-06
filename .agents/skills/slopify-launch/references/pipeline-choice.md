# Choix des niveaux Slopify

| Niveau | À choisir lorsque | Prérequis | Exclusion principale |
| --- | --- | --- | --- |
| `simple` | Une modification locale et claire doit être réalisée puis vérifiée. | Une demande directe et un périmètre identifiable. | Une décision de produit, plusieurs étapes dépendantes ou une revue indépendante sont nécessaires. |
| `moyen` | Une demande bornée doit être planifiée brièvement, implémentée puis revue. | Une demande compréhensible sans spécification ni découpage en tickets. | Une clarification approfondie, une spécification ou plusieurs tickets sont nécessaires. |
| `full` | Une nouvelle demande doit être clarifiée, spécifiée, découpée, implémentée puis revue. | Acceptation d’un flux long avec approbations et fichiers de suivi. | La modification est locale et évidente. |

## Compatibilité

- `grill-spec-tickets-implement-review` reste l’identifiant historique du
  niveau `full`.
- `implement-ticket` reste réservé à un ticket approuvé avec sa spécification.
- `review-delivery` reste réservé à une livraison existante à vérifier.

Un identifiant indisponible ne doit jamais être remplacé silencieusement par un
autre niveau.
