# Audit du pipeline full avec Vibe Sandbox

Le dépôt était propre au commit 90d277e avant le premier lancement réel.

Run f0ff33e9-7d2f-40ed-9131-85194f836c4e : échec au grill, malformed_interview_output (4 blocs proposed_plan). La sortie Vibe JSON contient le prompt et les effets outils. Le bridge publiait ce transcript complet au lieu de la dernière réponse assistant. Le test acpBridge.test.ts reproduit le défaut. La correction conserve stdout brut dans les diagnostics et ne publie que la dernière réponse assistant via ACP.

Le pilote répond aux questions et examine les promotions, conformément à la demande utilisateur.

Deuxième run a0c8a8e9-656b-4eb4-a296-a425a561e866 : grill valide mais répétition identique après réponse. Cause : le runtime passait le checkpoint du tour terminé comme resumeSandboxRun au tour suivant. Correction : pour les entretiens, seules les exécutions non checkpointées sont récupérées ; chaque nouveau prompt avec historique ou réparation est réellement exécuté. Le test pipeline reproduit cette frontière avec workspace-write et un checkpoint durable.

Troisième run e8e5c287-5753-4bab-9a40-7cf98fd39385 : ReadTimeout Mistral après environ 12 minutes, payload 118427 caractères, sans status HTTP ni request id. Cause réseau/fournisseur non déterminée; relance avec lectures ciblées.

Quatrième run 09bcd50a-635e-43ad-a694-8da9b5b88bbe : question et réponse réellement exécutées; plan ready obtenu. Échec collecte checkpoint non-fast-forward : les commits techniques de deux tours issus de la même base sont frères. Correction fetch forcé strictement sur la référence privée refs/slopify/checkpoints, sans mutation de branche hôte. Test de régression sur deux appels du runtime avec même identité et nouveau prompt.
