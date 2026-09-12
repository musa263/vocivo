import unittest
from collector import registrations, live_calls, sip_user


class CollectorTests(unittest.TestCase):
    def test_registration_expiry_and_empty_domain(self):
        self.assertEqual(registrations({'Domains': []}, 1000), [])
        data = {'Domains': [{'Domain': {'AoRs': [{'Info': {'AoR': 'alice@vocivo', 'Contacts': [
            {'Contact': {'Expires': 30}}, {'Contact': {'Expires': 0}}]}}]}}]}
        rows = registrations(data, 1000)
        self.assertEqual(rows[0]['username'], 'alice')
        self.assertEqual(rows[0]['contacts'], 1)
        self.assertEqual(rows[0]['expiresAt'], '1970-01-01T00:17:10+00:00')

    def test_malformed_sources_do_not_look_like_zero_calls(self):
        for value in (None, {}, {'error': 'failed'}, 'broken'):
            with self.assertRaises(ValueError):
                registrations(value, 1000)
            with self.assertRaises(ValueError):
                live_calls(value, [], 1000)

    def test_answered_queue_retains_winner_not_ringing_losers(self):
        root = {'Unique-ID': 'root', 'variable_vocivo_org': 'company', 'Answer-State': 'answered',
                'variable_vocivo_queue_id': 'support', 'variable_bridge_uuid': 'winner', 'variable_sip_call_id': 'fs-dialog'}
        winner = {'Unique-ID': 'winner', 'Answer-State': 'answered', 'variable_originating_leg_uuid': 'root', 'variable_sip_to_uri': 'bob@vocivo'}
        loser = {'Unique-ID': 'loser', 'Answer-State': 'ringing', 'variable_originating_leg_uuid': 'root', 'variable_sip_to_uri': 'sip:alice@vocivo'}
        dialog = {'callid': 'fs-dialog', 'state': 4, 'from_uri': 'sip:outside@trunk', 'to_uri': 'sip:bob@vocivo'}
        calls = live_calls([dialog], [root, winner, loser], 1000)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]['state'], 'active')
        self.assertEqual(calls[0]['usernames'], ['bob'])
        self.assertEqual(live_calls([], [root, loser], 1000)[0]['state'], 'waiting')

    def test_internal_dialogs_and_freeswitch_uri_variants(self):
        for value in ('sip:alice@vocivo', 'alice@vocivo', '"Alice" <sips:alice@vocivo>'):
            self.assertEqual(sip_user(value), 'alice')
        calls = live_calls([{'callid': 'internal', 'state': 4, 'from_uri': 'sip:alice@vocivo', 'to_uri': 'sip:bob@vocivo'}], [], 1000)
        self.assertEqual(calls[0]['direction'], 'internal')
        self.assertEqual(calls[0]['usernames'], ['alice', 'bob'])


if __name__ == '__main__':
    unittest.main()
