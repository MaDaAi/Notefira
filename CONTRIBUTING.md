# Contributing to Notefira

Thanks for your interest in improving Notefira! This guide explains how to report problems, suggest ideas and contribute code.

## Ways to help

- **Questions and help** — ask in [GitHub Discussions → Q&A](https://github.com/MaDaAi/Notefira/discussions/categories/q-a). Answering other people's questions is a great way to help too.
- **Bugs** — open a [bug report](https://github.com/MaDaAi/Notefira/issues/new/choose) using the template.
- **Ideas** — start in [Discussions → Ideas](https://github.com/MaDaAi/Notefira/discussions/categories/ideas); once an idea is well defined it can become a feature request issue.
- **Security problems** — never in public. Follow [SECURITY.md](SECURITY.md).
- **Code and documentation** — pull requests are welcome; see below.

Issues and discussions are public. Please don't post private notes, personal information or screenshots that contain them.

## What fits Notefira

Notefira is free, local-first and works without accounts, a server, analytics or ads. Contributions should keep it that way. Before starting on a large change, please open an issue or discussion first so we can agree on the approach — this avoids wasted work if a change doesn't fit the project.

## Development setup

You need [Node.js](https://nodejs.org/) 20 or later.

```bash
npm ci            # install dependencies
npm run dev       # dev server at http://localhost:1420
npm test          # unit tests
npm run build     # type-check and production build
```

The desktop app uses [Tauri 2](https://tauri.app/); see [docs/DESKTOP.md](docs/DESKTOP.md).

## Versions

Every update to the official site gets a new version number, shown in the app (library sidebar, welcome screen, Settings → About). Maintainers bump it before releasing:

```bash
npm version patch --no-git-tag-version   # e.g. 0.1.2 → 0.1.3 (use minor for bigger feature releases);
                                         # also copies the version into the desktop app config
npm run build
```

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Keep each pull request focused on one change, and follow the existing code style.
3. Add or update tests where it makes sense, and make sure `npm test` and `npm run build` pass.
4. Test your change in the app (and mention the browser/device and input method you used).
5. Fill in the pull request template.

All changes to the official repository are reviewed and merged by the maintainers, who decide what is accepted. A pull request may be declined or need changes even if it is well made — for example because it doesn't fit the project's direction. Please don't take that personally.

## Rules for contributions

- **No secrets or personal data** — never commit API keys, OAuth client secrets, tokens, or personal information.
- **Original work only** — contribute only code and assets you wrote yourself or that come from sources with a compatible open-source license. Don't copy code, icons, images, fonts or designs from other apps or products.
- **Dependencies** — add new dependencies only when necessary, and only with permissive licenses (for example MIT, BSD, Apache-2.0, ISC).
- **Privacy** — don't add analytics, tracking, advertising, or network requests that aren't needed for a feature the user chose to use.

## License of contributions

Notefira is licensed under the [MIT License](LICENSE). By submitting a contribution, you agree that it is provided under the MIT License and that you have the right to submit it.

## Be respectful

Be kind and constructive in issues, discussions and reviews. Harassment, personal attacks and spam are not tolerated; maintainers may edit or remove such content and block those responsible.
