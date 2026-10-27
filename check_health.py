"""Probe the local health endpoint for operational monitoring."""
from __future__ import annotations
import argparse
import json
import sys
import urllib.request


def main() -> int:
    parser=argparse.ArgumentParser()
    parser.add_argument("--url",default="http://127.0.0.1:8766/api/health")
    args=parser.parse_args()
    try:
        with urllib.request.urlopen(args.url,timeout=5) as response:
            data=json.load(response)
    except Exception as error:
        print(f"Resource Finder unavailable: {error}",file=sys.stderr)
        return 2
    providers=data["provider_health"]["providers"]
    for name,info in providers.items():
        print(f"{name}: {info['status']} ({info['requests']} recent calls, median {info['median_ms']} ms)")
    down=[name for name,info in providers.items() if info["status"]=="down"]
    if down:
        print("Providers down: "+", ".join(down),file=sys.stderr)
        return 1
    return 0


if __name__=="__main__":
    raise SystemExit(main())


