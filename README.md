# Notefira

A free, local-first notebook app for handwriting, PDF markup and study. Notebooks are stored on your own device and work offline; there are no accounts, no server, no analytics and no ads. Google Drive sync is optional and uses your own Drive.

**Use it:** [madaai.github.io/Notefira](https://madaai.github.io/Notefira/) · **Source:** [github.com/MaDaAi/Notefira](https://github.com/MaDaAi/Notefira)

## Features

- Pen (ball pen, fountain, brush), graphite pencil, highlighter and tape, with pressure support, three size presets per tool and solid / dashed / dotted lines
- Eraser (whole stroke, standard, precise) and scribble-to-erase
- Lasso selection (touch or enclose), shapes with draw-and-hold recognition, ruler, text boxes, images and sticky notes
- PDF import and export, page templates and paper colours, notebook covers, favourites and folders
- Audio recording linked to your notes, flash-card study sets, text recognition for searching handwriting and PDFs
- Light and dark themes; installable as a web app; desktop builds for Windows, macOS and Linux via Tauri

## Privacy in one paragraph

Everything stays in your browser (or the desktop app's data folder). Optional features contact other services only when you use them: Google Drive sync (limited `drive.file` permission — Notefira can only see files it created), the text-recognition engine (downloaded once from a public CDN) and live transcription (off by default; your browser's speech service may process the audio). See [`public/legal/privacy.html`](public/legal/privacy.html).

## Development

Requires [Node.js](https://nodejs.org/) 22.12 or later (Node 24 LTS recommended).

```bash
npm ci            # install exact dependency versions
npm run dev       # start the dev server at http://localhost:1420
npm test          # unit tests
npm run build     # type-check and build the static site into dist/
npm run preview   # serve the production build locally
```

Desktop builds use [Tauri 2](https://tauri.app/) (`npm run tauri dev`, `npm run desktop:build`); see [`docs/DESKTOP.md`](docs/DESKTOP.md).

## Deploying to GitHub Pages

The repository includes a workflow (`.github/workflows/deploy-pages.yml`) that tests, builds and publishes the site on every push to `main`.

1. In the GitHub repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Push to `main`. The site appears at `https://madaai.github.io/Notefira/` (a fork appears at `https://<username>.github.io/<repository>/`).

No server configuration is needed: the app is a single page with relative paths, so it works from the repository sub-folder and refreshing never breaks.

### Google Drive sync (maintainers)

Users never set anything up: they choose **Continue with Google** and pick their account. The maintainer configures one Google OAuth client for the app:

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the **Google Drive API**.
2. Google Auth Platform: **Branding** — app name *Notefira*, support email, home page `https://madaai.github.io/Notefira/`, privacy policy `https://madaai.github.io/Notefira/legal/privacy.html`, terms `https://madaai.github.io/Notefira/legal/terms.html`. **Data access** — only `.../auth/drive.file`, `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`. **Audience** — keep *Testing* (only listed test users can sign in) until you publish.
3. **Clients** → create a **Web application** client with authorised JavaScript origin `https://madaai.github.io` (origin only, no path; add `http://localhost:1420` for local development). No redirect URI and no client secret are used by the web app.
4. GitHub repository → **Settings → Secrets and variables → Actions → Variables**: `VITE_GOOGLE_CLIENT_ID` = the client ID. Leave `VITE_GOOGLE_SIGNIN` unset while testing: the button is then shown only in browsers opened once with `?google-test=on` (`?google-test=off` hides it again). Set `VITE_GOOGLE_SIGNIN` = `public` after the Google app is published, then re-run the deploy.

Client IDs are public identifiers, not secrets. Never commit or configure a client secret for the web app. For local development, put `VITE_GOOGLE_CLIENT_ID=...` in `.env.local` (git-ignored) or use *Settings → Cloud sync → Developer settings*, which exists only in development builds.

## Project layout

```
src/          app source (React + TypeScript)
  editor/     notebook editor, toolbar, canvas viewport
  engine/     stroke, pencil, shape and PDF rendering
  storage/    IndexedDB storage and backups
  sync/       optional Google Drive sync
public/       static files, including legal/ policy pages
src-tauri/    desktop app (Tauri 2)
tests/        unit tests (Vitest)
```

## Support and community

Help happens on GitHub — see [SUPPORT.md](SUPPORT.md):

- **Questions and troubleshooting:** [Discussions](https://github.com/MaDaAi/Notefira/discussions)
- **Bugs and feature requests:** [Issues](https://github.com/MaDaAi/Notefira/issues/new/choose)
- **Security vulnerabilities:** report privately — see [SECURITY.md](SECURITY.md)
- **Privacy or legal questions:** notefirasupport@gmail.com

## Contributing

Contributions are welcome — please read [CONTRIBUTING.md](CONTRIBUTING.md) first. All changes to this repository are reviewed and merged by the maintainers.

## License

Notefira is open source under the [MIT License](LICENSE).

Third-party components and their licenses are listed in `public/legal/third-party-licenses.txt`, which is regenerated on every build. Google and the Google "G" logo are trademarks of Google LLC; Notefira is not affiliated with Google.
