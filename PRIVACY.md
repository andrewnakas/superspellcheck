# SuperSpellCheck privacy policy

_Draft for store listings. Review with counsel before publishing._

## What stays on your device (always)

- **Your writing.** All spelling and grammar checking, including the optional AI deep check, runs inside the extension on your computer. Text you type is never sent anywhere.
- **Your personal dictionary and settings.** These are kept in your browser's extension storage. If browser sync is on, your browser syncs them to your other devices.
- **What you accept and dismiss.** The extension counts which suggestions you accept and ignore, so it can stop repeating ones you don't want. These counts never leave your device.

## AI deep check (optional)

If you turn on AI deep check, the extension downloads an AI model file once (about 600 MB) from Hugging Face and stores it in your browser. This download is the only network request the extension makes. The model then runs on your device; your text is not sent to SuperSpellCheck, Hugging Face or anyone else. You can delete the model at any time from the extension's settings.

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
| Offscreen document (Chrome) | Runs the on-device AI model in the background |

## Contact

privacy@superspellcheck.app (placeholder)
