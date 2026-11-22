# Contributing

Thank you for helping improve Floating Notes.

## Before opening an issue

1. Confirm the problem occurs on a normal `http://` or `https://` page. Browser-protected pages such as `chrome://`, `edge://`, and extension stores do not allow content-script injection.
2. Include the browser name and version, operating system, affected website, and exact reproduction steps.
3. Remove private note content, account information, and sensitive URLs from screenshots.

## Local validation

Before submitting a pull request:

```bash
node -e "JSON.parse(require('fs').readFileSync('manifest.json', 'utf8'))"
node --check service-worker.js
node --check content.js
node --check keyboard-guard.js
node --check fullscreen-bridge.js
node --check options.js
```

Then load the repository folder as an unpacked extension in Chrome or Edge and test the affected workflow on a real webpage.

## Pull requests

- Keep changes focused and explain the user problem they solve.
- Update `CHANGELOG.md` when behavior changes.
- Add or update testing notes for keyboard, fullscreen, storage, permissions, or video behavior.
- Do not commit browser profiles, exported notes, credentials, `.pem` files, or release ZIP archives.


