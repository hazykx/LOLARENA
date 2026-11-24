(() => {
  'use strict';

  const ROLE_LABEL = { TOP: 'Top', JUNGLE: 'Jungle', MID: 'Mid', ADC: 'ADC', SUPPORT: 'Support' };
  const ROLE_SHORT = { TOP: 'TOP', JUNGLE: 'JNG', MID: 'MID', ADC: 'ADC', SUPPORT: 'SUP' };
  const STATUS = {
    in_progress: ['Probíhá', 'yellow'], awaiting_confirm: ['Čeká na potvrzení', 'yellow'],
    disputed: ['Rozporováno', 'red'], finished: ['Dokončeno', 'green'], cancelled: ['Zrušeno', 'gray'],
  };

  const S = {
    me: null, accounts: [], status: null, config: null, queue: null, timeOffset: 0,
    ready: null, draft: null, draftId: null, chat: { all: [], team: [] }, chatTab: 'all', matchId: null,
  };
  const socket = io();
  const app = document.getElementById('app');

  // ─────────── helpery ───────────
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const now = () => Date.now() + S.timeOffset;
  const syncTime = (serverNow) => { if (serverNow) S.timeOffset = serverNow - Date.now(); };
  const fmtDur = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const fmtDate = (ts) => new Date(ts).toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
  const roleTag = (r) => `<span class="role-tag">${ROLE_SHORT[r] || esc(r)}</span>`;
  const sideBadge = (s) => (s ? `<span class="badge ${s === 'BLUE' ? 'blue' : 'red'}">${s}</span>` : '');
  const statusBadge = (s) => `<span class="badge ${STATUS[s]?.[1] || 'gray'}">${STATUS[s]?.[0] || esc(s)}</span>`;

  function avatar(u, size = 28) {
    if (u?.avatar) return `<img class="avatar" src="${esc(u.avatar)}" width="${size}" height="${size}" alt="">`;
    return `<span class="avatar-fallback" style="width:${size}px;height:${size}px">${esc((u?.username || '?')[0].toUpperCase())}</span>`;
  }
  const userLink = (u, size = 24) => `<a class="user-link" href="#/profile/${encodeURIComponent(u.id)}">${avatar(u, size)}<span>${esc(u.username)}</span></a>`;

  async function api(url, opts = {}) {
    const o = { ...opts, headers: { ...(opts.headers || {}) } };
    if (o.body && !(o.body instanceof FormData)) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(o.body); }
    const r = await fetch(url, o);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Chyba serveru');
    return data;
  }
  function emit(ev, data) {
    return new Promise((res) => socket.emit(ev, data, (r) => { if (r?.error) toast(r.error, 'error'); res(r); }));
  }
  function toast(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 4500);
  }
  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.18].forEach((t) => {
        const o = ctx.createOscillator(); const g = ctx.createGain();
        o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
        g.gain.setValueAtTime(0.15, ctx.currentTime + t); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.15);
        o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.16);
      });
    } catch { /* ignore */ }
  }

  async function refreshMe() {
    const d = await api('/api/me');
    S.me = d.user; S.accounts = d.accounts || []; S.status = d.status || null;
    renderNav(); renderBanner();
  }

  // ─────────── router ───────────
  function route() {
    const [name, id] = location.hash.replace(/^#\/?/, '').split('/');
    return { name: name || 'home', id: id ? decodeURIComponent(id) : null };
  }
  function render() {
    const r = route();
    if (S.matchId && !(r.name === 'match' && r.id === String(S.matchId))) { emit('match_leave', { id: S.matchId }); S.matchId = null; }
    if (r.name !== 'draft') S.draftId = null;
    document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === r.name));
    window.scrollTo(0, 0);
    const views = { home: viewHome, draft: viewDraft, match: viewMatch, profile: viewProfile, leaderboard: viewLeaderboard, matches: viewMatches };
    (views[r.name] || viewHome)(r.id);
    renderBanner();
  }
  window.addEventListener('hashchange', render);

  function renderNav() {
    const el = $('#nav-user');
    if (!S.me) { el.innerHTML = '<a class="btn" href="/auth/discord">Přihlásit přes Discord</a>'; return; }
    el.innerHTML = `
      <a class="user-chip" href="#/profile/${encodeURIComponent(S.me.id)}">${avatar(S.me, 30)}<span>${esc(S.me.username)}</span>
        <span class="elo-pill">${S.me.elo}</span></a>
      <button class="btn ghost sm" id="logout">Odhlásit</button>`;
    $('#logout').onclick = async () => { await api('/auth/logout', { method: 'POST' }); location.href = '/'; };
  }

  function renderBanner() {
    const el = $('#banner');
    const r = route();
    const st = S.status;
    let html = '';
    if (st?.draft && !(r.name === 'draft' && r.id === st.draft)) {
      html = `<span>Probíhá tvůj draft.</span><a class="btn sm" href="#/draft/${st.draft}">Otevřít draft</a>`;
    } else if (st?.activeMatch && !(r.name === 'match' && r.id === String(st.activeMatch))) {
      html = `<span>Máš rozehraný zápas <b>#${st.activeMatch}</b>.</span><a class="btn sm" href="#/match/${st.activeMatch}">Otevřít zápas</a>`;
    }
    el.innerHTML = html ? `<div class="bar"><div class="bar-inner">${html}</div></div>` : '';
  }

  // ─────────── HOME / FRONTA ───────────
  function viewHome() {
    if (!S.me) {
      app.innerHTML = `
        <section class="hero">
          <h1>League of Legends <span>INHOUSE</span></h1>
          <p>Připoj se do fronty na svou roli, potvrď hru, nech kapitány vydraftovat týmy a po hře nahraj replay. Elo se počítá automaticky.</p>
          <a class="btn lg" href="/auth/discord">Přihlásit přes Discord</a>
          ${S.config?.devLogin ? `<form id="dev-login" class="row" style="justify-content:center;margin-top:16px">
            <input class="input" name="name" placeholder="Testovací jméno" required><button class="btn ghost">Dev přihlášení</button></form>` : ''}
          <div class="steps">
            <div class="step"><b>1 · Fronta</b><p>Vyber roli. Hraje prvních 10 hráčů – 2 na každou roli.</p></div>
            <div class="step"><b>2 · Accept</b><p>Na přijetí hry máš ${S.config?.timers.readyCheck || 60} sekund.</p></div>
            <div class="step"><b>3 · Draft</b><p>Dva kapitáni ze stejné role si střídavě vybírají spoluhráče.</p></div>
            <div class="step"><b>4 · Výsledek</b><p>Vítěz nahraje .rofl, poražený potvrdí a přepočítá se elo.</p></div>
          </div>
        </section>`;
      const f = $('#dev-login');
      if (f) f.onsubmit = (e) => { e.preventDefault(); location.href = `/auth/dev?name=${encodeURIComponent(f.name.value)}`; };
      return;
    }
    app.innerHTML = '<div id="queue-view"></div><div class="layout-2"><div class="panel" id="queue-list"></div><div class="panel" id="side-panel"></div></div>';
    renderQueue();
    loadSidePanel();
  }

  function renderQueue() {
    const root = $('#queue-view');
    if (!root || !S.queue) return;
    const q = S.queue;
    const mine = q.entries.find((e) => e.user.id === S.me.id);
    const hasMain = S.accounts.some((a) => a.is_main);
    const busy = S.status?.draft || S.status?.readyCheck || S.status?.activeMatch;
    const byRole = Object.fromEntries(S.config.roles.map((r) => [r, q.entries.filter((e) => e.role === r)]));
    const filled = S.config.roles.filter((r) => byRole[r].length >= 2).length;

    const myPos = mine ? byRole[mine.role].findIndex((e) => e.user.id === S.me.id) + 1 : 0;
    root.innerHTML = `
      ${!hasMain ? `<div class="warn"><span>Pro hraní potřebuješ v profilu přidat svůj <b>EUNE</b> účet (hlavní účet, na kterém budeš hrát).</span>
        <a class="btn sm" href="#/profile/${encodeURIComponent(S.me.id)}">Přidat účet</a></div>` : ''}
      <div class="queue-top">
        <div>
          <h1>Fronta</h1>
          <div class="muted" style="margin-top:4px">${q.entries.length} hráčů ve frontě · obsazené role ${filled}/5
            ${q.readyChecks ? ` · <span class="badge yellow">${q.readyChecks}× čeká na accept</span>` : ''}</div>
        </div>
        ${mine ? `<div class="queue-status"><span class="dot"></span>
          <div><b>Hledám hru – ${ROLE_LABEL[mine.role]}</b><div class="small muted">${myPos <= 2 ? 'Jsi mezi prvními dvěma – hraješ, jakmile se obsadí ostatní role.' : `${myPos}. v pořadí na roli`} · <span data-since="${mine.joinedAt}"></span></div></div>
          <button class="btn ghost sm" id="leave">Opustit frontu</button></div>` : ''}
      </div>
      <div class="progress" style="margin-bottom:16px"><div style="width:${Math.min(10, S.config.roles.reduce((s, r) => s + Math.min(2, byRole[r].length), 0)) * 10}%"></div></div>
      <div class="roles">
        ${S.config.roles.map((r) => {
          const list = byRole[r];
          const isMine = mine?.role === r;
          const slots = [0, 1].map((i) => (list[i]
            ? `<div class="slot">${userLink(list[i].user, 22)}<span class="elo">${list[i].user.elo}</span></div>`
            : '<div class="slot empty">volné místo</div>')).join('');
          const waiting = list.slice(2);
          return `<div class="role-card ${isMine ? 'mine' : ''} ${list.length >= 2 ? 'full' : ''}">
            <div class="row between"><span class="role-name">${ROLE_LABEL[r].toUpperCase()}</span><span class="badge gray">${list.length}</span></div>
            ${slots}
            ${waiting.length ? `<div class="waiting-list">${waiting.slice(0, 4).map((e, i) => `<div class="w">${i + 3}. ${esc(e.user.username)}</div>`).join('')}
              ${waiting.length > 4 ? `<div class="w">+ ${waiting.length - 4} dalších</div>` : ''}</div>` : '<div class="waiting">Nikdo nečeká</div>'}
            <div style="margin-top:auto">${isMine
              ? '<button class="btn ghost" style="width:100%" data-leave>Opustit</button>'
              : `<button class="btn" style="width:100%" data-join="${r}" ${!hasMain || busy ? 'disabled' : ''}>${mine ? 'Přepnout sem' : 'Připojit'}</button>`}</div>
          </div>`;
        }).join('')}
      </div>`;
    root.querySelectorAll('[data-join]').forEach((b) => { b.onclick = () => emit('queue_join', { role: b.dataset.join }).then(refreshMe); });
    root.querySelectorAll('[data-leave], #leave').forEach((b) => { b.onclick = () => emit('queue_leave').then(refreshMe); });

    const list = $('#queue-list');
    list.innerHTML = `<div class="panel-head"><h2>Pořadí ve frontě</h2><span class="muted small">kdo dřív přijde, ten hraje</span></div>
      ${q.entries.length ? `<div class="list">${q.entries.map((e, i) => `<div class="list-row">
        <span class="muted" style="width:22px">${i + 1}.</span>${roleTag(e.role)}${userLink(e.user)}
        <span class="muted small" style="margin-left:auto">${e.user.elo} elo · <span data-since="${e.joinedAt}"></span></span></div>`).join('')}</div>`
        : '<div class="empty-state">Fronta je prázdná. Buď první!</div>'}`;
    tick();
  }

  async function loadSidePanel() {
    const el = $('#side-panel');
    if (!el) return;
    const drafts = S.queue?.drafts || [];
    let matches = { active: [] };
    try { matches = await api('/api/matches'); } catch { /* ignore */ }
    if (!$('#side-panel')) return;
    el.innerHTML = `
      <div class="panel-head"><h2>Právě se hraje</h2></div>
      ${drafts.map((d) => `<a class="list-row" href="#/draft/${d.id}"><span class="badge">DRAFT</span>
        <span>${esc(d.captains[0].username)} vs ${esc(d.captains[1].username)}</span></a>`).join('')}
      ${matches.active.map((m) => `<a class="list-row" href="#/match/${m.id}"><b>#${m.id}</b>${statusBadge(m.status)}
        <span class="muted small" style="margin-left:auto">${fmtDate(m.created_at)}</span></a>`).join('')}
      ${!drafts.length && !matches.active.length ? '<div class="empty-state">Žádná hra neprobíhá.</div>' : ''}`;
  }

  // ─────────── READY CHECK ───────────
  function renderReady() {
    const root = $('#modal-root');
    const rc = S.ready;
    if (!rc) { root.innerHTML = ''; document.title = 'INHOUSE'; return; }
    const total = S.config.timers.readyCheck * 1000;
    root.innerHTML = `<div class="overlay"><div class="ready-box">
      <h3>${ROLE_LABEL[rc.role] || ''}</h3>
      <h2 style="margin-top:8px">HRA NALEZENA</h2>
      <div class="ready-timer" data-deadline="${rc.deadline}" data-total="${total}"><span class="t"></span></div>
      <div class="progress" data-deadline="${rc.deadline}" data-total="${total}"><div class="bar"></div></div>
      <div class="pips">${Array.from({ length: rc.total }, (_, i) => `<span class="pip ${i < rc.accepted ? 'on' : ''}"></span>`).join('')}</div>
      ${rc.you ? `<div class="muted">Přijato ✓ Čekáme na ostatní (${rc.accepted}/${rc.total})</div>`
        : `<div class="ready-actions"><button class="btn lg" id="rc-accept">ACCEPT</button><button class="btn danger lg" id="rc-decline">Odmítnout</button></div>`}
    </div></div>`;
    document.title = '🔔 HRA NALEZENA – INHOUSE';
    const a = $('#rc-accept'); const d = $('#rc-decline');
    if (a) a.onclick = () => emit('ready_respond', { id: rc.id, accept: true });
    if (d) d.onclick = () => emit('ready_respond', { id: rc.id, accept: false });
    tick();
  }

  // ─────────── DRAFT ───────────
  function viewDraft(id) {
    S.draftId = id; S.draft = null; S.chat = { all: [], team: [] };
    app.innerHTML = `<div class="draft-layout">
      <div class="panel" id="draft-board"><div class="empty-state">Načítám draft…</div></div>
      <aside class="panel chat">
        <div class="chat-tabs"><button data-tab="all">Všichni</button><button data-tab="team">Tým</button></div>
        <div class="chat-msgs" id="chat-msgs"></div>
        <form class="chat-form" id="chat-form"><input class="input" name="text" maxlength="300" autocomplete="off" placeholder="Napiš zprávu…"><button class="btn">Odeslat</button></form>
      </aside></div>`;
    app.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => { S.chatTab = b.dataset.tab; renderChat(); }; });
    $('#chat-form').onsubmit = (e) => {
      e.preventDefault();
      const input = e.target.text;
      if (!input.value.trim()) return;
      emit('draft_chat', { id, channel: S.chatTab, text: input.value });
      input.value = '';
    };
    emit('draft_join', { id }).then((r) => {
      if (!r?.state) { $('#draft-board').innerHTML = `<div class="empty-state">${esc(r?.error || 'Draft nenalezen.')}</div>`; return; }
      syncTime(r.state.serverNow);
      S.draft = r.state; S.chat = r.chat;
      renderDraft(); renderChat();
      if (r.state.matchId) location.hash = `#/match/${r.state.matchId}`;
    });
  }

  function myDraftTeam() {
    const d = S.draft;
    if (!d || !S.me) return null;
    if (d.teams.A.some((p) => p.userId === S.me.id)) return 'A';
    if (d.teams.B.some((p) => p.userId === S.me.id)) return 'B';
    return null;
  }

  function renderDraft() {
    const d = S.draft;
    const board = $('#draft-board');
    if (!d || !board) return;
    const actorCap = d.captains[d.actor];
    const iAmActor = S.me && actorCap.id === S.me.id && d.phase !== 'done';
    const capName = `<em>${esc(actorCap.username)}</em>`;
    const phaseText = {
      choice: `${capName} volí: první výběr hráče, nebo výběr strany`,
      side: `${capName} volí stranu`,
      pick: `Kolo ${d.round + 1}/${d.totalRounds} – vybírá ${capName}`,
      done: 'Draft dokončen ✓',
    }[d.phase];
    const total = S.config.timers.draftPick * 1000;

    const teamHtml = (t) => {
      const side = d.side[t];
      const members = d.teams[t];
      const missing = d.totalRounds + 1 - members.length;
      return `<div class="team ${side ? `side-${side}` : ''} ${d.actor === t && d.phase !== 'done' ? 'active' : ''}">
        <div class="team-title"><span>Tým ${esc(d.captains[t].username)}</span>${sideBadge(side) || '<span class="badge gray">strana ?</span>'}</div>
        ${members.map((p) => `<div class="member">${roleTag(p.role)}${userLink(p.user)}
          <span class="note">${p.captain ? '👑 kapitán' : p.picked ? `pick ${p.round}` : 'dostal'}</span></div>`).join('')}
        ${Array.from({ length: Math.max(0, missing) }, () => '<div class="member empty">čeká na výběr</div>').join('')}
      </div>`;
    };

    let action = '';
    if (iAmActor && d.phase === 'choice') {
      action = `<div class="choice-box"><b>Jsi na tahu – vyber si výhodu</b>
        <div class="muted small" style="margin-top:4px">Když vezmeš první výběr hráče, soupeř si volí stranu. Když vezmeš stranu, soupeř vybírá prvního hráče.</div>
        <div class="row"><button class="btn lg" data-act="choice" data-value="pick">A) Volba prvního hráče</button>
        <button class="btn ghost lg" data-act="choice" data-value="side">B) Volba ingame strany</button></div></div>`;
    } else if (iAmActor && d.phase === 'side') {
      action = `<div class="choice-box"><b>Vyber si stranu</b>
        <div class="row"><button class="btn blue lg" data-act="side" data-value="BLUE">BLUE</button>
        <button class="btn red lg" data-act="side" data-value="RED">RED</button></div></div>`;
    } else if (iAmActor && d.phase === 'pick') {
      action = '<div class="choice-box" style="padding:12px"><b>Vyber hráče</b> – druhý hráč ze stejné role připadne soupeři.</div>';
    }

    const pool = Object.entries(d.pool);
    board.innerHTML = `
      <div class="draft-head">
        <div><h3>Draft · kapitáni z role ${ROLE_LABEL[d.captainRole]}</h3><div class="draft-phase" style="margin-top:6px">${phaseText}</div></div>
        ${d.phase !== 'done' ? `<div class="timer-big" data-deadline="${d.deadline}" data-total="${total}"><span class="t"></span></div>` : ''}
      </div>
      ${d.phase !== 'done' ? `<div class="progress" data-deadline="${d.deadline}" data-total="${total}"><div class="bar"></div></div>` : ''}
      ${action}
      <div class="teams">${teamHtml('A')}${teamHtml('B')}</div>
      ${pool.length ? `<div class="pool"><h3 style="margin-top:8px">K výběru</h3>
        ${pool.map(([role, players]) => `<div class="pool-role">${roleTag(role)}
          ${players.map((u) => `<button class="pick-card ${iAmActor && d.phase === 'pick' ? 'can' : ''}" ${iAmActor && d.phase === 'pick' ? `data-pick="${esc(u.id)}"` : 'disabled'}>
            ${avatar(u, 26)}<span>${esc(u.username)}</span><span class="elo">${u.elo}</span></button>`).join('')}
        </div>`).join('')}</div>` : ''}
      ${d.matchId ? `<div class="choice-box"><b>Zápas je připraven!</b><div class="row"><a class="btn lg" href="#/match/${d.matchId}">Přejít na zápas #${d.matchId}</a></div></div>` : ''}
      <div class="log">${d.log.slice().reverse().map((l) => `<div>${new Date(l.ts).toLocaleTimeString('cs-CZ')} · ${esc(l.text)}</div>`).join('')}</div>`;

    board.querySelectorAll('[data-act]').forEach((b) => {
      b.onclick = () => emit('draft_action', { id: d.id, value: b.dataset.value });
    });
    board.querySelectorAll('[data-pick]').forEach((b) => {
      b.onclick = () => emit('draft_action', { id: d.id, userId: b.dataset.pick });
    });
    renderChatTabs();
    tick();
  }

  function renderChatTabs() {
    const team = myDraftTeam();
    const isPlayer = S.draft && S.me && S.draft.participants.includes(S.me.id);
    if (S.chatTab === 'team' && !team) S.chatTab = 'all';
    app.querySelectorAll('[data-tab]').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === S.chatTab);
      if (b.dataset.tab === 'team') { b.disabled = !team; b.textContent = team ? `Tým ${S.draft.captains[team].username}` : 'Tým'; }
    });
    const input = $('#chat-form input');
    if (input) { input.disabled = !isPlayer; input.placeholder = isPlayer ? 'Napiš zprávu…' : 'Chatovat mohou jen hráči této hry'; }
  }

  function renderChat() {
    const box = $('#chat-msgs');
    if (!box) return;
    renderChatTabs();
    const msgs = S.chatTab === 'team' ? S.chat.team : S.chat.all;
    box.innerHTML = msgs.length ? msgs.map((m) => `<div class="msg"><span class="time">${new Date(m.ts).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' })}</span><span class="who">${esc(m.user.username)}</span>${esc(m.text)}</div>`).join('')
      : `<div class="empty-state small">${S.chatTab === 'team' ? 'Týmový chat – vidí jen tvůj tým.' : 'Chat pro všech 10 hráčů.'}</div>`;
    box.scrollTop = box.scrollHeight;
  }

  // ─────────── ZÁPAS ───────────
  async function viewMatch(id) {
    S.matchId = id;
    emit('match_join', { id });
    let data;
    try { data = await api(`/api/matches/${id}`); } catch (e) { app.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; return; }
    if (S.matchId !== id) return;
    const { match: m, players, viewer: v } = data;
    const team = (side) => players.filter((p) => p.team === side);
    const done = m.status === 'finished';
    const pending = m.pending;

    const teamTable = (side) => `<div class="team side-${side}">
      <div class="team-title"><span>Tým ${side}</span>${done ? (m.winner === side ? '<span class="badge green">VÝHRA</span>' : '<span class="badge gray">PROHRA</span>') : sideBadge(side)}</div>
      <table><thead><tr><th>Hráč</th>${done ? '<th>Champion</th><th class="num">KDA</th><th class="num">CS</th><th class="num">Dmg</th><th class="num">Elo</th>' : '<th class="num">Elo</th>'}</tr></thead>
      <tbody>${team(side).map((p) => `<tr>
        <td><div class="row">${roleTag(p.role)}${userLink({ id: p.user_id, username: p.username, avatar: p.avatar })}${p.is_captain ? ' 👑' : ''}</div>
          <div class="small muted" style="margin:3px 0 0 48px">${esc(p.riot_id || '')}</div></td>
        ${done ? `<td>${esc(p.champion || '–')}</td><td class="num">${p.kills ?? '–'}/${p.deaths ?? '–'}/${p.assists ?? '–'}</td>
          <td class="num">${p.cs ?? '–'}</td><td class="num">${p.damage != null ? p.damage.toLocaleString('cs-CZ') : '–'}</td>
          <td class="num">${p.elo_after}<span class="${p.elo_after >= p.elo_before ? 'plus' : 'minus'}"> ${p.elo_after >= p.elo_before ? '+' : ''}${p.elo_after - p.elo_before}</span></td>`
          : `<td class="num">${p.current_elo}</td>`}
      </tr>`).join('')}</tbody></table></div>`;

    let lobby = '';
    if (m.lobby) {
      const myVoice = m.voice && (v.myTeam ? m.voice[v.myTeam] : null);
      lobby = `<div class="panel"><div class="panel-head"><h2>Lobby</h2>${v.myTeam ? `<span>Hraješ za ${sideBadge(v.myTeam)}</span>` : ''}</div>
        <div class="lobby">
          <div class="field"><div><label>Název hry</label><strong>${esc(m.lobby.name)}</strong></div><button class="btn ghost sm" data-copy="${esc(m.lobby.name)}">Kopírovat</button></div>
          <div class="field"><div><label>Heslo</label><strong>${esc(m.lobby.password)}</strong></div><button class="btn ghost sm" data-copy="${esc(m.lobby.password)}">Kopírovat</button></div>
          ${myVoice ? `<a class="btn lg" href="${esc(myVoice.invite)}" target="_blank" rel="noopener">🎧 Připojit do voice</a>`
            : m.voice && v.isAdmin ? Object.entries(m.voice).map(([s, x]) => `<a class="btn ghost" href="${esc(x.invite)}" target="_blank">${s} voice</a>`).join('')
            : '<div class="field muted small">Voice kanál zatím není (bot není připojen).</div>'}
        </div>
        <div class="small muted" style="margin-top:10px">Lobby zakládá kapitán BLUE týmu: Play → Create Custom → Summoner's Rift, Tournament Draft, zadej název a heslo.</div>
      </div>`;
    }

    let result = '';
    if (done) {
      result = `<div class="winner-banner ${m.winner}">🏆 Vyhrál tým ${m.winner}${m.duration ? ` · ${fmtDur(m.duration * 1000)}` : ''}</div>`;
    } else if (m.status === 'cancelled') {
      result = '<div class="panel empty-state">Zápas byl zrušen adminem. Elo se nezměnilo.</div>';
    } else if (m.status === 'awaiting_confirm' && pending) {
      const loserName = players.find((p) => p.user_id === m.loserCaptain)?.username || 'kapitán poraženého týmu';
      result = `<div class="panel"><div class="panel-head"><h2>Nahraný výsledek</h2>${statusBadge(m.status)}</div>
        <div class="winner-banner ${pending.winner}">Podle replaye vyhrál ${pending.winner}${pending.duration ? ` · ${fmtDur(pending.duration * 1000)}` : ''}</div>
        <table style="margin-top:12px"><thead><tr><th>Hráč</th><th>Strana</th><th>Champion</th><th class="num">KDA</th><th class="num">CS</th><th class="num">Dmg</th></tr></thead><tbody>
        ${players.map((p) => { const s = pending.stats[p.user_id] || {}; return `<tr><td>${esc(p.username)}</td><td>${sideBadge(p.team)}</td><td>${esc(s.champion)}</td>
          <td class="num">${s.kills}/${s.deaths}/${s.assists}</td><td class="num">${s.cs}</td><td class="num">${(s.damage || 0).toLocaleString('cs-CZ')}</td></tr>`; }).join('')}
        </tbody></table>
        <div class="divider"></div>
        ${v.canConfirm ? `<div class="row"><button class="btn lg" id="confirm">Potvrdit výsledek</button><button class="btn danger" id="dispute">Rozporovat</button>
          <span class="muted small">Po potvrzení se zapíšou statistiky, přepočítá elo a smažou voice roomky.</span></div>`
          : `<div class="muted">Čeká se na potvrzení – ${esc(loserName)}.</div>`}
      </div>`;
    } else if (m.status === 'disputed') {
      result = `<div class="panel"><div class="panel-head"><h2>Výsledek je rozporován</h2>${statusBadge(m.status)}</div>
        <div class="muted">Kapitán poraženého týmu výsledek nepotvrdil. Rozhodne admin, nebo může kapitán nahrát správný replay.</div>
        ${v.isAdmin && pending ? `<div class="row" style="margin-top:12px"><button class="btn" id="confirm">Admin: potvrdit (vítěz ${pending.winner})</button></div>` : ''}
      </div>`;
    }

    let uploadBox = '';
    if (v.canUpload) {
      uploadBox = `<div class="panel"><div class="panel-head"><h2>Nahrát výsledek</h2><span class="muted small">kapitán vítězného týmu</span></div>
        <label class="drop" id="drop"><input type="file" accept=".rofl" id="rofl" hidden>
          <div><b>Přetáhni sem .rofl soubor</b> nebo klikni a vyber</div>
          <div class="small muted" style="margin-top:6px">Replay stáhneš v klientu: Profil → Match History → zápas → ikona stažení. Najdeš ho v Dokumenty/League of Legends/Replays.</div>
        </label><div id="upload-status" class="small muted" style="margin-top:8px"></div></div>`;
    }

    app.innerHTML = `
      <div class="match-head">
        <div class="row"><h1>Zápas #${m.id}</h1>${statusBadge(m.status)}</div>
        <div class="row muted small">${fmtDate(m.created_at)} · kapitáni z role ${ROLE_LABEL[m.captainRole] || ''}
          ${v.isAdmin && !['finished', 'cancelled'].includes(m.status) ? '<button class="btn danger sm" id="cancel">Admin: zrušit zápas</button>' : ''}</div>
      </div>
      <div class="stack">
        ${result}${lobby}
        <div class="teams" style="margin-top:0">${teamTable('BLUE')}${teamTable('RED')}</div>
        ${uploadBox}
        ${m.draftLog.length ? `<details class="panel"><summary class="muted" style="cursor:pointer">Průběh draftu</summary>
          <div class="log">${m.draftLog.map((l) => `<div>${esc(l.text)}</div>`).join('')}</div></details>` : ''}
      </div>`;

    app.querySelectorAll('[data-copy]').forEach((b) => {
      b.onclick = () => navigator.clipboard.writeText(b.dataset.copy).then(() => toast('Zkopírováno', 'success'));
    });
    const act = (url, msg) => async () => {
      try { await api(url, { method: 'POST' }); toast(msg, 'success'); refreshMe(); viewMatch(id); } catch (e) { toast(e.message, 'error'); }
    };
    if ($('#confirm')) $('#confirm').onclick = act(`/api/matches/${id}/confirm`, 'Výsledek potvrzen, elo přepočítáno.');
    if ($('#dispute')) $('#dispute').onclick = () => { if (confirm('Opravdu rozporovat výsledek? Rozhodne admin.')) act(`/api/matches/${id}/dispute`, 'Výsledek rozporován.')(); };
    if ($('#cancel')) $('#cancel').onclick = () => { if (confirm('Zrušit zápas bez změny ela?')) act(`/api/matches/${id}/cancel`, 'Zápas zrušen.')(); };

    const drop = $('#drop');
    if (drop) {
      const send = async (file) => {
        if (!file) return;
        if (!file.name.toLowerCase().endsWith('.rofl')) { toast('Vyber soubor .rofl', 'error'); return; }
        const st = $('#upload-status');
        st.textContent = `Nahrávám ${file.name} (${(file.size / 1048576).toFixed(1)} MB)…`;
        const fd = new FormData(); fd.append('rofl', file);
        try {
          const r = await api(`/api/matches/${id}/result`, { method: 'POST', body: fd });
          toast(`Výsledek nahrán (vítěz ${r.winner}). Čeká na potvrzení soupeřem.`, 'success');
          viewMatch(id);
        } catch (e) { st.textContent = ''; toast(e.message, 'error'); }
      };
      $('#rofl').onchange = (e) => send(e.target.files[0]);
      drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
      drop.ondragleave = () => drop.classList.remove('over');
      drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); send(e.dataTransfer.files[0]); };
    }
  }

  // ─────────── PROFIL ───────────
  async function viewProfile(id) {
    if (!id) { location.hash = S.me ? `#/profile/${encodeURIComponent(S.me.id)}` : '#/'; return; }
    let d;
    try { d = await api(`/api/users/${encodeURIComponent(id)}`); } catch (e) { app.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; return; }
    const u = d.user; const s = d.stats;
    const games = u.wins + u.losses;
    const kda = s.games ? ((s.kills + s.assists) / Math.max(1, s.deaths)).toFixed(2) : '–';

    const accounts = d.accounts.map((a) => `<div class="account ${a.is_main ? 'main' : ''}">
        <span class="badge ${a.region === 'EUNE' ? '' : 'gray'}">${esc(a.region)}</span>
        <span class="rid">${esc(a.game_name)}<span class="muted">#${esc(a.tag_line)}</span></span>
        ${a.is_main ? '<span class="badge green">HLAVNÍ</span>' : ''}${a.verified ? '<span class="small muted">✓ ověřeno</span>' : ''}
        ${d.isMe ? `<div class="actions">${!a.is_main && a.region === 'EUNE' ? `<button class="btn ghost sm" data-main="${a.id}">Nastavit jako hlavní</button>` : ''}
          <button class="btn danger sm" data-del="${a.id}">Odebrat</button></div>` : ''}
      </div>`).join('') || '<div class="empty-state">Žádné účty.</div>';

    app.innerHTML = `
      <div class="profile-head">${avatar(u, 72)}
        <div><h1>${esc(u.username)}</h1><div class="muted" style="margin-top:4px">${d.rank ? `#${d.rank} v žebříčku · ` : ''}členem od ${new Date(u.created_at).toLocaleDateString('cs-CZ')}</div></div>
      </div>
      <div class="stat-grid">
        <div class="stat"><h3>Elo</h3><div class="v accent">${u.elo}</div></div>
        <div class="stat"><h3>Zápasy</h3><div class="v">${games}</div></div>
        <div class="stat"><h3>V / P</h3><div class="v"><span class="result-W">${u.wins}</span> / <span class="result-L">${u.losses}</span></div></div>
        <div class="stat"><h3>Winrate</h3><div class="v">${games ? Math.round((u.wins / games) * 100) + ' %' : '–'}</div></div>
        <div class="stat"><h3>KDA</h3><div class="v">${kda}</div></div>
        <div class="stat"><h3>Ø CS</h3><div class="v">${s.cs ? Math.round(s.cs) : '–'}</div></div>
      </div>
      <div class="layout-2" style="margin-top:0">
        <div class="panel"><div class="panel-head"><h2>Historie zápasů</h2></div>
          ${d.history.length ? `<table><thead><tr><th>Zápas</th><th></th><th>Role</th><th>Champion</th><th class="num">KDA</th><th class="num">CS</th><th class="num">Elo</th></tr></thead><tbody>
          ${d.history.map((h) => `<tr style="cursor:pointer" onclick="location.hash='#/match/${h.id}'">
            <td><b>#${h.id}</b> <span class="small muted">${fmtDate(h.created_at)}</span></td>
            <td>${h.status === 'finished' ? `<span class="result-${h.win ? 'W' : 'L'}">${h.win ? 'VÝHRA' : 'PROHRA'}</span>` : statusBadge(h.status)}</td>
            <td>${roleTag(h.role)}${h.is_captain ? ' 👑' : ''}</td><td>${esc(h.champion || '–')}</td>
            <td class="num">${h.kills != null ? `${h.kills}/${h.deaths}/${h.assists}` : '–'}</td><td class="num">${h.cs ?? '–'}</td>
            <td class="num">${h.elo_after != null ? `<span class="${h.elo_after >= h.elo_before ? 'plus' : 'minus'}">${h.elo_after >= h.elo_before ? '+' : ''}${h.elo_after - h.elo_before}</span>` : '–'}</td>
          </tr>`).join('')}</tbody></table>` : '<div class="empty-state">Zatím žádné zápasy.</div>'}
        </div>
        <div class="stack">
          <div class="panel"><div class="panel-head"><h2>League of Legends účty</h2><span class="muted small">${d.accounts.length}/3</span></div>
            ${accounts}
            ${d.isMe && d.accounts.length < 3 ? `<form class="add-form" id="add-acc">
              <input class="input" name="gameName" placeholder="Jméno (Riot ID)" required maxlength="16">
              <input class="input" name="tagLine" placeholder="#TAG" required maxlength="6">
              <select class="input" name="region">${S.config.regions.map((r) => `<option ${r === 'EUNE' ? 'selected' : ''}>${r}</option>`).join('')}</select>
              <button class="btn">Přidat</button></form>` : ''}
            ${d.isMe ? '<div class="small muted" style="margin-top:10px">Min. 1, max. 3 účty. Hlavní účet musí být <b>EUNE</b> – na něm hraješ inhouse hry a podle něj se páruje replay.</div>' : ''}
          </div>
          ${d.roles.length ? `<div class="panel"><div class="panel-head"><h2>Role</h2></div>${d.roles.map((r) => `<div class="list-row">${roleTag(r.role)}<span>${r.games} her</span><span class="muted small" style="margin-left:auto">${Math.round((r.wins / r.games) * 100)} % WR</span></div>`).join('')}</div>` : ''}
          ${d.champions.length ? `<div class="panel"><div class="panel-head"><h2>Championi</h2></div>${d.champions.map((c) => `<div class="list-row"><span>${esc(c.champion)}</span><span class="muted small" style="margin-left:auto">${c.games} her · ${Math.round((c.wins / c.games) * 100)} %</span></div>`).join('')}</div>` : ''}
        </div>
      </div>`;

    const reload = async () => { await refreshMe(); viewProfile(id); };
    const f = $('#add-acc');
    if (f) f.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/api/me/accounts', { method: 'POST', body: { gameName: f.gameName.value, tagLine: f.tagLine.value, region: f.region.value } });
        toast('Účet přidán', 'success'); reload();
      } catch (err) { toast(err.message, 'error'); }
    };
    app.querySelectorAll('[data-del]').forEach((b) => { b.onclick = async () => {
      if (!confirm('Odebrat účet?')) return;
      try { await api(`/api/me/accounts/${b.dataset.del}`, { method: 'DELETE' }); reload(); } catch (err) { toast(err.message, 'error'); }
    }; });
    app.querySelectorAll('[data-main]').forEach((b) => { b.onclick = async () => {
      try { await api(`/api/me/accounts/${b.dataset.main}/main`, { method: 'POST' }); reload(); } catch (err) { toast(err.message, 'error'); }
    }; });
  }

  // ─────────── ŽEBŘÍČEK / ZÁPASY ───────────
  async function viewLeaderboard() {
    const d = await api('/api/leaderboard');
    app.innerHTML = `<h1 style="margin-bottom:18px">Žebříček</h1><div class="panel">
      ${d.players.length ? `<table><thead><tr><th style="width:50px">#</th><th>Hráč</th><th class="num">Elo</th><th class="num">Výhry</th><th class="num">Prohry</th><th class="num">Winrate</th></tr></thead><tbody>
      ${d.players.map((p, i) => `<tr><td class="muted">${i + 1}</td><td>${userLink(p)}</td><td class="num" style="color:var(--accent);font-weight:700">${p.elo}</td>
        <td class="num">${p.wins}</td><td class="num">${p.losses}</td><td class="num">${Math.round((p.wins / (p.wins + p.losses)) * 100)} %</td></tr>`).join('')}
      </tbody></table>` : '<div class="empty-state">Zatím nikdo nedohrál žádný zápas.</div>'}</div>`;
  }

  async function viewMatches() {
    const d = await api('/api/matches');
    const row = (m) => {
      const blue = m.players.filter((p) => p.team === 'BLUE').map((p) => esc(p.username)).join(', ');
      const red = m.players.filter((p) => p.team === 'RED').map((p) => esc(p.username)).join(', ');
      return `<a class="list-row" href="#/match/${m.id}"><b style="width:44px">#${m.id}</b>${statusBadge(m.status)}
        <span class="small" style="flex:1"><span style="color:var(--blue)">${blue}</span> <span class="muted">vs</span> <span style="color:var(--red)">${red}</span></span>
        ${m.winner ? sideBadge(m.winner) : ''}<span class="muted small">${fmtDate(m.created_at)}</span></a>`;
    };
    app.innerHTML = `<h1 style="margin-bottom:18px">Zápasy</h1><div class="stack">
      <div class="panel"><div class="panel-head"><h2>Probíhající</h2></div>${d.active.map(row).join('') || '<div class="empty-state">Nic neprobíhá.</div>'}</div>
      <div class="panel"><div class="panel-head"><h2>Poslední</h2></div>${d.recent.map(row).join('') || '<div class="empty-state">Zatím žádné zápasy.</div>'}</div></div>`;
  }

  // ─────────── časovače ───────────
  function tick() {
    document.querySelectorAll('[data-deadline]').forEach((el) => {
      const left = Math.max(0, Number(el.dataset.deadline) - now());
      const t = el.querySelector('.t'); if (t) t.textContent = `${Math.ceil(left / 1000)}`;
      const bar = el.querySelector('.bar'); if (bar) bar.style.width = `${(left / Number(el.dataset.total)) * 100}%`;
    });
    document.querySelectorAll('[data-since]').forEach((el) => { el.textContent = fmtDur(now() - Number(el.dataset.since)); });
  }
  setInterval(tick, 250);

  // ─────────── socket události ───────────
  socket.on('queue_state', (q) => {
    syncTime(q.serverNow);
    S.queue = q;
    if (route().name === 'home' && S.me) { renderQueue(); loadSidePanel(); }
  });
  socket.on('ready_check', (rc) => {
    syncTime(rc.serverNow);
    const fresh = !S.ready || S.ready.id !== rc.id;
    S.ready = rc; renderReady();
    if (fresh) { beep(); refreshMe(); }
  });
  socket.on('ready_end', (r) => {
    S.ready = null; renderReady();
    if (r.message) toast(r.message, r.success ? 'success' : 'error');
    refreshMe();
  });
  socket.on('draft_start', ({ id }) => { refreshMe(); location.hash = `#/draft/${id}`; });
  socket.on('draft_state', (st) => {
    if (st.id !== S.draftId) return;
    syncTime(st.serverNow);
    S.draft = st; renderDraft();
  });
  socket.on('draft_chat', ({ id, message }) => {
    if (id !== S.draftId) return;
    (message.channel === 'team' ? S.chat.team : S.chat.all).push(message);
    renderChat();
  });
  socket.on('draft_team_chat', ({ id, messages }) => {
    if (id !== S.draftId) return;
    S.chat.team = messages.slice(); renderChat();
  });
  socket.on('draft_done', ({ id, matchId }) => {
    refreshMe();
    if (id === S.draftId) { toast(`Týmy jsou hotové – zápas #${matchId}`, 'success'); setTimeout(() => { if (S.draftId === id) location.hash = `#/match/${matchId}`; }, 2500); }
  });
  socket.on('match_update', ({ id }) => { refreshMe(); if (String(id) === String(S.matchId)) viewMatch(String(id)); });
  socket.on('matches_changed', () => { if (route().name === 'home' && S.me) loadSidePanel(); });
  socket.on('connect', () => {
    if (S.draftId) emit('draft_join', { id: S.draftId }).then((r) => { if (r?.state) { S.draft = r.state; S.chat = r.chat; renderDraft(); renderChat(); } });
    if (S.matchId) emit('match_join', { id: S.matchId });
  });

  // ─────────── start ───────────
  (async () => {
    S.config = await api('/api/config');
    await refreshMe();
    if (new URLSearchParams(location.search).get('error') === 'oauth') toast('Přihlášení přes Discord se nezdařilo.', 'error');
    if (S.status?.draft && route().name === 'home') location.hash = `#/draft/${S.status.draft}`;
    render();
  })();
})();
