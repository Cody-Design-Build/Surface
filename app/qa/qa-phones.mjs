// Real React editors and phone cells, with no business workspace or network access.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { Window } from "happy-dom";
registerHooks({ load(url, context, nextLoad) { if (url.endsWith(".css")) return { format: "module", source: "export default {}", shortCircuit: true }; return nextLoad(url, context); } });
const window = new Window({ url: "http://localhost/" });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent"]) Object.defineProperty(globalThis, key, { value: key === "window" ? window : window[key], configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createElement, act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Value } = await import("../src/Properties.tsx");
const { CellView } = await import("../src/ViewPage.tsx");
const { textOf, PhoneGridEditor } = await import("../src/Grid.tsx");
const { normalizePhones } = await import("../../cli/src/phone.ts");
const f = { id: "phone", key: "phone", name: "Phone", kind: "phone" };
const value = [{ number: "+14155550123", extension: "004" }, { number: "+442079460958" }, { number: "+14155550124", extension: "09" }];
const app = { records: [] };
const gridText = textOf(app, f, { fields: { phone: value } });
assert.deepEqual(normalizePhones(gridText), value, "copy/paste and grid text retain every number, extension and primary order");
document.body.innerHTML = '<div id="root"></div><button id="outside">Outside editor</button>';
const root = createRoot(document.querySelector("#root"));
const outside = document.querySelector("#outside");
const changes = [];
const byLabel = label => document.querySelector(`[aria-label="${label}"]`);
const numbers = () => [...document.querySelectorAll('input[type="tel"]')];
const stars = () => [...document.querySelectorAll("button[aria-pressed]")];
const draw = current => root.render(createElement(Value, {
  f, value: current, records: [], onOpen() {},
  onChange(next) { changes.push(next); draw(next); },
}));
async function click(button) {
  assert(button, "control exists");
  await act(async () => {
    if (button.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, cancelable: true }))) button.focus();
    button.click();
  });
}
async function type(input, text) {
  assert(input, "input exists");
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, text);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}
async function key(input, key) {
  await act(async () => input.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
}
try {
  await act(async () => root.render(createElement(CellView, { app, f, v: value })));
  assert.equal(document.querySelector('a[href="tel:+14155550123;ext=004"]').textContent, "(415) 555-0123 ext. 004");
  assert.equal(document.querySelector('a[href="tel:+442079460958"]'), null, "secondary numbers are initially hidden");
  const disclosure = byLabel("Show 2 more phone numbers");
  assert.equal(disclosure.textContent, "+2 more");
  assert.equal(disclosure.getAttribute("aria-expanded"), "false");
  await click(disclosure);
  assert.equal(disclosure.getAttribute("aria-expanded"), "true");
  const extras = byLabel("Additional phone numbers");
  assert.equal(extras.id, disclosure.getAttribute("aria-controls"));
  assert.deepEqual([...extras.querySelectorAll("a")].map(link => link.getAttribute("href")), ["tel:+442079460958", "tel:+14155550124;ext=09"]);
  assert.equal(document.activeElement, extras.querySelector("a"), "revealed numbers can be reached by keyboard");
  await key(document.activeElement, "Escape");
  assert.equal(byLabel("Additional phone numbers"), null);
  assert.equal(document.activeElement, disclosure, "closing the disclosure restores focus");

  await act(async () => draw(value));
  assert.equal(numbers().length, 3);
  assert.equal(byLabel("Extension 1").value, "004");
  assert.equal(stars().filter(button => button.getAttribute("aria-pressed") === "true").length, 1);
  assert.equal(stars()[0].textContent, "★");
  await type(byLabel("Phone number 1"), "415.555.0129");
  await type(byLabel("Extension 1"), "005");
  assert.equal(changes.length, 0, "moving between row controls does not prematurely commit");
  await click(byLabel("Make phone number 3 primary"));
  let expected = [value[2], { number: "+14155550129", extension: "005" }, value[1]];
  assert.deepEqual(changes.at(-1), expected, "primary selection includes pending edits and preserves the order of all other numbers");
  assert.equal(changes.length, 1, "star mouse-down does not race an input blur");
  assert.equal(stars()[0].getAttribute("aria-pressed"), "true");
  assert.equal(byLabel("Extension 1").value, "09");
  await click(byLabel("Remove phone number 1"));
  expected = expected.slice(1);
  assert.deepEqual(changes.at(-1), expected, "removing the primary promotes the next entry");
  assert.equal(stars()[0].getAttribute("aria-pressed"), "true");

  let count = changes.length;
  await click([...document.querySelectorAll("button")].find(button => button.textContent === "Add number"));
  assert.equal(numbers().length, 3);
  assert.equal(document.activeElement, byLabel("Phone number 3"));
  assert.equal(changes.length, count, "adding an empty row is a local draft only");
  await key(byLabel("Phone number 3"), "Enter");
  assert.equal(changes.length, count, "an untouched blank row never reaches storage");
  await type(byLabel("Phone number 3"), "415 555 0125");
  await type(byLabel("Extension 3"), "007");
  await act(async () => outside.focus());
  expected = [...expected, { number: "+14155550125", extension: "007" }];
  assert.deepEqual(changes.at(-1), expected, "a new number appends without replacing existing numbers or extensions");

  count = changes.length;
  await type(byLabel("Phone number 3"), "unfinished number");
  await act(async () => outside.focus());
  assert.equal(changes.length, count);
  assert.equal(byLabel("Phone number 3").value, "unfinished number", "invalid drafts survive blur for correction");
  assert.equal(byLabel("Phone number 3").getAttribute("aria-invalid"), "true");
  await key(byLabel("Phone number 3"), "Enter");
  assert.equal(changes.length, count, "Enter cannot discard the other entries while one row is invalid");
  await type(byLabel("Phone number 3"), "415 555 0126");
  await key(byLabel("Phone number 3"), "Enter");
  expected = [...expected.slice(0, 2), { number: "+14155550126", extension: "007" }];
  assert.deepEqual(changes.at(-1), expected);
  count = changes.length;
  await type(byLabel("Phone number 2"), "another unfinished edit");
  await key(byLabel("Phone number 2"), "Escape");
  assert.equal(changes.length, count, "Escape cancels the draft rather than serializing a partial field");
  assert.deepEqual(normalizePhones(numbers().map((input, index) => ({ number: input.value, ...(byLabel(`Extension ${index + 1}`).value ? { extension: byLabel(`Extension ${index + 1}`).value } : {}) }))), expected);

  while (numbers().length > 1) await click(byLabel("Remove phone number 1"));
  assert.equal(stars().length, 0, "the sole number is primary without a redundant star action");
  await type(byLabel("Phone number 1"), "");
  await type(byLabel("Extension 1"), "");
  await key(byLabel("Phone number 1"), "Enter");
  assert.equal(changes.at(-1), null, "clearing the complete field stores null, never an empty number");
  await click(byLabel("Remove phone number 1"));
  assert.equal(numbers().length, 0);
  await act(async () => draw(value.slice(0, 1)));
  await click(byLabel("Remove phone number 1"));
  assert.equal(changes.at(-1), null, "removing the last stored number clears the field");

  await act(async () => draw("unparseable legacy note"));
  assert.equal(byLabel("Phone number 1").value, "unparseable legacy note", "invalid legacy text remains visible for correction");
  count = changes.length;
  await type(byLabel("Phone number 1"), "unparseable legacy note");
  await act(async () => outside.focus());
  assert.equal(changes.length, count, "an ordinary blur cannot silently replace invalid legacy text");
  await type(byLabel("Phone number 1"), "415.555.0123 ext. 001");
  await key(byLabel("Phone number 1"), "Enter");
  assert.deepEqual(changes.at(-1), [{ number: "+14155550123", extension: "001" }]);
  assert.equal(byLabel("Extension 1").value, "001", "an extension typed with a number remains separately editable after commit");
  await act(async () => outside.focus());
  const legacy = [{ number: "+14155550123", unexpected: "keep visible" }];
  await act(async () => draw(legacy));
  assert.equal(byLabel("Phone number 1").value, JSON.stringify(legacy));
  count = changes.length;
  await type(byLabel("Phone number 1"), JSON.stringify(legacy));
  await act(async () => outside.focus());
  assert.equal(changes.length, count, "unrecognized saved metadata cannot disappear on ordinary writes");

  const gridEvents = [];
  function GridHarness() {
    const [row, setRow] = useState({ id: "record", title: "Contact", fields: { phone: value } });
    const [closed, setClosed] = useState(false);
    return createElement("div", { className: "rdg-cell" }, closed ? "Closed" : createElement(PhoneGridEditor, {
      row, f, column: { name: "Phone" },
      onRowChange(next, finish) { gridEvents.push({ value: next.fields.phone, finish }); setRow(next); if (finish) setClosed(true); },
      onClose(commit) { gridEvents.push({ cancel: !commit }); setClosed(true); },
    }));
  }
  await act(async () => root.render(createElement(GridHarness, { key: "enter" })));
  await type(byLabel("Phone number 3"), "415.555.0128");
  await type(byLabel("Extension 3"), "008");
  await key(byLabel("Phone number 3"), "Enter");
  assert.deepEqual(gridEvents.at(-1), { value: [...value.slice(0, 2), { number: "+14155550128", extension: "008" }], finish: true }, "grid Enter submits the whole current draft, not a stale row");
  assert.equal(numbers().length, 0);
  await act(async () => root.render(createElement(GridHarness, { key: "outside" })));
  await click(byLabel("Make phone number 2 primary"));
  assert.deepEqual(gridEvents.at(-1), { value: [value[1], value[0], value[2]], finish: false });
  await type(byLabel("Extension 2"), "006");
  await click(outside);
  assert.deepEqual(gridEvents.at(-1), { value: [value[1], { ...value[0], extension: "006" }, value[2]], finish: true }, "outside click retains the reorder and the last typed extension");
  await act(async () => root.render(createElement(GridHarness, { key: "cancel" })));
  await type(byLabel("Phone number 2"), "invalid draft");
  count = gridEvents.length;
  await click(outside);
  assert.equal(gridEvents.length, count, "an invalid grid draft is not replaced by the previous saved row");
  assert.equal(byLabel("Phone number 2").value, "invalid draft");
  await key(byLabel("Phone number 2"), "Escape");
  assert.deepEqual(gridEvents.at(-1), { cancel: true }, "grid Escape cancels without writing a partial array");
  console.log("Phone UI passed: primary transitions, ordered numbers/extensions, local drafts, removal/empty fields, accessible extras, grid commits/cancellation, and legacy visibility.");
} finally { await act(async () => root.unmount()); await window.happyDOM.close(); }
