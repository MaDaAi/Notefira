# Security policy

## Reporting a vulnerability

**Please do not report security vulnerabilities in public issues, discussions or pull requests.**

Report them privately using GitHub's private vulnerability reporting:

1. Go to the repository's **Security** tab.
2. Choose **Report a vulnerability** (or open [this form](https://github.com/MaDaAi/Notefira/security/advisories/new) directly).
3. Describe the problem, how to reproduce it, and the impact you expect.

Only the maintainers can see your report. If you can't use GitHub, you can email **notefirasupport@gmail.com** with the subject "Security" instead.

Please include, where possible:

- the affected version or commit, and where you used Notefira (web, installed web app, or desktop app and operating system);
- steps to reproduce or a proof of concept;
- what an attacker could do (for example read notebooks, run scripts, or access a Google Drive).

Please don't include real personal data or real notebook content in your report.

## What to expect

Notefira is a free project maintained by volunteers, so responses are best effort. We aim to acknowledge reports within a few days, keep you informed while we investigate, and credit you when a fix is released if you'd like. Please give us a reasonable amount of time to release a fix before disclosing the issue publicly. There is no bug bounty.

## Supported versions

Security fixes are made to the latest version on the `main` branch, which is what the official website runs. Please make sure a problem still exists in the latest version before reporting it.

## Scope

In scope: the Notefira web app and desktop app source code in this repository and the official website built from it.

Out of scope: vulnerabilities in third-party services Notefira can connect to (such as Google sign-in or Google Drive) — please report those to the provider — and issues that require an attacker to already control your device or browser profile.

## How Notefira handles data

Notefira has no server and no accounts. Notebooks are stored on the user's device. Optional Google Drive sync uses the limited `drive.file` permission. The desktop app stores Google sign-in secrets only in the operating system's secure keychain (never in its local database); the web app keeps only a short-lived access token for the current browser tab. See the [Privacy Policy](public/legal/privacy.html) for details.
