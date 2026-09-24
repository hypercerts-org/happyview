import { cidForLex } from '@atproto/lex-cbor';
import { jsonToLex } from '@atproto/lexicon';

const collections = {
  location: 'app.certified.location',
  profile: 'app.certified.actor.profile',
  organization: 'app.certified.actor.organization',
};
const did = 'did:plc:abcdefghijklmnopqrstuvwx';
const indexedAt = '2025-01-02T03:04:05.000Z';

async function row(collection, rkey, fields, recordDid = did) {
  const record = { $type: collection, ...fields };
  const uri = `at://${recordDid}/${collection}/${rkey}`;
  const cid = (await cidForLex(jsonToLex(record))).toString();
  return { uri, did: recordDid, collection, rkey, cid, indexedAt, record };
}

export const profileRecords = await Promise.all([
  row(collections.profile, 'self', {
    displayName: 'Test Publisher', description: 'Location API deterministic fixture', createdAt: indexedAt,
  }),
  row(collections.profile, 'self', { displayName: 'Profile-only publisher', createdAt: indexedAt }, 'did:web:profile-only.example'),
]);

export const organizationRecords = await Promise.all([
  row(collections.organization, 'self', {
    organizationType: ['nonprofit'], visibility: 'public', createdAt: indexedAt,
  }),
  row(collections.organization, 'self', { organizationType: ['community'], createdAt: indexedAt }, 'did:web:organization-only.example'),
]);

export const locationRecords = await Promise.all([
  row(collections.location, '3jzfcijpj2z2a', {
    lpVersion: '1.0.0', srs: 'https://www.opengis.net/def/crs/OGC/1.3/CRS84', locationType: 'geojson',
    location: { $type: 'app.certified.location#string', string: '{"type":"Point","coordinates":[89.64,27.47]}' }, name: 'Thimphu Forest',
    description: 'Community forest restoration area', createdAt: '2025-01-01T00:00:00.000Z',
  }),
  row(collections.location, '3jzfcijpj2z2b', {
    lpVersion: '1.0.0', srs: 'https://www.opengis.net/def/crs/OGC/1.3/CRS84', locationType: 'address',
    location: { $type: 'app.certified.location#string', string: 'Wang Chhu riverbank' }, name: 'Wang Chhu Riverbank',
    description: 'Urban river monitoring site', createdAt: '2025-01-02T00:00:00.000Z',
  }),
  row(collections.location, '3jzfcijpj2z2c', {
    lpVersion: '1.0.0', srs: 'https://www.opengis.net/def/crs/OGC/1.3/CRS84', locationType: 'geojson',
    location: {
      $type: 'org.hypercerts.defs#smallBlob',
      blob: {
        $type: 'blob',
        ref: { $link: 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy' },
        mimeType: 'application/geo+json',
        size: 68,
      },
    },
    name: 'Blob-backed test location',
    description: 'Synthetic blob reference for offline record-shape and API pass-through tests; blob bytes are not included.',
    createdAt: '2025-01-03T00:00:00.000Z',
  }),
  row(collections.location, '3jzfcijpj2z2d', {
    lpVersion: '1.0.0', srs: 'https://www.opengis.net/def/crs/OGC/1.3/CRS84', locationType: '',
    location: { $type: 'app.certified.location#string', string: String.raw`Literal 100%_\path and + spaces` },
    name: String.raw`Literal 100%_\path and + spaces`, description: 'Search metacharacter fixture', createdAt: '2025-01-04T00:00:00+01:00',
  }),
  row(collections.location, '3jzfcijpj2z2e', {
    lpVersion: '1.0.0', srs: 'https://www.opengis.net/def/crs/OGC/1.3/CRS84', locationType: 'geojson-point',
    location: { $type: 'app.certified.location#string', string: 'No linked author records' },
    name: 'Unhydrated author', createdAt: '2025-01-04T00:00:00Z',
  }, 'did:web:no-relations.example'),
  row(collections.location, '3jzfcijpj2z2f', {
    lpVersion: '1.0.0', srs: 'https://www.opengis.net/def/crs/OGC/1.3/CRS84', locationType: 'geojson-point',
    location: { $type: 'app.certified.location#string', string: 'Profile without organization' },
    name: 'Profile-only author', createdAt: '2025-01-05T00:00:00Z',
  }, 'did:web:profile-only.example'),
  row(collections.location, '3jzfcijpj2z2g', {
    lpVersion: '1.0.0', srs: 'https://www.opengis.net/def/crs/OGC/1.3/CRS84', locationType: 'geojson-point',
    location: { $type: 'app.certified.location#string', string: 'Organization without profile' },
    name: 'Organization-only author', createdAt: '2025-01-06T00:00:00Z',
  }, 'did:web:organization-only.example'),
]);

export function seedSql({ disposableTestTarget = false } = {}) {
  if (disposableTestTarget !== true) throw new Error('Seeding requires explicit disposable-test target opt-in');
  return [...locationRecords, ...profileRecords, ...organizationRecords].map((record) => ({
    sql: 'INSERT INTO happyview_records (uri, did, collection, rkey, record, cid, indexed_at, created_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $7) ON CONFLICT (uri) DO UPDATE SET did = EXCLUDED.did, collection = EXCLUDED.collection, rkey = EXCLUDED.rkey, record = EXCLUDED.record, cid = EXCLUDED.cid, indexed_at = EXCLUDED.indexed_at, created_at = EXCLUDED.created_at',
    params: [record.uri, record.did, record.collection, record.rkey, JSON.stringify(record.record), record.cid, record.indexedAt],
  }));
}
