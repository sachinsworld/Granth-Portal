# Granth Portal: student + admin web app

A complete, self-hosted portal for monthly current-affairs practice (UPSC / UPPSC).
It has **real accounts** (email + password), a **student portal**, an **admin portal**, and a **database** (SQLite).
No npm install needed: it has zero dependencies.

## How the system is organised

There are **three kinds of practice sections**:

1. **Current Affairs (month-wise):** the built-in January–September 2026 questions. They are not tagged by subject or exam.
2. **Subject-wise:** subjects such as Polity, History, Geography, Economy. Students pick one or several and practise.
3. **Exam-wise:** an exam (UPSC, UPPSC, SSC...) is made of subjects. Students open an exam, see its subjects and take a full mock test.

The Subject-wise and Exam-wise sections start **empty**. You fill them from the admin portal.

### Setting it up (admin portal)
1. **Exams & Subjects:** edit the starter lists (add, rename, delete). Choose which subjects belong to each exam and set each exam's mock-test length and minutes.
2. **Add questions:** pick a **subject**, tick the **exam(s)** the questions help with, optionally a topic and default level. Then add questions:
   * one at a time with the form (with an optional explanation shown after the test), or
   * many at once by pasting text, or uploading a **PDF / TXT / JSON / CSV** file. A CSV template can be downloaded from the page
     (columns: `question,a,b,c,d,answer,level,explanation,topic`).
3. **Manage questions:** search, edit (text, options, answer, level, topic, exam tags), hide or delete any question.
4. **Tests:** publish a timed test to students built from current-affairs months, chosen subjects, or an exam (mixed evenly across the exam's subjects).

A question tagged with an exam appears in that exam's section **and** in its subject. A question with no exam tag appears only in Subject-wise.

### Students get
Dashboard with accuracy by month, by subject and exam readiness; Current Affairs, Subject-wise and Exam-wise practice with timer, negative marking and mock tests;
assigned tests; a mistake notebook; question bank; flagging; profile and password change.

### Admins get
First-run setup; approve / reject / revoke students; make other admins; reset passwords; overview analytics by month, subject and exam;
per-student results (CSV); Exams & Subjects manager; question adding and editing; test builder; announcements; add new current-affairs months from a PDF;
database page (tables, settings, audit log); full backup and restore.

## 1. Run it on your own computer (2 minutes)

1. Install Node.js 22 or newer from nodejs.org (Node 18/20 also work, using a JSON file instead of SQLite).
2. Open a terminal in this folder and run: `node server.js`
3. Visit http://localhost:3000
4. The first visit shows **"create the administrator account"**. Fill it in. That is your admin login.
5. Share the address with students; they use **New student? Sign up**.

Data is saved in the `data/` folder (`granth.db`). Daily backup copies go to `data/backups/`.

## 2. Put it online: where to upload

This app needs a place that runs Node.js. With SQLite (default) it also needs a **persistent disk**; with MongoDB Atlas (section 2b) it does not.
That rules out static hosts (GitHub Pages, Netlify, Vercel) and free tiers that wipe the disk or sleep.

| Option | Cost (check current prices) | Effort | Good for |
|---|---|---|---|
| **VPS** (Hetzner, DigitalOcean, AWS Lightsail Mumbai, Hostinger) | about $4–6 / month | Medium | **Best value and full control.** Recommended for a real class |
| **Railway** | about $5 / month usage | Easy | Quick deploy from GitHub with a Volume |
| **Render** (paid Web Service + Disk) | about $7 / month + disk | Easy | Uses the included `render.yaml` |
| **Fly.io** | small monthly cost | Medium | Docker + Volume |
| **cPanel "Setup Node.js App"** (shared hosting) | cheap | Medium | Works if your host offers Node 18+ |

**Always:** use HTTPS, point the database at persistent storage (`DATA_DIR`), and keep backups.

### Option A: VPS with Docker (recommended)
1. Create an Ubuntu VPS; point your domain's A record to its IP.
2. Install Docker: `curl -fsSL https://get.docker.com | sh`
3. Upload this folder (e.g. with `scp -r granth-portal user@SERVER:~`), then:
   ```
   cd granth-portal
   docker build -t granth-portal .
   docker run -d --name granth --restart unless-stopped -p 127.0.0.1:3000:3000 -v granth-data:/data granth-portal
   ```
4. HTTPS with Caddy (auto certificates): install Caddy, then in `/etc/caddy/Caddyfile`:
   ```
   yourdomain.com {
     reverse_proxy 127.0.0.1:3000
   }
   ```
   and run `sudo systemctl reload caddy`.
5. Open https://yourdomain.com and create the admin account.

### Option B: VPS without Docker
Install Node 22, upload the folder, run `npm i -g pm2 && pm2 start server.js --name granth && pm2 save && pm2 startup`,
then use Caddy as above.

### Option C: Railway
1. Put this folder in a GitHub repo. In Railway: New Project → Deploy from GitHub.
2. Add a **Volume** mounted at `/data`, and set variable `DATA_DIR=/data`.
3. Generate a domain (or add your own). Open it and create the admin account.

### Option D: Render
1. Push to GitHub. In Render: New → Blueprint → select the repo (it reads `render.yaml`).
2. It creates the web service, a 1 GB disk at `/data`, and a random `SESSION_SECRET`.

## 2b. Use MongoDB (MongoDB Atlas) instead of SQLite

Optional. MongoDB Atlas is a hosted database with a free tier. Your website still needs a host (Railway, Render, a VPS),
but the data lives in Atlas, so it survives restarts and you **do not need a persistent disk** on the host.

1. Create an account at mongodb.com/atlas and create a free cluster (choose a region near your students, for example Mumbai).
2. **Database Access → Add New Database User**: choose a username and a strong password (avoid special characters, or URL-encode them).
3. **Network Access → Add IP Address**: cloud hosts use changing IPs, so allow `0.0.0.0/0` (anywhere). This is only safe with a strong password. If your host gives you a fixed IP, add just that.
4. **Connect → Drivers**: copy the connection string, which looks like
   `mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority`. Put your real password in it.
5. On your host, add the variable `MONGODB_URI` with that string (optionally `MONGODB_DB=granth`) and redeploy.
   The deploy runs `npm install`, which fetches the MongoDB driver automatically.
6. Open the logs: you should see `database: mongodb`. Open the site and create the admin account.
   The admin **Database** page now shows *Engine: MongoDB*.

**Moving existing data from SQLite to MongoDB:** on the old site download *Database → Full backup*. Deploy with `MONGODB_URI`, create the
admin account on the new site, then use *Database → Restore* with that file. It replaces everything, including accounts.

To go back to SQLite, remove `MONGODB_URI`.

## 3. Settings (environment variables)

See `.env.example`. The important ones: `DATA_DIR` (persistent folder), `SESSION_SECRET` (long random text; auto-generated if empty),
`ADMIN_EMAIL` + `ADMIN_PASSWORD` (optional: auto-create the first admin on a headless host), `MONGODB_URI` / `MONGODB_DB` (optional: use MongoDB instead of SQLite).

## 4. Backups and safety

* Admin → **Database** → *Download full backup* gives one JSON file with everything (accounts include password hashes: keep it private).
  *Restore* replaces all data from such a file.
* The server also keeps 7 daily copies in `DATA_DIR/backups/`. Copy them off the server regularly (cloud storage, another machine).
* Passwords are stored as salted scrypt hashes. Sessions are signed HttpOnly cookies. Login attempts are rate limited.
  The server checks every permission itself (students cannot read other students' results, change tests, or approve themselves).
* There is no email service, so **password resets are done by an admin** (Admin → Registrations → Reset password).
* Students' private progress (mistake notebook) is stored in an area that even admin screens do not read.

## 5. Good to know

* Capacity: one small server comfortably handles hundreds of students; SQLite is fine at this scale.
* Importing a PDF as a new month uses a PDF reader loaded from the internet (cdnjs), so the *browser* needs a connection. Scanned PDFs do not work.
* Auto-generated questions from imported PDFs are lower quality than the hand-written ones; review them.
* Questions you add through the admin portal live in the database, so they survive restarts and updates.
* To change the app itself, replace `public/index.html` (and `server.js` if told to) and restart. Your database is untouched.
* Health check URL: `/healthz`.
