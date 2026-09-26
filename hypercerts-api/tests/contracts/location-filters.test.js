import test from 'node:test';
import assert from 'node:assert/strict';
import { contractUrl } from './helpers.js';

test('listLocations filter names and values serialize as expected', () => {
  assert.equal(contractUrl('http://127.0.0.1:8080', 'app.certified.location.listLocations', {
    authors: ['did:plc:a', 'did:plc:b'],
    uris: ['at://did:plc:a/app.certified.location/3jzfcijpj2z2a'],
    locationTypes: ['geojson', 'address'],
    sortDirection: 'asc',
  }), 'http://127.0.0.1:8080/xrpc/app.certified.location.listLocations?authors=did%3Aplc%3Aa&authors=did%3Aplc%3Ab&uris=at%3A%2F%2Fdid%3Aplc%3Aa%2Fapp.certified.location%2F3jzfcijpj2z2a&locationTypes=geojson&locationTypes=address&sortDirection=asc');
});
