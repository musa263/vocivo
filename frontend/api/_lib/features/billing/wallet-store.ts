import { randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { withDatabaseRetry } from '../../shared/object-store.js';

export type WalletStatus = 'active' | 'frozen';
export type WalletEntryType = 'topup' | 'manual_credit' | 'manual_debit' | 'refund' | 'chargeback' | 'promotion';

export type Wallet = {
  organizationId: string;
  currency: string;
  status: WalletStatus;
  availableMinor: number;
  reservedMinor: number;
  lowBalanceMinor: number;
  autoRechargeEnabled: boolean;
  autoRechargeThresholdMinor: number;
  autoRechargeAmountMinor: number;
  version: number;
  updatedAt: string;
};

export type WalletEntry = {
  id: string;
  organizationId: string;
  type: WalletEntryType;
  direction: 'credit' | 'debit';
  amountMinor: number;
  currency: string;
  balanceAfterMinor: number;
  reference: string;
  description: string;
  createdBy: string;
  createdAt: string;
};

export type PricingSettings = {
  currency: string;
  grossMarginBps: number;
  fxBufferBps: number;
  paymentFeeBps: number;
  minimumTopupMinor: number;
  lowCarrierBalanceMinor: number;
  updatedAt: string;
};

export type TopupPackage = {
  id: string;
  label: string;
  amountMinor: number;
  creditMinor: number;
  active: boolean;
  sortOrder: number;
};

export type RateRule = {
  id: string;
  countryCode: string;
  destinationName: string;
  wholesaleRateMicros: number;
  grossMarginBps: number | null;
  surchargeMicros: number;
  active: boolean;
  updatedAt: string;
};

type WalletRow = {
  organization_id: string;
  currency: string;
  status: string;
  available_minor: string | number;
  reserved_minor: string | number;
  low_balance_minor: string | number;
  auto_recharge_enabled: boolean;
  auto_recharge_threshold_minor: string | number;
  auto_recharge_amount_minor: string | number;
  version: string | number;
  updated_at: Date | string;
};

type EntryRow = {
  id: string;
  organization_id: string;
  entry_type: WalletEntryType;
  direction: 'credit' | 'debit';
  amount_minor: string | number;
  currency: string;
  balance_after_minor: string | number;
  reference: string;
  description: string;
  created_by: string;
  created_at: Date | string;
};

type SettingsRow = {
  currency: string;
  gross_margin_bps: number;
  fx_buffer_bps: number;
  payment_fee_bps: number;
  minimum_topup_minor: string | number;
  low_carrier_balance_minor: string | number;
  updated_at: Date | string;
};

type PackageRow = {
  package_id: string;
  label: string;
  amount_minor: string | number;
  credit_minor: string | number;
  active: boolean;
  sort_order: number;
};

type RateRuleRow = {
  rule_id: string;
  country_code: string;
  destination_name: string;
  wholesale_rate_micros: string | number;
  gross_margin_bps: number | null;
  surcharge_micros: string | number;
  active: boolean;
  updated_at: Date | string;
};

let walletTablesReady = false;
let walletTablesRequest: Promise<void> | null = null;

const integer = (value: string | number) => Number.parseInt(String(value), 10) || 0;
const iso = (value: Date | string) => new Date(value).toISOString();

function walletFromRow(row: WalletRow): Wallet {
  return {
    organizationId: row.organization_id,
    currency: row.currency,
    status: row.status === 'frozen' ? 'frozen' : 'active',
    availableMinor: integer(row.available_minor),
    reservedMinor: integer(row.reserved_minor),
    lowBalanceMinor: integer(row.low_balance_minor),
    autoRechargeEnabled: row.auto_recharge_enabled,
    autoRechargeThresholdMinor: integer(row.auto_recharge_threshold_minor),
    autoRechargeAmountMinor: integer(row.auto_recharge_amount_minor),
    version: integer(row.version),
    updatedAt: iso(row.updated_at),
  };
}

function entryFromRow(row: EntryRow): WalletEntry {
  return {
    id: row.id,
    organizationId: row.organization_id,
    type: row.entry_type,
    direction: row.direction,
    amountMinor: integer(row.amount_minor),
    currency: row.currency,
    balanceAfterMinor: integer(row.balance_after_minor),
    reference: row.reference,
    description: row.description,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
  };
}

function settingsFromRow(row: SettingsRow): PricingSettings {
  return {
    currency: row.currency,
    grossMarginBps: row.gross_margin_bps,
    fxBufferBps: row.fx_buffer_bps,
    paymentFeeBps: row.payment_fee_bps,
    minimumTopupMinor: integer(row.minimum_topup_minor),
    lowCarrierBalanceMinor: integer(row.low_carrier_balance_minor),
    updatedAt: iso(row.updated_at),
  };
}

function packageFromRow(row: PackageRow): TopupPackage {
  return {
    id: row.package_id,
    label: row.label,
    amountMinor: integer(row.amount_minor),
    creditMinor: integer(row.credit_minor),
    active: row.active,
    sortOrder: row.sort_order,
  };
}

function rateRuleFromRow(row: RateRuleRow): RateRule {
  return {
    id: row.rule_id,
    countryCode: row.country_code,
    destinationName: row.destination_name,
    wholesaleRateMicros: integer(row.wholesale_rate_micros),
    grossMarginBps: row.gross_margin_bps,
    surchargeMicros: integer(row.surcharge_micros),
    active: row.active,
    updatedAt: iso(row.updated_at),
  };
}

async function ensureWalletTables(sql: Sql) {
  if (walletTablesReady) return;
  walletTablesRequest ||= (async () => {
    await sql`
      create table if not exists vocivo_wallets (
        organization_id text primary key,
        currency varchar(3) not null default 'USD',
        status text not null default 'active' check (status in ('active', 'frozen')),
        available_minor bigint not null default 0 check (available_minor >= 0),
        reserved_minor bigint not null default 0 check (reserved_minor >= 0),
        low_balance_minor bigint not null default 1000 check (low_balance_minor >= 0),
        auto_recharge_enabled boolean not null default false,
        auto_recharge_threshold_minor bigint not null default 1000 check (auto_recharge_threshold_minor >= 0),
        auto_recharge_amount_minor bigint not null default 5000 check (auto_recharge_amount_minor >= 0),
        version bigint not null default 1,
        updated_at timestamptz not null default now()
      )
    `;
    await sql`
      create table if not exists vocivo_wallet_entries (
        id text primary key,
        organization_id text not null,
        entry_type text not null,
        direction text not null check (direction in ('credit', 'debit')),
        amount_minor bigint not null check (amount_minor > 0),
        currency varchar(3) not null,
        balance_after_minor bigint not null check (balance_after_minor >= 0),
        reference text not null default '',
        description text not null default '',
        created_by text not null,
        idempotency_key text not null,
        metadata jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now(),
        unique (organization_id, idempotency_key)
      )
    `;
    await sql`create index if not exists vocivo_wallet_entries_org_created_idx on vocivo_wallet_entries (organization_id, created_at desc)`;
    await sql`
      create table if not exists vocivo_pricing_settings (
        settings_id text primary key,
        currency varchar(3) not null,
        gross_margin_bps integer not null check (gross_margin_bps between 0 and 9000),
        fx_buffer_bps integer not null check (fx_buffer_bps between 0 and 5000),
        payment_fee_bps integer not null check (payment_fee_bps between 0 and 5000),
        minimum_topup_minor bigint not null check (minimum_topup_minor > 0),
        low_carrier_balance_minor bigint not null check (low_carrier_balance_minor >= 0),
        updated_at timestamptz not null default now()
      )
    `;
    await sql`
      create table if not exists vocivo_topup_packages (
        package_id text primary key,
        label text not null,
        amount_minor bigint not null check (amount_minor > 0),
        credit_minor bigint not null check (credit_minor > 0),
        active boolean not null default true,
        sort_order integer not null default 0,
        updated_at timestamptz not null default now()
      )
    `;
    await sql`
      create table if not exists vocivo_rate_rules (
        rule_id text primary key,
        country_code varchar(2) not null unique,
        destination_name text not null,
        wholesale_rate_micros bigint not null check (wholesale_rate_micros >= 0),
        gross_margin_bps integer check (gross_margin_bps between 0 and 9000),
        surcharge_micros bigint not null default 0 check (surcharge_micros >= 0),
        active boolean not null default true,
        updated_at timestamptz not null default now()
      )
    `;
    await sql`
      create table if not exists vocivo_schema_migrations (
        migration_id text primary key,
        applied_at timestamptz not null default now()
      )
    `;
    await sql.begin(async (transaction) => {
      await transaction`select pg_advisory_xact_lock(hashtext('vocivo:schema:wallet-rls-v1'))`;
      const applied = await transaction<Array<{ migration_id: string }>>`
        insert into vocivo_schema_migrations (migration_id)
        values ('wallet-rls-v1')
        on conflict (migration_id) do nothing
        returning migration_id
      `;
      if (!applied.length) return;
      await transaction`alter table vocivo_wallets enable row level security`;
      await transaction`alter table vocivo_wallets force row level security`;
      await transaction`alter table vocivo_wallet_entries enable row level security`;
      await transaction`alter table vocivo_wallet_entries force row level security`;
      await transaction.unsafe(`
        do $$ begin
          if not exists (select 1 from pg_policies where schemaname = current_schema() and tablename = 'vocivo_wallets' and policyname = 'vocivo_wallet_tenant_isolation') then
            create policy vocivo_wallet_tenant_isolation on vocivo_wallets
            using (current_setting('app.platform_access', true) = 'true' or organization_id = current_setting('app.organization_id', true))
            with check (current_setting('app.platform_access', true) = 'true' or organization_id = current_setting('app.organization_id', true));
          end if;
          if not exists (select 1 from pg_policies where schemaname = current_schema() and tablename = 'vocivo_wallet_entries' and policyname = 'vocivo_wallet_entry_tenant_isolation') then
            create policy vocivo_wallet_entry_tenant_isolation on vocivo_wallet_entries
            using (current_setting('app.platform_access', true) = 'true' or organization_id = current_setting('app.organization_id', true))
            with check (current_setting('app.platform_access', true) = 'true' or organization_id = current_setting('app.organization_id', true));
          end if;
        end $$;
      `);
    });
    await sql.begin(async (transaction) => {
      await transaction`select pg_advisory_xact_lock(hashtext('vocivo:schema:wallet-entry-type-check-v1'))`;
      const applied = await transaction<Array<{ migration_id: string }>>`
        insert into vocivo_schema_migrations (migration_id)
        values ('wallet-entry-type-check-v1')
        on conflict (migration_id) do nothing
        returning migration_id
      `;
      if (!applied.length) return;
      await transaction.unsafe(`
        do $$ begin
          if not exists (
            select 1 from pg_constraint
            where conname = 'vocivo_wallet_entries_entry_type_check'
              and conrelid = 'vocivo_wallet_entries'::regclass
          ) then
            alter table vocivo_wallet_entries
            add constraint vocivo_wallet_entries_entry_type_check
            check (entry_type in ('topup', 'manual_credit', 'manual_debit', 'refund', 'chargeback', 'promotion'))
            not valid;
          end if;
        end $$;
      `);
    });
    walletTablesReady = true;
  })().finally(() => { walletTablesRequest = null; });
  await walletTablesRequest;
}

async function setContext(transaction: TransactionSql, organizationId?: string, platform = false) {
  await transaction`select set_config('app.organization_id', ${organizationId || ''}, true)`;
  await transaction`select set_config('app.platform_access', ${platform ? 'true' : 'false'}, true)`;
}

async function seedPricing(transaction: TransactionSql) {
  await transaction`
    insert into vocivo_pricing_settings (
      settings_id, currency, gross_margin_bps, fx_buffer_bps, payment_fee_bps,
      minimum_topup_minor, low_carrier_balance_minor
    ) values ('global', 'USD', 3000, 300, 300, 1000, 10000)
    on conflict (settings_id) do nothing
  `;
  const packages = [
    ['topup-10', '$10 calling credit', 1000, 1000, 10],
    ['topup-25', '$25 calling credit', 2500, 2500, 20],
    ['topup-50', '$50 calling credit', 5000, 5000, 30],
    ['topup-100', '$100 calling credit', 10000, 10000, 40],
    ['topup-250', '$250 business credit', 25000, 25000, 50],
    ['topup-500', '$500 business credit', 50000, 50000, 60],
  ] as const;
  for (const [id, label, amount, credit, order] of packages) {
    await transaction`
      insert into vocivo_topup_packages (package_id, label, amount_minor, credit_minor, sort_order)
      values (${id}, ${label}, ${amount}, ${credit}, ${order})
      on conflict (package_id) do nothing
    `;
  }
}

async function ensureWallet(transaction: TransactionSql, organizationId: string, currency = 'USD') {
  await transaction`
    insert into vocivo_wallets (organization_id, currency)
    values (${organizationId}, ${currency})
    on conflict (organization_id) do nothing
  `;
}

export function retailRateFromWholesale(input: {
  wholesaleRateMicros: number;
  grossMarginBps: number;
  fxBufferBps?: number;
  surchargeMicros?: number;
}) {
  const wholesale = Math.max(0, Math.round(input.wholesaleRateMicros));
  const margin = Math.min(9000, Math.max(0, Math.round(input.grossMarginBps)));
  const buffered = wholesale * (1 + Math.max(0, input.fxBufferBps || 0) / 10_000);
  return Math.ceil(buffered / (1 - margin / 10_000) + Math.max(0, input.surchargeMicros || 0));
}

export const LAUNCH_CALLING_CREDIT_MINOR = 2500;
export const launchCallingCreditKey = (organizationId: string) => `launch-calling-credit:${organizationId}`;

async function applyLaunchCallingCreditIfEmpty(
  transaction: TransactionSql,
  organizationId: string,
  wallet: Wallet,
): Promise<Wallet> {
  if (wallet.status !== 'active' || wallet.availableMinor > 0) return wallet;
  const priorCredit = await transaction<Array<{ id: string }>>`
    select id from vocivo_wallet_entries
    where organization_id = ${organizationId} and direction = 'credit'
    limit 1
  `;
  if (priorCredit[0]) return wallet;
  const idempotencyKey = launchCallingCreditKey(organizationId);
  const nextBalance = wallet.availableMinor + LAUNCH_CALLING_CREDIT_MINOR;
  const updatedRows = await transaction<WalletRow[]>`
    update vocivo_wallets
    set available_minor = ${nextBalance}, version = version + 1, updated_at = now()
    where organization_id = ${organizationId} and version = ${wallet.version}
    returning *
  `;
  if (!updatedRows[0]) return wallet;
  await transaction`
    insert into vocivo_wallet_entries (
      id, organization_id, entry_type, direction, amount_minor, currency,
      balance_after_minor, reference, description, created_by, idempotency_key
    ) values (
      ${randomUUID()}, ${organizationId}, ${'promotion'}, ${'credit'}, ${LAUNCH_CALLING_CREDIT_MINOR},
      ${updatedRows[0].currency}, ${nextBalance}, ${''}, ${'Launch calling credit'},
      ${'vocivo-launch-credit'}, ${idempotencyKey}
    )
    on conflict (organization_id, idempotency_key) do nothing
  `;
  return walletFromRow(updatedRows[0]);
}

export function outboundWalletBlockReason(wallet: Pick<Wallet, 'status' | 'availableMinor'> | null | undefined) {
  if (!wallet) return 'Calling credit is not available.';
  if (wallet.status === 'frozen') return 'This account wallet is frozen.';
  if (wallet.availableMinor <= 0) return 'Calling credit is required before placing this call.';
  return '';
}

export function walletBalanceAfter(currentMinor: number, direction: 'credit' | 'debit', amountMinor: number) {
  if (!Number.isSafeInteger(currentMinor) || currentMinor < 0) throw new Error('Current wallet balance is invalid.');
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error('Wallet adjustment amount is invalid.');
  if (direction !== 'credit' && direction !== 'debit') throw new Error('Wallet adjustment direction is invalid.');
  const next = currentMinor + (direction === 'credit' ? amountMinor : -amountMinor);
  if (next < 0) throw new Error('This debit exceeds the customer wallet balance.');
  return next;
}

export async function readPlatformWalletState(organizations: Array<{ id: string; currency?: string }>) {
  return withDatabaseRetry(async (sql) => {
    await ensureWalletTables(sql);
    return sql.begin(async (transaction) => {
      await setContext(transaction, undefined, true);
      await seedPricing(transaction);
      for (const organization of organizations) await ensureWallet(transaction, organization.id, organization.currency || 'USD');
      const [walletRows, entryRows, settingsRows, packageRows, ruleRows, totalRows] = await Promise.all([
        transaction<WalletRow[]>`select * from vocivo_wallets order by updated_at desc`,
        transaction<EntryRow[]>`select * from vocivo_wallet_entries order by created_at desc limit 150`,
        transaction<SettingsRow[]>`select * from vocivo_pricing_settings where settings_id = 'global' limit 1`,
        transaction<PackageRow[]>`select * from vocivo_topup_packages order by sort_order, amount_minor`,
        transaction<RateRuleRow[]>`select * from vocivo_rate_rules order by destination_name`,
        transaction<Array<{credits: string; debits: string}>>`select
          coalesce(sum(amount_minor) filter (where direction = 'credit'),0)::text as credits,
          coalesce(sum(amount_minor) filter (where direction = 'debit'),0)::text as debits
          from vocivo_wallet_entries where created_at >= now() - interval '30 days'`,
      ]);
      return {
        totals30d: { credits: Number(totalRows[0].credits), debits: Number(totalRows[0].debits) },
        wallets: walletRows.map(walletFromRow),
        entries: entryRows.map(entryFromRow),
        settings: settingsFromRow(settingsRows[0]),
        packages: packageRows.map(packageFromRow),
        rateRules: ruleRows.map(rateRuleFromRow),
      };
    });
  });
}

export async function readTenantWallet(organizationId: string, currency = 'USD') {
  if (!organizationId) throw new Error('Wallet tenant is required.');
  return withDatabaseRetry(async (sql) => {
    await ensureWalletTables(sql);
    return sql.begin(async (transaction) => {
      // Tenant context, not platform: every query in here already filters on
      // organization_id, but this ran with platform access, which turns the
      // row-level isolation policy into a no-op for the one call every mobile
      // bootstrap and every outbound route makes. The database guard is worth
      // keeping precisely for the day a query here forgets its predicate.
      await setContext(transaction, organizationId, false);
      await transaction`select pg_advisory_xact_lock(hashtext(${`vocivo:wallet:${organizationId}`}))`;
      await ensureWallet(transaction, organizationId, currency);
      const rows = await transaction<WalletRow[]>`
        select * from vocivo_wallets where organization_id = ${organizationId} limit 1
      `;
      if (!rows[0]) throw new Error('Wallet not found.');
      return applyLaunchCallingCreditIfEmpty(transaction, organizationId, walletFromRow(rows[0]));
    });
  });
}

export async function readRetailRateDirectory<T extends { country_code: string; rate_per_min: number }>(baseRates: T[]): Promise<T[]> {
  return withDatabaseRetry<T[]>(async (sql) => {
    await ensureWalletTables(sql);
    const priced = await sql.begin(async (transaction) => {
      await setContext(transaction, undefined, true);
      await seedPricing(transaction);
      const [settingsRows, ruleRows] = await Promise.all([
        transaction<SettingsRow[]>`select * from vocivo_pricing_settings where settings_id = 'global' limit 1`,
        transaction<RateRuleRow[]>`select * from vocivo_rate_rules where active = true`,
      ]);
      const settings = settingsFromRow(settingsRows[0]);
      const rules = new Map(ruleRows.map((row) => [row.country_code, rateRuleFromRow(row)]));
      return baseRates.map((item): T => {
        const rule = rules.get(item.country_code);
        if (!rule) return item;
        const retailRateMicros = retailRateFromWholesale({
          wholesaleRateMicros: rule.wholesaleRateMicros,
          grossMarginBps: rule.grossMarginBps ?? settings.grossMarginBps,
          fxBufferBps: settings.fxBufferBps,
          surchargeMicros: rule.surchargeMicros,
        });
        return { ...item, rate_per_min: retailRateMicros / 1_000_000, rate_known: true } as T;
      });
    });
    return priced as T[];
  });
}

export async function recordWalletAdjustment(input: {
  organizationId: string;
  type: WalletEntryType;
  direction: 'credit' | 'debit';
  amountMinor: number;
  currency?: string;
  reference?: string;
  description?: string;
  createdBy: string;
  idempotencyKey: string;
}) {
  if (!input.organizationId) throw new Error('Customer is required.');
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0 || input.amountMinor > 100_000_000) throw new Error('Adjustment amount is invalid.');
  if (input.direction !== 'credit' && input.direction !== 'debit') throw new Error('Adjustment direction is invalid.');
  if (!(['topup', 'manual_credit', 'manual_debit', 'refund', 'chargeback', 'promotion'] satisfies WalletEntryType[]).includes(input.type)) throw new Error('Adjustment type is invalid.');
  if (typeof input.createdBy !== 'string' || !input.createdBy.trim()) throw new Error('Adjustment author is required.');
  if (!input.idempotencyKey || input.idempotencyKey.length > 120) throw new Error('Adjustment idempotency key is invalid.');
  return withDatabaseRetry(async (sql) => {
    await ensureWalletTables(sql);
    return sql.begin(async (transaction) => {
      await setContext(transaction, undefined, true);
      await transaction`select pg_advisory_xact_lock(hashtext(${`vocivo:wallet:${input.organizationId}`}))`;
      await ensureWallet(transaction, input.organizationId, input.currency || 'USD');
      const duplicate = await transaction<EntryRow[]>`
        select * from vocivo_wallet_entries
        where organization_id = ${input.organizationId} and idempotency_key = ${input.idempotencyKey}
        limit 1
      `;
      if (duplicate[0]) {
        const entry = entryFromRow(duplicate[0]);
        if (entry.amountMinor !== input.amountMinor || entry.direction !== input.direction || entry.type !== input.type) {
          throw new Error('This idempotency key was already used for a different adjustment.');
        }
        const wallets = await transaction<WalletRow[]>`select * from vocivo_wallets where organization_id = ${input.organizationId} limit 1`;
        return { wallet: walletFromRow(wallets[0]), entry, duplicate: true };
      }
      const wallets = await transaction<WalletRow[]>`
        select * from vocivo_wallets where organization_id = ${input.organizationId} for update
      `;
      const current = wallets[0];
      const currentBalance = integer(current.available_minor);
      const nextBalance = walletBalanceAfter(currentBalance, input.direction, input.amountMinor);
      const updatedRows = await transaction<WalletRow[]>`
        update vocivo_wallets
        set available_minor = ${nextBalance}, version = version + 1, updated_at = now()
        where organization_id = ${input.organizationId} and version = ${integer(current.version)}
        returning *
      `;
      if (!updatedRows[0]) throw new Error('Wallet changed while the adjustment was being applied.');
      const entryRows = await transaction<EntryRow[]>`
        insert into vocivo_wallet_entries (
          id, organization_id, entry_type, direction, amount_minor, currency,
          balance_after_minor, reference, description, created_by, idempotency_key
        ) values (
          ${randomUUID()}, ${input.organizationId}, ${input.type}, ${input.direction}, ${input.amountMinor},
          ${updatedRows[0].currency}, ${nextBalance}, ${(input.reference || '').slice(0, 120)},
          ${(input.description || '').slice(0, 300)}, ${input.createdBy.slice(0, 160)}, ${input.idempotencyKey}
        ) returning *
      `;
      return { wallet: walletFromRow(updatedRows[0]), entry: entryFromRow(entryRows[0]), duplicate: false };
    });
  });
}

export async function saveWalletControls(input: Pick<Wallet, 'organizationId' | 'status' | 'lowBalanceMinor' | 'autoRechargeEnabled' | 'autoRechargeThresholdMinor' | 'autoRechargeAmountMinor'>) {
  if (!input.organizationId) throw new Error('Customer is required.');
  if (!['active', 'frozen'].includes(input.status)) throw new Error('Wallet status is invalid.');
  for (const value of [input.lowBalanceMinor, input.autoRechargeThresholdMinor, input.autoRechargeAmountMinor]) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 100_000_000) throw new Error('Wallet control amount is invalid.');
  }
  return withDatabaseRetry(async (sql) => {
    await ensureWalletTables(sql);
    return sql.begin(async (transaction) => {
      await setContext(transaction, undefined, true);
      await ensureWallet(transaction, input.organizationId);
      const rows = await transaction<WalletRow[]>`
        update vocivo_wallets set
          status = ${input.status}, low_balance_minor = ${input.lowBalanceMinor},
          auto_recharge_enabled = ${input.autoRechargeEnabled},
          auto_recharge_threshold_minor = ${input.autoRechargeThresholdMinor},
          auto_recharge_amount_minor = ${input.autoRechargeAmountMinor},
          version = version + 1, updated_at = now()
        where organization_id = ${input.organizationId}
        returning *
      `;
      return walletFromRow(rows[0]);
    });
  });
}

export async function savePricingSettings(input: Omit<PricingSettings, 'updatedAt'>) {
  if (!/^[A-Z]{3}$/.test(input.currency)) throw new Error('Pricing currency is invalid.');
  if (!Number.isInteger(input.grossMarginBps) || input.grossMarginBps < 0 || input.grossMarginBps > 9000) throw new Error('Gross margin must be between 0% and 90%.');
  if (!Number.isInteger(input.fxBufferBps) || input.fxBufferBps < 0 || input.fxBufferBps > 5000) throw new Error('FX buffer must be between 0% and 50%.');
  if (!Number.isInteger(input.paymentFeeBps) || input.paymentFeeBps < 0 || input.paymentFeeBps > 5000) throw new Error('Payment fee must be between 0% and 50%.');
  if (!Number.isSafeInteger(input.minimumTopupMinor) || input.minimumTopupMinor <= 0) throw new Error('Minimum top-up amount is invalid.');
  if (!Number.isSafeInteger(input.lowCarrierBalanceMinor) || input.lowCarrierBalanceMinor < 0) throw new Error('Carrier alert threshold is invalid.');
  return withDatabaseRetry(async (sql) => {
    await ensureWalletTables(sql);
    const rows = await sql<SettingsRow[]>`
      insert into vocivo_pricing_settings (
        settings_id, currency, gross_margin_bps, fx_buffer_bps, payment_fee_bps,
        minimum_topup_minor, low_carrier_balance_minor, updated_at
      ) values (
        'global', ${input.currency}, ${input.grossMarginBps}, ${input.fxBufferBps},
        ${input.paymentFeeBps}, ${input.minimumTopupMinor}, ${input.lowCarrierBalanceMinor}, now()
      ) on conflict (settings_id) do update set
        currency = excluded.currency, gross_margin_bps = excluded.gross_margin_bps,
        fx_buffer_bps = excluded.fx_buffer_bps, payment_fee_bps = excluded.payment_fee_bps,
        minimum_topup_minor = excluded.minimum_topup_minor,
        low_carrier_balance_minor = excluded.low_carrier_balance_minor, updated_at = now()
      returning *
    `;
    return settingsFromRow(rows[0]);
  });
}

export async function saveTopupPackage(input: TopupPackage) {
  if (!input.label.trim() || input.label.length > 80) throw new Error('Top-up package name is invalid.');
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0 || !Number.isSafeInteger(input.creditMinor) || input.creditMinor <= 0) throw new Error('Top-up package amount is invalid.');
  return withDatabaseRetry(async (sql) => {
    await ensureWalletTables(sql);
    const rows = await sql<PackageRow[]>`
      insert into vocivo_topup_packages (package_id, label, amount_minor, credit_minor, active, sort_order, updated_at)
      values (${input.id || randomUUID()}, ${input.label}, ${input.amountMinor}, ${input.creditMinor}, ${input.active}, ${input.sortOrder}, now())
      on conflict (package_id) do update set label = excluded.label, amount_minor = excluded.amount_minor,
        credit_minor = excluded.credit_minor, active = excluded.active, sort_order = excluded.sort_order, updated_at = now()
      returning *
    `;
    return packageFromRow(rows[0]);
  });
}

export async function saveRateRule(input: RateRule) {
  if (!/^[A-Z]{2}$/.test(input.countryCode) || !input.destinationName.trim()) throw new Error('Rate destination is invalid.');
  if (!Number.isSafeInteger(input.wholesaleRateMicros) || input.wholesaleRateMicros < 0 || !Number.isSafeInteger(input.surchargeMicros) || input.surchargeMicros < 0) throw new Error('Rate amount is invalid.');
  if (input.grossMarginBps !== null && (!Number.isInteger(input.grossMarginBps) || input.grossMarginBps < 0 || input.grossMarginBps > 9000)) throw new Error('Rate margin must be between 0% and 90%.');
  return withDatabaseRetry(async (sql) => {
    await ensureWalletTables(sql);
    const rows = await sql<RateRuleRow[]>`
      insert into vocivo_rate_rules (
        rule_id, country_code, destination_name, wholesale_rate_micros,
        gross_margin_bps, surcharge_micros, active, updated_at
      ) values (
        ${input.id || randomUUID()}, ${input.countryCode}, ${input.destinationName},
        ${input.wholesaleRateMicros}, ${input.grossMarginBps}, ${input.surchargeMicros}, ${input.active}, now()
      ) on conflict (country_code) do update set
        destination_name = excluded.destination_name, wholesale_rate_micros = excluded.wholesale_rate_micros,
        gross_margin_bps = excluded.gross_margin_bps, surcharge_micros = excluded.surcharge_micros,
        active = excluded.active, updated_at = now()
      returning *
    `;
    return rateRuleFromRow(rows[0]);
  });
}

export async function deleteTopupPackage(id: string) {
  return withDatabaseRetry(async (sql) => {
    await ensureWalletTables(sql);
    const rows = await sql<Array<{ package_id: string }>>`delete from vocivo_topup_packages where package_id = ${id} returning package_id`;
    return rows.length === 1;
  });
}

export async function deleteRateRule(id: string) {
  return withDatabaseRetry(async (sql) => {
    await ensureWalletTables(sql);
    const rows = await sql<Array<{ rule_id: string }>>`delete from vocivo_rate_rules where rule_id = ${id} returning rule_id`;
    return rows.length === 1;
  });
}
