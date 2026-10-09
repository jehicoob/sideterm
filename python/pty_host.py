#!/usr/bin/env python3
"""SideTerm Local: single-process, POSIX PTY multiplexer (Python 3.8+; Linux/WSL and macOS).

JSON-lines over private stdio pipes. No listening sockets, threads, third-party
Python modules or transcript files. A shared 1-second metadata check runs only
while the view is visible; PTY I/O itself uses blocking selectors. Each child gets its own PTY and
session. Output credits bound outstanding data; the client acknowledges bytes
only after xterm has consumed them.
"""
from __future__ import annotations

import base64
import binascii
import errno
import fcntl
import json
import os
import pty
import resource
import selectors
import signal
import struct
import sys
import termios
import time
import unicodedata
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Deque, Dict, Optional

IS_DARWIN = sys.platform == 'darwin'
# Process inspection backend: Linux exposes /proc; macOS has no /proc, so libproc is read via ctypes.
BACKEND = 'darwin' if IS_DARWIN else 'proc'

VERSION = 1
WINDOW = 131072
MAX_LINE = 2 * 1024 * 1024
MAX_INPUT = 512 * 1024
MAX_SESSIONS = 12
READ_SIZE = 16384
METADATA_INTERVAL = 1.0
# Metadata is display-only. Never execute/read back anything supplied by a title.
SHELL_NAMES = {'bash', 'zsh', 'sh', 'dash', 'fish', 'ksh', 'tcsh', 'csh', 'nu'}
RUNTIME_NAMES = {'node', 'nodejs', 'bun', 'deno', 'python', 'python3', 'sh', 'bash', 'zsh', 'npm', 'npx', 'pnpm', 'yarn'}


if IS_DARWIN:
    import ctypes

    PROC_ALL_PIDS, PROC_TTY_ONLY, PROC_PPID_ONLY = 1, 3, 6
    PROC_PIDTBSDINFO, PROC_PIDVNODEPATHINFO = 3, 9
    TIOCPTYGNAME = 0x40807453
    SZOMB = 5

    class _BsdInfo(ctypes.Structure):
        _fields_ = [('flags', ctypes.c_uint32), ('status', ctypes.c_uint32), ('xstatus', ctypes.c_uint32),
                    ('pid', ctypes.c_uint32), ('ppid', ctypes.c_uint32), ('uid', ctypes.c_uint32),
                    ('gid', ctypes.c_uint32), ('ruid', ctypes.c_uint32), ('rgid', ctypes.c_uint32),
                    ('svuid', ctypes.c_uint32), ('svgid', ctypes.c_uint32), ('rfu', ctypes.c_uint32),
                    ('comm', ctypes.c_char * 16), ('name', ctypes.c_char * 32), ('nfiles', ctypes.c_uint32),
                    ('pgid', ctypes.c_uint32), ('pjobc', ctypes.c_uint32), ('tdev', ctypes.c_uint32),
                    ('tpgid', ctypes.c_uint32), ('nice', ctypes.c_int32),
                    ('start_sec', ctypes.c_uint64), ('start_usec', ctypes.c_uint64)]

    class _VnodePath(ctypes.Structure):
        _fields_ = [('vnode_info', ctypes.c_char * 152), ('path', ctypes.c_char * 1024)]

    class _VnodePathInfo(ctypes.Structure):
        _fields_ = [('cdir', _VnodePath), ('rdir', _VnodePath)]

    try:
        _libproc = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
        _libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
        _libproc.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
        _libproc.proc_listpids.argtypes = [ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_int]
        _libc.sysctl.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t]
    except (OSError, AttributeError):
        _libproc = None  # Metadata is display-only: tabs keep working with generic names.

    def darwin_list(kind: int, info: int) -> list:
        if _libproc is None:
            return []
        buffer = (ctypes.c_int * 1024)()
        count = _libproc.proc_listpids(kind, info, buffer, ctypes.sizeof(buffer))
        return [pid for pid in buffer[:max(count, 0) // ctypes.sizeof(ctypes.c_int)] if pid > 0]

    def darwin_process(pid: int) -> Optional[Dict[str, Any]]:
        if _libproc is None:
            return None
        info = _BsdInfo()
        size = _libproc.proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, ctypes.byref(info), ctypes.sizeof(info))
        if size != ctypes.sizeof(info) or info.pid != pid or info.status == SZOMB:
            return None
        return {'pid': pid, 'comm': (info.name or info.comm).decode('utf-8', 'replace'),
                'pgrp': info.pgid, 'tty': info.tdev, 'start': '%d.%06d' % (info.start_sec, info.start_usec)}

    def darwin_cwd(pid: int) -> Optional[str]:
        if _libproc is None:
            return None
        info = _VnodePathInfo()
        size = _libproc.proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, ctypes.byref(info), ctypes.sizeof(info))
        return info.cdir.path.decode('utf-8', 'replace') if size == ctypes.sizeof(info) else None

    def darwin_argv(pid: int) -> list:
        """KERN_PROCARGS2: argc, exec path, padding NULs, argv..., then the environment (never read)."""
        if _libproc is None:
            return []
        mib = (ctypes.c_int * 3)(1, 49, pid)  # CTL_KERN, KERN_PROCARGS2
        data = ctypes.create_string_buffer(65536)
        size = ctypes.c_size_t(ctypes.sizeof(data))
        if _libc.sysctl(mib, 3, data, ctypes.byref(size), None, 0) != 0 or size.value < 8:
            return []
        raw = data.raw[:min(size.value, 8192)]
        argc = int.from_bytes(raw[:4], sys.byteorder)
        position = raw.find(b'\0', 4)
        if position < 0:
            return []
        while position < len(raw) and raw[position] == 0:
            position += 1
        return [item.decode('utf-8', 'replace') for item in raw[position:].split(b'\0')[:min(argc, 32)]]

    def darwin_tty(master_fd: int) -> Optional[int]:
        """Device number of the PTY slave: the identity of this session's controlling terminal."""
        try:
            name = bytearray(128)
            fcntl.ioctl(master_fd, TIOCPTYGNAME, name)
            return os.stat(bytes(name).split(b'\0', 1)[0].decode('utf-8', 'replace')).st_rdev
        except (OSError, ValueError):
            return None


def clean_label(text: str, maximum: int = 96) -> str:
    return ''.join(c for c in text if not unicodedata.category(c).startswith('C')).strip()[:maximum]


def known_program(entry: str) -> Optional[str]:
    """Only executable/entry-point identity, never arbitrary command arguments."""
    lower = entry.lower().replace('\\', '/')
    name = lower.rsplit('/', 1)[-1]
    if name.endswith('.exe'):
        name = name[:-4]
    if name in ('opencode', 'opencode.js', 'opencode.cjs', 'opencode.mjs') or name.startswith(('opencode-linux-', 'opencode-darwin-')):
        return 'OpenCode'
    if name in ('claude', 'claude.js', 'claude.cjs', 'claude.mjs'):
        return 'Claude'
    if name in ('codex', 'codex.js', 'codex.cjs', 'codex.mjs'):
        return 'Codex'
    if '/@anthropic-ai/claude-code/' in lower and name in ('cli.js', 'cli.mjs', 'cli.cjs'):
        return 'Claude'
    if '/@openai/codex/' in lower and name in ('cli.js', 'cli.mjs', 'cli.cjs'):
        return 'Codex'
    return None


def read_process(pid: int) -> Optional[Dict[str, Any]]:
    if BACKEND == 'darwin':
        return darwin_process(pid)
    try:
        with open('/proc/%s/stat' % pid, encoding='utf-8', errors='replace') as file:
            raw = file.read(8192)
        closing = raw.rfind(')')
        fields = raw[closing + 2:].split()
        if closing < 0 or len(fields) < 20:
            return None
        return {'pid': pid, 'comm': raw[raw.find('(') + 1:closing],
                'pgrp': int(fields[2]), 'sid': int(fields[3]), 'start': fields[19]}
    except (OSError, ValueError):
        return None


def in_session(info: Dict[str, Any], s: 'Session') -> bool:
    """Linux exposes the session id; macOS does not, so the PTY's controlling terminal identifies it."""
    if info.get('sid') is not None:
        return info['sid'] == s.pid
    return s.tty is not None and info.get('tty') == s.tty


def process_argv(pid: int) -> list:
    if BACKEND == 'darwin':
        return darwin_argv(pid)
    try:
        with open('/proc/%s/cmdline' % pid, 'rb') as file:
            # Bounded and ephemeral. Command arguments are NEVER sent to the UI/logs.
            return file.read(8192).decode('utf-8', 'replace').split('\0')[:32]
    except OSError:
        return []


def child_pids(pid: int) -> list:
    if BACKEND == 'darwin':
        return darwin_list(PROC_PPID_ONLY, pid)[:16]
    with open('/proc/%s/task/%s/children' % (pid, pid)) as file:
        return file.read(4096).split()[:16]


def process_cwd(pid: int) -> Optional[str]:
    if BACKEND == 'darwin':
        return darwin_cwd(pid)
    try:
        return os.readlink('/proc/%s/cwd' % pid)
    except OSError:
        return None


def process_label(info: Dict[str, Any]) -> str:
    argv = process_argv(info['pid'])  # Ephemeral: command arguments are NEVER sent to the UI/logs.
    first = argv[0] if argv else ''
    for entry in (first, info['comm']):
        known = known_program(entry)
        if known:
            return known
    base = os.path.basename(first).lstrip('-') or info['comm']
    # Interpreter shebangs expose the script as the first non-option argument.
    # Do not mistake `node app.js --message Claude` for Claude itself.
    if base in RUNTIME_NAMES or base.startswith('python3.'):
        skip = False
        for item in argv[1:]:
            if skip:
                skip = False
                continue
            if item in ('-c', '-e', '--eval', '-p', '--print', '-m'):
                break
            if item in ('-r', '--require', '--import', '--loader', '--experimental-loader'):
                skip = True
                continue
            if item.startswith('-'):
                continue
            if item:
                known = known_program(item)
                if known:
                    return known
                break
    return clean_label(base) or 'terminal'


def inspect_terminal(s: 'Session') -> Optional[Dict[str, Any]]:
    """Read this PTY's foreground leader, never scan the system process table.

    Resolve a bounded child tree only for wrappers, without following an agent's
    jobs: `OpenCode -> git` must keep the OpenCode name and working directory.
    All candidates must remain in this exact session (Linux) or controlling terminal (macOS) and foreground group.
    """
    try:
        foreground = os.tcgetpgrp(s.fd)
    except OSError:
        return None
    root = read_process(foreground)
    if root is None or not in_session(root, s) or root['pgrp'] != foreground:
        root = read_process(s.pid)
    if root is None or not in_session(root, s):
        return None
    selected = root
    label = process_label(root)
    if label in RUNTIME_NAMES:
        queue = [root['pid']]
        seen = set()
        found = False
        inspected = 0
        while queue and inspected < 16 and not found:
            parent = queue.pop(0)
            if parent in seen:
                continue
            seen.add(parent)
            try:
                child_ids = child_pids(parent)
            except OSError:
                continue
            for value in child_ids:
                if inspected >= 16:
                    break
                inspected += 1
                try:
                    child = read_process(int(value))
                except ValueError:
                    continue
                if child is None or not in_session(child, s) or child['pgrp'] != root['pgrp']:
                    continue
                child_label = process_label(child)
                if child_label in ('OpenCode', 'Claude', 'Codex'):
                    selected, label, found = child, child_label, True
                    break
                if child_label in RUNTIME_NAMES:
                    queue.append(child['pid'])
    cwd = s.cwd
    for pid in (selected['pid'], root['pid'], s.pid):
        candidate = process_cwd(pid)
        if candidate and candidate.startswith('/'):
            cwd = candidate
            break
    return {'cwd': cwd, 'process': label,
            'foreground': selected['pid'] != s.pid or label not in SHELL_NAMES,
            'foregroundKey': '%s:%s:%s' % (selected['pid'], selected['start'], label)}


@dataclass
class Session:
    id: str
    pid: int
    fd: int
    credit: int = WINDOW
    incoming: bytearray = field(default_factory=bytearray)
    eof: bool = False
    status: Optional[int] = None
    closing: bool = False
    deadline: Optional[float] = None
    kill_sent: bool = False
    cwd: str = ""
    metadata: Optional[Dict[str, Any]] = None
    pending_title: Optional[str] = None
    tty: Optional[int] = None  # macOS: slave device number identifying the session
    known: Dict[int, str] = field(default_factory=dict)  # macOS: pid -> start time seen on the tty


class Host:
    def __init__(self) -> None:
        self.selector = selectors.DefaultSelector()
        self.sessions: Dict[str, Session] = {}
        self.stdin = bytearray()
        self.out: Deque[bytes] = deque()
        self.out_offset = 0
        self.out_size = 0
        self.stopping = False
        self.stdout_dead = False
        self.stop_deadline: Optional[float] = None
        self.metadata_visible = True
        self.metadata_due = time.monotonic()
        self.signal_r, self.signal_w = os.pipe()
        for fd in (0, 1, self.signal_r, self.signal_w):
            os.set_blocking(fd, False)
        self.selector.register(0, selectors.EVENT_READ, ('stdin', None))
        self.selector.register(self.signal_r, selectors.EVENT_READ, ('signal', None))
        signal.set_wakeup_fd(self.signal_w)
        signal.signal(signal.SIGCHLD, lambda *_: None)
        signal.signal(signal.SIGTERM, self.handle_stop)
        signal.signal(signal.SIGINT, self.handle_stop)
        signal.signal(signal.SIGHUP, self.handle_stop)
        signal.signal(signal.SIGPIPE, signal.SIG_IGN)

    def handle_stop(self, *_: Any) -> None:
        self.stopping = True

    def unregister(self, fd: int) -> None:
        try:
            self.selector.unregister(fd)
        except (KeyError, ValueError):
            pass

    def emit(self, obj: Dict[str, Any]) -> None:
        if self.stdout_dead:
            return
        payload = (json.dumps(obj, separators=(',', ':'), ensure_ascii=True) + '\n').encode()
        self.out.append(payload)
        self.out_size += len(payload)
        # Bounded output credits keep normal traffic < ~2.2 MiB at 12 sessions.
        if self.out_size > 8 * 1024 * 1024:
            self.stopping = True
            return
        try:
            self.selector.modify(1, selectors.EVENT_WRITE, ('stdout', None))
        except KeyError:
            self.selector.register(1, selectors.EVENT_WRITE, ('stdout', None))

    def flush(self) -> None:
        try:
            budget = 256 * 1024
            while self.out and budget > 0:
                item = self.out[0]
                sent = os.write(1, memoryview(item)[self.out_offset:])
                self.out_offset += sent
                self.out_size -= sent
                budget -= sent
                if self.out_offset == len(item):
                    self.out.popleft()
                    self.out_offset = 0
            if not self.out:
                self.unregister(1)
        except BlockingIOError:
            pass
        except (BrokenPipeError, OSError):
            self.stdout_dead = True
            self.out.clear()
            self.out_size = 0
            self.unregister(1)
            self.stopping = True

    @staticmethod
    def dim(value: Any, low: int, high: int) -> int:
        if not isinstance(value, int) or isinstance(value, bool):
            raise ValueError('Invalid terminal dimensions')
        return max(low, min(high, value))

    def watch(self, s: Session) -> None:
        if s.eof or s.fd < 0:
            return
        mask = (selectors.EVENT_READ if s.credit > 0 and not s.closing else 0)
        if s.incoming and not s.closing:
            mask |= selectors.EVENT_WRITE
        self.unregister(s.fd)
        if mask:
            self.selector.register(s.fd, mask, ('pty', s.id))

    def spawn(self, msg: Dict[str, Any]) -> None:
        sid = msg.get('id')
        if not isinstance(sid, str) or not 1 <= len(sid) <= 80 or sid in self.sessions:
            raise ValueError('Invalid or duplicate session identifier')
        if len(self.sessions) >= MAX_SESSIONS:
            raise ValueError('Session limit reached')
        shell, args, cwd = msg.get('shell'), msg.get('args'), msg.get('cwd')
        if not isinstance(shell, str) or not os.path.isabs(shell) or not os.access(shell, os.X_OK) or not os.path.isfile(shell):
            raise ValueError('Shell must be an existing executable absolute path')
        if not isinstance(args, list) or len(args) > 32 or any(not isinstance(a, str) or '\0' in a or len(a) > 4096 for a in args):
            raise ValueError('Invalid shell argument array')
        if not isinstance(cwd, str) or not os.path.isabs(cwd) or not os.path.isdir(cwd):
            raise ValueError('Working directory does not exist')
        cols = self.dim(msg.get('cols', 80), 2, 500)
        rows = self.dim(msg.get('rows', 24), 1, 200)
        pid, fd = pty.fork()
        if pid == 0:
            try:
                signal.set_wakeup_fd(-1)
                for sig in (signal.SIGCHLD, signal.SIGHUP, signal.SIGINT, signal.SIGQUIT,
                            signal.SIGTERM, signal.SIGPIPE, signal.SIGWINCH):
                    signal.signal(sig, signal.SIG_DFL)
                fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
                limit = resource.getrlimit(resource.RLIMIT_NOFILE)[0]
                os.closerange(3, min(int(limit) if limit != resource.RLIM_INFINITY else 65536, 1048576))
                os.chdir(cwd)
                env = dict(os.environ)
                env.update(TERM='xterm-256color', COLORTERM='truecolor',
                           TERM_PROGRAM='SideTermLocal', TERM_PROGRAM_VERSION='0.2.0',
                           SIDETERM_LOCAL='1')
                # Python isolated mode protects this helper, not the user's shell.
                os.execve(shell, [shell] + args, env)
            except BaseException as exc:
                os.write(2, ('SideTerm: cannot start shell: %s\r\n' % exc).encode('utf-8', 'replace'))
                os._exit(127)
        os.set_blocking(fd, False)
        session = Session(sid, pid, fd, cwd=cwd, tty=darwin_tty(fd) if IS_DARWIN else None)
        self.metadata_due = time.monotonic() + 0.05
        self.sessions[sid] = session
        self.watch(session)
        self.emit({'type': 'spawned', 'id': sid, 'pid': pid})

    def reap(self) -> None:
        while True:
            try:
                pid, status = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                return
            if pid <= 0:
                return
            for s in list(self.sessions.values()):
                if s.pid == pid:
                    s.status = status
                    self.finish(s)
                    break

    def finish(self, s: Session) -> None:
        if not s.eof or s.status is None:
            return
        if s.closing and s.deadline is not None and not s.kill_sent:
            return
        code = os.WEXITSTATUS(s.status) if os.WIFEXITED(s.status) else None
        sig = os.WTERMSIG(s.status) if os.WIFSIGNALED(s.status) else None
        self.emit({'type': 'exit', 'id': s.id, 'code': code, 'signal': sig})
        self.sessions.pop(s.id, None)

    def close_fd(self, s: Session) -> None:
        if s.fd >= 0:
            self.unregister(s.fd)
            try:
                os.close(s.fd)
            except OSError:
                pass
        s.fd = -1
        s.eof = True
        s.incoming.clear()

    @staticmethod
    def signal_session(s: Session, sig: int) -> None:
        # Job control creates multiple process groups. Signal all processes still
        # belonging to this particular session, not other shells.
        if BACKEND == 'proc' and sys.platform.startswith('linux'):
            try:
                entries = os.scandir('/proc')
                with entries:
                    for item in entries:
                        if not item.name.isdigit():
                            continue
                        try:
                            with open('/proc/%s/stat' % item.name, 'r') as file:
                                stat = file.read()
                            fields = stat[stat.rfind(')') + 2:].split()
                            if len(fields) > 3 and int(fields[3]) == s.pid:
                                os.kill(int(item.name), sig)
                        except (OSError, ValueError):
                            continue
            except OSError:
                pass
        else:
            Host.signal_tty_members(s, sig)
            try:
                if s.fd >= 0:
                    foreground = os.tcgetpgrp(s.fd)
                    if foreground > 0:
                        os.killpg(foreground, sig)
                os.killpg(s.pid, sig)
            except OSError:
                pass

    @staticmethod
    def signal_tty_members(s: Session, sig: int) -> None:
        """macOS has no session lookup. While the master is open, the slave's tty lists every member;
        afterwards the tty number may be reused by a new tab, so only pids recorded earlier are
        signalled, and only while their start time still matches (guards against pid reuse)."""
        if not IS_DARWIN:
            return
        if s.fd >= 0 and s.tty is not None:
            for pid in darwin_list(PROC_TTY_ONLY, s.tty):
                info = darwin_process(pid)
                if info is not None and info['tty'] == s.tty:
                    s.known[pid] = info['start']
        for pid, start in list(s.known.items()):
            info = darwin_process(pid)
            if info is None or info['start'] != start:
                s.known.pop(pid, None)
                continue
            try:
                os.kill(pid, sig)
            except OSError:
                pass

    def close(self, s: Session) -> None:
        if s.closing:
            return
        s.closing = True
        self.signal_session(s, signal.SIGHUP)
        self.close_fd(s)
        s.deadline = time.monotonic() + 0.5
        self.reap()
        # Keep the session until its cleanup deadline even when the leader exits:
        # descendants in other job-control groups may ignore SIGHUP.

    def read_pty(self, s: Session) -> None:
        try:
            data = os.read(s.fd, min(READ_SIZE, s.credit))
        except BlockingIOError:
            return
        except OSError as exc:
            if exc.errno not in (errno.EIO, errno.EBADF):
                self.emit({'type': 'error', 'id': s.id, 'message': 'PTY read failed'})
            data = b''
        if not data:
            self.close_fd(s)
            self.reap()
            self.finish(s)
            return
        s.credit -= len(data)
        self.emit({'type': 'data', 'id': s.id,
                   'data': base64.b64encode(data).decode('ascii'), 'bytes': len(data)})
        self.watch(s)

    def write_pty(self, s: Session) -> None:
        if not s.incoming or s.fd < 0:
            return
        try:
            count = os.write(s.fd, s.incoming)
            del s.incoming[:count]
        except BlockingIOError:
            pass
        except OSError:
            s.incoming.clear()
        self.watch(s)

    def dispatch(self, msg: Any) -> None:
        if not isinstance(msg, dict):
            raise ValueError('Expected a JSON object')
        op = msg.get('type')
        if op == 'spawn':
            if self.stopping:
                raise ValueError('Host is stopping')
            self.spawn(msg)
            return
        if op == 'shutdown':
            self.stopping = True
            return
        if op == 'visibility':
            if isinstance(msg.get('visible'), bool):
                self.metadata_visible = msg['visible']
                if self.metadata_visible:
                    self.metadata_due = time.monotonic()
            return
        if op == 'ping':
            self.emit({'type': 'pong', 'sessions': len(self.sessions)})
            return
        sid = msg.get('id')
        s = self.sessions.get(sid) if isinstance(sid, str) else None
        if s is None:
            # Late resize/input/ack messages after closure are benign.
            return
        if op == 'title':
            title = msg.get('title')
            if isinstance(title, str) and len(title) <= 512:
                s.pending_title = clean_label(title, 160)
        elif op == 'close':
            self.close(s)
        elif op == 'ack':
            count = msg.get('bytes')
            if not isinstance(count, int) or isinstance(count, bool) or not 0 < count <= WINDOW:
                raise ValueError('Invalid output acknowledgement')
            s.credit = min(WINDOW, s.credit + count)
            self.watch(s)
        elif op == 'input' and not s.closing and not s.eof:
            data = msg.get('data')
            if not isinstance(data, str) or len(data) > (MAX_INPUT * 4 // 3 + 8):
                raise ValueError('Input is too large')
            try:
                decoded = base64.b64decode(data, validate=True)
            except (ValueError, binascii.Error):
                raise ValueError('Invalid base64 input')
            if len(s.incoming) + len(decoded) > MAX_INPUT:
                raise ValueError('Input queue is full; wait before pasting more text')
            s.incoming.extend(decoded)
            self.write_pty(s)
        elif op == 'resize' and not s.closing and not s.eof:
            cols = self.dim(msg.get('cols'), 2, 500)
            rows = self.dim(msg.get('rows'), 1, 200)
            try:
                fcntl.ioctl(s.fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
            except OSError:
                pass

    def read_stdin(self) -> None:
        try:
            data = os.read(0, 65536)
        except BlockingIOError:
            return
        if not data:
            self.unregister(0)
            self.stopping = True
            return
        self.stdin.extend(data)
        if len(self.stdin) > MAX_LINE:
            self.emit({'type': 'error', 'message': 'Protocol line too large'})
            self.stopping = True
            return
        while b'\n' in self.stdin:
            line, _, rest = self.stdin.partition(b'\n')
            self.stdin = bytearray(rest)
            msg = None
            try:
                msg = json.loads(line)
                self.dispatch(msg)
            except (ValueError, TypeError, KeyError, OSError) as exc:
                sid = msg.get('id') if isinstance(msg, dict) else None
                self.emit({'type': 'error', 'id': sid,
                           'operation': msg.get('type') if isinstance(msg, dict) else None,
                           'message': str(exc)[:300]})

    def update_metadata(self) -> None:
        if self.stopping or not self.metadata_visible or time.monotonic() < self.metadata_due:
            return
        self.metadata_due = time.monotonic() + METADATA_INTERVAL
        for s in list(self.sessions.values()):
            if s.closing or s.eof or s.fd < 0:
                continue
            data = inspect_terminal(s)
            if data is not None and (data != s.metadata or s.pending_title is not None):
                s.metadata = data
                s.cwd = data['cwd']
                event = dict(data, type='metadata', id=s.id)
                if s.pending_title is not None:
                    event['title'] = s.pending_title
                    s.pending_title = None
                self.emit(event)

    def deadlines(self) -> Optional[float]:
        now = time.monotonic()
        future = []
        if self.metadata_visible and not self.stopping and any(not s.closing and not s.eof for s in self.sessions.values()):
            future.append(self.metadata_due)
        for s in list(self.sessions.values()):
            if s.deadline is not None:
                if now >= s.deadline:
                    self.signal_session(s, signal.SIGKILL)
                    s.kill_sent = True
                    s.deadline = None
                    self.finish(s)
                else:
                    future.append(s.deadline)
        if self.stop_deadline is not None:
            future.append(self.stop_deadline)
        return max(0.0, min(future) - now) if future else None

    def run(self) -> None:
        self.emit({'type': 'ready', 'protocol': VERSION, 'pid': os.getpid(),
                   'python': '.'.join(map(str, sys.version_info[:3]))})
        try:
            while True:
                if self.stopping and self.stop_deadline is None:
                    self.unregister(0)
                    for s in list(self.sessions.values()):
                        self.close(s)
                    self.stop_deadline = time.monotonic() + 1.2
                self.update_metadata()
                timeout = self.deadlines()
                self.reap()
                if self.stopping and ((not self.sessions and not self.out) or
                                      time.monotonic() >= (self.stop_deadline or 0)):
                    break
                for key, mask in self.selector.select(timeout):
                    kind, sid = key.data
                    if kind == 'stdin':
                        self.read_stdin()
                    elif kind == 'stdout':
                        self.flush()
                    elif kind == 'signal':
                        try:
                            while os.read(self.signal_r, 4096):
                                pass
                        except BlockingIOError:
                            pass
                        self.reap()
                    elif kind == 'pty':
                        s = self.sessions.get(sid)
                        if s and s.fd == key.fd:
                            if mask & selectors.EVENT_READ:
                                self.read_pty(s)
                            if mask & selectors.EVENT_WRITE and not s.eof:
                                self.write_pty(s)
        finally:
            for s in list(self.sessions.values()):
                self.signal_session(s, signal.SIGKILL)
                self.close_fd(s)
            self.reap()
            signal.set_wakeup_fd(-1)
            self.selector.close()
            os.close(self.signal_r)
            os.close(self.signal_w)


if __name__ == '__main__':
    if os.name != 'posix':
        sys.stderr.write('SideTerm Local requires Linux/WSL, macOS or another POSIX host.\n')
        sys.exit(2)
    Host().run()
