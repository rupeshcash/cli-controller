// core/spawn.js — cross-platform helpers for spawning installed CLI binaries.
// On Windows, npm package bins are often .cmd shims or JS files without a native
// executable bit. Normalize those forms so adapters can use spawn without shell.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

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

function resolveCommand(command) {
  for (const c of candidatePaths(command)) {
    try { if (c && fs.existsSync(c) && fs.statSync(c).isFile()) return c; } catch {}
  }
  return command;
}

function normalizeSpawn(command, args = []) {
  const ext = path.extname(command || '').toLowerCase();
  // JS-based bins (no native executable) must run through the Node runtime.
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    return { command: process.execPath, args: [command, ...args] };
  }
  // Windows: route through cmd.exe, which resolves .exe/.cmd/.bat shims via PATHEXT.
  // Use ComSpec (the full path to cmd.exe) so spawn can actually find it, and pass the
  // command NAME (never a PATH-derived absolute path) so we don't hand spawn an
  // uncontrolled absolute path (CodeQL js/shell-command-injection-from-environment).
  if (process.platform === 'win32') {
    return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command, ...args] };
  }
  // POSIX: spawn (shell:false) resolves a bare name via PATH itself; an explicit path is used as-is.
  return { command, args };
}

function spawnCli(command, args = [], options = {}) {
  const n = normalizeSpawn(command, args);
  return spawn(n.command, n.args, { ...options, shell: false });
}

function spawnCliSync(command, args = [], options = {}) {
  const n = normalizeSpawn(command, args);
  return spawnSync(n.command, n.args, { ...options, shell: false });
}

module.exports = { candidatePaths, resolveCommand, normalizeSpawn, spawnCli, spawnCliSync };