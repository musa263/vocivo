import { randomUUID } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAdmin } from '../../auth/auth.js';
import { allowMobile, methodNotAllowed, publicError, writeAuthError } from '../../../shared/http.js';
import { readPbxConfig } from '../../organizations/pbx-config-store.js';
import { telnyx } from '../../../shared/telnyx.js';
import {
  deleteRateRule,
  deleteTopupPackage,
  readPlatformWalletState,
  recordWalletAdjustment,
  retailRateFromWholesale,
  savePricingSettings,
  saveRateRule,
  saveTopupPackage,
  saveWalletControls,
  type RateRule,
  type TopupPackage,
  type WalletEntryType,
} from '../wallet-store.js';

function text(value: unknown, max = 120) {
  return typeof value === 'string' ? value.replace(/[\r\n]/g, ' ').trim().slice(0, max) : '';
}

function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error('A numeric value is invalid.');
  return parsed;
}

async function carrierTreasury() {
  try {
    const response = await telnyx('/balance');
    const payload = await response.json() as { data?: { balance?: string; credit_limit?: string; available_credit?: string; currency?: string } };
    const data = payload.data || {};
    return {
      balanceMinor: Math.round(Number(data.balance || 0) * 100),
      availableCreditMinor: Math.round(Number(data.available_credit || data.credit_limit || 0) * 100),
      currency: data.currency || 'USD',
      status: 'available' as const,
    };
  } catch (error) {
    console.error('[wallets] Unable to read Telnyx treasury balance', error);
    return { balanceMinor: null, availableCreditMinor: null, currency: 'USD', status: 'unavailable' as const };
  }
}

async function responseFor() {
  const config = await readPbxConfig();
  const state = await readPlatformWalletState(config.organizations.map((organization) => ({ id: organization.id, currency: 'USD' })));
  const treasury = await carrierTreasury();
  const organizationMap = new Map(config.organizations.map((organization) => [organization.id, organization]));
  const wallets = state.wallets.map((wallet) => {
    const organization = organizationMap.get(wallet.organizationId);
    return {
      ...wallet,
      organizationName: organization?.name || 'Removed customer',
      accountType: organization?.accountType || 'business',
    };
  });
  const customerLiabilityMinor = wallets.reduce((total, wallet) => total + wallet.availableMinor + wallet.reservedMinor, 0);
  const carrierFunds = treasury.balanceMinor === null ? null : Math.max(0, treasury.balanceMinor) + Math.max(0, treasury.availableCreditMinor || 0);
  return {
    treasury,
    summary: {
      customerLiabilityMinor,
      reservedMinor: wallets.reduce((total, wallet) => total + wallet.reservedMinor, 0),
      credits30dMinor: state.totals30d.credits,
      debits30dMinor: state.totals30d.debits,
      coveragePercent: carrierFunds === null || customerLiabilityMinor === 0 ? null : Math.round(carrierFunds / customerLiabilityMinor * 10_000) / 100,
    },
    wallets,
    entries: state.entries,
    settings: state.settings,
    packages: state.packages,
    rateRules: state.rateRules.map((rule) => ({
      ...rule,
      retailRateMicros: retailRateFromWholesale({
        wholesaleRateMicros: rule.wholesaleRateMicros,
        grossMarginBps: rule.grossMarginBps ?? state.settings.grossMarginBps,
        fxBufferBps: state.settings.fxBufferBps,
        surchargeMicros: rule.surchargeMicros,
      }),
    })),
  };
}

function requireSuperadmin(superadmin: boolean) {
  if (!superadmin) throw new Error('SuperadminRequired');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (allowMobile(req, res)) return;
  if (!['GET', 'PUT', 'DELETE'].includes(req.method || '')) return methodNotAllowed(res, ['GET', 'PUT', 'DELETE']);
  try {
    const access = await requireAdmin(req);
    requireSuperadmin(access.superadmin);
    if (req.method === 'GET') return res.status(200).json(await responseFor());

    const action = text(req.body?.action, 40);
    // The verb has to agree with the action, or a DELETE carrying
    // "adjust_wallet" moves money while every method-based rule and audit line
    // reads as a deletion.
    if (action.startsWith('delete_') ? req.method !== 'DELETE' : req.method !== 'PUT') {
      return res.status(405).json({ error: `${action.startsWith('delete_') ? 'Deleting' : 'Saving'} uses ${action.startsWith('delete_') ? 'DELETE' : 'PUT'}.` });
    }
    const config = await readPbxConfig();
    if (action === 'adjust_wallet') {
      const organizationId = text(req.body?.organizationId, 80);
      if (!config.organizations.some((organization) => organization.id === organizationId)) return res.status(404).json({ error: 'Customer was not found.' });
      const type = text(req.body?.entryType, 30) as WalletEntryType;
      const direction = req.body?.direction === 'debit' ? 'debit' : 'credit';
      const allowedTypes: WalletEntryType[] = ['topup', 'manual_credit', 'manual_debit', 'refund', 'chargeback', 'promotion'];
      if (!allowedTypes.includes(type)) throw new Error('Wallet entry type is invalid.');
      if (type === 'manual_debit' || type === 'chargeback' ? direction !== 'debit' : direction !== 'credit') throw new Error('Wallet entry direction does not match its type.');
      const reference = text(req.body?.reference, 120);
      if (['topup', 'refund', 'chargeback'].includes(type) && !reference) throw new Error('A payment or transaction reference is required.');
      // The caller supplies this or the request is refused. Minting one here
      // meant a double-clicked "credit $250", or a browser retrying a request
      // that had timed out, arrived as two different keys and credited the
      // customer twice — the wallet store implements idempotency properly, and
      // this was the one line that opted out of it.
      const idempotencyKey = text(req.body?.idempotencyKey, 120);
      if (!idempotencyKey) return res.status(400).json({ error: 'An idempotency key is required so a retried adjustment cannot be applied twice.' });
      await recordWalletAdjustment({
        organizationId,
        type,
        direction,
        amountMinor: integer(req.body?.amountMinor, 1, 100_000_000),
        reference,
        description: text(req.body?.description, 300),
        createdBy: access.session.email || access.session.sub || 'vocivo-superadmin',
        idempotencyKey,
      });
    } else if (action === 'save_wallet') {
      const organizationId = text(req.body?.wallet?.organizationId, 80);
      if (!config.organizations.some((organization) => organization.id === organizationId)) return res.status(404).json({ error: 'Customer was not found.' });
      await saveWalletControls({
        organizationId,
        status: req.body?.wallet?.status === 'frozen' ? 'frozen' : 'active',
        lowBalanceMinor: integer(req.body?.wallet?.lowBalanceMinor, 0, 100_000_000),
        autoRechargeEnabled: Boolean(req.body?.wallet?.autoRechargeEnabled),
        autoRechargeThresholdMinor: integer(req.body?.wallet?.autoRechargeThresholdMinor, 0, 100_000_000),
        autoRechargeAmountMinor: integer(req.body?.wallet?.autoRechargeAmountMinor, 0, 100_000_000),
      });
    } else if (action === 'save_settings') {
      await savePricingSettings({
        currency: text(req.body?.settings?.currency, 3).toUpperCase(),
        grossMarginBps: integer(req.body?.settings?.grossMarginBps, 0, 9000),
        fxBufferBps: integer(req.body?.settings?.fxBufferBps, 0, 5000),
        paymentFeeBps: integer(req.body?.settings?.paymentFeeBps, 0, 5000),
        minimumTopupMinor: integer(req.body?.settings?.minimumTopupMinor, 1, 100_000_000),
        lowCarrierBalanceMinor: integer(req.body?.settings?.lowCarrierBalanceMinor, 0, 100_000_000),
      });
    } else if (action === 'save_package') {
      const input = req.body?.package || {};
      await saveTopupPackage({
        id: text(input.id, 80), label: text(input.label, 80),
        amountMinor: integer(input.amountMinor, 1, 100_000_000), creditMinor: integer(input.creditMinor, 1, 100_000_000),
        active: input.active !== false, sortOrder: integer(input.sortOrder, 0, 10_000),
      } as TopupPackage);
    } else if (action === 'save_rate_rule') {
      const input = req.body?.rule || {};
      const margin = input.grossMarginBps === null || input.grossMarginBps === '' ? null : integer(input.grossMarginBps, 0, 9000);
      await saveRateRule({
        id: text(input.id, 80), countryCode: text(input.countryCode, 2).toUpperCase(), destinationName: text(input.destinationName, 100),
        wholesaleRateMicros: integer(input.wholesaleRateMicros, 0, 100_000_000), grossMarginBps: margin,
        surchargeMicros: integer(input.surchargeMicros, 0, 100_000_000), active: input.active !== false, updatedAt: new Date().toISOString(),
      } as RateRule);
    } else if (req.method === 'DELETE' && action === 'delete_package') {
      if (!await deleteTopupPackage(text(req.body?.id || req.query.id, 80))) return res.status(404).json({ error: 'Package was not found.' });
    } else if (req.method === 'DELETE' && action === 'delete_rate_rule') {
      if (!await deleteRateRule(text(req.body?.id || req.query.id, 80))) return res.status(404).json({ error: 'Rate rule was not found.' });
    } else {
      return res.status(400).json({ error: 'Choose a valid wallet administration action.' });
    }
    return res.status(200).json(await responseFor());
  } catch (error) {
    if (writeAuthError(res, error)) return;
    if (error instanceof Error && (error.message === 'Forbidden' || error.message === 'SuperadminRequired')) return res.status(403).json({ error: 'Only a Vocivo superadmin can manage customer wallets and pricing.' });
    if (error instanceof Error && /invalid|required|customer|wallet|amount|balance|margin|currency|top-up|direction|type/i.test(error.message)) return res.status(400).json({ error: error.message });
    return res.status(500).json({ error: publicError(error) });
  }
}
