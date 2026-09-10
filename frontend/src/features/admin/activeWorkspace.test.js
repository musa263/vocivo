import assert from 'node:assert/strict';
import test from 'node:test';
import { findActiveWorkspace } from './activeWorkspace.js';

const organizations = [
  { id: 'company-a', name: 'Company A', ownerEmail: 'billing@a.example' },
  { id: 'company-b', name: 'Company B', ownerEmail: 'billing@b.example' },
];

test('the active workspace is the one that was opened', () => {
  const { index, organization } = findActiveWorkspace(organizations, 'company-b');
  assert.equal(index, 1);
  assert.equal(organization.name, 'Company B');
});

test('an active id that is not in the list resolves to nothing, never to a neighbour', () => {
  for (const missing of ['company-c', '', null, undefined]) {
    const { index, organization } = findActiveWorkspace(organizations, missing);
    assert.equal(index, -1, `${missing} must not select a row`);
    assert.equal(organization, null, 'another customer\'s contact and billing details are not a default');
  }
});

test('an absent organization list is not an error', () => {
  assert.deepEqual(findActiveWorkspace(undefined, 'company-a'), { index: -1, organization: null });
  assert.deepEqual(findActiveWorkspace([], 'company-a'), { index: -1, organization: null });
});
