# 01: ADR et glossaire — la mort du processus hôte ne termine jamais un Pipeline Run

**What to build:** un futur contributeur qui découvre un run laissé en pause par un CLI mort comprend, depuis l'ADR initial du repo et le glossaire, pourquoi ce run reste reprenable et pourquoi la sortie du processus ne le cancelle pas.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Un ADR numéroté 0001 sous `docs/architecture/adr/` énonce l'invariant : seules les décisions explicites de l'utilisateur (approbation, rejet, réponse finale, Cancellation volontaire) terminent un Pipeline Run ; la fin du processus hôte, gracieuse ou brutale, ne modifie jamais son statut persisté.
- [ ] L'ADR documente le trade-off accepté : l'état des runs abandonnés s'accumule dans le run store (c'est déjà le cas d'un SIGKILL aujourd'hui), sans fuite de Sandbox — la rétention est déjà par tour d'agent et pilotée par l'utilisateur via `--keep-sandboxes`.
- [ ] L'ADR documente les deux alternatives rejetées : rendre les runs « cancelled » reprenables quand une interview est active (deux saveurs invisibles de Cancellation, en tension avec le glossaire), et un statut « interrupted » distinct (un nouveau concept pour un état que « paused » décrit déjà).
- [ ] L'entrée « Reprise » est ajoutée à `CONTEXT.md` : reprise d'un Pipeline Run en Pause ou interrompu par la fin du processus hôte, depuis son état persisté ; la fin du processus hôte ne modifie jamais le statut d'un run.
- [ ] Aucune contradiction introduite avec les définitions existantes (Cancellation, Promotion, Rejection restent définies au niveau où elles le sont déjà).
