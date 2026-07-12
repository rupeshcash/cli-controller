#!/usr/bin/env bash
# Start the Kiro Slack bridge. Sets NODE_EXTRA_CA_CERTS before Node boots so TLS
# works behind a TLS-inspecting proxy / corporate CA (must be set pre-launch;
# dotenv loads too late for this one). Harmless if macos-ca.pem is absent.
cd "$(dirname "$0")"
if [ -f macos-ca.pem ]; then
  export NODE_EXTRA_CA_CERTS="$PWD/macos-ca.pem"
fi
exec node src/index.js
