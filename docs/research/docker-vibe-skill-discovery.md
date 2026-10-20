# Docker Sandboxes et skills Mistral Vibe

Recherche du 6 octobre 2026, limitée aux sources officielles. Aucun agent payant lancé, aucune dépendance installée, aucun skill modifié. Le code public Vibe a été lu dans une archive temporaire au commit `7c19608af06f6c61d63f8f7a5c3430da73fba2ab` ; ce commit de `main` ne prouve pas le comportement d'une version installée différente.

## Copie dans un sandbox : documenté

`sbx cp SRC SANDBOX:/chemin/absolu` copie fichiers **et dossiers** depuis l'hôte. Si la destination est absente, elle est créée ; si elle est déjà un dossier, le dossier source est placé dedans. Il faut donc contrôler l'arborescence finale pour éviter un niveau `skills/skills`. `-L` suit les liens symboliques. Un côté doit être local ; pas de copie directe entre deux sandboxes. [Référence Docker `sbx cp`](https://docs.docker.com/reference/cli/sbx/cp/).

Les workspaces supplémentaires peuvent aussi être montés, notamment en lecture seule avec `:ro`, au même chemin absolu que sur l'hôte. C'est un mécanisme différent d'une copie isolée pour un run. [Docker : utilisation](https://docs.docker.com/ai/sandboxes/usage/).

Pour le cloud, `sbx --cloud cp` accepte les dossiers et effectue un transfert ponctuel, sans montage ni synchronisation. [Docker : sandboxes cloud](https://docs.docker.com/ai/sandboxes/cloud/usage/).

**Inférence pour Slopify V2 :** copier le dossier complet d'un skill, avec ses références et scripts, dans un emplacement découvert par Vibe est possible sans éditer son `SKILL.md`. La copie ne garantit pas que ses outils, dépendances ou chemins absolus soient utilisables dans l'environnement Linux. Une copie par run permet de conserver un instantané des instructions utilisées.

## Où Vibe découvre les skills

La documentation Mistral donne l'ordre suivant : `skill_paths` défini dans `config.toml`, skills de projet `./.vibe/skills/` ou `./.agents/skills/` dans un dossier trusted, puis `~/.vibe/skills/`. Les filtres `enabled_skills`/`disabled_skills` peuvent exclure un skill découvert. [Mistral : Skills](https://docs.mistral.ai/vibe/code/cli/skills).

Le code ajoute également `~/.agents/skills/` aux dossiers utilisateur. [Vibe : dossiers utilisateur, lignes 155–163](https://github.com/mistralai/mistral-vibe/blob/7c19608af06f6c61d63f8f7a5c3430da73fba2ab/vibe/core/config/harness_files/_harness_manager.py#L155). La découverte examine les sous-dossiers immédiats d'une racine et y cherche `SKILL.md` ; les doublons sont résolus selon les chemins prioritaires. `skill_paths` doit donc désigner la racine contenant `implement/SKILL.md`, plutôt que `implement/` directement. [Vibe : SkillManager](https://github.com/mistralai/mistral-vibe/blob/7c19608af06f6c61d63f8f7a5c3430da73fba2ab/vibe/core/skills/manager.py).

En mode programmatique, Vibe ne demande pas de faire confiance au dossier. `--trust` donne cette confiance pour l'invocation courante ; sans confiance, les configurations et skills de projet sont ignorés. Le skill officiel de référence explique ce comportement et documente aussi `VIBE_HOME`. [Vibe : référence embarquée](https://github.com/mistralai/mistral-vibe/blob/7c19608af06f6c61d63f8f7a5c3430da73fba2ab/vibe/plugins/builtins/vibe/skills/vibe/SKILL.md).

## `/implement` en mode non interactif

**Documenté publiquement :** `--prompt` lance une tâche programmatique puis quitte ; les skills invocables par l'utilisateur deviennent des commandes `/nom`. La page Skills présente surtout l'autocomplétion interactive, sans exemple explicite `vibe --prompt '/implement …'`. [Mistral : mode programmatique](https://docs.mistral.ai/vibe/code/cli/work-with-cli), [Mistral : Skills](https://docs.mistral.ai/vibe/code/cli/skills).

**Confirmé par lecture du code officiel au commit indiqué :** le runner programmatique envoie le prompt à `session.act(prompt)`, qui transmet un `turn/start`. [Runner](https://github.com/mistralai/mistral-vibe/blob/7c19608af06f6c61d63f8f7a5c3430da73fba2ab/vibe/cli/programmatic.py#L158), [session](https://github.com/mistralai/mistral-vibe/blob/7c19608af06f6c61d63f8f7a5c3430da73fba2ab/vibe/app_server/session.py).

Les deux backends traitent l'invocation au niveau du moteur, indépendamment du menu UI :

- Legacy : le début d'un message appelle `_inject_invoked_skill(user_msg)`, qui résout `/nom` et ajoute un appel et un résultat synthétiques de l'outil `skill`. [Agent loop, lignes 2031 et 2301](https://github.com/mistralai/mistral-vibe/blob/7c19608af06f6c61d63f8f7a5c3430da73fba2ab/vibe/core/agent_loop/_loop.py#L2031).
- Unified Harness : `start_turn` prépare les paramètres avec `inject_skill=True` ; `_resolved_invoked_skill` vérifie le nom et `user_invocable`, puis le corps du skill est ajouté au message. [Adaptateur, lignes 5354 et 6501–6590](https://github.com/mistralai/mistral-vibe/blob/7c19608af06f6c61d63f8f7a5c3430da73fba2ab/vibe/app_server/_unified_harness_backend_adapter.py#L5354).

**Conclusion de lecture du code :** `vibe --prompt '/implement …'` est bien une invocation explicite si le skill `implement` est découvert, valide, autorisé par les filtres et invocable par l'utilisateur. Si le nom manque ou `user-invocable: false`, le texte reste un prompt ordinaire. Ce support dépasse une simple commande slash UI ; il reste à valider sur la version Vibe réellement figée dans le template Docker.

## Séquence candidate à tester

Exemple conceptuel, non exécuté : destination choisie inexistante dans le sandbox et projet déjà présent à `/workspace/project`.

```sh
sbx exec slopify-run mkdir -p /workspace/project/.agents/skills
sbx cp ./skills/implement slopify-run:/workspace/project/.agents/skills/implement
sbx exec slopify-run vibe --workdir /workspace/project --trust --agent auto-approve --prompt '/implement Ajouter la fonctionnalité décrite dans task.md' --max-turns 5 --output json
```

`/workspace/project` est un exemple, pas un chemin Docker garanti. Le nom du skill et le chemin de travail doivent correspondre aux fichiers effectivement copiés. L'agent d'approbation est explicite : les sources Mistral divergent sur le défaut programmatique, et il ne faut pas en dépendre.

À tester ensuite sur le template choisi : versions `sbx`/Vibe, structure résultante de la copie, découverte avec `--trust`, preuve du chargement du skill dans l'historique JSON, absence de doublon masquant le skill, dépendances Linux et portée des outils autorisés. Aucun de ces tests d'exécution n'a été réalisé dans cette recherche.

## Vérification du kit utilisé par Slopify

Le 6 octobre 2026, `sbx kit inspect docker.io/sbx/vibe-kit:latest` et sa variante `--json` ont été exécutés sans lancer de modèle. Le manifeste public identifie un kit `vibe`, version `0.1.0`, schéma v2, utilisant `docker.io/sbx/vibe-image:latest`. Il lance Vibe avec `--trust --agent auto-approve` et déclare un volume `/home/agent/.vibe`. Aucun champ explicite de montage des skills n'apparaît dans ce manifeste ; l'inspection du kit ne prouve donc pas le montage effectué par le runtime Docker.

La commande `sbx ls --json` a trouvé un sandbox Vibe arrêté, créé le 13 septembre 2026. Il n'a pas été redémarré. La documentation Docker précise que le mode de partage des skills est fixé à la création : un ancien sandbox ne suffit pas à vérifier ce que fera une création avec la version actuelle. [Docker — Share agent skills](https://docs.docker.com/ai/sandboxes/workflows/agent-skills/).

La découverte de `.agents/skills` par Vibe est confirmée ; le montage effectif du magasin `sbx skills` dans un nouveau sandbox de ce kit reste à tester. Aucun skill n'a été installé et aucun sandbox n'a été créé pendant ces vérifications.
