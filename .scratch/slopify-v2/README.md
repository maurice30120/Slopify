# Slopify V2 — préparation de l’implémentation

La [spec](spec.md) et les [tickets](issues/) sont approuvés. Les interfaces de test, la granularité et les dépendances ont été validées le 6 octobre 2026.

Graphe approuvé : T01 → T02 et T03 en parallèle → T04 → T05 → T06 → T07.

L’implémentation utilisera une branche d’intégration dédiée, des implémenteurs en worktrees séparés et un sous-agent de fusion, puis une revue indépendante Standards/Spec. Le workspace actuel contient des changements antérieurs de skills et de conception ; ils ne seront pas inclus indistinctement dans les commits de produit.

Les agents cibles du produit sont Pi et Codex. Vibe est hors du scope V2.

Les [conclusions vérifiées du prototype](prototype-findings.md) distinguent les observations réelles des déclarations des agents et documentent les écarts TDD/revue. La suite existante passe avant changements produit ; elle ne constitue pas une validation de la V2.
