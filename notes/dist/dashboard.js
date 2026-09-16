const CONFIG = globalThis.AI_NOTE_CONFIG || {};
let API = CONFIG.backendUrl || 'http://localhost:4000';
const CLIENT = CONFIG.clientUrl || CONFIG.backendUrl || 'http://localhost:4000';
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let userId = '';
let authToken = '';
let meetings = [];
let activeMeeting = null;
let activeTab = 'summary';
let listViewFilter = 'all'; // all | favorites | archived

async function getAuth() {
  const stored = await chrome.storage.local.get({ authToken: '', authApiKey: '', authUser: null, noteUserId: '', backendUrlOverride: '' });
  authToken = stored.authToken || stored.authApiKey || '';
  userId = stored.authUser?.id || stored.noteUserId || '';
  if (stored.backendUrlOverride) API = String(stored.backendUrlOverride).replace(/\/$/, '');
  return stored;
}
async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  const res = await fetch(`${API}${path}`, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error(data.error || 'Please log in from the extension popup or web app.');
  if (!res.ok || data.ok === false) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
function esc(value='') { return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c])); }
function fmtDate(value) { return value ? new Date(value).toLocaleString([], {dateStyle:'medium', timeStyle:'short'}) : '—'; }
function fmtDuration(seconds) { const n = Math.max(0, Math.round(Number(seconds || 0))); return `${Math.floor(n/60)} min${n%60 ? ` ${n%60}s` : ''}`; }
function toast(message) { const el=$('toast'); el.textContent=message; el.classList.remove('hidden'); setTimeout(()=>el.classList.add('hidden'),2600); }
function openExtension() { chrome.windows.create({ url: chrome.runtime.getURL('popup.html'), type: 'popup', width: 440, height: 760, focused: true }).catch(()=>{}); }

let filterState = { date: 'all', source: 'all', status: 'all', ai: 'all' };
let selectedMeetingIds = new Set();
let meetingsOffset = 0;
const meetingsPageSize = 100;
let hasMoreMeetings = false;

function actionCount(m) { return Array.isArray(m?.ai?.actionItems) ? m.ai.actionItems.length : 0; }
function hasInsights(m) {
  const ai = m?.ai || {};
  return Boolean((ai.decisions||[]).length || (ai.topics||[]).length || (ai.followUps||[]).length || (ai.keyPoints||[]).length);
}
function meetingStatus(m) {
  if (m?.ai?.error || m?.lastSyncError) return { key:'failed', label:'AI analysis failed', icon:'warning', tone:'danger' };
  if (m?.ai?.summary) return { key:'ready', label:'AI summary ready', icon:'check_circle', tone:'success' };
  if (m?.fullTranscript || (m?.transcript||[]).length) return { key:'processing', label:'AI analysis in progress', icon:'progress_activity', tone:'processing' };
  return { key:'processing', label:'Transcript processing', icon:'sync', tone:'processing' };
}
function matchesDate(m, filter) {
  if (filter === 'all') return true;
  const d = new Date(m.startedAt || m.createdAt || 0); if (Number.isNaN(d.getTime())) return false;
  const now = new Date(); const start = new Date(now); start.setHours(0,0,0,0);
  if (filter === 'today') return d >= start;
  if (filter === 'yesterday') { const y = new Date(start); y.setDate(y.getDate()-1); return d >= y && d < start; }
  if (filter === 'week') { const w = new Date(start); const day=(w.getDay()+6)%7; w.setDate(w.getDate()-day); return d >= w; }
  if (filter === 'month') { return d.getMonth()===now.getMonth() && d.getFullYear()===now.getFullYear(); }
  return true;
}
function matchesSearch(m, q) {
  if (!q) return true;
  const ai=m.ai||{};
  const hay=[m.title,m.platform,m.meetingUrl,m.fullTranscript,...(m.participants||[]).flatMap(p=>[p.name,p.email]),ai.summary,ai.detailedSummary,...(ai.keyPoints||[]),...(ai.decisions||[]),...(ai.topics||[]),...(ai.followUps||[]),...(ai.actionItems||[]).flatMap(a=>[a.task,a.owner,a.deadline])].join(' ').toLowerCase();
  return hay.includes(q.toLowerCase());
}
function applyClientFilters(source) {
  const q=$('searchInput').value.trim();
  return source.filter(m=>{
    if (!matchesSearch(m,q)) return false;
    if (filterState.date !== 'all' && !matchesDate(m,filterState.date)) return false;
    if (filterState.source !== 'all' && String(m.platform||'Manual').toLowerCase() !== filterState.source.toLowerCase()) return false;
    const st=meetingStatus(m).key; if (filterState.status !== 'all' && st !== filterState.status) return false;
    if (filterState.ai==='summary' && !m.ai?.summary) return false;
    if (filterState.ai==='actions' && actionCount(m)===0) return false;
    if (filterState.ai==='insights' && !hasInsights(m)) return false;
    return true;
  });
}
function dedupeMeetings(items) {
  const seen=new Map();
  for(const m of items){
    const key=String(m.externalId||m._id||`${m.userId||''}:${m.startedAt||''}:${m.title||''}`);
    if(!seen.has(key)) seen.set(key,m);
    else {
      const existing=seen.get(key);
      const existingScore=(existing.ai?.summary?4:0)+(existing.fullTranscript?2:0)+(existing.participants?.length||0);
      const currentScore=(m.ai?.summary?4:0)+(m.fullTranscript?2:0)+(m.participants?.length||0);
      if(currentScore>existingScore) seen.set(key,m);
    }
  }
  return [...seen.values()];
}
async function loadMeetings() {
  $('meetingList').innerHTML = '<div class="loading">Loading your meeting history…</div>';
  try {
    const q = $('searchInput').value.trim();
    const data = await api(`/api/meetings?userId=${encodeURIComponent(userId)}&q=${encodeURIComponent(q)}&view=${encodeURIComponent(listViewFilter)}&limit=${meetingsPageSize}&offset=${meetingsOffset}`);
    const incoming = dedupeMeetings(data.meetings || []);
    meetings = meetingsOffset > 0 ? dedupeMeetings([...meetings, ...incoming]) : incoming;
    hasMoreMeetings = Boolean(data.hasMore);
    window.meetingsTotal = Number(data.total || meetings.length);
    const filtered = applyClientFilters(meetings);
    const sort = $('sortSelect').value;
    if (sort === 'oldest') filtered.sort((a,b)=>new Date(a.startedAt)-new Date(b.startedAt));
    if (sort === 'longest') filtered.sort((a,b)=>(b.duration||0)-(a.duration||0));
    if (sort === 'shortest') filtered.sort((a,b)=>(a.duration||0)-(b.duration||0));
    if (sort === 'updated') filtered.sort((a,b)=>new Date(b.updatedAt||b.endedAt||b.startedAt)-new Date(a.updatedAt||a.endedAt||a.startedAt));
    if (sort === 'actions') filtered.sort((a,b)=>actionCount(b)-actionCount(a));
    if (sort === 'viewed') filtered.sort((a,b)=>(b.viewCount||0)-(a.viewCount||0));
    renderMeetings(filtered);
    updateFilterCount();
    $('loadMoreWrap')?.classList.toggle('hidden', !hasMoreMeetings || Boolean($('searchInput').value.trim()) || Object.values(filterState).some(v=>v!=='all'));
  } catch (error) {
    $('meetingList').innerHTML=''; $('listState').classList.remove('hidden');
    $('listState').innerHTML=`<strong>Could not load meetings</strong><p>${esc(error.message)}<br>Start the backend with <code>server/npm install</code> and <code>npm start</code>.</p>`;
  }
}
function groupLabel(date) {
  const d=new Date(date), now=new Date(); const today=new Date(now); today.setHours(0,0,0,0);
  const yesterday=new Date(today); yesterday.setDate(yesterday.getDate()-1);
  if(d>=today) return 'Today'; if(d>=yesterday) return 'Yesterday';
  const week=new Date(today); const day=(week.getDay()+6)%7; week.setDate(week.getDate()-day);
  if(d>=week) return 'This week'; return 'Earlier';
}
function platformIcon(platform) {
  const p=String(platform||'Manual').toLowerCase();
  if(p.includes('meet')) return 'videocam'; if(p.includes('zoom')) return 'video_camera_front'; if(p.includes('team')) return 'groups'; if(p.includes('upload')) return 'upload_file'; return 'mic';
}
function renderMeetings(items=meetings) {
  $('listState').classList.add('hidden');
  $('loadMoreWrap')?.classList.toggle('hidden', !hasMoreMeetings);
  if (!items.length) {
    const q=$('searchInput').value.trim();
    let title='No meetings yet', msg='Your recorded meetings will appear here automatically.';
    if(q || Object.values(filterState).some(v=>v!=='all')) { title='No meetings found'; msg='Try a different keyword or clear some filters.'; }
    else if(listViewFilter==='favorites'){title='No favourite meetings';msg='Star important meetings to find them quickly.';}
    else if(listViewFilter==='archived'){title='Nothing archived';msg='Archived meetings will appear here.';}
    $('meetingList').innerHTML=`<div class="state-card"><strong>${title}</strong><p>${msg}</p><button class="primary-btn empty-cta" id="emptyNewMeeting"><span class="material-symbols-outlined">add</span> New Meeting</button></div>`;
    $('emptyNewMeeting')?.addEventListener('click',openExtension); updateSelectionBar(); return;
  }
  let lastGroup=''; let html='';
  for(const m of items){
    const group=groupLabel(m.startedAt); if(group!==lastGroup){html+=`<div class="meeting-group-title">${group}</div>`;lastGroup=group;}
    const st=meetingStatus(m), actions=actionCount(m), selected=selectedMeetingIds.has(String(m.externalId));
    const participants=(m.participants||[]).filter(p=>p?.name).slice(0,3).map(p=>esc(p.name)).join(', ');
    const participantText=participants ? ` · ${participants}` : ` · ${(m.participants||[]).length || 0} participant${(m.participants||[]).length===1?'':'s'}`;
    html+=`<article class="meeting-card ${selected?'selected':''}" data-id="${esc(m.externalId)}">
      <label class="meeting-select" title="Select meeting"><input type="checkbox" data-select-id="${esc(m.externalId)}" ${selected?'checked':''}><span></span></label>
      <div class="meeting-card-main">
        <div class="meeting-title-row"><div class="meeting-title">${esc(m.title||'Untitled meeting')}</div>${m.isArchived?'<span class="badge-archived">Archived</span>':''}</div>
        <div class="meeting-meta">${esc(new Date(m.startedAt||m.createdAt||Date.now()).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'}))} · ${fmtDuration(m.duration)} · ${esc(m.platform||'Manual')}${participantText}</div>
        <div class="meeting-status-row"><span class="status-pill status-${st.tone}"><span class="material-symbols-outlined">${st.icon}</span>${esc(st.label)}</span>${m.fullTranscript||m.transcript?.length?'<span class="availability-pill"><span class="material-symbols-outlined">check_circle</span>Transcript</span>':''}${actions?`<span class="availability-pill"><span class="material-symbols-outlined">task_alt</span>${actions} action${actions===1?'':'s'}</span>`:''}</div>
      </div>
      <div class="meeting-right"><div class="platform"><span class="material-symbols-outlined">${platformIcon(m.platform)}</span>${esc(m.platform||'Manual')}</div><div class="meeting-card-actions"><button type="button" class="mini-btn fav-btn" data-action="favorite" data-id="${esc(m.externalId)}" title="${m.isFavorite?'Remove favourite':'Add to favourites'}">${m.isFavorite?'★':'☆'}</button><button type="button" class="mini-btn menu-btn" data-action="menu" data-id="${esc(m.externalId)}" title="More actions"><span class="material-symbols-outlined">more_horiz</span></button></div></div>
      <div class="meeting-menu hidden" data-menu-id="${esc(m.externalId)}"><button data-menu-action="open">Open meeting</button><button data-menu-action="ask">Ask AI</button><button data-menu-action="favorite">${m.isFavorite?'Remove from favourites':'Add to favourites'}</button><button data-menu-action="rename">Rename</button><button data-menu-action="export">Export</button><button data-menu-action="archive">${m.isArchived?'Unarchive':'Archive'}</button><button data-menu-action="delete" class="danger-menu">Delete</button></div>
    </article>`;
  }
  $('meetingList').innerHTML=html;
  bindMeetingInteractions(); updateSelectionBar();
}
function bindMeetingInteractions(){
  document.querySelectorAll('.meeting-card').forEach(el=>el.addEventListener('click',e=>{ if(e.target.closest('[data-action]')||e.target.closest('.meeting-select')||e.target.closest('.meeting-menu'))return; openMeeting(el.dataset.id); }));
  document.querySelectorAll('[data-select-id]').forEach(cb=>cb.addEventListener('change',e=>{const id=String(e.target.dataset.selectId);e.target.checked?selectedMeetingIds.add(id):selectedMeetingIds.delete(id);e.target.closest('.meeting-card')?.classList.toggle('selected',e.target.checked);updateSelectionBar();}));
  document.querySelectorAll('[data-action="favorite"]').forEach(btn=>btn.addEventListener('click',()=>runMeetingAction(btn.dataset.id,'favorite')));
  document.querySelectorAll('[data-action="menu"]').forEach(btn=>btn.addEventListener('click',e=>{e.stopPropagation();document.querySelectorAll('.meeting-menu').forEach(m=>m.classList.add('hidden'));document.querySelector(`[data-menu-id="${CSS.escape(btn.dataset.id)}"]`)?.classList.toggle('hidden');}));
  document.querySelectorAll('.meeting-menu button').forEach(btn=>btn.addEventListener('click',e=>{e.stopPropagation();const menu=btn.closest('.meeting-menu'),id=menu.dataset.menuId,action=btn.dataset.menuAction;menu.classList.add('hidden');runMeetingMenuAction(id,action);}));
}
async function runMeetingAction(id,action){
  const m=meetings.find(x=>String(x.externalId)===String(id)); if(!m)return;
  try{ if(action==='favorite'){await api(`/api/meetings/${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify({userId,isFavorite:!m.isFavorite})});toast(m.isFavorite?'Removed from favourites.':'Marked favourite.');await loadMeetings();} }
  catch(e){toast(e.message);}
}
async function runMeetingMenuAction(id,action){
  const m=meetings.find(x=>String(x.externalId)===String(id)); if(!m)return;
  if(action==='open') return openMeeting(id);
  if(action==='ask'){await openMeeting(id);activeTab='chat';renderTab();return;}
  if(action==='favorite') return runMeetingAction(id,'favorite');
  if(action==='rename'){const title=prompt('Meeting title',m.title||'Untitled meeting');if(title&&title.trim()){await api(`/api/meetings/${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify({userId,title:title.trim()})});await loadMeetings();toast('Meeting renamed.');}return;}
  if(action==='export'){await openMeeting(id);return exportAllPdf();}
  if(action==='archive'){await api(`/api/meetings/${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify({userId,isArchived:!m.isArchived})});toast(m.isArchived?'Unarchived.':'Archived.');await loadMeetings();return;}
  if(action==='delete'){if(!confirm('Delete this meeting? This removes its transcript and AI analysis.'))return;await api(`/api/meetings/${encodeURIComponent(id)}?userId=${encodeURIComponent(userId)}`,{method:'DELETE'});toast('Meeting deleted.');await loadMeetings();}
}
function updateFilterCount(){const n=Object.values(filterState).filter(v=>v!=='all').length;$('filterCount')?.classList.toggle('hidden',n===0);if($('filterCount'))$('filterCount').textContent=n;}
function updateSelectionBar(){const n=selectedMeetingIds.size;$('selectionBar')?.classList.toggle('hidden',n===0);if($('selectedCount'))$('selectedCount').textContent=n;}
async function bulkAction(action){
  const ids=[...selectedMeetingIds]; if(!ids.length)return;
  if(action==='delete' && !confirm(`Delete ${ids.length} selected meeting${ids.length>1?'s':''}?`))return;
  for(const id of ids){
    try{
      if(action==='delete') await api(`/api/meetings/${encodeURIComponent(id)}?userId=${encodeURIComponent(userId)}`,{method:'DELETE'});
      else if(action==='favorite') await api(`/api/meetings/${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify({userId,isFavorite:true})});
      else if(action==='archive') await api(`/api/meetings/${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify({userId,isArchived:true})});
    }catch(e){toast(e.message);break;}
  }
  if(action==='export'){for(const id of ids){await openMeeting(id);exportAllPdf();}}
  selectedMeetingIds.clear();await loadMeetings();toast(`${ids.length} meeting${ids.length>1?'s':''} updated.`);
}
async function openMeeting(id) {
  $('listView').classList.add('hidden'); $('detailView').classList.remove('hidden'); $('detailContent').innerHTML='<div class="loading">Loading meeting…</div>';
  try { const data=await api(`/api/meetings/${encodeURIComponent(id)}?userId=${encodeURIComponent(userId)}`); activeMeeting=data.meeting; renderDetail(); } catch(error) { $('detailContent').innerHTML=`<div class="state-card">${esc(error.message)}</div>`; }
}
function renderDetail() {
  const m=activeMeeting;
  $('meetingHero').innerHTML=`<div class="hero-kicker">${esc(m.platform)} · MEETING NOTES</div><div class="hero-title">${m.isFavorite ? '★ ' : ''}${esc(m.title)}${m.isArchived ? ' · Archived' : ''}</div><div class="hero-meta">${esc(fmtDate(m.startedAt))} · ${fmtDuration(m.duration)} · ${m.ai?.summary ? 'AI summary ready' : 'Transcript saved'}</div>`;
  if ($('favoriteBtn')) $('favoriteBtn').textContent = m.isFavorite ? '★ Favourited' : '☆ Favourite';
  if ($('archiveBtn')) $('archiveBtn').textContent = m.isArchived ? '↩ Unarchive' : 'Archive';
  renderTab();
}
function renderTab() {
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===activeTab));
  const m=activeMeeting;
  if(activeTab==='summary') {
    const ai=m.ai||{};
    const discussion=Array.isArray(ai.discussionDetails)?ai.discussionDetails:[];
    const decisionDetails=Array.isArray(ai.decisionDetails)?ai.decisionDetails:[];
    const conflicts=Array.isArray(ai.conflicts)?ai.conflicts:[];
    const questions=Array.isArray(ai.openQuestions)?ai.openQuestions:[];
    $('detailContent').innerHTML=`
      <div class="section-card title-card"><div class="section-eyebrow">AI-GENERATED MEETING TITLE</div><h2>${esc(ai.generatedTitle||m.title||'Untitled meeting')}</h2><p>Created from the actual discussion so your meeting history is easier to scan.</p></div>
      <div class="section-card"><h3>Executive summary</h3><div class="summary-text">${esc(ai.summary||'AI summary is not available yet. Use Retry analysis if Gemini is configured.')}</div></div>
      <div class="section-card"><h3>Detailed summary</h3><div class="long-summary">${esc(ai.detailedSummary||ai.summary||'No detailed summary available yet.').replace(/\n\s*\n/g,'</p><p>').replace(/^/,'<p>').replace(/$/,'</p>')}</div></div>
      <div class="section-card"><h3>Discussion breakdown</h3>${discussion.length?`<div class="table-wrap"><table class="ai-table"><thead><tr><th>Topic</th><th>What was discussed</th><th>Outcome</th></tr></thead><tbody>${discussion.map(x=>`<tr><td><strong>${esc(x.topic)}</strong></td><td>${esc(x.details)}</td><td>${esc(x.outcome||'Not specified')}</td></tr>`).join('')}</tbody></table></div>`:'<p>No detailed discussion breakdown was identified.</p>'}</div>
      <div class="section-card"><h3>Key points</h3>${listHtml(ai.keyPoints)}</div>
      <div class="section-card"><h3>Decisions</h3>${decisionDetails.length?`<div class="table-wrap"><table class="ai-table"><thead><tr><th>Decision</th><th>Rationale / context</th></tr></thead><tbody>${decisionDetails.map(x=>`<tr><td><strong>${esc(x.decision)}</strong></td><td>${esc(x.rationale||'Not specified')}</td></tr>`).join('')}</tbody></table></div>`:listHtml(ai.decisions)}</div>
      <div class="section-card"><h3>Action items</h3>${(ai.actionItems||[]).length?`<div class="table-wrap"><table class="ai-table"><thead><tr><th>Status</th><th>Task</th><th>Owner</th><th>Deadline</th></tr></thead><tbody>${ai.actionItems.map(a=>`<tr><td>${a.completed?'✓ Complete':'☐ Open'}</td><td><strong>${esc(a.task)}</strong></td><td>${esc(a.owner||'Not specified')}</td><td>${esc(a.deadline||'Not specified')}</td></tr>`).join('')}</tbody></table></div>`:'<p>No action items identified.</p>'}</div>
      <div class="section-card"><h3>Conflicts &amp; differing viewpoints</h3>${conflicts.length?`<div class="table-wrap"><table class="ai-table conflict-table"><thead><tr><th>Topic</th><th>Perspectives</th><th>Impact</th><th>Resolution</th><th>Status</th></tr></thead><tbody>${conflicts.map(x=>`<tr><td><strong>${esc(x.topic)}</strong></td><td>${esc(x.perspectives)}</td><td>${esc(x.impact)}</td><td>${esc(x.resolution||'Not resolved')}</td><td><span class="status-pill">${esc(x.status||'Open')}</span></td></tr>`).join('')}</tbody></table></div>`:'<div class="empty-inline">No explicit conflicts or competing viewpoints were identified in the transcript.</div>'}</div>
      <div class="section-card"><h3>Open questions</h3>${listHtml(questions)}</div>
      <div class="section-card"><h3>Topics</h3><div class="chips">${(ai.topics||[]).map(x=>`<span class="chip"># ${esc(x)}</span>`).join('')||'<span class="chip">No topics yet</span>'}</div></div>
      <div class="section-card"><h3>Risks / blockers</h3>${listHtml(ai.risks)}</div>
      <div class="section-card"><h3>Follow-ups</h3>${listHtml(ai.followUps)}</div>
      ${ai.error?`<div class="section-card"><h3>AI processing</h3><p>${esc(ai.error)}</p><button id="retryAi" class="primary-btn">Retry analysis</button></div>`:''}`;
    $('retryAi')?.addEventListener('click', retryAnalysis);
  } else if(activeTab==='transcript') renderTranscript();
  else if(activeTab==='chat') renderChat();
  else renderNotes();
}
function listHtml(items=[]) { return items.length?`<ul class="bullet-list">${items.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`:'<p>No items identified.</p>'; }
function renderTranscript() {
  const raw=String(activeMeeting.fullTranscript||'').trim();
  const lines=raw?raw.split(/\n+/).filter(Boolean):[];
  $('detailContent').innerHTML=`<div class="transcript"><div class="transcript-search"><input id="transcriptSearch" placeholder="Search in transcript…"></div><div id="transcriptLines">${lines.length?lines.map((line,i)=>`<div class="line"><time>${String(Math.floor(i/60)).padStart(2,'0')}:${String(i%60).padStart(2,'0')}</time><span class="speaker">Speaker</span><span class="text">${esc(line)}</span></div>`).join(''):'<div class="state-card">No transcript captured.</div>'}</div></div>`;
  $('transcriptSearch')?.addEventListener('input',e=>{const q=e.target.value.toLowerCase();document.querySelectorAll('.line').forEach(l=>l.classList.toggle('hidden',q&&!l.textContent.toLowerCase().includes(q)));});
}
function renderMarkdownDash(md) {
  if (!md) return '';
  let text = String(md).replace(/\r\n/g, '\n');
  const codeBlocks = [];
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, __, code) => {
    const i = codeBlocks.length;
    codeBlocks.push(`<pre class="md-code"><code>${esc(code.trimEnd())}</code></pre>`);
    return `\n%%CODEBLOCK${i}%%\n`;
  });
  text = text.replace(/`([^`\n]+)`/g, (_, c) => `<code class="md-inline">${esc(c)}</code>`);
  text = text.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    const cb = trimmed.match(/^%%CODEBLOCK(\d+)%%$/);
    if (cb) { out.push(codeBlocks[Number(cb[1])]); i++; continue; }
    const h = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (h) { out.push(`<h${h[1].length} class="md-h${h[1].length}">${h[2]}</h${h[1].length}>`); i++; continue; }
    if (/^[-*]\s+\[[ xX]\]\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length && /^[-*]\s+\[[ xX]\]\s+/.test(lines[i].trim())) {
        const m = lines[i].trim().match(/^[-*]\s+\[([ xX])\]\s+(.+)$/);
        if (m) items.push(`<li class="md-task ${m[1].toLowerCase()==='x'?'done':''}"><span class="md-check">${m[1].toLowerCase()==='x'?'☑':'☐'}</span><span class="md-task-text">${m[2]}</span></li>`);
        i++;
      }
      out.push(`<ul class="md-task-list">${items.join('')}</ul>`); continue;
    }
    if (/^[-*•]\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length && /^[-*•]\s+/.test(lines[i].trim())) { items.push(`<li>${lines[i].trim().replace(/^[-*•]\s+/, '')}</li>`); i++; }
      out.push(`<ul class="md-ul">${items.join('')}</ul>`); continue;
    }
    if (/^\d+[.)]\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) { items.push(`<li>${lines[i].trim().replace(/^\d+[.)]\s+/, '')}</li>`); i++; }
      out.push(`<ol class="md-ol">${items.join('')}</ol>`); continue;
    }
    if (/^>\s?/.test(trimmed)) {
      const parts = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) { parts.push(lines[i].trim().replace(/^>\s?/, '')); i++; }
      out.push(`<blockquote class="md-quote">${parts.join(' ')}</blockquote>`); continue;
    }
    if (/^[🔵🟢🔴🟡]\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length && /^[🔵🟢🔴🟡]\s+/.test(lines[i].trim())) {
        const m = lines[i].trim().match(/^([🔵🟢🔴🟡])\s+(.+)$/);
        if (m) items.push(`<div class="md-decision"><span class="md-dec-icon">${m[1]}</span><div class="md-dec-body">${m[2]}</div></div>`);
        i++;
      }
      out.push(`<div class="md-decisions">${items.join('')}</div>`); continue;
    }
    if (!trimmed) { i++; continue; }
    const buf = [];
    while (i < lines.length) {
      const t = lines[i].trim();
      if (!t || /^(#{1,3})\s+/.test(t) || /^[-*•]\s+/.test(t) || /^\d+[.)]\s+/.test(t) || /^>\s?/.test(t) || /^%%CODEBLOCK/.test(t) || /^[🔵🟢🔴🟡]\s+/.test(t)) break;
      buf.push(t); i++;
    }
    if (buf.length) out.push(`<p>${buf.join(' ')}</p>`);
  }
  return out.join('\n');
}

function buildAiCardDash(markdown, { question = '', promptId = null, isError = false } = {}) {
  const body = isError ? `<p class="ai-error-text">${esc(markdown)}</p>` : renderMarkdownDash(markdown);
  return `<article class="ai-card ${isError ? 'ai-card-error' : ''}" data-raw="${esc(markdown)}">
    <header class="ai-card-header">
      <div class="ai-card-title"><span class="ai-card-icon">✦</span><span>AI Answer</span><span class="ai-context-badge">Transcript · AI Summary</span></div>
      <div class="ai-card-actions">
        <button type="button" class="ai-action-btn ai-copy">Copy</button>
        <button type="button" class="ai-action-btn ai-regen" data-q="${esc(question)}" data-prompt-id="${esc(promptId || '')}">Regenerate</button>
      </div>
    </header>
    <div class="ai-card-body md-content">${body}</div>
  </article>`;
}

function renderChat() {
  $('detailContent').innerHTML = `<div class="chat">
    <div class="prompt-gallery">
      <h3 class="prompt-gallery-title">✦ What will you create today?</h3>
      <p class="chat-intro muted">Answers use only this meeting’s transcript and summary.</p>
      <div class="prompt-grid">
        <button type="button" class="prompt-card" data-prompt-id="short_summary"><span class="prompt-card-icon">✦</span><span class="prompt-card-label">Short summary</span></button>
        <button type="button" class="prompt-card" data-prompt-id="detailed_summary"><span class="prompt-card-icon">✦</span><span class="prompt-card-label">Detailed summary</span></button>
        <button type="button" class="prompt-card" data-prompt-id="detailed_with_citations"><span class="prompt-card-icon">✦</span><span class="prompt-card-label">Detailed summary with citation</span></button>
        <button type="button" class="prompt-card" data-prompt-id="summary_and_actions"><span class="prompt-card-icon">📋</span><span class="prompt-card-label">Summary and Action items</span></button>
        <button type="button" class="prompt-card" data-prompt-id="team_sync"><span class="prompt-card-icon">👥</span><span class="prompt-card-label">Team Sync – Project Updates</span></button>
        <button type="button" class="prompt-card" data-prompt-id="smart_advice"><span class="prompt-card-icon">💡</span><span class="prompt-card-label">Smart AI Advice</span></button>
        <button type="button" class="prompt-card" data-prompt-id="generate_tasks"><span class="prompt-card-icon">☑</span><span class="prompt-card-label">Generate tasks</span></button>
        <button type="button" class="prompt-card" data-prompt-id="prepare_slides"><span class="prompt-card-icon">▶</span><span class="prompt-card-label">Prepare slides</span></button>
        <button type="button" class="prompt-card" data-prompt-id="key_decisions"><span class="prompt-card-icon">🔵</span><span class="prompt-card-label">Key decisions</span></button>
        <button type="button" class="prompt-card" data-prompt-id="next_steps"><span class="prompt-card-icon">→</span><span class="prompt-card-label">Next steps</span></button>
      </div>
    </div>
    <div id="chatHistory" class="chat-history"></div>
    <div class="chat-form"><input id="chatInput" placeholder="Ask about this meeting…"><button id="chatSend" class="primary-btn">Ask AI</button></div>
  </div>`;
  $('chatSend').addEventListener('click', () => sendChat());
  $('chatInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
  document.querySelectorAll('.prompt-card').forEach(btn => {
    btn.addEventListener('click', () => {
      const promptId = btn.getAttribute('data-prompt-id');
      const label = btn.querySelector('.prompt-card-label')?.textContent?.trim() || promptId;
      sendChat({ promptId, label });
    });
  });
  const history = $('chatHistory');
  history.addEventListener('click', async e => {
    const copyBtn = e.target.closest('.ai-copy');
    if (copyBtn) {
      const card = copyBtn.closest('.ai-card');
      const raw = card?.getAttribute('data-raw') || card?.querySelector('.ai-card-body')?.innerText || '';
      try { await navigator.clipboard.writeText(raw); copyBtn.textContent = 'Copied'; setTimeout(() => copyBtn.textContent = 'Copy', 1200); } catch {}
      return;
    }
    const regenBtn = e.target.closest('.ai-regen');
    if (regenBtn) {
      const q = regenBtn.getAttribute('data-q');
      const pid = regenBtn.getAttribute('data-prompt-id');
      if (pid) sendChat({ promptId: pid, label: q });
      else if (q) { $('chatInput').value = q; sendChat(); }
    }
  });
}

async function sendChat(opts = {}) {
  const input = $('chatInput');
  const promptId = opts.promptId || null;
  const label = opts.label || '';
  const q = promptId ? (label || promptId) : (input?.value || '').trim();
  if (!promptId && !q) return;
  const history = $('chatHistory');
  history.insertAdjacentHTML('beforeend', `<div class="bubble user">${esc(q)}</div>`);
  history.insertAdjacentHTML('beforeend', `<article class="ai-card ai-thinking"><header class="ai-card-header"><div class="ai-card-title"><span class="ai-card-icon">✦</span><span>AI Answer</span></div></header><div class="ai-card-body"><div class="ai-thinking-row"><span class="ai-dots"><i></i><i></i><i></i></span><span>Thinking…</span></div></div></article>`);
  const pending = history.lastElementChild;
  if (input) input.value = '';
  history.scrollTop = history.scrollHeight;
  try {
    const body = promptId ? { userId, promptId, question: q } : { userId, question: q };
    const data = await api(`/api/meetings/${encodeURIComponent(activeMeeting.externalId)}/chat`, {
      method: 'POST',
      body: JSON.stringify(body)
    });
    pending.outerHTML = buildAiCardDash(data.answer || 'No answer.', { question: q, promptId: data.promptId || promptId });
  } catch (error) {
    pending.outerHTML = buildAiCardDash(error.message, { question: q, promptId, isError: true });
  }
  history.scrollTop = history.scrollHeight;
}
function renderNotes(){ $('detailContent').innerHTML=`<div class="section-card"><h3>Private notes</h3><textarea id="notes" class="notes" placeholder="Add your notes…">${esc(activeMeeting.notes||'')}</textarea><div style="margin-top:10px"><button id="saveNotes" class="primary-btn">Save notes</button></div></div>`; $('saveNotes').addEventListener('click',async()=>{try{const data=await api(`/api/meetings/${encodeURIComponent(activeMeeting.externalId)}`,{method:'PATCH',body:JSON.stringify({userId,notes:$('notes').value})});activeMeeting=data.meeting;toast('Notes saved.');}catch(error){toast(error.message);}}); }
async function retryAnalysis(){try{const data=await api(`/api/meetings/${encodeURIComponent(activeMeeting.externalId)}/analyze`,{method:'POST',body:JSON.stringify({userId})});activeMeeting=data.meeting;renderTab();toast('AI summary updated.');}catch(error){toast(error.message);}}
function pdfSafe(value='') {
  return String(value ?? '')
    .replace(/\r/g, '')
    .replace(/\u2022/g, '-')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2018|\u2019/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/[^\x20-\x7E\n\t]/g, '?');
}
function pdfEscape(value='') {
  return pdfSafe(value).replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)');
}
function createStructuredPdf(documentModel) {
  const W=595, H=842, M=42, bottom=42;
  const font='Helvetica';
  const pages=[];
  let ops=[];
  let y=H-M;
  const pushPage=()=>{ if(ops.length) pages.push(ops.join('\n')); ops=[]; y=H-M; };
  const ensure=need=>{ if(y-need<bottom) pushPage(); };
  const text=(value,size=10,bold=false,indent=0)=>{
    const content=pdfSafe(value);
    const maxWidth=W-M*2-indent;
    const charWidth=size*0.52;
    const maxChars=Math.max(10,Math.floor(maxWidth/charWidth));
    let remaining=content;
    if(!remaining) { ensure(size+4); y-=size+4; return; }
    while(remaining.length>maxChars){
      let cut=remaining.lastIndexOf(' ',maxChars); if(cut<12) cut=maxChars;
      ensure(size+4); ops.push(`BT /${bold?'F2':'F1'} ${size} Tf ${M+indent} ${y} Td (${pdfEscape(remaining.slice(0,cut))}) Tj ET`); y-=size+4;
      remaining=remaining.slice(cut).trimStart();
    }
    ensure(size+4); ops.push(`BT /${bold?'F2':'F1'} ${size} Tf ${M+indent} ${y} Td (${pdfEscape(remaining)}) Tj ET`); y-=size+4;
  };
  const heading=(value,level=2)=>{
    const size=level===1?18:level===2?12:10;
    ensure(size+14); y-=level===1?2:8; text(value,size,true); y-=4;
  };
  const paragraph=(value)=>{ for(const part of pdfSafe(value).split(/\n+/)){ text(part,9,false); y-=2; } };
  const bullet=(value)=>text(`- ${value}`,9,false,8);
  const table=(headers,rows,widths)=>{
    const total=widths.reduce((a,b)=>a+b,0), x0=M;
    const wrap=(value,maxChars)=>{ let s=pdfSafe(value||''); if(!s) return ['']; const out=[]; while(s.length>maxChars){let cut=s.lastIndexOf(' ',maxChars);if(cut<8)cut=maxChars;out.push(s.slice(0,cut));s=s.slice(cut).trimStart();} out.push(s); return out; };
    const drawRow=(cells,isHeader=false)=>{
      const wrapped=cells.map((c,i)=>wrap(c,Math.max(5,Math.floor(widths[i]/(isHeader?4.6:4.8)))));
      const lines=Math.max(...wrapped.map(a=>a.length));
      const rowH=Math.max(18,lines*(isHeader?9:9)+8);
      if(y-rowH<bottom){ pushPage(); }
      let x=x0;
      ops.push(`${isHeader?'0.94':'1'} g`); ops.push(`${x} ${y-rowH} ${total} ${rowH} re f`); ops.push('0 g');
      x=x0;
      for(let i=0;i<widths.length;i++){
        ops.push(`${x} ${y-rowH} ${widths[i]} ${rowH} re S`);
        for(let j=0;j<wrapped[i].length;j++){
          const yy=y-11-j*9;
          ops.push(`BT /${isHeader?'F2':'F1'} ${isHeader?7.5:7.2} Tf ${x+4} ${yy} Td (${pdfEscape(wrapped[i][j])}) Tj ET`);
        }
        x+=widths[i];
      }
      y-=rowH;
    };
    drawRow(headers,true); rows.forEach(r=>drawRow(r,false)); y-=8;
  };
  const section=(title,items)=>{
    heading(title,2);
    if(!items || !items.length) paragraph('None identified.'); else items.forEach(bullet);
  };

  heading(documentModel.title||'Meeting Notes',1);
  if(documentModel.meta) documentModel.meta.forEach(line=>text(line,9));
  y-=8;
  if(documentModel.summary){ heading('Executive Summary'); paragraph(documentModel.summary); }
  if(documentModel.detailedSummary){ heading('Detailed Summary'); paragraph(documentModel.detailedSummary); }
  if(documentModel.discussion?.length){ heading('Discussion Breakdown'); table(['Topic','What was discussed','Outcome'],documentModel.discussion.map(x=>[x.topic,x.details,x.outcome||'Not specified']),[105,300,106]); }
  section('Key Points',documentModel.keyPoints);
  if(documentModel.decisions?.length){ heading('Decisions'); table(['Decision','Rationale / context'],documentModel.decisions.map(x=>[x.decision||x,x.rationale||'Not specified']),[190,321]); }
  if(documentModel.actions?.length){ heading('Action Items'); table(['Status','Task','Owner','Deadline'],documentModel.actions.map(x=>[x.completed?'Complete':'Open',x.task,x.owner||'Not specified',x.deadline||'Not specified']),[52,235,100,124]); }
  if(documentModel.conflicts?.length){ heading('Conflicts & Differing Viewpoints'); table(['Topic','Perspectives','Impact','Resolution','Status'],documentModel.conflicts.map(x=>[x.topic,x.perspectives,x.impact,x.resolution||'Not resolved',x.status||'Open']),[82,150,105,125,49]); }
  section('Open Questions',documentModel.openQuestions);
  section('Topics',documentModel.topics);
  section('Risks / Blockers',documentModel.risks);
  section('Follow-ups',documentModel.followUps);
  if(documentModel.notes){ heading('Personal Notes'); paragraph(documentModel.notes); }
  if(documentModel.transcript){ heading('Full Transcript'); paragraph(documentModel.transcript); }
  if(!ops.length) pushPage(); else pushPage();

  const objects=[]; const add=o=>{objects.push(o);return objects.length;};
  const f1=add(`<< /Type /Font /Subtype /Type1 /BaseFont /${font} /Encoding /WinAnsiEncoding >>`);
  const f2=add(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`);
  const kids=[];
  for(const stream of pages){
    const content=`q\n0.35 w\n${stream}\nQ`;
    const cid=add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent PAGES_REF /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${cid} 0 R >>`));
  }
  const pagesId=add(`<< /Type /Pages /Kids [${kids.map(id=>`${id} 0 R`).join(' ')}] /Count ${kids.length} >>`);
  const catalogId=add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  for(const id of kids) objects[id-1]=objects[id-1].replace('PAGES_REF',`${pagesId} 0 R`);
  let pdf='%PDF-1.4\n'; const offsets=[0];
  objects.forEach((body,i)=>{offsets[i+1]=pdf.length;pdf+=`${i+1} 0 obj\n${body}\nendobj\n`;});
  const xref=pdf.length; pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
  for(let i=1;i<=objects.length;i++) pdf+=`${String(offsets[i]).padStart(10,'0')} 00000 n \n`;
  pdf+=`trailer\n<< /Size ${objects.length+1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Blob([pdf],{type:'application/pdf'});
}
function downloadPdf(blob,filename,message){
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=filename; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),1000); toast(message);
}
function meetingBaseModel(m){
  return { title:m.title||'Meeting Notes', meta:[`Platform: ${m.platform||'Unknown'}`,`Started: ${fmtDate(m.startedAt)}`,`Ended: ${fmtDate(m.endedAt)}`,`Duration: ${fmtDuration(m.duration)}`] };
}
function exportSummaryPdf(){
  const m=activeMeeting; if(!m)return; const ai=m.ai||{}; const model=meetingBaseModel(m);
  model.summary=ai.summary||'No AI summary available.'; model.detailedSummary=ai.detailedSummary||ai.summary||'No detailed summary available.';
  model.discussion=ai.discussionDetails||[]; model.keyPoints=ai.keyPoints||[];
  model.decisions=(ai.decisionDetails||[]).length?ai.decisionDetails:(ai.decisions||[]).map(x=>({decision:x,rationale:'Not specified'}));
  model.actions=ai.actionItems||[]; model.conflicts=ai.conflicts||[]; model.openQuestions=ai.openQuestions||[]; model.topics=ai.topics||[]; model.risks=ai.risks||[]; model.followUps=ai.followUps||[]; model.notes=m.notes||'';
  const filename=`${(m.title||'meeting').replace(/[^a-z0-9]+/gi,'-').replace(/^-|-$/g,'').toLowerCase()||'meeting'}-summary.pdf`;
  downloadPdf(createStructuredPdf(model),filename,'Summary PDF exported.');
}
function exportTranscriptPdf(){
  const m=activeMeeting; if(!m)return; const model=meetingBaseModel(m); model.transcript=m.fullTranscript||'No transcript captured.';
  const filename=`${(m.title||'meeting').replace(/[^a-z0-9]+/gi,'-').replace(/^-|-$/g,'').toLowerCase()||'meeting'}-transcript.pdf`;
  downloadPdf(createStructuredPdf(model),filename,'Transcript PDF exported.');
}
function exportAllPdf(){
  const m=activeMeeting; if(!m)return; const ai=m.ai||{}; const model=meetingBaseModel(m);
  model.summary=ai.summary||'No AI summary available.'; model.detailedSummary=ai.detailedSummary||ai.summary||'No detailed summary available.';
  model.discussion=ai.discussionDetails||[]; model.keyPoints=ai.keyPoints||[];
  model.decisions=(ai.decisionDetails||[]).length?ai.decisionDetails:(ai.decisions||[]).map(x=>({decision:x,rationale:'Not specified'}));
  model.actions=ai.actionItems||[]; model.conflicts=ai.conflicts||[]; model.openQuestions=ai.openQuestions||[]; model.topics=ai.topics||[]; model.risks=ai.risks||[]; model.followUps=ai.followUps||[]; model.notes=m.notes||''; model.transcript=m.fullTranscript||'No transcript captured.';
  const filename=`${(m.title||'meeting').replace(/[^a-z0-9]+/gi,'-').replace(/^-|-$/g,'').toLowerCase()||'meeting'}-all-notes.pdf`;
  downloadPdf(createStructuredPdf(model),filename,'Complete meeting PDF exported.');
}

async function deleteMeeting(){if(!confirm('Delete this meeting and its saved transcript?'))return;try{await api(`/api/meetings/${encodeURIComponent(activeMeeting.externalId)}?userId=${encodeURIComponent(userId)}`,{method:'DELETE'});activeMeeting=null;showList();toast('Meeting deleted.');}catch(error){toast(error.message);}}
async function toggleFavorite(){
  if(!activeMeeting) return;
  try{
    const data=await api(`/api/meetings/${encodeURIComponent(activeMeeting.externalId)}`,{method:'PATCH',body:JSON.stringify({userId,isFavorite:!activeMeeting.isFavorite})});
    activeMeeting=data.meeting||{...activeMeeting,isFavorite:!activeMeeting.isFavorite};
    renderDetail();
    toast(activeMeeting.isFavorite?'Marked favourite.':'Removed from favourites.');
  }catch(error){toast(error.message);}
}
async function toggleArchive(){
  if(!activeMeeting) return;
  try{
    const data=await api(`/api/meetings/${encodeURIComponent(activeMeeting.externalId)}`,{method:'PATCH',body:JSON.stringify({userId,isArchived:!activeMeeting.isArchived})});
    activeMeeting=data.meeting||{...activeMeeting,isArchived:!activeMeeting.isArchived};
    renderDetail();
    toast(activeMeeting.isArchived?'Archived.':'Unarchived.');
  }catch(error){toast(error.message);}
}
function showList(){ $('detailView').classList.add('hidden');$('listView').classList.remove('hidden');loadMeetings();}
$('backBtn').addEventListener('click',showList);
$('refreshBtn').addEventListener('click',loadMeetings);
$('searchInput').addEventListener('input',()=>{clearTimeout(window.searchTimer);window.searchTimer=setTimeout(()=>{meetingsOffset=0;loadMeetings();},250)});
$('sortSelect').addEventListener('change',loadMeetings);
$('openExtension').addEventListener('click',openExtension);
$('startBtn').addEventListener('click',openExtension);
$('exportSummaryBtn').addEventListener('click',exportSummaryPdf);
$('exportTranscriptBtn').addEventListener('click',exportTranscriptPdf);
$('exportAllBtn').addEventListener('click',exportAllPdf);
$('deleteBtn').addEventListener('click',deleteMeeting);
$('favoriteBtn')?.addEventListener('click',toggleFavorite);
$('archiveBtn')?.addEventListener('click',toggleArchive);
document.querySelectorAll('.tab').forEach(t=>t.addEventListener('click',()=>{activeTab=t.dataset.tab;renderTab();}));
document.querySelectorAll('.filter-chip').forEach(chip=>chip.addEventListener('click',()=>{document.querySelectorAll('.filter-chip').forEach(c=>c.classList.toggle('active',c===chip));listViewFilter=chip.dataset.filter||'all';meetingsOffset=0;selectedMeetingIds.clear();loadMeetings();}));
$('advancedFilterBtn')?.addEventListener('click',()=>$('filterPanel').classList.toggle('hidden'));
$('clearFiltersBtn')?.addEventListener('click',()=>{['dateFilter','sourceFilter','statusFilter','aiFilter'].forEach(id=>$(id).value='all');filterState={date:'all',source:'all',status:'all',ai:'all'};meetingsOffset=0;loadMeetings();});
['dateFilter','sourceFilter','statusFilter','aiFilter'].forEach(id=>$(id)?.addEventListener('change',()=>{filterState={date:$('dateFilter').value,source:$('sourceFilter').value,status:$('statusFilter').value,ai:$('aiFilter').value};meetingsOffset=0;loadMeetings();}));
$('clearSelectionBtn')?.addEventListener('click',()=>{selectedMeetingIds.clear();renderMeetings(applyClientFilters(meetings));});
$('loadMoreBtn')?.addEventListener('click',()=>{meetingsOffset += meetingsPageSize;loadMeetings();});
document.querySelectorAll('[data-bulk]').forEach(btn=>btn.addEventListener('click',()=>bulkAction(btn.dataset.bulk)));
document.addEventListener('click',e=>{if(!e.target.closest('.meeting-card'))document.querySelectorAll('.meeting-menu').forEach(m=>m.classList.add('hidden'));});
(async()=>{
  const auth=await getAuth();
  if(!authToken){
    $('meetingList').innerHTML='';
    $('listState').classList.remove('hidden');
    $('listState').innerHTML=`<strong>Sign in required</strong><p>Log in from the extension popup, or open the web app at <a href="${CLIENT}" target="_blank">${CLIENT}</a>.</p>`;
    if($('userIdShort')) $('userIdShort').textContent='guest';
    return;
  }
  if($('userIdShort')) $('userIdShort').textContent=(auth.authUser?.username||userId).toString().slice(0,12);
  const id=params.get('meeting');
  if(id)openMeeting(id);else loadMeetings();
})();
