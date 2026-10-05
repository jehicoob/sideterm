"""0.1.1 metadata regressions: real PTY + /proc, no real AI accounts needed."""
import importlib.util
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch, mock_open
from types import SimpleNamespace
from test_pty import Client, SCRIPT

spec = importlib.util.spec_from_file_location('sideterm_pty_for_test', SCRIPT)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


class LabelPolicy(unittest.TestCase):
    def test_known_entrypoints(self):
        for entry, label in [('/bin/opencode', 'OpenCode'), ('/bin/claude', 'Claude'),
                             ('/opt/node_modules/@anthropic-ai/claude-code/cli.js', 'Claude'),
                             ('/opt/bin/codex.js', 'Codex'), ('opencode-linux-arm64', 'OpenCode')]:
            self.assertEqual(module.known_program(entry), label)
        self.assertIsNone(module.known_program('/home/Claude/readme.md'))
        self.assertIsNone(module.known_program('my-opencode-project'))

    def test_sanitize_controls_and_bidi(self):
        self.assertEqual(module.clean_label('\x1bOpen\u202ecode\n'), 'Opencode')
        self.assertEqual(module.clean_label('A'*300), 'A'*96)
        self.assertEqual(module.clean_label('café 漢字'), 'café 漢字')


    def test_wrapper_traversal_with_proc_fixture(self):
        root = {'pid': 101, 'pgrp': 101, 'sid': 100, 'start': '10', 'comm': 'node'}
        child = {'pid': 102, 'pgrp': 101, 'sid': 100, 'start': '11', 'comm': 'opencode'}
        session = SimpleNamespace(pid=100, fd=8, cwd='/old')
        with patch.object(module.os, 'tcgetpgrp', return_value=101), \
             patch.object(module, 'read_process', side_effect=lambda p: {101:root,102:child}.get(p)), \
             patch.object(module, 'process_label', side_effect=lambda p: 'node' if p['pid']==101 else 'OpenCode'), \
             patch('builtins.open', mock_open(read_data='102')), \
             patch.object(module.os, 'readlink', return_value='/actual'):
            snapshot = module.inspect_terminal(session)
        self.assertEqual(snapshot['process'], 'OpenCode')
        self.assertEqual(snapshot['cwd'], '/actual')
        self.assertTrue(snapshot['foreground'])

    def test_cannot_follow_process_in_another_linux_session(self):
        root = {'pid':101,'pgrp':101,'sid':100,'start':'10','comm':'node'}
        other = {'pid':102,'pgrp':101,'sid':500,'start':'11','comm':'claude'}
        session = SimpleNamespace(pid=100, fd=8, cwd='/old')
        with patch.object(module.os,'tcgetpgrp',return_value=101), \
             patch.object(module,'read_process',side_effect=lambda p: {101:root,102:other}.get(p)), \
             patch.object(module,'process_label',return_value='node'), \
             patch('builtins.open',mock_open(read_data='102')), \
             patch.object(module.os,'readlink',return_value='/actual'):
            snapshot = module.inspect_terminal(session)
        self.assertEqual(snapshot['process'],'node')


@unittest.skipUnless(sys.platform.startswith('linux'), 'WSL/Linux only')
class MetadataIntegration(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sideterm-metadata-')
        self.root = Path(self.temp.name)
        self.client = Client()

    def tearDown(self):
        self.client.cleanup()
        self.temp.cleanup()

    def latest(self, sid='s1'):
        return next((e for e in reversed(self.client.events) if e.get('type') == 'metadata' and e.get('id') == sid), {})

    def meta(self, predicate, sid='s1'):
        self.client.until(lambda: predicate(self.latest(sid)), timeout=5)
        return self.latest(sid)

    def fake(self, name):
        # Real executable with a controlled name; it is NOT the actual AI CLI.
        binary = self.root/name
        binary.symlink_to(shutil.which('sleep'))
        return shlex.quote(str(binary))

    def test_cd_tracks_actual_process_cwd_spaces_unicode_and_cd_back(self):
        c = self.client
        target = self.root/'otro proyecto café'
        target.mkdir()
        c.spawn(cwd=str(self.root))
        self.meta(lambda m: m.get('cwd') == str(self.root))
        c.input('cd '+shlex.quote(str(target))+'\n')
        self.meta(lambda m: m.get('cwd') == str(target))
        c.input('cd -\n')
        self.meta(lambda m: m.get('cwd') == str(self.root))
        self.assertEqual(self.latest()['process'], 'bash')

    def test_foreground_agent_labels_and_return_to_shell(self):
        c = self.client; c.spawn(cwd=str(self.root))
        for program, label in [('opencode', 'OpenCode'), ('claude', 'Claude'), ('codex', 'Codex')]:
            c.input(self.fake(program)+' 30\n')
            self.meta(lambda m: m.get('process') == label)
            self.assertTrue(self.latest()['foreground'])
            c.input('\x03')
            self.meta(lambda m: m.get('process') == 'bash' and m.get('foreground') is False)

    def test_background_job_does_not_hijack_tab(self):
        c = self.client; c.spawn(cwd=str(self.root))
        self.meta(lambda m: m.get('process') == 'bash')
        c.input(self.fake('claude')+' 30 &\n')
        until = time.monotonic() + 1.5
        while time.monotonic() < until: c.poll(.03)
        self.assertEqual(self.latest()['process'], 'bash')
        c.input('fg\n')
        self.meta(lambda m: m.get('process') == 'Claude')
        c.input('\x1a')  # Ctrl+Z: job is suspended, shell owns the PTY again.
        self.meta(lambda m: m.get('process') == 'bash')

    def test_foreground_cwd_is_not_frozen_to_shell_parent(self):
        c = self.client; c.spawn(cwd=str(self.root))
        target = self.root/'agent-cwd'; target.mkdir()
        c.input('(cd '+shlex.quote(str(target))+'; '+self.fake('opencode')+' 30)\n')
        self.meta(lambda m: m.get('process') == 'OpenCode' and m.get('cwd') == str(target))
        c.input('\x03')
        self.meta(lambda m: m.get('process') == 'bash' and m.get('cwd') == str(self.root))

    def test_hidden_view_suspends_metadata_without_stopping_pty(self):
        c = self.client; c.spawn(cwd=str(self.root))
        self.meta(lambda m: m.get('cwd') == str(self.root))
        c.send({'type':'visibility', 'visible':False})
        for _ in range(5): c.poll(.02)
        old = len([e for e in c.events if e.get('type') == 'metadata'])
        c.input('cd /; printf "HIDDEN_STILL_RUNNING\\n"\n'); c.output('HIDDEN_STILL_RUNNING')
        until = time.monotonic()+1.3
        while time.monotonic() < until: c.poll(.03)
        self.assertEqual(len([e for e in c.events if e.get('type') == 'metadata']), old)
        c.send({'type':'visibility','visible':True})
        self.meta(lambda m: m.get('cwd') == '/')

    def test_unchanged_metadata_is_not_retransmitted(self):
        c = self.client; c.spawn(cwd=str(self.root))
        self.meta(lambda m: m.get('process') == 'bash')
        old = len([e for e in c.events if e.get('type') == 'metadata'])
        until = time.monotonic()+2.2
        while time.monotonic() < until: c.poll(.03)
        self.assertEqual(len([e for e in c.events if e.get('type') == 'metadata']), old)

    @unittest.skipUnless(shutil.which('node'), 'Node needed only for this development test')
    def test_node_entrypoint_and_arguments_not_misidentified_or_exposed(self):
        c = self.client; c.spawn(cwd=str(self.root))
        namespace = self.root/'node_modules'/'@anthropic-ai'/'claude-code'; namespace.mkdir(parents=True)
        real_entry = namespace/'cli.js'; real_entry.write_text('setTimeout(() => {}, 30000);')
        generic = self.root/'app.js'; generic.write_text('setTimeout(() => {}, 30000);')
        node = shlex.quote(shutil.which('node'))
        c.input(node+' '+shlex.quote(str(real_entry))+' --api-key SECRET_TEST_ONLY\n')
        self.meta(lambda m: m.get('process') == 'Claude')
        self.assertNotIn('SECRET_TEST_ONLY', json.dumps([e for e in c.events if e.get('type') == 'metadata']))
        c.input('\x03'); self.meta(lambda m: m.get('process') == 'bash')
        c.input(node+' '+shlex.quote(str(generic))+' claude opencode\n')
        self.meta(lambda m: m.get('process') == 'node')
        self.assertNotIn('args', self.latest())
        self.assertNotIn('cmdline', self.latest())

    @unittest.skipUnless(shutil.which('node') and Path('/proc/self/task/%s/children' % os.getpid()).exists(), 'Kernel does not expose /proc/.../children for real wrapper traversal; mocked branch tested separately')
    def test_wrapper_child_identifies_agent_without_hijacking_cwd(self):
        c = self.client; c.spawn(cwd=str(self.root))
        agent = self.fake('opencode')
        wrapper = self.root/'wrapper.js'
        # Node remains group leader; a directly attached child runs the agent.
        wrapper.write_text("require('node:child_process').spawn("+json.dumps(str(self.root/'opencode'))+", ['30'], {stdio:'inherit'}); setTimeout(()=>{},30000);")
        c.input(shlex.quote(shutil.which('node'))+' '+shlex.quote(str(wrapper))+'\n')
        self.meta(lambda m: m.get('process') == 'OpenCode')

    def test_two_sessions_keep_independent_dynamic_directories(self):
        c = self.client; c.spawn('s1',cwd=str(self.root)); c.spawn('s2',cwd='/tmp')
        self.meta(lambda m: m.get('cwd') == str(self.root),'s1')
        self.meta(lambda m: m.get('cwd') == '/tmp','s2')
        c.input('cd /\n', 's1')
        self.meta(lambda m: m.get('cwd') == '/', 's1')
        self.assertEqual(self.latest('s2')['cwd'], '/tmp')

if __name__ == '__main__': unittest.main()
