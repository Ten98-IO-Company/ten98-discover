# Meta connections — one bounded accessibility repair

Use Kimi K3 with maximum thinking. Load Ponytail and UX Copy Refiner. Skill-only; no shell, filesystem, network, delegation, providers, DB or publication. ONE repair with a 120-second deadline, then stop; no further attempt. Return only JSON {"replacements":[{"id":"R1","new":"exact replacement"}, ...]}. Return every supplied ID once.

Only src/components/MetaConnectionView.tsx, the exact spans below may change. All other source bytes are frozen. Independent browser checks found these controls are 40px tall at 768/1440px; the accepted contract requires at least 44px. Add an inline minHeight:44 to each supplied input/select. Preserve existing fill styles when present. Preserve every other attribute, value, callback, handler body, disabled condition, identifier, text and surrounding structure exactly. Do not change helpers, shared CSS, tests or design. This is a presentation-only correction; GPT applies and independently checks the output.

```json
[
  {
    "id": "R1",
    "original": "<input\n                  id={id('name')}\n                  value={name}\n                  maxLength={120}\n                  disabled={writing}\n                  onChange={(event) => onName(event.target.value)}\n                  aria-describedby={id('connect-helper')}\n                />",
    "sha256": "AF7B27568266603DF760D1E6C46ADDB853A1ECA82BE18ADF2CBDBB59BC08ACAD"
  },
  {
    "id": "R2",
    "original": "<input\n              id={id('account-id')}\n              value={accountId}\n              inputMode='numeric'\n              maxLength={40}\n              disabled={writing}\n              onChange={(event) => onAccountId(event.target.value)}\n              aria-describedby={id('account-id-helper')}\n            />",
    "sha256": "ADAAFBF183C51E6D344A067451AD8293E93C239653DC1BE324669C7F0BBB21A4"
  }
]
```
