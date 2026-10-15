# Shade Pull Plan Tracker

Pull plan එක සහ SAP reports (ZMMBE, ZMMBE KFC, ZMMBE PFC, PLANT, TRR) upload කළ ගමන් calculation එක auto run වෙලා, open කරලා තියෙන හැම dashboard එකක්ම **realtime** update වෙන web app එකක්.

```
 Browser (Vercel)                        Cloudflare
 ┌──────────────────────┐   HTTPS    ┌──────────────────────────────┐
 │ Next.js dashboard     │ ─────────▶ │ Worker  /api/*               │
 │ - Excel read (SheetJS)│            │  - login (PBKDF2 + token)    │
 │ - column mapping      │            │  - upload → D1 (all-or-none) │
 │ - charts / table      │  WebSocket │  - Pull Plan calc (SQL)      │
 │ - Excel export        │ ◀════════▶ │ Durable Object "LiveHub"     │
 └──────────────────────┘            │  - pushes every change live   │
          ▲                          │ D1 database (SQLite)          │
   GitHub push → Vercel deploy       └──────────────────────────────┘
   GitHub push → Action deploys Worker
```

## Calculation එක (Excel එකේ Pull Plan sheet එකට සමානයි)

Key = `SO | LI | Item Code` (SAP වල තියෙන leading zeros සහ `.0` ඉවත් කරලා).

| Dashboard column | Excel formula එක | Source |
|---|---|---|
| UR / QI / Block / Assigned | `SUMIF(ZMMBE!A:A, key, G/L/M/N)` | ZMMBE |
| Variance | `QTY − Assigned` | |
| KFC UR / QI / Block | `SUMIF('ZMMBE KFC'…)` | ZMMBE KFC |
| PFC UR / QI / Block | `SUMIF('ZMMBE PFC'…)` | ZMMBE PFC |
| At plant | `SUMIF(PLANT!A:A, key, O)` (Total) | PLANT |
| Stock plant / St Loc | `VLOOKUP(ZMMBE…)`. මෙතන පළවෙනි එක විතරක් නෙමෙයි, තියෙන **හැම** plant/location එකක්ම පෙන්නනවා. | ZMMBE |
| TN QTY / TN number | `SUMIF(TRR, Q)` / `VLOOKUP(TRR, B)` | TRR |
| Coverage *(අලුත්)* | Covered = UR ≥ QTY · Partial · QI/Block only · No stock | |
| Short *(අලුත්)* | `max(QTY − UR, 0)` | |

Week 42 file එකෙන් test කළා: lines 1,137 × columns 13. Excel එකේ අගයන් එක්ක mismatches 0යි.

> KPI tiles වල stock totals ගණන් කරන්නේ එක key එකකට එක පාරයි. Plan එකේ එකම SO/LI/Item දෙපාරක් තිබුණොත් Excel column sum එකට වඩා අඩු අගයක් පේන්නේ ඒ නිසා.

## Upload කරන විදිහ

- සියලුම sheets තියෙන **එක workbook එකක්** (Pull Plan, ZMMBE, ZMMBE KFC, ZMMBE PFC, PLANT, TRR) drop කරන්න. Sheet name එකෙන් report type එක auto-detect වෙනවා. ඊට පස්සේ **Upload 6 sheets** click කරන්න.
- නැත්නම් report එකින් එක වෙනම files විදිහටත් upload කරන්න පුළුවන්.
- Columns හොයාගන්න ක්‍රම තුනක් තියෙනවා:
  1. Header row එකක් තියෙනවා නම් (SO, LI, Material, Unrestricted…) ඒකෙන්.
  2. ඔයාගේ දැන් workbook layout එකෙන් (column A එකේ key formula එක තියෙන විදිහ).
  3. Key column එක නැති raw SAP export layout එකෙන්.
  
  Preview එකේ වැරදියට map වෙලා තියෙන column එකක් තිබුණොත් dropdown එකෙන් වෙනස් කරලා Upload කරන්න.
- Report එකක් upload කළාම ඒ report එකේ කලින් data replace වෙනවා (all-or-nothing). Status, Comment, Vehicle edits SO|LI|Item key එකට save වෙන නිසා අලුත් plan එකක් upload කළත් ඒවා නැති වෙන්නේ නැහැ.

## Roles

| Role | කරන්න පුළුවන් දේ |
|---|---|
| admin | සේරම, ඊට අමතරව Users page එක සහ report data clear කරන එක |
| editor | Upload කරන්න, Status / Comment / Vehicle edit කරන්න |
| viewer | බලන්න සහ Excel export කරන්න විතරයි |

---

## Deploy කරන විදිහ (එක පාරක් කළාම ඇති)

ඕනේ වෙන්නේ: GitHub account, Cloudflare account (free plan එක ඇති), Vercel account (Hobby plan එක ඇති), ඔයාගේ computer එකේ Node.js 20+.

### 1. GitHub එකට දාන්න (browser එකෙන්)
1. GitHub එකේ **New repository** → නම `shade-tracker` → **Private** → **Create repository**.
2. **uploading an existing file** link එක click කරන්න.
3. Zip එක extract කරපු `shade-tracker` folder එක **ඇතුළට** යන්න. එතන තියෙන **හැම file එකක්ම folder එකක්ම** (`app`, `components`, `lib`, `worker`, `package.json` …) select කරලා (Ctrl+A) GitHub page එකට **drag** කරන්න.
   - Chrome හෝ Edge පාවිච්චි කරන්න. "choose your files" button එකෙන් folders select කරන්න බැහැ, drag කරන්නම ඕනේ.
   - `.github`, `.gitignore` පේන්නේ නැත්නම්: File Explorer → View → **Hidden items** ✔ කරන්න.
4. **Commit changes** click කරන්න.
5. Repo එකේ මුල් page එකේ `app`, `components`, `lib`, `worker` folders සහ `package.json` පේනවද බලන්න.

(Git පාවිච්චි කරනවා නම්: `git init && git add . && git commit -m init && git remote add origin <url> && git push -u origin main`)

### 2. Cloudflare: database එක සහ Worker එක
```bash
cd worker          # shade-tracker\worker folder එක
npm install
npx wrangler login                          # browser එකේ Cloudflare login එක open වෙනවා
npx wrangler d1 create shade-tracker        # ලැබෙන database_id එක copy කරගන්න
```
`worker/wrangler.toml` file එකේ `REPLACE_WITH_YOUR_D1_DATABASE_ID` තියෙන තැනට ඒ id එක දාන්න. ඊට පස්සේ:
```bash
npm run db:init                             # tables හදනවා
npx wrangler secret put JWT_SECRET          # දිග random text එකක් (උදා: openssl rand -hex 32)
npx wrangler secret put ADMIN_USER          # උදා: admin
npx wrangler secret put ADMIN_PASSWORD      # පළවෙනි admin password එක
npm run deploy
```
Deploy වුණාම `https://shade-tracker-api.<ඔයාගේ-subdomain>.workers.dev` වගේ URL එකක් ලැබෙනවා. `…/api/health` open කරලා `{"ok":true}` එනවද බලන්න.

### 3. Vercel: dashboard එක
1. Vercel → **Add New → Project** → ඔයාගේ GitHub repo එක Import කරන්න.
2. **Root Directory** එක වෙනස් කරන්න එපා (හිස්ව / `./` තියන්න). Framework එක **Next.js** කියලා auto-detect වෙනවා.
3. **Environment Variables** එකේ `NEXT_PUBLIC_API_URL` = පියවර 2 එකේ ලැබුණ Worker URL එක (අගට `/` දාන්න එපා).
4. **Deploy** කරන්න. `https://shade-tracker.vercel.app` වගේ URL එකක් ලැබෙනවා.

### 4. Lock down කරන්න
`worker/wrangler.toml` එකේ:
```toml
ALLOWED_ORIGINS = "https://shade-tracker.vercel.app"
```
ඊට පස්සේ `npm run deploy` කරන්න. දැන් ඔයාගේ Vercel site එකට විතරයි API එක පාවිච්චි කරන්න පුළුවන්.

### 5. පළවෙනි login එක
Vercel URL එක open කරලා `ADMIN_USER` / `ADMIN_PASSWORD` වලින් login වෙන්න. මේ secrets පාවිච්චි වෙන්නේ users කවුරුත් නැති වෙලාවට විතරයි. ඊට පස්සේ **Users** page එකෙන් අනිත් අයව add කරන්න.

### 6. Auto-deploy (GitHub → Cloudflare), optional
GitHub repo → Settings → Secrets → Actions එකේ secrets දෙකක් add කරන්න:
- `CLOUDFLARE_API_TOKEN`: Cloudflare dashboard → My Profile → API Tokens → "Edit Cloudflare Workers" template එක. ඒකට **D1 Edit** permission එකත් add කරන්න.
- `CLOUDFLARE_ACCOUNT_ID`: Cloudflare dashboard එකේ දකුණු පැත්තේ තියෙනවා.

මේක set කළාට පස්සේ `worker/` folder එකට push කරන හැම වෙලාවකම Worker එක auto deploy වෙනවා. අනිත් files වලට push කළාම Vercel auto deploy වෙනවා.

### Custom domain (Cloudflare DNS), optional
- Dashboard එකට: Vercel → Project → Domains → `tracker.yourdomain.com` add කරන්න. ඊට පස්සේ Cloudflare DNS එකේ `CNAME tracker → cname.vercel-dns.com` දාන්න (DNS only, grey cloud).
- API එකට: Cloudflare → Workers → shade-tracker-api → Settings → Domains & Routes → `api.yourdomain.com`. ඊට පස්සේ Vercel එකේ `NEXT_PUBLIC_API_URL` එක update කරලා redeploy කරන්න.

---

## Local එකේ run කරන්න
```bash
# Terminal 1: API
cd worker && npm install
cp .dev.vars.example .dev.vars              # local login: admin / admin123
npm run db:init:local
npm run dev                                  # http://127.0.0.1:8787

# Terminal 2: dashboard (repo root එකේ)
npm install
echo "NEXT_PUBLIC_API_URL=http://127.0.0.1:8787" > .env.local
npm run dev                                  # http://localhost:3000
```

## Files
```
worker/src/index.ts     API, calculation SQL, auth, LiveHub realtime Durable Object
worker/schema.sql       D1 tables
lib/mapping.ts          Excel sheet → columns (header / layout detection)
lib/live.ts             realtime client (WebSocket, auto-reconnect)
lib/calc.ts             coverage, totals, formatting
app/page.tsx            dashboard
app/upload/             uploads + column mapping
app/users/              user admin
```

## Limits සහ සටහන්
- Cloudflare free plan එකේ D1 limits: rows reads 5M/day, writes 100k/day. ඒ කියන්නේ ~2,000 rows reports දවසට uploads 40ක් වගේ ගණනකට ඇති.
- Excel files parse වෙන්නේ browser එක ඇතුළේ. Server එකට යවන්නේ map කරපු rows විතරයි, original file එක නෙමෙයි.
- `xlsx` (SheetJS) 0.18.5 තමයි npm එකේ තියෙන අලුත්ම version එක. SheetJS එකේ අලුත් versions download කරන්න පුළුවන් එයාලගේම CDN එකෙන් විතරයි. එහෙම upgrade කරන්න ඕනේ නම් `package.json` එකේ `"xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"` දාලා `npm install` කරන්න.
