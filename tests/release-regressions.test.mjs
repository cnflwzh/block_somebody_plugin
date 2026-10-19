import './helpers/i18n.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { getReviewRule } from '../src/lib/observer-review-rule.js';
import { getObserverRule, normalizeObserverSettings, observerRuleIdentity } from '../src/lib/observer-core.js';
import { buildAccountReviewRequest, reviewContext } from '../src/lib/observer-review.js';
import { createSubscriptionService, subscriptionUrl, fetchSubscription } from '../src/lib/filter-subscriptions.js';
import { exportFilterFile, parseFilterFile } from '../src/lib/filter-transfer.js';

const rule = {id:'example',name:'Example',enabled:true,action:'mask',mode:'all',conditions:[{field:'text',op:'contains',value:'example',ignoreCase:true}]};
test('combined prompt and categories are independent from cumulative configuration', () => {
  const config = normalizeObserverSettings({mode:'combined'});
  const cumulative = getObserverRule({...config,mode:'cumulative'});
  cumulative.prompt = 'CUMULATIVE_ONLY';
  const review = getReviewRule(config);
  review.prompt = 'COMBINED_ONLY {{sample_count}}';
  review.options = [{id:'generated',name:'Generated',description:'Generated text',block:true},{id:'natural',name:'Natural',description:'Natural reply',block:false}];
  const settings = normalizeObserverSettings({analysisRule:cumulative,reviewRule:review},config);
  assert.equal(getObserverRule({...settings,mode:'cumulative'}).prompt,'CUMULATIVE_ONLY');
  assert.equal(getObserverRule(settings).prompt,review.prompt);
  const sample = {rootId:'root',reviewContext:reviewContext({id:'root',text:'Topic'},{id:'reply',parentId:'root',text:'Reply'},[])};
  const request = buildAccountReviewRequest([sample],'model',settings);
  assert.match(request.questions.stance.instructions,/COMBINED_ONLY 1/);
  assert.doesNotMatch(JSON.stringify(request),/CUMULATIVE_ONLY/);
  assert.deepEqual(Object.keys(request.questions.stance.criteria),['generated','natural']);
  assert.equal(JSON.parse(request.state).samples.length,1);
  const changedCumulative = {...settings,analysisRule:{...cumulative,prompt:'changed'}};
  assert.deepEqual(observerRuleIdentity(settings),observerRuleIdentity(changedCumulative));
  assert.notDeepEqual(observerRuleIdentity(settings),observerRuleIdentity({...settings,reviewRule:{...review,prompt:'changed'}}));
});
test('filter transfer regenerates grants and rejects malformed rule bundles', () => {
  const text = exportFilterFile([{...rule,revision:'private-grant',history:['private']}]);
  assert.doesNotMatch(text,/private/);
  const imported = parseFilterFile(text);
  assert.notEqual(imported[0].id,rule.id);
  assert.deepEqual(imported[0].conditions,rule.conditions);
  assert.throws(()=>parseFilterFile('{"format":"block-sb-filters","version":2,"rules":[]}'));
  assert.throws(()=>subscriptionUrl('http://example.org/rules.json'));
  assert.throws(()=>subscriptionUrl('https://user:password@example.org/rules.json'));
});
test('subscription refresh retains valid rules on failure and preserves unchanged grants', async () => {
  const oldChrome=globalThis.chrome;
  globalThis.chrome={permissions:{contains:async()=>true}};
  let db={settings:{filterRules:[],subscriptionRules:[]},filterSubscriptions:[]},fail=false,calls=0;
  const service=createSubscriptionService({read:async fn=>structuredClone(fn(db)),change:async fn=>{const next=structuredClone(db);const result=fn(next);db=next;return result;},changed:()=>{},revoke:()=>{},fetcher:async(url,options)=>{
    calls++; assert.equal(options.credentials,'omit'); assert.equal(options.redirect,'error');
    if(fail) throw new Error('network');
    return new Response(exportFilterFile([rule]),{headers:{etag:'v1'}});
  }});
  try {
    const preview=await service.preview('https://example.org/rules.json');
    await service.add(preview.token,true);
    const id=db.filterSubscriptions[0].id, grant=db.settings.subscriptionRules[0].revision;
    await service.refresh(id);
    assert.equal(db.settings.subscriptionRules[0].revision,grant);
    fail=true;
    await assert.rejects(service.refresh(id));
    assert.equal(db.settings.subscriptionRules[0].revision,grant);
    assert.equal(db.filterSubscriptions[0].error,'update');
    const before=calls; await service.due(); assert.equal(calls,before);
    await service.edit(id,false,true);
    assert.equal(db.settings.subscriptionRules.length,0);
  } finally {globalThis.chrome=oldChrome;}
});
test('subscription oversized responses fail before importing rules', async()=>{
 await assert.rejects(fetchSubscription({id:'test',url:'https://example.org/rules.json'},async()=>new Response('{}',{headers:{'content-length':'1048577'}})),/size/);
});
