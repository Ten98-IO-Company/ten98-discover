# M03 latest — single bounded repair

Use verified Kimi K3 maximum thinking. Load supplied Ponytail and UX Copy Refiner. Skill-only: no shell/filesystem/network/subagents/provider/DB/publication. ONE repair with a120-second process deadline, then stop for GPT review; no further retry or scope expansion. Return only bare JSON {"replacements":[{"id":"R1","new":"exact replacement"}, ...]} including every supplied ID once. Empty replacement strings are permitted. GPT applies and independently tests.

Allowlist: src/components/MetaLatestView.tsx, only these exact supplied spans. Every other byte stays unchanged. No tests, dependencies, controllers, props, helpers, state or other file edits.

Fix only the missed compact header. R1 replaces the existing h2 with a wrapping row using className row and inline flexWrap wrap, gap var(--space-2), alignItems center, minWidth0. Keep the h2 text/id/tabIndex unchanged, add zero margin and marginInlineEnd auto. Move the TWO EXACT original buttons from R2 after the h2 inside this row, preserving all attributes/callbacks/disabled expressions byte-for-byte. R2 becomes the empty string, removing their old row. Intro, errors, loading, cancellation, profile, dates, tables and all other bytes are frozen. No other styling or behavior edits.

Public originals, SHA256 over exact UTF-8 strings:

```json
[
  {
    "id": "R1",
    "sha256": "a8321a9b2de94dba49876c95389b620fb40e0e9804ab8860b83fb669852d7e14",
    "original": "      <h2 id={headingId} tabIndex={-1}>Latest complete coverage</h2>"
  },
  {
    "id": "R2",
    "sha256": "4f3624240bfe6fe1ae82720526a306be57a87d798d8632c71f949856855630f2",
    "original": "      <div className=\"row\">\n        <button type=\"button\" className=\"btn\" style={btnStyle} onClick={props.onBack}>Back to imports</button>\n        <button type=\"button\" className=\"btn\" style={btnStyle} onClick={props.onReload} disabled={busy}>Reload coverage</button>\n      </div>"
  }
]
```
