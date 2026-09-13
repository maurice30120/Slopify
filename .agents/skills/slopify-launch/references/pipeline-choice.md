# Guide de choix des pipelines Slopify

Cette matrice décrit les pipelines actuellement présents dans `.acp/pipelines/`.
La sortie de `slopify list --json` reste la vérification d’existence à utiliser
avant tout lancement ; ce document décrit l’intention, les prérequis et les
limites de chaque pipeline.

## Matrice

| Pipeline | À choisir lorsque | Prérequis | Ne pas choisir lorsque |
| --- | --- | --- | --- |
| `grill-spec-tickets-implement-review` | Une nouvelle demande doit être clarifiée, spécifiée, découpée en tickets, implémentée puis revue. | Demande nouvelle ; décisions de produit ou de domaine ; plusieurs fichiers, étapes ou tickets possibles ; acceptation d’un flux long et interactif. | La tâche est un changement local évident, un ticket existe déjà, ou seule une revue est demandée. |
| `implement-ticket` | Un ticket unique est déjà approuvé et prêt à être implémenté. | Un `.scratch/<feature>/spec.md` et le ticket Markdown correspondant existent ; le prompt contient exactement les chemins attendus. | La demande est encore à clarifier, le ticket n’existe pas, ou plusieurs tickets doivent être planifiés. |
| `review-delivery` | Une livraison existante doit être vérifiée par rapport à sa spécification et à ses tickets. | La spécification, les tickets et les changements à revoir existent déjà ; aucune modification de code n’est attendue. | L’utilisateur demande une implémentation, une correction ou l’ajout d’un test. |

## Règles de décision

1. Un pipeline explicitement nommé par l’utilisateur est conservé s’il est
   disponible. Signaler ses prérequis s’ils ne sont pas réunis ; ne pas le
   remplacer automatiquement.
2. Pour un ticket approuvé unique, préférer `implement-ticket` au pipeline
   complet.
3. Pour une revue sans modification, préférer `review-delivery`.
4. Pour une nouvelle demande non triviale nécessitant des décisions, une
   spécification ou plusieurs tickets, choisir
   `grill-spec-tickets-implement-review`.
5. Pour une petite demande sans ticket approuvé, ne pas présenter le pipeline
   complet comme un choix léger. Dire qu’aucun pipeline léger n’est disponible
   et demander à l’utilisateur de choisir entre le pipeline complet et une
   implémentation directe.
6. Si le pipeline demandé n’apparaît pas dans `list --json`, arrêter le routage
   et afficher les identifiants disponibles.

## Exemples de routage

- « Ajoute deux commentaires dans `workspaceRunPolicy.ts` » : demande simple ;
  pas de sélection silencieuse du pipeline complet.
- « Implémente `.scratch/auth/spec.md` et le ticket `T01` » :
  `implement-ticket`, si les deux fichiers existent.
- « Vérifie la livraison décrite par ce `spec.md` et ce dossier `issues/` » :
  `review-delivery`.
- « Lance explicitement `grill-spec-tickets-implement-review` » : respecter
  ce choix après vérification de sa disponibilité.
- « Lance `quick` » alors qu’il n’est pas listé : arrêter et signaler qu’il est
  indisponible ; ne pas substituer `grill-spec-tickets-implement-review`.
