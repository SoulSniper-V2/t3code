import type { RemoteT3RunnerOptions } from "@t3tools/ssh/tunnel";

export function resolveDesktopSshCliReleaseBaseUrl(input: {
  readonly releaseBaseUrl?: string | undefined;
  readonly updateRepository?: string | undefined;
  readonly githubRepository?: string | undefined;
}): string | undefined {
  const releaseBaseUrl = input.releaseBaseUrl?.trim();
  if (releaseBaseUrl) return releaseBaseUrl.replace(/\/+$/u, "");

  const repository = input.updateRepository?.trim() || input.githubRepository?.trim();
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    return undefined;
  }

  return `https://github.com/${repository}/releases/download`;
}

export function resolveDesktopSshCliRunner(input: {
  readonly isDevelopment: boolean;
  readonly devRemoteT3ServerEntryPath?: string | undefined;
  readonly appVersion: string;
  readonly nodeEngineRange: string;
  readonly releaseBaseUrl?: string | undefined;
}): RemoteT3RunnerOptions {
  if (input.isDevelopment && input.devRemoteT3ServerEntryPath) {
    return {
      nodeScriptPath: input.devRemoteT3ServerEntryPath,
      nodeEngineRange: input.nodeEngineRange,
    };
  }

  return {
    archiveVersion: input.appVersion,
    ...(input.releaseBaseUrl ? { releaseBaseUrl: input.releaseBaseUrl } : {}),
  };
}
