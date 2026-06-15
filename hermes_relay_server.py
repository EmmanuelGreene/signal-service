#!/usr/bin/env python3
"""Persistent Hermes chat relay - runs as a background daemon.
Listens on a Unix socket. Each request is handled in a thread so subprocess works."""

import asyncio, json, os, sys, socket as sock_mod
from concurrent.futures import ThreadPoolExecutor

os.environ.setdefault('HERMES_HOME', '/opt/data')
os.chdir('/opt/hermes')
sys.path.insert(0, '/opt/hermes')

SOCKET_PATH = '/tmp/hermes_chat_relay.sock'

def call_hermes(message: str) -> str:
    """Synchronous call to Hermes CLI (runs in thread)."""
    import subprocess
    try:
        result = subprocess.run(
            ['/opt/hermes/.venv/bin/python3', '-m', 'hermes_cli.main', 'chat', '-Q', '-q', message],
            capture_output=True, text=True, timeout=120,
            cwd='/opt/hermes',
            env={**os.environ, 'PAGER': 'cat', 'PYTHONUNBUFFERED': '1',
                 'HERMES_HOME': '/opt/data', 'HERMES_QUIET': '1'}
        )
        lines = [l.strip() for l in result.stdout.split('\n') if l.strip()]
        for line in reversed(lines):
            if not line.startswith('<') and not line.startswith('session_id:'):
                return line
        return "I'm not sure how to respond."
    except subprocess.TimeoutExpired:
        return "The AI backend timed out. Check the signal board for ratings."
    except Exception:
        return "AI backend unavailable."

async def handle_client(reader, writer, pool: ThreadPoolExecutor):
    try:
        data = await asyncio.wait_for(reader.read(65536), timeout=10)
        if not data:
            writer.close()
            return
        
        msg = json.loads(data.decode())
        message = msg.get('message', '')
        
        loop = asyncio.get_running_loop()
        reply = await loop.run_in_executor(pool, call_hermes, message)
        
        response = json.dumps({"reply": reply}, ensure_ascii=False)
        writer.write(response.encode())
        await writer.drain()
    except asyncio.TimeoutError:
        writer.write(json.dumps({"reply": "Request timed out."}).encode())
        await writer.drain()
    except Exception as e:
        writer.write(json.dumps({"reply": f"Error: {str(e)[:60]}"}).encode())
        await writer.drain()
    finally:
        try:
            writer.close()
        except:
            pass

async def main():
    if os.path.exists(SOCKET_PATH):
        os.unlink(SOCKET_PATH)
    
    pool = ThreadPoolExecutor(max_workers=2)
    server = await asyncio.start_unix_server(
        lambda r, w: handle_client(r, w, pool),
        SOCKET_PATH
    )
    os.chmod(SOCKET_PATH, 0o777)
    print(f"🎤 Hermes relay on {SOCKET_PATH}", flush=True)
    async with server:
        await server.serve_forever()

if __name__ == '__main__':
    asyncio.run(main())
