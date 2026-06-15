#!/usr/bin/env python3
"""Fast Hermes chat relay for crypto-signals server.
Usage: python3 hermes_relay.py "user message"
Outputs: plain text response on stdout, exits 0 on success.

Runs inside the Hermes venv so imports are instant."""

import sys
import json
import os
from pathlib import Path

# Add hermes to path
sys.path.insert(0, '/opt/hermes')
os.environ['HERMES_HOME'] = '/opt/data'

from hermes_cli.main import chat  # these are the CLI internal modules

def main():
    if len(sys.argv) < 2:
        print("Usage: hermes_relay.py <message>", file=sys.stderr)
        sys.exit(1)
    
    message = sys.argv[1]
    
    # Use the CLI chat function directly
    from hermes_cli.commands.chat import chat_command
    from hermes_cli.config import load_config
    
    config = load_config()
    
    # Run chat with single query
    result = chat_command(
        config=config,
        query=message,
        quiet=True,
        no_stream=True,
    )
    
    print(result)

if __name__ == '__main__':
    main()
