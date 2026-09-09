import { useState } from 'react';
import { Network, PhoneIncoming, RefreshCw, Save, Trash2 } from 'lucide-react';
import { Empty, Field, Modal, PageHeader } from '../components/ui.jsx';
import { routeLabel, useNumberRouting } from './useNumberRouting.js';
import './number-routing.css';

export function NumbersPage({ config, onRefresh, onOpenTrunks, api }) {
  const { data, error, busy, load, save } = useNumberRouting(api, config.activeOrganizationId);
  const [draft, setDraft] = useState(null), [removing, setRemoving] = useState(null), [removeBusy, setRemoveBusy] = useState(false);
  const [notice, setNotice] = useState(''), [failure, setFailure] = useState('');
  async function refreshParent() {
    try { await onRefresh?.(); }
    catch { setFailure('Saved. Refresh the workspace to update the remaining views.'); }
  }
  async function saveRoute(event) {
    event.preventDefault(); setNotice(''); setFailure('');
    const [destinationType, ...id] = draft.target.split(':');
    const result = await save({ action: 'route', number: draft.number, destinationType, destinationId: id.join(':') });
    if (result) { setDraft(null); setNotice('Inbound destination saved.'); await refreshParent(); }
  }
  async function removeNumber() {
    setRemoveBusy(true); setFailure('');
    try {
      const result = await save({ action: 'remove', number: removing.number });
      if (result) { setRemoving(null); await refreshParent(); }
    } catch (error) { setFailure(error.message); }
    finally { setRemoveBusy(false); }
  }
  return <div className="page number-routing-page">
    <PageHeader eyebrow="ROUTING" title="Phone numbers" subtitle="Direct lines, shared numbers and inbound destinations.">
      {/* A link, not a second trunk editor. Embedding the editor here gave the
          same trunk two revision counters, so a save from one page rejected the
          other's, and it asked a trunks endpoint for its data on behalf of every
          customer entitled to numbers but not to trunks — who got nothing but a
          permanent error banner. */}
      {onOpenTrunks && <button className="secondary" onClick={onOpenTrunks}><Network /> SIP trunks</button>}
      <button className="secondary" disabled={busy || removeBusy} onClick={() => { setDraft(null); setFailure(''); setNotice(''); void load(); }}><RefreshCw /> Refresh</button>
    </PageHeader>
    {(error || failure) && <div className="error-banner" role="alert">{error || failure}</div>}
    {notice && <p role="status">{notice}</p>}
    {!data ? <p role="status">{busy ? 'Loading number routes...' : 'Number routes unavailable.'}</p> : !data.numbers.length ?
      <Empty icon={PhoneIncoming} title="No company numbers" copy="No numbers are published in this workspace." /> :
      <div className="table-shell"><table><thead><tr><th>Number</th><th>Label</th><th>Inbound destination</th><th>Source</th><th /></tr></thead>
        <tbody>{data.numbers.map(item => <tr key={item.number}><td><strong>{item.number}</strong></td><td>{item.label || '-'}</td>
          <td>{routeLabel(item, data.targets)}</td><td>{item.source === 'carrier' ? 'Company carrier' : item.source === 'verified' ? 'Verified caller ID' : 'Managed number'}</td>
          <td><div className="row-actions"><button disabled={busy || removeBusy || !item.available || item.source === 'verified'} onClick={() => {
            setFailure(''); setNotice(''); setDraft({ number: item.number, current: routeLabel(item, data.targets), target: item.destinationType === 'unassigned' ? '' : item.destinationType + ':' + item.destinationId });
          }} aria-label={'Route ' + item.number}>Edit route</button>
            <button className="danger" disabled={busy || removeBusy} title="Remove from company" aria-label={'Remove ' + item.number + ' from company'} onClick={() => { setFailure(''); setRemoving(item); }}><Trash2 /></button>
          </div></td></tr>)}</tbody></table></div>}
    {draft && <Modal title="Inbound destination" subtitle={draft.number} onClose={() => { if (!busy) setDraft(null); }}>
      <form className="modal-form" onSubmit={saveRoute}>
        <p>Current destination: {draft.current}</p>
        <Field label="New destination"><select aria-label="New destination" required disabled={busy} value={draft.target} onChange={event => setDraft({ ...draft, target: event.target.value })}>
          <option value="" disabled>Select destination</option>{data.targets.map(target => <option key={target.type + ':' + target.id} value={target.type + ':' + target.id}>{target.label}</option>)}
        </select></Field>
        {error && <div role="alert" className="error-banner">{error}</div>}
        <footer><button type="button" className="secondary" disabled={busy} onClick={() => setDraft(null)}>Cancel</button><button className="primary" disabled={busy}><Save /> Save route</button></footer>
      </form>
    </Modal>}
    {removing && <Modal title="Remove company number" onClose={() => { if (!removeBusy) setRemoving(null); }}>
      <p>Remove <strong>{removing.number}</strong> from this company's caller IDs and inbound routing?</p>
      <p>The carrier account keeps the number. This does not release a carrier number.</p>
      {(error || failure) && <div role="alert" className="error-banner">{error || failure}</div>}
      <footer><button className="secondary" disabled={removeBusy} onClick={() => setRemoving(null)}>Cancel</button><button className="danger" disabled={removeBusy} onClick={removeNumber}>Remove number</button></footer>
    </Modal>}
  </div>;
}
