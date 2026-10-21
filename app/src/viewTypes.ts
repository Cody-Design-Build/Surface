import { apps } from "../../surfaces.mts";
import type { AppState } from "./api.ts";

/** Show existing workspace views, rather than every installed surface. */
export function workspaceViewTypes(app: Pick<AppState, "root" | "types">) {
  return apps.filter(view => {
    if (view.id === "writing") return !!app.root;
    // Every defined type has an All records table, even without a saved view.
    if (view.id === "data") return app.types.length > 0;
    // New surfaces must declare their workspace availability before appearing.
    return false;
  });
}
