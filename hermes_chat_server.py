#!/usr/bin/env python3
"""Keep-warm Hermes chat relay — runs as a subprocess that stays alive.
Reads a line from stdin (JSON), writes a line to stdout (JSON)."""

import sys, json, os

os.environ.setdefault('HERMES_HOME', '/opt/data')
os.environ.setdefault('HERMES_QUIET', '1')
os.chdir('/opt/hermes')
sys.path.insert(0, '/opt/hermes')

# Pre-import everything so subsequent calls are instant
from hermes_cli.config import load_config
config = load_config()

for line in sys.stdin:
    if not line.strip():
        continue
    try:
        msg = json.loads(line.strip())
        message = msg.get('message', '')
    except json.JSONDecodeError:
        print(json.dumps({"reply": "Invalid JSON."}), flush=True)
        continue

    try:
        import subprocess
        result = subprocess.run(
            ['/opt/hermes/.venv/bin/python3', '-m', 'hermes_cli.main', 'chat', '-Q', '-q', message],
            capture_output=True, text=True, timeout=120,
            cwd='/opt/hermes',
            env={**os.environ, 'PAGER': 'cat', 'PYTHONUNBUFFERED': '1',
                 'HERMES_HOME': '/opt/data', 'HERMES_QUIET': '1'}
        )
        lines = [l.strip() for l in result.stdout.split('\n') if l.strip()]
        reply = "I'm not sure."
        for l in reversed(lines):
            if not l.startswith('<') and not l.startswith('session_id:'):
                reply = l
                break
    except subprocess.TimeoutExpired:
        reply = "AI backend timed out."
    except Exception:
        reply = "AI backend unavailable."
    
    print(json.dumps({"reply": reply}), flush=True)
