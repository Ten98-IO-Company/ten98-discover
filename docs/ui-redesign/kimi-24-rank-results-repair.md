# Rank results — one bounded table-readability repair

Use Kimi K3 maximum thinking. Load Ponytail and UX Copy Refiner. Skill-only: no shell, filesystem, network, delegation, providers, DB or publication. ONE repair with a120-second deadline, then stop; no further attempt. Return only JSON {"replacements":[{"id":"R1","new":"exact replacement"}, ...]}; every supplied ID exactly once.

Only src/components/RankCheckResults.tsx, exact header spans below, may change. Independent browser tests and screenshots found short words and exact money values breaking into letter fragments because long keyword/URL/diagnostic cells squeeze other columns. Add style={{minWidth:N}} to each existing th using its corresponding minWidths entry, in order. Preserve every label, whitespace, surrounding tag, data expression, table structure and all other source bytes. Keep ordinary wrapping and existing named horizontal scroll regions. No helpers, CSS, body maps, callback, API, controller or test changes. No nowrap or truncation. GPT applies only reviewed output and independently reruns the original semantic regression.

```json
[
  {
    "id": "R1",
    "original": "    <thead><tr><th>Created</th><th>Method</th><th>Scope</th><th>Outcome</th><th>Costs</th><th>Data</th></tr></thead>",
    "sha256": "6B298576DA70A9C401EE49034E5D20EBC825FAF99E581E1A936CED33662A8D54",
    "minWidths": [
      160,
      88,
      180,
      110,
      240,
      140
    ]
  },
  {
    "id": "R2",
    "original": "     <thead><tr><th>Keyword</th><th>Device</th><th>Outcome</th><th>Position</th><th>Coverage</th><th>Observed</th><th>Ranking URL</th></tr></thead>",
    "sha256": "DCDFF37C5265FD917EE6E282BE855BE319FA6684B3203E1E6F9B03EA2DCB6029",
    "minWidths": [
      180,
      88,
      160,
      140,
      180,
      160,
      240
    ]
  },
  {
    "id": "R3",
    "original": "     <thead><tr><th>Request</th><th>State</th><th>Maximum</th><th>Confirmed charge</th><th>Recovery</th></tr></thead>",
    "sha256": "E2B7505BD4620C3826575C1D2B77681C09A608BFC5BBB7BFC5FCF642BF5750EA",
    "minWidths": [
      110,
      240,
      140,
      160,
      180
    ]
  }
]
```
