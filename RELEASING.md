# Releasing Thumb Grove

Installed copies update themselves from GitHub Releases. They check at startup and every six hours, download the changed parts of the new version in the background, and install it on restart. An update keeps that person's own library, settings, and bot token in `%APPDATA%\Thumb Grove`. The portable version doesn't update itself.

The installer contains only the app. It holds no library, token, server, channel, or folder, so every new install starts from scratch.

## Steps

1. Commit your changes to `main`, so that nothing is left uncommitted.
2. Run:

   ```bash
   npm run release
   ```

   This runs the tests and the type check, raises the patch version, then pushes the commit and a new version tag.
3. GitHub Actions takes it from there. `.github/workflows/release.yml` runs the checks again, builds on a clean Windows machine, and publishes the release with its update files. Follow it on the repository's Actions tab.

Installed copies pick up the release the next time they check. For a larger change, run `npm version minor` and `git push origin HEAD --follow-tags` instead of step 2.

To try a build on this computer without publishing anything, run `npm run dist`. It creates `dist\Thumb-Grove-Setup-<version>.exe` and the portable `dist\Thumb-Grove-<version>.exe`.

## Good to know

- Every published release reaches everyone with an installed copy, so try changes with `npm run dev` first. A pre-release is not offered as an update.
- To replace a bad release, fix it and release again. Copies only update to a higher version number.
- The installer isn't signed, so Windows SmartScreen may warn about it when it's downloaded by hand. Choose **More info**, then **Run anyway**. Automatic updates don't show this warning.
- Before a database upgrade, Thumb Grove copies the library to `%APPDATA%\Thumb Grove\backups` and keeps the last five. To go back, close Thumb Grove, install the older version, and replace `library.db` with the backup.
- An older version refuses to open a library made by a newer one, so it can't damage it.
- The portable and installed versions share a data folder, so uninstalling the installed version also clears the portable version's library and token.
- Uninstalling deletes `%APPDATA%\Thumb Grove`, including the bot token and the downloaded model, so a later install starts from scratch. Images on disk are never touched. Updating doesn't delete it.
- Install in the default folder. Upgrading failed in testing when Thumb Grove was installed in a folder with a very long path.
- Installing or uninstalling replaces any shortcut named `Thumb Grove` on the desktop or in the Start menu.
