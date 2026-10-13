---
status: accepted
---

# Limiter Slopify V2 à l’exécution des tâches d’implémentation

La frontière confirmée pendant la conception est que le pipeline d’implémentation reçoit des tâches déjà définies et leurs dépendances explicites. La préparation suit la chaîne `grill-with-docs` → `to-spec` → `to-tickets` : clarification du besoin et documentation des décisions, synthèse de la spec, puis découpage en tickets et approbation par l’utilisateur. Le pipeline orchestre ensuite l’exécution et l’intégration des résultats. Cette séparation permet de faire évoluer la préparation du travail sans maintenir un moteur de pipelines générique pour l’implémentation.

Pour la V2, la préparation est menée dans une conversation externe à Slopify. Slopify démarre uniquement avec les tickets approuvés et leurs dépendances ; il ne pilote pas l’entretien, la rédaction de la spec ou le découpage. Ce choix réduit le périmètre du refacto et permet aux skills de préparation d’évoluer indépendamment. Une entrée permettant de piloter le parcours complet pourra être envisagée ultérieurement, sans être un engagement pour la V2.

Cette décision décrit la cible V2 ; elle ne modifie pas le fonctionnement V1. Le format d’entrée des tâches reste à préciser pendant l’entretien.
