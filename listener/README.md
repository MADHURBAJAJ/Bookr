# Bookr WhatsApp listener

A small program for the billing PC. It is linked to the reception number as a WhatsApp linked device (like WhatsApp Web)
and **only reads**. From the groups chosen in Bookr (Settings → WhatsApp groups) it picks up photos and PDF bills, and
sends them to Bookr. There they are read, paired and shown under **WhatsApp** for review.

**What it never does:**

- send a message or a reaction;
- mark anything as read (the blue ticks);
- show the number as online or typing;
- change a group or a setting.

`src/guard.js` stops the WhatsApp library itself from doing any of these, and `npm test` proves it with the real
library. Every hour the log has a `SENT … | BLOCKED …` line, and `npm run check-log` reads those lines and confirms it.

**What it skips without downloading:** private chats, groups not chosen in Bookr, text, voice notes, videos, stickers,
and files over 10 MB.

**Before you start:** WhatsApp does not officially allow programs like this, and could restrict a number that uses one.
The listener keeps the risk low: it is read-only, does little, and never sends anything. The owner accepted this risk
for the reception number. Try it on a test number first.

---

## 1. Try it first with a test number

You can do this on any computer, against Bookr on that computer or against the demo site.

**In Bookr:**

1. Set the secret the listener will use, at least 16 random characters.
   - Local: add `WA_INGEST_SECRET=...` to `.dev.vars`.
   - Demo: run `npx wrangler secret put WA_INGEST_SECRET`.
2. Run the migrations (`0039_whatsapp.sql`).

**In this folder:**

```
npm ci
copy .env.example .env      (Mac: cp .env.example .env)
```

Edit `.env`:

- `BOOKR_URL`: `http://127.0.0.1:8787` for local, or the demo site's address.
- `BOOKR_SECRET`: the same value as `WA_INGEST_SECRET`.

Then:

```
npm run link
```

A QR appears. On the **test** phone, go to WhatsApp → Settings → Linked devices → Link a device, and scan it. The program
says "Linked" and stops by itself after 20 seconds.

```
npm start
```

Within a minute, the test number's groups appear in Bookr under Settings → WhatsApp groups, under "Seen by the
listener, not read". Press **Read** on one test group and set its department.

Within the next minute, the listener starts reading that group (its log says "Reading 1 group"). Post a UPI screenshot
in the group, then a bill photo as a reply to it. Both appear under **WhatsApp** in Bookr within a minute, paired.

**Check these:**

| What | How |
|---|---|
| The photo appears within a minute, with the amount and UTR read | Post one in the test group |
| A bill sent right after is paired with it | Reply to the screenshot with the bill photo |
| The same image forwarded twice gives one item | Forward it again; the log says "not stored (same file)" |
| Messages sent while the listener was off appear after it starts | Stop it (Ctrl+C), post, start it again |
| Nothing from other groups or private chats | Post in one; nothing in Bookr, nothing in `data\` |
| It never sends anything | `npm run check-log` says OK; on the phone, nothing was read or sent |
| The warning in Bookr when it stops | Stop it; after 30 minutes the red banner shows on WhatsApp in Bookr |

When you are done, remove the test PC from the test phone (Linked devices), and delete `auth\`.

---

## 2. Set it up on the billing PC (Windows)

**You need:**

- Windows 10 or 11.
- Node.js 22 LTS (20 or newer works). Get it from nodejs.org, using the "Windows Installer (.msi)", with default options.
- The PC set never to sleep: Settings → System → Power → Screen and sleep → Sleep: **Never**. The listener can only
  read while the PC is on. Messages from a short time off are caught up when it starts again.

**Steps.** Open **PowerShell as administrator** (Start → type PowerShell → right-click → Run as administrator):

1. Put this folder at `C:\BookrListener`: copy the `listener` folder from the Bookr repo, or clone the repo and copy
   it from there.
2. `cd C:\BookrListener`
3. `npm ci`
4. `copy .env.example .env`, then `notepad .env`. Set `BOOKR_URL` to the live address and `BOOKR_SECRET` to the live
   `WA_INGEST_SECRET`. Save.
5. `npm run link`. On the **reception phone**: WhatsApp → Settings → Linked devices → Link a device, and scan the QR.
   Wait for "Linked".
6. `powershell -ExecutionPolicy Bypass -File windows\install-task.ps1`
7. `Start-ScheduledTask -TaskName 'Bookr WhatsApp listener'`

**What step 6 does:**

- It adds a Windows task, **Bookr WhatsApp listener**. The task starts the listener one minute after Windows starts,
  even when nobody signs in.
- Every 5 minutes it checks the listener is running, and starts it again if it stopped. Only one copy ever runs.
- It locks the folder so only Windows itself (SYSTEM) and administrators can open it. `auth\` holds the WhatsApp login.
  Anyone who copies it can read the reception number's messages.

**Check it:**

- Within a minute of step 7, Bookr's WhatsApp screen has no red banner.
- Settings → WhatsApp groups lists the reception number's groups.
- On the reception phone, Linked devices shows the PC as **Chrome (Windows)**.

**After a restart:** it starts again by itself. To check, open `C:\BookrListener\logs\` (the newest file) or Bookr.

---

## 3. Everyday

- **Choosing groups:** in Bookr, Settings → WhatsApp groups. Changes reach the listener within a minute. Nothing needs
  to be done on the PC. To limit this PC further, put group ids in `groups.txt` (one per line) and set
  `GROUPS_FILE=groups.txt` in `.env`. A group is read only when it is on both lists.
- **The log:** `logs\listener-YYYY-MM-DD.log`, in India time, kept for 30 days. It holds ids, group names and what was
  done, never message text.
- **Proof it sends nothing:** run `npm run check-log` (in an administrator PowerShell, in the folder). It reads every
  hourly `SENT … | BLOCKED …` line:
  - SENT lists only the protocol traffic any linked device sends (delivery receipts, acknowledgements, queries).
  - BLOCKED should always be `none`.
- **Files Bookr refused** (not a photo or PDF, too large) are kept in `data\failed\` for a look. They are never sent
  again.

## 4. When something is wrong

| Bookr or the log says | Do this |
|---|---|
| Red banner "Listener offline since …" | Is the PC on and online? In PowerShell (admin): `Get-ScheduledTask -TaskName 'Bookr WhatsApp listener'`, then look at the newest log |
| Log: "This PC is not linked" or "WhatsApp logged this PC out" | Relink (below). WhatsApp unlinks a device that has been off for about two weeks, or that was removed on the phone |
| Log: "Bookr refused the secret" | `BOOKR_SECRET` in `.env` must equal `WA_INGEST_SECRET` in Bookr |
| Log: "The send guard cannot be put in place" | The WhatsApp library changed. Keep the version in `package.json` and run `npm ci`. Update `src/guard.js` only with a developer |
| Log: "Gave up downloading" | WhatsApp no longer has that photo. Ask for it to be sent again |

**Relink** (in an administrator PowerShell, in the folder):

```
Stop-ScheduledTask -TaskName 'Bookr WhatsApp listener'
npm run link
Start-ScheduledTask -TaskName 'Bookr WhatsApp listener'
```

**Move to another number** (for example from the test number to reception): stop the task, delete `auth\`, then relink
with the other phone.

**Remove it:**

1. Run `powershell -ExecutionPolicy Bypass -File windows\uninstall-task.ps1`.
2. On the phone, remove the PC under Linked devices.
3. Delete the folder.

## 5. For developers

- `npm test` runs the tests (Node's own test runner, no build step).
  - `test/readonly.test.js` drives the real WhatsApp library and asks it to send a message, a reaction, read receipts,
    online status and typing. It checks the guard stops each one, and that a stand-in WhatsApp server receives nothing
    but frames the guard allowed. It also checks our code never calls a sending function.
- The WhatsApp library (`baileys`) is pinned to an exact version. Before you update it:
  1. Run `npm test`.
  2. Read its `lib/Socket/socket.js`. Every frame must still go through `sendNode`, which shows it to the logger first.
  3. The listener checks this at start-up and refuses to run when it is not so.
- Calls to Bookr:
  - `POST /api/wa/ingest`: multipart, with `meta` and `file`.
  - `POST /api/wa/heartbeat`: every minute. Bookr answers with `readGroups`.
  - Both send the secret in the `X-Bookr-WA-Secret` header. See `src/routes/wa.ts` in Bookr.
- Never commit `.env`, `auth/`, `data/` or `logs/`. The repo's `.gitignore` keeps them out.
