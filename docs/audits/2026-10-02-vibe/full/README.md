# Audit du pipeline full avec Vibe Sandbox

Le dépôt était propre au commit 90d277e avant le premier lancement réel.

Run f0ff33e9-7d2f-40ed-9131-85194f836c4e : échec au grill, malformed_interview_output (4 blocs proposed_plan). La sortie Vibe JSON contient le prompt et les effets outils. Le bridge publiait ce transcript complet au lieu de la dernière réponse assistant. Le test acpBridge.test.ts reproduit le défaut. La correction conserve stdout brut dans les diagnostics et ne publie que la dernière réponse assistant via ACP.

Le pilote répond aux questions et examine les promotions, conformément à la demande utilisateur.
