# 04: Vérifier la portée documentaire et la terminologie

**What to build:** Relire et finaliser l’ensemble des commentaires révisés afin de livrer une documentation française concise et exacte, strictement limitée aux commentaires existants et aux enrichissements locaux indispensables dans le module hôte ciblé.

**Blocked by:** 01, 02, 03

**Status:** ready-for-agent

- [ ] Tous les commentaires ciblés sont en français clair, sans traduction des noms techniques, variables d’environnement ou événements ACP.
- [ ] La relecture confirme l’exactitude des invariants de cycle de vie, de Reprise, de journalisation, d’assainissement et de streaming par rapport à la spécification et aux ADR pertinents.
- [ ] Aucun commentaire exhaustif, commentaire de remplissage ou fichier documentaire supplémentaire n’est ajouté.
- [ ] Le diff final ne contient que des modifications de commentaires dans le module ciblé : aucun import, type, nom, signature, expression, ordre des opérations ou structure n’a changé.
- [ ] `git diff --check` et le contrôle TypeScript ciblé déjà disponible sont exécutés lorsque directement disponibles ; aucun nouveau test n’est créé.

