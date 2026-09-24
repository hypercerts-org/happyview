import test from 'node:test';
import assert from 'node:assert/strict';
import { contractUrl, requireContractTarget } from './helpers.js';

test('repeated arrays are encoded as unbracketed query keys and empty optional arrays are omitted', () => {
  assert.equal(contractUrl('http://127.0.0.1:8080', 'app.certified.location.listLocations', { authors: ['did:plc:a', 'did:plc:b'], uris: [], search: 'river bank' }),
    'http://127.0.0.1:8080/xrpc/app.certified.location.listLocations?authors=did%3Aplc%3Aa&authors=did%3Aplc%3Ab&search=river%20bank');
});

test('contract target must be an explicit supplied HTTP(S) URL', () => {
  assert.throws(() => requireContractTarget({}), /HAPPYVIEW_BASE_URL/);
  assert.equal(requireContractTarget({ HAPPYVIEW_BASE_URL: 'http://127.0.0.1:8000' }).origin, 'http://127.0.0.1:8000');
  assert.throws(() => requireContractTarget({ HAPPYVIEW_BASE_URL: 'https://happyview.example.com' }), /restricted to a local HappyView URL/);
});
