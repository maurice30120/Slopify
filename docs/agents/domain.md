# Domain Docs

Comment les skills d'ingénierie consomment la documentation de domaine de ce repo pendant l'exploration du code.

## Avant d'explorer, lire

- **`CONTEXT.md`** à la racine du repo : sa section `Language` tient le rôle de glossaire (vocabulaire V1/V2, avec les synonymes à éviter pour chaque terme).
- **`docs/adr/`** : lire les ADR qui touchent la zone sur le point d'être modifiée.

Si ces fichiers n'existent pas, **continuer en silence**. Ne pas signaler leur absence ; ne pas en proposer la création upfront. La skill `/domain-modeling` (atteinte via `/grill-with-docs`) crée les entrées paresseusement quand des termes sont réellement résolus — dans ce repo, un terme résolu est ajouté à la section `Language` de `CONTEXT.md`, pas dans un `GLOSSARY.md` séparé.

## Structure

Single-context :

```
/
├── CONTEXT.md        ← glossaire (section Language)
└── docs/adr/         ← décisions système numérotées
```

## Utiliser le vocabulaire du glossaire

Quand une production (titre d'issue, proposition de refactor, nom de test) nomme un concept du domaine, utiliser le terme tel que défini dans `CONTEXT.md`. Ne pas glisser vers les synonymes que la section `Language` marque explicitement à éviter.

Si le concept nécessaire n'y figure pas, c'est un signal : soit un langage que le projet n'utilise pas (reconsidérer), soit un vrai manque (le noter pour `/domain-modeling`).

## Signaler les conflits d'ADR

Si une production contredit une ADR existante, le dire explicitement plutôt que de passer outre en silence :

> _Contredit l'ADR-NNNN (...), mais vaut la peine d'être rouverte parce que..._
