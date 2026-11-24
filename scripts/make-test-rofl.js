// Vytvoří FALEŠNÝ .rofl soubor pro zápas z databáze – jen pro testování nahrávání výsledku.
//   node scripts/make-test-rofl.js <matchId> <BLUE|RED vítěz> [výstup.rofl]
const fs = require('fs');
const db = require('../src/db');

const [matchId, winner = 'BLUE', out = `test-match-${matchId}.rofl`] = process.argv.slice(2);
if (!matchId) { console.log('Použití: node scripts/make-test-rofl.js <matchId> <BLUE|RED> [soubor]'); process.exit(1); }

const players = db.prepare(`SELECT p.team, p.role, a.game_name, a.tag_line FROM match_players p
  JOIN lol_accounts a ON a.user_id = p.user_id AND a.is_main = 1 WHERE p.match_id = ?`).all(matchId);
if (players.length !== 10) { console.log(`Zápas ${matchId} nemá 10 hráčů s hlavním účtem.`); process.exit(1); }

const champs = ['Ahri', 'Garen', 'LeeSin', 'Jinx', 'Thresh', 'Darius', 'Viego', 'Syndra', 'Kaisa', 'Nautilus'];
const r = (a, b) => String(a + Math.floor(Math.random() * (b - a)));
const stats = players.map((p, i) => ({
  NAME: p.game_name, RIOT_ID_GAME_NAME: p.game_name, RIOT_ID_TAG_LINE: p.tag_line,
  TEAM: p.team === 'BLUE' ? '100' : '200', WIN: p.team === winner ? 'Win' : 'Fail',
  SKIN: champs[i], TEAM_POSITION: p.role,
  CHAMPIONS_KILLED: r(0, 15), NUM_DEATHS: r(0, 10), ASSISTS: r(0, 20),
  MINIONS_KILLED: r(20, 250), NEUTRAL_MINIONS_KILLED: r(0, 40), GOLD_EARNED: r(6000, 16000),
  TOTAL_DAMAGE_DEALT_TO_CHAMPIONS: r(5000, 40000), VISION_SCORE: r(5, 80),
}));
const meta = JSON.stringify({ gameLength: 1800000 + Math.floor(Math.random() * 600000), gameVersion: '15.23.1', lastGameChunkId: 1, lastKeyFrameId: 1, statsJson: JSON.stringify(stats) });
const metaBuf = Buffer.from(meta, 'utf8');
const len = Buffer.alloc(4); len.writeUInt32LE(metaBuf.length);
const buf = Buffer.concat([Buffer.from('RIOT\0\0'), Buffer.alloc(400), Buffer.from(`${Math.random()}`), metaBuf, len]);
fs.writeFileSync(out, buf);
console.log(`Vytvořeno ${out} – vítěz ${winner}`);
