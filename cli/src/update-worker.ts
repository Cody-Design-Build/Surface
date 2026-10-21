// A separate process survives the local server restart during an update.
import { runUpdateJob } from "./update.ts";
const [id, operation] = process.argv.slice(2);
if (!/^[a-f0-9]{24}$/.test(id ?? "") || !["check", "install"].includes(operation ?? "")) throw new Error("Invalid update job");
await runUpdateJob(id, operation as "check" | "install").catch(() => { process.exitCode = 1; });
