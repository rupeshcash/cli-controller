// core/spawn.js — helpers for launching external CLIs safely across platforms.
//
// Node's child_process.spawn(command, args, { shell: false }) is intentionally
// strict. On Windows, a command installed by npm is often exposed as a PowerShell
// shim (`foo.ps1`) plus a cmd shim (`foo.cmd`). PowerShell can run `foo`, but
// Node may fail with `spawn foo ENOENT`. Resolve bare commands to concrete
// executable files first so adapters can keep using args arrays without a shell.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const WIN_EXTS = ['.exe', '.cmd', '.bat', '.com'];

function hasPathSeparator(command) {
  return /[\\/]/.test(command || '');
}

function candidatePaths(command) {
  if (!command) return [];
  if (process.platform !== 'win32') return [command];

  const ext = path.extname(command).toLowerCase();
  // Prefer real Windows executables/shims before npm's extensionless shell shim.
  // The extensionless file is useful in POSIX shells but can fail with ENOENT or
  // EINVAL when launched from Windows via Node's shell-free spawn API.
  const names = ext ? [command] : [...WIN_EXTS.map((e) => command + e), command];

  if (hasPathSeparator(command)) return names;

  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  return pathDirs.flatMap((dir) => names.map((name) => path.join(dir, name)));
}

function resolveCommand(command) {
  if (process.platform !== 'win32' || !command) return command;
  for (const file of candidatePaths(command)) {
    try {
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
    } catch { /* keep searching */ }
  }
  return command;
}

function npmBinScript(command) {
  if (process.platform !== 'win32' || !command || hasPathSeparator(command)) return null;
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const pkgFile = path.join(dir, 'node_modules', command, 'package.json');
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && pkg.bin[command];
      if (!bin) continue;
      const script = path.resolve(path.dirname(pkgFile), bin);
      if (fs.existsSync(script) && fs.statSync(script).isFile()) return script;
    } catch { /* keep searching */ }
  }
  return null;
}

function resolveSpawn(command, args = []) {
  const script = npmBinScript(command);
  if (script) return { command: process.execPath, args: [script, ...args], displayCommand: command, resolvedCommand: script };
  const resolved = resolveCommand(command);
  return { command: resolved, args, displayCommand: command, resolvedCommand: resolved };
}

function spawnCli(command, args = [], options = {}) {
  const r = resolveSpawn(command, args);
  return spawn(r.command, r.args, { ...options, shell: false });
}

function spawnCliSync(command, args = [], options = {}) {
  const r = resolveSpawn(command, args);
  return spawnSync(r.command, r.args, { ...options, shell: false });
}

module.exports = { resolveCommand, resolveSpawn, spawnCli, spawnCliSync, candidatePaths, npmBinScript };