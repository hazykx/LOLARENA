# LoL INHOUSE – web + Discord bot

Node.js aplikace (Express + Socket.IO + SQLite + discord.js). Web i bot běží v **jednom procesu**.

## Co umí
- **Přihlášení přes Discord** (OAuth2, scope `identify`)
- **Fronta** – hráč si vybere roli, ve frontě může být neomezeně lidí. Hraje vždy prvních 2 hráčů z každé role (podle času připojení), ostatní čekají.
- **ACCEPT** – po nalezení 10 hráčů má každý 60 s na přijetí. Kdo odmítne / nestihne, vypadne z fronty; ostatní se vrací na své původní místo.
- **Draft** – náhodně se vybere role kapitánů (oba kapitáni jsou z ní), los určí, kdo začíná.
  - Kapitán 1 volí **A) první výběr hráče** (→ kapitán 2 volí stranu) nebo **B) stranu** (→ kapitán 2 vybírá prvního hráče).
  - 4 kola na přeskáčku: kapitán vybere hráče z role, druhý hráč téže role automaticky připadne soupeři.
  - 30 s na každou volbu, po vypršení se volí náhodně.
  - Chat **pro všechny** a **týmový chat**.
- **Zápas** – vygeneruje se název lobby + heslo, bot vytvoří 2 voice roomky (BLUE/RED), pošle hráčům odkazy do DM a zobrazí je i na webu.
- **Výsledek** – kapitán vítězného týmu nahraje `.rofl`. Web z něj přečte vítěze a statistiky (champion, KDA, CS, gold, damage, vision), zkontroluje, že hráči a strany sedí s draftem. Kapitán poraženého týmu výsledek **potvrdí** (nebo rozporuje → řeší admin). Pak se zapíšou statistiky, přepočítá elo (Elo, K=32, start 1000) a bot smaže voice roomky.
- **Profil** – 1–3 LoL účty, hlavní musí být EUNE; statistiky, role, championi, historie.
- **Žebříček** a **seznam zápasů**.

## Nastavení Discordu
1. https://discord.com/developers/applications → **New Application**
2. **OAuth2** → zkopíruj *Client ID* a *Client Secret* → přidej Redirect: `BASE_URL/auth/discord/callback`
   (lokálně `http://localhost:3000/auth/discord/callback`)
3. **Bot** → *Reset Token* → zkopíruj token.
4. Pozvi bota na server: OAuth2 → URL Generator → scope `bot`, oprávnění:
   **View Channels, Manage Channels, Manage Roles, Create Invite, Connect, Send Messages**.
5. V Discordu zapni *Nastavení → Rozšířené → Režim vývojáře* a zkopíruj ID serveru (a případně kategorie / kanálu).

## Spuštění
```bash
npm install
cp .env.example .env   # vyplň hodnoty
npm start              # http://localhost:3000
```
Potřebuješ Node.js 22. Databáze se vytvoří sama v `data/inhouse.db`.

## Testování bez 10 lidí
V `.env` nastav `DEV_LOGIN=true` (a třeba `PICK_SECONDS=15`), spusť server a v druhém terminálu:
```bash
node scripts/simulate.js        # 9 botů – ty se připoj na SUPPORT jako 10. hráč
node scripts/simulate.js 10     # 10 botů – celý flow proběhne sám
node scripts/make-test-rofl.js 1 RED   # falešný .rofl pro zápas #1 (vyhrál RED)
PASSIVE=1 node scripts/simulate.js 9   # boti v draftu nevolí – můžeš draftovat ručně
OFFSET=7 node scripts/simulate.js 3    # přidá jen Bot8–Bot10 (ADC, 2× SUPPORT)
```
Testovacího hráče přihlásíš přes `http://localhost:3000/auth/dev?name=Jmeno`.

## Nasazení na Railway
Aplikace nepotřebuje žádný konfigurační soubor – Railway pozná Node.js a spustí `npm start`.

1. **New Project → Deploy from GitHub repo** → vyber tento repozitář
   (poprvé tě Railway pošle nainstalovat GitHub aplikaci – povol jí přístup k repu).
2. **Volume (důležité!)** – na plátně projektu klikni pravým na službu → **Attach Volume** → Mount path `/data`.
   Bez volume se databáze (hráči, elo, zápasy) při každém redeployi smaže. Aplikace volume najde sama.
3. **Doména** – služba → *Settings → Networking → Generate Domain*. Adresu webu (`BASE_URL`) si aplikace vezme sama.
4. **Variables** – služba → *Variables* → přidej:

   | Proměnná | Povinná | Hodnota |
   |---|---|---|
   | `DISCORD_CLIENT_ID` | ano | z Discord Developer Portalu |
   | `DISCORD_CLIENT_SECRET` | ano | z Discord Developer Portalu |
   | `DISCORD_BOT_TOKEN` | pro voice roomky | token bota |
   | `DISCORD_GUILD_ID` | pro voice roomky | ID serveru |
   | `ADMIN_DISCORD_IDS` | doporučeno | tvoje Discord ID (víc oddělit čárkou) |
   | `DISCORD_VOICE_CATEGORY_ID`, `DISCORD_ANNOUNCE_CHANNEL_ID`, `RIOT_API_KEY` | ne | viz `.env.example` |

   `BASE_URL`, `PORT`, `SESSION_SECRET` a `DB_FILE` **nevyplňuj**. `DEV_LOGIN` na produkci nezapínej.
5. **Discord redirect** – v Developer Portalu → OAuth2 → Redirects přidej
   `https://<tvoje-domena>.up.railway.app/auth/discord/callback`.
6. (doporučeno) *Settings → Deploy → Healthcheck Path* = `/health`. Počet replik nech na **1**.

Každý push do `main` spustí nový deploy. Při redeployi se vyprázdní fronta a zruší rozběhnutý draft;
hráči zůstávají přihlášení a dokončené zápasy i elo zůstávají v databázi.

Logy najdeš ve službě → *Deployments → View Logs*. Když tam uvidíš „Běžíš na Railway bez volume“, chybí krok 2.

## Nasazení na vlastní server
- Nastav `BASE_URL=https://tvoje-domena.cz` a `DEV_LOGIN=false`.
- Za reverse proxy (nginx/Caddy) povol WebSockety.
- Spouštěj přes `pm2 start src/server.js --name inhouse` nebo systemd.

## Omezení (MVP)
- Fronta, accept a rozběhnuté drafty jsou v paměti – restart/redeploy je zruší (dokončené zápasy, elo a přihlášení zůstávají v DB).
- Běží jen jako 1 instance (fronta je v paměti procesu).
- ROFL parser podporuje starý i nový formát replaye, ale je otestovaný na syntetickém souboru – ověř ho na reálném replayi z vaší custom hry.

## Struktura
```
src/server.js    HTTP API, Discord OAuth, Socket.IO
src/game.js      fronta, accept, draft, chat
src/results.js   nahrání ROFL, potvrzení, elo
src/rofl.js      parser .rofl
src/bot.js       Discord bot (voice roomky, DM, oznámení)
src/db.js        SQLite schéma
src/session-store.js  přihlášení uložená v SQLite
public/          frontend (HTML/CSS/JS bez buildu)
scripts/         testovací nástroje
```
