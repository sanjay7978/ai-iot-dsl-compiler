// site.js — shared chrome for the website pages: header, footer, theme,
// mobile menu, scroll reveals and the real project numbers.

export const REPO = "https://github.com/sanjay7978/ai-iot-dsl-compiler";

export const LOGO = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" class="logo-svg">
  <rect x="1" y="1" width="22" height="22" rx="6.5" class="logo-bg"/>
  <path d="M8 5.5v8.2" class="logo-stem"/>
  <circle cx="8" cy="16.6" r="2.6" class="logo-bulb"/>
  <path d="m13.2 8.6 4 3.4-4 3.4" class="logo-chev"/>
</svg>`;

const ICON = {
  sun: '<svg class="icon-sun" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  moon: '<svg class="icon-moon" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/></svg>',
  github: '<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.3-3.4-1.3-.4-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.3 1.1 2.9.8.1-.6.4-1.1.6-1.3-2.2-.3-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.8 1a9.6 9.6 0 0 1 5 0c1.9-1.3 2.8-1 2.8-1 .5 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.9-2.4 4.7-4.6 5 .4.3.7.9.7 1.9V21c0 .3.2.6.7.5A10 10 0 0 0 12 2Z"/></svg>',
  menu: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
};
export { ICON };

const LINKS = [
  ["studio.html", "Studio"],
  ["docs.html", "Docs"],
  ["examples.html", "Examples"],
  ["about.html", "About"],
];

// Works for /studio and /studio.html alike.
const page = () => (location.pathname.split("/").pop().replace(/\.html$/, "") || "index") + ".html";

export function currentTheme() {
  return document.documentElement.dataset.theme ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}

export function toggleTheme() {
  const next = currentTheme() === "dark" ? "light" : "dark";
  const apply = () => {
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("iotc-theme", next); } catch (e) { /* storage unavailable */ }
  };
  // Cross-fade the theme change where the browser supports view transitions.
  if (document.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) document.startViewTransition(apply);
  else apply();
}

function header() {
  const here = page();
  const links = LINKS.map(([href, label]) =>
    `<a href="${href}" class="nav-link${here === href ? " current" : ""}"${here === href ? ' aria-current="page"' : ""}>${label}</a>`).join("");
  return `
  <div class="nav-inner">
    <a class="wordmark" href="index.html" aria-label="Kelvin home">${LOGO}<span>Kelvin</span><small>IoT DSL compiler</small></a>
    <nav class="nav-links" aria-label="Main">${links}</nav>
    <div class="nav-actions">
      <a class="icon-btn" href="${REPO}" target="_blank" rel="noopener" aria-label="Source code on GitHub" title="Source code on GitHub">${ICON.github}</a>
      <button class="icon-btn theme-btn" type="button" data-theme-toggle aria-label="Switch theme" title="Switch theme">${ICON.sun}${ICON.moon}</button>
      <a class="btn btn-primary nav-cta" href="studio.html">Open Studio ${ICON.arrow}</a>
      <button class="icon-btn nav-menu" type="button" aria-label="Menu" aria-expanded="false" aria-controls="navSheet">${ICON.menu}</button>
    </div>
  </div>
  <div class="nav-sheet" id="navSheet" hidden>
    ${links}
    <a href="${REPO}" target="_blank" rel="noopener" class="nav-link">GitHub</a>
    <a class="btn btn-primary" href="studio.html">Open Studio ${ICON.arrow}</a>
  </div>`;
}

function footer(stats) {
  const tests = stats && stats.tests.total ? `${stats.tests.total} automated tests passing` : "Automated test suite";
  return `
  <div class="foot-inner">
    <div class="foot-brand">
      <a class="wordmark" href="index.html">${LOGO}<span>Kelvin</span></a>
      <p>An AI-assisted compiler for IoT automation rules. A hand-written C++ compiler that turns plain-English intent into checked, optimized code for C, Arduino, Python and JavaScript.</p>
      <p class="foot-meta"><span class="badge"><i class="led"></i>${tests}</span></p>
    </div>
    <div class="foot-col"><h4>Product</h4>
      <a href="studio.html">Studio</a><a href="studio.html#smartHome">Digital twin</a><a href="examples.html">Examples</a><a href="docs.html#remote">Phone remote</a></div>
    <div class="foot-col"><h4>Learn</h4>
      <a href="docs.html#quick-start">Quick start</a><a href="docs.html#language">Language reference</a><a href="docs.html#grammar">Grammar &amp; LL(1)</a><a href="docs.html#errors">Error catalogue</a></div>
    <div class="foot-col"><h4>Project</h4>
      <a href="about.html">About</a><a href="about.html#architecture">Architecture</a><a href="about.html#team">Team</a><a href="${REPO}" target="_blank" rel="noopener">GitHub</a></div>
  </div>
  <div class="foot-base">
    <span>Compiler Design project · built with a hand-written C++17 compiler, Python standard library and vanilla JavaScript</span>
    <span class="mono">No trackers · no CDNs · works offline</span>
  </div>`;
}

let statsPromise = null;
export function projectStats() {
  if (!statsPromise) {
    statsPromise = fetch("data/project.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  }
  return statsPromise;
}

// Elements with [data-reveal] fade up once when they scroll into view.
export function initReveal(root = document) {
  const items = root.querySelectorAll("[data-reveal]:not(.revealed)");
  if (!("IntersectionObserver" in window)) { items.forEach((el) => el.classList.add("revealed")); return; }
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add("revealed"); io.unobserve(e.target); }
    });
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
  items.forEach((el) => io.observe(el));
}

// Count a number up when it becomes visible. Respects reduced motion.
export function countUp(el, to, { duration = 1100, suffix = "" } = {}) {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) { el.textContent = to.toLocaleString() + suffix; return; }
  const start = performance.now();
  const tick = (t) => {
    const k = Math.min(1, (t - start) / duration);
    const eased = 1 - Math.pow(1 - k, 3);
    el.textContent = Math.round(to * eased).toLocaleString() + suffix;
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export function initSite() {
  const nav = document.getElementById("siteNav");
  const foot = document.getElementById("siteFooter");
  if (nav) nav.innerHTML = header();
  document.querySelectorAll("[data-theme-toggle]").forEach((b) => b.addEventListener("click", toggleTheme));

  const menu = nav && nav.querySelector(".nav-menu");
  if (menu) {
    const sheet = nav.querySelector(".nav-sheet");
    menu.addEventListener("click", () => {
      const open = sheet.hidden;
      sheet.hidden = !open;
      menu.setAttribute("aria-expanded", String(open));
      nav.classList.toggle("menu-open", open);
    });
  }
  if (nav) {
    const onScroll = () => nav.classList.toggle("scrolled", scrollY > 8);
    addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }
  if (foot) {
    foot.innerHTML = footer(null);
    projectStats().then((s) => { if (s) foot.innerHTML = footer(s); });
  }
  initReveal();
}
