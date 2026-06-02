export function byId(id) {
  return document.getElementById(id);
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
