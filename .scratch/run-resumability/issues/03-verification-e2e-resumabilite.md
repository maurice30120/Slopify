# 03: Vérification e2e — EOF à une question puis reprise réussie

**What to build:** la démonstration réelle, sur le pipeline par défaut avec l'agent OpenCode sandboxé, que le scénario ayant exposé le bug (EOF à la première question d'interview) se termine désormais par un run reprenable et une reprise réussie.

**Blocked by:** 02.

**Status:** ready-for-agent

- [ ] Le pipeline par défaut tourne avec l'agent OpenCode sandboxé et stdin à EOF : l'agent produit sa première question d'interview, le CLI exit en l'affichant, et le guide de reprise apparaît sur stderr.
- [ ] Le snapshot persisté est « paused » (pause en attente conservée), sans diagnostic d'échec d'agent.
- [ ] `slopify resume <run-id>` avec stdin à EOF re-affiche la même question d'interview — preuve de reprise — puis exit proprement.
- [ ] Après ce second EOF, le run reste « paused » et reprenable : la reprise est idempotente.
- [ ] Non-régression : le workspace hôte reste inchangé (git propre exigé par le preflight au lancement, et inchangé après), aucune Sandbox orpheline laissée sans `--keep-sandboxes`.
