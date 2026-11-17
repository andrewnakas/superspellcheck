# SuperSpellCheck privacy policy

_Draft for store listings. Review with counsel before publishing._

## What stays on your device (always)

- **Your writing.** Spelling and grammar checking runs inside the extension, on your computer. Text you type is not sent anywhere unless you turn on AI deep check.
- **Your personal dictionary and settings.** These are kept in your browser's extension storage. If browser sync is on, your browser syncs them to your other devices.
- **What you accept and dismiss.** The extension counts which suggestions you accept and ignore, so it can stop repeating ones you don't want. These counts never leave your device.

## AI deep check (optional, Pro)

If you turn on AI deep check and enter an API key:

- Paragraphs you type in supported fields, and sentences you ask to rewrite, are sent over HTTPS to the SuperSpellCheck API.
- The API forwards the text to Anthropic's Claude to produce suggestions and rewrites.
- The SuperSpellCheck API does not store or log your text. It logs only request metadata: account id, character count, number of suggestions and response time.
- Anthropic processes the text under its commercial terms. See https://www.anthropic.com/legal/commercial-terms.
- Your API key is stored only on this device and is not synced.

## What we never do

- Read password, email, one-time-code or credit-card fields.
- Check fields a website has opted out of (`spellcheck="false"`, `data-gramm="false"`) or code editors.
- Sell or share your data, or use it for advertising.

## Permissions

| Permission | Why |
|---|---|
| Read and change data on websites | To find text fields and draw underlines next to them |
| Storage | To save your settings and personal dictionary |
| Active tab | So the toolbar popup can turn checking off for the current site |
| Optional access to the API server | Requested only when you turn on AI deep check |

## Contact

privacy@superspellcheck.app (placeholder)
