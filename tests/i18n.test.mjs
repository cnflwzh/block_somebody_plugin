import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../src/lib/i18n.js", import.meta.url), "utf8");
function fixture(fetch) {
  const requests = [];
  const context = {
    chrome: {
      i18n: { getUILanguage: () => "zh-TW", getMessage: key => `native:${key}` },
      runtime: { getURL: path => `chrome-extension://fixture/${path}` }
    },
    fetch: async url => {
      requests.push(url);
      return { ok: true, json: async () => fetch(url.match(/_locales\/([^/]+)\//)[1]) };
    }
  };
  runInNewContext(source, context);
  return { api: context.BlockSBI18n, requests };
}

test("language preference uses packaged Chrome catalogs and preserves native automatic mode", async () => {
  const { api, requests } = fixture(code => ({ greeting: { message: code } }));
  const { t } = api;
  assert.equal(t("greeting"), "native:greeting");
  assert.equal(api.locale, "zh-TW");
  for (const [code, locale] of [["zh_CN", "zh-CN"], ["zh_TW", "zh-TW"], ["ja", "ja"], ["ko", "ko"], ["en", "en"]]) {
    await api.setLanguage(code);
    assert.equal(t("greeting"), code);
    assert.equal(api.locale, locale);
  }
  assert.equal(requests.length, 5, "each bundled catalog is fetched once");
  await api.setLanguage("../../outside");
  assert.equal(t("greeting"), "native:greeting");
  assert.equal(api.locale, "zh-TW");
  assert.equal(requests.length, 5, "unsupported values never become fetch paths");
});

test("manual language supports named and numbered placeholders without interpreting inserted values", async () => {
  const { api } = fixture(code => ({
    literal: { message: "$name$ / $1 / $$ / $V1$$v2$", placeholders: {
      NAME: { content: "$1" }, v1: { content: "$2" }, v2: { content: "$3" }
    } },
    ...(code === "en" ? { fallback: { message: "English fallback" } } : {})
  }));
  await api.setLanguage("ja");
  assert.equal(api.t("literal", "$2<script>", "one", "two"), "$2<script> / $2<script> / $ / onetwo");
  assert.equal(api.t("fallback"), "English fallback");
  assert.equal(api.t("not_in_catalog"), "native:not_in_catalog");
});

test("a slow earlier language fetch cannot overwrite the most recent preference", async () => {
  let finishJapanese;
  const delayed = new Promise(resolve => { finishJapanese = resolve; });
  const { api } = fixture(code => code === "ja" ? delayed : { greeting: { message: code } });
  const first = api.setLanguage("ja");
  await api.setLanguage("ko");
  finishJapanese({ greeting: { message: "ja" } });
  await first;
  assert.equal(api.locale, "ko");
  assert.equal(api.t("greeting"), "ko");
  const { api: second } = fixture(code => ({ greeting: { message: code } }));
  const pending = second.setLanguage("ja");
  await second.setLanguage("auto");
  await pending;
  assert.equal(second.t("greeting"), "native:greeting");
});

test("temporary catalog errors fall back to Chrome and can be retried", async () => {
  let fail = true;
  const { api } = fixture(code => {
    if (code === "ja" && fail) throw new Error("resource unavailable");
    return { greeting: { message: code } };
  });
  await api.setLanguage("ja");
  assert.equal(api.t("greeting"), "native:greeting");
  fail = false;
  await api.setLanguage("ja");
  assert.equal(api.t("greeting"), "ja");
});
