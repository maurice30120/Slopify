# Prompts embarqués — workflows `implement` et `code-review`

Ce répertoire embarque les workflows officiels `implement` et `code-review` extraits
du dépôt [mattpocock/skills](https://github.com/mattpocock/skills), avec toutes leurs
dépendances transitives, pour les tickets #184 et #193. Les textes restent en anglais
original. L'extraction a été réalisée ponctuellement par un agent : il n'existe ni
importateur, ni générateur, ni mécanisme de mise à jour automatique.

## Provenance

- Source : `https://github.com/mattpocock/skills`, répertoire `skills/engineering/`.
- Révision exacte : commit `5863806dd4e15c63174bee4e7515a4256792ecfa`
  (« Merge pull request #1416 from mattpocock/software-factory-task-wording », 2026-11-12).
- Inventaire machine : [`inventory.json`](inventory.json) (source, rôles, dépendances,
  ressources partagées, adaptations) — lu par la commande `slopify prompts`.

## Arborescence

- `skills/` — **le bundle livré** : arborescence et noms upstream conservés
  (`engineering/implement`, `engineering/tdd`, `engineering/codebase-design`,
  `engineering/code-review`). C'est ce que la CLI distribue et affiche, et ce que les
  runners doivent rendre accessible aux agents.
- `upstream/` — copie **pristine** de l'extraction à la révision ci-dessus, conservée
  comme référence de comparaison. Elle n'est jamais modifiée localement.
- `patches/` — diffs lisibles `upstream → skills/` documentant chaque adaptation
  Slopify, fichier par fichier.
- `inventory.json` — inventaire explicite (voir ci-dessus).

Tout fichier de `skills/` non listé dans `adaptations` de `inventory.json` doit rester
identique octet par octet à sa contrepartie `upstream/` (vérifié par les tests).

## Points d'entrée et dépendances

- **Rôle implémenteur** : `skills/engineering/implement/SKILL.md`.
  Dépendances transitives : `tdd/SKILL.md` (conditionnel : « where possible, at
  pre-agreed seams ») puis `tdd/tests.md`, `tdd/mocking.md` ;
  `codebase-design/SKILL.md` (conditionnel : quand la forme de l'interface testée est
  elle-même en question) puis `DEEPENING.md`, `DESIGN-IT-TWICE.md` ; référence
  informationnelle à `code-review/SKILL.md` (point d'entrée du rôle reviewer).
- **Rôle reviewer** : `skills/engineering/code-review/SKILL.md`. Revue à deux axes
  (Standards, Spec) en sous-agents parallèles, agrégation distincte ; la baseline de
  code smells est incluse dans le fichier. Dépendances embarquées : aucune.
- **Ressources partagées** (dédupliquées, un seul exemplaire) :
  `code-review/SKILL.md` (point d'entrée reviewer, aussi référencé par `tdd`) et
  `codebase-design/SKILL.md` (vocabulaire partagé).
- **Dépendances fournies par le projet cible, non embarquées** (les références restent
  dirigées vers ce projet) : le doc du issue tracker (`docs/agents/issue-tracker.md`),
  `GLOSSARY.md` s'il existe, les ADR de la zone touchée, les fichiers de standards du
  dépôt revu, et le skill de setup `/setup-matt-pocock-skills` mentionné comme repli.

Les fichiers `agents/openai.yaml` présents en amont ne sont pas embarqués : ce sont des
métadonnées d'interface propres à une plateforme, pas des instructions de workflow.

## Adaptations Slopify (les seules)

1. **Séparation des rôles** (`patches/implement.patch`) : le point d'entrée
   implémenteur ne déclenche plus la revue indépendante — le Controller Slopify
   démarre le reviewer séparément. TDD, validations et sous-agents internes sont
   conservés.
2. **Lecture des ressources embarquées** (`patches/tdd.patch`, partie de
   `patches/implement.patch`) : les appels au Skill tool deviennent des instructions de
   lecture/application des fichiers embarqués ; les dépendances conditionnelles restent
   conditionnelles.
3. **Commit avant revue et constats seuls** (`patches/implement.patch`,
   `patches/code-review.patch`, cf. ADR 0001) : l'implémenteur valide et commite avant
   de se déclarer terminé et prend en charge les corrections ; le reviewer produit des
   constats sans modifier le code ni commiter.

## Inspection

`slopify prompts` (lecture seule) affiche l'inventaire ; `slopify prompts implementer`
et `slopify prompts reviewer` affichent les prompts exacts ;
`slopify prompts <chemin dans skills/>` affiche n'importe quelle ressource embarquée ;
`slopify prompts --check` vérifie que toutes les ressources déclarées existent, que
chaque fichier du bundle est déclaré et que les références Markdown internes résolvent.

## Mise à jour manuelle (procédure)

1. Cloner `mattpocock/skills` et noter le nouveau commit.
2. Comparer `upstream/engineering/` avec `skills/engineering/` de la nouvelle révision
   (`diff -ru`) pour identifier les changements amont des fichiers embarqués.
3. Mettre à jour `upstream/` avec les fichiers concernés, puis réappliquer les
   adaptations de `patches/` dans `skills/` (ne jamais écraser silencieusement :
   chaque adaptation passée est revue avant d'être réappliquée).
4. Régénérer les fichiers de `patches/` et mettre à jour `inventory.json` (commit
   source, dépendances, adaptations).
5. Contrôler les références entre skills : `slopify prompts --check`, puis exécuter les
   tests de packaging et de CLI (`npm run build && npm test -w slopify`).
