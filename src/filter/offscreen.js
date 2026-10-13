// Only the service worker can submit work. No storage, cookies or network are used here.
let queue = Promise.resolve();
let queued = 0;
let reusableWorker, idleTimer;
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target !== "filter-offscreen" || sender.id !== chrome.runtime.id || sender.tab
    || sender.url && sender.url !== chrome.runtime.getURL("src/background.js")) return;
  if (++queued > 40) { queued--; respond({ error: "busy" }); return; }
  const job = queue.then(() => evaluate(message));
  queue = job.catch(() => {});
  job.then(respond, () => respond({ error: "worker" })).finally(() => queued--);
  return true;
});
function evaluate({ rules, payload: target }) {
  return new Promise(resolve => {
    clearTimeout(idleTimer);
    const worker = reusableWorker ||= new Worker("worker.js", { type: "module" });
    const results = [], errors = [];
    let current, timer, settled = false;
    const finish = error => {
      if (settled) return; settled = true; clearTimeout(timer);
      worker.onmessage = null; worker.onerror = null;
      if (error || errors.length) { worker.terminate(); reusableWorker = null; }
      else idleTimer = setTimeout(() => { worker.terminate(); if (reusableWorker === worker) reusableWorker = null; }, 5000);
      resolve({ results, errors, ...(error ? { error } : {}) });
    };
    timer = setTimeout(() => finish("startup"), 5000);
    worker.onmessage = ({ data }) => {
      if (settled) return;
      clearTimeout(timer);
      if (data.type === "start") {
        current = data.id;
        timer = setTimeout(() => { errors.push({ id: current, reason: "timeout" }); finish(); }, 200);
      } else if (data.type === "result") results.push(data.result);
      else if (data.type === "error") errors.push({ id: data.id, reason: "invalid" });
      else if (data.type === "done") finish();
    };
    worker.onerror = () => finish("worker");
    try { worker.postMessage({ rules, target }); } catch { finish("worker"); }
  });
}
