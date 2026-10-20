---
status: proposed
---

# Exécuter les Workers V2 dans Docker Engine

Docker Engine classique est l'option retenue pour une éventuelle intégration réelle du candidat Control Plane : chaque Worker aurait un clone privé et exécuterait Pi via son protocole RPC. Le prototype d'architecture utilise d'abord des Workers simulés pour évaluer la réconciliation et leur occupation. L'adoption en V2 dépend du résultat de cette expérimentation.

Si ce candidat est adopté, cette décision remplacera le choix de runtime de l'[ADR 0001](0001-replace-sandcastle-with-docker-sandboxes.md). Les politiques réseau globales de `sbx` choisies par l'[ADR 0005](0005-use-docker-sandboxes-global-network-policies.md) ne s'appliqueront pas aux essais Docker Engine.

Le premier livrable utilise un réseau bridge Docker avec accès sortant Internet, sans port publié ni partage du réseau hôte. Il ne reproduit pas le filtrage par domaine de `sbx`.

Les Workers disposent d'une configuration Pi dédiée et reçoivent explicitement les clés API nécessaires aux providers retenus. Le montage complet de la configuration Pi personnelle est exclu ; le support OAuth et des abonnements utilisables depuis Pi est reporté. Les montages supplémentaires des Workers restent à préciser.

L'intégration des résultats conserve la frontière de l'[ADR 0010](0010-integrate-tasks-in-dedicated-branch.md) : Slopify alimente une branche d'intégration dédiée et l'utilisateur décide de récupérer le résultat dans sa branche de travail.
