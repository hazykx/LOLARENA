// Fronta → potvrzení hry (ACCEPT) → draft kapitánů → vytvoření zápasu
const crypto = require('crypto');
const db = require('./db');
const config = require('./config');
const bot = require('./bot');

const ROLES = config.roles;
let io = null;

const queue = [];                 // { userId, role, joinedAt }
const readyChecks = new Map();    // id -> ready check
const drafts = new Map();         // id -> draft
const userState = new Map();      // userId -> { type: 'ready' | 'draft', id }
const disconnectTimers = new Map();

const other = (t) => (t === 'A' ? 'B' : 'A');
const pickRandom = (arr) => arr[crypto.randomInt(arr.length)];
const userRoom = (id) => `user:${id}`;
const opposite = (side) => (side === 'BLUE' ? 'RED' : 'BLUE');

const stmtUser = db.prepare('SELECT id, username, avatar, elo FROM users WHERE id = ?');
function pub(id) {
  return stmtUser.get(id) || { id, username: 'Neznámý', avatar: null, elo: config.elo.start };
}

function init(_io) { io = _io; }

function activeMatchId(userId) {
  const r = db.prepare(`SELECT m.id FROM matches m JOIN match_players p ON p.match_id = m.id
    WHERE p.user_id = ? AND m.status IN ('in_progress','awaiting_confirm','disputed') LIMIT 1`).get(userId);
  return r ? r.id : null;
}
function hasMainAccount(userId) {
  return !!db.prepare('SELECT 1 FROM lol_accounts WHERE user_id = ? AND is_main = 1 AND region = ?')
    .get(userId, config.mainRegion);
}

function getUserStatus(userId) {
  const q = queue.find((e) => e.userId === userId);
  const st = userState.get(userId);
  return {
    queue: q ? { role: q.role, joinedAt: q.joinedAt } : null,
    readyCheck: st?.type === 'ready' ? st.id : null,
    draft: st?.type === 'draft' ? st.id : null,
    activeMatch: activeMatchId(userId),
  };
}

// ───────────────────────── Fronta ─────────────────────────
function queueSnapshot() {
  return {
    serverNow: Date.now(),
    entries: [...queue].sort((a, b) => a.joinedAt - b.joinedAt)
      .map((e) => ({ user: pub(e.userId), role: e.role, joinedAt: e.joinedAt })),
    readyChecks: readyChecks.size,
    drafts: [...drafts.values()].filter((d) => d.phase !== 'done')
      .map((d) => ({ id: d.id, captains: [pub(d.captains.A), pub(d.captains.B)] })),
  };
}
function broadcastQueue() { io?.emit('queue_state', queueSnapshot()); }

function joinQueue(userId, role) {
  if (!ROLES.includes(role)) throw new Error('Neplatná role.');
  if (!hasMainAccount(userId)) throw new Error('Nejdřív si v profilu přidej hlavní EUNE účet.');
  const st = userState.get(userId);
  if (st) throw new Error(st.type === 'ready' ? 'Právě probíhá potvrzení hry.' : 'Právě jsi v draftu.');
  if (activeMatchId(userId)) throw new Error('Máš rozehraný zápas – nejdřív musí být potvrzen jeho výsledek.');

  const existing = queue.find((e) => e.userId === userId);
  if (existing) {
    if (existing.role === role) return;
    existing.role = role;            // změna role = nové místo ve frontě
    existing.joinedAt = Date.now();
  } else {
    queue.push({ userId, role, joinedAt: Date.now() });
  }
  tryMatch();
}

function leaveQueue(userId) {
  const i = queue.findIndex((e) => e.userId === userId);
  if (i === -1) return false;
  queue.splice(i, 1);
  broadcastQueue();
  return true;
}

// Kdo se dřív připojí, ten hraje: z každé role první 2 hráči podle času připojení.
function tryMatch() {
  for (;;) {
    const sorted = [...queue].sort((a, b) => a.joinedAt - b.joinedAt);
    const picked = Object.fromEntries(ROLES.map((r) => [r, []]));
    for (const e of sorted) if (picked[e.role].length < 2) picked[e.role].push(e);
    if (!ROLES.every((r) => picked[r].length === 2)) break;
    const entries = ROLES.flatMap((r) => picked[r]);
    for (const e of entries) queue.splice(queue.indexOf(e), 1);
    startReadyCheck(entries);
  }
  broadcastQueue();
}

// ───────────────────────── ACCEPT ─────────────────────────
function startReadyCheck(entries) {
  const id = crypto.randomUUID();
  const ms = config.timers.readyCheck * 1000;
  const rc = { id, entries, accepted: new Set(), deadline: Date.now() + ms };
  rc.timer = setTimeout(() => endReadyCheck(rc, null, false), ms);
  readyChecks.set(id, rc);
  for (const e of entries) userState.set(e.userId, { type: 'ready', id });
  emitReady(rc);
  bot.notifyReadyCheck(entries.map((e) => e.userId)).catch(() => {});
}

function readyPayload(rc, userId) {
  return {
    id: rc.id, deadline: rc.deadline, serverNow: Date.now(),
    total: rc.entries.length, accepted: rc.accepted.size,
    you: rc.accepted.has(userId), role: rc.entries.find((e) => e.userId === userId)?.role,
  };
}
function emitReady(rc) {
  for (const e of rc.entries) io.to(userRoom(e.userId)).emit('ready_check', readyPayload(rc, e.userId));
}

function respondReady(userId, id, accept) {
  const rc = readyChecks.get(id);
  if (!rc || !rc.entries.some((e) => e.userId === userId)) throw new Error('Potvrzení hry už neplatí.');
  if (!accept) return endReadyCheck(rc, userId, false);
  rc.accepted.add(userId);
  if (rc.accepted.size === rc.entries.length) endReadyCheck(rc, null, true);
  else emitReady(rc);
}

function endReadyCheck(rc, declinedBy, success) {
  if (!readyChecks.has(rc.id)) return;
  clearTimeout(rc.timer);
  readyChecks.delete(rc.id);
  for (const e of rc.entries) userState.delete(e.userId);

  if (success) {
    for (const e of rc.entries) io.to(userRoom(e.userId)).emit('ready_end', { success: true });
    startDraft(rc.entries);
    broadcastQueue();
    return;
  }
  // Kdo přijal, vrací se na své PŮVODNÍ místo ve frontě. Kdo odmítl / nestihl, vypadává.
  for (const e of rc.entries) {
    const ok = rc.accepted.has(e.userId) && e.userId !== declinedBy;
    if (ok && !queue.some((q) => q.userId === e.userId)) queue.push({ userId: e.userId, role: e.role, joinedAt: e.joinedAt });
    io.to(userRoom(e.userId)).emit('ready_end', {
      success: false,
      message: ok ? 'Někdo hru nepřijal. Vracíš se do fronty na své původní místo.'
        : 'Hru jsi nepřijal – byl jsi odebrán z fronty.',
    });
  }
  tryMatch();
}

// ───────────────────────── DRAFT ─────────────────────────
// Fáze: choice (kapitán A volí "první pick" nebo "strana") → side → pick ×4 → done
function startDraft(entries) {
  const id = crypto.randomUUID();
  const captainRole = pickRandom(ROLES);
  const caps = entries.filter((e) => e.role === captainRole).map((e) => e.userId);
  if (crypto.randomInt(2)) caps.reverse();               // los, kdo začíná

  const pool = {};
  for (const r of ROLES) if (r !== captainRole) pool[r] = entries.filter((e) => e.role === r).map((e) => e.userId);

  const d = {
    id, createdAt: Date.now(), captainRole,
    captains: { A: caps[0], B: caps[1] },
    roles: Object.fromEntries(entries.map((e) => [e.userId, e.role])),
    pool,
    teams: {
      A: [{ userId: caps[0], role: captainRole, round: 0, captain: true }],
      B: [{ userId: caps[1], role: captainRole, round: 0, captain: true }],
    },
    side: { A: null, B: null },
    firstChoice: null, firstPicker: null,
    phase: 'choice', actor: 'A', round: 0,
    deadline: 0, timer: null, log: [],
    chat: { all: [], A: [], B: [] },
  };
  drafts.set(id, d);
  for (const e of entries) {
    userState.set(e.userId, { type: 'draft', id });
    io.in(userRoom(e.userId)).socketsJoin(`draft:${id}`);
  }
  io.in(userRoom(caps[0])).socketsJoin(`draft:${id}:A`);
  io.in(userRoom(caps[1])).socketsJoin(`draft:${id}:B`);

  log(d, `Kapitáni (${captainRole}): ${pub(caps[0]).username} a ${pub(caps[1]).username}. Los: začíná ${pub(caps[0]).username}.`);
  armTimer(d);
  for (const e of entries) io.to(userRoom(e.userId)).emit('draft_start', { id });
  bot.announce(`⚔️ Draft začal! Kapitáni: **${pub(caps[0]).username}** vs **${pub(caps[1]).username}** – ${config.baseUrl}/#/draft/${id}`).catch(() => {});
}

function log(d, text) { d.log.push({ ts: Date.now(), text }); }
function teamOf(d, uid) {
  if (d.teams.A.some((p) => p.userId === uid)) return 'A';
  if (d.teams.B.some((p) => p.userId === uid)) return 'B';
  return null;
}

function publicDraft(d) {
  const mapTeam = (t) => d.teams[t].map((p) => ({ ...p, user: pub(p.userId) }));
  return {
    id: d.id, phase: d.phase, actor: d.actor, round: d.round, totalRounds: ROLES.length - 1,
    captainRole: d.captainRole,
    captains: { A: pub(d.captains.A), B: pub(d.captains.B) },
    side: d.side, firstChoice: d.firstChoice, firstPicker: d.firstPicker,
    teams: { A: mapTeam('A'), B: mapTeam('B') },
    pool: Object.fromEntries(Object.entries(d.pool).map(([r, ids]) => [r, ids.map(pub)])),
    participants: Object.keys(d.roles),
    deadline: d.deadline, serverNow: Date.now(), log: d.log.slice(-30), matchId: d.matchId || null,
  };
}
function emitDraft(d) { io.to(`draft:${d.id}`).emit('draft_state', publicDraft(d)); }

function armTimer(d) {
  clearTimeout(d.timer);
  const ms = config.timers.draftPick * 1000;
  d.deadline = Date.now() + ms;
  d.timer = setTimeout(() => {
    try { autoAct(d); } catch (e) { console.error('[draft] auto', e); }
  }, ms);
}

function joinTeamRoom(d, uid, t) {
  io.in(userRoom(uid)).socketsJoin(`draft:${d.id}:${t}`);
  io.to(userRoom(uid)).emit('draft_team_chat', { id: d.id, messages: d.chat[t] });
}

function draftJoin(socket, userId, id) {
  const d = drafts.get(id);
  if (!d) return { error: 'Draft neexistuje nebo už skončil.' };
  socket.join(`draft:${id}`);
  const t = userId ? teamOf(d, userId) : null;
  if (t) socket.join(`draft:${id}:${t}`);
  return { state: publicDraft(d), chat: { all: d.chat.all, team: t ? d.chat[t] : [] } };
}

function draftAction(userId, id, action) {
  const d = drafts.get(id);
  if (!d || d.phase === 'done') throw new Error('Draft už skončil.');
  if (d.captains[d.actor] !== userId) throw new Error('Teď nejsi na tahu.');
  applyAction(d, action || {}, false);
}

function autoAct(d) {
  if (d.phase === 'done') return;
  if (d.phase === 'choice') return applyAction(d, { value: pickRandom(['pick', 'side']) }, true);
  if (d.phase === 'side') return applyAction(d, { value: pickRandom(['BLUE', 'RED']) }, true);
  return applyAction(d, { userId: pickRandom(Object.values(d.pool).flat()) }, true);
}

function applyAction(d, action, auto) {
  const name = pub(d.captains[d.actor]).username;
  const sfx = auto ? ' (automaticky – vypršel čas)' : '';

  if (d.phase === 'choice') {
    if (!['pick', 'side'].includes(action.value)) throw new Error('Neplatná volba.');
    d.firstChoice = action.value;
    if (action.value === 'pick') {
      d.firstPicker = d.actor;
      log(d, `${name} si zvolil PRVNÍ VÝBĚR HRÁČE${sfx}. Soupeř volí stranu.`);
      d.actor = other(d.actor);
    } else {
      d.firstPicker = other(d.actor);
      log(d, `${name} si zvolil VÝBĚR STRANY${sfx}. Soupeř bude vybírat prvního hráče.`);
    }
    d.phase = 'side';
  } else if (d.phase === 'side') {
    if (!['BLUE', 'RED'].includes(action.value)) throw new Error('Neplatná strana.');
    d.side[d.actor] = action.value;
    d.side[other(d.actor)] = opposite(action.value);
    log(d, `${name} hraje na ${action.value}${sfx}.`);
    d.phase = 'pick';
    d.actor = d.firstPicker;
  } else if (d.phase === 'pick') {
    const target = action.userId;
    const role = Object.keys(d.pool).find((r) => d.pool[r].includes(target));
    if (!role) throw new Error('Tento hráč už není k výběru.');
    const rest = d.pool[role].find((x) => x !== target);
    d.round += 1;
    d.teams[d.actor].push({ userId: target, role, round: d.round, picked: true });
    d.teams[other(d.actor)].push({ userId: rest, role, round: d.round, picked: false });
    delete d.pool[role];
    joinTeamRoom(d, target, d.actor);
    joinTeamRoom(d, rest, other(d.actor));
    log(d, `${name} vybral ${pub(target).username} (${role})${sfx} → ${pub(rest).username} jde k soupeři.`);
    if (Object.keys(d.pool).length === 0) return finishDraft(d);
    d.actor = other(d.actor);
  }
  armTimer(d);
  emitDraft(d);
}

function draftChat(userId, id, channel, text) {
  const d = drafts.get(id);
  if (!d) throw new Error('Draft neexistuje.');
  if (!d.roles[userId]) throw new Error('Chatovat mohou jen hráči této hry.');
  text = String(text || '').trim().slice(0, 300);
  if (!text) return;
  let room = `draft:${id}`;
  let key = 'all';
  if (channel === 'team') {
    const t = teamOf(d, userId);
    if (!t) throw new Error('Ještě nejsi v žádném týmu.');
    room += `:${t}`;
    key = t;
  }
  const u = pub(userId);
  const message = { id: crypto.randomUUID(), channel: key === 'all' ? 'all' : 'team',
    user: { id: u.id, username: u.username, avatar: u.avatar }, text, ts: Date.now() };
  d.chat[key].push(message);
  if (d.chat[key].length > 200) d.chat[key].shift();
  io.to(room).emit('draft_chat', { id, message });
}

function randomPassword(n = 6) {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: n }, () => abc[crypto.randomInt(abc.length)]).join('');
}

function finishDraft(d) {
  clearTimeout(d.timer);
  d.phase = 'done';
  const teamOfSide = (side) => (d.side.A === side ? 'A' : 'B');

  const create = db.transaction(() => {
    const info = db.prepare(`INSERT INTO matches (status, captain_role, blue_captain, red_captain, draft_json, created_at)
      VALUES ('in_progress', ?, ?, ?, ?, ?)`).run(
      d.captainRole, d.captains[teamOfSide('BLUE')], d.captains[teamOfSide('RED')],
      JSON.stringify({ log: d.log, firstChoice: d.firstChoice, firstPickerSide: d.side[d.firstPicker] }), Date.now(),
    );
    const matchId = Number(info.lastInsertRowid);
    db.prepare('UPDATE matches SET lobby_name = ?, lobby_password = ? WHERE id = ?')
      .run(`INHOUSE ${matchId}`, randomPassword(), matchId);
    const ins = db.prepare(`INSERT INTO match_players (match_id, user_id, team, role, is_captain, pick_round, picked)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const t of ['A', 'B']) {
      for (const p of d.teams[t]) ins.run(matchId, p.userId, d.side[t], p.role, p.captain ? 1 : 0, p.round, p.picked ? 1 : 0);
    }
    return matchId;
  });
  const matchId = create();
  d.matchId = matchId;
  log(d, `Draft dokončen – zápas #${matchId} vytvořen.`);

  for (const uid of Object.keys(d.roles)) userState.delete(uid);
  emitDraft(d);
  io.to(`draft:${d.id}`).emit('draft_done', { id: d.id, matchId });
  setTimeout(() => drafts.delete(d.id), 10 * 60 * 1000);
  broadcastQueue();
  io.emit('matches_changed');

  const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
  const teams = {
    BLUE: d.teams[teamOfSide('BLUE')].map((p) => p.userId),
    RED: d.teams[teamOfSide('RED')].map((p) => p.userId),
  };
  bot.createMatchVoice(m, teams)
    .then((voice) => {
      if (!voice) return;
      db.prepare('UPDATE matches SET voice_json = ? WHERE id = ?').run(JSON.stringify(voice), matchId);
      emitMatchUpdate(matchId);
    })
    .catch((e) => console.error('[bot] voice', e.message));
}

function emitMatchUpdate(matchId) {
  io?.to(`match:${matchId}`).emit('match_update', { id: Number(matchId) });
  io?.emit('matches_changed');
}

// ─────────────── připojení / odpojení socketů ───────────────
function onConnect(socket, userId) {
  const t = disconnectTimers.get(userId);
  if (t) { clearTimeout(t); disconnectTimers.delete(userId); }
  const st = userState.get(userId);
  if (st?.type === 'ready') {
    const rc = readyChecks.get(st.id);
    if (rc) socket.emit('ready_check', readyPayload(rc, userId));
  }
  if (st?.type === 'draft') socket.join(`draft:${st.id}`);
}

async function onDisconnect(userId) {
  if ((await io.in(userRoom(userId)).fetchSockets()).length) return;
  if (!queue.some((e) => e.userId === userId)) return;
  const t = setTimeout(async () => {
    disconnectTimers.delete(userId);
    if (!(await io.in(userRoom(userId)).fetchSockets()).length && leaveQueue(userId)) {
      console.log(`[queue] ${userId} odebrán z fronty (odpojen)`);
    }
  }, config.timers.disconnectGrace * 1000);
  disconnectTimers.set(userId, t);
}

module.exports = {
  init, joinQueue, leaveQueue, queueSnapshot, broadcastQueue, getUserStatus,
  respondReady, draftJoin, draftAction, draftChat, emitMatchUpdate, onConnect, onDisconnect,
  userRoom, isInQueue: (uid) => queue.some((e) => e.userId === uid),
};
