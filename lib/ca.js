// lib/ca.js — best-effort CA trust so the Slack bridge's Socket Mode TLS works
// behind a corporate TLS-inspecting proxy. Never throws; returns env to merge.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// macOS keychains holding the system + MDM/corporate root certs.
const MAC_KEYCHAINS = [
  '/System/Library/Keychains/SystemRootCertificates.keychain',
  '/Library/Keychains/System.keychain',
];

// Export the macOS trust store to a PEM bundle if it's missing. Idempotent, best-effort.
function provisionMacCa(pem) {
  if (fs.existsSync(pem)) return;
  let out = '';
  for (const kc of MAC_KEYCHAINS) {
    try { out += execFileSync('security', ['find-certificate', '-a', '-p', kc], { encoding: 'utf8', timeout: 8000 }); } catch {}
  }
  if (out.includes('BEGIN CERTIFICATE')) { try { fs.writeFileSync(pem, out, { mode: 0o600 }); } catch {} }
}

// Returns env vars that make Node trust the OS/corporate CA. Never throws.
function caEnv(bridgeDir) {
  const env = {};
  try {
    const pem = path.join(bridgeDir, 'macos-ca.pem');
    if (process.platform === 'darwin') provisionMacCa(pem);
    if (fs.existsSync(pem)) env.NODE_EXTRA_CA_CERTS = pem;
    // Belt-and-suspenders (covers Windows/Linux corp CAs): trust the OS store when this Node supports it.
    try {
      if (process.allowedNodeEnvironmentFlags && process.allowedNodeEnvironmentFlags.has('--use-system-ca')) {
        env.NODE_OPTIONS = [process.env.NODE_OPTIONS, '--use-system-ca'].filter(Boolean).join(' ');
      }
    } catch {}
  } catch {}
  return env;
}

module.exports = { caEnv, provisionMacCa };
