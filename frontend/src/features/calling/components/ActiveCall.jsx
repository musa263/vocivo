import { useState } from "react";
import { ArrowLeftRight, Mic, MicOff, Pause, Grid3X3, Merge, Phone, PhoneForwarded, PhoneOff, UserMinus, UserPlus, Volume2, X } from "lucide-react";
import { api } from "../../../shared/api";
import { KEYS } from './Dialer.jsx';
import { formatPhone, formatDuration } from '../formatting.js';

export function ActiveCall({ voice, number, elapsed, selectedNumber, profile }) {
  const remote = voice.remoteIdentity?.number || number;
  const name = voice.remoteIdentity?.name || 'Phone call';
  const [tool, setTool] = useState('');
  const [mode, setMode] = useState('external');
  const [target, setTarget] = useState('');
  const [team, setTeam] = useState([]);
  const [busy, setBusy] = useState(false);
  const [toolError, setToolError] = useState('');
  const status = voice.connected ? (voice.state === 'held' ? 'ON HOLD' : voice.conference ? 'CONFERENCE' : 'LIVE CALL') : 'CALLING';
  // This screen is only mounted for an active call, and both edges define that
  // as a call that is not an unanswered incoming one. Asking for voice.incoming
  // as well meant the flag was always false here and Transfer never enabled.
  const canTransfer = voice.canTransfer !== false && Boolean(profile?.extension) && !voice.conference;
  const openTool = async (next) => {
    setTool(next); setToolError(''); setTarget('');
    if (next === 'transfer') {
      try { const result = await api('/api/voice/directory'); setTeam((result.users || []).filter((user) => user.id !== profile?.id)); }
      catch (directoryError) { setToolError(directoryError.message || 'The company directory is unavailable.'); }
    }
  };
  const addCaller = async () => {
    if (!target || busy) return;
    setBusy(true); setToolError('');
    try {
      if (mode === 'extension') {
        const result = await api(`/api/voice/directory?extension=${encodeURIComponent(target)}`);
        const colleague = result.users?.[0];
        if (!colleague?.sipUsername) throw new Error('That extension is not available.');
        await voice.startSecondInternalCall(colleague.sipUsername, colleague.extension, colleague.name);
      } else {
        if (!selectedNumber?.phone_number) throw new Error('Choose a caller ID before adding an external caller.');
        await voice.startSecondCall(target.startsWith('+') ? target : `+${target}`, selectedNumber.phone_number);
      }
      setTool(''); setTarget('');
    } catch (addError) { setToolError(addError.message || 'The second call could not be started.'); }
    finally { setBusy(false); }
  };
  const transfer = async (member) => {
    setBusy(true); setToolError('');
    try { await voice.transferCall(member.id); setTool(''); }
    catch (transferError) { setToolError(transferError.message || 'The call could not be transferred.'); }
    finally { setBusy(false); }
  };
  const action = async (operation) => {
    setBusy(true); setToolError('');
    try { await operation(); }
    catch (actionError) { setToolError(actionError.message || 'The call action could not be completed.'); }
    finally { setBusy(false); }
  };
  return (
    <div className="call-overlay" role="dialog" aria-modal="true">
      <div className="call-modal active-modal web-call-modal">
        <div className="live-pill"><span /> {status}</div>
        {voice.remoteIdentity?.photoUrl ? <img className="call-avatar call-avatar-photo" src={voice.remoteIdentity.photoUrl} alt="" /> : <div className="call-avatar">{name.charAt(0).toUpperCase()}</div>}<h2>{name}</h2><p className="call-number">{voice.remoteIdentity?.internal ? remote : formatPhone(remote)}</p>{voice.connected ? <strong className="call-timer">{formatDuration(elapsed)}</strong> : null}
        <div className="call-controls">
          <button className={voice.muted ? 'control active' : 'control'} onClick={voice.toggleMute} title={voice.muted ? 'Unmute' : 'Mute'}>{voice.muted ? <MicOff /> : <Mic />}<span>{voice.muted ? 'Unmute' : 'Mute'}</span></button>
          <button className={voice.state === 'held' ? 'control active' : 'control'} disabled={!voice.connected || busy || voice.canHold === false} onClick={() => action(voice.toggleHold)} title="Hold call"><Pause /><span>Hold</span></button>
          <button className="control" onClick={() => openTool('keypad')} title="Open keypad"><Grid3X3 /><span>Keypad</span></button>
          <button className="control" disabled={!voice.connected || voice.heldCall || voice.conference || voice.canAddCaller === false} onClick={() => openTool('add')} title="Add caller"><UserPlus /><span>Add caller</span></button>
          <button className="control" disabled={!voice.heldCall || voice.conference || busy} onClick={() => action(voice.swapCalls)} title="Swap calls"><ArrowLeftRight /><span>Swap</span></button>
          <button className={voice.conference ? 'control active' : 'control'} disabled={!voice.canMerge || busy} onClick={() => action(voice.mergeCalls)} title="Merge calls"><Merge /><span>Merge</span></button>
          <button className="control" disabled={!voice.connected || !canTransfer} onClick={() => openTool('transfer')} title="Transfer call"><PhoneForwarded /><span>Transfer</span></button>
          <button className={voice.conference ? 'control active' : 'control'} disabled={!voice.conference} onClick={() => openTool('participants')} title="Conference participants"><UserMinus /><span>Participants</span></button>
          <button className={voice.audioBlocked ? 'control attention' : 'control'} disabled={!voice.connected || busy} onClick={() => action(voice.resumeAudio)} title={voice.audioBlocked ? 'Resume browser audio' : 'Refresh browser audio'}><Volume2 /><span>{voice.audioBlocked ? 'Resume audio' : 'Audio'}</span></button>
        </div>
        {voice.heldCall && !voice.conference && <div className="held-call-strip"><span>{voice.heldCall.identity?.name || voice.heldCall.identity?.number} on hold</span><button onClick={() => action(voice.swapCalls)}>Swap</button></div>}
        {tool && <div className="web-call-tool">
          <div className="web-call-tool-head"><strong>{tool === 'add' ? 'Add caller' : tool === 'transfer' ? 'Transfer call' : tool === 'participants' ? 'Conference participants' : 'Keypad'}</strong><button onClick={() => { setTool(''); setToolError(''); }} title="Close"><X /></button></div>
          {tool === 'add' && <><div className="web-call-segments"><button className={mode === 'external' ? 'active' : ''} onClick={() => { setMode('external'); setTarget(''); }}>External</button><button className={mode === 'extension' ? 'active' : ''} onClick={() => { setMode('extension'); setTarget(''); }}>Extension</button></div><div className="web-call-input"><span>{mode === 'extension' ? 'EXT' : '+'}</span><input inputMode="tel" value={target} onChange={(event) => setTarget(event.target.value.replace(/\D/g, '').slice(0, mode === 'extension' ? 5 : 18))} placeholder={mode === 'extension' ? 'Company extension' : 'International number'} /><button disabled={!target || busy} onClick={addCaller}><Phone />{busy ? 'Calling' : 'Call'}</button></div></>}
          {tool === 'transfer' && <div className="web-team-list">{team.map((member) => <button key={member.id} disabled={busy} onClick={() => transfer(member)}><span><strong>{member.name}</strong><small>Extension {member.extension} · {member.department}</small></span><PhoneForwarded /></button>)}</div>}
          {tool === 'participants' && <div className="web-team-list">{voice.conference?.participants.map((participant, index) => <div key={participant.id}><span><strong>{participant.name || participant.number}</strong><small>{index === 0 ? 'Primary caller' : participant.number}</small></span>{index === 0 ? <em>PRIMARY</em> : <button disabled={busy} onClick={() => action(() => voice.removeConferenceParticipant(participant.id))}><UserMinus /></button>}</div>)}</div>}
          {tool === 'keypad' && <div className="web-dtmf">{KEYS.map(([digit, letters]) => <button key={digit} onClick={() => voice.sendDtmf(digit)}><strong>{digit}</strong><small>{letters}</small></button>)}</div>}
          {toolError && <div className="web-call-error">{toolError}</div>}
        </div>}
        <button className="hangup-button" onClick={voice.hangup}><PhoneOff size={24} /> End call</button>
      </div>
    </div>
  );
}
