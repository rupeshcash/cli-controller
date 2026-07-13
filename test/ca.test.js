const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { caEnv } = require('../lib/ca');

test('caEnv trusts an existing CA bundle and never throws', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-'));
  const pem = path.join(dir, 'macos-ca.pem');
  fs.writeFileSync(pem, '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n');
  const env = caEnv(dir);
  assert.equal(env.NODE_EXTRA_CA_CERTS, pem);
  assert.equal(typeof env, 'object');
});
