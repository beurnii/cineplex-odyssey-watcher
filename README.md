# Cineplex "The Odyssey" IMAX 70mm date watcher — Montréal

> ### ⚠️ Currently in test mode
>
> The cutoff in `check-cineplex.mjs` is temporarily **`2026-09-15T00:00:00Z`**
> instead of the real `2026-09-16T00:00:00Z`. That makes the date Cineplex
> already offers (`2026-09-16T00:00:00`) count as a detection, so the full
> alert path runs for real and you get the ten notification emails.
>
> **To return to normal watching, both steps are required:**
> 1. set `CUTOFF_ISO` back to `"2026-09-16T00:00:00Z"` in `check-cineplex.mjs`
> 2. delete `.alert-state.json` from the repository
>
> Doing only step 1 leaves the state file in place and the watcher stays quiet.
> Doing only step 2 restarts a fresh sequence of ten test alerts.

A self-contained GitHub Actions service that watches the Cineplex API for new
bookable dates for **The Odyssey** and emails you when they appear.

It runs entirely on GitHub's servers. Nothing runs on your computer, and it
keeps working when your computer is off.

There is no npm package to install, no server to rent, no API account to
create, and no secret to store.

---

## Contents

- [How it works](#how-it-works)
- [Key facts](#key-facts)
- [Read this before you deploy: Actions minutes](#read-this-before-you-deploy-actions-minutes)
- [About the subscription key](#about-the-subscription-key)
- [About the cutoff and time zones](#about-the-cutoff-and-time-zones)
- [The ten-alert sequence](#the-ten-alert-sequence)
- [Setup, entirely in a web browser](#setup-entirely-in-a-web-browser)
- [Testing it](#testing-it)
- [Reading the workflow logs](#reading-the-workflow-logs)
- [Telling a real alert from a technical failure](#telling-a-real-alert-from-a-technical-failure)
- [Resetting the watcher](#resetting-the-watcher)
- [Changing the settings](#changing-the-settings)
- [Limitations you should know about](#limitations-you-should-know-about)
- [Troubleshooting](#troubleshooting)

---

## How it works

Every 15 minutes GitHub runs a small Node.js script. The script asks Cineplex
which dates are currently bookable for The Odyssey, and compares them against a
cutoff date.

The clever part is how it emails you. GitHub does not offer "send me an email"
as a workflow action, but it *does* email you when a workflow **fails**. So
when the watcher finds a new date, it deliberately fails the workflow. That
failure is the notification.

To avoid a single alert being easy to miss, the watcher repeats that deliberate
failure on each of the next ten runs, then goes quiet.

```
                 ┌──────────────────────────────┐
   every 15 min  │  Does .alert-state.json       │
   ───────────►  │  exist in the repository?     │
                 └───────────┬──────────────────┘
                             │
              ┌──────────────┴───────────────┐
             NO                              YES
              │                               │
              ▼                               ▼
   ┌─────────────────────┐        ┌──────────────────────────┐
   │ Call the Cineplex   │        │ Have 10 alerts been sent? │
   │ API. Any date after │        └────────┬─────────────────┘
   │ the cutoff?         │                 │
   └──────┬──────────────┘         ┌───────┴────────┐
          │                       NO                YES
    ┌─────┴──────┐                 │                 │
   NO           YES                ▼                 ▼
    │            │        ┌──────────────────┐  ┌──────────────┐
    ▼            ▼        │ counter += 1     │  │ Log "all 10  │
┌────────┐  ┌──────────┐  │ commit the file  │  │ already sent"│
│ succeed│  │ write    │  │ then FAIL        │  │ then succeed │
│ quietly│  │ the file │  └──────────────────┘  └──────────────┘
└────────┘  │ commit it│
            │ then FAIL│
            └──────────┘
```

The order matters enormously: **the state file is committed and pushed before
the workflow fails.** If it failed first, the new counter value would be thrown
away with the job, every run would look like alert number one, and you would be
emailed forever.

---

## Key facts

| Thing | Value |
|---|---|
| API endpoint | `https://apis.cineplex.com/prod/cpx/theatrical/api/v1/dates/bookable` |
| Film ID | `37617` (The Odyssey) |
| Location | `9406` — Cinéma Banque Scotia Montréal |
| Experience filter | `imax-70mm` (IMAX 70mm, 15-perf) |
| Cutoff | `2026-09-16T00:00:00Z` (UTC) — ⚠️ **temporarily set to `2026-09-15T00:00:00Z` for testing**, see below |
| Trigger condition | any bookable date **strictly later** than the cutoff |
| Schedule | `7,22,37,52 * * * *` — four times an hour, UTC |
| Alerts per detection | 10 |
| Time to receive them all | roughly 2.5 hours |
| State file | `.alert-state.json`, committed to the default branch |
| Dependencies | none |
| Secrets required | none |

The full request is:

```text
https://apis.cineplex.com/prod/cpx/theatrical/api/v1/dates/bookable?filmId=37617&locationId=9406&experiences=imax-70mm
```

which currently returns a plain list of 44 dates:

```json
["2026-08-03T00:00:00","2026-08-04T00:00:00", ... ,"2026-09-16T00:00:00"]
```

Three observations about that response, all of which shaped the code:

0. **It is scoped to one cinema.** Without `locationId` the API answers for all
   of Canada: 45 dates starting 2026-08-03. With `locationId=9406` it answers
   for Montréal only: 44 dates starting 2026-08-04. The **last** date is
   `2026-09-16` either way today, which is why the cutoff is the same for both.
   An unknown `locationId` returns HTTP 200 with `[]` rather than an error, so
   the checker warns loudly whenever the list comes back empty.
1. **It is a bare array with no object keys at all.** An extractor that only
   trusted values found under a key named `date`/`dates` would find nothing
   here and would silently never alert. The extractor therefore accepts any
   string that is *entirely* an ISO-8601 date, and only uses key names as a
   tie-breaker if the response ever gains a wrapper object.
2. **The last date it returns is currently `2026-09-16T00:00:00` — exactly the
   cutoff.** This is why the comparison must be strictly greater-than. A
   `>=` comparison would fire immediately and burn all ten alerts on day one.

> **Note on the experience filter.** `imax-70mm` means **IMAX 70mm** (15-perf) —
> the premium format. It is not the same as `70mm`, which also matches plain
> 5-perf 70mm prints. Both formats really are showing this film: on 2026-08-04
> the API reported 32 sessions tagged `["IMAX","70mm"]` across 8 theatres, plus
> 14 sessions tagged only `["70mm"]` at 4 other theatres.
>
> On the `dates/bookable` endpoint specifically, `imax-70mm`, `70mm` and `imax`
> currently return an **identical** list of 45 dates, because the film happens
> to play in IMAX 70mm on every day of its run. Using `imax-70mm` still matters:
> if Cineplex ever opens plain-70mm dates without IMAX 70mm, the correct filter
> is what stops you being alerted for the wrong format.
>
> **The value is case-sensitive and fails silently.** `IMAX`, `70MM`,
> `IMAX 70mm` and `imax70mm` all return HTTP 200 with `[]` rather than an error
> — which is indistinguishable from "this film has finished its run", and would
> mean the watcher never alerts. The checker prints a loud warning whenever the
> list comes back empty, for exactly this reason.

---

## Read this before you deploy: Actions minutes

> **This repository is deliberately public, and that is why.** Public
> repositories get unlimited free Actions minutes, so the 15-minute schedule
> runs uninterrupted. Nothing here is sensitive — the only key involved is
> Cineplex's own public client-side key, which their website already serves to
> every visitor. If you switch this repository to Private, read this section
> first and change the schedule to match.

**This is the one thing most likely to quietly break your watcher.**

GitHub Actions is free and unmetered for **public** repositories. For
**private** repositories, a GitHub Free account includes **2,000 minutes per
month**, and GitHub **rounds every job up to the nearest whole minute** — a job
that takes 15 seconds is billed as one minute.

Do the arithmetic for a 15-minute schedule:

```
 4 runs/hour x 24 hours       =    96 runs per day
96 runs/day x ~30.4 days      = ~2,918 runs per month
                              = ~2,918 billed minutes per month
```

That is roughly **46% over** the 2,000 free minutes. On a private repository
with a Free account, Actions will stop running about **three weeks into each
billing month**. GitHub Pro's 3,000 minutes covers it, but only barely.

Pick one of these:

| Option | What to do | Result |
|---|---|---|
| **Make the repository public** *(recommended)* | Create it as Public instead of Private | Unlimited free minutes, keeps the full 15-minute cadence. There is nothing sensitive in this repository — see [About the subscription key](#about-the-subscription-key). |
| **Keep it private, check every 30 minutes** | Change the cron to `7,37 * * * *` | ~1,460 minutes/month, comfortably inside the free tier. You would learn about new dates up to 30 minutes later. |
| **Keep it private, only watch during the day** | Change the cron to `7,22,37,52 11-23 * * *` | ~1,580 minutes/month. Covers 7am–7pm Eastern, when box-office systems actually update. |
| **Keep it private and 15-minute** | Change nothing | Works for ~3 weeks per month, then pauses until your quota resets on the 1st. |

You can check your usage any time at
**[github.com/settings/billing](https://github.com/settings/billing)**.

---

## About the subscription key

The spec for this project asked for no secrets. That turned out to need one
small caveat, so here it is plainly.

`apis.cineplex.com` sits behind Azure API Management. Calling the endpoint with
no key returns:

```json
{ "statusCode": 401, "message": "Access denied due to missing subscription key. ..." }
```

The key the script sends, `dcdac5601d864addbc2675a2e96cb1f8`, is the **public,
client-side key that Cineplex ships inside their own website's JavaScript**.
Every visitor's browser already sends that exact value on every page view. It
is not yours, it grants no account access, and it identifies no user. It is
configuration, not a credential.

That is why it sits in plain sight in `check-cineplex.mjs` and why this project
needs no GitHub Secret. The watcher makes four requests an hour — far less
traffic than a single person browsing the site.

If Cineplex ever rotates that key you will start getting HTTP 401 failures. You
can fix it without touching the code — see
[Troubleshooting → HTTP 401](#http-401-access-denied-due-to-missing-subscription-key).

---

## About the cutoff and time zones

The cutoff you asked for was `2026-09-16T00:00:00`, with no time zone. The code
uses **`2026-09-16T00:00:00Z`**, explicitly UTC. Here is why that matters.

JavaScript parses a naive date-*time* like `2026-09-16T00:00:00` as **local**
time, but a naive date-*only* string like `2026-09-16` as **UTC**. Those two
rules disagree, and the disagreement is not theoretical:

```text
On a machine set to America/Toronto:
  Date.parse("2026-09-16T00:00:00")   ->  1789531200000
  Date.parse("2026-09-16T00:00:00Z")  ->  1789516800000   (4 hours earlier)
```

The API returns naive timestamps. If they were parsed as local time and
compared against a UTC cutoff, the date `2026-09-16T00:00:00` — which is
currently the *last bookable date* and must **not** trigger — would look four
hours later than the cutoff and fire a false alarm immediately.

So the script normalises explicitly: **any timestamp with no time zone is
interpreted as UTC**, and the cutoff is UTC. Both sides then follow the same
rule, and the result is identical no matter which machine or region runs it.
Every value the API returns is a midnight day-marker, so treating them as UTC
day labels is the correct reading.

This is verified by tests that run the checker under `America/Toronto` and
`Pacific/Auckland` and confirm the cutoff-equal date does not trigger.

---

## The ten-alert sequence

| Run | `.alert-state.json` | What happens | Outcome |
|---|---|---|---|
| Before detection | absent | Calls the API. Nothing later than the cutoff. | ✅ success, no email |
| Detection | created, `alertsSent: 1` | Logs the dates, writes the file, **commits it**, then fails | ❌ failure → email 1 |
| Next run | `alertsSent: 2` | Skips the API, increments, **commits**, then fails | ❌ failure → email 2 |
| … | … | … | … |
| 10th alert | `alertsSent: 10` | Increments, **commits**, then fails | ❌ failure → email 10 |
| 11th run onward | `alertsSent: 10` | Logs "all 10 already triggered" | ✅ success, no email |

Once an alert sequence has started, the watcher **stops calling the Cineplex
API**. The detection already happened, so re-checking could only introduce new
ways to fail. It also means the sequence finishes even if Cineplex goes down
halfway through.

The state file looks like this:

```json
{
  "detectedAt": "2026-09-01T14:07:11.482Z",
  "lastAlertAt": "2026-09-01T16:22:09.115Z",
  "alertsSent": 10,
  "maximumAlerts": 10,
  "dates": [
    "2026-09-17T00:00:00",
    "2026-09-18T00:00:00"
  ],
  "cutoff": "2026-09-16T00:00:00Z",
  "filmId": "37617",
  "experiences": "70mm",
  "note": "Delete this file from the repository to reset the watcher and allow a new sequence of alerts."
}
```

---

## Setup, entirely in a web browser

These instructions assume Windows 11 and a web browser. You never need Git,
Node.js, a terminal, or WSL.

### Step 1 — Create the repository

1. Go to **[github.com/new](https://github.com/new)**.
2. **Repository name**: `cineplex-odyssey-watcher`
3. **Description** (optional): `Watches Cineplex for new 70mm Odyssey dates`
4. Choose **Private**, or **Public** if you followed the
   [Actions minutes](#read-this-before-you-deploy-actions-minutes) advice.
5. Tick **Add a README file**. (This creates the default branch, which the
   watcher needs in order to commit its state file.)
6. Click **Create repository**.

### Step 2 — Add `check-cineplex.mjs`

1. On the repository home page, click **Add file** → **Create new file**.
2. In the filename box at the top, type: `check-cineplex.mjs`
3. Paste in the entire contents of `check-cineplex.mjs`.
4. Scroll down, click **Commit changes…**, then **Commit changes**.

### Step 3 — Add the workflow

1. Click **Add file** → **Create new file** again.
2. In the filename box, type this **exactly**, including the slashes:

   ```text
   .github/workflows/check-cineplex.yml
   ```

   GitHub turns each `/` into a folder as you type. That is expected.
3. Paste in the entire contents of `check-cineplex.yml`.
4. Click **Commit changes…**, then **Commit changes**.

> YAML is whitespace-sensitive. Paste it exactly as given — do not re-indent it.

### Step 4 — Add `.gitignore`

1. Click **Add file** → **Create new file**.
2. Filename: `.gitignore`
3. Paste in the contents of `.gitignore`.
4. Click **Commit changes…**, then **Commit changes**.

> Never add `.alert-state.json` to this file. The workflow must be able to
> commit it.

### Step 5 — Replace the README (optional)

1. Click `README.md`, then the pencil (**Edit this file**) icon.
2. Select everything, paste this document in, and commit.

### Step 6 — Allow the workflow to commit

This is required. Without it, the workflow cannot save its counter and you
would be emailed forever.

1. In your repository, click **Settings** (the tab, not your profile settings).
2. In the left sidebar: **Actions** → **General**.
3. Scroll to **Workflow permissions**.
4. Select **Read and write permissions**.
5. Click **Save**.

```text
Settings > Actions > General > Workflow permissions > Read and write permissions
```

### Step 7 — Confirm Actions is enabled

1. Click the **Actions** tab.
2. If you see a button offering to enable workflows, click it.
3. You should see **Cineplex Odyssey 70mm watcher** listed on the left.

### Step 8 — Turn on failure emails

The whole notification mechanism depends on this.

1. Click your **profile photo** (top right) → **Settings**.
2. In the left sidebar, click **Notifications**.
3. Find the **Actions** section (it may be grouped under **System**).
4. Make sure **Email** is ticked.
5. If you see an option along the lines of *"Send notifications for failed
   workflows only"*, tick it. That is exactly what this project produces, and
   it keeps your inbox quiet the rest of the time.
6. Confirm your email address is **verified**, at
   **[github.com/settings/emails](https://github.com/settings/emails)**. GitHub
   will not send to an unverified address.

> GitHub occasionally rewords these settings. If the labels differ slightly,
> look for the Actions/workflow-run notification option on the Notifications
> page and enable email for it.

### Step 9 — Prove it works

Run both tests in [Testing it](#testing-it) below. Do the forced test first —
it confirms email delivery end to end before you rely on it.

---

## Testing it

### Test A — a normal run

Confirms the watcher can reach Cineplex and read the dates.

1. **Actions** tab → click **Cineplex Odyssey 70mm watcher** on the left.
2. Click **Run workflow** (top right).
3. Leave `force_alert` **unticked**.
4. Click the green **Run workflow** button.
5. Refresh, then click into the run.

Expected: a **green tick**. Open the **Run checker** step and you will see the
raw list of dates and:

```text
NO QUALIFYING DATES. Nothing to do.
Latest bookable date: 2026-09-16T00:00:00
Cutoff (UTC):         2026-09-16T00:00:00Z
```

No email. No `.alert-state.json` in your repository.

### Test B — a forced alert (checks your email actually arrives)

1. **Actions** → **Cineplex Odyssey 70mm watcher** → **Run workflow**.
2. **Tick** the `force_alert` checkbox.
3. Click **Run workflow**.

Expected: a **red X**, and an email from GitHub within a few minutes.

The log will say, unmistakably:

```text
*  FORCED TEST ALERT - this is a DRILL, not a real detection.
```

This drill:

- does **not** call the Cineplex API,
- does **not** create or modify `.alert-state.json`,
- does **not** change your real alert counter,
- does **not** affect the real watcher in any way.

You can run it during an active alert sequence and the counter will not move.

If no email arrives, revisit [Step 8](#step-8--turn-on-failure-emails) and check
your spam folder.

### Test C — confirm the schedule is live

Scheduled runs only begin once the workflow file is on the **default branch**,
which it is if you followed the steps above.

Wait until the next `:07`, `:22`, `:37` or `:52` **UTC**, plus a delay — GitHub
frequently starts scheduled runs 5–15 minutes late, and sometimes much later.
Then check the **Actions** tab for a run whose trigger says **Scheduled**
rather than "Manually run by …".

If nothing has appeared after an hour, see
[Troubleshooting → scheduled runs never start](#scheduled-runs-never-start).

---

## Reading the workflow logs

1. **Actions** tab.
2. Click the run you want (red X = failed, green tick = fine).
3. Click the **Check for new 70mm dates** job on the left.
4. Click any step to expand it. **Run checker** has the interesting output.

Every run prints the raw API response, so you can always see exactly what
Cineplex returned. It contains only public show dates — there are no secrets in
this project to leak.

Failed runs also show a red annotation banner at the top of the run summary
page. Its title tells you immediately which kind of failure it was.

---

## Telling a real alert from a technical failure

Both arrive as "workflow failed" emails, so the workflow labels them clearly.
Look at the annotation title at the top of the run:

| Annotation title | Meaning | What to do |
|---|---|---|
| `Cineplex Odyssey 70mm alert` | **Real detection.** A bookable date later than the cutoff exists. | Go book tickets. |
| `TEST ALERT (drill, not a real Odyssey date)` | You ticked `force_alert`. | Nothing. |
| `Odyssey watcher TECHNICAL FAILURE` | Something broke: API down, HTTP error, bad JSON, push rejected. | See [Troubleshooting](#troubleshooting). |

A real alert also prints a block like this in the log:

```text
===================================================================
 CINEPLEX ODYSSEY 70mm ALERT 3 OF 10
===================================================================
Cutoff (UTC):     2026-09-16T00:00:00Z
Qualifying dates: 2026-09-17T00:00:00, 2026-09-18T00:00:00
```

A technical failure prints:

```text
======================================================================
TECHNICAL FAILURE: Cineplex API returned HTTP 503 Service Unavailable
======================================================================
...
This is NOT a Cineplex date alert. Nothing was written to
.alert-state.json, and your alert counter was not changed.
```

A technical failure never writes state and never consumes an alert, so a
Cineplex outage cannot use up your ten notifications.

> The failure email GitHub sends is generic and may not list the dates. The
> dates are always in the log, and in the run's **Summary** page.

---

## Resetting the watcher

Deleting the state file fully resets everything.

1. In your repository, click **`.alert-state.json`**.
2. Click the **⋯** menu (top right of the file view) → **Delete file**.
   (On some layouts this is a trash-can icon.)
3. Scroll down, click **Commit changes…**, then **Commit changes**.

The very next run will call the Cineplex API again from scratch. If a
qualifying date still exists, it will start a **brand new sequence of ten
alerts** — so only reset when you actually want that.

To stop the watcher permanently instead, go to **Actions** → **Cineplex Odyssey
70mm watcher** → the **⋯** menu → **Disable workflow**.

---

## Changing the settings

### Change the cutoff date

Edit `check-cineplex.mjs`, near the top:

```javascript
const CUTOFF_ISO = "2026-09-16T00:00:00Z";
```

Keep the trailing `Z`. If you drop it, the comparison becomes dependent on the
runner's time zone. Delete `.alert-state.json` afterwards so the new cutoff is
actually re-evaluated.

### Change the cinema, or watch all of Canada

In the SETTINGS block at the top of `check-cineplex.mjs`:

```javascript
const LOCATION_ID = "9406";   // Cinéma Banque Scotia Montréal
```

Set it to `""` to watch every Cineplex location. To find another cinema's id,
open that cinema's showtimes page on cineplex.com and read `locationId` out of
the URL. An unknown id returns an empty list rather than an error, so check the
request URL printed in the workflow log after changing it.

### Change the format

```javascript
const EXPERIENCES = "imax-70mm";
```

`imax-70mm` is IMAX 70mm; `70mm` also matches plain 5-perf 70mm; `imax` matches
any IMAX including digital. **Case-sensitive** — `IMAX` and `70MM` silently
return nothing. Set to `""` for any format.

### Change how many alerts you get

```javascript
const MAX_ALERTS = 10;
```

Note that an in-progress sequence remembers the old number in its
`maximumAlerts` field, so delete `.alert-state.json` if you want the new value
to apply immediately.

### Change the schedule

Edit `.github/workflows/check-cineplex.yml`:

```yaml
    - cron: "7,22,37,52 * * * *"
```

The five fields are `minute hour day-of-month month day-of-week`, always in
**UTC**.

| Goal | Cron |
|---|---|
| Every 15 minutes (default) | `7,22,37,52 * * * *` |
| Every 30 minutes | `7,37 * * * *` |
| Hourly | `7 * * * *` |
| Every 15 min, 7am–7pm Eastern only | `7,22,37,52 11-23 * * *` |

The offset minutes are deliberate. GitHub's own documentation notes that the
`schedule` event "can be delayed during periods of high loads… High load times
include the start of every hour", and advises scheduling "at a different time
of the hour". Avoid `0`, `15`, `30` and `45`.

Five minutes is the shortest interval GitHub allows.

---

## Limitations you should know about

Please read these. They are the difference between "this is broken" and "this
is GitHub behaving normally".

**Scheduled runs are not punctual.** GitHub queues scheduled workflows on
shared infrastructure. Runs commonly start 5–15 minutes late and can be delayed
much longer. GitHub's docs state that under sufficiently high load "some queued
jobs may be dropped" — a run can be skipped entirely. Your ten alerts may
therefore span more than 2.5 hours.

**Cron is always UTC.** It does not follow Eastern Time and does not shift for
daylight saving.

**Scheduled workflows get disabled after 60 days of inactivity.** GitHub's
documentation states this for public repositories, and community reports
indicate private repositories are affected too. Only **commits** reset the
timer — opening issues or editing settings does not. While the watcher is
merely waiting, it makes no commits, so if it sits idle for two months GitHub
may switch it off and email you about it. To keep it alive, push any trivial
commit (editing this README from the website is enough), or re-enable it from
the **Actions** tab banner.

**Private repositories consume Actions minutes.** See
[the section above](#read-this-before-you-deploy-actions-minutes). This is the
most likely reason for a watcher that silently stops mid-month.

**Email delivery is entirely GitHub's to control.** This project triggers ten
workflow *failures*. It cannot guarantee ten separate messages land in your
inbox. GitHub may thread, group, batch, rate-limit or suppress repeated
notifications from the same repository and workflow, and your mail provider may
collapse them into one conversation. Ten failures is a deliberate hedge against
that, not a promise of ten emails. **Treat the Actions tab as the source of
truth**, not your inbox.

**A technical failure also produces a failure email.** An API outage or a bad
deploy will email you too. The annotation title tells you which is which — see
[Telling a real alert from a technical failure](#telling-a-real-alert-from-a-technical-failure).

**Cineplex may change or block the API at any time.** It is an internal API with
no stability promise. If the response shape changes, the watcher fails loudly
with a `TECHNICAL FAILURE` rather than silently reporting "no new dates" — that
is a deliberate design choice, so a broken watcher is noisy instead of
invisible.

---

## Troubleshooting

### HTTP 401 "Access denied due to missing subscription key"

Cineplex rotated the public key in their website bundle. Fix it without editing
code:

1. In a desktop browser, open **<https://www.cineplex.com>**.
2. Press <kbd>F12</kbd> → **Network** tab.
3. Reload the page and click any request to `apis.cineplex.com`.
4. Under **Request Headers**, copy the value of `Ocp-Apim-Subscription-Key`.
5. In your repository: **Settings** → **Secrets and variables** → **Actions** →
   **Variables** tab → **New repository variable**.
6. Name it exactly `CINEPLEX_SUBSCRIPTION_KEY`, paste the value, click
   **Add variable**.

The workflow picks it up automatically. A repository *variable* (not a secret)
is the right home for it, since it is public information.

### HTTP 403

Cineplex's bot protection rejected the request. The script already sends
browser-like headers. This is usually temporary — wait for the next run. If it
persists, refresh the subscription key as above; the `User-Agent` in
`check-cineplex.mjs` can also be updated to a current browser string.

### HTTP 429

Rate limited. Harmless in isolation — the next scheduled run retries. If it
happens constantly, lengthen the schedule interval.

### "Cineplex API response was not valid JSON"

You will see the first 1,000 characters of what actually came back. Usually
it is an HTML block page or a maintenance page. Normally temporary.

### "Could not find any dates in the Cineplex response"

The response parsed but contained no ISO dates, meaning the API shape changed.
The watcher fails on purpose here rather than silently reporting "no new dates".
Compare the logged response against the format shown in
[Key facts](#key-facts) and adjust if needed.

### Push fails with HTTP 403, or "Could not push .alert-state.json"

Almost always the repository permission setting:

1. **Settings** → **Actions** → **General** → **Workflow permissions**
2. Select **Read and write permissions** → **Save**
3. Re-run the failed workflow.

If your default branch has branch-protection or a required-review ruleset, it
will block `github-actions[bot]`. Either add an exception for it, or protect a
different branch.

### `.alert-state.json` is not valid JSON

Someone edited it by hand. Delete the file (see
[Resetting the watcher](#resetting-the-watcher)) and the watcher rebuilds it.
It refuses to auto-repair on purpose, because silently rebuilding it would
restart the ten-alert sequence unexpectedly.

### Scheduled runs never start

- Scheduled workflows only run from the **default branch**. Confirm
  `.github/workflows/check-cineplex.yml` is on `main`.
- Check the **Actions** tab for a banner saying scheduled workflows were
  disabled due to inactivity, and click to re-enable.
- Confirm Actions is enabled: **Settings** → **Actions** → **General** →
  **Allow all actions and reusable workflows**.
- Check your Actions minutes at
  **[github.com/settings/billing](https://github.com/settings/billing)**.
- Give it an hour. Late is normal; a brand-new workflow's first scheduled run
  can take a while to appear.

### I got a failure email but I do not know why

Open the run, read the annotation title at the top, then look at
[Telling a real alert from a technical failure](#telling-a-real-alert-from-a-technical-failure).

### It emailed me ten times and I want it to stop

Nothing to do — it stops on its own after ten. If you want it to stop
immediately, disable the workflow: **Actions** → **Cineplex Odyssey 70mm
watcher** → **⋯** → **Disable workflow**.

### I am not getting any emails at all

1. Verify your email at [github.com/settings/emails](https://github.com/settings/emails).
2. Enable Actions email notifications — [Step 8](#step-8--turn-on-failure-emails).
3. Run the forced test (Test B) and watch for it.
4. Check spam, and any inbox rules for `notifications@github.com`.
5. If the run shows a red X but no email arrives, the problem is notification
   settings or mail filtering, not the watcher.
