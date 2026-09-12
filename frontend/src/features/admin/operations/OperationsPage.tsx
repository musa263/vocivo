import { useState } from 'react';
import { Activity, RefreshCw } from 'lucide-react';
import { PageHeader } from '../components/ui.jsx';
import { useOperations } from './useOperations';
import './operations.css';
const label = (value: string) => ({ on_call: 'On Call', on_break: 'On Break', available: 'Available', offline: 'Offline', unknown: 'Unknown', active: 'Active', inactive: 'Inactive' }[value] || value);
export function OperationsPage({ api, canManage }: { api: any; canManage: boolean }) {
  const { data, error, loading, refresh } = useOperations(api, '/api/admin/operations', 10_000);
  const [tab, setTab] = useState('agents'); const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(''); const [saveError, setSaveError] = useState('');
  async function change(agent: any, state: string) {
    setSaving(agent.id); setSaveError('');
    try { await api('/api/admin/operations', { method: 'PATCH', body: { extensionId: agent.id, state, version: agent.preference.version } }); refresh(); }
    catch (err) { setSaveError(err instanceof Error ? err.message : 'Status could not be saved'); }
    finally { setSaving(''); }
  }
  const agents = (data?.agents || []).filter((a: any) => `${a.name} ${a.extension}`.toLowerCase().includes(search.toLowerCase()));
  return <div className="page operations-page">
    <PageHeader eyebrow="PHONE OPERATIONS" title="Live operations" subtitle={data?.observedAt ? `Last observed ${new Date(data.observedAt).toLocaleTimeString()}` : 'Awaiting SIP edge telemetry'}>
      <button className="secondary" onClick={refresh} disabled={loading} title="Refresh operations"><RefreshCw /> Refresh</button>
    </PageHeader>
    {(error || saveError) && <p role="alert" className="ops-notice">{error || saveError}</p>}
    {data && !data.fresh && <p role="status" className="ops-notice">{data.source === 'unsupported-edge' ? 'Live monitoring requires the Vocivo SIP edge.' : 'Live telemetry is unavailable or stale. Call and registration counts are unknown.'}</p>}
    <div className="ops-metrics">{[['Active registrations', 'activeRegistrations'], ['Inactive registrations', 'inactiveRegistrations'], ['Inbound calls', 'inbound'], ['Outbound calls', 'outbound'], ['Internal calls', 'internal']].map(([name, key]) => <div key={key}><span>{name}</span><strong>{data?.counters?.[key] ?? '\u2014'}</strong></div>)}</div>
    <div className="ops-toolbar"><div className="ops-tabs" role="tablist" aria-label="Operations views">{[['agents', 'Agents & registrations'], ['queues', 'Queues'], ['calls', 'Live calls']].map(([id, name]) => <button role="tab" aria-selected={tab === id} key={id} onClick={() => setTab(id)}>{name}</button>)}</div>
      {tab === 'agents' && <input type="search" aria-label="Search agents" placeholder="Search colleague or extension" value={search} onChange={e => setSearch(e.target.value)} />}</div>
    {tab === 'agents' && <div className="ops-table"><table><thead><tr><th>Colleague</th><th>Extension</th><th>Agent status</th><th>SIP registration</th><th>Contacts</th><th>Queue availability</th></tr></thead><tbody>{agents.map((a: any) => <tr key={a.id}><td>{a.name}{!a.enabled && <small>Account disabled</small>}</td><td>{a.extension}</td><td><span className={`ops-state ${a.state}`}><i />{label(a.state)}</span></td><td><span className={`ops-state ${a.registration}`}><i />{label(a.registration)}</span></td><td>{a.contacts ?? '\u2014'}</td><td><select aria-label={`Queue availability for ${a.name}`} value={a.preference.state} disabled={!canManage || !a.enabled || Boolean(saving)} onChange={e => void change(a, e.target.value)}><option value="available">Available</option><option value="on_break">On Break</option></select></td></tr>)}</tbody></table>{!agents.length && <p className="ops-empty">{loading ? 'Loading agents...' : 'No matching agents'}</p>}</div>}
    {tab === 'queues' && <div className="ops-table"><table><thead><tr><th>Queue</th><th>Extension</th><th>Waiting</th><th>Connected</th><th>Available agents</th><th>On Break</th></tr></thead><tbody>{(data?.queues || []).map((q: any) => <tr key={q.id}><td>{q.name}</td><td>{q.extension}</td><td>{q.waiting ?? '\u2014'}</td><td>{q.onCall ?? '\u2014'}</td><td>{q.available ?? '\u2014'}</td><td>{q.onBreak}</td></tr>)}</tbody></table>{!data?.queues?.length && <p className="ops-empty">No queues configured</p>}</div>}
    {tab === 'calls' && <div className="ops-table"><table><thead><tr><th>Direction</th><th>State</th><th>Colleagues</th><th>Queue</th><th>Started</th></tr></thead><tbody>{(data?.calls || []).map((c: any) => <tr key={c.id}><td>{c.direction}</td><td>{c.state}</td><td>{c.extensionIds.map((id: string) => data.agents.find((a: any) => a.id === id)?.name).filter(Boolean).join(', ') || '\u2014'}</td><td>{data.queues.find((q: any) => q.id === c.queueId)?.name || '\u2014'}</td><td>{new Date(c.startedAt).toLocaleTimeString()}</td></tr>)}</tbody></table>{!data?.calls?.length && <p className="ops-empty"><Activity /> {data?.fresh ? 'No active calls' : 'Live calls unavailable'}</p>}</div>}
  </div>;
}
