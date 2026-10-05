#!/usr/bin/env python3
"""Optional Linux-only measurement of helper RSS/CPU, excluding VS Code and shells.
Uses only stdlib and the same integration-test client; not shipped in the VSIX.
"""
import json
import os
from pathlib import Path
import sys
import time
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'tests'))
from test_pty import Client


def stats(pid):
    text = Path('/proc/%d/stat' % pid).read_text()
    fields = text[text.rfind(')') + 2:].split()
    ticks = int(fields[11]) + int(fields[12])
    rss = int(fields[21])*os.sysconf('SC_PAGE_SIZE')
    return ticks, rss


def main():
    python = '/usr/bin/python3' if Path('/usr/bin/python3').exists() else sys.executable
    client = Client(python)
    try:
        pids = [client.spawn('tab%d' % i) for i in range(3)]
        time.sleep(.25)
        before, rss_before = stats(client.proc.pid)
        start = time.monotonic()
        time.sleep(3)
        after, rss_after = stats(client.proc.pid)
        elapsed = time.monotonic() - start
        report = {
            'platform': 'Linux container; not the user WSL machine',
            'python_version': client.events[0].get('python'), 'python_executable': python,
            'scope': 'Only shared Python PTY helper, with 3 idle bash sessions; excludes shells, browser, VS Code extension host and AI CLI',
            'helper_count': 1, 'idle_shell_count': len(pids),
            'helper_rss_bytes': rss_after, 'helper_rss_before_bytes': rss_before,
            'sample_seconds': round(elapsed, 3),
            'helper_cpu_ticks_delta': after-before,
            'clock_ticks_per_second': os.sysconf('SC_CLK_TCK'),
            'not_a_total_memory_benchmark': True,
        }
        (ROOT/'docs/helper-metrics.json').write_text(json.dumps(report, indent=2)+'\n')
        print(json.dumps(report, indent=2))
    finally:
        client.cleanup()


if __name__ == '__main__':
    main()
