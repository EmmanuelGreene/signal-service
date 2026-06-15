#!/usr/bin/env python3
"""Fast Hermes chat relay — uses venv Python3 directly (no uv).
Syntax: HERMES_HOME=/opt/data /opt/hermes/.venv/bin/python3 hermes_chat.py "message"

First call may be slow (Python imports), subsequent calls are fast due to FS cache.
Outputs JSON: {"reply": "..."} on stdout."""

import sys, json, os, subprocess

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No message"}), file=sys.stderr)
        sys.exit(1)

    message = sys.argv[1]
    
    try:
        result = subprocess.run(
            ['/opt/hermes/.venv/bin/python3', '-m', 'hermes_cli.main', 'chat', '-Q', '-q', message],
            capture_output=True, text=True, timeout=180,
            cwd='/opt/hermes',
            env={'HERMES_HOME': '/opt/data', 'PAGER': 'cat', 'PYTHONUNBUFFERED': '1',
                 'HERMES_QUIET': '1', 'HERMES_NO_TELEMETRY': '1',
                 'PATH': os.environ.get('PATH', '/usr/bin'),
                 'HOME': os.environ.get('HOME', '/tmp')}
        )
        
        lines = [l.strip() for l in result.stdout.split('\n') if l.strip()]
        reply = "I'm not sure how to respond to that."
        for line in reversed(lines):
            if not line.startswith('<') and not line.startswith('session_id:'):
                reply = line
                break
                
    except subprocess.TimeoutExpired:
        reply = "The AI backend took too long. Check the signal board for BUY/SELL/HOLD ratings."
    except Exception as e:
        reply = f"The AI backend is temporarily unavailable."
    
    print(json.dumps({"reply": reply}, ensure_ascii=False), flush=True)

if __name__ == '__main__':
    main()
