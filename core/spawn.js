// core/spawn.js — cross-platform CLI spawning.
// Uses cross-spawn so Windows npm `.cmd`/`.bat` shims launch correctly and args
// (like the prompt) are escaped properly through the cmd.exe hand-off — hand-rolling
// that quoting drops/mangles args (e.g. cline: "Unknown command or unquoted prompt").
const fs = require('fs');
const os = require('os');
const path = require('path');
const crossSpawn = require('cross-spawn');

function pathExts() {
  return process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
}

function candidatePaths(command) {
  if (!command || /[\\/]/.test(command)) return [command];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = pathExts();
  const names = process.platform === 'win32'
    ? [command, ...exts.map((e) => command.toLowerCase().endsWith(e.toLowerCase()) ? command : command + e)]
    : [command];
  return dirs.flatMap((dir) => names.map((name) => path.join(dir, name)));
}

// Best-effort resolve to a concrete binary path — used for DISPLAY only (resume strings),
// never handed to the spawner (cross-spawn does its own resolution safely).
function resolveCommand(command) {
  for (const c of candidatePaths(command)) {
    try { if (c && fs.existsSync(c) && fs.statSync(c).isFile()) return c; } catch {}
  }
  return command;
}

// A cwd that doesn't exist makes Windows spawn fail with a misleading "spawn <cmd> ENOENT".
// Fall back to home so a stale/relocated session dir degrades gracefully instead of hard-failing.
function safeOptions(options = {}) {
  const opts = { ...options };
  if (opts.cwd && !fs.existsSync(opts.cwd)) {
    console.warn(`[spawn] cwd does not exist: ${opts.cwd} — falling back to ${os.homedir()}`);
    opts.cwd = os.homedir();
  }
  return opts;
}

function spawnCli(command, args = [], options = {}) {
  return crossSpawn(command, args, safeOptions(options));
}

function spawnCliSync(command, args = [], options = {}) {
  return crossSpawn.sync(command, args, safeOptions(options));
}

module.exports = { candidatePaths, resolveCommand, spawnCli, spawnCliSync };
