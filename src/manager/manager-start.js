// Paint the popup shell and wake the worker while the module graph is still loading.
(() => {
  const params = new URLSearchParams(location.search);
  if (params.has("popup")) document.documentElement.classList.add("popup");
  // The in-page drawer passes X's current theme; other pages follow the system preference.
  if (["light", "dim", "dark"].includes(params.get("theme"))) document.documentElement.dataset.theme = params.get("theme");
  globalThis.blockSBInitialSnapshot = chrome.runtime.sendMessage({ type: "SNAPSHOT", view: "settings" }).catch(() => null);
})();
