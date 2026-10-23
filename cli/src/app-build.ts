// Prepare matching browser assets before starting or stopping a Surface server.
import fs from "node:fs";
import path from "node:path";
import { apps } from "../../surfaces.mts";
import { UserError } from "./client.ts";
import { runCommand } from "./service.ts";

type AppVersion = { number: string; commit: string | null };

function matchesBuild(directory: string, version: AppVersion): boolean {
  try {
    const built = JSON.parse(fs.readFileSync(path.join(directory, "surface-build.json"), "utf8"));
    return built?.number === version.number && built?.commit === version.commit &&
      apps.every(app => fs.statSync(path.join(directory, app.entry)).isFile());
  } catch { return false; }
}

export function ensureAppBuild(root: string, version: AppVersion): void {
  const app = path.join(root, "app"), dist = path.join(app, "dist");
  if (matchesBuild(dist, version)) return;
  let temporary: string | null = null;
  let preserveBackup = false;
  try {
    temporary = fs.mkdtempSync(path.join(app, ".surface-build-"));
    const output = path.join(temporary, "dist"), backup = path.join(temporary, "previous");
    runCommand("npm", ["run", "build", "--", "--outDir", output], { cwd: app });
    if (!matchesBuild(output, version)) throw new Error("The build did not produce matching surface-build.json metadata and every app HTML entry point.");
    const previous = fs.existsSync(dist);
    if (previous) fs.renameSync(dist, backup);
    try { fs.renameSync(output, dist); }
    catch (error) {
      if (previous) {
        try { fs.renameSync(backup, dist); }
        catch (recovery) {
          preserveBackup = true;
          throw new Error(`Publishing failed: ${(error as Error).message}. Restoring app/dist also failed: ${(recovery as Error).message}. Previous assets are preserved at ${backup}.`);
        }
      }
      throw error;
    }
  } catch (error) {
    throw new UserError(`Could not prepare the Surface web app: ${(error as Error).message}\nFix the build error in ${app} before starting or restarting Surface (npm run build).`);
  } finally {
    if (temporary && !preserveBackup) fs.rmSync(temporary, { recursive: true, force: true });
  }
}
