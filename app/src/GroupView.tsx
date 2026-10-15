import { useEffect, useMemo, useState } from "react";
import { api, type AppState, type RecordFull, type TreeNode } from "./api.ts";
import { Icon, typeIcon } from "./Icon.tsx";
import { Pill } from "./Properties.tsx";

/** A group in the Views tree, shown as a calm table of its records. */
export function GroupView({ app, node, path, open }: { app: AppState; node: TreeNode; path: string[]; open: (id: string) => void }) {
  const ids = useMemo(() => collect(node.children), [node]);
  const [rows, setRows] = useState<RecordFull[]>([]);
  useEffect(() => {
    if (!ids.length) return setRows([]);
    api.query({ ids }).then((r) => setRows(r.records)).catch(() => {});
  }, [ids.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  // columns: the fields of the most common type in the group
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
  const main = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const type = app.types.find((t) => t.key === main);
  const cols = (type?.fields ?? []).slice(0, 6);
  const titleOf = new Map(app.records.map((r) => [r.id, r.title]));

  const cell = (r: RecordFull, key: string) => {
    if (r.type !== main) return null;
    const v = r.fields[key];
    const f = cols.find((c) => c.key === key)!;
    if (v == null || v === "") return <span className="empty">—</span>;
    if (f.kind === "checkbox") return v ? "✓" : "";
    if (f.kind === "select") return <Pill label={String(v)} />;
    if (f.kind === "multi_select") return (v as string[]).map((x) => <Pill key={x} label={x} />);
    if (f.kind === "link") return (Array.isArray(v) ? v : [v]).map((id) => <span key={String(id)} className="cell-link">{titleOf.get(String(id)) ?? String(id)}</span>);
    if (f.kind === "number") return <span className="num">{Number(v).toLocaleString()}</span>;
    if (f.kind === "date") return new Date(String(v) + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    return String(v);
  };

  return (
    <article className="page group-page">
      <header className="page-head">
        <div className="crumbs">
          {path.slice(0, -1).map((p, i) => (
            <span key={i} className="crumb">
              <span>{p}</span>
              <span className="crumb-sep">/</span>
            </span>
          ))}
        </div>
      </header>
      <div className="page-body wide">
        <h1 className="group-title">{node.label}</h1>
        <div className="meta">
          <span className="type-badge">
            <Icon name="table" size={13} />
            {rows.length} {rows.length === 1 ? "record" : "records"}
          </span>
        </div>
        <table className="grid">
          <thead>
            <tr>
              <th>Title</th>
              {cols.map((c) => (
                <th key={c.id}>{c.name}</th>
              ))}
              <th className="col-updated">Updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} onClick={() => open(r.id)}>
                <td className="cell-title">
                  <span className="cell-title-inner">
                    <Icon name={typeIcon(r.type)} size={14} />
                    {r.title}
                  </span>
                </td>
                {cols.map((c) => (
                  <td key={c.id}>{cell(r, c.key)}</td>
                ))}
                <td className="col-updated">{new Date(r.updated_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length ? <div className="page-empty small">Nothing here yet.</div> : null}
      </div>
    </article>
  );
}

function collect(nodes: TreeNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.kind === "record" && n.id && !out.includes(n.id)) out.push(n.id);
    else if (n.kind === "group") collect(n.children, out);
  }
  return out;
}
