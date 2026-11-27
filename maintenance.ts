import { experimental_execHostFile } from "@get-bb/plugin-sdk/process";
import { existsSync } from "node:fs";
import {
  experimental_downloadedInstallerCommand,
  experimental_installationVerification,
} from "@get-bb/plugin-sdk/provider-bridge";
import { isAgyVersionTooOld, MIN_AGY_ACP_VERSION, parseAgyVersion } from "./acp-proxy.ts";
import { resolveAntigravityCommand } from "./cli.ts";
import { readAntigravityProviderUsage } from "./usage.ts";

type AntigravityProviderUsageResult = Awaited<ReturnType<typeof readAntigravityProviderUsage>>;
type SemverTuple = readonly [number, number, number];

const UPDATE_CHECK_TIMEOUT_MS = 4_000;

export const MINIMUM_SUPPORTED_AGY_VERSION = MIN_AGY_ACP_VERSION.join(".");
export const AGY_UNIX_INSTALLER_URL = "https://antigravity.google/cli/install.sh";
export const AGY_WINDOWS_INSTALLER_URL = "https://antigravity.google/cli/install.ps1";
export const AGY_LOGIN_COMMAND = "agy acp --login";

export interface MaintenanceProbeOptions {
  command?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  isMusl?: boolean;
  checkUpdates?: boolean;
  fetch?: typeof globalThis.fetch;
  resolveCommand?: (command: string, options?: { cwd?: string; env?: NodeJS.ProcessEnv }) => string | null;
  execFile?: NonNullable<Parameters<typeof readAntigravityProviderUsage>[0]>["execFile"];
  checkUsage?: () => Promise<AntigravityProviderUsageResult>;
}

export interface AntigravityInstallationStatus {
  executableName: string;
  executablePath: string | null;
  installed: boolean;
  installSource: "notInstalled" | "npmGlobal" | "external";
  currentVersion: string | null;
  latestVersion: string | null;
  minimumSupportedVersion: string | null;
  npmPackageName: string | null;
  npmGlobalPackageVersion: string | null;
  installAction: { kind: "install" | "update"; label: "Install" | "Update"; command: string } | null;
  needsUpdate: boolean;
  versionUnsupported: boolean;
}

export interface AntigravityHealthResult {
  supported: true;
  health: {
    status: "ready" | "not_installed" | "unauthenticated" | "expired" | "unsupported_version" | "unknown";
    statusMessage: string | null;
    accountEmail: string | null;
    planLabel: string | null;
    installedVersion: string | null;
    minimumSupportedVersion: string | null;
    canInstall: boolean;
    canUpdate: boolean;
    loginCommand: string | null;
    localLoginCommand?: string | null;
  };
}

export type AntigravityInstallationRunResult =
  | { available: false; message: string }
  | {
      available: true;
      command: { command: string; args: string[]; displayCommand: string };
      verification:
        | { kind: "installed" }
        | { kind: "version_changed"; previousVersion: string }
        | { kind: "version_at_least"; version: string };
    };

function installerCommand(platform?: NodeJS.Platform) {
  return experimental_downloadedInstallerCommand(AGY_UNIX_INSTALLER_URL, {
    platform,
    powershellUrl: AGY_WINDOWS_INSTALLER_URL,
  });
}

function isVersionNewer(latest: SemverTuple, current: SemverTuple): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (latest[i] !== current[i]) return latest[i] > current[i];
  }
  return false;
}

function detectLinuxMusl(): boolean {
  return existsSync("/lib/libc.musl-x86_64.so.1") || existsSync("/lib/libc.musl-aarch64.so.1");
}

function resolveAgyManifestPlatform(platform: NodeJS.Platform, arch: string, isMusl?: boolean): string | null {
  const mappedArch = arch === "arm64" ? "arm64" : arch === "x64" ? "amd64" : null;
  if (!mappedArch) return null;
  if (platform === "darwin") return `darwin_${mappedArch}`;
  if (platform === "win32") return `windows_${mappedArch}`;
  if (platform === "linux") {
    const musl = typeof isMusl === "boolean" ? isMusl : detectLinuxMusl();
    return musl ? `linux_${mappedArch}_musl` : `linux_${mappedArch}`;
  }
  return null;
}

function extractDownloadBaseUrl(installerScript: string): string | null {
  const match = installerScript.match(/^\s*DOWNLOAD_BASE_URL=["'](https:\/\/[^"'\s]+)["']/m);
  if (!match) return null;
  try {
    const url = new URL(match[1]);
    if (url.protocol !== "https:") return null;
    return url.origin + url.pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

async function fetchLatestAntigravityVersion(options: MaintenanceProbeOptions): Promise<SemverTuple | null> {
  const manifestPlatform = resolveAgyManifestPlatform(
    options.platform ?? process.platform,
    options.arch ?? process.arch,
    options.isMusl,
  );
  if (!manifestPlatform) return null;

  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS);
  timer.unref?.();
  try {
    const installerRes = await fetchImpl(AGY_UNIX_INSTALLER_URL, {
      signal: controller.signal,
      headers: { Accept: "text/plain" },
    });
    if (!installerRes.ok) return null;
    const baseUrl = extractDownloadBaseUrl(await installerRes.text());
    if (!baseUrl) return null;

    const manifestRes = await fetchImpl(`${baseUrl}/manifests/${manifestPlatform}.json`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!manifestRes.ok) return null;
    const payload = await manifestRes.json() as { version?: unknown } | null;
    return typeof payload?.version === "string" ? (parseAgyVersion(payload.version) ?? null) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function readAntigravityInstallationStatus(
  options: MaintenanceProbeOptions = {},
): Promise<AntigravityInstallationStatus> {
  const requested = options.command || "agy";
  const env = options.env ?? process.env;
  const resolveCommand = options.resolveCommand ?? resolveAntigravityCommand;
  const run = options.execFile ?? experimental_execHostFile;
  const shouldCheckUpdates = options.checkUpdates === true;

  const executablePath = requested === "agy"
    ? resolveCommand(requested, { cwd: options.cwd, env })
    : requested;

  if (!executablePath) {
    const install = installerCommand(options.platform);
    const latestParsed = shouldCheckUpdates ? await fetchLatestAntigravityVersion(options) : null;
    return {
      executableName: "agy",
      executablePath: null,
      installed: false,
      installSource: "notInstalled",
      currentVersion: null,
      latestVersion: latestParsed ? latestParsed.join(".") : null,
      minimumSupportedVersion: MINIMUM_SUPPORTED_AGY_VERSION,
      npmPackageName: null,
      npmGlobalPackageVersion: null,
      installAction: { kind: "install", label: "Install", command: install.displayCommand },
      needsUpdate: false,
      versionUnsupported: false,
    };
  }

  const readInstalledVersion = async (): Promise<SemverTuple | null> => {
    try {
      const { stdout, stderr } = await run(executablePath, ["--version"], {
        cwd: options.cwd,
        env,
        timeout: 10_000,
      });
      return parseAgyVersion(`${stdout}\n${stderr}`) ?? null;
    } catch {
      return null;
    }
  };

  const [currentParsed, latestParsed] = await Promise.all([
    readInstalledVersion(),
    shouldCheckUpdates ? fetchLatestAntigravityVersion(options) : Promise.resolve(null),
  ]);

  const currentVersion = currentParsed ? currentParsed.join(".") : null;
  const versionUnsupported = currentParsed ? isAgyVersionTooOld(currentParsed) : false;
  const latestVersion = latestParsed ? latestParsed.join(".") : null;
  const updateAvailable = currentParsed !== null && latestParsed !== null && isVersionNewer(latestParsed, currentParsed);

  return {
    executableName: "agy",
    executablePath,
    installed: true,
    installSource: "external",
    currentVersion,
    latestVersion,
    minimumSupportedVersion: MINIMUM_SUPPORTED_AGY_VERSION,
    npmPackageName: null,
    npmGlobalPackageVersion: null,
    installAction: { kind: "update", label: "Update", command: "agy update" },
    needsUpdate: versionUnsupported || updateAvailable,
    versionUnsupported,
  };
}

export async function planAntigravityInstallationRun(
  action: "install" | "update",
  options: MaintenanceProbeOptions = {},
): Promise<AntigravityInstallationRunResult> {
  const status = await readAntigravityInstallationStatus({ ...options, checkUpdates: false });
  if (action === "install") {
    return {
      available: true,
      command: installerCommand(options.platform),
      verification: experimental_installationVerification(status, "install"),
    };
  }
  if (!status.installed || !status.executablePath) {
    return {
      available: false,
      message: "Antigravity CLI (agy) is not installed on this machine.",
    };
  }
  return {
    available: true,
    command: {
      command: status.executablePath,
      args: ["update"],
      displayCommand: "agy update",
    },
    verification: experimental_installationVerification(status, "update"),
  };
}

export async function readAntigravityHealth(
  options: MaintenanceProbeOptions = {},
): Promise<AntigravityHealthResult> {
  const status = await readAntigravityInstallationStatus({ ...options, checkUpdates: false });
  if (!status.installed) {
    return {
      supported: true,
      health: {
        status: "not_installed",
        statusMessage: `Install Antigravity CLI (agy) ${MINIMUM_SUPPORTED_AGY_VERSION} or later on this machine.`,
        accountEmail: null,
        planLabel: null,
        installedVersion: null,
        minimumSupportedVersion: MINIMUM_SUPPORTED_AGY_VERSION,
        canInstall: true,
        canUpdate: false,
        loginCommand: AGY_LOGIN_COMMAND,
        localLoginCommand: AGY_LOGIN_COMMAND,
      },
    };
  }
  if (status.versionUnsupported) {
    return {
      supported: true,
      health: {
        status: "unsupported_version",
        statusMessage: `Antigravity CLI ${status.currentVersion} is older than ${MINIMUM_SUPPORTED_AGY_VERSION}. Run \`agy update\` on this machine.`,
        accountEmail: null,
        planLabel: null,
        installedVersion: status.currentVersion,
        minimumSupportedVersion: MINIMUM_SUPPORTED_AGY_VERSION,
        canInstall: false,
        canUpdate: true,
        loginCommand: AGY_LOGIN_COMMAND,
        localLoginCommand: AGY_LOGIN_COMMAND,
      },
    };
  }
  try {
    const usageResult = options.checkUsage
      ? await options.checkUsage()
      : await readAntigravityProviderUsage({
          command: status.executablePath ?? options.command ?? "agy",
          cwd: options.cwd,
          env: options.env,
          execFile: options.execFile,
        });
    const usage = usageResult.usage as { status?: string; accountEmail?: string | null; planLabel?: string | null } | undefined;
    if (usage?.status === "unauthenticated") {
      return {
        supported: true,
        health: {
          status: "unauthenticated",
          statusMessage: `Sign in to Antigravity CLI to start coding. Run \`${AGY_LOGIN_COMMAND}\` on this machine, then retry.`,
          accountEmail: null,
          planLabel: null,
          installedVersion: status.currentVersion,
          minimumSupportedVersion: MINIMUM_SUPPORTED_AGY_VERSION,
          canInstall: false,
          canUpdate: true,
          loginCommand: AGY_LOGIN_COMMAND,
          localLoginCommand: AGY_LOGIN_COMMAND,
        },
      };
    }
    if (usage?.status === "expired") {
      return {
        supported: true,
        health: {
          status: "expired",
          statusMessage: `Your Antigravity CLI sign-in expired. Run \`${AGY_LOGIN_COMMAND}\` on this machine to refresh it.`,
          accountEmail: null,
          planLabel: null,
          installedVersion: status.currentVersion,
          minimumSupportedVersion: MINIMUM_SUPPORTED_AGY_VERSION,
          canInstall: false,
          canUpdate: true,
          loginCommand: AGY_LOGIN_COMMAND,
          localLoginCommand: AGY_LOGIN_COMMAND,
        },
      };
    }
    if (usage?.status === "ok") {
      return {
        supported: true,
        health: {
          status: "ready",
          statusMessage: null,
          accountEmail: usage.accountEmail ?? null,
          planLabel: usage.planLabel ?? null,
          installedVersion: status.currentVersion,
          minimumSupportedVersion: MINIMUM_SUPPORTED_AGY_VERSION,
          canInstall: false,
          canUpdate: true,
          loginCommand: AGY_LOGIN_COMMAND,
          localLoginCommand: AGY_LOGIN_COMMAND,
        },
      };
    }
  } catch {
    // Fall through to ready if usage probe is transiently unavailable while CLI is valid.
  }
  return {
    supported: true,
    health: {
      status: "ready",
      statusMessage: null,
      accountEmail: null,
      planLabel: null,
      installedVersion: status.currentVersion,
      minimumSupportedVersion: MINIMUM_SUPPORTED_AGY_VERSION,
      canInstall: false,
      canUpdate: true,
      loginCommand: AGY_LOGIN_COMMAND,
      localLoginCommand: AGY_LOGIN_COMMAND,
    },
  };
}
