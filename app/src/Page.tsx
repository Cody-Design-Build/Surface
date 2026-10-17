import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type AppState, type Backlink, type RecordFull } from "./api.ts";
import { Editor, focusEditor } from "./Editor.tsx";
import { setImageBase } from "./livePreview.ts";
import { Icon, typeIcon } from "./Icon.tsx";
import { Properties } from "./Properties.tsx";
import { deleteRecord } from "./edits.ts";

export type SaveStatus = "saved" | "saving" | "error" | "conflict";

interface Props {
  id: string;
  app: AppState;
  remoteTick: number;
  remoteIds: string[];
  open: (id: string) => void;
  openTitle: (title: string) => void;
  createPage: (parent: string | null) => void;
  onStatus: (s: SaveStatus, msg?: string) => void;
  onDeleted: () => void;
  onMove: () => void;
}

// Many files start with "# Title". The app shows the title above the text, so that heading is
// tucked away while editing and written back, with the current title, when the body is saved.
function splitTitle(body: string, title: string): { text: string; heading: boolean } {
  const m = /^#[ \t]+(.+?)[ \t]*\r?\n(?:[ \t]*\r?\n)?/.exec(body);
  if (m && m[1].trim().toLowerCase() === title.trim().toLowerCase()) return { text: body.slice(m[0].length), heading: true };
  return { text: body, heading: false };
}
function joinTitle(text: string, title: string, heading: boolean) {
  return heading ? `# ${title}\n\n${text}` : text;
}

interface Pending {
  title?: string;
  body?: string;
  fields?: Record<string, unknown>;
}

export function Page({ id, app, remoteTick, remoteIds, open, openTitle, createPage, onStatus, onDeleted, onMove }: Props) {
  const [showText, setShowText] = useState(false);
  const [rec, setRec] = useState<RecordFull | null>(null);
  const [backlinks, setBacklinks] = useState<Backlink[]>([]);
  const [title, setTitle] = useState("");
  const [editorValue, setEditorValue] = useState("");
  const [fields, setFields] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [missing, setMissing] = useState(false);

  const revRef = useRef(0);
  const pending = useRef<Pending>({});
  const timer = useRef<number | undefined>(undefined);
  const inflight = useRef(false);
  const bodyRef = useRef("");
  const headingRef = useRef(false);
  const titleNow = useRef("");
  const titleRef = useRef<HTMLTextAreaElement>(null);

  const type = useMemo(() => app.types.find((t) => t.key === rec?.type), [app.types, rec?.type]);

  const load = useCallback(
    async (keepEditor = false) => {
      try {
        const { record, backlinks } = await api.record(id);
        setRec(record);
        setBacklinks(backlinks);
        revRef.current = record.rev;
        setTitle(record.title);
        setFields(record.fields);
        setImageBase(record.path && record.path.includes("/") ? record.path.split("/").slice(0, -1).join("/") : "");
        const split = splitTitle(record.body, record.title);
        headingRef.current = split.heading;
        titleNow.current = record.title;
        bodyRef.current = split.text;
        void keepEditor;
        setEditorValue(split.text);
        setMissing(false);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) setMissing(true);
      }
    },
    [id],
  );

  // open a record
  useEffect(() => {
    pending.current = {};
    window.clearTimeout(timer.current);
    setErrors({});
    setConflict(false);
    setNotice(null);
    setRec(null);
    load();
  }, [id, load]);

  // a change made elsewhere (CLI, agent, another window)
  useEffect(() => {
    if (!remoteTick) return;
    const dirty = Object.keys(pending.current).length > 0 || inflight.current;
    if (remoteIds.length && !remoteIds.includes(id)) {
      // other records changed: refresh backlinks quietly
      api.record(id).then(({ backlinks }) => setBacklinks(backlinks)).catch(() => {});
      return;
    }
    if (!dirty) load(true);
  }, [remoteTick]); // eslint-disable-line react-hooks/exhaustive-deps

  const flush = useCallback(async () => {
    if (inflight.current) return;
    const patch = pending.current;
    if (!Object.keys(patch).length) return;
    pending.current = {};
    inflight.current = true;
    onStatus("saving");
    try {
      const out = { ...patch };
      if (out.body !== undefined) out.body = joinTitle(out.body, titleNow.current, headingRef.current);
      const res = await api.save(id, { baseRev: revRef.current, ...out });
      revRef.current = res.record.rev;
      setRec(res.record);
      if (patch.fields) {
        setFields((cur) => {
          const next = { ...cur };
          for (const k of Object.keys(patch.fields!)) if (!(pending.current.fields && k in pending.current.fields)) next[k] = res.record.fields[k];
          return next;
        });
        setErrors((cur) => {
          const next = { ...cur };
          for (const k of Object.keys(patch.fields!)) delete next[k];
          return next;
        });
      }
      if (res.notices.length) {
        setNotice(res.notices.join(" · "));
        window.setTimeout(() => setNotice(null), 4000);
      }
      onStatus("saved");
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        pending.current = { ...patch, ...pending.current, fields: { ...(patch.fields ?? {}), ...(pending.current.fields ?? {}) } };
        if (!Object.keys(pending.current.fields ?? {}).length) delete pending.current.fields;
        setConflict(true);
        onStatus("conflict", "Changed elsewhere");
      } else if (e instanceof ApiError && e.status === 422 && e.errors) {
        setErrors((cur) => ({ ...cur, ...e.errors }));
        if (patch.title !== undefined || patch.body !== undefined) {
          pending.current = { ...pending.current, title: pending.current.title ?? patch.title, body: pending.current.body ?? patch.body };
        }
        onStatus("error", "Some values aren't valid");
      } else {
        pending.current = { ...patch, ...pending.current };
        onStatus("error", e instanceof Error ? e.message : "Couldn't save");
      }
    } finally {
      inflight.current = false;
      if (Object.keys(pending.current).length && !conflictRef.current) schedule(1200);
    }
  }, [id, onStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  const conflictRef = useRef(false);
  conflictRef.current = conflict;

  const schedule = useCallback(
    (ms = 600) => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, ms);
    },
    [flush],
  );

  // save before leaving the page or the app
  useEffect(() => {
    const before = () => {
      if (Object.keys(pending.current).length) flush();
    };
    window.addEventListener("beforeunload", before);
    return () => {
      window.removeEventListener("beforeunload", before);
      if (Object.keys(pending.current).length) flush();
    };
  }, [id, flush]);

  const change = (p: Pending) => {
    pending.current = { ...pending.current, ...p, fields: p.fields ? { ...(pending.current.fields ?? {}), ...p.fields } : pending.current.fields };
    if (!pending.current.fields) delete pending.current.fields;
    if (!conflict) schedule(p.fields ? 150 : 700);
    onStatus("saving");
  };

  const keepMine = async () => {
    const { record } = await api.record(id);
    revRef.current = record.rev;
    setConflict(false);
    flush();
  };
  const useTheirs = async () => {
    pending.current = {};
    setConflict(false);
    await load();
    onStatus("saved");
  };

  const crumbs = useMemo(() => {
    const out: { id: string; title: string }[] = [];
    const byId = new Map(app.records.map((r) => [r.id, r]));
    let p = rec?.parent ? byId.get(rec.parent) : undefined;
    for (let i = 0; p && i < 8; i++) {
      out.unshift({ id: p.id, title: p.title });
      p = p.parent ? byId.get(p.parent) : undefined;
    }
    return out;
  }, [app.records, rec?.parent]);

  const children = useMemo(() => app.records.filter((r) => r.parent === id).sort((a, b) => a.title.localeCompare(b.title)), [app.records, id]);
  const titles = useCallback(() => app.records.map((r) => r.title), [app.records]);

  useEffect(() => {
    const el = titleRef.current;
    if (el) {
      el.style.height = "0px";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [title, rec?.id]);

  // new, untitled pages start with the title selected
  useEffect(() => {
    if (rec && rec.title === "Untitled" && rec.rev === 1 && !rec.body) {
      titleRef.current?.focus();
      titleRef.current?.select();
    }
  }, [rec?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (missing) return <div className="page-empty">This record was deleted or isn't in this checkout.</div>;
  if (!rec) return <div className="page-loading" />;

  return (
    <article className={`page ${type?.display === "fields" ? "is-fields" : ""}`}>
      <header className="page-head">
        <div className="crumbs">
          {crumbs.map((c) => (
            <span key={c.id} className="crumb">
              <button onClick={() => open(c.id)}>{c.title}</button>
              <span className="crumb-sep">/</span>
            </span>
          ))}
        </div>
        <div className="page-actions">
          <div className="menu-wrap">
            <button className="icon-btn" onClick={() => setMenu(!menu)} aria-label="Page menu">
              <Icon name="more" size={18} />
            </button>
            {menu ? (
              <div className="menu menu-right" onMouseLeave={() => setMenu(false)}>
                <button className="menu-item" onClick={() => (createPage(id), setMenu(false))}>
                  <Icon name="nest" size={14} /> Add a page inside
                </button>
                <button className="menu-item" onClick={() => (onMove(), setMenu(false))}>
                  <Icon name="move" size={14} /> Move to…
                </button>
                {rec.path ? (
                  <button className="menu-item" onClick={() => (navigator.clipboard.writeText(`${app.root}/${rec.path}`), setMenu(false))}>
                    <Icon name="copy" size={14} /> Copy file path
                  </button>
                ) : null}
                <button className="menu-item" onClick={() => (navigator.clipboard.writeText(rec.id), setMenu(false))}>
                  <Icon name="copy" size={14} /> Copy ID
                </button>
                <div className="menu-sep" />
                <button
                  className="menu-item danger"
                  onClick={async () => {
                    setMenu(false);
                    await deleteRecord(rec);
                    onDeleted();
                  }}
                >
                  <Icon name="trash" size={14} /> Delete
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      {conflict ? (
        <div className="banner">
          <span>This page changed somewhere else while you were editing.</span>
          <button onClick={keepMine}>Keep my version</button>
          <button onClick={useTheirs}>Use theirs</button>
        </div>
      ) : null}

      <div className="page-body">
        <textarea
          ref={titleRef}
          className="title"
          value={title}
          rows={1}
          placeholder="Untitled"
          spellCheck
          onChange={(e) => {
            const v = e.target.value.replace(/\n/g, "");
            setTitle(v);
            if (v.trim()) {
              titleNow.current = v.trim();
              change(headingRef.current ? { title: v.trim(), body: bodyRef.current } : { title: v.trim() });
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || (e.key === "ArrowDown" && (e.target as HTMLTextAreaElement).selectionStart === title.length)) {
              e.preventDefault();
              focusEditor(true);
            }
          }}
        />
        <div className="meta">
          <span className="type-badge">
            <Icon name={typeIcon(rec.type)} size={13} />
            {type?.name ?? rec.type}
          </span>
          {rec.path && rec.path.includes("/") ? (
            <span className="meta-path" title={`${app.root}/${rec.path}`}>
              {rec.path.split("/").slice(0, -1).join(" › ")}
            </span>
          ) : null}
          {notice ? <span className="meta-notice">{notice}</span> : null}
        </div>

        {type ? (
          <Properties
            fields={type.fields}
            values={fields}
            errors={errors}
            records={app.records}
            typeKeyOf={(rid) => app.records.find((r) => r.id === rid)?.type}
            onChange={(k, v) => {
              setFields((cur) => ({ ...cur, [k]: v }));
              change({ fields: { [k]: v } });
            }}
            onOpen={open}
          />
        ) : null}

        {type?.display === "fields" && !editorValue.trim() && !showText ? (
          <button className="add-notes" onClick={() => setShowText(true)}>
            <Icon name="page" size={14} /> Add notes
          </button>
        ) : (
        <Editor
          docKey={rec.id}
          value={editorValue}
          titles={titles}
          onChange={(v) => {
            bodyRef.current = v;
            change({ body: v });
          }}
          openLink={openTitle}
          onEscapeUp={() => titleRef.current?.focus()}
        />
        )}

        {children.length || backlinks.length ? (
          <footer className="page-foot">
            {children.length ? (
              <section>
                <h4>Pages inside</h4>
                <ul className="ref-list">
                  {children.map((c) => (
                    <li key={c.id}>
                      <button onClick={() => open(c.id)}>
                        <Icon name={typeIcon(c.type)} size={14} />
                        {c.title}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {backlinks.filter((b) => b.via !== "nested").length ? (
              <section>
                <h4>Linked from</h4>
                <ul className="ref-list">
                  {backlinks
                    .filter((b) => b.via !== "nested")
                    .map((b) => (
                      <li key={b.id}>
                        <button onClick={() => open(b.id)}>
                          <Icon name={typeIcon(b.type)} size={14} />
                          {b.title}
                          <span className="ref-via">{b.via === "mention" ? "mentions this" : b.via}</span>
                        </button>
                      </li>
                    ))}
                </ul>
              </section>
            ) : null}
          </footer>
        ) : null}
      </div>
    </article>
  );
}
