// The apps shipped by Surface. The switcher, CLI, build and server share this list.
// Add an HTML entry in app/ and register it here; surface update builds it for everyone.
export interface SurfaceApp {
  id: string;
  name: string;
  description: string;
  icon: string;
  path: string;
  entry: string;
}

export function defineApps(apps: SurfaceApp[]): readonly SurfaceApp[] {
  const ids = new Set<string>(), paths = new Set<string>(), entries = new Set<string>();
  for (const app of apps) {
    if (!/^[a-z][a-z0-9-]*$/.test(app.id) || !app.name.trim() || !app.description.trim()) throw new Error(`Invalid app: ${app.id}`);
    if (!/^\/(?:[a-z][a-z0-9-]*\/)?$/.test(app.path) || ["/api/", "/w/", "/assets/"].includes(app.path)) throw new Error(`Invalid app path: ${app.path}`);
    if (!/^[a-z][a-z0-9-]*\.html$/.test(app.entry)) throw new Error(`Invalid app entry: ${app.entry}`);
    if (ids.has(app.id) || paths.has(app.path) || entries.has(app.entry)) throw new Error(`Duplicate app: ${app.id}`);
    ids.add(app.id); paths.add(app.path); entries.add(app.entry);
  }
  if (!paths.has("/")) throw new Error("An app must serve the root path");
  return apps;
}

export const apps = defineApps([
  { id: "writing", name: "Surface", description: "Documents and writing", icon: "page", path: "/", entry: "index.html" },
  { id: "data", name: "Surface Data", description: "Tables, records and views", icon: "table", path: "/data/", entry: "data.html" },
]);

/** Recognize public and workspace-scoped routes, including direct HTML links. */
export function appAtPath(pathname: string, registry = apps): SurfaceApp | undefined {
  const local = pathname.replace(/^\/w\/[a-z0-9]+(?=\/|$)/, "") || "/";
  return registry.find(app => local === app.path || local === app.path.slice(0, -1) || local === `/${app.entry}`);
}

/** Switch apps in this tab's workspace; authentication stays in the cookie. */
export function appUrl(app: SurfaceApp, pathname: string): string {
  const workspace = /^\/w\/[a-z0-9]+(?=\/|$)/.exec(pathname)?.[0] ?? "";
  return workspace + app.path;
}
