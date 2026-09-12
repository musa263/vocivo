import assert from 'node:assert/strict';
import test from 'node:test';
import { csvCell, reportCsv } from './report-export.js';
test('CSV quotes delimiters and neutralizes formula injection without inventing charges', () => {
  assert.equal(csvCell('=SUM(A1)'), '"\'=SUM(A1)"');
  assert.equal(csvCell('\t +123'), '"\'\t +123"');
  assert.equal(csvCell('a,"b"'), '"a,""b"""');
  assert.ok(reportCsv([{ cost: null }]).endsWith(',""'));
});
