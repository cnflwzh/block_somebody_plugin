import "../lib/i18n.js";
const { t } = globalThis.BlockSBI18n;
const el = (tag, cls, text) => { const n = document.createElement(tag); n.className = cls || ''; if (text !== undefined) n.textContent = text; return n; };
/** Dashboard presentation. Actions are delegated to existing manager handlers. */
export function mountDashboard({ send, refresh, navigate, showRecord, undoRecord, toast }) {
  const root = document.getElementById('view-dashboard');
  let state, filter = 'all', limit = 30, signature = '';
  const label = module => t(module === 'observer' ? 'ui_observer_title' : module === 'name' ? 'ui_name_rules' : 'block_history');
  const button = (text, fn, cls='text-button') => { const b=el('button',cls,text); b.type='button'; b.onclick=async()=>{b.disabled=true;try{await fn();}catch(e){toast(e.message);}finally{b.disabled=false;}};return b; };
  root.innerHTML = `<div class="section-heading dashboard-heading"><h2 data-i18n="dash_overview"></h2><time id="dashboard-date"></time></div><div class="stats dashboard-stats"><div><span data-i18n="dash_analyzed"></span><strong id="dashboard-analyzed">0</strong></div><div><span data-i18n="ui_queued"></span><strong id="dashboard-pending">0</strong></div><div><span data-i18n="ui_submitted"></span><strong id="dashboard-submitted">0</strong></div></div><div id="dashboard-modules"></div><div class="section-heading dashboard-record-heading"><h2 data-i18n="dash_recent"></h2></div><div class="toolbar"><label class="search-field"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg><input id="dashboard-search" type="search" data-i18n-placeholder="dash_search" data-i18n-aria-label="dash_search"></label><div class="filters" id="dashboard-filters"></div></div><div id="dashboard-records"></div><button id="dashboard-more" class="subtle wide" type="button" data-i18n="ui_show_more_accounts" hidden></button>`;
  root.querySelector('#dashboard-search').oninput=()=>{limit=30;renderRecords();};
  root.querySelector('#dashboard-more').onclick=()=>{limit+=30;renderRecords();};
  function renderRecords(){
    if(!state?.dashboard)return;
    const query=root.querySelector('#dashboard-search').value.trim().toLowerCase();
    const rows=state.dashboard.records.filter(r=>(filter==='all'||r.modules.includes(filter))&&(!query||[r.target?.name,r.target?.handle,r.account,...r.ruleNames].join(' ').toLowerCase().includes(query)));
    const list=root.querySelector('#dashboard-records');list.replaceChildren();
    for(const r of rows.slice(0,limit)){
      const row=el('article','dashboard-record'), identity=el('div','dashboard-identity');
      identity.append(el('span','avatar',(r.target?.name||r.target?.handle||'?').slice(0,1)),el('strong','',r.target?.name||r.target?.handle||'—'),el('span','muted','@'+(r.target?.handle||'—')));
      identity.title=t('ui_observer_actor',r.account);
      const reason=el('div','dashboard-reason'),sources=el('div','dashboard-sources');
      for(const m of r.modules)sources.append(el('span','source-badge source-'+m,label(m)));
      reason.append(sources,el('span','',r.ruleNames.length?r.ruleNames.join(' / '):Number.isFinite(r.probability)?t(r.modules.includes('observer')?(r.combined?'dash_combined_score':'dash_ai_score'):'dash_support_score',Math.round(r.probability*100)):t(r.reason==='manual'?'ui_blocked_manually':'dash_observation')));
      const statusKeys={pending:'ui_pending',running:'ui_submitting',submitted:'ui_submitted',blocked:'ui_submitted',skipped:'dash_skipped',masked:'dash_masked',observing:'ui_observer_watching',failed:'ui_submission_failed',uncertain:'ui_needs_verification',cancelled:'ui_task_canceled',unblocked:'ui_unblocked',undo_pending:'ui_unblock_pending',undo_running:'ui_unblocking',undo_failed:'ui_unblock_failed',preexisting:'ui_already_blocked'};
      const status=el('span','status '+r.status,t(statusKeys[r.status]||'ui_observer_watching'));
      const actions=el('div','dashboard-actions'),h=state.history.find(h=>h.id===r.historyId);
      if(h){if(['pending','running','submitted','blocked','undo_failed'].includes(h.status)&&(h.owned||['pending','running'].includes(h.status))&&r.modules.length===1)actions.append(button(t(['pending','running'].includes(h.status)?'dash_withdraw':'dash_undo'),()=>undoRecord(h,r.modules[0])));else actions.append(button(t('ui_view_reason'),()=>showRecord(h)));}
      else if(r.replyId&&/^\d+$/.test(r.replyId)){const a=el('a','text-button',t('ui_view_original'));a.setAttribute('aria-label',t('ui_view_post_on_x'));a.href=`https://x.com/i/status/${r.replyId}`;a.target='_blank';a.rel='noopener noreferrer';actions.append(a);}
      const time=el('time','dashboard-time',new Date(r.at).toLocaleTimeString(globalThis.BlockSBI18n.locale.replace('_','-'),{hour:'2-digit',minute:'2-digit'}));time.dateTime=new Date(r.at).toISOString();time.title=new Date(r.at).toLocaleString();
      row.append(identity,reason,status,actions,time);list.append(row);
    }
    if(!rows.length)list.append(el('p','empty-inline',t(query?'ui_observer_no_matches':'dash_empty')));
    root.querySelector('#dashboard-more').hidden=rows.length<=limit;
  }
  return next=>{
    state=next;if(!state.dashboard)return;
    const nextSignature=JSON.stringify([state.dashboard,state.settings.observer,state.settings.filterRules,state.settings.subscriptionRules,state.settings.customFiltersEnabled,state.settings.paused,state.modelError,globalThis.BlockSBI18n.locale]);
    if(nextSignature===signature)return;signature=nextSignature;
    globalThis.BlockSBI18n.localizeDocument(root);
    root.querySelector('#dashboard-date').textContent=new Date().toLocaleDateString(globalThis.BlockSBI18n.locale.replace('_','-'));
    for(const key of ['analyzed','pending','submitted'])root.querySelector('#dashboard-'+key).textContent=state.dashboard[key];
    root.querySelector('#dashboard-analyzed').title=t('dash_count_note');
    const modules=root.querySelector('#dashboard-modules');modules.replaceChildren();
    for(const kind of ['observer','stance','name']){
      const row=el('div','dashboard-module'),icon=el('span','module-icon source-'+kind);const img=el('img');img.src='../../assets/ui/'+(kind==='observer'?'users':kind==='stance'?'network':'filter')+'.svg';img.alt='';icon.append(img);row.append(icon,el('strong','',label(kind)));
      const config=state.settings.observer,enabled=kind==='observer'?config.enabled:(state.settings.filterRules||[]).some(r=>r.enabled);
      const stateText=kind==='stance'?t(state.dashboard.activeTasks?'dash_tasks':'dash_no_tasks',state.dashboard.activeTasks):kind==='name'?(state.settings.customFiltersEnabled===false?t('ui_custom_filters_off'):t('ui_name_rules_count',[...(state.settings.filterRules||[]),...(state.settings.subscriptionRules||[])].filter(r=>r.enabled).length)):t(state.settings.paused?'ui_observer_state_paused':!enabled?'ui_observer_state_off':state.modelError?'ui_observer_state_error':!state.settings.configured?'ui_observer_state_unconfigured':config.mode==='combined'?'dash_combined_watching':'dash_cumulative_watching');
      row.append(el('span','muted',stateText));
      if(kind==='observer'||kind==='name'){const toggle=el('input');toggle.type='checkbox';toggle.setAttribute('role','switch');toggle.setAttribute('aria-label',label(kind));toggle.checked=kind==='name'?state.settings.customFiltersEnabled!==false:enabled;toggle.onchange=async()=>{toggle.disabled=true;try{await send('SAVE_SETTINGS',{value:kind==='name'?{customFiltersEnabled:toggle.checked}:{observer:{enabled:toggle.checked}}});await refresh();}catch(e){toast(e.message);toggle.checked=!toggle.checked;}finally{toggle.disabled=false;}};row.append(toggle);}
      else row.append(button(t(kind==='stance'?'dash_view_tasks':'dash_manage'),()=>navigate(kind==='stance'?'history':'name-rules'),'subtle'));
      modules.append(row);
    }
    const filters=root.querySelector('#dashboard-filters');filters.replaceChildren();
    for(const key of ['all','observer','stance','name']){const b=button(key==='all'?t('ui_all'):label(key),()=>{filter=key;limit=30;signature='';update(state);},key===filter?'selected':'');filters.append(b);}
    renderRecords();
  };
  function update(next){state=next;signature='';const filters=root.querySelectorAll('#dashboard-filters button');['all','observer','stance','name'].forEach((k,i)=>filters[i]?.classList.toggle('selected',k===filter));renderRecords();}
}
