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
      if (!el.dataset.originalTabIndex && el.hasAttribute("tabindex")) el.dataset.originalTabIndex = el.getAttribute("tabindex");
      el.setAttribute("tabindex", "-1");
    } else if (el.dataset.originalTabIndex) {
      el.setAttribute("tabindex", el.dataset.originalTabIndex);
      delete el.dataset.originalTabIndex;
    } else {
      el.removeAttribute("tabindex");
    }
  });
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
