let creation;
/** Evaluate bounded rules in a killable worker, hosted by an extension-owned offscreen page. */
export async function evaluateFilters(rules, target) {
  if (!rules.length) return { results: [], errors: [] };
  const url = chrome.runtime.getURL("src/filter/offscreen.html");
  if (!creation) creation = (async () => {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] });
    if (!contexts.length) await chrome.offscreen.createDocument({ url, reasons: ["WORKERS"], justification: "Run user-defined regular expressions with a cancellable time limit." });
  })().finally(() => { creation = null; });
  await creation;
  const result = await chrome.runtime.sendMessage({ target: "filter-offscreen", rules,
    // Use a separate payload key: the envelope's target selects the receiving context.
    payload: target });
  if (!result || result.error) throw new Error(result?.error || "filter evaluator unavailable");
  return result;
}
