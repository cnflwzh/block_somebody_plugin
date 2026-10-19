import "../lib/i18n.js";
import { renderHelpText } from "./help-text.js";

const i18n = globalThis.BlockSBI18n;
await i18n.ready;
await i18n.setLanguage(new URLSearchParams(location.search).get("language") || "auto");
const { t } = i18n;
i18n.localizeDocument(document);
for (const node of document.querySelectorAll("[data-prose]")) renderHelpText(node, t(node.dataset.prose));

// This is an explanatory simulation, not a classifier. It never reads account data,
// persists settings, or calls Jev/X. Fixed scores make request timing easy to compare.
const $ = id => document.getElementById(id);
let count = 0;
function renderExample() {
  const mixed = $("scenario").value === "mixed";
  const hits = count - (mixed && count === 3 ? 1 : 0);
  const completed = count === 3;
  $("replies").replaceChildren();
  for (let index = 0; index < 3; index++) {
    const row = document.createElement("li");
    row.className = count > 0 ? "seen" : "";
    const label = document.createElement("strong"); label.textContent = t("modes_reply", index + 1, String.fromCharCode(65 + index));
    const text = document.createElement("span"); text.textContent = index < count ? t("modes_reply_score", mixed && index === 2 ? 8 : [94, 92, 96][index]) : count > 0 ? t("modes_fetched_reply") : t("modes_unseen");
    row.append(label, text); $("replies").append(row);
  }
  $("c-requests").textContent = count;
  $("b-requests").textContent = count > 0 ? 1 : 0;
  $("c-progress").textContent = t("modes_hit_progress", hits);
  $("b-progress").textContent = t("modes_collect_progress", count > 0 ? 3 : 0, count > 0 ? 3 : 0);
  $("c-status").textContent = t(completed && !mixed ? "modes_queued" : "modes_wait_hits");
  $("b-status").textContent = count > 0 ? t(mixed ? "modes_batch_no" : "modes_batch_yes") : t("modes_wait_collect");
  $("c-status").classList.toggle("qualified", completed && !mixed);
  $("b-status").classList.toggle("qualified", count > 0 && !mixed);
  $("next").disabled = completed;
}
$("next").addEventListener("click", () => { count = Math.min(3, count + 1); renderExample(); });
$("reset").addEventListener("click", () => { count = 0; renderExample(); });
$("scenario").addEventListener("change", () => { count = 0; renderExample(); });
renderExample();
