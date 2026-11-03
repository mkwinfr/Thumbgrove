# Releasing Thumb Grove

Updates are manual: run the new installer over the old one. An update keeps that person's own library, settings, and bot token in `%APPDATA%\Thumb Grove`.

The installer contains only the app. It holds no library, token, server, channel, or folder, so every new install starts from scratch.

## Steps

1. Raise `version` in `package.json`.
2. Run the tests and the type check:

   ```bash
   npm test
   ```

   ```bash
   npx tsc --noEmit
   ```

3. Build:

   ```bash
   npm run dist
   ```

   This creates `dist\Thumb-Grove-Setup-<version>.exe` and the portable `dist\Thumb-Grove-<version>.exe`.
4. Check that the build carries nothing personal: search `out\` for your username and your server, channel, and thread IDs.
5. Close Thumb Grove, run the new installer over your current version, and check that your library is intact. If the database format changed, Settings → About shows one more backup.
6. Commit, then tag the release:

   ```bash
   git tag v<version>
   ```

## Good to know

- The installer isn't signed, so Windows SmartScreen may warn about it. Choose **More info**, then **Run anyway**.
- Before a database upgrade, Thumb Grove copies the library to `%APPDATA%\Thumb Grove\backups` and keeps the last five. To go back, close Thumb Grove, install the older version, and replace `library.db` with the backup.
- An older version refuses to open a library made by a newer one, so it can't damage it.
- The portable and installed versions share a data folder, so uninstalling the installed version also clears the portable version's library and token.
- Uninstalling deletes `%APPDATA%\Thumb Grove`, including the bot token and the downloaded model, so a later install starts from scratch. Images on disk are never touched. Updating doesn't delete it.
- Install in the default folder. Upgrading failed in testing when Thumb Grove was installed in a folder with a very long path.
- Installing or uninstalling replaces any shortcut named `Thumb Grove` on the desktop or in the Start menu.
