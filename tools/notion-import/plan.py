#!/usr/bin/env python3
"""Turn a Notion export (export.py output) into a Surface import plan (plan.json).

The mapping below is CDB's Notion workspace. Each Notion database becomes a Surface type;
two copies of the same database (per-job Selections / Orders) merge into one type with a job link.
Relations are kept once (on the side with fewer links); the other side is a backlink in Surface.
Formulas and rollups are imported as their current values (static), noted in the field name.
"""
import json, os, re, sys, collections

SRC = sys.argv[1] if len(sys.argv) > 1 else "."
rows = json.load(open(f"{SRC}/rows.json"))
pages = json.load(open(f"{SRC}/pages_search.json"))
md = {f[:-5]: json.load(open(f"{SRC}/md/{f}")).get("markdown", "") for f in os.listdir(f"{SRC}/md")}

DS = {
    "organization": ["3228e0d8-a1ad-8121-ad0f-000bba6a5873"],
    "contact": ["3198e0d8-a1ad-8147-a7ef-000b58f72d77"],
    "job": ["f36d7efd-efc0-4e60-8622-ddb0545db22a"],
    "task": ["53dbecb0-365c-440b-b399-08fc2ea0b711"],
    "selection": ["7e8003c5-3983-4b98-990a-205059bef62c", "5b38e0d8-a1ad-82d4-9afb-078c4c82d9e8"],
    "order": ["f1cfdd2a-3dec-4cf0-b80e-963e9520170e", "19b8e0d8-a1ad-82fa-9b1b-87d8b47a5b75"],
    "tile_surface": ["a51af7c3-01fe-4fb0-be84-7546b348a010"],
    "lead": ["247a20a5-154e-4969-b88c-241b6beb559e"],
}

def F(key, kind, src=None, name=None, **kw):
    return {"key": key, "kind": kind, "src": src or [], "name": name or key.replace("_", " ").capitalize(), **kw}

# key, kind, Notion property names (any of), extras. "body" = goes into the Markdown body.
TYPES = {
    "organization": dict(name="Organization", folder="Organizations", display="fields", fields=[
        F("category", "multi_select", ["Category"]), F("specialties", "multi_select", ["Specialties"]),
        F("trades", "text", ["Trades"]), F("phone", "phone", ["Phone"]), F("email", "email", ["Email"]),
        F("website", "url", ["Website"]), F("address", "text", ["Address"]), F("license", "text", ["License"]),
        F("w9_on_file", "checkbox", ["W-9 on file"], name="W-9 on file"),
    ], body=["Notes"]),
    "contact": dict(name="Contact", folder="Contacts", display="fields", fields=[
        F("organizations", "link", ["Organizations"], target="organization", multiple=True),
        F("role", "text", ["Role"]), F("relationship", "text", ["Relationship"]),
        F("email", "email", ["Email"]), F("phone", "phone", ["Phone"]),
        F("source_list", "select", ["Source List"]), F("specialty", "multi_select", ["Specialty"]),
        F("specialty_trade", "select", ["Specialty Trade"]),
        F("organization_name", "text", ["Organization"], name="Organization (text)"),
    ], body=["Notes"]),
    "job": dict(name="Job", folder="Jobs", display="document", fields=[
        F("status", "select", ["Status"]), F("project_type", "select", ["Project Type"]),
        F("address", "text", ["Address"]), F("contract_value", "number", ["Contract Value"]),
        F("owner", "link", ["Owner"], target="contact", multiple=True, name="Owner"),
        F("contacts", "link", ["Contacts"], target="contact", multiple=True),
        F("organizations", "link", ["Organizations"], target="organization", multiple=True),
    ], body=[]),
    "task": dict(name="Task", folder="Tasks", display="document", fields=[
        F("status", "select", ["Status"]), F("priority", "select", ["Priority"]), F("category", "select", ["Category"]),
        F("due", "date", ["Due Date"], name="Due"), F("completed", "date", ["Completed Date"], name="Completed"),
        F("reminder", "date", ["Reminder"]), F("job", "link", ["Job"], target="job"),
        F("organizations", "link", ["Organizations"], target="organization", multiple=True),
        F("contacts", "link", ["Contacts"], target="contact", multiple=True),
    ], body=["Description"]),
    "selection": dict(name="Selection", folder="Selections", display="fields", fields=[
        F("job", "link", ["Job"], target="job"), F("area", "select", ["Area"]), F("trade", "select", ["Type"], name="Trade"),
        F("product", "text", ["Product"]), F("finish", "text", ["Finish"]),
        F("quantity", "number", ["Quantity"]), F("unit", "text", ["Unit"]),
        F("reference_price", "number", ["Reference price"]), F("supplier", "text", ["Supplier"]),
        F("product_link", "url", ["Product reference link"], name="Product link"),
        F("order_status", "select", ["Order status"]), F("ordered_by", "select", ["Ordered by"]),
        F("needed_on_site", "date", ["Needed on site"]),
        F("orders", "link", ["Orders"], target="order", multiple=True),
    ], body=["Notes"]),
    "order": dict(name="Order", folder="Orders", display="fields", fields=[
        F("job", "link", ["Job"], target="job"), F("status", "select", ["Status"]),
        F("supplier", "text", ["Supplier"]), F("contact", "text", ["Contact"]),
        F("quote_number", "text", ["Quote number"]), F("quote_date", "date", ["Quote date"]),
        F("requested", "date", ["Requested date"]), F("ordered", "date", ["Ordered date"]),
        F("expected_delivery", "date", ["Expected delivery"]), F("order_number", "text", ["Order number"]),
        F("subtotal", "number", ["Subtotal"]), F("tax", "number", ["Tax"]), F("shipping", "number", ["Shipping"]),
        F("total", "number", ["Total"]), F("source_email", "url", ["Source email"]),
    ], body=["Notes"]),
    "tile_surface": dict(name="Tile surface", folder="Tile surfaces", display="fields", fields=[
        F("job", "link", [], target="job"), F("selection", "link", ["Procurement item"], target="selection", name="Material item"),
        F("sequence", "number", ["Sequence"]), F("room", "select", ["Room"]), F("surface_type", "select", ["Surface type"]),
        F("material_type", "select", ["Material type"]), F("calculation", "select", ["Calculation"]),
        F("length_in", "number", ["Length in"], name="Length (in)"), F("width_in", "number", ["Width or height in"], name="Width or height (in)"),
        F("count", "number", ["Count"]), F("area_input_sf", "number", ["Area input SF"], name="Area input (SF)"),
        F("deduct_sf", "number", ["Deduct SF"], name="Deduct (SF)"), F("net_sf", "number", ["Net SF"], name="Net SF"),
        F("waste_percent", "number", ["Waste percent"]), F("include_waste", "checkbox", ["Include waste"]),
        F("sf_with_waste", "number", ["SF with waste"], name="SF with waste (imported value)"),
        F("drawing", "url", ["Drawing"]), F("sheet_reference", "text", ["Sheet reference"]),
        F("material_note", "text", ["Material note"]),
    ], body=["Notes"]),
    "lead": dict(name="Referral lead", folder="Referral leads", display="fields", fields=[
        F("status", "select", ["Status"]), F("priority", "select", ["Priority"]),
        F("company", "text", ["Company"]), F("trade", "text", ["Trade"]),
        F("chapter", "text", ["Chapter"]), F("chapter_city", "text", ["Chapter City"]), F("business_city", "text", ["Business City"]),
        F("phone", "phone", ["Phone"]), F("email", "email", ["Email"]), F("website", "url", ["Website"]),
        F("source", "url", ["Source"]), F("next_step", "text", ["Next Step"]),
        F("next_follow_up", "date", ["Next Follow-up"]), F("last_contacted", "date", ["Last Contacted"]),
        F("list", "select", [], name="List"),
    ], body=["Notes"]),
}
PAGE_FIELDS = [F("job", "link", [], target="job")]

def plain(rt):
    return "".join(x.get("plain_text", "") for x in rt or [])

def title_of(p):
    for v in p.get("properties", {}).values():
        if v["type"] == "title":
            return plain(v["title"]).strip()
    return plain(p.get("title")).strip()

def nid(s):
    s = s.replace("-", "")
    return f"{s[:8]}-{s[8:12]}-{s[12:16]}-{s[16:20]}-{s[20:32]}" if len(s) >= 32 else s

def value(prop):
    t = prop["type"]; v = prop.get(t)
    if t in ("rich_text", "title"): return plain(v).strip() or None
    if t in ("select", "status"): return v["name"] if v else None
    if t == "multi_select": return [o["name"] for o in v] or None
    if t == "date": return v["start"][:10] if v else None
    if t in ("number", "url", "email", "phone_number", "checkbox"): return v
    if t == "relation": return [nid(r["id"]) for r in v] or None
    if t == "formula":
        return v.get(v["type"]) if v else None
    if t == "rollup":
        if v and v["type"] == "array":
            out = [value(x) for x in v["array"]]
            out = [o for o in out if o]
            return ", ".join(map(str, out)) or None
        return v.get(v["type"]) if v else None
    if t == "files": return [f.get("name") for f in v] or None
    return None

# ------------------------------------------------------------------ records
records = {}   # notion id -> record
src_type = {}  # notion id -> surface type
for tkey, dsids in DS.items():
    for d in dsids:
        for r in rows[d]:
            src_type[nid(r["id"])] = tkey

job_ids = [nid(r["id"]) for r in rows[DS["job"][0]]]
STEINER = next(j for j in job_ids if "Steiner" in title_of(next(r for r in rows[DS["job"][0]] if nid(r["id"]) == j)))

for tkey, dsids in DS.items():
    spec = TYPES[tkey]
    for d in dsids:
        for r in rows[d]:
            P = r["properties"]
            rec = {"nid": nid(r["id"]), "type": tkey, "title": title_of(r) or "Untitled", "fields": {}, "links": {}, "body": "", "parent": None,
                   "url": r.get("url"), "created": r.get("created_time"), "edited": r.get("last_edited_time")}
            for f in spec["fields"]:
                for s in f["src"]:
                    if s in P:
                        v = value(P[s])
                        if v in (None, [], ""): continue
                        if f["kind"] == "link":
                            rec["links"][f["key"]] = v if f.get("multiple") else v[:1]
                        elif f["kind"] == "url" and isinstance(v, str):
                            v = v.strip()
                            if not re.match(r"^[a-z][a-z0-9+.-]*://", v, re.I): v = "https://" + v.lstrip("/")
                            rec["fields"][f["key"]] = v
                        elif f["kind"] == "phone" and isinstance(v, str):
                            rec["fields"][f["key"]] = v
                        elif f["kind"] == "number" and isinstance(v, str):
                            try: rec["fields"][f["key"]] = float(v)
                            except ValueError: pass
                        else:
                            rec["fields"][f["key"]] = v
                        break
            notes = [value(P[b]) for b in spec["body"] if b in P and value(P[b])]
            rec["_notes"] = "\n\n".join(notes)
            if tkey == "tile_surface": rec["links"]["job"] = [STEINER]
            if tkey == "lead": rec["fields"]["list"] = "BNI"
            if tkey == "order" and P.get("Documents") and value(P["Documents"]):
                rec["_notes"] += ("\n\n" if rec["_notes"] else "") + "Documents in Notion: " + ", ".join(value(P["Documents"]))
            records[rec["nid"]] = rec

# Notion "Owner" + "Contacts" on jobs often list the same person twice: keep owners out of contacts
for r in records.values():
    if r["type"] == "job" and r["links"].get("owner") and r["links"].get("contacts"):
        r["links"]["contacts"] = [c for c in r["links"]["contacts"] if c not in r["links"]["owner"]] or None
        if not r["links"]["contacts"]: del r["links"]["contacts"]

# ------------------------------------------------------------------ standalone pages
SHELLS = {"Databases", "Projects", "[Archive-Projects]"}  # navigation-only containers in Notion
by_nid = {nid(p["id"]): p for p in pages}
job_page = {}  # notion project page id -> job record nid
for j in job_ids:
    jr = next(r for r in rows[DS["job"][0]] if nid(r["id"]) == j)
    url = jr["properties"]["Project Page"]["url"] or ""
    m = re.search(r"([0-9a-f]{32})", url.replace("-", ""))
    if m: job_page[nid(m.group(1))] = j

for p in pages:
    if p["parent"]["type"] == "data_source_id": continue
    pid = nid(p["id"]); t = title_of(p)
    if t in SHELLS: continue
    if pid in job_page:
        records[job_page[pid]]["_page"] = pid  # the job's document = its Notion project page
        continue
    rec = {"nid": pid, "type": "page", "title": t or "Untitled", "fields": {}, "links": {}, "body": "", "parent": None, "url": p.get("url"),
           "created": p.get("created_time"), "edited": p.get("last_edited_time")}
    # parent page -> parent; a job's project page -> nest under the job and link it
    par = p["parent"].get("page_id")
    par = nid(par) if par else None
    hops, cur = 0, par
    while cur and hops < 6:
        if cur in job_page:
            rec["links"]["job"] = [job_page[cur]]
            break
        cur = nid(by_nid[cur]["parent"]["page_id"]) if cur in by_nid and by_nid[cur]["parent"].get("page_id") else None
        hops += 1
    if par in job_page: pass  # directly under the job's page: the job link places it (no parent)
    elif par in by_nid and title_of(by_nid[par]) not in SHELLS: rec["parent"] = par
    records[pid] = rec

# ------------------------------------------------------------------ titles must be unique per type for [[links]]
seen = collections.defaultdict(list)
for r in records.values(): seen[(r["type"], r["title"].lower())].append(r)
for (tkey, _), rs in seen.items():
    if len(rs) < 2: continue
    for r in rs:
        extra = r["fields"].get("area") or r["fields"].get("room") or r["fields"].get("surface_type")
        jid = (r["links"].get("job") or [None])[0]
        jt = records[jid]["title"].split(" - ")[0] if jid in records else None
        r["title"] = " — ".join(x for x in [r["title"], extra, jt if not extra else None] if x)
    seen2 = collections.Counter(r["title"].lower() for r in rs)
    for r in rs:
        if seen2[r["title"].lower()] > 1:
            r["title"] += f" ({r['nid'][:4]})"
# titles unique across all types too (wikilinks are resolved by title)
allc = collections.Counter(r["title"].lower() for r in records.values())
for r in records.values():
    if allc[r["title"].lower()] > 1 and r["type"] != "job":
        r["title"] = f"{r['title']} ({TYPES.get(r['type'], {'name': 'Page'})['name']})"

title_by_nid = {k: r["title"] for k, r in records.items()}

# ------------------------------------------------------------------ body conversion
VIEW_FOR_DS = {"53dbecb0-365c-440b-b399-08fc2ea0b711": "job-tasks", "7e8003c5-3983-4b98-990a-205059bef62c": "job-selections",
               "5b38e0d8-a1ad-82d4-9afb-078c4c82d9e8": "job-selections", "f1cfdd2a-3dec-4cf0-b80e-963e9520170e": "job-orders",
               "19b8e0d8-a1ad-82fa-9b1b-87d8b47a5b75": "job-orders", "a51af7c3-01fe-4fb0-be84-7546b348a010": "job-tile",
               "3228e0d8-a1ad-8121-ad0f-000bba6a5873": "organizations", "3198e0d8-a1ad-8147-a7ef-000b58f72d77": "contacts",
               "f36d7efd-efc0-4e60-8622-ddb0545db22a": "all-jobs", "247a20a5-154e-4969-b88c-241b6beb559e": "referral-leads"}
unresolved = collections.Counter()

def link_for(url, label=None):
    m = re.search(r"([0-9a-f]{32})", (url or "").replace("-", ""))
    if m:
        k = nid(m.group(1))
        k = job_page.get(k, k)
        if k in title_by_nid:
            t = title_by_nid[k]
            return f"[[{t}|{label}]]" if label and label != t else f"[[{t}]]"
    unresolved[url] += 1
    return f"[{label or 'Notion link'}]({url})"

def convert(text):
    if not text: return ""
    def db(m):
        dsid = re.search(r"collection://([0-9a-f-]+)", m.group(0))
        v = VIEW_FOR_DS.get(dsid.group(1)) if dsid else None
        return f"\n```surface\nview: {v}\n```\n" if v else ""
    text = re.sub(r"<database[^>]*>.*?</database>|<database[^>]*/>", db, text, flags=re.S)
    text = re.sub(r'<mention-page url="([^"]+)"\s*/>', lambda m: link_for(m.group(1)), text)
    text = re.sub(r'<mention-page url="([^"]+)">(.*?)</mention-page>', lambda m: link_for(m.group(1), m.group(2)), text)
    text = re.sub(r'<page url="([^"]+)"[^>]*>(.*?)</page>', lambda m: link_for(m.group(1), m.group(2)), text)
    text = re.sub(r'<mention-date start="([^"]+)"[^>]*/>', lambda m: m.group(1)[:10], text)
    text = re.sub(r'<mention-user[^>]*/>', "@someone", text)
    text = re.sub(r"<empty-block\s*/>", "", text)
    text = re.sub(r'<pdf src="([^"]+)"[^>]*>(.*?)</pdf>|<pdf src="([^"]+)"[^>]*/>', lambda m: f"[PDF]({m.group(1) or m.group(3)})", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()

for k, r in records.items():
    parts = []
    if r.get("_notes"): parts.append(r["_notes"].strip())
    src = md.get(r.get("_page") or k, "")
    if src.strip(): parts.append(convert(src))
    # a job page that pointed back at the register row: drop that self-link line
    body = "\n\n".join(p for p in parts if p)
    body = re.sub(r"^\*\*Project register:\*\*.*\n?", "", body, flags=re.M)
    r["body"] = body.strip()
    r.pop("_notes", None)

# links to records we didn't import (other Notion DBs): drop, but count
dropped = collections.Counter()
for r in records.values():
    for key, ids in list(r["links"].items()):
        keep = [i for i in ids if i in records]
        if len(keep) < len(ids): dropped[(r["type"], key)] += len(ids) - len(keep)
        if keep: r["links"][key] = keep
        else: del r["links"][key]

# select options from the data (Notion option lists + values seen)
for tkey, spec in TYPES.items():
    for f in spec["fields"]:
        if f["kind"] in ("select", "multi_select"):
            opts = []
            for d in DS[tkey]:
                ds = next((x for x in json.load(open(f"{SRC}/datasources.json")) if x["id"] == d), None)
                for s in f["src"]:
                    p = ds and ds["properties"].get(s)
                    if p and p["type"] in ("select", "multi_select", "status"):
                        for o in p[p["type"]]["options"]:
                            if o["name"] not in opts: opts.append(o["name"])
            for r in records.values():
                if r["type"] != tkey: continue
                v = r["fields"].get(f["key"])
                for x in (v if isinstance(v, list) else [v] if v else []):
                    if x not in opts: opts.append(x)
            if f["key"] == "list": opts = ["BNI"]
            f["options"] = opts or ["Other"]

plan = {
    "types": {k: {**{x: v for x, v in s.items() if x != "body"}, "fields": [{x: y for x, y in f.items() if x != "src"} for f in s["fields"]]} for k, s in TYPES.items()},
    "page_fields": [{x: y for x, y in f.items() if x != "src"} for f in PAGE_FIELDS],
    "records": list(records.values()),
}
json.dump(plan, open(f"{SRC}/plan.json", "w"), indent=1)
c = collections.Counter(r["type"] for r in records.values())
print("records:", dict(c), "total", sum(c.values()))
print("links dropped (target not imported):", dict(dropped))
print("unresolved Notion links in text:", sum(unresolved.values()), list(unresolved)[:5])
