'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const si = require('systeminformation');

const execFileAsync = promisify(execFile);
const REPOSITORY = 'smells1k/nova-island';
const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'NOVA-Island-Desktop',
  'X-GitHub-Api-Version': '2022-11-28',
};
let githubCache = { value: null, expiresAt: 0 };
let discordCache = { value: null, expiresAt: 0 };

function finitePercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number * 10) / 10)) : null;
}

function usableTemperature(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number < 150 ? Math.round(number * 10) / 10 : null;
}

async function getMachineSnapshot() {
  const results = await Promise.allSettled([
    si.currentLoad(),
    si.mem(),
    si.cpuTemperature(),
    si.diskLayout(),
    si.cpu(),
  ]);
  const load = results[0].status === 'fulfilled' ? results[0].value : {};
  const memory = results[1].status === 'fulfilled' ? results[1].value : {};
  const cpuTemp = results[2].status === 'fulfilled' ? results[2].value : {};
  const disks = results[3].status === 'fulfilled' && Array.isArray(results[3].value) ? results[3].value : [];
  const cpu = results[4].status === 'fulfilled' ? results[4].value : {};
  const totalBytes = Number(memory.total) || os.totalmem();
  const usedBytes = Number(memory.used) || (totalBytes - os.freemem());
  const diskTemps = disks.map((disk) => usableTemperature(disk && disk.temperature)).filter((value) => value !== null);
  const discordRunning = await isDiscordRunning();
  return {
    ok: true,
    platform: process.platform,
    cpuPercent: finitePercent(load.currentLoad),
    ramUsedBytes: usedBytes,
    ramTotalBytes: totalBytes,
    ramPercent: finitePercent(totalBytes ? (usedBytes / totalBytes) * 100 : null),
    cpuTemperatureC: usableTemperature(cpuTemp.main),
    diskTemperatureC: diskTemps.length ? Math.max(...diskTemps) : null,
    cpuModel: String(cpu.brand || cpu.manufacturer || '').trim().slice(0, 80),
    discordRunning,
    sampledAt: Date.now(),
  };
}

async function isDiscordRunning() {
  if (discordCache.expiresAt > Date.now()) return discordCache.value;
  let running = null;
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('tasklist.exe', ['/FO', 'CSV', '/NH'], { timeout: 2500, windowsHide: true, maxBuffer: 1024 * 1024 });
      running = /\bdiscord(?:canary|ptb)?\.exe\b/i.test(stdout);
    } else if (process.platform === 'linux') {
      const { stdout } = await execFileAsync('pgrep', ['-af', 'discord'], { timeout: 1500, maxBuffer: 256 * 1024 });
      running = /discord/i.test(stdout);
    } else {
      running = false;
    }
  } catch (error) {
    // pgrep returns exit code 1 when nothing matches; tasklist can be unavailable in test environments.
    running = error && error.code === 1 ? false : null;
  }
  discordCache = { value: running, expiresAt: Date.now() + 10000 };
  return running;
}

function validatePingTarget(value) {
  const host = String(value || '').trim().replace(/\.$/, '');
  if (!host || host.length > 253 || host.includes('..') || !/^[a-zA-Z0-9.-]+$/.test(host)) return '';
  if (host.startsWith('.') || host.startsWith('-') || host.endsWith('-')) return '';
  const labels = host.split('.');
  if (labels.some((label) => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-'))) return '';
  return host;
}

function parsePingTime(output) {
  const text = String(output || '');
  const match = text.match(/(?:time|время)\s*[=<]\s*([\d.,]+)\s*(?:m\s*s|мс)/i)
    || text.match(/(?:time|время)\s*[=<]\s*([\d.,]+)\s*(?:ms|мс)/i);
  if (!match) return null;
  const value = Number(String(match[1]).replace(',', '.'));
  return Number.isFinite(value) ? Math.max(0, Math.round(value * 10) / 10) : null;
}

async function pingHost(value) {
  const host = validatePingTarget(value);
  if (!host) return { ok: false, host: '', message: 'Укажи корректный адрес хоста (IP или домен).' };
  const args = process.platform === 'win32'
    ? ['-n', '1', '-w', '1800', host]
    : ['-c', '1', '-W', '2', host];
  let output = '';
  let commandError = null;
  try {
    const result = await execFileAsync('ping', args, { timeout: 3500, windowsHide: true, maxBuffer: 128 * 1024 });
    output = `${result.stdout || ''}\n${result.stderr || ''}`;
  } catch (error) {
    commandError = error;
    output = `${error && error.stdout ? error.stdout : ''}\n${error && error.stderr ? error.stderr : ''}`;
  }
  if (commandError && commandError.code === 'ENOENT') return { ok: false, host, message: 'Команда ping не найдена в системе.' };
  if (/operation not permitted|permission denied|доступ запрещён/i.test(output)) return { ok: false, host, message: 'Система запрещает ICMP ping этому приложению.' };
  if (commandError && commandError.killed) return { ok: false, host, message: 'Проверка превысила время ожидания.' };
  const latencyMs = parsePingTime(output);
  if (latencyMs !== null) return { ok: true, host, latencyMs, message: `${latencyMs} мс` };
  return { ok: false, host, latencyMs: null, message: 'Ответа нет · проверь сеть или доступность ICMP.' };
}

function parseVersion(value) {
  const match = String(value || '').match(/\d+(?:\.\d+){0,3}/);
  return match ? match[0].split('.').map((part) => Number(part) || 0) : [];
}

function isVersionNewer(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a.length || !b.length) return false;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index] || 0;
    const right = b[index] || 0;
    if (left !== right) return left > right;
  }
  return false;
}

async function fetchGitHubJson(url) {
  const response = await fetch(url, { headers: GITHUB_HEADERS, signal: AbortSignal.timeout(6000) });
  if (!response.ok) throw new Error(`GitHub ответил HTTP ${response.status}`);
  return response.json();
}

async function getRepositoryStatus(currentVersion) {
  if (githubCache.expiresAt > Date.now() && githubCache.value) {
    return { ...githubCache.value, currentVersion, updateAvailable: isVersionNewer(githubCache.value.latestTag, currentVersion) };
  }
  try {
    const [release, commits] = await Promise.all([
      fetchGitHubJson(`https://api.github.com/repos/${REPOSITORY}/releases/latest`),
      fetchGitHubJson(`https://api.github.com/repos/${REPOSITORY}/commits?per_page=1&sha=main`),
    ]);
    const commit = Array.isArray(commits) && commits[0] ? commits[0] : null;
    const value = {
      ok: true,
      repository: REPOSITORY,
      latestTag: String(release.tag_name || ''),
      releaseUrl: String(release.html_url || ''),
      publishedAt: String(release.published_at || ''),
      latestCommit: commit ? {
        sha: String(commit.sha || '').slice(0, 8),
        message: String(commit.commit && commit.commit.message || '').split(/\r?\n/)[0].slice(0, 150),
        date: String(commit.commit && commit.commit.author && commit.commit.author.date || ''),
      } : null,
      checkedAt: Date.now(),
    };
    githubCache = { value, expiresAt: Date.now() + 5 * 60 * 1000 };
    return { ...value, currentVersion, updateAvailable: isVersionNewer(value.latestTag, currentVersion) };
  } catch (error) {
    return { ok: false, repository: REPOSITORY, currentVersion, message: error && error.message ? error.message : 'GitHub недоступен.' };
  }
}

function spawnDetached(command, args) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    } catch (error) {
      reject(error);
      return;
    }
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

async function openTerminal() {
  if (process.platform === 'win32') {
    try {
      await spawnDetached('wt.exe', []);
    } catch {
      await spawnDetached('cmd.exe', ['/c', 'start', '', 'cmd.exe']);
    }
    return { ok: true, message: 'Терминал запущен.' };
  }
  const candidates = process.platform === 'linux' ? ['x-terminal-emulator', 'xterm'] : ['open'];
  for (const command of candidates) {
    try {
      await spawnDetached(command, []);
      return { ok: true, message: 'Терминал запущен.' };
    } catch {
      // Try the next known terminal without passing user-supplied arguments.
    }
  }
  return { ok: false, message: 'Терминал не найден в системе.' };
}

async function clearOldUserTempFiles() {
  const root = path.resolve(os.tmpdir());
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  let removed = 0;
  let bytes = 0;
  try {
    const entries = await fs.promises.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const filePath = path.resolve(root, entry.name);
      const relative = path.relative(root, filePath);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
      try {
        const stat = await fs.promises.lstat(filePath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.mtimeMs >= cutoff) continue;
        await fs.promises.unlink(filePath);
        removed += 1;
        bytes += stat.size;
      } catch {
        // Skip files in use, protected files, and entries that vanish during cleanup.
      }
    }
  } catch (error) {
    return { ok: false, message: `Не удалось проверить пользовательскую временную папку: ${error.message}` };
  }
  return { ok: true, removed, bytes, message: `Удалено файлов: ${removed}; освобождено ${bytes} байт. Очищались только старые файлы верхнего уровня в пользовательской TEMP-папке.` };
}

async function restartExplorer() {
  if (process.platform !== 'win32') return { ok: false, message: 'Перезапуск Проводника доступен только в Windows.' };
  const script = "$ErrorActionPreference='Stop'; Get-Process explorer -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep -Milliseconds 500; Start-Process explorer.exe";
  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 8000, windowsHide: true, maxBuffer: 128 * 1024 });
    return { ok: true, message: 'Проводник Windows перезапущен.' };
  } catch (error) {
    return { ok: false, message: `Не удалось перезапустить Проводник: ${error.message}` };
  }
}

async function adjustSystemControl(control, direction) {
  if (process.platform !== 'win32') return { ok: false, message: 'Управление громкостью и яркостью колесом доступно только в Windows.' };
  const mode = control === 'brightness' ? 'brightness' : (control === 'volume' ? 'volume' : '');
  const steps = Math.max(1, Math.min(8, Math.abs(Math.trunc(Number(direction) || 1))));
  const sign = Number(direction) < 0 ? -1 : 1;
  if (!mode) return { ok: false, message: 'Неизвестный системный регулятор.' };
  if (mode === 'volume') {
    const key = sign > 0 ? 0xAF : 0xAE;
    const script = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class NovaVolumeKey { [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra); }'; 1..${steps} | ForEach-Object { [NovaVolumeKey]::keybd_event([byte]${key}, 0, 0, [UIntPtr]::Zero); [NovaVolumeKey]::keybd_event([byte]${key}, 0, 2, [UIntPtr]::Zero) }`;
    try {
      await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 5000, windowsHide: true, maxBuffer: 64 * 1024 });
      return { ok: true, message: sign > 0 ? 'Громкость увеличена.' : 'Громкость уменьшена.' };
    } catch (error) {
      return { ok: false, message: `Не удалось изменить громкость: ${error.message}` };
    }
  }
  const delta = sign * steps * 5;
  const script = `$ErrorActionPreference='Stop'; $methods=Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods; $current=Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness | Select-Object -First 1 -ExpandProperty CurrentBrightness; if ($null -eq $current -or -not $methods) { throw 'Датчик яркости не обнаружен' }; $next=[Math]::Max(0,[Math]::Min(100,[int]$current + (${delta}))); foreach ($method in $methods) { Invoke-CimMethod -InputObject $method -MethodName WmiSetBrightness -Arguments @{Timeout=1;Brightness=[byte]$next} | Out-Null }; [Console]::Write($next)`;
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 7000, windowsHide: true, maxBuffer: 64 * 1024 });
    const value = Number(String(stdout || '').trim());
    return Number.isFinite(value)
      ? { ok: true, message: `Яркость: ${value}%.` }
      : { ok: false, message: 'Датчик яркости не найден. Для внешних мониторов может потребоваться DDC/CI.' };
  } catch (error) {
    return { ok: false, message: 'Изменение яркости недоступно: встроенный датчик экрана не найден или Windows отказала в доступе.' };
  }
}

const FULLSCREEN_PROBE = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NovaFullscreenProbe {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError=true)] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  public static string Read() { var h=GetForegroundWindow(); RECT r; uint pid; GetWindowRect(h,out r); GetWindowThreadProcessId(h,out pid); return pid+"|"+r.Left+"|"+r.Top+"|"+r.Right+"|"+r.Bottom; }
}
'@; [Console]::Write([NovaFullscreenProbe]::Read())
`;

const WINDOW_SURFACE_PROBE = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NovaRainWindowProbe {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@ -ErrorAction SilentlyContinue
$ownPid = __OWN_PID__
$items = [System.Collections.Generic.List[object]]::new()
[NovaRainWindowProbe]::EnumWindows({
  param($handle, $state)
  [uint32]$windowPid = 0
  [void][NovaRainWindowProbe]::GetWindowThreadProcessId($handle, [ref]$windowPid)
  if ($windowPid -eq $ownPid -or -not [NovaRainWindowProbe]::IsWindowVisible($handle) -or [NovaRainWindowProbe]::IsIconic($handle)) { return $true }
  $rect = [NovaRainWindowProbe+RECT]::new()
  if (-not [NovaRainWindowProbe]::GetWindowRect($handle, [ref]$rect)) { return $true }
  $width = $rect.Right - $rect.Left; $height = $rect.Bottom - $rect.Top
  if ($width -lt 170 -or $height -lt 90) { return $true }
  $items.Add([PSCustomObject]@{ id=$handle.ToInt64().ToString(); x=$rect.Left; y=$rect.Top; width=$width; height=$height })
  return $true
}, [IntPtr]::Zero) | Out-Null
$items | ConvertTo-Json -Compress
`;

async function getRainWindowSurfaces(ownPid, virtualBounds) {
  if (process.platform !== 'win32') return { supported: false, surfaces: [] };
  try {
    const script = WINDOW_SURFACE_PROBE.replace('__OWN_PID__', String(Math.max(0, Math.trunc(Number(ownPid) || 0))));
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 3500, windowsHide: true, maxBuffer: 512 * 1024 });
    const parsed = JSON.parse(String(stdout || '[]').trim() || '[]');
    const entries = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
    const bounds = virtualBounds && typeof virtualBounds === 'object' ? virtualBounds : { x:0, y:0, width:0, height:0 };
    const surfaces = entries.map((entry) => ({
      id: String(entry.id || ''), x: Number(entry.x) - (Number(bounds.x) || 0), y: Number(entry.y) - (Number(bounds.y) || 0),
      width: Number(entry.width), height: Number(entry.height),
    })).filter((item) => item.id && [item.x,item.y,item.width,item.height].every(Number.isFinite)
      && item.width >= 170 && item.height >= 90
      && !(item.x <= 2 && item.y <= 2 && item.width >= (Number(bounds.width) || Infinity) * .85 && item.height >= (Number(bounds.height) || Infinity) * .85)
      && item.x < (Number(bounds.width) || Infinity) && item.y < (Number(bounds.height) || Infinity)
      && item.x + item.width > 0 && item.y + item.height > 0);
    return { supported: true, surfaces: surfaces.slice(0, 60) };
  } catch {
    return { supported: true, surfaces: [] };
  }
}

async function isExternalFullscreen(displays, ownPid) {
  if (process.platform !== 'win32') return { supported: false, fullscreen: false };
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', FULLSCREEN_PROBE], { timeout: 3500, windowsHide: true, maxBuffer: 64 * 1024 });
    const [pidText, leftText, topText, rightText, bottomText] = String(stdout || '').trim().split('|');
    const pid = Number(pidText);
    const rect = { left: Number(leftText), top: Number(topText), right: Number(rightText), bottom: Number(bottomText) };
    if (!Number.isFinite(pid) || pid === Number(ownPid) || Object.values(rect).some((value) => !Number.isFinite(value))) return { supported: true, fullscreen: false };
    const fullscreen = (Array.isArray(displays) ? displays : []).some((display) => {
      const bounds = display && display.bounds;
      if (!bounds) return false;
      return rect.left <= bounds.x + 2 && rect.top <= bounds.y + 2
        && rect.right >= bounds.x + bounds.width - 2 && rect.bottom >= bounds.y + bounds.height - 2;
    });
    return { supported: true, fullscreen, pid };
  } catch {
    return { supported: true, fullscreen: false, error: 'Проверка полноэкранного окна не удалась.' };
  }
}

module.exports = {
  adjustSystemControl,
  isVersionNewer,
  parsePingTime,
  validatePingTarget,
  clearOldUserTempFiles,
  getMachineSnapshot,
  getRainWindowSurfaces,
  getRepositoryStatus,
  isExternalFullscreen,
  openTerminal,
  pingHost,
  restartExplorer,
};
