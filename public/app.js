(() => {
  'use strict';

  const ROLE_LABEL = { TOP: 'Top', JUNGLE: 'Jungle', MID: 'Mid', ADC: 'ADC', SUPPORT: 'Support' };
  const STATUS = {
    in_progress: ['Probíhá', 'live'], awaiting_confirm: ['Čeká na potvrzení', 'warn'],
    disputed: ['Rozporováno', 'bad'], finished: ['Dohráno', 'ok'], cancelled: ['Zrušeno', 'off'],
  };

  // ─────────── ikony ───────────
  const svg = (inner) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
  const FRAME = '<rect class="fr" x="3.5" y="3.5" width="17" height="17" rx="4"/>';
  const ROLE_SVG = {
    TOP: `${FRAME}<path d="M7.5 16.5v-9h9"/>`,
    JUNGLE: `${FRAME}<path d="M12 7c-2.6 2.4-3.4 5.2-1.6 9M12 7c2.6 2.4 3.4 5.2 1.6 9M12 10.5v6"/>`,
    MID: `${FRAME}<path d="M7.5 16.5l9-9"/>`,
    ADC: `${FRAME}<path d="M7.5 16.5h9v-9"/>`,
    SUPPORT: `${FRAME}<path d="M12 7.5l3.8 1.4v3c0 2.3-1.6 3.9-3.8 4.6-2.2-.7-3.8-2.3-3.8-4.6v-3z"/>`,
  };
  const roleIcon = (r, cls = '') => `<span class="ri ${cls}" title="${ROLE_LABEL[r] || r}" aria-label="${ROLE_LABEL[r] || r}">${svg(ROLE_SVG[r] || FRAME)}</span>`;
  const IC = {
    crown: svg('<path d="M4.5 17.5h15M5.5 14.5 4.5 7.5l5 3.5L12 5.5l2.5 5.5 5-3.5-1 7z"/>'),
    copy: svg('<rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>'),
    out: svg('<path d="M14 4.5h3a2.5 2.5 0 0 1 2.5 2.5v10a2.5 2.5 0 0 1-2.5 2.5h-3M10 16l-4-4 4-4M6 12h9.5"/>'),
    send: svg('<path d="M5 12h13M13 6l6 6-6 6"/>'),
    star: svg('<path d="M12 4.5l2.3 4.7 5.2.8-3.8 3.6.9 5.1-4.6-2.4-4.6 2.4.9-5.1L4.5 10l5.2-.8z"/>'),
    x: svg('<path d="M7 7l10 10M17 7 7 17"/>'),
    plus: svg('<path d="M12 6v12M6 12h12"/>'),
    check: svg('<path d="M5.5 12.5l4 4 9-9"/>'),
    voice: svg('<path d="M4.5 14v-2a7.5 7.5 0 0 1 15 0v2"/><rect x="3.5" y="13" width="4" height="6.5" rx="1.5"/><rect x="16.5" y="13" width="4" height="6.5" rx="1.5"/>'),
    upload: svg('<path d="M12 16V5M7 10l5-5 5 5M5 19h14"/>'),
  };

  const S = {
    me: null, accounts: [], status: null, config: null, queue: null, timeOffset: 0, seen: null,
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
  const sideName = (s) => (s === 'BLUE' ? 'Blue' : 'Red');
  const sideChip = (s) => (s ? `<span class="chip-s ${s === 'BLUE' ? 'blue' : 'red'}">${sideName(s)}</span>` : '');
  const statusChip = (s) => `<span class="chip-s ${STATUS[s]?.[1] || 'off'}">${STATUS[s]?.[0] || esc(s)}</span>`;
  const delta = (n) => `<span class="${n >= 0 ? 'plus' : 'minus'}">${n >= 0 ? '+' : '−'}${Math.abs(n)}</span>`;
  const profileHref = (id) => `#/profile/${encodeURIComponent(id)}`;

  function hue(seed) {
    let h = 2166136261;
    for (const c of String(seed || '?')) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    return ((h >>> 0) % 12) * 30;   // 12 rozlišitelných odstínů
  }
  function avatar(u, size = 28) {
    if (u?.avatar) return `<img class="av" src="${esc(u.avatar)}" width="${size}" height="${size}" alt="">`;
    const h = hue(u?.id || u?.username);
    return `<span class="av" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px;background:hsl(${h} 20% 21%);color:hsl(${h} 70% 82%)">${esc((u?.username || '?')[0].toUpperCase())}</span>`;
  }

  function ring(deadline, total, size, stroke, fs) {
    const r = (size - stroke) / 2;
    const c = 2 * Math.PI * r;
    return `<div class="ring" style="width:${size}px;height:${size}px;--fs:${fs}px" data-deadline="${deadline}" data-total="${total}" data-c="${c}">
      <svg width="${size}" height="${size}"><circle class="track" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}"/>
      <circle class="bar" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}" stroke-dasharray="${c}" stroke-dashoffset="0"/></svg>
      <span class="num"></span></div>`;
  }

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
    } catch { /* bez zvuku */ }
  }

  async function refreshMe() {
    const d = await api('/api/me');
    S.me = d.user; S.accounts = d.accounts || []; S.status = d.status || null;
    renderNav(); renderDock();
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
    if (r.name !== 'home') S.seen = null;
    document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === r.name));
    window.scrollTo(0, 0);
    const views = { home: viewHome, draft: viewDraft, match: viewMatch, profile: viewProfile, leaderboard: viewLeaderboard, matches: viewMatches };
    (views[r.name] || viewHome)(r.id);
    renderDock();
  }
  window.addEventListener('hashchange', render);

  function renderNav() {
    const el = $('#nav-user');
    if (!S.me) { el.innerHTML = '<a class="btn sm" href="/auth/discord">Přihlásit přes Discord</a>'; return; }
    el.innerHTML = `
      <a class="me-chip" href="${profileHref(S.me.id)}">${avatar(S.me, 32)}<span class="nm">${esc(S.me.username)}</span><span class="elo">${S.me.elo}</span></a>
      <button class="btn bare icon sm" id="logout" title="Odhlásit" aria-label="Odhlásit">${IC.out}</button>`;
    $('#logout').onclick = async () => { await api('/auth/logout', { method: 'POST' }); location.href = '/'; };
  }

  // Plovoucí lišta: fronta / draft / rozehraný zápas
  function myQueueEntry() { return S.me && S.queue?.entries.find((e) => e.user.id === S.me.id); }
  function renderDock() {
    const el = $('#dock');
    const r = route();
    const st = S.status;
    const mine = myQueueEntry();
    let html = '';
    if (st?.draft && !(r.name === 'draft' && r.id === st.draft)) {
      html = `<span class="pulse"></span><b>Draft běží</b><a class="btn sm" href="#/draft/${st.draft}">Otevřít</a>`;
    } else if (mine) {
      html = `<span class="pulse"></span>${roleIcon(mine.role)}<b>Hledám hru</b><span class="t" data-since="${mine.joinedAt}"></span>
        <button class="btn sm ghost" id="dock-leave">Zrušit</button>`;
    } else if (st?.activeMatch && !(r.name === 'match' && r.id === String(st.activeMatch))) {
      html = `<span class="pulse ok"></span><b>Zápas #${st.activeMatch}</b><a class="btn sm" href="#/match/${st.activeMatch}">Otevřít</a>`;
    }
    el.innerHTML = html ? `<div class="dock" role="status">${html}</div>` : '';
    const b = $('#dock-leave');
    if (b) b.onclick = () => emit('queue_leave').then(refreshMe);
    tick();
  }

  // ─────────── FRONTA ───────────
  function viewHome() {
    if (!S.me) {
      app.innerHTML = `
        <section class="hero">
          <h1>Inhouse 5v5</h1>
          <p>Fronta podle rolí, draft kapitánů a elo po každé hře.</p>
          <a class="btn lg" href="/auth/discord">Přihlásit přes Discord</a>
          ${S.config?.devLogin ? '<form id="dev-login"><input class="input" name="name" placeholder="Testovací jméno" required><button class="btn ghost">Dev přihlášení</button></form>' : ''}
        </section>
        <div class="q-head"><h2 class="muted">Právě ve frontě</h2><div class="meter" id="meter"></div></div>
        <div class="roles" id="roles"></div>`;
      const f = $('#dev-login');
      if (f) f.onsubmit = (e) => { e.preventDefault(); location.href = `/auth/dev?name=${encodeURIComponent(f.name.value)}`; };
      renderQueue();
      return;
    }
    app.innerHTML = `
      <div class="q-head"><h1>Fronta</h1><div class="meter" id="meter"></div></div>
      <div id="note"></div>
      <div class="roles" id="roles"></div>
      <div class="live" id="live"></div>`;
    renderQueue();
    loadLive();
  }

  function renderQueue() {
    const rolesEl = $('#roles');
    if (!rolesEl || !S.queue || !S.config) return;
    const q = S.queue;
    const roles = S.config.roles;
    const by = Object.fromEntries(roles.map((r) => [r, q.entries.filter((e) => e.role === r)]));
    const mine = myQueueEntry();
    const interactive = !!S.me;
    const hasMain = S.accounts.some((a) => a.is_main);
    const busy = S.status?.draft || S.status?.readyCheck || S.status?.activeMatch;
    const filled = roles.reduce((s, r) => s + Math.min(2, by[r].length), 0);
    const seenNow = new Set();

    $('#meter').innerHTML = `${Array.from({ length: 10 }, (_, i) => `<i class="${i < filled ? 'on' : ''}"></i>`).join('')}<b>${filled}/10</b>`;
    const note = $('#note');
    if (note) {
      note.innerHTML = interactive && !hasMain
        ? `<div class="note"><span>Pro hraní si přidej EUNE účet.</span><a class="btn sm" href="${profileHref(S.me.id)}">Přidat účet</a></div>` : '';
    }

    rolesEl.innerHTML = roles.map((r) => {
      const list = by[r];
      const isMine = mine?.role === r;
      const slots = [0, 1].map((i) => {
        const e = list[i];
        if (!e) return `<div class="slot empty" aria-label="Volné místo">${IC.plus}</div>`;
        seenNow.add(e.user.id);
        const pop = S.seen && !S.seen.has(e.user.id) ? ' pop' : '';
        const me = S.me && e.user.id === S.me.id ? ' me' : '';
        return `<a class="slot${pop}${me}" href="${profileHref(e.user.id)}">${avatar(e.user, 28)}<span class="nm">${esc(e.user.username)}</span><span class="elo">${e.user.elo}</span></a>`;
      }).join('');
      const waiting = list.slice(2);
      const wait = waiting.length
        ? `<div class="wait" title="Čekají na místo">${waiting.slice(0, 5).map((e) => avatar(e.user, 22)).join('')}<span>+${waiting.length}</span></div>`
        : '<div class="wait"></div>';
      let btn = '';
      if (interactive) {
        btn = isMine
          ? '<button class="btn ghost" data-leave>Zrušit</button>'
          : `<button class="btn" data-join="${r}" ${!hasMain || busy ? 'disabled' : ''}>${mine ? 'Přepnout' : 'Hrát'}</button>`;
      }
      return `<div class="role${isMine ? ' mine' : ''}${list.length >= 2 ? ' full' : ''}">
        <div class="role-top">${roleIcon(r)}<b>${ROLE_LABEL[r]}</b><span class="cnt">${Math.min(2, list.length)}/2</span></div>
        ${slots}${wait}${btn}</div>`;
    }).join('');
    S.seen = seenNow;

    rolesEl.querySelectorAll('[data-join]').forEach((b) => { b.onclick = () => emit('queue_join', { role: b.dataset.join }).then(refreshMe); });
    rolesEl.querySelectorAll('[data-leave]').forEach((b) => { b.onclick = () => emit('queue_leave').then(refreshMe); });
  }

  async function loadLive() {
    const el = $('#live');
    if (!el) return;
    const drafts = S.queue?.drafts || [];
    let matches = { active: [] };
    try { matches = await api('/api/matches'); } catch { /* ignore */ }
    if (!$('#live')) return;
    const chips = [
      ...drafts.map((d) => `<a class="chip" href="#/draft/${d.id}"><span class="dot draft"></span>Draft: ${esc(d.captains[0].username)} vs ${esc(d.captains[1].username)}</a>`),
      ...matches.active.map((m) => `<a class="chip" href="#/match/${m.id}"><span class="dot"></span>Zápas #${m.id}</a>`),
    ];
    el.innerHTML = chips.length ? `<span class="lbl">Teď se hraje</span>${chips.join('')}` : '';
  }

  // ─────────── POTVRZENÍ HRY ───────────
  function renderReady() {
    const root = $('#modal-root');
    const rc = S.ready;
    if (!rc) { root.innerHTML = ''; document.title = 'INHOUSE'; return; }
    const total = S.config.timers.readyCheck * 1000;
    root.innerHTML = `<div class="overlay"><div class="ready" role="dialog" aria-modal="true" aria-label="Hra nalezena">
      ${roleIcon(rc.role, 'lg')}
      <h2>Hra nalezena</h2>
      ${ring(rc.deadline, total, 168, 8, 46)}
      <div class="pips" aria-label="Přijalo ${rc.accepted} z ${rc.total}">${Array.from({ length: rc.total }, (_, i) => `<span class="pip ${i < rc.accepted ? 'on' : ''}"></span>`).join('')}</div>
      ${rc.you ? '<p class="muted">Čekáme na ostatní</p>'
        : '<div class="actions"><button class="btn lg" id="rc-accept">Přijmout</button><button class="btn bare" id="rc-decline">Odmítnout</button></div>'}
    </div></div>`;
    document.title = '🔔 Hra nalezena – INHOUSE';
    const a = $('#rc-accept'); const d = $('#rc-decline');
    if (a) { a.onclick = () => emit('ready_respond', { id: rc.id, accept: true }); a.focus(); }
    if (d) d.onclick = () => emit('ready_respond', { id: rc.id, accept: false });
    tick();
  }

  // ─────────── DRAFT ───────────
  function viewDraft(id) {
    S.draftId = id; S.draft = null; S.chat = { all: [], team: [] };
    app.innerHTML = `<div class="draft">
      <section class="board" id="board"><div class="empty">Načítám draft…</div></section>
      <aside class="chat">
        <div class="seg" role="tablist"><button data-tab="all">Všichni</button><button data-tab="team">Tým</button></div>
        <div class="msgs" id="msgs"></div>
        <form class="send" id="send"><input class="input" name="text" maxlength="300" autocomplete="off" placeholder="Zpráva">
          <button class="btn icon" aria-label="Odeslat">${IC.send}</button></form>
      </aside></div>`;
    app.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => { S.chatTab = b.dataset.tab; renderChat(); }; });
    $('#send').onsubmit = (e) => {
      e.preventDefault();
      const input = e.target.text;
      if (!input.value.trim()) return;
      emit('draft_chat', { id, channel: S.chatTab, text: input.value });
      input.value = '';
    };
    emit('draft_join', { id }).then((r) => {
      if (!r?.state) { $('#board').innerHTML = `<div class="empty">${esc(r?.error || 'Draft nenalezen.')}</div>`; return; }
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
    const board = $('#board');
    if (!d || !board) return;
    const done = d.phase === 'done';
    const actor = d.captains[d.actor];
    const myTurn = !done && S.me && actor.id === S.me.id;
    const canPick = myTurn && d.phase === 'pick';
    const total = S.config.timers.draftPick * 1000;
    const sideVar = (t) => (d.side[t] ? `--side:var(--${d.side[t] === 'BLUE' ? 'blue' : 'red'})` : '');

    const cap = (t, pos) => {
      const c = d.captains[t];
      return `<div class="cap ${pos}${!done && d.actor === t ? ' turn' : ''}">${avatar(c, 46)}
        <div style="min-width:0"><span class="nm">${esc(c.username)}</span>
        <div class="tags">${d.side[t] ? sideChip(d.side[t]) : ''}${d.firstPicker === t ? '<span class="chip-s">1. pick</span>' : ''}</div></div></div>`;
    };

    let phase;
    if (done) phase = 'Týmy jsou hotové';
    else if (myTurn) phase = { choice: 'Vyber si výhodu', side: 'Vyber stranu', pick: 'Vyber hráče' }[d.phase];
    else phase = { choice: `${actor.username} volí výhodu`, side: `${actor.username} volí stranu`, pick: `${actor.username} vybírá` }[d.phase];

    let opts = '';
    if (myTurn && d.phase === 'choice') {
      opts = `<div class="opts"><button class="opt" data-act="pick"><b>První pick</b><span>Soupeř si volí stranu</span></button>
        <button class="opt" data-act="side"><b>Strana</b><span>Soupeř má první pick</span></button></div>`;
    } else if (myTurn && d.phase === 'side') {
      opts = '<div class="opts"><button class="opt blue" data-act="BLUE"><b>Blue</b></button><button class="opt red" data-act="RED"><b>Red</b></button></div>';
    }

    const slot = (p, t, pos) => (p
      ? `<div class="dslot ${pos}" style="${sideVar(t)}">${avatar(p.user, 30)}<span class="nm">${esc(p.user.username)}</span>${p.captain ? `<span class="crown" title="Kapitán">${IC.crown}</span>` : ''}</div>`
      : `<div class="dslot ${pos} empty" style="${sideVar(t)}"></div>`);
    const cand = (u) => `<button class="cand${canPick ? ' can' : ''}" ${canPick ? `data-pick="${esc(u.id)}"` : 'disabled'}>${avatar(u, 24)}<span class="nm">${esc(u.username)}</span><span class="elo">${u.elo}</span></button>`;
    const rows = S.config.roles.map((r) => {
      const a = d.teams.A.find((p) => p.role === r);
      const b = d.teams.B.find((p) => p.role === r);
      const c = d.pool[r];
      return `<div class="drow${c ? ' open' : ''}">${slot(a, 'A', 'left')}
        <div class="mid">${c ? cand(c[0]) : '<span></span>'}${roleIcon(r)}${c ? cand(c[1]) : '<span></span>'}</div>
        ${slot(b, 'B', 'right')}</div>`;
    }).join('');

    board.innerHTML = `
      <div class="dhead">${cap('A', 'left')}
        <div class="dclock">${done ? `<div class="done-mark">${IC.check}</div>` : ring(d.deadline, total, 84, 6, 24)}</div>
        ${cap('B', 'right')}</div>
      <p class="phase${myTurn ? ' you' : ''}">${esc(phase)}${d.phase === 'pick' && !done ? ` <span class="faint">${d.round + 1}/${d.totalRounds}</span>` : ''}</p>
      ${opts}
      <div class="rows">${rows}</div>
      ${d.matchId ? `<div class="go"><a class="btn lg" href="#/match/${d.matchId}">Přejít na zápas</a></div>` : ''}`;

    board.querySelectorAll('[data-act]').forEach((b) => { b.onclick = () => emit('draft_action', { id: d.id, value: b.dataset.act }); });
    board.querySelectorAll('[data-pick]').forEach((b) => { b.onclick = () => emit('draft_action', { id: d.id, userId: b.dataset.pick }); });
    renderChatTabs();
    tick();
  }

  function renderChatTabs() {
    const team = myDraftTeam();
    const isPlayer = S.draft && S.me && S.draft.participants.includes(S.me.id);
    if (S.chatTab === 'team' && !team) S.chatTab = 'all';
    app.querySelectorAll('[data-tab]').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === S.chatTab);
      if (b.dataset.tab === 'team') b.disabled = !team;
    });
    const input = $('#send input');
    if (input) { input.disabled = !isPlayer; input.placeholder = isPlayer ? 'Zpráva' : 'Jen pro hráče'; }
  }

  function renderChat() {
    const box = $('#msgs');
    if (!box) return;
    renderChatTabs();
    const msgs = S.chatTab === 'team' ? S.chat.team : S.chat.all;
    let prev = null;
    box.innerHTML = msgs.length ? msgs.map((m) => {
      const me = S.me && m.user.id === S.me.id;
      const showWho = prev !== m.user.id;
      prev = m.user.id;
      return `<div class="msg${me ? ' me' : ''}">${showWho ? avatar(m.user, 22) : '<span style="width:22px;flex-shrink:0"></span>'}
        <div class="body">${showWho ? `<div class="who">${esc(m.user.username)}</div>` : ''}<div class="text">${esc(m.text)}</div></div></div>`;
    }).join('') : `<div class="empty">${S.chatTab === 'team' ? 'Vidí jen tvůj tým' : 'Napiš první zprávu'}</div>`;
    box.scrollTop = box.scrollHeight;
  }

  // ─────────── ZÁPAS ───────────
  async function viewMatch(id) {
    S.matchId = id;
    emit('match_join', { id });
    let data;
    try { data = await api(`/api/matches/${id}`); } catch (e) { app.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    if (S.matchId !== id) return;
    const { match: m, players, viewer: v } = data;
    const done = m.status === 'finished';
    const pending = m.pending;
    const statsOf = (p) => (done ? p : pending?.stats?.[p.user_id] || null);

    const mp = (p, pos) => {
      if (!p) return `<div class="mp ${pos}"></div>`;
      const s = statsOf(p);
      const u = { id: p.user_id, username: p.username, avatar: p.avatar };
      const meta = s && s.kills != null ? `${esc(s.champion || '')} <span class="faint">${s.kills}/${s.deaths}/${s.assists}</span>` : esc(p.riot_id || '');
      const end = done && p.elo_after != null ? `<span class="end">${delta(p.elo_after - p.elo_before)}</span>` : `<span class="end plain">${p.current_elo}</span>`;
      return `<a class="mp ${pos}" href="${profileHref(p.user_id)}">${avatar(u, 38)}
        <div class="who"><div class="nm">${esc(p.username)}${p.is_captain ? `<span class="crown" title="Kapitán">${IC.crown}</span>` : ''}</div><div class="meta">${meta}</div></div>${end}</a>`;
    };
    const rows = S.config.roles.map((r) => `<div class="mrow">${mp(players.find((p) => p.team === 'BLUE' && p.role === r), 'left')}
      <div class="mid">${roleIcon(r)}</div>${mp(players.find((p) => p.team === 'RED' && p.role === r), 'right')}</div>`).join('');
    const th = (side, pos) => {
      let res = '';
      if (done) res = m.winner === side ? '<span class="chip-s ok">Výhra</span>' : '<span class="chip-s off">Prohra</span>';
      return `<div class="th ${side.toLowerCase()} ${pos}"><b>${sideName(side)}</b>${res}${v.myTeam === side ? '<span class="chip-s">Tvůj tým</span>' : ''}</div>`;
    };

    let lobby = '';
    if (m.lobby) {
      const myVoice = m.voice && v.myTeam ? m.voice[v.myTeam] : null;
      let voice;
      if (myVoice) voice = `<a class="btn voice" href="${esc(myVoice.invite)}" target="_blank" rel="noopener">${IC.voice}Voice</a>`;
      else if (m.voice && v.isAdmin) voice = `<div class="field">${Object.entries(m.voice).map(([s, x]) => `<a class="btn sm ghost" href="${esc(x.invite)}" target="_blank" rel="noopener">${sideName(s)}</a>`).join('')}</div>`;
      else voice = '<div class="field off">Voice zatím není</div>';
      lobby = `<div class="lobby">
        <div class="field"><div style="min-width:0"><small>Název hry</small><strong>${esc(m.lobby.name)}</strong></div>
          <button class="btn bare icon" data-copy="${esc(m.lobby.name)}" title="Kopírovat" aria-label="Kopírovat název">${IC.copy}</button></div>
        <div class="field"><div style="min-width:0"><small>Heslo</small><strong>${esc(m.lobby.password)}</strong></div>
          <button class="btn bare icon" data-copy="${esc(m.lobby.password)}" title="Kopírovat" aria-label="Kopírovat heslo">${IC.copy}</button></div>
        ${voice}</div>
        <p class="hint">Lobby zakládá kapitán Blue týmu.</p>`;
    }

    let status = '';
    if (m.status === 'awaiting_confirm' && pending) {
      const loser = players.find((p) => p.user_id === m.loserCaptain)?.username || 'kapitána soupeře';
      status = `<div class="card status-card"><div><h2>Vyhrál ${sideName(pending.winner)}</h2>
        <p>${v.canConfirm ? 'Podle nahraného replaye. Potvrď výsledek.' : `Čeká na potvrzení od ${esc(loser)}.`}</p></div>
        ${v.canConfirm ? '<div class="acts"><button class="btn danger" id="dispute">Rozporovat</button><button class="btn" id="confirm">Potvrdit</button></div>' : ''}</div>`;
    } else if (m.status === 'disputed') {
      status = `<div class="card status-card"><div><h2>Výsledek je rozporovaný</h2><p>Rozhodne admin, nebo nahraj správný replay.</p></div>
        ${v.isAdmin && pending ? `<div class="acts"><button class="btn" id="confirm">Potvrdit výhru ${sideName(pending.winner)}</button></div>` : ''}</div>`;
    } else if (m.status === 'cancelled') {
      status = '<div class="card status-card"><div><h2>Zápas byl zrušen</h2><p>Elo se nezměnilo.</p></div></div>';
    }

    const upload = v.canUpload ? `<label class="drop" id="drop"><input type="file" accept=".rofl" id="rofl" hidden>${IC.upload}
      <b>Nahrát replay vítěze</b><span class="muted small">Soubor .rofl stáhneš v klientu v historii zápasů.</span></label><p class="hint" id="upload-status"></p>` : '';

    const meta = [fmtDate(m.created_at), m.duration ? fmtDur(m.duration * 1000) : ''].filter(Boolean).join(', ');
    app.innerHTML = `
      <div class="mhead"><h1>Zápas #${m.id}</h1>${statusChip(m.status)}<span class="faint small">${meta}</span><span class="sp"></span>
        ${v.isAdmin && !['finished', 'cancelled'].includes(m.status) ? '<button class="btn danger sm" id="cancel">Zrušit zápas</button>' : ''}</div>
      ${lobby}
      <div class="stack">
        ${status}
        <div class="vs"><div class="vs-head">${th('BLUE', 'left')}<span></span>${th('RED', 'right')}</div><div class="rows">${rows}</div></div>
        ${upload}
      </div>`;

    app.querySelectorAll('[data-copy]').forEach((b) => {
      b.onclick = () => navigator.clipboard.writeText(b.dataset.copy).then(() => toast('Zkopírováno', 'success'));
    });
    const act = (url, msg) => async () => {
      try { await api(url, { method: 'POST' }); toast(msg, 'success'); refreshMe(); viewMatch(id); } catch (e) { toast(e.message, 'error'); }
    };
    if ($('#confirm')) $('#confirm').onclick = act(`/api/matches/${id}/confirm`, 'Výsledek potvrzen');
    if ($('#dispute')) $('#dispute').onclick = () => { if (confirm('Rozporovat výsledek? Rozhodne admin.')) act(`/api/matches/${id}/dispute`, 'Výsledek rozporován')(); };
    if ($('#cancel')) $('#cancel').onclick = () => { if (confirm('Zrušit zápas bez změny ela?')) act(`/api/matches/${id}/cancel`, 'Zápas zrušen')(); };

    const drop = $('#drop');
    if (drop) {
      const send = async (file) => {
        if (!file) return;
        if (!file.name.toLowerCase().endsWith('.rofl')) { toast('Vyber soubor .rofl', 'error'); return; }
        const st = $('#upload-status');
        st.textContent = `Nahrávám ${file.name}…`;
        const fd = new FormData(); fd.append('rofl', file);
        try {
          const r = await api(`/api/matches/${id}/result`, { method: 'POST', body: fd });
          toast(`Replay nahrán, vyhrál ${sideName(r.winner)}`, 'success');
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
    if (!id) { location.hash = S.me ? profileHref(S.me.id) : '#/'; return; }
    let d;
    try { d = await api(`/api/users/${encodeURIComponent(id)}`); } catch (e) { app.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    const u = d.user; const s = d.stats;
    const games = u.wins + u.losses;
    const wr = games ? Math.round((u.wins / games) * 100) : null;
    const kda = s.games ? ((s.kills + s.assists) / Math.max(1, s.deaths)).toFixed(2) : '–';

    const accounts = d.accounts.map((a) => `<div class="acc${a.is_main ? ' main' : ''}">
        <span class="reg">${esc(a.region)}</span>
        <span class="rid">${esc(a.game_name)}<span class="faint">#${esc(a.tag_line)}</span></span>
        ${a.is_main ? '<span class="chip-s">Hlavní</span>' : ''}
        ${d.isMe ? `<span class="acts">${!a.is_main && a.region === 'EUNE' ? `<button class="btn bare icon sm" data-main="${a.id}" title="Nastavit jako hlavní" aria-label="Nastavit jako hlavní">${IC.star}</button>` : ''}
          <button class="btn bare icon sm" data-del="${a.id}" title="Odebrat" aria-label="Odebrat účet">${IC.x}</button></span>` : ''}
      </div>`).join('') || '<div class="empty">Žádné účty</div>';

    const history = d.history.map((h) => {
      const cls = h.status === 'finished' ? (h.win ? 'w' : 'l') : '';
      const end = h.elo_after != null ? delta(h.elo_after - h.elo_before) : statusChip(h.status);
      return `<a class="hrow ${cls}" href="#/match/${h.id}"><span class="bar"></span>${roleIcon(h.role)}
        <div style="min-width:0"><div class="nm">${esc(h.champion || ROLE_LABEL[h.role])}${h.is_captain ? ` <span class="crown" title="Kapitán">${IC.crown}</span>` : ''}</div>
        <div class="meta">#${h.id}, ${fmtDate(h.created_at)}</div></div>
        <span class="kda">${h.kills != null ? `${h.kills}/${h.deaths}/${h.assists}` : ''}</span><span class="end">${end}</span></a>`;
    }).join('');

    const pct = (w, g) => Math.round((w / g) * 100);
    const roles = d.roles.map((r) => `<div class="srow">${roleIcon(r.role)}<span>${ROLE_LABEL[r.role]}</span>
      <span class="v">${r.games}×</span><span class="wrbar"><i style="width:${pct(r.wins, r.games)}%"></i></span><span class="v" style="margin-left:0;width:36px;text-align:right">${pct(r.wins, r.games)} %</span></div>`).join('');
    const champs = d.champions.map((c) => `<div class="srow"><span class="nm">${esc(c.champion)}</span>
      <span class="v">${c.games}×</span><span class="wrbar"><i style="width:${pct(c.wins, c.games)}%"></i></span><span class="v" style="margin-left:0;width:36px;text-align:right">${pct(c.wins, c.games)} %</span></div>`).join('');

    app.innerHTML = `
      <div class="phead">${avatar(u, 72)}
        <div><h1>${esc(u.username)}</h1><div class="muted">${d.rank ? `${d.rank}. místo v žebříčku` : 'Zatím bez zápasu'}</div></div>
        <div class="pelo"><b>${u.elo}</b><span>elo</span></div></div>
      <div class="strip">
        <div><b>${games}</b><span>Zápasy</span></div>
        <div><b><span class="ok">${u.wins}</span><span class="faint"> / </span><span class="bad">${u.losses}</span></b><span>Výhry / prohry</span></div>
        <div><b>${wr != null ? `${wr} %` : '–'}</b><span>Winrate</span></div>
        <div><b>${kda}</b><span>KDA</span></div>
        <div><b>${s.cs ? Math.round(s.cs) : '–'}</b><span>Ø CS</span></div>
      </div>
      <div class="cols">
        <div class="card"><div class="card-head"><h2>Historie</h2></div>
          ${history ? `<div class="list">${history}</div>` : '<div class="empty">Zatím žádné zápasy</div>'}</div>
        <div class="side-col">
          <div class="card"><div class="card-head"><h2>Účty</h2><span class="faint small">${d.accounts.length}/3</span></div>
            ${accounts}
            ${d.isMe && d.accounts.length < 3 ? `<form class="addf" id="add-acc">
              <input class="input" name="gameName" placeholder="Jméno" required maxlength="16" aria-label="Riot jméno">
              <input class="input" name="tagLine" placeholder="Tag" required maxlength="6" aria-label="Tag">
              <select class="input" name="region" aria-label="Region">${S.config.regions.map((r) => `<option ${r === 'EUNE' ? 'selected' : ''}>${r}</option>`).join('')}</select>
              <button class="btn icon" aria-label="Přidat účet">${IC.plus}</button></form>` : ''}
            ${d.isMe && !d.accounts.some((a) => a.is_main) ? '<p class="hint">Hlavní účet musí být EUNE.</p>' : ''}
          </div>
          ${roles ? `<div class="card"><div class="card-head"><h2>Role</h2></div>${roles}</div>` : ''}
          ${champs ? `<div class="card"><div class="card-head"><h2>Championi</h2></div>${champs}</div>` : ''}
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
    const rows = d.players.map((p, i) => {
      const wr = Math.round((p.wins / (p.wins + p.losses)) * 100);
      return `<a class="lrow" href="${profileHref(p.id)}"><span class="rank${i < 3 ? ' top' : ''}">${i + 1}</span>
        <span class="who">${avatar(p, 34)}<span class="nm">${esc(p.username)}</span></span>
        <span class="wl"><span class="ok">${p.wins}</span><span class="faint"> / </span><span class="bad">${p.losses}</span></span>
        <span class="wr"><span class="wrbar"><i style="width:${wr}%"></i></span>${wr} %</span>
        <span class="elo">${p.elo}</span></a>`;
    }).join('');
    app.innerHTML = `<h1 class="page-title">Žebříček</h1>
      <div class="card">${rows ? `<div class="list">${rows}</div>` : '<div class="empty">Zatím nikdo nedohrál zápas</div>'}</div>`;
  }

  async function viewMatches() {
    const d = await api('/api/matches');
    const row = (m) => {
      const team = (s) => m.players.filter((p) => p.team === s).map((p) => avatar({ id: p.user_id, username: p.username, avatar: p.avatar }, 26)).join('');
      return `<a class="mlrow" href="#/match/${m.id}"><span class="rank">#${m.id}</span>
        <span class="teams"><span class="avs blue">${team('BLUE')}</span><span class="faint small">vs</span><span class="avs red">${team('RED')}</span>
        ${m.winner ? sideChip(m.winner) : ''}</span>
        ${statusChip(m.status)}<span class="when">${fmtDate(m.created_at)}</span></a>`;
    };
    app.innerHTML = `<h1 class="page-title">Zápasy</h1>
      ${d.active.length ? `<div class="card"><div class="list">${d.active.map(row).join('')}</div></div>` : ''}
      <h2 class="section-title">Dohrané</h2>
      <div class="card">${d.recent.length ? `<div class="list">${d.recent.map(row).join('')}</div>` : '<div class="empty">Zatím žádné zápasy</div>'}</div>`;
  }

  // ─────────── časovače ───────────
  function tick() {
    document.querySelectorAll('.ring[data-deadline]').forEach((el) => {
      const total = Number(el.dataset.total);
      const left = Math.max(0, Number(el.dataset.deadline) - now());
      const c = Number(el.dataset.c);
      el.querySelector('.bar').style.strokeDashoffset = String(c * (1 - left / total));
      el.querySelector('.num').textContent = String(Math.ceil(left / 1000));
      el.classList.toggle('urgent', left < 10000);
    });
    document.querySelectorAll('[data-since]').forEach((el) => { el.textContent = fmtDur(now() - Number(el.dataset.since)); });
  }
  setInterval(tick, 250);

  // ─────────── socket události ───────────
  socket.on('queue_state', (q) => {
    syncTime(q.serverNow);
    S.queue = q;
    if (route().name === 'home') { renderQueue(); loadLive(); }
    renderDock();
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
    if (id === S.draftId) setTimeout(() => { if (S.draftId === id) location.hash = `#/match/${matchId}`; }, 2500);
  });
  socket.on('match_update', ({ id }) => { refreshMe(); if (String(id) === String(S.matchId)) viewMatch(String(id)); });
  socket.on('matches_changed', () => { if (route().name === 'home' && S.me) loadLive(); });
  socket.on('connect', () => {
    if (S.draftId) emit('draft_join', { id: S.draftId }).then((r) => { if (r?.state) { S.draft = r.state; S.chat = r.chat; renderDraft(); renderChat(); } });
    if (S.matchId) emit('match_join', { id: S.matchId });
  });

  // ─────────── start ───────────
  (async () => {
    S.config = await api('/api/config');
    await refreshMe();
    if (new URLSearchParams(location.search).get('error') === 'oauth') toast('Přihlášení přes Discord se nezdařilo', 'error');
    if (S.status?.draft && route().name === 'home') location.hash = `#/draft/${S.status.draft}`;
    render();
  })();
})();
