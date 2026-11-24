// Nahrání výsledku (ROFL) → potvrzení poraženým kapitánem → statistiky + elo
const crypto = require('crypto');
const db = require('./db');
const config = require('./config');
const bot = require('./bot');
const game = require('./game');
const { parseRofl } = require('./rofl');

const httpErr = (status, message) => Object.assign(new Error(message), { status });
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
const opposite = (side) => (side === 'BLUE' ? 'RED' : 'BLUE');

const getMatch = (id) => db.prepare('SELECT * FROM matches WHERE id = ?').get(id);
const getPlayers = (id) => db.prepare('SELECT * FROM match_players WHERE match_id = ?').all(id);
const captainOf = (m, side) => (side === 'BLUE' ? m.blue_captain : m.red_captain);
const username = (id) => db.prepare('SELECT username FROM users WHERE id = ?').get(id)?.username || id;

function uploadResult(matchId, userId, buffer, isAdmin) {
  const m = getMatch(matchId);
  if (!m) throw httpErr(404, 'Zápas neexistuje.');
  if (!['in_progress', 'disputed'].includes(m.status)) throw httpErr(400, 'Výsledek tohoto zápasu už byl nahrán.');
  const capSide = m.blue_captain === userId ? 'BLUE' : m.red_captain === userId ? 'RED' : null;
  if (!capSide && !isAdmin) throw httpErr(403, 'Výsledek může nahrát jen kapitán.');
  if (!buffer?.length) throw httpErr(400, 'Chybí soubor .rofl.');

  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  if (db.prepare('SELECT id FROM matches WHERE rofl_hash = ? AND id != ?').get(hash, matchId)) {
    throw httpErr(400, 'Tento replay už byl použit u jiného zápasu.');
  }

  let parsed;
  try { parsed = parseRofl(buffer); } catch (e) { throw httpErr(400, e.message); }

  // Spárovat hráče zápasu s hráči v replayi (přes PUUID nebo Riot ID kteréhokoli jejich účtu)
  const players = getPlayers(matchId);
  const accStmt = db.prepare('SELECT game_name, tag_line, puuid FROM lol_accounts WHERE user_id = ?');
  const used = new Set();
  const stats = {};
  const missing = [];
  for (const p of players) {
    const accs = accStmt.all(p.user_id);
    let found = -1;
    parsed.players.forEach((rp, i) => {
      if (found !== -1 || used.has(i)) return;
      const hit = accs.some((a) => (a.puuid && rp.puuid && a.puuid === rp.puuid)
        || (norm(rp.gameName) === norm(a.game_name) && (!rp.tagLine || norm(rp.tagLine) === norm(a.tag_line))));
      if (hit) found = i;
    });
    if (found === -1) { missing.push(username(p.user_id)); continue; }
    used.add(found);
    stats[p.user_id] = parsed.players[found];
  }
  if (missing.length) {
    throw httpErr(400, `V replayi chybí: ${missing.join(', ')}. Hráli na účtech, které mají v profilu?`);
  }
  const wrongSide = players.filter((p) => stats[p.user_id].team !== p.team);
  if (wrongSide.length) {
    throw httpErr(400, `Strany v replayi neodpovídají draftu (${wrongSide.map((p) => username(p.user_id)).join(', ')}).`);
  }
  const winners = new Set(Object.values(stats).filter((s) => s.win).map((s) => s.team));
  if (winners.size !== 1) throw httpErr(400, 'Z replaye nejde určit vítěze (hra byla nedohraná?).');
  const winner = [...winners][0];
  if (!isAdmin && capSide !== winner) {
    throw httpErr(403, `Podle replaye vyhrál ${winner}. Výsledek nahrává kapitán vítězného týmu.`);
  }

  db.prepare(`UPDATE matches SET status = 'awaiting_confirm', pending_json = ?, rofl_hash = ?, reported_by = ? WHERE id = ?`)
    .run(JSON.stringify({ winner, duration: parsed.gameLength, version: parsed.gameVersion, stats }), hash, userId, matchId);

  bot.dm(captainOf(m, opposite(winner)),
    `📥 Kapitán soupeře nahrál výsledek zápasu #${matchId} (vítěz ${winner}). Potvrď ho: ${config.baseUrl}/#/match/${matchId}`);
  game.emitMatchUpdate(matchId);
  return { winner };
}

function eloDelta(winners, losers) {
  const avg = (t) => t.reduce((s, p) => s + p.elo, 0) / t.length;
  const expected = 1 / (1 + 10 ** ((avg(losers) - avg(winners)) / 400));
  return Math.max(1, Math.round(config.elo.k * (1 - expected)));
}

function applyResult(m) {
  const pending = JSON.parse(m.pending_json);
  const { winner } = pending;
  const tx = db.transaction(() => {
    const eloOf = db.prepare('SELECT elo FROM users WHERE id = ?');
    const players = getPlayers(m.id).map((p) => ({ ...p, elo: eloOf.get(p.user_id).elo }));
    const delta = eloDelta(players.filter((p) => p.team === winner), players.filter((p) => p.team !== winner));
    const upP = db.prepare(`UPDATE match_players SET champion=?, kills=?, deaths=?, assists=?, cs=?, gold=?, damage=?, vision=?,
      win=?, elo_before=?, elo_after=? WHERE match_id=? AND user_id=?`);
    const upU = db.prepare('UPDATE users SET elo = ?, wins = wins + ?, losses = losses + ? WHERE id = ?');
    for (const p of players) {
      const s = pending.stats[p.user_id] || {};
      const win = p.team === winner;
      const after = Math.max(0, p.elo + (win ? delta : -delta));
      upP.run(s.champion || null, s.kills ?? null, s.deaths ?? null, s.assists ?? null, s.cs ?? null, s.gold ?? null,
        s.damage ?? null, s.vision ?? null, win ? 1 : 0, p.elo, after, m.id, p.user_id);
      upU.run(after, win ? 1 : 0, win ? 0 : 1, p.user_id);
    }
    db.prepare(`UPDATE matches SET status='finished', winner=?, game_duration=?, finished_at=? WHERE id=?`)
      .run(winner, pending.duration || null, Date.now(), m.id);
  });
  tx();
  bot.deleteMatchVoice(m.voice_json);
  bot.announce(`🏆 Zápas **#${m.id}** – vyhrál **${winner}**. ${config.baseUrl}/#/match/${m.id}`);
  game.emitMatchUpdate(m.id);
}

function confirmResult(matchId, userId, isAdmin) {
  const m = getMatch(matchId);
  if (!m) throw httpErr(404, 'Zápas neexistuje.');
  const allowed = isAdmin ? ['awaiting_confirm', 'disputed'] : ['awaiting_confirm'];
  if (!allowed.includes(m.status) || !m.pending_json) throw httpErr(400, 'Není co potvrzovat.');
  const { winner } = JSON.parse(m.pending_json);
  if (!isAdmin && userId !== captainOf(m, opposite(winner))) {
    throw httpErr(403, 'Výsledek potvrzuje kapitán poraženého týmu.');
  }
  applyResult(m);
}

function disputeResult(matchId, userId, isAdmin) {
  const m = getMatch(matchId);
  if (!m || m.status !== 'awaiting_confirm') throw httpErr(400, 'Výsledek nelze rozporovat.');
  const { winner } = JSON.parse(m.pending_json);
  if (!isAdmin && userId !== captainOf(m, opposite(winner))) throw httpErr(403, 'Rozporovat může jen kapitán poraženého týmu.');
  db.prepare(`UPDATE matches SET status = 'disputed' WHERE id = ?`).run(matchId);
  for (const a of config.admins) bot.dm(a, `⚠️ Výsledek zápasu #${matchId} byl rozporován: ${config.baseUrl}/#/match/${matchId}`);
  game.emitMatchUpdate(matchId);
}

function cancelMatch(matchId) {
  const m = getMatch(matchId);
  if (!m || ['finished', 'cancelled'].includes(m.status)) throw httpErr(400, 'Zápas nelze zrušit.');
  db.prepare(`UPDATE matches SET status = 'cancelled', finished_at = ? WHERE id = ?`).run(Date.now(), matchId);
  bot.deleteMatchVoice(m.voice_json);
  game.emitMatchUpdate(matchId);
}

module.exports = { uploadResult, confirmResult, disputeResult, cancelMatch };
