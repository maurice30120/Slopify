---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

If the user passes a ticket reference, fetch it from the issue tracker and state its title before starting. If the reference is ambiguous, ask.

Where possible, at pre-agreed seams, read and apply the embedded tdd skill at [tdd/SKILL.md](../tdd/SKILL.md).

Run typechecking regularly, single test files regularly, and the full test suite once at the end.

Validate your work, then commit it to the current branch before reporting done. When a review returns findings, you also handle the corrections: apply the findings, validate again, and commit again before reporting done.

Do not launch an independent review of your own work: the Controller starts the reviewer separately once your work is committed.
