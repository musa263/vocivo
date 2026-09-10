import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import xml.etree.ElementTree as ET

RENDER = Path(__file__).resolve().parents[1]/'freeswitch/render-env.sh'

class RenderTests(unittest.TestCase):
    def test_xml_and_sed_metacharacters_remain_literal(self):
        for value in ['alpha&beta#gamma/path', 'quote" and \' apostrophe', 'back\\slash', '$(touch /tmp/never-run)']:
            result = subprocess.run(['/bin/sh', '-c', '. "$1"; replacement=$(render_value "$TEST_VALUE") || exit; printf \'<param value="$${SECRET}"/>\' | sed "s#\\$\\${SECRET}#$replacement#g"', 'fixture', str(RENDER)], env={**os.environ, 'TEST_VALUE':value}, capture_output=True, text=True, check=True)
            self.assertEqual(ET.fromstring(result.stdout).attrib['value'], value)

if __name__ == '__main__': unittest.main()

class InvalidValues(unittest.TestCase):
    def test_control_characters_are_rejected_before_rendering(self):
        for value in ['newline\nvalue', 'return\rvalue', 'tab\tvalue']:
            result = subprocess.run(['/bin/sh', '-c', '. "$1"; render_value "$TEST_VALUE"', 'fixture', str(RENDER)], env={**os.environ, 'TEST_VALUE':value}, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
