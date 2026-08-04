#!/usr/bin/env node
/**
 * Cineplex "The Odyssey" 70mm bookable-date watcher.
 *
 * The settings you are most likely to change are immediately below, right at
 * the top of this file. A full explanation of how everything works - including
 * the subscription key and the time zone handling - is in the "HOW THIS WORKS"
 * section further down.
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

/* ===========================================================================
 *
 *   S E T T I N G S
 *
 *   Everything you are likely to want to change lives in this one block.
 *   Nothing below it needs editing for normal use.
 *
 * =========================================================================== */

/**
 * ---------------------------------------------------------------------------
 * THE CUTOFF DATE. This is the setting you are most likely to change.
 * ---------------------------------------------------------------------------
 * Only bookable dates STRICTLY LATER than this instant count as a detection.
 * A date exactly equal to it does NOT trigger an alert.
 *
 * ALWAYS keep the trailing "Z". It means UTC. Without it the comparison would
 * silently depend on the time zone of whichever machine runs the check, which
 * is a real bug rather than a nitpick - see "ABOUT TIME ZONES" further down.
 *
 * After changing this, delete .alert-state.json from the repository, otherwise
 * an alert sequence that is already in progress will just carry on and the new
 * cutoff will never be evaluated.
 *
 * 2026-09-16 is the last date currently bookable at this cinema, so the watcher
 * stays quiet until Cineplex opens something genuinely new. Because the test is
 * strictly greater-than, that last date does NOT count as a detection.
 *
 * To rehearse the alert path for real, set this one day earlier
 * ("2026-09-15T00:00:00Z") and delete .alert-state.json - the date Cineplex
 * already offers then qualifies, and the whole sequence runs end to end.
 */
const CUTOFF_ISO = "2026-09-16T00:00:00Z";

/** How many failure notifications to trigger, in total, per detection. */
const MAX_ALERTS = 10;

/** Cineplex internal film id for "The Odyssey". */
const FILM_ID = "37617";

/**
 * Which cinema to watch. "9406" is Cinéma Banque Scotia Montréal.
 *
 * Set this to an empty string ("") to watch every Cineplex location in Canada
 * instead. Narrowing to one cinema genuinely changes the answer: nationally the
 * film has 45 bookable dates starting 2026-08-03, but at 9406 it has 44,
 * starting 2026-08-04. The LAST bookable date happens to be the same
 * (2026-09-16) for both today, which is why the cutoff did not need changing.
 *
 * Like the experience filter, an unrecognised id fails SILENTLY: the API
 * answers HTTP 200 with [] rather than an error. Verify any new value by
 * opening the request URL that gets printed in the workflow log.
 */
const LOCATION_ID = "9406";

/**
 * Experience filter passed to the API. THIS VALUE IS CASE-SENSITIVE.
 *
 * "imax-70mm" is IMAX 70mm (15-perf), which is the premium format worth
 * queueing for. It is NOT the same thing as "70mm", which also matches plain
 * 5-perf 70mm prints. Both are real, and for this film they are genuinely
 * different showings: on 2026-08-04 the API reports 32 sessions tagged
 * ["IMAX","70mm"] across 8 theatres, plus 14 sessions tagged only ["70mm"]
 * at 4 other theatres.
 *
 * Known-good values seen on this endpoint:
 *   imax-70mm   IMAX 70mm
 *   70mm        any 70mm, including IMAX 70mm
 *   imax        any IMAX, including digital IMAX
 *   vip, dbox, ultraavx, ...
 *
 * Case matters: "IMAX", "70MM" and "IMAX 70mm" all silently return an empty
 * list rather than an error, which would look exactly like "no dates" forever.
 * If you change this, confirm the value still returns dates by opening the URL
 * printed in the workflow log.
 */
const EXPERIENCES = "imax-70mm";

/**
 * Used only to build the "buy tickets" links that appear in the alert.
 *
 * FILM_SLUG is the film's page name on cineplex.com: the "the-odyssey" in
 * https://www.cineplex.com/movie/the-odyssey. THEATRE_NAME is cosmetic - it is
 * just what the alert calls your cinema.
 */
const FILM_SLUG = "the-odyssey";
const THEATRE_NAME = "Cinéma Banque Scotia Montréal";

/* ===========================================================================
 * Internal constants - you should not normally need to touch these.
 * =========================================================================== */

/** Committed to the repository while an alert sequence is in progress. */
const STATE_FILE = ".alert-state.json";

/**
 * Public client-side Azure APIM key (see the long note above). Overridable
 * with a repository VARIABLE if Cineplex ever rotates it.
 */
const PUBLIC_SUBSCRIPTION_KEY = "dcdac5601d864addbc2675a2e96cb1f8";

/* --- Logging / safety limits ------------------------------------------- */

/** Error response bodies are truncated to this many characters in the log. */
const MAX_ERROR_BODY_CHARS = 1000;

/** Successful response bodies are truncated to this many characters. */
const MAX_SUCCESS_BODY_CHARS = 4000;

/** Give up on the HTTP request after this long. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Safety rail for the recursive extractor against absurdly nested JSON. */
const MAX_RECURSION_DEPTH = 12;

/* ===========================================================================
 * HOW THIS WORKS - background reading, no settings below this point.
 * =========================================================================== */
/**
 * ============================================================================
 * Cineplex "The Odyssey" 70mm bookable-date watcher
 * ============================================================================
 *
 * WHAT THIS DOES
 * --------------
 * Asks the Cineplex public showtimes API which dates are currently bookable
 * for film 37617 ("The Odyssey") in IMAX 70mm at Cinéma Banque Scotia Montréal,
 * and reports whether ANY bookable date is strictly later than a cutoff date.
 * All three of those - film, format and cinema - are set in SETTINGS above.
 *
 * It never sends email itself. It decides what should happen and tells the
 * GitHub Actions workflow via a step output called `mode`:
 *
 *   mode=none       -> nothing to do. Workflow finishes successfully.
 *   mode=alert      -> a qualifying date exists AND we still owe alerts.
 *                      This script has already written .alert-state.json.
 *                      The workflow must COMMIT that file and THEN fail.
 *   mode=exhausted  -> all alerts already sent. Workflow finishes successfully.
 *   mode=test       -> forced test alert. No state written, no counter touched.
 *                      The workflow should just fail, without committing.
 *
 * On a genuine technical problem (network down, HTTP error, bad JSON,
 * unexpected response shape) this script exits with code 1 immediately,
 * WITHOUT writing state and WITHOUT setting mode=alert. That makes a real
 * outage look different from a real detection, both in the log and in the
 * workflow step that fails.
 *
 * NO npm DEPENDENCIES. Node's built-in fetch (Node 18+) and node:fs only.
 *
 * ---------------------------------------------------------------------------
 * ABOUT THE SUBSCRIPTION KEY (please read)
 * ---------------------------------------------------------------------------
 * apis.cineplex.com sits behind Azure API Management. Calling the endpoint
 * with no key returns:
 *
 *   HTTP 401 {"statusCode":401,"message":"Access denied due to missing
 *             subscription key. ..."}
 *
 * The key below is NOT a secret and NOT a credential belonging to you. It is
 * the public, client-side key that Cineplex ships inside their own website's
 * JavaScript bundle, so every visitor's browser already sends this exact value
 * on every page view. It grants no account access and identifies no user.
 * That is why this project needs no GitHub Secret.
 *
 * If Cineplex ever rotates it you will start seeing HTTP 401. Fix it WITHOUT
 * editing code by adding a repository variable (not a secret) named
 * CINEPLEX_SUBSCRIPTION_KEY under:
 *   Settings > Secrets and variables > Actions > Variables
 * See the README section "Troubleshooting -> HTTP 401" for how to find the
 * current value.
 *
 * ---------------------------------------------------------------------------
 * ABOUT TIME ZONES (please read)
 * ---------------------------------------------------------------------------
 * The API returns "naive" timestamps with no zone, e.g. "2026-09-16T00:00:00".
 * JavaScript parses a naive date-TIME as LOCAL time but a naive date-ONLY
 * ("2026-09-16") as UTC. Relying on that difference is a real bug: on a
 * machine in America/Toronto, Date.parse("2026-09-16T00:00:00") is four hours
 * LARGER than Date.parse("2026-09-16T00:00:00Z"), so the cutoff date itself
 * would look "later than the cutoff" and fire a false alarm.
 *
 * So we normalise explicitly: any timestamp with no zone is interpreted as
 * UTC, and the cutoff is written as UTC. Both sides then use the same rule and
 * the comparison is exact no matter which machine runs this. Because every
 * value the API returns is a midnight day-marker, treating them as UTC day
 * labels is the correct reading, and it is stable regardless of runner region.
 * ============================================================================
 */

/* ===========================================================================
 * SMALL HELPERS
 * =========================================================================== */

/** Truncate long text for logging, and say so when we truncate. */
function clip(text, limit) {
  const s = String(text ?? "");
  return s.length <= limit
    ? s
    : `${s.slice(0, limit)}\n... [truncated, ${s.length} characters total]`;
}

/**
 * Write a GitHub Actions step output.
 *
 * Uses the current `$GITHUB_OUTPUT` file (the old `::set-output::` command was
 * deprecated and disabled by GitHub). Values are written with a randomly named
 * heredoc delimiter so that multi-line values, `=` signs and other special
 * characters cannot corrupt the file or be used to inject extra outputs.
 */
function setOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  const text = String(value);
  if (!outputFile) {
    // Running outside GitHub Actions (e.g. a local sanity check).
    console.log(`[output] ${name}=${text}`);
    return;
  }
  const delimiter = `ghadelimiter_${randomUUID()}`;
  appendFileSync(outputFile, `${name}<<${delimiter}\n${text}\n${delimiter}\n`, "utf8");
}

/** Append Markdown to the run's job summary, if we are inside Actions. */
function addSummary(markdown) {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile) return;
  try {
    appendFileSync(summaryFile, `${markdown}\n`, "utf8");
  } catch {
    /* A summary is a nicety; never fail the run over it. */
  }
}

/**
 * Report a genuine technical failure and stop.
 *
 * The `::error` annotation title deliberately says "technical failure" so it
 * can never be confused with the real detection alert in the email subject or
 * in the Actions UI.
 */
function failTechnical(title, details) {
  console.error("");
  console.error("=".repeat(70));
  console.error(`TECHNICAL FAILURE: ${title}`);
  console.error("=".repeat(70));
  console.error(details);
  console.error("");
  console.error("This is NOT a Cineplex date alert. Nothing was written to");
  console.error(`${STATE_FILE}, and your alert counter was not changed.`);
  console.error("The watcher will try again on the next scheduled run.");
  // Newlines are stripped: annotation messages are a single line. Use %0A if
  // you ever want a literal line break inside an annotation.
  const oneLine = `${title} -- ${String(details).replace(/\s+/g, " ")}`;
  console.error(`::error title=Odyssey watcher TECHNICAL FAILURE::${clip(oneLine, 800)}`);
  setOutput("mode", "error");
  addSummary(`## Odyssey watcher: technical failure\n\n**${title}**\n\nThis is *not* a date alert.`);
  process.exit(1);
}

/* ===========================================================================
 * BOOKING LINKS
 * =========================================================================== */

/**
 * Build a cineplex.com link that opens straight on the showtimes for one date
 * at your cinema, so the alert is one click away from buying a ticket.
 *
 * The date must be formatted M/D/YYYY - that is the format cineplex.com's own
 * site uses in its URLs. The parts are read in UTC to match how the rest of
 * this script interprets the API's zoneless timestamps.
 */
function bookingUrl(isoDate) {
  const url = new URL(`https://www.cineplex.com/movie/${FILM_SLUG}`);
  if (LOCATION_ID) url.searchParams.set("locationId", LOCATION_ID);
  const millis = toUtcMillis(isoDate);
  if (millis !== null) {
    const d = new Date(millis);
    url.searchParams.set("date", `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`);
  }
  return url.toString();
}

/**
 * Rich Markdown shown on the workflow run's Summary page.
 *
 * This matters because GitHub writes the failure EMAIL itself and we cannot put
 * anything inside it. What we can control is where its "View results" link
 * lands, so the run page is made to open with a big obvious booking link.
 */
function alertSummary(alertNumber, maximum, dates, cutoff) {
  const rows = dates
    .map((d) => `| **${d.slice(0, 10)}** | [🎟 Buy tickets →](${bookingUrl(d)}) |`)
    .join("\n");
  return [
    `# 🎟 New IMAX 70mm date for The Odyssey`,
    ``,
    `**${THEATRE_NAME}** has opened ${dates.length} bookable date(s) later than \`${cutoff}\`.`,
    ``,
    `| Date | Book |`,
    `|---|---|`,
    rows,
    ``,
    `All showtimes: [${THEATRE_NAME}](${bookingUrl(dates[0])})`,
    ``,
    `---`,
    ``,
    `Alert **${alertNumber} of ${maximum}**. This run failed on purpose - that is how it emailed you.`,
    `Nothing is broken. It stops by itself after ${maximum} alerts.`,
    ``,
  ].join("\n");
}

/* ===========================================================================
 * DATE EXTRACTION
 * =========================================================================== */

/**
 * Matches a whole string that looks like an ISO-8601 date or date-time.
 *
 * Anchoring with ^...$ is the single most important defence against false
 * positives: a synopsis, a title, a URL or an id can never match this, because
 * the ENTIRE string has to be a date. Accepted examples:
 *
 *   2026-09-17
 *   2026-09-17T00:00:00
 *   2026-09-17T19:30:00.000
 *   2026-09-17T19:30:00Z
 *   2026-09-17T19:30:00-04:00
 *   2026-09-17 19:30
 */
const ISO_LIKE = new RegExp(
  "^(?<year>\\d{4})-(?<month>\\d{2})-(?<day>\\d{2})" +
    "(?:[T ](?<hour>\\d{2}):(?<minute>\\d{2})(?::(?<second>\\d{2})(?:\\.\\d{1,9})?)?)?" +
    "(?<zone>Z|z|[+-]\\d{2}:?\\d{2})?$",
);

/**
 * Keys whose names suggest the value is a show date. Used to PREFER candidates,
 * never to exclude them outright - see pickBestCandidates() for why that
 * distinction matters.
 */
const DATE_KEY_HINT =
  /(^|[^a-z])(date|dates|day|days|bookable|presentation|presentations|show|shows|showtime|showtimes|start|starts|begin|end|ends|available)([^a-z]|$)/i;

/**
 * Convert an ISO-like string to a UTC timestamp in milliseconds.
 *
 * Returns null when the string is not a date at all, or is a nonsense date
 * such as "2026-13-45" that matches the shape but is not a real calendar day.
 * A missing zone is interpreted as UTC (see the time zone note at the top).
 */
function toUtcMillis(raw) {
  const match = ISO_LIKE.exec(String(raw).trim());
  if (!match) return null;

  const g = match.groups;
  const year = Number(g.year);
  const month = Number(g.month);
  const day = Number(g.day);
  const hour = Number(g.hour ?? "0");
  const minute = Number(g.minute ?? "0");
  const second = Number(g.second ?? "0");

  // Reject impossible components before trusting Date at all.
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 60) return null;

  // Round-trip check catches things like 2026-02-31, which Date would happily
  // roll forward into March instead of rejecting.
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const probe = new Date(asUtc);
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }

  // No zone in the source string -> treat it as UTC.
  if (!g.zone) return asUtc;

  // Zone present -> honour it. Normalise "+0500" to "+05:00" so Date.parse
  // accepts it on every Node version.
  let zone = g.zone.toUpperCase();
  if (zone !== "Z" && !zone.includes(":")) {
    zone = `${zone.slice(0, 3)}:${zone.slice(3)}`;
  }
  const pad = (n) => String(n).padStart(2, "0");
  const rebuilt =
    `${g.year}-${g.month}-${g.day}T${pad(hour)}:${pad(minute)}:${pad(second)}${zone}`;
  const parsed = Date.parse(rebuilt);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Walk any JSON value and collect every string that is entirely an ISO-like
 * date, remembering where it came from.
 *
 * Handles arrays, objects, and nested combinations of both. Each candidate
 * records the nearest enclosing OBJECT KEY (walking up through array indices),
 * which is what lets us prefer `{"dates": [...]}` over an unrelated
 * `{"lastModified": "..."}` if the response ever grows a wrapper.
 */
function collectDateCandidates(node, keyHint = null, path = "$", depth = 0, found = []) {
  if (depth > MAX_RECURSION_DEPTH || node === null || node === undefined) return found;

  if (typeof node === "string") {
    const millis = toUtcMillis(node);
    if (millis !== null) {
      found.push({ value: node.trim(), millis, path, keyHint });
    }
    return found;
  }

  if (Array.isArray(node)) {
    node.forEach((item, index) => {
      // An array index is not a key, so the enclosing key hint is inherited.
      collectDateCandidates(item, keyHint, `${path}[${index}]`, depth + 1, found);
    });
    return found;
  }

  if (typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      collectDateCandidates(value, key, `${path}.${key}`, depth + 1, found);
    }
  }

  // Numbers/booleans are ignored on purpose: a bare epoch number is too easy
  // to confuse with an id, a runtime in minutes, or a price.
  return found;
}

/**
 * Decide which collected candidates to actually treat as show dates.
 *
 * The live endpoint currently returns a BARE ARRAY of date strings with no
 * object keys anywhere:
 *
 *   ["2026-08-03T00:00:00", ..., "2026-09-16T00:00:00"]
 *
 * so there are no key names to filter on. An implementation that only accepted
 * values under a key called "date"/"dates" would find nothing at all here and
 * would silently never alert. That is precisely the failure this function
 * exists to avoid.
 *
 * Rule: if ANY candidate came from a date-suggesting key, trust only those -
 * that is the disambiguating signal for a future wrapped response. Otherwise
 * (today's shape) accept every fully-ISO string we found.
 */
function pickBestCandidates(candidates) {
  const hinted = candidates.filter((c) => c.keyHint && DATE_KEY_HINT.test(c.keyHint));
  if (hinted.length > 0) {
    console.log(
      `Found ${hinted.length} date value(s) under date-like keys ` +
        `(${[...new Set(hinted.map((c) => c.keyHint))].join(", ")}); ` +
        `ignoring ${candidates.length - hinted.length} other ISO-looking value(s).`,
    );
    return hinted;
  }
  if (candidates.length > 0) {
    console.log(
      `Response has no object keys to filter on (bare list shape); ` +
        `accepting all ${candidates.length} fully-ISO value(s).`,
    );
  }
  return candidates;
}

/* ===========================================================================
 * API CALL
 * =========================================================================== */

/** Fetch the bookable dates and return them as an array of {value, millis}. */
async function fetchBookableDates() {
  // Built with URLSearchParams so every value is escaped correctly, and so an
  // empty LOCATION_ID cleanly means "all locations" rather than sending an
  // empty locationId= that the API would treat as no match.
  const query = new URLSearchParams({ filmId: FILM_ID });
  if (LOCATION_ID) query.set("locationId", LOCATION_ID);
  if (EXPERIENCES) query.set("experiences", EXPERIENCES);
  const url =
    `https://apis.cineplex.com/prod/cpx/theatrical/api/v1/dates/bookable?${query}`;

  // A repository VARIABLE may override the built-in public key. Empty string
  // is what an unset variable expands to, so fall back on anything falsy.
  const subscriptionKey =
    (process.env.CINEPLEX_SUBSCRIPTION_KEY || "").trim() || PUBLIC_SUBSCRIPTION_KEY;

  console.log(`Requesting: ${url}`);

  let response;
  let bodyText;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/json",
        Origin: "https://www.cineplex.com",
        Referer: "https://www.cineplex.com/",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Accept-Language": "en-CA,en;q=0.9",
        // Public client-side key shipped in Cineplex's own web bundle.
        "Ocp-Apim-Subscription-Key": subscriptionKey,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // DNS failure, TLS failure, connection reset, or our own timeout.
    const reason = error?.name === "TimeoutError"
      ? `No response within ${REQUEST_TIMEOUT_MS} ms.`
      : `${error?.name ?? "Error"}: ${error?.message ?? String(error)}` +
        (error?.cause?.message ? ` (cause: ${error.cause.message})` : "");
    failTechnical("Could not reach the Cineplex API", reason);
    return; // unreachable; keeps static analysers happy
  }

  console.log(`HTTP ${response.status} ${response.statusText}`);

  // Always read the body as TEXT first. If it turns out not to be JSON we can
  // still show what actually came back, which is the difference between a
  // useful log and a mystery.
  try {
    bodyText = await response.text();
  } catch (error) {
    failTechnical(
      "Could not read the Cineplex API response body",
      `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`,
    );
    return;
  }

  if (!response.ok) {
    const hint =
      response.status === 401
        ? "\n\nHTTP 401 usually means the public subscription key changed. " +
          "See the README section 'Troubleshooting -> HTTP 401'."
        : response.status === 403
          ? "\n\nHTTP 403 can mean the request was blocked by Cineplex's bot protection."
          : response.status === 429
            ? "\n\nHTTP 429 means rate limited. The next scheduled run will retry."
            : "";
    failTechnical(
      `Cineplex API returned HTTP ${response.status} ${response.statusText}`,
      `First ${MAX_ERROR_BODY_CHARS} characters of the response body:\n` +
        `${clip(bodyText, MAX_ERROR_BODY_CHARS)}${hint}`,
    );
    return;
  }

  if (bodyText.trim() === "") {
    failTechnical(
      "Cineplex API returned an empty body",
      `HTTP ${response.status} was a success status but the body had no content.`,
    );
    return;
  }

  // The real payload is about 1 KB, so printing it is genuinely useful for
  // diagnosing shape changes. It contains no secrets - only public show dates.
  console.log("--- Raw response body ---");
  console.log(clip(bodyText, MAX_SUCCESS_BODY_CHARS));
  console.log("--- End of response body ---");

  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch (error) {
    failTechnical(
      "Cineplex API response was not valid JSON",
      `Parser said: ${error?.message ?? String(error)}\n` +
        `First ${MAX_ERROR_BODY_CHARS} characters of the body:\n` +
        clip(bodyText, MAX_ERROR_BODY_CHARS),
    );
    return;
  }

  // A bare string, number, boolean or null is NOT a valid answer. The API does
  // exactly this for a bad film id: HTTP 404 with the body
  //   "Movie not found for specified ID"
  // which is perfectly valid JSON. Without this guard such a response would
  // parse cleanly, yield zero dates, and be reported as "no new dates" forever.
  if (payload === null || typeof payload !== "object") {
    failTechnical(
      "Cineplex API returned an unexpected response structure",
      `Expected a JSON array (or an object containing one) but got ` +
        `${payload === null ? "null" : typeof payload}: ` +
        clip(JSON.stringify(payload), MAX_ERROR_BODY_CHARS),
    );
    return;
  }

  const candidates = pickBestCandidates(collectDateCandidates(payload));

  // An empty ARRAY is a legitimate "nothing is bookable" answer - the API
  // returns [] for an unknown experience filter, and would for a film that has
  // finished its run. But an OBJECT that yields no dates means the response
  // shape changed underneath us, and quietly reporting "no new dates" would
  // hide a broken watcher. Those two cases get opposite treatment.
  if (candidates.length === 0) {
    if (Array.isArray(payload) && payload.length === 0) {
      console.log("API returned an empty list: no bookable dates at all right now.");
      // An empty list is legitimate when a film has finished its run, so this
      // is not an error. But it is ALSO exactly what a mistyped experience
      // filter returns - the API answers HTTP 200 with [] rather than
      // complaining - and that would look like "no dates" forever. Say so
      // loudly, because a silently mis-configured watcher is the worst
      // outcome here.
      console.log("");
      console.log(`::warning title=Odyssey watcher::No bookable dates returned for ` +
        `experiences="${EXPERIENCES}" locationId="${LOCATION_ID || "(all)"}". ` +
        `That is normal once a film finishes its run, but it is also what an invalid experience filter ` +
        `or an unknown locationId returns - both answer HTTP 200 with an empty list instead of an error. ` +
        `The experience filter is case-sensitive ("IMAX" and "70MM" both return nothing). ` +
        `Open the request URL above in a browser to check.`);
      return [];
    }
    failTechnical(
      "Could not find any dates in the Cineplex response",
      "The response parsed as JSON but contained no ISO-8601 date strings. " +
        "The API shape has probably changed, so this run is being treated as a " +
        "failure rather than silently reporting 'no new dates'.\n" +
        `Response was:\n${clip(bodyText, MAX_ERROR_BODY_CHARS)}`,
    );
    return;
  }

  // De-duplicate by the normalised instant, then sort chronologically.
  const byInstant = new Map();
  for (const candidate of candidates) {
    if (!byInstant.has(candidate.millis)) byInstant.set(candidate.millis, candidate);
  }
  return [...byInstant.values()].sort((a, b) => a.millis - b.millis);
}

/* ===========================================================================
 * ALERT STATE
 * =========================================================================== */

/**
 * Read .alert-state.json if it exists.
 *
 * A corrupt state file is a hard failure on purpose. Silently rebuilding it
 * would reset the counter and fire another ten emails, which is exactly the
 * surprise we do not want. Deleting the file is a deliberate, documented act.
 */
function readState() {
  if (!existsSync(STATE_FILE)) return null;

  let raw;
  try {
    raw = readFileSync(STATE_FILE, "utf8");
  } catch (error) {
    failTechnical(`Could not read ${STATE_FILE}`, error?.message ?? String(error));
  }

  let state;
  try {
    state = JSON.parse(raw);
  } catch (error) {
    failTechnical(
      `${STATE_FILE} is not valid JSON`,
      `Parser said: ${error?.message ?? String(error)}\n` +
        `Delete ${STATE_FILE} from the repository to reset the watcher.\n` +
        `File contents:\n${clip(raw, MAX_ERROR_BODY_CHARS)}`,
    );
  }

  if (state === null || typeof state !== "object" || Array.isArray(state)) {
    failTechnical(
      `${STATE_FILE} does not contain a JSON object`,
      `Delete ${STATE_FILE} from the repository to reset the watcher.`,
    );
  }

  // Be strict about the counter: a missing, negative or non-numeric value must
  // not be coerced into something that quietly restarts the sequence.
  if (!Number.isInteger(state.alertsSent) || state.alertsSent < 0) {
    failTechnical(
      `${STATE_FILE} has an invalid "alertsSent" value`,
      `Expected a whole number >= 0 but found: ${JSON.stringify(state.alertsSent)}\n` +
        `Delete ${STATE_FILE} from the repository to reset the watcher.`,
    );
  }

  return state;
}

/** Write the state file, pretty-printed with a trailing newline. */
function writeState(state) {
  try {
    writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch (error) {
    failTechnical(`Could not write ${STATE_FILE}`, error?.message ?? String(error));
  }
}

/* ===========================================================================
 * MAIN
 * =========================================================================== */

async function main() {
  const cutoffMillis = Date.parse(CUTOFF_ISO);
  if (Number.isNaN(cutoffMillis)) {
    failTechnical("The configured CUTOFF_ISO is not a valid date", `CUTOFF_ISO = ${CUTOFF_ISO}`);
  }

  const nowIso = new Date().toISOString();
  console.log("=".repeat(70));
  console.log("Cineplex 'The Odyssey' 70mm bookable-date watcher");
  console.log("=".repeat(70));
  console.log(`Run started (UTC): ${nowIso}`);
  console.log(`Film id:           ${FILM_ID}`);
  console.log(`Experience filter: ${EXPERIENCES}`);
  console.log(`Location:          ${LOCATION_ID || "(all Cineplex locations)"}`);
  console.log(`Cutoff (UTC):      ${CUTOFF_ISO}`);
  console.log(`Alerts per detection: ${MAX_ALERTS}`);
  console.log("");

  /* --- Forced test mode -------------------------------------------------
   * Deliberately handled FIRST and returned from immediately, so a test can
   * never read, write, create or delete the real state file, and can never
   * touch the real counter. `inputs.force_alert` arrives as the string "true"
   * only when the box was ticked; on a scheduled run it is an empty string. */
  if ((process.env.FORCE_ALERT || "").toLowerCase() === "true") {
    console.log("*".repeat(70));
    console.log("*  FORCED TEST ALERT - this is a DRILL, not a real detection.");
    console.log("*".repeat(70));
    console.log("");
    console.log("You ticked 'force_alert' when starting this workflow manually.");
    console.log("The workflow will now fail on purpose so you can confirm that");
    console.log("GitHub emails you about failed workflow runs.");
    console.log("");
    console.log("This test did NOT contact the Cineplex API.");
    console.log(`This test did NOT create or modify ${STATE_FILE}.`);
    console.log("This test did NOT change your real alert counter.");
    console.log("The real watcher is completely unaffected and keeps running.");
    setOutput("mode", "test");
    addSummary(
      `## TEST alert (a drill)\n\n` +
        `This run failed on purpose to test email delivery.\n\n` +
        `No Cineplex data was read and \`${STATE_FILE}\` was not touched.`,
    );
    return;
  }

  /* --- Continuing an alert sequence -------------------------------------
   * If state already exists we are mid-sequence. There is no need to call the
   * API again: the detection already happened and re-checking could only add a
   * way to fail. This also keeps the sequence running even if Cineplex has an
   * outage halfway through. */
  const existingState = readState();

  if (existingState) {
    const alreadySent = existingState.alertsSent;
    const maximum = Number.isInteger(existingState.maximumAlerts) && existingState.maximumAlerts > 0
      ? existingState.maximumAlerts
      : MAX_ALERTS;

    console.log(`${STATE_FILE} exists - an alert sequence is already in progress.`);
    console.log(`Detected at:  ${existingState.detectedAt ?? "unknown"}`);
    console.log(`Alerts sent:  ${alreadySent} of ${maximum}`);
    console.log("");

    if (alreadySent >= maximum) {
      console.log("=".repeat(70));
      console.log(`ALL ${maximum} NOTIFICATIONS HAVE ALREADY BEEN TRIGGERED.`);
      console.log("=".repeat(70));
      console.log("");
      console.log("This run will finish successfully and send no further alerts.");
      console.log("Qualifying dates found at the time of detection:");
      for (const date of existingState.dates ?? []) console.log(`  - ${date}`);
      console.log("");
      console.log(`To start watching again, delete ${STATE_FILE} from the repository.`);
      setOutput("mode", "exhausted");
      setOutput("alert_number", String(alreadySent));
      setOutput("max_alerts", String(maximum));
      addSummary(
        `## Alert sequence complete\n\n` +
          `All ${maximum} notifications were already triggered. ` +
          `Delete \`${STATE_FILE}\` to reset the watcher.`,
      );
      return;
    }

    // Increment FIRST, then persist. The workflow commits the file before it
    // fails, so this number is durable even though the job ends in failure.
    const alertNumber = alreadySent + 1;
    const updated = {
      ...existingState,
      lastAlertAt: nowIso,
      alertsSent: alertNumber,
      maximumAlerts: maximum,
    };
    writeState(updated);

    console.log("=".repeat(70));
    console.log(`SENDING ALERT ${alertNumber} OF ${maximum}`);
    console.log("=".repeat(70));
    const seqDates = existingState.dates ?? [];
    const seqCutoff = existingState.cutoff ?? CUTOFF_ISO;
    console.log("Qualifying dates from the original detection:");
    for (const date of seqDates) console.log(`  - ${date}   ${bookingUrl(date)}`);
    console.log("");
    console.log(`${STATE_FILE} updated. The workflow will commit it, then fail on purpose.`);
    if (seqDates.length > 0) {
      addSummary(alertSummary(alertNumber, maximum, seqDates, seqCutoff));
      setOutput("booking_url", bookingUrl(seqDates[0]));
    }

    setOutput("mode", "alert");
    setOutput("alert_number", String(alertNumber));
    setOutput("max_alerts", String(maximum));
    setOutput("dates", (existingState.dates ?? []).join(", "));
    setOutput("dates_count", String((existingState.dates ?? []).length));
    // Report the cutoff that was in force when the detection happened, not the
    // one configured right now - they differ if you edited CUTOFF_ISO
    // mid-sequence, and the original is the honest number to show.
    setOutput("cutoff", existingState.cutoff ?? CUTOFF_ISO);
    return;
  }

  /* --- No state yet: actually check the API ----------------------------- */
  console.log(`${STATE_FILE} does not exist - checking the Cineplex API.`);
  console.log("");

  const dates = await fetchBookableDates();

  console.log("");
  console.log(`Bookable dates found: ${dates.length}`);
  for (const date of dates) {
    const marker = date.millis > cutoffMillis ? "  <-- LATER THAN CUTOFF" : "";
    console.log(`  ${date.value}${marker}`);
  }
  console.log("");

  // STRICTLY greater than. A date exactly equal to the cutoff must not fire.
  // This matters right now: the last currently-bookable date IS the cutoff.
  const qualifying = dates.filter((date) => date.millis > cutoffMillis);

  if (qualifying.length === 0) {
    const latest = dates.length > 0 ? dates[dates.length - 1].value : "none";
    console.log("=".repeat(70));
    console.log("NO QUALIFYING DATES. Nothing to do.");
    console.log("=".repeat(70));
    console.log(`Latest bookable date: ${latest}`);
    console.log(`Cutoff (UTC):         ${CUTOFF_ISO}`);
    console.log("");
    console.log(`No email sent. ${STATE_FILE} was not created. Run finishes successfully.`);
    setOutput("mode", "none");
    setOutput("dates_count", String(dates.length));
    addSummary(
      `## No new dates\n\n` +
        `Checked ${dates.length} bookable date(s). Latest is \`${latest}\`, ` +
        `which is not after the cutoff \`${CUTOFF_ISO}\`.`,
    );
    return;
  }

  /* --- First detection --------------------------------------------------- */
  const qualifyingValues = qualifying.map((date) => date.value);

  console.log("=".repeat(70));
  console.log("NEW DATES DETECTED!");
  console.log("=".repeat(70));
  console.log(`${qualifying.length} bookable date(s) are later than ${CUTOFF_ISO}:`);
  for (const value of qualifyingValues) console.log(`  - ${value}   ${bookingUrl(value)}`);
  console.log("");

  const state = {
    detectedAt: nowIso,
    lastAlertAt: nowIso,
    alertsSent: 1, // this run IS alert number 1 - it is not counted again later
    maximumAlerts: MAX_ALERTS,
    dates: qualifyingValues,
    bookingUrls: qualifyingValues.map(bookingUrl),
    cutoff: CUTOFF_ISO,
    filmId: FILM_ID,
    locationId: LOCATION_ID,
    experiences: EXPERIENCES,
    note:
      "Delete this file from the repository to reset the watcher and allow a " +
      "new sequence of alerts.",
  };
  writeState(state);

  console.log(`SENDING ALERT 1 OF ${MAX_ALERTS}`);
  console.log(`${STATE_FILE} created. The workflow will commit it, then fail on purpose.`);

  setOutput("mode", "alert");
  setOutput("alert_number", "1");
  setOutput("max_alerts", String(MAX_ALERTS));
  setOutput("dates", qualifyingValues.join(", "));
  setOutput("dates_count", String(qualifyingValues.length));
  setOutput("cutoff", CUTOFF_ISO);
  setOutput("booking_url", bookingUrl(qualifyingValues[0]));
  addSummary(alertSummary(1, MAX_ALERTS, qualifyingValues, CUTOFF_ISO));
}

// Any error we did not anticipate still has to be an obvious technical failure
// rather than a silent success or a fake alert.
try {
  await main();
} catch (error) {
  failTechnical(
    "Unexpected error while running the watcher",
    `${error?.stack ?? error?.message ?? String(error)}`,
  );
}
