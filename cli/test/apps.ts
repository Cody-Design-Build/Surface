import assert from "node:assert/strict";
import fs from "node:fs";
import { appAtPath, apps, appUrl, defineApps } from "../../surfaces.mts";

for (const app of apps) {
  assert(fs.existsSync(new URL(`../../app/${app.entry}`, import.meta.url)), `${app.id} has an HTML entry`);
  for (const pathname of [app.path, `/${app.entry}`, app.path.slice(0, -1) || "/"]) {
    assert.equal(appAtPath(pathname)?.id, app.id);
    assert.equal(appAtPath(`/w/abc123${pathname}`)?.id, app.id);
  }
  assert.equal(appUrl(app, "/w/abc123/data/"), `/w/abc123${app.path}`);
  assert.equal(appUrl(app, "/data.html"), app.path);
}
assert.equal(appAtPath("/api/state"), undefined);
assert.equal(appAtPath("/database/"), undefined);
assert.equal(appAtPath("/assets/data.js"), undefined);
const future = { id: "projects", name: "Projects", description: "Job progress", icon: "project", path: "/projects/", entry: "projects.html" };
const expanded = defineApps([...apps, future]);
assert.equal(appAtPath("/w/abc123/projects/", expanded), future);
assert.equal(appAtPath("/projects.html", expanded), future);
assert.equal(appUrl(future, "/w/xyz789/"), "/w/xyz789/projects/");
for (const patch of [{ id: apps[0].id }, { path: apps[0].path }, { entry: apps[0].entry }, { path: "/api/" }, { path: "/w/" }, { path: "/assets/" }, { path: "https://example.com/" }, { path: "/../" }, { entry: "../projects.html" }]) {
  assert.throws(() => defineApps([...apps, { ...future, ...patch }]));
}
assert.throws(() => defineApps([future]), /root path/);
console.log("App registry: existing and future routes, workspace links, and invalid definitions passed.");
