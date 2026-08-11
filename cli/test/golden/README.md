# Golden matrix

Frozen CLI observable baseline: exit code, stdout, stderr, and durable
`$YACO_HOME` state for every case in `cases.ts`, captured against the hermetic
sandbox in `fixture.ts`.

```bash
node test/golden/capture.ts --out test/golden/matrix.json
```

Two matrices are committed, and they are verified differently:

| File | Status | Verified by |
| --- | --- | --- |
| `matrix.original.json` | Historical artifact, captured on Bun **before** directory ordering was defined. Not reproducible — it records one machine's undefined `readdir` order. | Never recaptured. |
| `matrix.json` | The live baseline, captured **after** the sort landed under Bun. Runtime- and machine-independent — `cli-sqlite-hop` reproduced it byte-for-byte with a Node child and never recaptured it. | `golden.test.ts` recaptures and compares. |

`ordering-delta.test.ts` compares the two committed files: everything except
stdout line order must be identical, and at least one case must actually differ
in order — that pair is the evidence that the ordering change was ordering and
nothing else.

A matrix is only comparable to another with the same `casesDigest`. Changing
`cases.ts` changes the digest and requires recapturing `matrix.json`;
`matrix.original.json` cannot be recaptured, so a case-list change ends the
comparison rather than updating it.

Recapture `matrix.json` whenever a captured observable changes on purpose, and
name the case in `ordering-delta.test.ts`'s `INTENTIONAL_DELTAS` with the reason —
that file compares the two matrices, and a case that changed for a reason other
than ordering is no longer comparable. Exempting it by name keeps the comparison
strict everywhere else.

`install-dry-run-json` plans one action per shipped skill, so **adding or removing
a skill under `agent-config/global/skills/` requires a recapture** — an honest
coupling: the plan is the skill list.
