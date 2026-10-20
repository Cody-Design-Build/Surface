import { useEffect, useId, useRef, useState } from "react";
import { appAtPath, apps, appUrl } from "../../surfaces.mts";
import { Icon } from "./Icon.tsx";

export function AppSwitcher({ beforeNavigate }: { beforeNavigate?: () => boolean }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const current = appAtPath(location.pathname) ?? apps[0];

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  return <div className="app-switcher" ref={root} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }} onKeyDown={event => {
    if (event.key === "Escape" && open) {
      event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus();
    }
    if (open && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const links = [...(root.current?.querySelectorAll<HTMLAnchorElement>("nav a") ?? [])];
      const index = links.indexOf(document.activeElement as HTMLAnchorElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? links.length - 1 : event.key === "ArrowDown" ? (index + 1) % links.length : (index <= 0 ? links.length : index) - 1;
      links[next]?.focus();
    }
  }}>
    <button ref={trigger} className="app-switcher-trigger" aria-label={`Switch app, ${current.name}`} aria-expanded={open} aria-controls={menuId} onClick={() => setOpen(value => !value)} onKeyDown={event => {
      if (!open && event.key === "ArrowDown") { event.preventDefault(); setOpen(true); }
    }}>
      <span className="app-switcher-mark" aria-hidden="true">S</span>
      <strong>{current.name}</strong><Icon name="chevron" size={13} />
    </button>
    {open && <nav id={menuId} className="app-switcher-menu" aria-label="Apps">
      <div className="app-switcher-heading">Your apps</div>
      {apps.map(app => <a key={app.id} href={appUrl(app, location.pathname)} aria-current={app.id === current.id ? "page" : undefined} onClick={event => {
        // Keep native new-tab behavior without touching the current tab's edits.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        if (app.id === current.id) { event.preventDefault(); setOpen(false); trigger.current?.focus(); return; }
        if (beforeNavigate && !beforeNavigate()) { event.preventDefault(); return; }
        setOpen(false);
      }}>
        <span className="app-switcher-icon"><Icon name={app.icon} size={19} /></span>
        <span className="app-switcher-label"><strong>{app.name}</strong><small>{app.description}</small></span>
        {app.id === current.id && <span className="app-switcher-current" aria-hidden="true">✓</span>}
      </a>)}
    </nav>}
  </div>;
}
