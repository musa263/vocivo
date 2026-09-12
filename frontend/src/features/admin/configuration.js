import { Activity, BarChart3, BellRing, Bot, Building2, CalendarClock, FileClock, GitBranch, KeyRound, LockKeyhole, Network, PhoneCall, PhoneIncoming, Route, Settings2, ShieldCheck, Users, WalletCards } from "lucide-react";
import { buildDialingDirectory } from "../numbers/countries";

export const emptyUser = { extension: '', name: '', email: '', mobile: '', department: 'General', role: 'user', loginPassword: '' };

export const defaultProfile = { outboundCallerId: '', did: '', twoFactorEnabled: false, noAnswerSeconds: 25, forwardBusy: '', forwardNoAnswer: '', forwardUnavailable: '', simultaneousRing: '', voicemailEnabled: true, voicemailEmail: true, voicemailTranscription: false, schedule: 'Use office hours', permissions: { international: true, transfer: true, video: true, recording: false, reports: false } };

export const emptyTrunk = { name: '', proxy: '', username: '', password: '', transport: 'TLS', destinationUri: '', active: true, policy: { inboundEnabled: true, outboundEnabled: true, inboundDids: [], defaultDestination: '', outboundPrefix: '', priority: 1, failoverTrunkId: '', channelLimit: 10, codecs: ['PCMU', 'PCMA'], mediaEncryption: true, notes: '' } };

export const countryOptions = buildDialingDirectory();

export const platformNav = [
  { group: 'VOCIVO PLATFORM', items: [['platform-dashboard', Activity, 'Overview'], ['organizations', Building2, 'Customers'], ['subscriptions', BellRing, 'Subscriptions'], ['wallets', WalletCards, 'Wallets & pricing'], ['feature-access', LockKeyhole, 'Feature access']] },
  { group: 'CUSTOMER WORKSPACE', items: [['dashboard', PhoneCall, 'Phone system'], ['users', Users, 'Users'], ['numbers', PhoneIncoming, 'Phone numbers'], ['voice', Bot, 'Voice & AI'], ['outbound', Route, 'Outbound rules'], ['hours', CalendarClock, 'Office hours'], ['handling', GitBranch, 'Call handling'], ['operations', Activity, 'Live operations'], ['reports', BarChart3, 'Reports'], ['events', FileClock, 'Event log']] },
  { group: 'PLATFORM SYSTEM', items: [['trunks', Network, 'Carrier & SIP'], ['developer', KeyRound, 'Developer API'], ['system', Settings2, 'Settings'], ['security', ShieldCheck, 'Password & security']] },
];

export const customerNav = [
  { group: 'COMPANY', items: [['dashboard', Activity, 'Overview'], ['users', Users, 'Users'], ['numbers', PhoneIncoming, 'Phone numbers'], ['voice', Bot, 'Voice & AI']] },
  { group: 'ROUTING', items: [['outbound', Route, 'Outbound rules'], ['hours', CalendarClock, 'Office hours'], ['handling', GitBranch, 'Call handling']] },
  { group: 'INSIGHTS', items: [['operations', Activity, 'Live operations'], ['reports', BarChart3, 'Reports'], ['events', FileClock, 'Event log']] },
  { group: 'CONNECTIVITY', items: [['trunks', Network, 'SIP trunks'], ['developer', KeyRound, 'Developer API'], ['system', Settings2, 'Company settings'], ['security', ShieldCheck, 'Password & security']] },
];

export const sectionFeatures = { operations: 'analytics', numbers: 'phoneNumbers', voice: 'aiReceptionist', outbound: 'outboundCalling', handling: 'queues', reports: 'analytics', events: 'analytics', trunks: 'sipTrunks', developer: 'developerApi' };

export const uid = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
