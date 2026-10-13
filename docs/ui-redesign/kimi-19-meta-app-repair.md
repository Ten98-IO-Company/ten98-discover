# Meta app — one bounded accessibility repair

Use Kimi K3 with maximum thinking. Load Ponytail and UX Copy Refiner. Skill-only; no shell, filesystem, network, delegation, providers, DB or publication. ONE repair with a 120-second deadline, then stop; no further attempt. Return only JSON {"replacements":[{"id":"R1","new":"exact replacement"}, ...]}. Return every supplied ID once.

Only src/components/MetaAppView.tsx, the exact spans below may change. All other source bytes are frozen. Independent browser checks found these controls are 40px tall at 768/1440px; the accepted contract requires at least 44px. Add an inline minHeight:44 to each supplied input/select. Preserve existing fill styles when present. Preserve every other attribute, value, callback, handler body, disabled condition, identifier, text and surrounding structure exactly. Do not change helpers, shared CSS, tests or design. This is a presentation-only correction; GPT applies and independently checks the output.

```json
[
  {
    "id": "R1",
    "original": "<select\n            id={`${p}registration`}\n            aria-labelledby={`${p}registration-label`}\n            value={newRegistration || selected === null ? '' : selected.id}\n            disabled={busy || unknown}\n            style={fill}",
    "sha256": "EA79C5A86B2724274FAD5F7DEE0CE81B115C3D424EFEFD653679B893DE0D6B1B"
  },
  {
    "id": "R2",
    "original": "<input\n                  id={`${p}appid`}\n                  type=\"text\"\n                  inputMode=\"numeric\"\n                  maxLength={40}\n                  value={appId}\n                  readOnly={!newRegistration}\n                  disabled={fieldLocked}\n                  style={fill}",
    "sha256": "F8D6E7355FC057312DA7714A237248156A2675B39D0ECB02392DAF50FFB9100C"
  },
  {
    "id": "R3",
    "original": "<input\n                  id={`${p}configid`}\n                  type=\"text\"\n                  inputMode=\"numeric\"\n                  maxLength={40}\n                  value={configId}\n                  disabled={fieldLocked}\n                  style={fill}",
    "sha256": "09F3DC69AE5E033D3786D8D64A0E6ECAC49B6BC4DB5053453D67D385E30DA90F"
  },
  {
    "id": "R4",
    "original": "<input\n                id={`${p}secret`}\n                type=\"password\"\n                autoComplete=\"new-password\"\n                maxLength={512}\n                value={secret}\n                disabled={fieldLocked}\n                style={fill}",
    "sha256": "85AB15AF84227E4ACE870282C130C69A9D2660A043B34F184E795C334F502EA9"
  },
  {
    "id": "R5",
    "original": "<select\n                id={`${p}mode`}\n                value={declaredMode}\n                disabled={fieldLocked}\n                style={fill}",
    "sha256": "49E6EB4BA982DFFA133100AD49C5D8E3C34488B75451E0C20B8EFEC5ED6BB791"
  },
  {
    "id": "R6",
    "original": "<input\n                id={`${p}callback-${callback.kind}`}\n                type=\"text\"\n                readOnly\n                value={callback.url}\n                style={fill}",
    "sha256": "70E85C839C8555CABFB6E6F72374AAFD0B17DD7761AE5D211BEC84558843EF4D"
  }
]
```
