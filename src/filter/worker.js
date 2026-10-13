import { matchFilter } from "../lib/filter-rules.js";
self.onmessage = ({ data }) => {
  for (const rule of data.rules) {
    self.postMessage({ type: "start", id: rule.id });
    try { self.postMessage({ type: "result", result: matchFilter(rule, data.target) }); }
    catch { self.postMessage({ type: "error", id: rule.id }); }
  }
  self.postMessage({ type: "done" });
};
