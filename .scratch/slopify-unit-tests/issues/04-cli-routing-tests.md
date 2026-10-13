# 04: Tests unitaires pour le routage de la CLI

**What to build:** une suite de tests unitaires dédiée au point d'entrée de
la CLI, couvrant le routage des commandes : appel sans argument et `--help`
affichent l'aide générale et renvoient 0 ; `tasks` et `init` délèguent à
leurs sous-CLIs ; les commandes retirées (`list`, `run`, `resume`) et une
commande inconnue renvoient 1 avec le message documenté, sans stack trace.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Un fichier de test dédié couvre le routage de la CLI au seam public,
      sans toucher au code de production.
- [ ] Sans argument : l'aide générale est affichée et le code de sortie est 0.
- [ ] Avec `--help` ou `-h` : même comportement.
- [ ] `tasks` et `init` délèguent aux sous-CLIs correspondantes (arguments
      restants transmis), codes de sortie propagés.
- [ ] Chacune des commandes retirées `list`, `run`, `resume` renvoie 1 avec
      un message mentionnant les commandes V2 de remplacement.
- [ ] Une commande inconnue renvoie 1 avec un message d'erreur et l'aide,
      sans lever d'exception non capturée.
- [ ] La suite complète du paquet passe (compilation incluse) après ajout du
      fichier de test.

**Interfaces de test approuvées :**

- `main(argv?: string[]): Promise<number>` — entrée : arguments de la CLI
  (défaut : `process.argv.slice(2)`) ; sortie : code de sortie.
- Les tests passent un `argv` explicite et observent le code de retour et la
  sortie standard/erreur ; aucune dépendance à l'état global du processus
  n'est requise au-delà de la capture de la sortie.
