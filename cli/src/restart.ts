// Restart installed source without a Git update, including older unmanaged servers.
import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR, findCheckout, readJson } from "./config.ts";
import { UserError } from "./client.ts";
import { openSurface, running, startServer } from "./open.ts";
import { ROOT, runCommand, serviceAction, serviceInstalled } from "./service.ts";
import { ensureAppBuild } from "./app-build.ts";
import { installedVersion } from "./system.ts";

export async function restartLocal() {
  let server = await running();
  const managed = serviceInstalled();
  let checkout;
  if (!server) {
    const record = readJson<{pid?:number;port?:number;root?:string}>(path.join(CONFIG_DIR,"serve.json"),{});
    if (record.pid) {
      let stopped = false;
      try { process.kill(record.pid,0); } catch (error) { stopped = (error as NodeJS.ErrnoException).code === "ESRCH"; }
      if (!stopped) throw new UserError("No reachable Surface server from this terminal, but its recorded process may still be running. Use the desktop's normal terminal to restart it.");
    }
    checkout = findCheckout() ?? (record.root ? findCheckout(record.root) : null);
    if (!checkout) throw new UserError("Run surface restart from your workspace folder to start Surface again.");
    const port = record.port ?? 4317;
    if (managed) {
      ensureAppBuild(ROOT, installedVersion());
      serviceAction("restart");
    }
    else await startServer(checkout,port);
    server = {root:checkout.root,port};
  } else {
    checkout = findCheckout(server.root);
    if (!checkout) throw new UserError(`No checkout at ${server.root}; the server was left running.`);
    if (managed) {
      ensureAppBuild(ROOT, installedVersion());
      serviceAction("restart");
    }
    else {
      const record = readJson<{pid?:number;port?:number}>(path.join(CONFIG_DIR,"serve.json"),{});
      const pid = record.pid;
      if (!Number.isSafeInteger(pid) || pid! <= 0 || pid === process.pid || record.port !== server.port) throw new UserError("Cannot verify the server PID; it was left running.");
      const inspected = runCommand("ps",["-p",String(pid),"-o","command="],{quiet:true,allowFailure:true});
      const command = inspected.stdout?.trim() ?? "";
      if (inspected.status !== 0 || !command.includes(path.join(ROOT,"cli/src/main.ts")) || !/(?:^|\s)serve(?:\s|$)/.test(command)) throw new UserError("Cannot verify that the recorded process is this Surface server. Stop it in its original terminal, then run surface serve.");
      ensureAppBuild(ROOT, installedVersion());
      process.kill(pid!,"SIGTERM");
      const deadline = Date.now()+30000;
      while (true) {
        let alive = true;
        try { process.kill(pid!,0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; else throw error; }
        if (!alive) break;
        if (Date.now()>deadline) throw new UserError("The old server did not stop cleanly. Check it before starting another one.");
        await new Promise(resolve=>setTimeout(resolve,200));
      }
      await startServer(checkout,server.port);
    }
  }
  const token = fs.readFileSync(path.join(CONFIG_DIR,"serve-token"),"utf8").trim();
  const deadline = Date.now()+15000;
  while (true) {
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/system`,{headers:{cookie:`surface_token=${token}`},signal:AbortSignal.timeout(2000)});
      const info = response.ok ? await response.json() as {version?:{number?:string};account?:unknown} : null;
      if (info?.version?.number && "account" in info) break;
    } catch { /* Managed services can take a moment to restart. */ }
    if (Date.now()>deadline) throw new UserError("The account/update API did not come up. Check ~/.config/surface-cli/serve.log.");
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  return openSurface(checkout,null,{port:server.port,print:true});
}
