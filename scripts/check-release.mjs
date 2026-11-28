import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerSettingDescriptors, validatePluginProviderDeclaration } from "@get-bb/plugin-sdk/internal/host-policy";
import plugin from "../server.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BANNED_MARKETPLACE_WORDS =
  /\b(powerful|seamless|easy|simple|fast|best|modern|beautiful|robust|intuitive|first-class)\b/gi;

const failures = [];
function fail(message) {
  failures.push(message);
}

function readUtf8(relPath) {
  return readFileSync(join(ROOT, relPath), "utf8");
}

// 1. Runtime inspection of server.ts settings + provider registration
let definedSettings = {};
let registeredProvider = null;
await plugin({
  settings: {
    define(descriptors) {
      definedSettings = descriptors;
      return { get: async () => ({}), onChange() {} };
    },
  },
  providers: {
    register(value) {
      registeredProvider = value;
      return { dispose() {} };
    },
  },
});

if (!registeredProvider) {
  fail("server.ts did not register a provider");
}
try {
  if (registeredProvider) validatePluginProviderDeclaration(registeredProvider);
  registerSettingDescriptors({}, definedSettings);
} catch (error) {
  fail(`SDK rejected the provider declaration or settings: ${error.message}`);
}

const settingKeys = Object.keys(definedSettings);
const pkg = JSON.parse(readUtf8("package.json"));
const entry = JSON.parse(readUtf8("docs/marketplace-entry.template.json"));
const readme = readUtf8("README.md");
const overview = readUtf8("PLUGIN_OVERVIEW.md");
const security = readUtf8("SECURITY.md");
const review = readUtf8("docs/REVIEW.md");
const features = readUtf8("docs/FEATURES.md");
const release = readUtf8("docs/RELEASE.md");
const skill = readUtf8("skills/antigravity-plus/SKILL.md");
const usageSrc = readUtf8("usage.ts");
const smokeSrc = readUtf8("scripts/smoke.mjs");
const license = readUtf8("LICENSE");

// 2. Settings parity across code and docs
for (const key of settingKeys) {
  for (const [label, content] of [
    ["README.md", readme],
    ["SECURITY.md", security],
    ["skills/antigravity-plus/SKILL.md", skill],
  ]) {
    if (!content.includes(`\`${key}\``)) {
      fail(`Setting "${key}" from server.ts is not documented in ${label}`);
    }
  }
}

// Guard against removed/retired setting names lingering in user-facing docs
for (const retired of ["processPerSession", "autoApprove", "promptOnSandboxEscape"]) {
  if (!settingKeys.includes(retired)) {
    for (const [label, content] of [
      ["README.md", readme],
      ["PLUGIN_OVERVIEW.md", overview],
      ["docs/FEATURES.md", features],
      ["SECURITY.md", security],
      ["skills/antigravity-plus/SKILL.md", skill],
    ]) {
      if (content.includes(`\`${retired}\``)) {
        fail(`Retired setting "\`${retired}\`" still appears in ${label}`);
      }
    }
  }
}

// 3. Name, ID, version, repo, icon hash, and license checks
if (pkg.bb?.name !== registeredProvider?.displayName) {
  fail(`package.json bb.name (${pkg.bb?.name}) !== server.ts displayName (${registeredProvider?.displayName})`);
}
if (pkg.bb?.name !== entry.displayName) {
  fail(`package.json bb.name (${pkg.bb?.name}) !== marketplace entry displayName (${entry.displayName})`);
}
if (entry.id !== registeredProvider?.id) {
  fail(`marketplace entry id (${entry.id}) !== server.ts provider id (${registeredProvider?.id})`);
}
if (pkg.repository?.url !== entry.source?.git?.url) {
  fail(`package.json repository.url (${pkg.repository?.url}) !== marketplace source.git.url (${entry.source?.git?.url})`);
}
if (
  !smokeSrc.includes("version: manifest.version") &&
  !smokeSrc.includes(`version: '${pkg.version}'`) &&
  !smokeSrc.includes(`version: "${pkg.version}"`)
) {
  fail(`scripts/smoke.mjs clientInfo.version does not use manifest.version or match package.json version (${pkg.version})`);
}
if (!license.includes(pkg.author)) {
  fail(`LICENSE does not include package.json author "${pkg.author}"`);
}

const iconHash = createHash("sha256").update(readFileSync(join(ROOT, "assets/icon.svg"))).digest("hex").slice(0, 8);
const expectedIconUrl = `./icons/${entry.id}-${iconHash}.svg`;
if (entry.icon?.url !== expectedIconUrl) {
  fail(`marketplace icon.url is "${entry.icon?.url}", expected "${expectedIconUrl}"`);
}

// 4. Marketplace overview, manifest metadata & description contract
if (overview.length > 2800) {
  fail(`PLUGIN_OVERVIEW.md is ${overview.length} chars (keep <= 2800 per bb-plugin-authoring; hard marketplace max is 4000)`);
}
if (/^#{1,2} /.test(overview.trimStart())) {
  fail("PLUGIN_OVERVIEW.md must lead with an outcome paragraph, not a '#' or '##' heading (BB renders '##' as a small uppercase section label)");
}
if (/^# /m.test(overview)) {
  fail("PLUGIN_OVERVIEW.md must not contain a level-1 '# ' heading");
}
if (/<[a-z][a-z0-9-]*[\s>]/i.test(overview)) {
  fail("PLUGIN_OVERVIEW.md must not contain raw HTML");
}
if (/^\|.+\|$/m.test(overview)) {
  fail("PLUGIN_OVERVIEW.md must not contain Markdown tables");
}
if (/!\[[^\]]*\]\([^)]+\)/.test(overview)) {
  fail("PLUGIN_OVERVIEW.md must not contain images");
}
if (/http:\/\//i.test(overview)) {
  fail("PLUGIN_OVERVIEW.md must use https:// links only");
}

for (const [label, content] of [
  ["package.json bb.description", String(pkg.bb?.description ?? "")],
  ["README.md", readme],
  ["PLUGIN_OVERVIEW.md", overview],
  ["docs/marketplace-entry.template.json", JSON.stringify(entry)],
]) {
  const banned = content.match(BANNED_MARKETPLACE_WORDS);
  if (banned?.length) {
    fail(`${label} contains banned buzzwords: ${[...new Set(banned)].join(", ")}`);
  }
  if (content.includes("—")) {
    fail(`${label} contains an em dash (—)`);
  }
}

const bbDesc = String(pkg.bb?.description ?? "").trim();
if (!bbDesc) {
  fail("package.json bb.description is required");
}
if (bbDesc !== String(entry.description ?? "").trim()) {
  fail("package.json bb.description does not match docs/marketplace-entry.template.json description");
}
const hook = `${bbDesc.split(". ")[0].replace(/\.$/, "")}.`;
if (bbDesc.length > 140) {
  fail(`package.json bb.description is ${bbDesc.length} chars (target <= 140)`);
}
if (hook.toLowerCase().startsWith("a plugin") || hook.toLowerCase().startsWith(entry.displayName.toLowerCase())) {
  fail(`marketplace description hook must start with a verb, not display name or "A plugin": "${hook}"`);
}

const DROPPED_KEYWORDS = new Set(["bb-plugin", "bb", "bb-plugins"]);
const pkgKeywords = Array.isArray(pkg.keywords) ? pkg.keywords : [];
if (!pkgKeywords.some((k) => typeof k === "string" && k.trim().toLowerCase() === "bb-plugin")) {
  fail('package.json keywords must include "bb-plugin" for marketplace self-publishing');
}
const derivedTags = [];
for (const kw of pkgKeywords) {
  if (typeof kw !== "string") continue;
  const tag = kw.trim().toLowerCase();
  if (DROPPED_KEYWORDS.has(tag)) continue;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tag) || tag.length > 32) {
    fail(`invalid package.json keyword tag "${kw}"`);
    continue;
  }
  if (!derivedTags.includes(tag)) derivedTags.push(tag);
}
if (derivedTags.length === 0 || derivedTags.length > 10) {
  fail(`package.json derived marketplace tags must have 1 to 10 items (found ${derivedTags.length})`);
}
if (JSON.stringify(derivedTags) !== JSON.stringify(entry.tags ?? [])) {
  fail(`package.json derived tags (${derivedTags.join(", ")}) !== marketplace template tags (${(entry.tags ?? []).join(", ")})`);
}

// Validate bbMarketplace object against the get-bb/marketplace crawler schema
const ALLOWED_BB_MARKETPLACE_KEYS = new Set(["category", "secondaryCategories", "screenshots"]);
const market = pkg.bbMarketplace;
if (!market || typeof market !== "object" || Array.isArray(market)) {
  fail("package.json bbMarketplace object is required for self-published category and screenshots");
} else {
  const unknownKeys = Object.keys(market).filter((k) => !ALLOWED_BB_MARKETPLACE_KEYS.has(k));
  if (unknownKeys.length > 0) {
    fail(`package.json bbMarketplace has unknown keys: ${unknownKeys.join(", ")}`);
  }
  if (typeof market.category !== "string" || !market.category.trim()) {
    fail("package.json bbMarketplace.category is required");
  } else if (market.category !== entry.category) {
    fail(`package.json bbMarketplace.category (${market.category}) !== template category (${entry.category})`);
  }
  if (market.secondaryCategories !== undefined) {
    if (!Array.isArray(market.secondaryCategories) || market.secondaryCategories.length > 3) {
      fail("package.json bbMarketplace.secondaryCategories must be an array of at most 3 items");
    } else {
      if (new Set(market.secondaryCategories).size !== market.secondaryCategories.length || market.secondaryCategories.includes(market.category)) {
        fail("package.json bbMarketplace.secondaryCategories must be distinct from each other and from category");
      }
      if (JSON.stringify(market.secondaryCategories) !== JSON.stringify(entry.secondaryCategories ?? [])) {
        fail("package.json bbMarketplace.secondaryCategories does not match marketplace template");
      }
    }
  }
}

// 5. Screenshots validation (pure Node PNG header check, works on macOS/Linux/Windows)
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const marketScreenshots = Array.isArray(market?.screenshots) ? market.screenshots : [];
const declaredScreenshots = Array.isArray(entry.screenshots) ? entry.screenshots : [];
if (marketScreenshots.length === 0 || marketScreenshots.length > 6) {
  fail(`package.json bbMarketplace.screenshots must reference 1 to 6 screenshots (found ${marketScreenshots.length})`);
}
const invalidScreenshotEntries = marketScreenshots.filter((ref) => typeof ref !== "string" || !ref.trim());
if (invalidScreenshotEntries.length > 0) {
  fail("package.json bbMarketplace.screenshots entries must all be non-empty strings");
} else if (
  JSON.stringify(marketScreenshots.map((ref) => basename(ref))) !==
  JSON.stringify(declaredScreenshots.map((ref) => basename(String(ref))))
) {
  fail("package.json bbMarketplace.screenshots order/list does not match docs/marketplace-entry.template.json");
}

const screenshotDir = join(ROOT, "assets/screenshots");
const actualFiles = existsSync(screenshotDir)
  ? readdirSync(screenshotDir).filter((name) => !name.startsWith("."))
  : [];

for (const ref of marketScreenshots) {
  if (typeof ref !== "string") continue;
  if (!ref.startsWith("./assets/screenshots/") && !ref.startsWith("assets/screenshots/")) {
    fail(`bbMarketplace screenshot "${ref}" must be a relative path under assets/screenshots/`);
    continue;
  }
  const file = basename(ref);
  const abs = join(screenshotDir, file);
  if (!existsSync(abs)) {
    fail(`marketplace screenshot "${ref}" missing from assets/screenshots/${file}`);
    continue;
  }
  if (!readme.includes(`assets/screenshots/${file}`)) {
    fail(`screenshot assets/screenshots/${file} is not embedded in README.md`);
  }
  const stat = statSync(abs);
  if (stat.size > 2 * 1024 * 1024) {
    fail(`assets/screenshots/${file} is ${stat.size} bytes (max 2 MiB)`);
  }
  const buf = readFileSync(abs);
  if (file.endsWith(".png")) {
    if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_MAGIC)) {
      fail(`assets/screenshots/${file} is not a valid PNG file`);
    } else {
      const width = buf.readUInt32BE(16);
      if (width < 1200) {
        fail(`assets/screenshots/${file} is ${width}px wide (marketplace requires >= 1200px)`);
      }
    }
  }
}

for (const file of actualFiles) {
  if (!marketScreenshots.some((ref) => basename(ref) === file)) {
    fail(`unreferenced screenshot file assets/screenshots/${file} (add to bbMarketplace.screenshots or delete)`);
  }
}

// 6. Stale upstream references and privacy leak scan on tracked docs/source
if (security.includes("ols-md/bb-plugin-antigravity") || security.includes("bb-plugin-antigravity/background-tasks.json")) {
  fail("SECURITY.md still contains stale upstream repo or state-dir reference");
}
if (release.includes("ols-md/bb-plugin-antigravity") || release.includes("antigravity-cli")) {
  fail("docs/RELEASE.md still contains stale upstream repo or antigravity-cli reference");
}
if (review.includes("antigravity-cli")) {
  fail("docs/REVIEW.md still references antigravity-cli");
}
if (usageSrc.includes("antigravity-cli")) {
  fail("usage.ts still contains stale antigravity-cli reference");
}

const trackedFiles = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
  .split(/\r?\n/)
  .filter(Boolean);

for (const rel of trackedFiles) {
  if (/\.(png|jpg|jpeg|webp|svg|ico)$/i.test(rel) || rel === "package-lock.json" || rel === "scripts/check-release.mjs") {
    continue;
  }
  const content = readUtf8(rel);
  const homeMatch = content.match(/(?:\/(?:Users|home)\/|[A-Za-z]:\\Users\\)([a-zA-Z0-9._-]+)/g) ?? [];
  for (const hit of homeMatch) {
    const parts = hit.split(/[\\/]/).filter(Boolean);
    const user = parts[parts.length - 1] ?? "";
    if (!["u", "user", "alice", "bob", "dev", "test", "example", "..."].includes(user.toLowerCase())) {
      fail(`Local home path "${hit}" found in ${rel}`);
    }
  }
  if (/[a-zA-Z0-9._%+-]+@(?!users\.noreply\.github\.com|example\.com)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(content)) {
    fail(`Email address found in ${rel}`);
  }
}

// 7. Package tarball hygiene
const packJson = execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
  cwd: ROOT,
  encoding: "utf8",
});
const packInfo = JSON.parse(packJson)[0];
const packedPaths = new Set((packInfo?.files ?? []).map((f) => f.path));

for (const required of ["LICENSE", "README.md", "PLUGIN_OVERVIEW.md", "SECURITY.md", "server.ts", "host.ts", "app.tsx"]) {
  if (!packedPaths.has(required)) {
    fail(`Required file "${required}" missing from npm pack output`);
  }
}
// Architectural fitness function: every root .ts module imported by entrypoints must ship in npm pack.
const visitedModules = new Set();
const moduleQueue = ["server.ts", "host.ts", "app.tsx"];
while (moduleQueue.length > 0) {
  const mod = moduleQueue.shift();
  if (!mod || visitedModules.has(mod) || !existsSync(join(ROOT, mod))) continue;
  visitedModules.add(mod);
  if (!packedPaths.has(mod)) {
    fail(`Imported runtime module "${mod}" is missing from package.json "files" / npm pack output`);
  }
  const source = readUtf8(mod);
  for (const match of source.matchAll(/from\s+["']\.\/([^"']+\.tsx?)["']/g)) {
    if (match[1]) moduleQueue.push(match[1]);
  }
}
for (const path of packedPaths) {
  if (path.endsWith(".map") || path.startsWith(".env") || path.includes("scratch/")) {
    fail(`Disallowed file "${path}" included in npm pack output`);
  }
}

if (failures.length > 0) {
  console.error(`Release check failed (${failures.length} issue${failures.length === 1 ? "" : "s"}):`);
  for (const issue of failures) {
    console.error(`  - ${issue}`);
  }
  process.exit(1);
}

console.log(
  `Release check passed: ${settingKeys.length} settings synced, ${declaredScreenshots.length} screenshots (>=1200px), icon ${iconHash}, overview ${overview.length}/4000 chars, ${packedPaths.size} tarball files.`,
);
