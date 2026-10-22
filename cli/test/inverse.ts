// Pure read projection and Markdown invariants; no database or network required.
import assert from "node:assert/strict";
import { materializeInverseLinks, type RecordRow, type TypeRow } from "../src/db.ts";
import { parse, render } from "../src/markdown.ts";

const type = (id: string, key: string, fields: TypeRow["fields"], workspace = "workspace"): TypeRow => ({
  id, key, workspace_id: workspace, name: key, icon: null, folder: null, fields, is_builtin: false,
});
const organization = type("organizations", "organization", [
  { id: "inverse", key: "contacts", name: "Contacts", kind: "link", target: "contacts", multiple: true, inverse: "forward" },
  { id: "notes", key: "notes", name: "Notes", kind: "text" },
]);
const contact = type("contacts", "contact", [
  { id: "forward", key: "organizations", name: "Organizations", kind: "link", target: "organizations", multiple: true },
]);
const record = (id: string, type_id: string, fields: RecordRow["fields"] = {}, extra: Partial<RecordRow> = {}): RecordRow => ({
  id, type_id, workspace_id: "workspace", title: id, fields, body: "", folder: null, parent_id: null,
  rev: 1, created_at: "2026-10-22T00:00:00Z", updated_at: "2026-10-22T00:00:00Z", deleted_at: null, ...extra,
});
const org = record("org", organization.id, { notes: "Kept" });
const otherOrg = record("other-org", organization.id);
const anna = record("anna", contact.id, { forward: [org.id, org.id, otherOrg.id] });
const ben = record("ben", contact.id, { forward: [org.id] });
const deleted = record("deleted", contact.id, { forward: [org.id] }, { deleted_at: "2026-10-22T01:00:00Z" });
const foreign = record("foreign", contact.id, { forward: [org.id] }, { workspace_id: "another-workspace" });
const wrongType = record("wrong-type", organization.id, { forward: [org.id] });
const raw = [org, otherOrg, ben, anna, deleted, foreign, wrongType];
const before = JSON.stringify(raw);
const shown = materializeInverseLinks(raw, [organization, contact]);
assert.deepEqual(shown[0].fields, { notes: "Kept", inverse: ["anna", "ben"] });
assert.deepEqual(shown[1].fields.inverse, ["anna"]);
assert.equal(JSON.stringify(raw), before, "read materialization must not mutate canonical rows or arrays");
assert.equal(shown[2], ben, "ordinary records need no projection copy");
assert.deepEqual(materializeInverseLinks([org], [organization, contact], raw)[0].fields.inverse, ["anna", "ben"], "an id lookup or partial checkout uses all source rows");
assert.deepEqual(materializeInverseLinks([org], [organization, contact], [deleted, foreign, wrongType])[0].fields.inverse, []);
assert.deepEqual(materializeInverseLinks([record("org", organization.id, { inverse: ["stale"] })], [organization, contact], raw)[0].fields.inverse, ["anna", "ben"], "stale reverse values never override the canonical forward relation");

// Permanent field ids, not mutable source keys, identify the stored relationship.
const renamed = { ...contact, key: "person", fields: contact.fields.map(f => ({ ...f, key: "employers" })) };
assert.deepEqual(materializeInverseLinks([org], [organization, renamed], raw)[0].fields.inverse, ["anna", "ben"]);
const noInverse = materializeInverseLinks(raw, [contact, { ...organization, fields: organization.fields.filter(f => !f.inverse) }]);
assert.equal(noInverse[0], org);
assert.deepEqual(anna.fields.forward, [org.id, org.id, otherOrg.id], "removing reverse presentation does not alter stored memberships");

const markdown = render(shown[0], organization, id => id);
const frontmatter = parse(markdown).frontmatter!;
assert.equal(Object.hasOwn(frontmatter, "contacts"), false, "computed inverse values must not be serialized to Markdown");
assert.equal(frontmatter.notes, "Kept");
assert.equal(parse(render(anna, contact, id => id)).frontmatter!.organizations instanceof Array, true, "stored forward links remain serialized");
console.log("ok inverse projections: canonical source, partial reads, deletions, renames, immutability and Markdown");
