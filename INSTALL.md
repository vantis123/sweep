# Install Sweep — step-by-step

For students who've never opened a terminal. Five minutes, one time.

---

## 1. Install Node.js

Sweep runs on Node.js. Get the **LTS** version (the green button) from:

→ [https://nodejs.org/en/download](https://nodejs.org/en/download)

Run the installer. Click Next through everything. Done.

> Already have Node? Make sure it's version 20 or higher. Run `node -v` in a terminal. If it prints `v20.x.x` or higher you're good.

---

## 2. Download Sweep

Either clone with git:

```bash
git clone https://github.com/vantis123/sweep.git
cd sweep
```

Or download the ZIP from GitHub → unzip it → drag the folder somewhere you'll remember (Desktop is fine).

---

## 3. First-time launch

### Mac

Double-click `Run Sweep.command` inside the Sweep folder.

> The first time Mac blocks unsigned scripts. Right-click the file → **Open** → click **Open** in the warning. Only have to do this once.

A terminal window opens, installs dependencies (takes about 3 minutes), then opens your browser to Sweep.

### Windows

Double-click `Run Sweep.bat` inside the Sweep folder.

Same thing — a window opens, installs dependencies, opens your browser.

### Command line (any OS)

```bash
cd sweep
npm install
npm start
```

---

## 4. Using Sweep

Browser opens to `http://localhost:7879`.

1. Pick the platform your client is on — **MyFreeScoreNow** or **IdentityIQ**.
2. Enter their login email and password.
3. For IIQ, enter the last 4 of their SSN (it's IIQ's login challenge).
4. Type your client's full name.
5. Hit **Pull report**.
6. A Chromium browser window pops up — that's Sweep logging in. Don't touch it.
7. ~60 seconds later you'll see the review screen with every negative item, every inquiry, and the personal-info section auto-filled.
8. Review, pick reasons, verify personal info, hit **Generate letters**.
9. PDFs land in the `letters/{client-name}/` folder inside Sweep.

---

## Where Sweep stores things

- **Reports + screenshots from the capture:** `~/.sweep/sandbox/`
- **Generated letters:** `letters/{client-name}/` inside the Sweep folder

Both are gitignored. Nothing leaves your machine.

---

## Troubleshooting

**"command not found: node"** — Node.js isn't installed or isn't in your PATH. Go back to step 1.

**Mac says "cannot be opened because the developer cannot be verified"** — right-click `Run Sweep.command` → Open → click Open in the dialog. One-time gatekeeper bypass.

**Login fails on first try** — IIQ sometimes hits a security question. Re-run with the last 4 of SSN field filled in. If it still fails, log in manually in your normal browser first to clear any new-device check.

**Port 7879 already in use** — close any other Sweep window, or run `PORT=7979 npm start` to use a different port.
