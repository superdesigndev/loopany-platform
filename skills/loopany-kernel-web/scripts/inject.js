(() => {
  "use strict";

  const SENTINEL = "__loopanyKernelWebInjection__";
  const ENTRY_ID = "loopany-kernel-web-entry";
  const PAGE_ID = "loopany-kernel-web-page";
  const FRAME_ID = "loopany-kernel-web-frame";
  const STYLE_ID = "loopany-kernel-web-style";
  const URL = window.__LOOPANY_KERNEL_WEB_URL__;
  const previous = window[SENTINEL];
  previous?.destroy?.();

  let entry;
  let page;
  let frame;
  let observer;
  let active = false;
  let hiddenNodes = [];

  function styles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${ENTRY_ID}[aria-current="page"] { background: var(--color-token-list-hover-background, color-mix(in srgb,currentColor 8%,transparent)); }
      #${PAGE_ID} { position:absolute;inset:0;z-index:40;min-width:0;min-height:0;background:#fafafa; }
      #${PAGE_ID}[hidden] { display:none!important; }
      #${FRAME_ID} { display:block;width:100%;height:100%;border:0;background:#fafafa; }
    `;
    document.head.appendChild(style);
  }

  function pluginsButton() {
    const scroll = document.querySelector("[data-app-action-sidebar-scroll]");
    if (!scroll) return null;
    return [...scroll.querySelectorAll("button")].find((button) => /^(plugins|插件)$/i.test(button.textContent?.trim() || "")) || null;
  }

  function makeEntry(reference) {
    const button = reference.cloneNode(true);
    button.id = ENTRY_ID;
    button.removeAttribute("aria-expanded");
    button.removeAttribute("aria-controls");
    button.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
    const label = button.querySelector(".text-fade-truncate") || [...button.querySelectorAll("span")].at(-1);
    if (label) label.textContent = "Loopany";
    else button.textContent = "Loopany";
    button.setAttribute("aria-label", "Open Loopany Kernel");
    button.setAttribute("title", "Loopany Kernel");
    const icon = button.querySelector("svg");
    if (icon) {
      icon.setAttribute("viewBox", "0 0 24 24");
      icon.setAttribute("fill", "none");
      icon.setAttribute("stroke", "currentColor");
      icon.innerHTML = '<rect x="3" y="4" width="18" height="16"/><path d="M9 4v16M13 9h5M13 13h5M13 17h3"/>';
    }
    button.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); open(); });
    return button;
  }

  function ensureEntry() {
    const reference = pluginsButton();
    if (!reference?.parentElement) return;
    if (!entry) entry = makeEntry(reference);
    if (entry.parentElement !== reference.parentElement || entry.previousElementSibling !== reference) reference.after(entry);
  }

  function pageMount() {
    return document.querySelector(".app-shell-main-content-frame") || document.querySelector("[data-app-shell-main-content-layout]");
  }

  function ensurePage() {
    const mount = pageMount();
    if (!mount) return false;
    if (!page) {
      page = document.createElement("section");
      page.id = PAGE_ID;
      page.hidden = true;
      page.setAttribute("role", "region");
      page.setAttribute("aria-label", "Loopany Kernel");
      frame = document.createElement("iframe");
      frame.id = FRAME_ID;
      frame.title = "Loopany Kernel";
      frame.src = URL;
      frame.referrerPolicy = "no-referrer";
      frame.setAttribute("allow", "clipboard-read; clipboard-write");
      frame.setAttribute("sandbox", "allow-same-origin allow-scripts allow-forms allow-modals allow-downloads");
      frame.addEventListener("load", () => { frame.dataset.loaded = "true"; });
      page.appendChild(frame);
    }
    const position = getComputedStyle(mount).position;
    if (position === "static") mount.style.position = "relative";
    if (page.parentElement !== mount) mount.appendChild(page);
    return true;
  }

  function hideNative() {
    const mount = pageMount();
    hiddenNodes = [...(mount?.children || [])].filter((node) => node !== page && !node.hidden);
    hiddenNodes.forEach((node) => { node.dataset.loopanyKernelHidden = "true"; node.style.visibility = "hidden"; });
  }

  function restoreNative() {
    hiddenNodes.forEach((node) => { if (node.dataset.loopanyKernelHidden) { node.style.visibility = ""; delete node.dataset.loopanyKernelHidden; } });
    hiddenNodes = [];
  }

  function open() {
    active = true;
    if (!ensurePage()) return;
    hideNative();
    page.hidden = false;
    entry?.setAttribute("aria-current", "page");
  }

  function close() {
    active = false;
    if (page) page.hidden = true;
    entry?.removeAttribute("aria-current");
    restoreNative();
  }

  function mount() {
    styles();
    ensureEntry();
    if (active) { ensurePage(); hideNative(); if (page) page.hidden = false; }
  }

  function destroy() {
    observer?.disconnect();
    close();
    entry?.remove();
    page?.remove();
    document.getElementById(STYLE_ID)?.remove();
    delete window[SENTINEL];
  }

  document.addEventListener("click", (event) => {
    if (!active || event.target?.closest?.(`#${ENTRY_ID}`) || event.target?.closest?.(`#${PAGE_ID}`)) return;
    if (event.target?.closest?.("aside button,aside a,[data-app-action-sidebar-scroll] button")) close();
  }, true);
  window[SENTINEL] = { open, close, destroy, get active() { return active; } };
  function boot() {
    if (!document.documentElement) return;
    observer = new MutationObserver(mount);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    mount();
    open();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
