import "./helpers/i18n.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, normalizeHandle, sanitizePost, isWhitelisted, updateSettings, buildRequest, parseDecision, validateThread } from "../src/lib/core.js";

const root = { id: "100000", conversationId: "100000", handle: "author", userId: "900000", text: "所有远程办公都应该取消", parentId: "", hasMedia: false, incomplete: false };
const reply = { id: "100001", conversationId: "100000", handle: "reader", userId: "900001", text: "没错，我也支持取消", parentId: "100000", hasMedia: false, incomplete: false };
function answer(label = "support", probabilities = { support: .96, oppose: .01, neutral: .01, uncertain: .02 }, confidence = .95) {
  return { answers: { stance: { type: "choice", choice: label, probabilities, confidence } } };
}
test("clear support authorizes a block only with complete direct context", () => {
  assert.equal(parseDecision(answer(), DEFAULTS, root, reply).action, "block");
  for (const changed of [{ ...reply, text: "" }, { ...reply, incomplete: true }, { ...reply, parentId: "100002" }]) assert.equal(parseDecision(answer(), DEFAULTS, root, changed).action, "keep");
});
test("media presence does not veto clear textual support; uncertain media context remains visible", () => {
  const scores = { support: .98, oppose: .005, neutral: .005, uncertain: .01 };
  const result = parseDecision(answer("support", scores, .97), { ...DEFAULTS, high: .87, confidence: .72 }, { ...root, hasMedia: true }, { ...reply, text: "坚持坚持再坚持" });
  assert.equal(result.action, "block"); assert.deepEqual(result.blockReasons, []);
  assert.equal(parseDecision(answer(), DEFAULTS, root, { ...reply, hasMedia: true }).action, "block");
  const uncertain = parseDecision(answer("uncertain", { support: .1, oppose: .1, neutral: .1, uncertain: .7 }), DEFAULTS, { ...root, hasMedia: true }, reply);
  assert.equal(uncertain.action, "keep");
  assert.match(uncertain.blockReasons.join(";"), /未判定为明确支持/);
  assert.match(parseDecision(answer("support", scores, .5), DEFAULTS, root, reply).blockReasons.join(";"), /模型置信度/);
});
test("uncertain and medium support remain visible while folding is disabled", () => {
  assert.equal(parseDecision(answer("support", { support: .7, oppose: .1, neutral: .1, uncertain: .1 }), DEFAULTS, root, reply).action, "keep");
  assert.equal(parseDecision(answer("uncertain", { support: .1, oppose: .1, neutral: .1, uncertain: .7 }), DEFAULTS, root, reply).action, "keep");
  assert.equal(parseDecision(answer("support", { support: .4, oppose: .2, neutral: .2, uncertain: .2 }), DEFAULTS, root, reply).action, "keep");
});
test("explicit opposition and unrelated comments are never blocked or collapsed", () => {
  for (const label of ["oppose", "neutral"]) {
    const p = { support: .1, oppose: .1, neutral: .1, uncertain: .1 }; p[label] = .7;
    assert.equal(parseDecision(answer(label, p, .3), DEFAULTS, root, reply).action, "keep");
  }
});
test("confidence independently prevents auto-blocking", () => assert.equal(parseDecision(answer("support", undefined, .5), DEFAULTS, root, reply).action, "keep"));
test("malformed model output cannot authorize account changes", () => {
  for (const invalid of [{}, { answers: { stance: { type: "choice", choice: "support" } } }, answer("support", { support: 2, oppose: 0, neutral: 0, uncertain: 0 }), answer("support", { support: .2, oppose: .8, neutral: 0, uncertain: 0 }), answer("support", undefined, "0.99")]) assert.throws(() => parseDecision(invalid, DEFAULTS, root, reply));
});
test("selected reply scope excludes unrelated sibling branches", () => {
  assert.equal(validateThread(root, reply), true);
  const selected = { ...root, id: "100002" };
  assert.equal(validateThread(selected, reply), false);
  const parent = { ...reply, id: "100003", parentId: selected.id };
  const child = { ...reply, id: "100004", parentId: parent.id };
  assert.equal(validateThread(selected, child, [parent]), true);
  assert.equal(validateThread(selected, child, [{ ...parent, parentId: "100005" }]), false);
  assert.equal(validateThread(selected, child, [parent, parent]), false);
});
test("whitelist protects both handles and stable numeric user IDs", () => {
  const db = { whitelist: [{ handle: "reader", userId: "900001" }] };
  assert.equal(isWhitelisted(db, reply), true);
  assert.equal(isWhitelisted(db, { handle: "renamed", userId: "900001" }), true);
  assert.equal(isWhitelisted(db, { handle: "unrelated", userId: "900002" }), false);
});
test("Jev payload excludes identity and login fields", () => {
  const body = buildRequest({ ...root, cookie: "SECRET_COOKIE" }, { ...reply, apiKey: "SECRET_KEY" }, null, DEFAULTS.model);
  const text = JSON.stringify(body);
  for (const sensitive of ["SECRET_COOKIE", "SECRET_KEY", "900000", "900001", '"handle"', '"userId"']) assert.equal(text.includes(sensitive), false);
  assert.equal(body.state.original_post, root.text);
  assert.equal(body.state.reply, reply.text);
});
test("handles and stored links are normalized, hostile URLs rejected", () => {
  assert.equal(normalizeHandle(" https://x.com/Some_User "), "some_user");
  assert.equal(normalizeHandle("@Some_User"), "some_user");
  assert.throws(() => normalizeHandle("https://example.org/user"));
  assert.throws(() => normalizeHandle("https://x.com/user/status/12345"));
  assert.equal(sanitizePost({ ...reply, url: "javascript:alert(1)" }).url, "https://x.com/reader/status/100001");
});
test("threshold preferences reject impossible or non-finite combinations", () => {
  assert.throws(() => updateSettings(DEFAULTS, { high: .49 }));
  assert.throws(() => updateSettings(DEFAULTS, { high: NaN }));
  assert.throws(() => updateSettings(DEFAULTS, { model: "https://evil.example" }));
  assert.equal(updateSettings(DEFAULTS, { preset: "balanced" }).high, .87);
});

test("observer settings stay opt-in and independent of the stance policy", () => {
  assert.equal(DEFAULTS.observer.enabled, false);
  const updated = updateSettings(DEFAULTS, { observer: { enabled: true, skipFollowing: false }, autoLoadDefault: true, language: "zh_TW" });
  assert.equal(updated.observer.enabled, true);
  assert.equal(updated.observer.skipFollowing, false);
  assert.equal(updated.skipFollowing, true);
  assert.equal(updated.observer.minHits, 3);
  assert.equal(updated.autoLoadDefault, true);
  assert.equal(updated.language, "zh_TW");
  assert.equal(DEFAULTS.observer.enabled, false, "saving nested preferences must not mutate defaults");
  assert.throws(() => updateSettings(DEFAULTS, { language: "../../invalid" }));
});

test("post snapshots retain explicit blue status without persisting avatar fields", () => {
  const post = sanitizePost({ ...reply, blueVerified: true, avatar: "https://example.org/avatar.jpg", profile_image_url_https: "https://example.org/another.jpg" });
  assert.equal(post.blueVerified, true);
  assert.equal(post.userId, reply.userId);
  assert.equal("avatar" in post, false);
  assert.equal("profile_image_url_https" in post, false);
  assert.equal(sanitizePost({ ...reply, verified: true }).blueVerified, null);
  assert.equal(sanitizePost({ ...reply, blueVerified: "true" }).blueVerified, null);
});
