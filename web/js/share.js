// share.js — shareable links: the program is compressed into the URL (#p=...).

import { copyText, toast } from "./util.js";

const toB64 = (bytes) => {
  let s = "";
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64 = (text) => {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

async function pipe(bytes, stream) {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export async function encodeProgram(text) {
  const raw = new TextEncoder().encode(text);
  if (typeof CompressionStream === "undefined") return "r" + toB64(raw);
  return "z" + toB64(await pipe(raw, new CompressionStream("deflate-raw")));
}

export async function decodeProgram(code) {
  const bytes = fromB64(code.slice(1));
  if (code[0] === "r") return new TextDecoder().decode(bytes);
  return new TextDecoder().decode(await pipe(bytes, new DecompressionStream("deflate-raw")));
}

export async function shareProgram(text) {
  const code = await encodeProgram(text);
  const url = location.origin + location.pathname + "#p=" + code;
  history.replaceState(null, "", "#p=" + code);
  if (await copyText(url)) toast("Link copied: anyone opening it gets this program");
  else toast("Link ready in the address bar");
}

export async function programFromUrl() {
  const m = location.hash.match(/#p=([A-Za-z0-9_-]+)/);
  if (!m) return null;
  try {
    return await decodeProgram(m[1]);
  } catch (e) {
    toast("The shared link is damaged", "bad");
    return null;
  }
}
