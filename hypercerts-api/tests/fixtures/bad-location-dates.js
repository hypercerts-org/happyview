import { makeDateCaseRows } from './bad-dates.js';
import { locationRecords } from './records.js';

export const badDateLocations = await makeDateCaseRows(locationRecords[0], {
  did: 'did:plc:baddatefixturesexamplexx',
  decorateRecord: (record, rkey) => ({
    ...record, locationType: 'date-test', name: `Date test ${rkey}`, description: 'Synthetic timestamp fixture',
  }),
});
