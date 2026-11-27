# Release and CI/CD playbook

This document defines the repeatable validation, release, and marketplace update workflow for **Antigravity Provider +** (`antigravity-plus`). Every check that caught drift during development is automated in `scripts/check-release.mjs` and runs on every PR and push to `main`.

## 1. Automated CI checks (every PR and push)

[`.github/workflows/checks.yml`](../.github/workflows/checks.yml) runs read-only checks on Ubuntu. The typecheck and test job runs on Node 22 and 24.

1. **Typecheck, tests, and release gate:**
   - `npm ci --ignore-scripts`
   - `npm run check` (`tsc --noEmit`)
   - `npm test` uses an isolated `HOME` at `$RUNNER_TEMP/antigravity-test-home`. CI fails if the tests create `.bb` there.
   - `npm run check:release` (`scripts/check-release.mjs`), which enforces:
     - The SDK's `validatePluginProviderDeclaration` and `registerSettingDescriptors` accept the runtime provider declaration and settings.
     - Runtime setting keys in `server.ts` match `README.md`, `SECURITY.md`, and `skills/antigravity-plus/SKILL.md`, with no retired setting names left behind.
     - Display name, provider ID, version (`package.json` and `scripts/smoke.mjs`), repository URL, `LICENSE` author, `bb.description`, `keywords`, `bbMarketplace` (`category`, `secondaryCategories`, `screenshots`), and `assets/icon.svg` SHA-256 hash are valid and match `docs/marketplace-entry.template.json`.
     - `PLUGIN_OVERVIEW.md` stays at or under 4,000 characters, has no `# ` H1 title, no raw HTML, no tables, no images, HTTPS links only, zero em dashes, and zero banned marketplace buzzwords.
     - Every screenshot in `package.json` `bbMarketplace.screenshots` exists in `assets/screenshots/`, is embedded in `README.md`, is at most 2 MiB, and is at least 1200 px wide (with no unreferenced leftover screenshots).
     - Zero local home paths (`/Users/...`, `/home/...`), personal email addresses, or stale upstream references in tracked files.
     - `npm pack --dry-run --ignore-scripts` contains all required entrypoints and excludes `.map`, `.env`, and scratch files.
   - `npm audit --audit-level=low`
   - `npm pack --dry-run --ignore-scripts`
2. **Secret scan:**
   - Pinned Gitleaks binary (`v8.30.1`, SHA-256 verified) scanning full Git history (`--redact`).

## 2. Local pre-release checklist (before tagging `vX.Y.Z`)

Run these steps locally on a machine with BB and a signed-in `agy` CLI:

1. **Sync BB SDK types and bump version (when cutting a new release):**
   ```sh
   bb plugin types .
   ```
   Update `version` in `package.json` (`scripts/smoke.mjs` reads `manifest.version` automatically), and update `range` in `docs/marketplace-entry.template.json` if crossing a major/minor floor.
2. **Run the full local gate:**
   ```sh
   bb plugin types --check .
   npm run check
   ISO_HOME=$(mktemp -d) && env -u BB_ANTIGRAVITY_TASK_STATE_DIR HOME="$ISO_HOME" npm test && test ! -e "$ISO_HOME/.bb" && find "$ISO_HOME" -depth -delete
   npm run build
   npm run check:release
   npm run smoke -- --modes --usage
   git diff --check
   ```
   The live `--usage` check parses `agy --version`, validates the quota response with the SDK schema, and requires an `ok` result with at least one window. It uses the signed-in profile on the agent host.
3. **Install locally into BB and verify live surfaces:**
   ```sh
   bb plugin install --yes .
   bb provider models antigravity-plus --json
   ```
   Verify in BB Desktop:
   - Streaming reply, Build/Plan mode toggle, and reasoning levels (`low` through `max`).
   - Tip fork (`Fork`) and manual `/compact`.
   - `/swarm` run: Swarm side-panel tab auto-opens, composer pill toggles it, and swarm timeline cards render cleanly.
   - Provider maintenance (`health`, `usage`, `installation`) and Settings panel.
4. **Refresh screenshots whenever UI or Settings change:**
   - Capture tightly framed Retina images (`>= 1200px` wide, `<= 2 MiB` each) in a clean non-private workspace with empty margins, sidebars, and floating overlays removed so text stays readable inside BB's compact marketplace drawer.
   - Visually inspect every PNG before committing to confirm zero personal emails, local home paths, tokens, or unrelated thread titles.
   - Re-run `npm run check:release` to verify dimensions, file sizes, and `README.md` + `marketplace-entry.template.json` references.
5. **Check commit identity, tag immutably, and publish the GitHub Release:**
   ```sh
   git var GIT_AUTHOR_IDENT
   git status -s
   git tag -a vX.Y.Z -m "Release vX.Y.Z"
   git push origin main vX.Y.Z
   gh release create vX.Y.Z --title "vX.Y.Z" --latest --notes "<release notes>"
   ```
   Never move a published tag. Cut a patch version for follow-up fixes. Push the explicit `vX.Y.Z` tag (rather than `--follow-tags`) so older ancestor tags are not pushed unintentionally.

## 3. Updating the BB Community marketplace

`antigravity-plus` is self-published through the automated [get-bb/marketplace](https://github.com/get-bb/marketplace) crawler because this repository is public, is not a GitHub fork, and carries the `bb-plugin` GitHub topic and `package.json` keyword.

When you push a new semver tag (`vX.Y.Z`), the marketplace crawler reads the new tag within about 30 minutes and updates the live listing automatically from this repository:

- `package.json` `bb.name` -> display name
- `package.json` `bb.description` -> card description
- `package.json` `bb.branding.icon` -> icon (`<= 256 KiB`)
- `package.json` `keywords` -> search tags (up to 10 kebab-case tags after `bb-plugin` is stripped)
- `package.json` `bbMarketplace` (`category`, `secondaryCategories`, `screenshots`) -> categories and screenshot gallery (first entry is the hero image; any unknown key or invalid screenshot skips the release update)
- `PLUGIN_OVERVIEW.md` -> long-form listing overview (`<= 4000` chars)

No pull request to `get-bb/marketplace` is needed for normal releases, copy updates, or screenshot refreshes. Recheck `scripts/crawl-lib.mjs` on [get-bb/marketplace](https://github.com/get-bb/marketplace) before changing `bbMarketplace` keys or category IDs. Open a PR to `get-bb/marketplace` only if you ever need to change legacy-only metadata outside the self-published contract. Keep `docs/marketplace-entry.template.json` synced as a checked reference snapshot.
