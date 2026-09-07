# 01: Créer le script d'audit JSDoc

**What to build:** Un script maison `scripts/audit-docs.mjs` (compatible `node:test`, sans dépendance externe) qui analyse récursivement les fichiers `.ts` des cinq packages sous `*/src/`, détecte les symboles exportés (classe, interface, fonction, type) sans bloc JSDoc, les liste avec fichier et numéro de ligne, et échoue avec un code de sortie non nul dès qu'un symbole exporté n'est pas documenté. C'est la seam de test de la feature : elle rend le périmètre « public = exporté » vérifiable automatiquement.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Le script existe à `scripts/audit-docs.mjs` et s'exécute avec `node scripts/audit-docs.mjs` sans dépendance externe (compatible `node:test`)
- [ ] Il analyse récursivement les fichiers `.ts` sous `*/src/` des cinq packages, en excluant les fichiers `.test.ts`
- [ ] Il détecte les symboles exportés (`export` d'une classe, interface, fonction ou type) et vérifie qu'un bloc JSDoc (`/** ... */`) précède chacun
- [ ] En cas de défaut, il liste chaque symbole non documenté avec son fichier et sa ligne
- [ ] Il échoue (code de sortie non nul) si au moins un symbole exporté en scope n'a pas de JSDoc, et passe (0) quand la couverture est complète
- [ ] Il accepte d'être ciblé sur un package (ex. `node scripts/audit-docs.mjs acp-pipeline`) pour permettre une vérification incrémentale ticket par ticket