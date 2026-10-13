# M03 import — single bounded repair

Use verified Kimi K3 maximum thinking. Load supplied Ponytail and UX Copy Refiner. Skill-only: no shell/filesystem/network/subagents/provider/DB/publication. ONE repair with a120-second process deadline, then stop for GPT review; no further retry or scope expansion. Return only bare JSON {"replacements":[{"id":"R1","new":"exact replacement"}, ...]} including every supplied ID once. Empty replacement strings are permitted. GPT applies and independently tests.

Allowlist: src/components/MetaImportView.tsx, only these exact supplied spans. Every other byte stays unchanged. No tests, dependencies, controllers, props, helpers, state or other file edits.

Fix only duplicate No sources on this page in the successful first empty-page branch. R1 adds a React fragment around the existing ELSE branch, before its source-selector row. R2 keeps the original row closing and settled-empty condition/paragraph unchanged, moves that paragraph INSIDE the same ELSE branch, then closes the fragment and conditional. The first empty branch already has exactly one paragraph and role-aware help; keep it unchanged. All source fields, pagers, their guards/callbacks and existing settled/error/loading conditions remain unchanged. R3 and R4 only restore a newline between adjacent replaced subtrees; retain their exact non-whitespace text. No helper/state/new conditions or other styling/behavior edits.

Public originals, SHA256 over exact UTF-8 strings:

```json
[
  {
    "id": "R1",
    "sha256": "27343b8b19353441887a3cbadb60d38081f612e0b7bf247b00bfce3872e11007",
    "original": "            ) : (\n            <div className=\"row\" style={{ alignItems: 'end' }}>"
  },
  {
    "id": "R2",
    "sha256": "c2d0292b30d7017ddd3b62e8f815889e10f8566593051028fe9aa29f4f6f586d",
    "original": "            </div>\n            )}\n            {props.loaded && !props.reading && props.error === '' && props.sources.length === 0 && (\n              <p className=\"hint\">No sources on this page.</p>\n            )}"
  },
  {
    "id": "R3",
    "sha256": "03a0eb8cbeecd87f570236387d38e750a28a1a2df55120958f634017ce51b0af",
    "original": "          </div>          {props.selectedSourceId !== '' && ("
  },
  {
    "id": "R4",
    "sha256": "c5d42f360c3bc4c297b79cb176e648bd53d84460fa8a1d5fb2abd2279b622f2b",
    "original": "          )}          {summary !== null && ("
  }
]
```
