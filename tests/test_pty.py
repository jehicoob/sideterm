"""Integration tests: real PTYs, shells and subprocesses. No third-party modules."""
import base64
import json
import os
from pathlib import Path
import queue
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'python' / 'pty_host.py'
WINDOW = 131072


def alive(pid):
    try:
        text = Path('/proc/%d/stat' % pid).read_text()
        return text[text.rfind(')') + 2:].split()[0] != 'Z'
    except FileNotFoundError:
        return False


class Client:
    def __init__(self, python_executable=None):
        self.proc = subprocess.Popen([python_executable or sys.executable, '-I', '-S', '-u', str(SCRIPT)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.queue = queue.Queue()
        self.outputs = {}
        self.events = []
        self.unacked = {}
        self.auto_ack = True
        self.thread = threading.Thread(target=self.read, daemon=True)
        self.thread.start()
        self.until(lambda: any(e.get('type') == 'ready' for e in self.events))

    def read(self):
        for line in self.proc.stdout:
            self.queue.put(json.loads(line))

    def send(self, msg):
        self.proc.stdin.write((json.dumps(msg) + '\n').encode())
        self.proc.stdin.flush()

    def poll(self, timeout=.1):
        try:
            msg = self.queue.get(timeout=timeout)
        except queue.Empty:
            return None
        self.events.append(msg)
        if msg.get('type') == 'data':
            sid = msg['id']
            data = base64.b64decode(msg['data'])
            self.outputs[sid] = self.outputs.get(sid, b'') + data
            self.unacked[sid] = self.unacked.get(sid, 0) + len(data)
            if self.auto_ack:
                self.send({'type': 'ack', 'id': sid, 'bytes': len(data)})
                self.unacked[sid] -= len(data)
        return msg

    def until(self, condition, timeout=4):
        end = time.monotonic() + timeout
        while not condition():
            if time.monotonic() >= end:
                raise AssertionError('Timed out; recent events: %r' % self.events[-5:])
            self.poll(.03)

    def spawn(self, sid='s1', cwd=None, rows=24, cols=80):
        self.send({'type': 'spawn', 'id': sid, 'shell': '/bin/bash', 'args': ['--noprofile', '--norc', '-i'],
                   'cwd': cwd or tempfile.gettempdir(), 'rows': rows, 'cols': cols})
        self.until(lambda: any(e.get('type') == 'spawned' and e.get('id') == sid for e in self.events))
        pid = next(e['pid'] for e in self.events if e.get('type') == 'spawned' and e.get('id') == sid)
        self.input('stty -echo; printf "\\nNOECHO_READY\\n"\n', sid)
        self.until(lambda: b'\r\nNOECHO_READY\r\n' in self.outputs.get(sid, b''))
        self.outputs[sid] = b''
        return pid

    def input(self, text, sid='s1'):
        self.send({'type': 'input', 'id': sid, 'data': base64.b64encode(text.encode()).decode()})

    def output(self, text, sid='s1', timeout=4):
        data = text.encode() if isinstance(text, str) else text
        self.until(lambda: data in self.outputs.get(sid, b''), timeout)

    def cleanup(self):
        if self.proc.poll() is None:
            try:
                self.send({'type': 'shutdown'})
                self.proc.wait(timeout=3)
            except (BrokenPipeError, subprocess.TimeoutExpired):
                self.proc.kill(); self.proc.wait()
        self.proc.stdin.close(); self.proc.stdout.close(); self.proc.stderr.close()


@unittest.skipUnless(sys.platform.startswith('linux'), 'WSL/Linux tests')
class PtyIntegration(unittest.TestCase):
    def setUp(self): self.client = Client()
    def tearDown(self): self.client.cleanup()

    def test_lazy_host_starts_with_no_shells(self):
        ready = self.client.events[0]
        self.assertEqual(ready['type'], 'ready')
        self.assertEqual(ready['protocol'], 1)
        self.client.send({'type': 'ping'})
        self.client.until(lambda: any(e.get('type') == 'pong' for e in self.client.events))
        self.assertEqual(self.client.events[-1]['sessions'], 0)

    def test_real_interactive_tty_and_stderr(self):
        c = self.client; c.spawn()
        c.input("test -t 0 && test -t 1 && printf 'TTY_OK\\n'; printf 'ERR_OK\\n' >&2\n")
        c.output('TTY_OK\r\n'); c.output('ERR_OK\r\n')

    def test_utf8_and_ansi(self):
        c = self.client; c.spawn()
        c.input("printf '\\033[31mEspañol: café 漢字 😀\\033[0m\\n'\n")
        c.output('\x1b[31mEspañol: café 漢字 😀\x1b[0m')

    def test_cwd_with_spaces_and_unicode(self):
        c = self.client
        with tempfile.TemporaryDirectory(prefix='sideterm café ') as directory:
            c.spawn(cwd=directory)
            c.input('printf "CWD="; pwd\n')
            c.output('CWD=' + directory + '\r\n')

    def test_independent_sessions(self):
        c = self.client; c.spawn('a'); c.spawn('b')
        c.input('export SIDE_VALUE=AAA; printf "VALUE=$SIDE_VALUE\\n"\n', 'a')
        c.input('export SIDE_VALUE=BBB; printf "VALUE=$SIDE_VALUE\\n"\n', 'b')
        c.output('VALUE=AAA', 'a'); c.output('VALUE=BBB', 'b')
        self.assertNotIn(b'VALUE=BBB', c.outputs['a'])

    def test_initial_size_and_resize(self):
        c = self.client; c.spawn(rows=31, cols=97)
        c.input('stty size\n'); c.output('31 97\r\n')
        c.send({'type': 'resize', 'id': 's1', 'rows': 43, 'cols': 111})
        c.input('stty size\n'); c.output('43 111\r\n')

    def test_ctrl_c_interrupts_foreground_not_shell(self):
        c = self.client; pid = c.spawn()
        c.input('sleep 30\n'); time.sleep(.12)
        c.input('\x03'); c.input('printf "AFTER_INTERRUPT\\n"\n')
        c.output('AFTER_INTERRUPT\r\n')
        self.assertTrue(alive(pid))

    def test_invalid_shell_fails_without_spawn(self):
        c = self.client
        c.send({'type': 'spawn', 'id': 'bad', 'shell': '/does/not/exist', 'args': [], 'cwd': '/tmp'})
        c.until(lambda: any(e.get('type') == 'error' for e in c.events))
        self.assertFalse(any(e.get('type') == 'spawned' for e in c.events))

    def test_invalid_cwd_fails_without_spawn(self):
        c = self.client
        c.send({'type': 'spawn', 'id': 'bad', 'shell': '/bin/bash', 'args': ['-i'], 'cwd': '/missing/folder'})
        c.until(lambda: any(e.get('type') == 'error' for e in c.events))
        self.assertFalse(any(e.get('type') == 'spawned' for e in c.events))

    def test_malformed_protocol_recovers(self):
        c = self.client
        c.proc.stdin.write(b'not json\n'); c.proc.stdin.flush()
        c.until(lambda: any(e.get('type') == 'error' for e in c.events))
        c.send({'type': 'ping'})
        c.until(lambda: any(e.get('type') == 'pong' for e in c.events))
        self.assertIsNone(c.proc.poll())

    def test_flow_control_bounded_and_resumes(self):
        c = self.client; c.spawn()
        # Drain prompt output before withholding credits.
        for _ in range(5): c.poll(.03)
        c.auto_ack = False
        c.input("python3 -c \"import sys; sys.stdout.write('Z'*400000); sys.stdout.flush()\"\n")
        c.until(lambda: c.unacked.get('s1', 0) >= WINDOW)
        before = c.unacked['s1']; self.assertEqual(before, WINDOW)
        for _ in range(5): c.poll(.03)
        self.assertEqual(c.unacked['s1'], before)
        c.send({'type': 'ack', 'id': 's1', 'bytes': before}); c.unacked['s1'] = 0
        c.auto_ack = True
        c.until(lambda: c.outputs['s1'].count(b'Z') >= 400000, timeout=6)

    def test_exit_status(self):
        c = self.client; c.spawn(); c.input('exit 7\n')
        c.until(lambda: any(e.get('type') == 'exit' and e.get('id') == 's1' for e in c.events))
        self.assertEqual(next(e['code'] for e in c.events if e.get('type') == 'exit'), 7)

    def test_close_cleans_job_control_descendant(self):
        c = self.client; shell_pid = c.spawn()
        c.input("bash -c 'trap \"\" HUP; sleep 60' & printf 'CHILD=%s\\n' $!\n")
        c.until(lambda: re.search(rb'CHILD=(\d+)\r\n', c.outputs.get('s1', b'')) is not None)
        child = int(re.search(rb'CHILD=(\d+)\r\n', c.outputs['s1']).group(1))
        c.send({'type': 'close', 'id': 's1'})
        c.until(lambda: any(e.get('type') == 'exit' for e in c.events))
        time.sleep(.1)
        self.assertFalse(alive(shell_pid)); self.assertFalse(alive(child))

    def test_parent_pipe_eof_cleans_shell(self):
        c = self.client; shell_pid = c.spawn()
        c.proc.stdin.close(); c.proc.wait(timeout=3)
        self.assertFalse(alive(shell_pid))

    def test_shell_environment(self):
        c = self.client; c.spawn()
        c.input('printf "ENV=%s/%s/%s\\n" "$TERM" "$COLORTERM" "$SIDETERM_LOCAL"\n')
        c.output('ENV=xterm-256color/truecolor/1')


if __name__ == '__main__': unittest.main()
