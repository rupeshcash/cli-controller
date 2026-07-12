// lib/lifecycle.js — start/stop/status a long-running Node service, cross-platform.
// Pure Node (no bash, no `kill -0`) so it behaves identically on macOS/Linux/Windows.
// A "service" = { name, cwd, args:[scriptPath,...], pidFile, logFile, env }.
const fs = require('fs');
const { spawn } = require('child_process');

// existence probe: process.kill(pid,0) throws if dead; EPERM means alive-but-not-ours
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

// pid from file, only if the process is actually alive (else null; stale files ignored)
function readPid(pidFile) {
  try { const p = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10); return p && pidAlive(p) ? p : null; }
  catch { return null; }
}

function status(svc) { const pid = readPid(svc.pidFile); return { running: !!pid, pid: pid || null }; }

function start(svc) {
  const cur = readPid(svc.pidFile);
  if (cur) return { running: true, pid: cur, already: true };
  const out = fs.openSync(svc.logFile, 'a');
  const child = spawn(process.execPath, svc.args, {
    cwd: svc.cwd, env: { ...process.env, ...(svc.env || {}) }, detached: true, stdio: ['ignore', out, out],
  });
  child.unref();
  fs.writeFileSync(svc.pidFile, String(child.pid));
  return { running: true, pid: child.pid };
}

function stop(svc) {
  const pid = readPid(svc.pidFile);
  if (!pid) { try { fs.unlinkSync(svc.pidFile); } catch {} return { stopped: false }; }
  try { process.kill(pid, 'SIGTERM'); } catch {}
  try { fs.unlinkSync(svc.pidFile); } catch {}
  return { stopped: true, pid };
}

function restart(svc) { stop(svc); return start(svc); }

module.exports = { pidAlive, readPid, status, start, stop, restart };
