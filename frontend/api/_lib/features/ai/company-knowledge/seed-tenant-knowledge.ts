/**
 * One-time move of a shipped company brief into the tenant that owns it.
 *
 * Vocivo used to answer one company's calls, and that company's facts were
 * compiled into the platform: whenever a tenant's knowledge box was empty and
 * its name matched, the receptionist read them out. On a multi-tenant platform
 * that is wrong twice over — another tenant with a similar name would have been
 * given someone else's facts, and the company that owns the text could not edit
 * a word of it, because it was not in their settings.
 *
 * So the text moves once, into that tenant's own `ai.knowledge`, where their
 * administrator (and the superadmin, through the customer switcher) edits it
 * like any other setting. After the move the platform ships no company facts at
 * all: an empty knowledge box means an empty knowledge box.
 *
 * The seed runs at most once per tenant. `knowledgeSeededAt` records that it
 * happened, so clearing the box afterwards keeps it clear — a deliberate empty
 * box is never refilled. Once every deployment has run it, this file and its
 * call sites can be deleted; nothing else imports the text.
 */
import { legacyPrimaryOrganizationId, pbxForOrganization, savePbxConfig, organizationSettingsFrom, type PbxConfig } from '../../organizations/pbx-config-store.js';

/** Facts published on www.ghsl.us, read on 5 September 2026, seeded once into the tenant that owns them. */
const seeds: { match: RegExp; knowledge: string }[] = [
  {
    match: /global heritage|ghsl/i,
    knowledge: `
Company: Global Heritage Systems LTD, usually called GHSL. Website www.ghsl.us.
An industrial solutions provider based in Jubail Industrial City, Saudi Arabia (Al-Raifi, Jubail), supporting Saudi Arabia's industrial growth in line with Vision 2030. Over 500 projects delivered, 7 business divisions, 20+ years of combined expertise.

Contact: phone +966 53 545 8080, email info@ghsl.us. Office in Jubail, close to Saudi Arabia's industrial corridor. Enquiries can also be sent through the contact form on the website; the team routes each enquiry to the right service team.

Who we serve: oil and gas, petrochemical, refining, power, energy, construction and manufacturing clients, mainly in the Eastern Province and across Saudi Arabia.

What we do — business segments:
- Industrial services: project delivery, maintenance, environmental services, electrical and instrumentation, equipment support, manufacturing and qualified field teams under one operating standard, with a delivery method of scope review, method planning, resource mobilisation, safe execution and quality close-out.
- Projects (EPC and LSTK): integrated engineering, procurement and construction, lump-sum turnkey work, civil industrial construction, piping, equipment installation and rope-access delivery.
- Plant maintenance and turnaround: planned shutdowns, emergency maintenance, turnaround execution, chemical cleaning of heat exchangers, piping and vessels, hydrojetting, steam tracing, steam trap surveys, leak sealing, tank maintenance, and pre-commissioning and commissioning support.
- Bolt torquing and tensioning: controlled bolting for critical flanges and pressure equipment, flange joint integrity, and bolting documentation for shutdowns.
- Electrical and instrumentation: power systems, substations, SCADA, automation, instrumentation, cable health and energy management.
- Environmental services: VOC (volatile organic compound) emission assessment, activated-carbon adsorption and other treatment technologies, turnkey environmental control systems from survey and engineering to installation, commissioning and maintenance, and compliance support. Waste management including collection, disposal and recycling.
- Equipment rental: heavy equipment for construction, maintenance and turnarounds; hydrojetting equipment; temporary site facilities such as modular offices, cabins, blast-resistant cabins and welfare units; summer cooling and air-conditioning rental for field teams; dewatering; and temporary power and energy services.
- Industrial support: qualified manpower, operations support and field teams for petrochemical, manufacturing and infrastructure sites.
- Renewable energy: solar PV power generation projects for industrial and commercial clients, and carbon-credit offset programmes customers can buy to offset residual greenhouse-gas emissions.
- Manufacturing: Thermo-Track is GHSL's valve division, producing valves and steam traps — mechanical inverted-bucket traps, ball-float traps, thermodynamic disc traps and bellows-sealed valves. Digital products live at thermotrack.ghsl.us.

Careers: GHSL hires professionals who care about technical excellence, safety and accountability. Candidates apply on the Careers page of www.ghsl.us with a CV (PDF or Word, up to 3 MB); the team reviews every profile. A caller asking about a job can be pointed to the careers page or have a message taken for the hiring team.

Vision: to be the leading and most trusted industrial services partner, with integrity, professionalism and world-class delivery. Mission: dependable industrial solutions that improve safety, efficiency and sustainability for clients across Saudi Arabia.

If a caller asks for prices, quotations, project timelines or anything not covered here, do not guess: offer to take their details and have the right team call back, or put them through if a person is available.
`.trim(),
  },
];

/**
 * The brief for a company, or an empty string when the platform ships none —
 * which is the normal case, and the only case for every tenant created since.
 *
 * `isLegacyPrimary` is the half of this that cannot be forged. A tenant
 * administrator chooses their own company name, so a name alone would let any
 * tenant call themselves GHSL and be handed another company's phone number,
 * email and service list to read out to callers. Only the tenant that owns the
 * settings predating multi-tenancy — pinned by a platform administrator, not by
 * the tenant — can be the one this text belonged to.
 */
export function seedKnowledgeFor(companyName: string, isLegacyPrimary: boolean) {
  const name = (companyName || '').trim();
  if (!name || !isLegacyPrimary) return '';
  return seeds.find((seed) => seed.match.test(name))?.knowledge || '';
}

/**
 * Seeds a tenant's knowledge box once, and returns the text the receptionist
 * should use now. Never overwrites what an administrator typed, and never runs
 * twice for the same tenant, so an emptied box stays empty.
 *
 * The write is best-effort: another request may be saving the configuration at
 * the same moment, and losing that race only means the seed happens on the next
 * call. The caller still gets the text either way.
 */
export async function seedTenantKnowledge(config: PbxConfig, organizationId: string) {
  const tenant = pbxForOrganization(config, organizationId);
  const existing = tenant.ai.knowledge?.trim();
  if (existing) return existing;
  if (tenant.ai.knowledgeSeededAt) return '';

  let isLegacyPrimary = false;
  try {
    isLegacyPrimary = legacyPrimaryOrganizationId(config) === organizationId;
  } catch {
    // No tenant owns the legacy settings, so no tenant owns a legacy brief.
  }
  const knowledge = seedKnowledgeFor(tenant.company?.name || '', isLegacyPrimary);
  const settings = { ...organizationSettingsFrom(tenant), ai: { ...tenant.ai, knowledge, knowledgeSeededAt: new Date().toISOString() } };
  try {
    await savePbxConfig({
      organizationSettings: { ...config.organizationSettings, [organizationId]: settings },
    }, { expectedUpdatedAt: config.updatedAt });
  } catch {
    // A concurrent save won; the next call seeds it.
  }
  return knowledge;
}
