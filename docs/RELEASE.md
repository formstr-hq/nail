# Android release runbook (Mail by Form*)

Last used: **2026-11-12, v0.5.1**. Keep this file with the code; update it when
the release path changes.

## What ships where

| Target | Artifact | Gradle task |
| --- | --- | --- |
| Zapstore / sideload | `nail-vX.Y.Z.apk` (direct flavor) | `assembleDirectRelease` |
| GitHub release | APK + AAB, both direct flavor | `assembleDirectRelease`, `bundleDirectRelease` |
| Play Store | Play AAB, built separately | `build:web:store` + `bundlePlayRelease` |

The direct APK contains Lightning + hosted card checkout and **no** Play
Billing/Google services. Never upload the Play AAB as the Zapstore/GitHub
direct artifact. The GitHub APK is the Zapstore build.

## Local credentials and keys (do not delete)

- **Android keystore:** `~/.config/nail-release/release.p12`
  - alias `release`
  - cert SHA-256 `10549b63ee5bd87878d53ea36db2df8374ff45308430d792d480552d5a5d51f1`
  - copy of staging `/srv/android/release.p12`; the old
    `~/.local/share/formstr-release/android-release.p12` is byte-identical.
- **Release tooling env:** `~/Dev/formstr/formstr-infra/.env.release`
  (`GH_TOKEN`, keystore passwords, `BUNKER_*`, `GITHUB_SYNC_REPO`). The older
  release workspace env is `~/.local/share/formstr-release/.env.release`.
- **Zapstore / NIP-C1 signer:** `npub1qu7…` via `BUNKER_ABHAY`. The established
  NIP-46 client key lives in
  `~/.local/share/formstr-release/xdg/zsp/bunker-keys/d8987a9c….key`.
  Portable connection: `~/.config/nail-release/abhay.nbunksec` (mode 0600).
- **ngit release signer:** `npub15gkmu50rcuv6mzevmslyllppwmeqxulnqfak0gwud3hfwmau6mvqqnpfvg`
  via `BUNKER_NGIT` + `NGIT_BUNKER_APP_KEY`. Create an `nbunksec` on demand; the
  app key is in `.env.release`.
- **Signer relays that work from this host:** `relay.primal.net`,
  `theforest.nostr1.com`, `nostr.oxtr.dev`, `nostr.wine`,
  `relay.snort.social`, `relay.mostr.pub`.
  `relay.nsec.app`, `relay.damus.io`, `nos.lol` are unreliable here.

## 1. Bump the version

- `client/package.json` → `"version": "X.Y.Z"`
- `client/android/app/build.gradle` → `versionCode` +1, `versionName "X.Y.Z"`
- Add a dated entry to `docs/Session-Log.md`.
- Keep `zapstore.yaml` exactly as the original 0.3.1 listing (description,
  screenshots, tags, `metadata_sources: github`). The only allowed addition is
  the pinned original icon:

```yaml
icon: https://cdn.zapstore.dev/5997548ca2436109b1e6cb7a65113d127c90272644539d616ddb1e3b9c61d251
```

This prevents Zapstore from re-extracting a thin outlined icon from the APK.

## 2. Build the direct APK/AAB

From the repo root:

```bash
pnpm install --frozen-lockfile
ln -sfn "$PWD/client/web/node_modules" "$PWD/nostr-bridge/node_modules"
( cd client && pnpm run build )      # web bundle + cap sync (open/direct)
```

`@capacitor/filesystem@7.1.8` pins AGP 8.7.1, which Google Maven no longer
serves. Patch it to 8.7.2 before Gradle:

```bash
FS_GRADLE=$(find "$PWD/node_modules/.pnpm" \
  -path '*@capacitor+filesystem@7.1.8*/node_modules/@capacitor/filesystem/android/build.gradle' | head -1)
sed -i 's/com.android.tools.build:gradle:8.7.1/com.android.tools.build:gradle:8.7.2/' "$FS_GRADLE"
```

Then:

```bash
export ANDROID_HOME="$HOME/Android/Sdk"
export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/27.1.12297006"
cd client/android
./gradlew --no-daemon \
  --init-script /path/to/formstr-infra/container-android-abifilters.gradle \
  assembleDirectRelease bundleDirectRelease \
  -Pandroid.injected.signing.store.file="$HOME/.config/nail-release/release.p12" \
  -Pandroid.injected.signing.store.password="$ANDROID_KEYSTORE_PASSWORD" \
  -Pandroid.injected.signing.key.alias="$ANDROID_KEY_ALIAS" \
  -Pandroid.injected.signing.key.password="$ANDROID_KEY_PASSWORD"
```

Artifacts:

- `client/android/app/build/outputs/apk/direct/release/app-direct-release.apk`
- `client/android/app/build/outputs/bundle/directRelease/app-direct-release.aab`

Verify before publishing:

```bash
zsp utils extract-apk app-direct-release.apk --json   # versionName/versionCode
apksigner verify --print-certs app-direct-release.apk # cert 10549b63…
```

The `formstr-infra` container build currently runs bare
`assembleRelease bundleRelease`, which builds **both** flavors and trips the
Play store-bundle guard. Use the direct tasks above, or patch
`container-build.sh` in the release repo.

### Launcher icon gotcha

The launcher icon is an adaptive icon whose foreground is a **transparent
raster mark** (`drawable-*/ic_launcher_foreground.png`) with a transparent
background; the legacy `mipmap-*/ic_launcher{,_round}.png` rasters also carry the
original mark. Do **not** restore the `drawable-v24` vector foreground: Zapstore
extracts it as a thin outlined imitation. The original geometry lives in
`scripts/render-app-icon.py`; the transparent foregrounds were generated from
the same constants.

## 3. Commit, tag, mirror

```bash
git add ...
git commit -m "client: release X.Y.Z"
git tag -f vX.Y.Z
git push origin main refs/tags/vX.Y.Z          # nostr source of truth
```

GitHub mirror + release:

```bash
gh release create vX.Y.Z nail-vX.Y.Z.apk nail-vX.Y.Z.aab \
  --repo formstr-hq/nail \
  --target <FULL_COMMIT_SHA> \
  --title vX.Y.Z \
  --notes-file release-notes.md
```

Use the **full** commit SHA for `--target`; a short SHA fails validation.
Push `main` and the tag to the mirror first (the release repo's
`sync_github_from_nostr` does this when using the container build).

## 4. NIP-82 nostr release

Use the existing Zapstore app event (same package id) and the ABHAY signer:

```bash
ngit --nbunksec-file ~/.config/nail-release/abhay.nbunksec \
  release publish -d -q -f \
  --repo nostr://npub1qu7…/relay.ngit.dev/nail \
  --app 32267:073cd836b557a9fdc2a62c27373273da0c556a7008763f7f0e2b7f28ea754fd6:com.formstr.mail \
  --tag vX.Y.Z --commit <FULL_SHA> \
  --blossom-server https://blossom.primal.net/ \
  --notes-file release-notes.md \
  --file android-arm64-v8a=nail-vX.Y.Z.apk
```

- New version → create (no `--edit`).
- Same version re-cut → add `--edit`; use a **new filename** to avoid
  “asset already uses filename”. Prefer a patch release instead.
- `cdn.zapstore.dev` rejected direct ngit uploads with HTTP 400; use
  `https://blossom.primal.net/` for the NIP-82 asset.
- Verify the asset event URL returns 200.

## 5. Zapstore

Use `zsp` with the ABHAY bunker and the established client key:

```bash
SIGN_WITH='bunker://…' \
XDG_CONFIG_HOME="$HOME/.local/share/formstr-release/xdg" \
BLOSSOM_URL=https://cdn.zapstore.dev \
GH_TOKEN=… zsp publish -q --overwrite-release zapstore.yaml
```

- Do **not** use `--skip-certificate-linking`. If Zapstore says “unclaimed”,
  publish the NIP-C1 proof for the APK cert:

```bash
SIGN_WITH='bunker://…' XDG_CONFIG_HOME=… KEYSTORE_PASSWORD=… \
  zsp identity --link-key ~/.config/nail-release/release.p12 \
  --key-alias release --offline > link-event.json

nak event wss://relay.zapstore.dev wss://relay.primal.net \
  wss://theforest.nostr1.com wss://nostr.oxtr.dev < link-event.json
```

`zsp identity` needs `--offline` + `nak` here; the interactive publisher tries
to open a TTY. Verify a kind `30509` event with `d = 10549b63…` signed by
`npub1qu7…` is on `relay.zapstore.dev`.

### Zapstore gotchas

- The store’s **icon cache** can keep showing an old extracted icon even after
  the app event points at the original. A patch version often busts it;
  otherwise fix the listing icon in **Zapstore Studio** (the app is claimed)
  or ask Zapstore to clear the cache.
- If the update returns **HTTP 404**, inspect the release’s `3063` asset event.
  It may list a `cdn.zapstore.dev/<hash>` URL that was never uploaded before the
  working GitHub URL. The GitHub URL is authoritative and works. Direct
  uploads to `cdn.zapstore.dev/upload` require BUD-06/BUD-02 headers
  (`Authorization: Nostr <base64 auth>`, `X-SHA-256`, `X-Content-Type`,
  `X-Content-Length`, `Content-Digest`) and an auth event with
  `t=upload`, `x=<hash>`, `expiration`, and `server=cdn.zapstore.dev`.
- If `zsp` fails at “failed to sign blossom auth event”, the remote signer is
  timing out on kind `24242`. The app/release events still publish; the APK is
  on GitHub and the store update can use that URL. Prefer a fresh
  `bunker://` URL (or the established `abhay.nbunksec`) over removing the
  certificate check.

## 6. Final checks

- GitHub release assets exist; `Web CI` is green on the tagged commit.
- NIP-82 release event + asset URL are live.
- Zapstore page: correct version/versionCode, no “unclaimed” banner, original
  description and screenshots.
- Install the APK: launcher icon is the transparent original mark, with no
  black tile or square inside the launcher circle.
