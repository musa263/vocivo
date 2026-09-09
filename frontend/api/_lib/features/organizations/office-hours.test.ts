import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultPbxConfig } from './pbx-config-store.js';
import { officeHoursDecision, userAvailableBySchedule, validOfficeTime, validTimeZone } from './office-hours.js';

const config = defaultPbxConfig();

test('evaluates weekly hours in the configured timezone', () => {
  const hours = structuredClone(config.officeHours);
  // Named explicitly rather than leaned on: the platform default is UTC, and a
  // test about honouring the configured zone should say which zone it means.
  hours.timezone = 'Asia/Riyadh';
  hours.weekdays.Monday = { enabled: true, start: '09:00', end: '17:00' };
  assert.equal(officeHoursDecision(hours, new Date('2026-08-24T07:00:00Z')).open, true);
  assert.equal(officeHoursDecision(hours, new Date('2026-08-24T18:00:00Z')).open, false);
});

test('new company phone systems accept calls every day by default', () => {
  assert.equal(officeHoursDecision(config.officeHours, new Date('2026-08-29T10:00:00Z')).open, true);
});

test('supports overnight office windows', () => {
  const hours = structuredClone(config.officeHours);
  hours.timezone = 'UTC';
  hours.weekdays.Monday = { enabled: true, start: '22:00', end: '06:00' };
  assert.equal(officeHoursDecision(hours, new Date('2026-08-24T23:00:00Z')).open, true);
  assert.equal(officeHoursDecision(hours, new Date('2026-08-25T03:00:00Z')).open, true);
});

test('honors holiday routing and always-available users', () => {
  const hours = structuredClone(config.officeHours);
  hours.holidays = [{ id: 'eid', name: 'Holiday', date: '2026-08-24', destination: 'Main voicemail' }];
  assert.equal(officeHoursDecision(hours, new Date('2026-08-24T07:00:00Z')).open, false);
  assert.equal(userAvailableBySchedule({ schedule: 'Always available' } as never, hours, new Date('2026-08-24T07:00:00Z')), true);
});

test('validates office time and timezone values', () => {
  assert.equal(validOfficeTime('09:30'), true);
  assert.equal(validOfficeTime('25:00'), false);
  assert.equal(validTimeZone('Asia/Riyadh'), true);
  assert.equal(validTimeZone('Not/AZone'), false);
});
