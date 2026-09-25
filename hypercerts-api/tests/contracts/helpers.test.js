import test from 'node:test';
import assert from 'node:assert/strict';
import { contractUrl, requireContractTarget } from './helpers.js';

test('repeated arrays use unbracketed keys, omit empty options, and preserve URL encoding', () => {
  assert.equal(contractUrl('http://127.0.0.1:8080', 'org.example.search', {
    authors: ['did:plc:a', 'did:plc:b'], empty: [], search: 'river bank + 50%',
  }), 'http://127.0.0.1:8080/xrpc/org.example.search?authors=did%3Aplc%3Aa&authors=did%3Aplc%3Ab&search=river%20bank%20%2B%2050%25');
});

test('contract target must be an explicit supplied HTTP(S) URL', () => {
  assert.throws(() => requireContractTarget({}), /HAPPYVIEW_BASE_URL/);
  assert.equal(requireContractTarget({ HAPPYVIEW_BASE_URL: 'http://127.0.0.1:8000' }).origin, 'http://127.0.0.1:8000');
  assert.throws(() => requireContractTarget({ HAPPYVIEW_BASE_URL: 'https://happyview.example.com' }), /restricted to a local HappyView URL/);
});
