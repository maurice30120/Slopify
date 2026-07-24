# PROTOTYPE JETABLE — Codex dans Docker Sandbox

## Question

Est-ce que Slopify peut lancer Codex sans interaction dans une sandbox `sbx
--clone`, créer lui-même un checkpoint Git après l'exécution de l'agent, puis
récupérer et prévisualiser ce checkpoint depuis l'hôte sans modifier le
workspace hôte ?

## Exécution

```bash
npm run prototype:docker-sandbox-codex
```

Le prototype crée `slopify-prototype-codex`, demande à Codex d'ajouter un
fichier marqueur dans le clone privé, crée un commit technique, fetch le remote
`sandbox-slopify-prototype-codex`, puis affiche le diff. Il conserve la sandbox
pour diagnostic et imprime les commandes d'inspection et de suppression.

La sandbox portant ce nom ne doit pas déjà exister. Le fichier marqueur ne doit
pas exister dans le workspace hôte.

## Verdict du parcours du 24 juillet 2026

Le parcours fonctionne avec `sbx version` v0.35.0 et Codex CLI 0.142.4 :

- `sbx create --clone` crée un clone privé et ajoute automatiquement un remote
  hôte `sandbox-<name>` ;
- `codex exec --dangerously-bypass-approvals-and-sandbox --ephemeral --json`
  fonctionne sans interaction dans la microVM ;
- Codex peut laisser des changements non commités, puis Slopify peut configurer
  une identité Git dédiée et créer le checkpoint technique ;
- `git fetch sandbox-<name>` expose le checkpoint et permet de calculer son diff
  sans changer le HEAD ni les fichiers du workspace hôte.

Deux détails doivent entrer dans la spec : la commande de version est `sbx
version` (et non `sbx --version`), et stdin doit être fermé pour l'exécution
non interactive de Codex.
