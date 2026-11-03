# Thumb Grove installer roadmap

Thumb Grove ships as a Windows installer, `Thumb-Grove-Setup-<version>.exe`, and as one portable file, `Thumb-Grove-<version>.exe`.
The release steps are in [RELEASING.md](RELEASING.md).

**Status:** Phases 1 and 2 are done, and the first pre-release is published. Phase 3 is partly done, because it has only run on the main Windows account so far. Phase 4 is partly decided.

## Goals

- Install, update, and uninstall like any other Windows app.
- Keep the library, settings, queues, and bot token through updates. Uninstalling removes them, so nothing carries into a later install.
- Open faster, because an installed app doesn't unpack itself on every launch.
- Keep the portable build available.

## Not planned yet

- Mac or Linux versions.
- A Microsoft Store release.
- Code signing, until Phase 4 decides it.

## Phase 1: Get the app ready

Do these first. They matter once Thumb Grove can be launched from several shortcuts.

- [x] Allow only one running copy. A second launch should focus the open window. Two copies could otherwise work on the same database and move the same files.
- [x] Set a Windows app ID, using the existing `com.thumbgrove.app`, so that the taskbar groups Thumb Grove correctly. Don't change this ID afterward, because Windows treats a new one as a different app.
- [x] Back up `library.db` before a database upgrade. Upgrades only go forward, so this is the way back from a bad update.
- [x] Write errors to a log file in the data folder, with a Settings button to open it. Never log the bot token.
- [x] Add the missing `author` field to `package.json`, and show the version number in Settings.

**Done when:** a second launch focuses the first window, and a test upgrade leaves a usable backup.

## Phase 2: Build the installer

- [x] Add an NSIS target to the `electron-builder` settings, alongside the portable build.
- [x] Install for the current user, so no administrator prompt is needed.
- [x] Show the normal setup wizard, with a choice of install folder.
- [x] Create Start menu and desktop shortcuts.
- [x] Remove `%APPDATA%\Thumb Grove` on uninstall, and keep it on updates.

**Done when:** `npm run dist` produces `Thumb-Grove-Setup-<version>.exe` as well as the portable file.

## Phase 3: Test on a clean setup

These are meant for a clean Windows user account or Windows Sandbox. Ticked items passed on the main account with a throwaway library.

- [ ] Fresh install: the app opens, and thumbnails and folder watching work. Opening passed on the installed app. Thumbnails and folder watching passed on the unpacked build, and not yet on a clean account.
- [ ] Recognition: the model downloads on a machine without the old app, then runs on the GPU, with CPU fallback. The real download has not been tested yet.
- [ ] Upgrade: install an older version, add data, install the newer one, and confirm everything is still there, including the bot token. The upgrade and library passed. The bot token has not been checked across an upgrade.
- [x] Uninstall: the app, shortcuts, and data are gone, and reinstalling starts from scratch.
- [ ] Switching: data carries over between the portable and installed versions, which share a data folder.
- [x] A new install finds nothing from an earlier app or another person: no token, server, channels, folders, or library.
- [ ] Limits: folder and user names with spaces or non-English characters, and running the installer while Thumb Grove is open. Installing while Thumb Grove is open passed. A very long install path made the upgrade fail, which is noted in RELEASING.md.

**Done when:** all of these pass, and the manual steps are written down for future releases.

## Phase 4: Decide on updates and signing

| Option | What it gives you | Cost | Recommendation |
|---|---|---|---|
| Manual updates | Run the new installer over the old one | None | Start here |
| Automatic updates | The app finds and installs new versions, using `electron-updater` | Somewhere to host releases, plus setup and testing | Add if manual updates become annoying |
| Code signing | Fewer or no SmartScreen warnings, and a verified publisher name | A paid certificate or signing service, and identity checks | Recommended now that Thumb Grove is going to other people |

**Decision so far:** automatic updates, with `electron-updater` and releases built by GitHub Actions. Signing is still to be decided now that Thumb Grove is shared. Check current signing prices and requirements, because they change.

## Phase 5: Release routine

- [x] Choose a version number for each release, and keep short release notes.
- [x] Tag each release in git.
- [x] Release with `npm run release`, which runs the checks and hands the build to GitHub Actions.
- [x] Back up the repository somewhere other than this computer.
