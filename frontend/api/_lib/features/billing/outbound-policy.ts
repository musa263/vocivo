import { parsePhoneNumber } from 'libphonenumber-js';
import type { PbxConfig } from '../organizations/pbx-config-store.js';

type OutboundActor = {
  extension?: string;
  department?: string;
  internationalAllowed: boolean;
};

function numberInRange(value: string, expression: string) {
  const trimmed = expression.trim();
  if (!trimmed) return true;
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) return false;
  return trimmed.split(',').some((part) => {
    const match = part.trim().match(/^(\d{1,5})(?:\s*-\s*(\d{1,5}))?$/);
    if (!match) return false;
    const start = Number(match[1]);
    const end = Number(match[2] || match[1]);
    return numeric >= Math.min(start, end) && numeric <= Math.max(start, end);
  });
}

function lengthMatches(destination: string, expression: string) {
  const trimmed = expression.trim();
  if (!trimmed) return true;
  return numberInRange(destination.replace(/\D/g, '').length.toString(), trimmed);
}

function isInternational(destination: string, callerId: string) {
  try {
    const destinationCountry = parsePhoneNumber(destination).country;
    const callerCountry = parsePhoneNumber(callerId).country;
    // An unknown numbering region cannot establish permission for a domestic call.
    return !destinationCountry || !callerCountry || destinationCountry !== callerCountry;
  } catch {
    return true;
  }
}

export function authorizeOutboundCall(config: PbxConfig, actor: OutboundActor, destination: string, callerId: string) {
  if (!actor.internationalAllowed && isInternational(destination, callerId)) {
    throw new Error('International calling is disabled for this extension.');
  }

  const department = actor.department?.trim().toLowerCase() || '';
  const rule = config.outboundRules.find((candidate) => {
    if (!candidate.enabled || !candidate.routes.length) return false;
    if (candidate.prefix && !destination.startsWith(candidate.prefix.trim())) return false;
    if (!numberInRange(actor.extension || '', candidate.extensionRange)) return false;
    if (!lengthMatches(destination, candidate.numberLength)) return false;
    const requiredDepartment = candidate.department.trim().toLowerCase();
    if (requiredDepartment && requiredDepartment !== 'all' && requiredDepartment !== department) return false;
    return true;
  });
  if (!rule) throw new Error('No enabled outbound rule permits this call.');
  return rule;
}
