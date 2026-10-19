import "../lib/i18n.js";
import { subscriptionOrigin, subscriptionUrl } from "../lib/filter-subscriptions.js";
const { t } = globalThis.BlockSBI18n;
const node = (tag, text) => { const n = document.createElement(tag); if (text) n.textContent = text; return n; };

/** URL subscription controls. Host access is requested only by the user's load click. */
export function mountSubscriptions({ send, refresh, toast }) {
  const root = document.getElementById("filter-subscriptions"), dialog = node("dialog");
  dialog.className = "rule-transfer-dialog"; document.body.append(dialog);
  let generation = 0;
  const button = (title, action) => {
    const b = node("button", title); b.type = "button"; b.className = "subtle";
    b.onclick = async () => { b.disabled = true; try { await action(); } catch (error) { toast(error.message); } finally { b.disabled = false; } }; return b;
  };
  dialog.addEventListener("close", () => generation++);
  document.getElementById("filter-subscribe").onclick = () => {
    const current = ++generation; dialog.replaceChildren();
    const title = node("h2", t("ui_subscription_add")); title.id = "subscription-title";
    dialog.setAttribute("aria-labelledby", title.id);
    const field = node("label", "URL"), input = node("input"); input.type = "url"; input.placeholder = "https://example.com/rules.json"; input.maxLength = 2048; field.className = "subscription-url-field"; field.append(input);
    const daily = node("input"); daily.type = "checkbox";
    const dailyLabel = node("label"); dailyLabel.append(daily, node("span", t("ui_subscription_daily")));
    const result = node("div"); result.className = "subscription-preview"; result.setAttribute("aria-live", "polite");
    const error = node("p"); error.className = "record-error"; error.setAttribute("role", "alert");
    let preview = null;
    const add = button(t("ui_subscription_apply"), async () => {
      if (!preview) return;
      await send("SUBSCRIPTION_ADD", { token: preview.token, autoUpdate: daily.checked });
      dialog.close(); await refresh();
    }); add.className = "primary"; add.disabled = true;
    input.oninput = () => { preview = null; add.disabled = true; result.replaceChildren(); error.textContent = ""; };
    const load = button(t("ui_subscription_load"), async () => {
      let url;
      try { url = subscriptionUrl(input.value.trim()); } catch { error.textContent = t("ui_subscription_url_invalid"); return; }
      input.disabled = true; add.disabled = true; preview = null; error.textContent = "";
      try {
        if (!await chrome.permissions.request({ origins: [subscriptionOrigin(url)] })) throw new Error(t("ui_subscription_permission"));
        const value = await send("SUBSCRIPTION_PREVIEW", { url });
        if (current !== generation || !dialog.open) return;
        preview = value; result.replaceChildren(node("strong", t("ui_subscription_count", value.rules.length)));
        const list = node("ul");
        for (const rule of value.rules) list.append(node("li", rule.name));
        result.append(list); add.disabled = false;
      } catch (e) { if (current === generation) error.textContent = e.message; }
      finally { input.disabled = false; }
    });
    const footer = node("div"); footer.className = "rule-transfer-footer";
    footer.append(button(t("ui_close"), () => dialog.close()), add);
    dialog.append(title, field, dailyLabel, node("p", t("ui_subscription_notice")), load, result, error, footer);
    dialog.showModal(); input.focus();
  };
  return sources => {
    root.replaceChildren(); root.hidden = !sources?.length;
    if (!sources?.length) return;
    root.append(node("h3", t("ui_subscription_title")));
    for (const source of sources) {
      const card = node("article"); card.className = "subscription-card";
      const name = node("strong", new URL(source.url).hostname), url = node("p", source.url); url.className = "subscription-url";
      const meta = node("p", t("ui_subscription_count", source.count)); meta.className = "muted";
      if (source.lastCheck) meta.append(document.createTextNode(" · " + t("ui_subscription_checked", new Date(source.lastCheck).toLocaleString(globalThis.BlockSBI18n.locale))));
      card.append(name, url, meta);
      const details = node("details"), summary = node("summary", t("ui_subscription_count", source.count)), rules = node("ul");
      for (const rule of source.rules || []) rules.append(node("li", rule.name + " · " + t(rule.action === "block" ? "ui_filter_block" : "ui_filter_hide_action")));
      details.append(summary, rules); card.append(details);
      if (source.error) { const warning = node("p", t("ui_subscription_update_failed")); warning.className = "record-error"; card.append(warning); }
      const actions = node("div"); actions.className = "subscription-actions";
      const daily = node("input"); daily.type = "checkbox"; daily.checked = source.autoUpdate;
      daily.onchange = async () => {
        daily.disabled = true;
        try { await send("SUBSCRIPTION_EDIT", { id: source.id, autoUpdate: daily.checked }); await refresh(); }
        catch (e) { daily.checked = source.autoUpdate; toast(e.message); } finally { daily.disabled = false; }
      };
      const label = node("label"); label.append(daily, node("span", t("ui_subscription_daily")));
      actions.append(label, button(t("ui_subscription_refresh"), async () => { try { await send("SUBSCRIPTION_REFRESH", { id: source.id }); } finally { await refresh(); } }), button(t("ui_subscription_remove"), async () => { await send("SUBSCRIPTION_REMOVE", { id: source.id }); await refresh(); }));
      card.append(actions); root.append(card);
    }
  };
}
