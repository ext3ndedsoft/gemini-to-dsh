/**
 * Grouped quota windows: five-hour **and** weekly.
 *
 * `fetchAvailableModels` only carries one window per model (the five-hour one). The grouped
 * view the Antigravity app shows — "Gemini Models" and "Claude and GPT models", each with a
 * `5h` and a `weekly` bucket — comes from a separate endpoint that only answers the `hub`
 * client identity. A bare `antigravity/cli/...` identity gets a reduced answer, so the
 * identity below is not cosmetic: it decides whether the weekly buckets exist at all.
 *
 * The lookup is optional enrichment. Generation never depends on it, so every failure here
 * degrades to "no weekly bars" instead of an error.
 */

import { log } from './config.js';

const SUMMARY_PATH = '/v1internal:retrieveUserQuotaSummary';

/** Daily first: it is the host the desktop app talks to. The others are fallbacks. */
const HOSTS = [
  'https://daily-cloudcode-pa.googleapis.com',
  'https://cloudcode-pa.googleapis.com',
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
];

/** Hub versions below this floor do not receive every quota group. */
const HUB_VERSION = process.env.AG_HUB_VERSION || '2.26.0';
const TIMEOUT_MS = Number(process.env.AG_QUOTA_TIMEOUT_MS || 15000);

function platformTag() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'darwin';
  return 'linux';
}

function archTag() {
  if (process.arch === 'x64') return 'amd64';
  if (process.arch === 'arm64') return 'arm64';
  return process.arch;
}

/** The language-server identity of the Antigravity app. Google gates quota groups on it. */
export function hubUserAgent() {
  return `antigravity/hub/${HUB_VERSION} (aidev_client; os_type=${platformTag()}; arch=${archTag()})`;
}

function normalizeBucket(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const fraction = typeof raw.remainingFraction === 'number' ? raw.remainingFraction : null;
  if (fraction === null) return null;
  const window = String(raw.window || '').toLowerCase();
  return {
    id: raw.bucketId || window || 'bucket',
    window,
    label: raw.displayName || raw.window || raw.bucketId || 'Limit',
    remaining: fraction,
    resetAt: raw.resetTime || null,
    description: raw.description || '',
  };
}

function normalizeGroup(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const buckets = (Array.isArray(raw.buckets) ? raw.buckets : []).map(normalizeBucket).filter(Boolean);
  if (!buckets.length) return null;
  return {
    name: raw.displayName || 'Quota',
    description: raw.description || '',
    buckets,
    weekly: buckets.filter((bucket) => `${bucket.window} ${bucket.id}`.toLowerCase().includes('week')),
    fiveHour: buckets.filter((bucket) => !`${bucket.window} ${bucket.id}`.toLowerCase().includes('week')),
  };
}

async function postSummary(host, token, body) {
  const res = await fetch(host + SUMMARY_PATH, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + token,
      'content-type': 'application/json',
      'user-agent': hubUserAgent(),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return res;
}

/**
 * @param {{ token: string, project?: string|null }} account
 * @returns {Promise<{groups: object[], at: number, host: string} | null>}
 */
export async function fetchQuotaSummary({ token, project } = {}) {
  if (!token) return null;

  const withProject = project ? [{ project }, {}] : [{}];

  for (const host of HOSTS) {
    for (const body of withProject) {
      let res;
      try {
        res = await postSummary(host, token, body);
      } catch (err) {
        log(`quota: ${host} unreachable (${err.name})`);
        break; // network is down for this host; try the next one
      }

      if (res.ok) {
        let payload;
        try {
          payload = await res.json();
        } catch {
          payload = null;
        }
        const groups = (payload && Array.isArray(payload.groups) ? payload.groups : [])
          .map(normalizeGroup)
          .filter(Boolean);
        if (!groups.length) return null;
        return { groups, at: Date.now(), host: host.replace('https://', '').split('.')[0] };
      }

      const status = res.status;
      // A rejected credential is terminal: another host will reject it too.
      if (status === 401) return null;
      // Some accounts get 403 for a summary asked with a project; ask again without it.
      if (status === 403 && 'project' in body) continue;
      break;
    }
  }
  return null;
}

/** Flat list of every bucket, useful for the client and for tests. */
export function flattenGroups(groups) {
  return (groups || []).flatMap((group) =>
    group.buckets.map((bucket) => ({ group: group.name, ...bucket })),
  );
}