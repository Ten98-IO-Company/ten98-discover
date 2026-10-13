# M03 campaign — single bounded repair

Use verified Kimi K3 maximum thinking. Load supplied Ponytail and UX Copy Refiner. Skill-only: no shell/filesystem/network/subagents/provider/DB/publication. ONE repair with a120-second process deadline, then stop for GPT review; no further retry or scope expansion. Return only bare JSON {"replacements":[{"id":"R1","new":"exact replacement"}, ...]} including every supplied ID once. Empty replacement strings are permitted. GPT applies and independently tests.

Allowlist: src/components/MetaCampaignView.tsx, only these exact supplied spans. Every other byte stays unchanged. No tests, dependencies, controllers, props, helpers, state or other file edits.

Fix only the lost selected-mode label when summary is null. R1 keeps the supplied latestAttempt paragraph exact, then adds a separate paragraph gated by known && ready using the SAME showingLatest ternary and exact Latest complete inventory / Selected history receipt text from R2. It must remain visible with a null summary, just as before redesign. R2 becomes the empty string, removing the inner duplicate from the snapshot card. Preserve all other source bytes, data, callbacks, guards, layout and native disclosures. No new helper or state.

Public originals, SHA256 over exact UTF-8 strings:

```json
[
  {
    "id": "R1",
    "sha256": "cde39de18425c583863ee7b82415c7c93d49421781158193140cef7a645261b0",
    "original": "      {known && ready && latestAttemptLabel !== '' && <p className=\"hint\">{latestAttemptLabel}</p>}"
  },
  {
    "id": "R2",
    "sha256": "31d72c92f959de84f6008c2be33a169fab93415985d8ffa34efe37c00a8124a3",
    "original": "          <p className=\"hint\">{showingLatest ? 'Latest complete inventory' : 'Selected history receipt'}</p>"
  }
]
```
