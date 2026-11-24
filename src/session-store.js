// Ukládá přihlášení (session) do SQLite, takže hráči zůstanou přihlášení i po redeployi.
const session = require('express-session');

class SqliteStore extends session.Store {
  constructor(db) {
    super();
    this.q = {
      get: db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expires > ?'),
      set: db.prepare(`INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires`),
      destroy: db.prepare('DELETE FROM sessions WHERE sid = ?'),
      touch: db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?'),
      prune: db.prepare('DELETE FROM sessions WHERE expires <= ?'),
    };
    this.q.prune.run(Date.now());
    setInterval(() => this.q.prune.run(Date.now()), 3600000).unref();
  }

  static expiry(sess) {
    const e = sess?.cookie?.expires;
    return e ? new Date(e).getTime() : Date.now() + 86400000;
  }

  get(sid, cb) {
    try {
      const row = this.q.get.get(sid, Date.now());
      cb(null, row ? JSON.parse(row.sess) : null);
    } catch (e) { cb(e); }
  }

  set(sid, sess, cb) {
    try { this.q.set.run(sid, JSON.stringify(sess), SqliteStore.expiry(sess)); cb?.(null); } catch (e) { cb?.(e); }
  }

  destroy(sid, cb) {
    try { this.q.destroy.run(sid); cb?.(null); } catch (e) { cb?.(e); }
  }

  touch(sid, sess, cb) {
    try { this.q.touch.run(SqliteStore.expiry(sess), sid); cb?.(null); } catch (e) { cb?.(e); }
  }
}

module.exports = SqliteStore;
