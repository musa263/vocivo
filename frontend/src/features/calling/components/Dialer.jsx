import { useEffect, useRef, useState } from 'react';
import { CalendarPlus, Delete, Phone, PhoneOff, UsersRound, Video, Voicemail, Wifi, WifiOff } from 'lucide-react';
import { parsePhoneNumberFromString } from 'libphonenumber-js/min';
import { cleanCallInput, resolveCallDestination } from '../engine/callDestination';
import { useCallingDirectory } from '../hooks/useCallingDirectory';
import { PresenceDot } from './PresenceDot';

export const KEYS = [
  ['1', ''], ['2', 'ABC'], ['3', 'DEF'], ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'],
  ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'], ['*', ''], ['0', '+'], ['#', ''],
];

export function Dialer({ rates, selectedNumber, voice, accountType, initialNumber, profile, numberState, onOpenCalls }) {
  const [number, setNumber] = useState(initialNumber || '');
  const [teamOpen, setTeamOpen] = useState(false);
  const [callError, setCallError] = useState('');
  const starting = useRef(false);
  const business = accountType === 'business';
  const directory = useCallingDirectory(business && profile?.organization_id ? JSON.stringify([profile.organization_id, profile.id]) : '');
  useEffect(() => { if (initialNumber) setNumber(cleanCallInput(initialNumber)); }, [initialNumber]);
  const region = numberState?.dialing?.country || profile?.dialing_country || (!business
    ? parsePhoneNumberFromString(selectedNumber?.phone_number || '')?.country || navigator.language.split('-').at(-1)?.toUpperCase() : undefined);
  const country = rates.find(rate => rate.country_code === region);
  const route = resolveCallDestination(number, { business, ownExtension: profile?.extension, directory: directory.users, countryCode: region, dialCode: country?.dial_code });
  const internal = route.kind === 'internal';
  const short = internal || route.kind === 'self' || route.kind === 'unknown-extension';
  const carrierPending = !short && selectedNumber?.source === 'carrier' && selectedNumber.status !== 'ready';
  // The last call's failure belongs to the number that caused it. Editing the
  // destination — which is also how the keypad switches between an extension
  // and an external number — used to carry "Use a complete international
  // destination" onto the extension the person was now dialling.
  const editNumber = (update) => { setNumber(update); setCallError(''); voice.clearError?.(); };
  const zeroHold = useRef({ timer: null, fired: false });
  useEffect(() => () => window.clearTimeout(zeroHold.current.timer), []);
  function endZeroHold() { window.clearTimeout(zeroHold.current.timer); zeroHold.current.timer = null; }
  function pressKey(key) {
    if (key === '0' && zeroHold.current.fired) { zeroHold.current.fired = false; return; }
    editNumber(current => cleanCallInput(current + key));
  }
  async function call() {
    if (starting.current || voice.callStarting || voice.active || carrierPending || !['internal', 'external'].includes(route.kind)) return;
    starting.current = true; setCallError('');
    try {
      if (internal) await voice.startInternalCall('', route.input, route.colleague?.name || 'Extension ' + route.input);
      else if (selectedNumber?.phone_number) await voice.startCall(route.number, selectedNumber.phone_number);
      else setCallError('Contact your administrator to assign an outgoing line.');
    } catch (error) { setCallError(error.message || 'The call could not be started.'); }
    finally { starting.current = false; }
  }
  return (
    <section className="dialer-workspace simple-dialer">
      <header className="workspace-header"><h1>Dial Pad</h1><div className="dialer-header-actions">
        {onOpenCalls && <><button className="icon-button" title="Schedule a call" aria-label="Schedule a call" onClick={() => onOpenCalls('schedule')}><CalendarPlus size={20} /></button><button className="icon-button" title="Video calls" aria-label="Video calls" onClick={() => onOpenCalls('video')}><Video size={20} /></button><button className="icon-button" title="Voicemail" aria-label="Voicemail" onClick={() => onOpenCalls('voicemail')}><Voicemail size={20} /></button></>}
        {business && <button className="icon-button" aria-label="Company colleagues" title="Company colleagues" aria-expanded={teamOpen} onClick={() => setTeamOpen(value => !value)}><UsersRound size={22} /></button>}
        <div className={`status-badge ${voice.ready ? 'online' : ''}`}>{voice.ready ? <Wifi size={15} /> : <WifiOff size={15} />}{voice.ready ? 'Ready for calls' : voice.statusLabel}</div>
      </div></header>
      {teamOpen && <div className="dialer-team" aria-label="Company colleagues">{directory.users.filter(user => user.id !== profile?.id).map(user => <button key={user.id} onClick={() => { editNumber(user.extension); setTeamOpen(false); }}><PresenceDot presence={user.presence} /><span><strong>{user.name}</strong><small>Extension {user.extension}</small></span><Phone size={18} /></button>)}{directory.status === 'loading' && <p role="status">Loading colleagues...</p>}{directory.status === 'failed' && <button onClick={directory.retry}>Retry company directory</button>}</div>}
      <div className="dialer-layout"><div className="dialer-panel">
        <div className="dialer-identity" aria-live="polite">{internal ? <><PresenceDot presence={route.colleague?.presence} />{route.colleague?.name}</> : route.kind === 'self' ? 'This is your extension' : route.kind === 'unknown-extension' ? (directory.status === 'loading' ? 'Finding colleague...' : 'No matching company extension') : null}</div>
        <div className="destination-field">
          <input value={number} onChange={event => editNumber(cleanCallInput(event.target.value))} placeholder={business ? 'Number or extension' : 'Phone number'} inputMode="tel" aria-label="Number to call" />
          <button className="erase-button" onClick={() => editNumber(value => value.slice(0, -1))} disabled={!number} title="Delete digit"><Delete size={22} /></button>
        </div>
        <div className="keypad" aria-label="Phone keypad">{KEYS.map(([key, letters]) => <button key={key} onClick={() => pressKey(key)} onPointerDown={key === '0' ? () => { endZeroHold(); zeroHold.current.fired = false; zeroHold.current.timer = window.setTimeout(() => { zeroHold.current.fired = true; setNumber(current => cleanCallInput('+' + current)); }, 550); } : undefined} onPointerUp={key === '0' ? endZeroHold : undefined} onPointerLeave={key === '0' ? endZeroHold : undefined} onPointerCancel={key === '0' ? endZeroHold : undefined}><strong>{key}</strong><small>{letters}</small></button>)}</div>
        {(callError || voice.error) ? <div className="inline-error" role="alert">{callError || voice.error}</div> : voice.notice && <div className="call-notice" role="status"><PhoneOff size={18} /><span>{voice.notice}</span></div>}
        {carrierPending && <p className="call-notice" role="status">Your outgoing line is pending activation. Contact your administrator.</p>}
        {number && !short && !selectedNumber && <p className="call-notice" role="status">Contact your administrator to assign an outgoing line.</p>}
        {number && !short && !region && !/^(\+|00)/.test(number) && <p className="call-notice" role="status">Enter the full number, including + and country code.</p>}
        <button className="call-button" aria-label={internal ? 'Call extension' : 'Call now'} title={internal ? 'Call extension' : 'Call now'} onClick={call} disabled={voice.active || voice.callStarting || !['internal', 'external'].includes(route.kind) || carrierPending || (!internal && !selectedNumber?.phone_number) || !voice.ready}><Phone size={28} /></button>
      </div></div>
    </section>
  );
}
