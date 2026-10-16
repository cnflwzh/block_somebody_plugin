const COMPLETED = "blocksb.setup.completed.v1";
/** Setup writes model configuration on Connect and selected policies on Finish.
 * Secrets are transient. onConnect requests host access within the submit gesture. */
export function mountGuide({ t, getSettings, onConnect, onSave }) {
  const node = (tag, cls = "", text = "") => { const n = document.createElement(tag); n.className = cls; n.textContent = text; return n; };
  const btn = (key, fn, cls = "subtle") => { const b = node("button", cls, t(key)); b.type = "button"; b.onclick = fn; return b; };
  const dialog = node("dialog", "bs-setup"), title = node("h2"), count = node("span", "muted");
  title.id = "setup-title"; dialog.setAttribute("aria-labelledby", title.id);
  const header = node("div", "bs-setup-header"), body = node("form"), footer = node("div", "bs-setup-footer"), error = node("p", "record-error");
  error.setAttribute("role", "alert");
  const close = btn("ui_close", () => dismiss(false)), back = btn("guide_previous", () => { capture(); step--; render(-1); });
  const skip = btn("guide_skip", () => dismiss(true), "text-button");
  const next = node("button", "primary"); next.type = "submit";
  header.append(title, close); footer.append(skip, back, count, next); dialog.append(header, body, error); document.body.append(dialog);
  let step = 0, busy = false, values, fields = {}, notice, focus, previewMode = false;
  const animations = new Set(), timers = new Set();
  let sceneVersion = 0;
  const reduced = () => getSettings().reducedMotion && matchMedia("(prefers-reduced-motion: reduce)").matches;
  function stopAnimations() { sceneVersion++; for (const timer of timers) clearTimeout(timer); timers.clear(); for (const a of animations) a.cancel(); animations.clear(); }
  function motion(el, frames, duration = 600) {
    const a = el.animate(frames, { duration: reduced() ? 1 : duration, easing: "ease-in-out", fill: "forwards" });
    animations.add(a); a.finished.catch(() => {}); return a;
  }
  function later(fn, ms) { const version = sceneVersion, timer = setTimeout(() => { timers.delete(timer); if (version === sceneVersion && dialog.open && !document.hidden) fn(); }, ms); timers.add(timer); }
  const completed = () => { try { localStorage.setItem(COMPLETED, "1"); } catch {} notice?.remove(); };
  const clearSecret = () => { if (fields.key) fields.key.value = ""; };
  function dismiss(done) { if (busy) return; clearSecret(); stopAnimations(); dialog.close(); if (done) completed(); focus?.focus(); }
  dialog.addEventListener("cancel", e => { e.preventDefault(); dismiss(false); });
  window.addEventListener("pagehide", () => { clearSecret(); stopAnimations(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) stopAnimations(); });
  function field(key, label, type, value) {
    const row = node("label", "bs-setup-field", t(label)), input = node("input"); input.type = type; input.value = value || "";
    input.autocomplete = "off"; input.spellcheck = false; fields[key] = input; row.append(input); return row;
  }
  function select(key, label, choices, value) {
    if (["preset", "observerPreset", "scope", "animationEffect", "mode"].includes(key)) {
      const row = node("div", "compact-row"), group = node("div", "segments"); row.append(node("span", "", t(label)), group);
      for (const [id, text] of choices) { const item = node("label"), input = node("input"); input.type = "radio"; input.name = "setup-" + key; input.value = id; input.checked = id === value; item.append(input, node("span", "", t(text))); group.append(item); }
      Object.defineProperty(group, "value", { get: () => group.querySelector("input:checked")?.value || value });
      fields[key] = group; return row;
    }
    const row = node("label", "compact-row", t(label)), input = node("select");
    for (const [id, text] of choices) { const o = node("option", "", t(text)); o.value = id; input.append(o); }
    input.value = value; fields[key] = input; row.append(input); return row;
  }
  function capture() {
    if (step === 1) { for (const key of ["scope", "observerPreset", "mode"]) values[key] = fields[key].value; values.enabled = fields.enabled.checked; }
    if (step === 2) values.preset = fields.preset.value;
    if (step === 3) values.animationEffect = fields.animationEffect.value;
  }
  const policies = [["careful", "ui_cautious"], ["balanced", "ui_balanced"], ["active", "ui_aggressive"], ["custom", "ui_custom"]];
  /** Match the real X thread and extension controls; only sample DOM is changed. */
  function demo(page, autoRemove = false) {
    const stage = node("section", "setup-demo"), toolbar = node("div", "setup-demo-toolbar");
    toolbar.append(node("span", "muted", t("setup_demo")), btn("guide_replay", () => { stopAnimations(); stage.replaceWith(demo(page, autoRemove)); }, "text-button")); stage.append(toolbar);
    const screen = node("div", "guide-x-screen"); stage.append(screen);
    const heading = node("div", "guide-x-heading", "←  " + t("setup_x_post")); screen.append(heading);
    function tweet(handle, text, root = false) {
      const row = node("article", "guide-x-tweet" + (root ? " guide-x-root" : ""));
      const avatar = node("span", "guide-x-avatar", handle.slice(0, 1).toUpperCase()), content = node("div", "guide-x-content"), line = node("div", "guide-x-author");
      line.append(node("strong", "", handle), node("span", "muted", "@" + handle + " · 1h"));
      content.append(line, node("p", "guide-x-text", text));
      const icons = node("div", "guide-x-actions"); icons.setAttribute("aria-hidden", "true");
      // Same stroke-based icon style as the X action row.
      for (const path of ["M20 11a8 8 0 0 1-8 8H5l-3 3V11a9 9 0 0 1 18 0Z", "m5 7 3-3 3 3M8 4v13h10m1 0-3 3-3-3M16 20V7H6", "M12 20 3 11C-2 3 8 0 12 6c4-6 14-3 9 5Z", "M5 20V12m7 8V4m7 16V8"]) { const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg"); icon.setAttribute("viewBox", "0 0 24 24"); const p = document.createElementNS(icon.namespaceURI, "path"); p.setAttribute("d", path); icon.append(p); icons.append(icon); }
      content.append(icons); row.append(avatar, content); return { row, line, content };
    }
    const original = tweet("example", t(page === 2 ? "setup_stance_original" : "setup_original_text"), true); screen.append(original.row);
    const more = btn("setup_demo_menu", () => { menu.hidden = !menu.hidden; more.setAttribute("aria-expanded", String(!menu.hidden)); }, "guide-x-more");
    more.setAttribute("aria-label", t("ui_reply_actions")); more.setAttribute("aria-expanded", "false"); original.line.append(more);
    const menu = node("div", "guide-x-menu"); menu.hidden = true; screen.append(menu);
    menu.append(node("div", "guide-x-menu-native", t("setup_native_block")));
    const slot = node("div", "setup-demo-slot"), reply = tweet("reader", t(page === 2 ? "setup_stance_support" : "setup_sample_text")), card = reply.row;
    slot.append(card); screen.append(slot);
    const following = tweet("visitor", t(page === 2 ? "setup_stance_oppose" : "setup_other_reply")); screen.append(following.row);
    const tools = node("span", "guide-x-tools"); tools.hidden = page === 2;
    const probability = btn("agreement_probability", () => { panel.hidden = !panel.hidden; }, "text-button"); probability.textContent = t(page === 1 ? "observer_category_ai_generated" : "agreement_probability") + " 96%";
    const manual = btn("ui_block", remove, "text-button"); tools.append(probability, manual); reply.line.append(tools);
    const panel = node("section", "guide-probability-panel"); panel.hidden = true; screen.append(panel);
    panel.append(node("strong", "", t("ui_view_probabilities_by_option")));
    const labels = page === 1 ? ["observer_category_ai_generated", "observer_category_human_like", "observer_category_uncertain"] : ["category_support", "category_oppose", "category_uncertain"];
    [96, 3, 1].forEach((score, index) => {
      const option = node("div", "guide-probability-option"), label = node("div", "guide-probability-label"); label.append(node("span", "", t(labels[index])), node("strong", "", score + "%"));
      const bar = node("div", "guide-probability-bar"), fill = node("div", "guide-probability-fill"); fill.style.width = score + "%"; fill.style.background = ["#1d9bf0", "#00ba7c", "#c27c00"][index]; bar.append(fill);
      if (!index) { const marker = node("i", "guide-probability-threshold"); marker.style.left = "92%"; bar.append(marker); }
      option.append(label, bar); panel.append(option);
    });
    panel.append(node("small", "muted", t("setup_threshold_note")));
    probability.onmouseenter = probability.onfocus = () => { panel.hidden = false; };
    probability.onmouseleave = probability.onblur = () => { panel.hidden = true; };
    const dock = node("div", "guide-x-dock"), trash = btn("", () => { history.hidden = !history.hidden; }, "guide-x-trash");
    trash.setAttribute("aria-label", t("ui_block_s_b_block_history"));
    trash.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    dock.append(trash, node("span", "guide-x-dock-icon", "Grok"), node("span", "guide-x-dock-icon", "◯")); screen.append(dock);
    const history = node("div", "guide-demo-history"); history.hidden = true; history.append(node("strong", "", t("block_history")), node("p", "", "@reader"), btn("ui_quick_undo", () => { stopAnimations(); stage.replaceWith(demo(page)); }, "text-button")); screen.append(history);
    const undo = node("div", "guide-quick-undo"); undo.hidden = true; undo.append(node("span", "", t("ui_quick_undo_preview_count", 1)), btn("ui_quick_undo", () => { stopAnimations(); stage.replaceWith(demo(page)); }, "text-button")); stage.append(undo);
    const progress = node("p", "setup-demo-progress"); stage.append(progress);
    let removing = false;
    function remove() {
      if (removing) return; removing = true; panel.hidden = true; mask.hidden = true;
      const height = slot.getBoundingClientRect().height; slot.style.height = height + "px";
      const from = card.getBoundingClientRect(), to = trash.getBoundingClientRect();
      // Animate a clone so the original position is blank throughout the flight.
      const ghost = card.cloneNode(true); ghost.classList.add("guide-x-ghost"); ghost.style.width = from.width + "px"; ghost.style.left = slot.offsetLeft + "px"; ghost.style.top = slot.offsetTop + "px"; screen.append(ghost); card.style.visibility = "hidden";
      if (values?.animationEffect === "particles" && !reduced()) for (let i = 0; i < 20; i++) { const p = node("span", "setup-particle"); slot.append(p); motion(p, [{ opacity: 1 }, { opacity: 0, transform: "translate(" + (i % 7 - 3) * 25 + "px," + (-20-i*4) + "px)" }]); }
      motion(ghost, values?.animationEffect === "particles" ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 1 }, { opacity: 0, transform: "translate(" + (to.x-from.x-from.width/2) + "px," + (to.y-from.y) + "px) scale(.05)" }]);
      later(() => { ghost.remove(); motion(slot, [{ height: height + "px" }, { height: "0px" }], 300); undo.hidden = false; }, reduced() ? 20 : 620);
    }
    const mask = node("div", "guide-x-mask"); mask.hidden = page !== 3; mask.append(node("span", "", t("ui_auto_hidden", t("support_probability"), 85)), btn("ui_show_reply", () => { mask.hidden = true; }, "text-button")); card.append(mask);
    const start = btn("", () => { menu.hidden = true; tools.hidden = false; progress.textContent = t("setup_model_analysis"); later(remove, 900); }, "guide-menu-start"); start.textContent = t("ui_block_and_agreeing_repliers", "example"); menu.append(start);
    if (page === 1) {
      for (let n = 1; n <= 3; n++) later(() => { progress.textContent = t("setup_demo_evidence", n); motion(card, [{ opacity: .4 }, { opacity: 1 }], 250); if (n === 3) later(remove, 700); }, n*1000);
    } else if (page === 2) {
      later(() => motion(more, [{ boxShadow: "0 0 0 0 transparent" }, { boxShadow: "0 0 0 4px var(--blue-soft)" }], 400), 250);
    } else if (autoRemove) later(remove, 200);
    return stage;
  }
  function render(direction = 1) {
    stopAnimations();
    clearSecret(); fields = {}; error.textContent = ""; body.replaceChildren();
    title.textContent = t(["setup_connect", "ui_observer_settings", "ui_support_settings", "ui_display_animation", "setup_confirm"][step]); count.textContent = `${step + 1} / 5`; back.hidden = step === 0;
    next.textContent = t(step === 4 ? "setup_finish" : step === 0 && !getSettings().configured ? "setup_connect_next" : "guide_next");
    body.append(node("p", "setup-page-description", t(["setup_connect_description", "setup_auto_hint", "setup_manual_stance", "setup_display_description", "setup_finish_description"][step])));
    if (step > 0 && step < 4) body.append(demo(step));
    if (step === 0) {
      if (getSettings().configured) body.append(node("p", "bs-setup-connected", t("ui_saved_and_connected")));
      body.append(field("key", "api_key", "password", "")); fields.key.required = !getSettings().configured; fields.key.maxLength = 500;
      fields.key.placeholder = t(getSettings().configured ? "ui_leave_blank_to_keep_the_saved_key" : "ui_enter_api_key");
      const advanced = node("details"), summary = node("summary", "", t("setup_endpoint_model")); advanced.append(summary);
      advanced.append(field("endpoint", "ui_api_endpoint", "url", getSettings().endpoint), field("model", "ui_model", "text", getSettings().model));
      fields.endpoint.required = true; fields.endpoint.maxLength = 2048; fields.model.required = true; fields.model.maxLength = 100;
      body.append(advanced);
    } else if (step === 1) {
      const row = node("label", "switch-row", t("setup_auto_observe")), toggle = node("input"); toggle.type = "checkbox"; toggle.checked = values.enabled; toggle.setAttribute("role", "switch"); fields.enabled = toggle; row.append(toggle); body.append(row);
      body.append(select("scope", "ui_observer_scope", [["blue", "ui_observer_blue"], ["all", "ui_observer_all"]], values.scope));
      body.append(select("mode", "ui_observer_mode", [["cumulative", "ui_mode_cumulative"], ["combined", "ui_mode_combined"]], values.mode));
      const policy = select("observerPreset", "ui_detection_policy", policies, values.observerPreset); policy.hidden = values.mode === "combined"; body.append(policy);
      fields.mode.onchange = () => { capture(); policy.hidden = values.mode === "combined"; };

    } else if (step === 2) {
      body.append(select("preset", "ui_support_settings", policies, values.preset));

    } else if (step === 3) {
      body.append(select("animationEffect", "ui_delete_effect", [["fly", "ui_fly_to_trash"], ["particles", "ui_particle_dissolve"]], values.animationEffect));
      fields.animationEffect.onchange = () => { capture(); stopAnimations(); body.querySelector(".setup-demo").replaceWith(demo(3, true)); };
    } else {
      const row = (label, value) => { const r = node("div", "compact-row"); r.append(node("span", "", t(label)), node("strong", "", value)); body.append(r); };
      row("setup_auto_observe", t(values.enabled ? "setup_on" : "setup_off"));
      row("ui_observer_mode", t(values.mode === "combined" ? "ui_mode_combined" : "ui_mode_cumulative"));
      if (values.mode !== "combined") row("ui_observer_settings", t(policies.find(p => p[0] === values.observerPreset)[1]));
      row("ui_support_settings", t(policies.find(p => p[0] === values.preset)[1]));
      row("ui_delete_effect", t(values.animationEffect === "particles" ? "ui_particle_dissolve" : "ui_fly_to_trash"));
    }
    body.append(footer); body.querySelector("input,select,button")?.focus();
    if (!(getSettings().reducedMotion && matchMedia("(prefers-reduced-motion: reduce)").matches)) {
      const animation = body.animate([{ opacity: .4, transform: `translateX(${direction * 12}px)` }, { opacity: 1, transform: "translateX(0)" }], { duration: 180, easing: "ease-out" });
      animations.add(animation); animation.finished.then(() => animations.delete(animation), () => animations.delete(animation));
    }
  }
  body.onsubmit = async event => {
    event.preventDefault(); if (busy || previewMode) return; capture();
    let operation;
    try {
      if (step === 0 && (!getSettings().configured || fields.key.value || fields.endpoint.value !== getSettings().endpoint || fields.model.value !== getSettings().model)) {
        operation = onConnect({ key: fields.key.value, endpoint: fields.endpoint.value, model: fields.model.value });
      } else if (step === 4) operation = onSave(values);
      busy = true; error.textContent = "";
      for (const el of dialog.querySelectorAll("button,input,select")) el.disabled = true;
      await operation;
      busy = false;
      if (step === 4) dismiss(true); else { step++; render(); }
    } catch (e) { error.textContent = e.message; }
    finally { busy = false; for (const el of dialog.querySelectorAll("button,input,select")) el.disabled = false; }
  };
  function open() {
    if (!getSettings()) return;
    const s = getSettings(); values = { enabled: !!s.observer?.enabled, scope: s.observer?.scope || "blue", observerPreset: s.observer?.preset || "careful", mode: s.observer?.mode || "cumulative", preset: s.preset || "careful", animationEffect: s.animationEffect || "fly" };
    focus = document.activeElement; step = 0; previewMode = false; if (!dialog.open) dialog.showModal(); render();
  }
  let done = false; try { done = localStorage.getItem(COMPLETED) === "1"; } catch {}
  if (!done) {
    notice = node("div", "bs-setup-entry"); notice.append(btn("setup_start", open, "text-button"), btn("guide_skip", completed, "text-button"));
    document.querySelector(".topbar")?.after(notice);
  }
  function preview(effect) {
    focus = document.activeElement; clearSecret(); previewMode = true; fields = {}; error.textContent = ""; body.replaceChildren(); title.textContent = t("ui_preview_animation");
    const sample = node("div", "bs-setup-sample", "block s.b."), play = btn("guide_replay", () => {
      stopAnimations(); body.querySelectorAll(".setup-particle").forEach(p => p.remove());
      const reduce = getSettings().reducedMotion && matchMedia("(prefers-reduced-motion: reduce)").matches;
      const animate = (el, frames, options) => { const a = el.animate(frames, options); animations.add(a); a.finished.then(() => { animations.delete(a); if (el !== sample) el.remove(); }, () => { animations.delete(a); if (el !== sample) el.remove(); }); };
      if (effect === "particles" && !reduce) for (let i = 0; i < 24; i++) {
        const p = node("span", "setup-particle"); sample.append(p);
        animate(p, [{ opacity: 1 }, { opacity: 0, transform: `translate(${(i % 7 - 3) * 28}px,${-25 - i * 4}px) scale(.1)` }], { duration: 700 });
      }
      animate(sample, effect === "particles" ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 1 }, { opacity: 0, transform: "translate(100px,-40px) scale(.1)" }], { duration: reduce ? 1 : 700 });
    });
    body.append(sample, play); if (!dialog.open) dialog.showModal(); play.focus();
  }
  return { open, preview };
}
