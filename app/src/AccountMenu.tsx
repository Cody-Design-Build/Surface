import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { type SystemInfo } from "./api.ts";
import { ACCENTS, useAppearance, type Appearance } from "./appearance.ts";
import { Icon } from "./Icon.tsx";

export function AccountMenu({ system, unavailable, onRetry }: {
  system: SystemInfo | null; unavailable: boolean; onRetry: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [appearance, updateAppearance] = useAppearance();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const account = system?.account;
  return <div className="app-account" ref={root} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }} onKeyDown={event => {
    if (event.key === "Escape" && open) {
      event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus();
    }
  }}>
    <button className="app-account-trigger" ref={trigger} aria-label="Account menu" aria-haspopup="dialog" aria-expanded={open} aria-controls={id} title={account?.email ?? "Account and appearance"} onClick={() => setOpen(value => !value)}>
      <Icon name="user" size={19} />
    </button>
    {open && <section className="app-account-menu" id={id} role="dialog" aria-label="Account and appearance">
      <div className="app-account-details">
        <span className="app-menu-heading">Account</span>
        {account ? <><strong>{account.name || account.email}</strong>{account.name && <span>{account.email}</span>}<small>Signed in on {system.machine}</small></> : <>
          <strong>{system ? "Not signed in" : unavailable ? "Account unavailable" : "Loading account…"}</strong>
          <small>{system ? "No Surface account is signed in on this computer." : unavailable ? "Reconnect or restart the local server to load your account." : "Getting your account details."}</small>
          {unavailable && <button className="btn-soft" onClick={onRetry}>Retry</button>}
        </>}
      </div>
      <fieldset className="app-appearance">
        <legend>Appearance</legend>
        <label className="app-setting-row"><span>Theme</span><select aria-label="Theme" value={appearance.theme} onChange={event => updateAppearance({theme:event.target.value as Appearance["theme"]})}>
          <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
        </select></label>
        <div className="app-setting-row"><span>Color theme</span><div className="app-accent-options" role="group" aria-label="Color theme">
          {ACCENTS.map(accent => <button key={accent.id} className="app-accent-swatch" aria-label={accent.name} aria-pressed={appearance.accent === accent.id} title={accent.name} style={{"--swatch-color":accent.color, "--swatch-contrast":accent.contrast} as CSSProperties} onClick={() => updateAppearance({accent:accent.id})}><span aria-hidden="true">{appearance.accent === accent.id ? "✓" : ""}</span></button>)}
        </div></div>
        <small>Coordinated Radix colors for backgrounds, controls and text. Saved in this browser for all apps.</small>
      </fieldset>
    </section>}
  </div>;
}
