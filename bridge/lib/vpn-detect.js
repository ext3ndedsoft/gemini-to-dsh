/**
 * Is a real VPN tunnel up?
 *
 * `mode: 'vpn'` means "do not relay anything, the traffic already leaves through a tunnel the
 * user runs". That only makes sense if we can tell whether such a tunnel exists, otherwise the
 * mode is a silent switch to direct with a nicer name. This probes the adapters, not WARP:
 * Cloudflare WARP is used for something else entirely and its presence proves nothing.
 *
 * Detection is best effort and cached, so a slow or missing PowerShell never blocks a request.
 */

import { execFile } from 'node:child_process';

/** Adapter descriptions that mean a user-space VPN, not a physical NIC. */
const TUNNEL_HINTS =
  /wireguard|openvpn|tap-windows|wintun|tailscale|nordlynx|proton|mullvad|surfshark|expressvpn|globalprotect|anyconnect|fortinet|cisco|softether|tunnel|vpn/i;

const REFRESH_MS = Number(process.env.AG_VPN_REFRESH_MS || 15000);

const SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$rows = @()
foreach ($a in Get-NetAdapter) {
  if ($a.Status -ne 'Up') { continue }
  $route = Get-NetRoute -InterfaceIndex $a.ifIndex -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
    Sort-Object RouteMetric | Select-Object -First 1
  $rows += [pscustomobject]@{
    name         = $a.Name
    description  = $a.InterfaceDescription
    ifIndex      = [int]$a.ifIndex
    hasDefault   = [bool]$route
    metric       = if ($route) { [int]$route.RouteMetric } else { $null }
  }
}
ConvertTo-Json -InputObject $rows -Compress -Depth 3
`;

let snapshot = { checkedAt: 0, connected: false, name: null, kind: null, interfaces: [] };
let timer = null;
let running = false;

function platformScript() {
  if (process.platform === 'win32') {
    return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', SCRIPT] };
  }
  // Linux/macOS: one line per interface, no JSON dependency.
  return {
    file: 'sh',
    args: ['-c', "ip -o link show up 2>/dev/null | awk -F': ' '{print $2}' || ifconfig -l 2>/dev/null"],
  };
}

function classify(rows) {
  const tunnels = rows.filter((row) => TUNNEL_HINTS.test(`${row.name || ''} ${row.description || ''}`));
  if (!tunnels.length) return { connected: false, name: null, kind: null };
  // Prefer a tunnel that actually carries the default route: that is the one the traffic uses.
  const carrier = tunnels.find((row) => row.hasDefault) || tunnels[0];
  return {
    connected: true,
    name: carrier.name || null,
    kind: carrier.description || null,
    carriesDefault: Boolean(carrier.hasDefault),
  };
}

function probe() {
  return new Promise((resolve) => {
    const { file, args } = platformScript();
    const child = execFile(file, args, { timeout: 8000, windowsHide: true }, (error, stdout) => {
      if (error) return resolve([{ name: '', description: '', hasDefault: false, error: error.message }]);
      if (process.platform !== 'win32') {
        const names = String(stdout || '').split(/\s+/).filter(Boolean);
        return resolve(names.map((name) => ({ name, description: name, hasDefault: false })));
      }
      try {
        const text = String(stdout || '').trim();
        if (!text) return resolve([]);
        const parsed = JSON.parse(text);
        resolve(Array.isArray(parsed) ? parsed : [parsed]);
      } catch {
        resolve([]);
      }
    });
    child.on('error', () => resolve([]));
  });
}

async function refresh() {
  if (running) return;
  running = true;
  try {
    const rows = await probe();
    const verdict = classify(Array.isArray(rows) ? rows : []);
    snapshot = {
      checkedAt: Date.now(),
      interfaces: (Array.isArray(rows) ? rows : []).map((row) => row.name).filter(Boolean),
      ...verdict,
    };
  } catch {
    snapshot = { checkedAt: Date.now(), connected: false, name: null, kind: null, interfaces: [] };
  } finally {
    running = false;
  }
}

export function startVpnWatch() {
  if (timer) return;
  refresh();
  timer = setInterval(refresh, Math.max(3000, REFRESH_MS));
  if (timer.unref) timer.unref();
}

export function vpnSnapshot() {
  return { ...snapshot };
}

export function refreshVpnNow() {
  return refresh();
}

export { TUNNEL_HINTS };