## Problem Statement

Le module de promotion Git de `acp-sandbox` expose des classes, interfaces, alias de type, méthodes publiques et fonctions utilitaires dont le rôle et l’intention ne sont pas suffisamment expliqués en français. Cette absence de documentation rend plus difficile la compréhension du transfert contrôlé des changements d’un Sandbox Run vers le workspace hôte, ainsi que la maintenance des invariants associés.

## Solution

Ajouter uniquement des commentaires explicatifs en français dans le module de promotion Git ciblé. Documenter le rôle et l’intention de chaque classe, interface, alias de type, méthode publique et fonction utilitaire, ainsi que les constantes exportées lorsque leur usage le nécessite. Les identifiants, messages, commentaires existants, signatures, logique et comportements restent strictement inchangés.

## User Stories

1. En tant que développeur, je veux comprendre le rôle de chaque classe de la promotion Git, afin de situer sa responsabilité dans le transfert contrôlé des changements.
2. En tant que développeur, je veux comprendre l’intention de chaque interface et alias de type, afin d’utiliser correctement les contrats du module.
3. En tant que mainteneur, je veux que chaque méthode publique explique son rôle et ses effets attendus, afin de préserver les invariants du cycle de Promotion.
4. En tant que mainteneur, je veux que chaque fonction utilitaire explique l’intention de son traitement, afin de pouvoir la modifier sans altérer le comportement existant.
5. En tant que contributeur, je veux que les commentaires ajoutés soient en français, afin d’assurer une documentation cohérente avec le vocabulaire du projet.
6. En tant que contributeur, je veux que les identifiants et messages existants restent inchangés, afin de ne pas modifier l’API ni les sorties observables.
7. En tant que mainteneur, je veux que les commentaires existants soient préservés, afin que cette documentation ciblée n’entraîne pas de réécriture cosmétique.
8. En tant que contributeur, je veux que le changement soit limité à des commentaires, afin de garantir l’absence de modification fonctionnelle.

## Implementation Decisions

- La portée est limitée au module de promotion Git de `acp-sandbox`.
- Les classes, interfaces, alias de type, méthodes publiques et fonctions utilitaires du module reçoivent des commentaires explicatifs en français décrivant leur rôle et leur intention.
- Les constantes exportées sont commentées lorsque cela clarifie leur usage ou leur impact dans le contrat du module.
- Les identifiants, messages existants, commentaires existants, imports, signatures, types, logique, ordre d’exécution et comportements ne sont pas modifiés.
- Aucun commentaire ne traduit ni ne renomme les identifiants ou les messages existants.
- Aucun autre fichier n’est créé ou modifié.
- La terminologie de domaine existante, notamment `Sandbox Run` et `Promotion`, est conservée lorsqu’elle est pertinente.

## Testing Decisions

- La seam de vérification est l’inspection du diff du module ciblé.
- Le diff doit contenir uniquement des ajouts ou modifications de commentaires ; aucune ligne de logique, signature, identifiant, message ou sortie existante ne doit changer.
- La relecture vérifie que chaque classe, interface, alias de type, méthode publique et fonction utilitaire est documenté, que les constantes exportées pertinentes le sont également, et que les commentaires ajoutés sont en français.
- Aucune modification ni aucun nouveau test n’est nécessaire pour ce changement documentaire.

## Out of Scope

- Toute modification de logique, comportement, sortie, signature, type, import ou structure d’exécution.
- La traduction ou la modification des identifiants, messages et commentaires existants.
- La documentation d’autres fichiers ou modules.
- La création de documentation externe, de tests ou de règles d’outillage.
- Toute refactorisation, correction fonctionnelle ou modification du format des sorties.

## Further Notes

Cette spécification est strictement documentaire. Le résultat attendu est un diff minimal qui ajoute des explications en français au module ciblé tout en conservant intégralement son comportement observable.
