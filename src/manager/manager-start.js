// Paint the popup shell and wake the worker while the module graph is still loading.
(() => {
  if (new URLSearchParams(location.search).has("popup")) document.documentElement.classList.add("popup");
  globalThis.blockSBInitialSnapshot = chrome.runtime.sendMessage({ type: "SNAPSHOT", view: "settings" }).catch(() => null);
})();
