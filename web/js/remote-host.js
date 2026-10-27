// remote-host.js — the laptop side of the phone remote: shows a QR code, publishes
// the current sensors, and receives phone changes through Server-Sent Events.

import { $, bus, getJson, postJson, escapeHtml, debounce } from "./util.js";
import { state } from "./state.js";
import { sensorSpecs } from "./vm.js";
import { qrSvg } from "./qr.js";

let info = null;
let source = null;

export async function openRemote() {
  const modal = $("remoteModal");
  modal.hidden = false;
  document.body.classList.add("modal-open");
  const body = $("remoteBody");
  body.innerHTML = "<p>Checking…</p>";
  try {
    info = await getJson("/api/remote/info");
  } catch (e) {
    body.innerHTML = `<p>Could not reach the server: ${escapeHtml(e.message)}</p>`;
    return;
  }
  if (!info.enabled) {
    body.innerHTML =
      "<p>The phone remote is off. It needs the server to listen on your Wi-Fi network:</p>" +
      "<ol><li>Stop the server with <kbd>Ctrl</kbd> + <kbd>C</kbd> in its terminal.</li>" +
      "<li>Start it with <code>make remote</code>.</li><li>Reload this page and press <b>Phone remote</b> again.</li></ol>" +
      "<p class=\"muted\">Only the remote page is reachable from other devices, and only with a secret key.</p>";
    return;
  }
  body.innerHTML =
    `<div class="qr-wrap">${qrSvg(info.url)}</div>` +
    `<p>Scan with your phone's camera (same Wi-Fi as this laptop). The phone becomes the sensor panel; changes appear here instantly.</p>` +
    `<p class="url"><code>${escapeHtml(info.url)}</code></p>` +
    `<p class="muted" id="remoteStatus">Waiting for a phone…</p>`;
  connect();
  publish();
}

function closeRemote() {
  $("remoteModal").hidden = true;
  document.body.classList.remove("modal-open");
}

function connect() {
  if (source) return;
  source = new EventSource("/api/remote/events");
  source.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type !== "sensor") return;
    const spec = state.result && sensorSpecs(state.result).find((s) => s.name === ev.name);
    if (!spec) return;
    const value = spec.type === "NUMBER" ? parseFloat(ev.value) : ev.value;
    if (spec.type === "NUMBER" && Number.isNaN(value)) return;
    bus.emit("set-sensor", { name: ev.name, value, from: "phone" });
    const st = $("remoteStatus");
    if (st) st.textContent = `Phone connected · last change: ${ev.name} = ${ev.value}`;
    $("remoteBtn").classList.add("live");
  };
  source.onerror = () => {};
}

// Tells the server which sensors the phone should show.
export const publish = debounce(async () => {
  if (!info || !info.enabled || !state.result || !state.result.cCode) return;
  const sensors = sensorSpecs(state.result).map((s) => ({ ...s, value: state.simInputs[s.name] }));
  try {
    await postJson("/api/remote/config", { sensors, program: state.exampleName || "program" });
  } catch (e) { /* the remote is optional */ }
}, 250);

export function initRemote() {
  $("remoteBtn").addEventListener("click", openRemote);
  $("remoteClose").addEventListener("click", closeRemote);
  $("remoteModal").addEventListener("click", (e) => e.target === $("remoteModal") && closeRemote());
  document.addEventListener("keydown", (e) => e.key === "Escape" && !$("remoteModal").hidden && closeRemote());
  bus.on("compiled", publish);
  bus.on("inputs-changed", publish);
  // If the server already runs in LAN mode, listen for phones right away.
  getJson("/api/remote/info").then((i) => { info = i; if (i.enabled) { connect(); publish(); } }).catch(() => {});
}
