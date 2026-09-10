import { BellRing, CircleDot, FileClock, Network, PhoneIncoming, Users } from "lucide-react";
import { Status, PageHeader, Empty } from '../components/ui.jsx';
import { findActiveWorkspace } from '../activeWorkspace.js';

export function Dashboard({ overview, extensions, config, events, setSection, customer, voices }) {
  const metrics = overview?.metrics || {};
  const { organization } = findActiveWorkspace(config.organizations, config.activeOrganizationId);
  const missingPushPlatforms = [
    !overview?.connection?.iosPushConfigured && 'iOS PushKit',
    !overview?.connection?.androidPushConfigured && 'Android FCM',
  ].filter(Boolean);
  const platformReadiness = overview?.connection ? [
    ['Calling service', overview.connection.active, overview.connection.active === null ? overview.connection.registrationStatus : overview.connection.name],
    ['Mobile incoming push', overview.connection.pushConfigured, overview.connection.pushConfigured ? 'iOS and Android configured' : `${missingPushPlatforms.join(' and ') || 'Mobile push'} not configured`],
  ] : [];
  const readiness = [
    ...platformReadiness,
    // On Vocivo's own edge the receptionist needs the voice engine, not a carrier assistant id.
    ['AI receptionist', config.ai.enabled && (voices?.engine === 'vocivo' ? Boolean(voices?.provider?.healthy) : Boolean(config.ai.assistantId)), !config.ai.enabled ? 'Disabled' : voices?.engine === 'vocivo' ? (voices?.provider?.healthy ? 'Active on the Vocivo edge' : 'Voice engine unavailable') : (config.ai.assistantId ? 'Active' : 'Needs synchronization')],
    organization
      ? [`Extension range ${organization.extensionStart}-${organization.extensionEnd}`, organization.internalCallingEnabled, `${extensions.length} of ${organization.extensionEnd - organization.extensionStart + 1} slots assigned`]
      // Reading the range off whichever organization happens to be first would
      // report another customer's allocation as this one's.
      : ['Extension range', false, 'The open workspace is no longer in the customer list'],
  ];
  return <div className="page"><PageHeader eyebrow="SYSTEM OVERVIEW" title="Dashboard" subtitle="Live voice infrastructure, users and routing at a glance."><button className="secondary" onClick={() => setSection('events')}><FileClock /> Event log</button></PageHeader>
    <div className="metrics"><div><Users /><span>Active users</span><strong>{metrics.activeExtensions ?? extensions.length}</strong><small>{extensions.length} extensions</small></div><div><PhoneIncoming /><span>Company numbers</span><strong>{metrics.phoneNumbers ?? 0}</strong><small>Inbound lines</small></div><div><Network /><span>Concurrent calls</span><strong>{customer?.plan?.limits?.concurrentCalls || 0}</strong><small>Plan capacity</small></div><div><BellRing /><span>Vocivo plan</span><strong>{customer?.plan?.name || 'Unavailable'}</strong><small>{customer?.subscription?.status || 'Subscription unavailable'}</small></div></div>
    <section className="band"><div className="section-title"><div><h2>System readiness</h2><p>Items that directly affect inbound and internal calls.</p></div></div><div className="readiness">{readiness.map(([label, good, detail]) => <div key={label}><span>{label}</span><strong>{detail}</strong><Status good={good} warn={!good}>{good ? 'Ready' : 'Attention'}</Status></div>)}</div></section>
    <section className="band"><div className="section-title"><div><h2>Recent activity</h2><p>Latest Vocivo call activity from the last 24 hours.</p></div><button className="text-button" onClick={() => setSection('events')}>View all</button></div>{events.length ? <div className="event-list">{events.slice(0, 8).map((e, i) => <div key={e.call_leg_id || i}><CircleDot /><strong>{e.name || 'Call event'}</strong><span>{e.call_session_id || 'Voice platform'}</span><time>{e.event_timestamp ? new Date(e.event_timestamp).toLocaleString() : ''}</time></div>)}</div> : <Empty icon={FileClock} title="No recent call events" copy="New call activity will appear here." />}</section>
  </div>;
}
