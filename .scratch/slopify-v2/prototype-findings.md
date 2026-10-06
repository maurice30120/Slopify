# Conclusions vérifiées du prototype — 6 octobre 2026

Ce document constitue une synthèse des traces déjà produites. Il ne déclare pas le prototype conforme au parcours complet et ne remplace pas la vérification multi-tâches prévue pour la V2.

## État de la source

Le chat de prototype est terminal avec le statut `systemError` après atteinte d’une limite d’usage. Son dernier appel d’exécution enregistré a néanmoins terminé l’essai Pi natif avec le code zéro. Le compte rendu annoncé dans le plan n’a pas été écrit dans le worktree du prototype. Aucun nouvel essai n’est lancé pour cette synthèse.

Les preuves restent dans `/private/tmp/slopify-v2-skills-20261006/evidence/`. Ce répertoire est temporaire ; ses chemins servent aux implémenteurs de cette session, pas à la configuration du produit.

## Codex

- La sonde affiche Codex `0.149.1`, Node `22.22.1` et 38 skills. `implement` est un lien vers le magasin `sbx` exposé en lecture seule ; une tentative d’écriture échoue avec `Read-only file system`.
- Le second essai a produit le commit `cd2438f13922429490f1d693e49b8214afaa7d1e` pour la petite fonction d’addition.
- Le rapport contient un test rouge sur deux nombres positifs, puis un test vert après implémentation, des validations supplémentaires pour négatifs/zéro et deux axes de revue native.
- La validation extérieure du second essai a le code zéro pour typechecking, tests et vérification du diff.
- Sources : `codex-retest-probe.stdout.log`, `codex-retest-probe.stderr.log`, `codex-retest-implement.stdout.log`, `codex-parallel-proof.json`, `codex-retest-verify.json`, `codex-retest-verify.stdout.log`, `codex-final-report.md`.

## Pi

- La sonde montre 38 skills montés en lecture seule et une racine fournie explicitement à Pi. Les chemins absolus du compte de l’utilisateur présents dans ce prototype doivent devenir des chemins découverts ou configurés dans le produit.
- Le kit Pi public a échoué sur une requête avec `x-api-key header is required`. La création d’un sandbox ne valide donc pas sa capacité à interroger le fournisseur.
- Un kit dédié utilisant l’image Pi, le service Mistral et l’injection du header Authorization par le proxy Docker a ensuite été validé et exercé ; aucun secret réel n’est nécessaire dans le manifeste.
- L’essai natif final a terminé avec le code zéro en 118,09 secondes. Le log contient un appel à l’extension `subagent` avec `mode: parallel` et deux résultats distincts `standards` / `spec`, chacun avec le code zéro.
- Le même log montre l’écriture initiale de trois tests, des corrections du harnais, puis trois tests rouges avant l’unique implémentation et trois tests verts ensuite. Ce parcours n’est pas le cycle unitaire red → green demandé par le skill TDD, même si le rapport final annonce l’absence de blocages.
- Le commit annoncé est `b0141a6` ; le rapport indique des validations réussies et les deux axes de revue. Ces déclarations doivent rester distinctes des observations des outils.
- La revue native indique l’absence de standards documentés alors que le contexte contient un `AGENTS.md`. Les reviewers doivent recevoir et lire explicitement les standards du dépôt, la spec complète et la baseline du skill ; leur disponibilité ne garantit pas leur utilisation.
- Sources : `pi-probe.stdout.log`, `pi-native-readiness.stderr.log` (échec du kit public), `../kit-pi-mistral/spec.yaml`, `pi-native-implement.json`, `pi-native-implement.stdout.log`.

## Erreurs de protocole déjà rencontrées

Un premier appel de revue Pi désignait `user` comme agent plutôt que comme portée : les deux sous-tâches ont échoué avec `Unknown agent`. L’appel suivant utilisant `standards` et `spec` a réussi en parallèle. Il faut vérifier les résultats individuels de la délégation, pas seulement le code de sortie du processus parent.

Une première revue Spec a déduit l’absence de TDD, tests et délégation du seul historique Git, sans recevoir les logs. Le résultat final d’un diff et un nom de commit ne suffisent ni à prouver ni à réfuter ces étapes. Les reviewers doivent recevoir les traces réelles et préciser ce qui n’a pas été observé.

Sources : `pi-subagent-proof.json`, `pi-final-report.md`, `pi-review.stdout.log`.

## Conséquences pour la V2

1. Pi et Codex sont les seuls agents cibles ; Vibe reste historique.
2. Préparer le fournisseur Pi et la délégation avant l’exécution ; ne pas considérer la seule création du sandbox comme préflight suffisant.
3. Exposer les skills officiels sans les modifier et sans chemin propre au prototype.
4. Rendre durables les logs et les comptes rendus, fournir leurs pointeurs aux reviewers et signaler les preuves absentes ou contradictoires.
5. Vérifier séparément graphe, waves, intégration Git, reprise, conflits, entrées issues et vérification finale : ces exigences restent non couvertes par l’addition d’une tâche unique.

## Baseline du dépôt

Avant toute implémentation produit de cette spec, `rtk npm test` a terminé avec le code zéro le 6 octobre 2026, sur le workspace actuel. Cette commande construit et teste les workspaces existants. Elle ne valide aucune exigence encore non implémentée de la V2.
