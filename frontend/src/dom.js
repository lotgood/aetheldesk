export function byId(id) {
  return document.getElementById(id);
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function isNaturallyFocusable(el) {
  return el.matches?.(FOCUSABLE_SELECTOR) && !el.disabled;
}

function focusableWithin(root) {
  return [root, ...root.querySelectorAll(FOCUSABLE_SELECTOR)].filter(el => {
    const style = window.getComputedStyle(el);
    return isNaturallyFocusable(el) && style.display !== "none" && style.visibility !== "hidden";
  });
}

export function setHiddenInteraction(root, hidden) {
  root.toggleAttribute("inert", hidden);
  root.setAttribute("aria-hidden", hidden ? "true" : "false");
  [root, ...root.querySelectorAll("button, input, select, textarea, a[href], iframe, [tabindex]")].forEach(el => {
    if (hidden) {
      // Idempotence matters: renderers call this for every server snapshot.
      // Without a sentinel, a second hidden call mistakes our own -1 for the
      // original value and permanently removes the control from the tab order.
      if (el.dataset.interactionHidden === "true") return;
      el.dataset.interactionHidden = "true";
      el.dataset.originalTabIndex = el.hasAttribute("tabindex") ? el.getAttribute("tabindex") : "__none__";
      el.setAttribute("tabindex", "-1");
    } else {
      if (el.dataset.interactionHidden !== "true") return;
      if (el.dataset.originalTabIndex === "__none__") el.removeAttribute("tabindex");
      else el.setAttribute("tabindex", el.dataset.originalTabIndex);
      delete el.dataset.originalTabIndex;
      delete el.dataset.interactionHidden;
    }
  });
}

let activeModalRoot = null;

function setModalSiblingHidden(el, hidden) {
  if (hidden) {
    if (el.dataset.modalIsolationHidden === "true") return;
    el.dataset.modalIsolationHidden = "true";
    el.dataset.modalOriginalAriaHidden = el.hasAttribute("aria-hidden") ? el.getAttribute("aria-hidden") : "__none__";
    el.dataset.modalOriginalInert = el.hasAttribute("inert") ? "true" : "false";
    el.setAttribute("aria-hidden", "true");
    el.toggleAttribute("inert", true);
    return;
  }

  if (el.dataset.modalIsolationHidden !== "true") return;
  if (el.dataset.modalOriginalAriaHidden === "__none__") el.removeAttribute("aria-hidden");
  else el.setAttribute("aria-hidden", el.dataset.modalOriginalAriaHidden);
  el.toggleAttribute("inert", el.dataset.modalOriginalInert === "true");
  delete el.dataset.modalIsolationHidden;
  delete el.dataset.modalOriginalAriaHidden;
  delete el.dataset.modalOriginalInert;
}

function walkModalSiblings(root, callback) {
  let current = root;
  while (current?.parentElement) {
    for (const sibling of current.parentElement.children) {
      if (sibling === current || sibling.tagName === "SCRIPT" || sibling.tagName === "STYLE") continue;
      callback(sibling);
    }
    current = current.parentElement;
  }
}

export function setModalIsolation(root, active) {
  if (active) {
    if (activeModalRoot && activeModalRoot !== root) setModalIsolation(activeModalRoot, false);
    walkModalSiblings(root, sibling => setModalSiblingHidden(sibling, true));
    activeModalRoot = root;
    return;
  }

  if (activeModalRoot !== root) return;
  walkModalSiblings(root, sibling => setModalSiblingHidden(sibling, false));
  activeModalRoot = null;
}

export function createFocusTrap(dialog, { initialFocus, onCancel } = {}) {
  let restoreEl = null;
  let active = false;

  function focusInitial() {
    const target = typeof initialFocus === "function" ? initialFocus() : initialFocus;
    (target || focusableWithin(dialog)[0] || dialog).focus();
  }

  function onKeyDown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel?.();
      return;
    }
    if (event.key !== "Tab") return;
    const items = focusableWithin(dialog);
    if (!items.length) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function onFocusIn(event) {
    if (active && !dialog.contains(event.target)) focusInitial();
  }

  function activate() {
    if (active) return;
    active = true;
    restoreEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    setTimeout(focusInitial, 50);
  }

  function deactivate({ restore = true } = {}) {
    if (!active) return;
    active = false;
    dialog.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("focusin", onFocusIn);
    if (restore && restoreEl && document.contains(restoreEl)) restoreEl.focus();
    restoreEl = null;
  }

  return { activate, deactivate };
}

export function setVisible(el, visible, display = "flex") {
  el.style.display = visible ? display : "none";
}

export function showFlex(el) {
  el.classList.remove("hidden");
  el.classList.add("flex");
}

export function hideFlex(el) {
  el.classList.add("hidden");
  el.classList.remove("flex");
}

export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
