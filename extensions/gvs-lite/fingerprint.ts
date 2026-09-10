import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export async function workspaceFingerprint(
  pi: ExtensionAPI,
  cwd: string,
  configDirName = ".pi",
): Promise<string | null> {
  const inside = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd, timeout: 5_000 });
  if (inside.code !== 0 || inside.stdout.trim() !== "true") return null;

  const pathspec = ["--", ".", `:(exclude)${configDirName}/work/**`];
  const [diff, cached, status] = await Promise.all([
    pi.exec("git", ["diff", "--binary", "--no-ext-diff", "HEAD", ...pathspec], { cwd, timeout: 15_000 }),
    pi.exec("git", ["diff", "--binary", "--no-ext-diff", "--cached", ...pathspec], { cwd, timeout: 15_000 }),
    pi.exec("git", ["status", "--porcelain=v1", "--untracked-files=all", ...pathspec], { cwd, timeout: 15_000 }),
  ]);

  return createHash("sha256")
    .update(diff.stdout)
    .update("\0")
    .update(cached.stdout)
    .update("\0")
    .update(status.stdout)
    .digest("hex");
}
