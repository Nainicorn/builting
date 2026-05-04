#!/usr/bin/env python3
"""Subprocess validator for the contract round-trip runner.

Reads a JSON payload on stdin, validates it against the named contract,
and writes a JSON verdict to stdout:

  {"ok": true}                            on success
  {"ok": false, "errors": [...]}          on failure

The runner (run-roundtrip.mjs) calls this once per fixture. Adding a new
contract = adding one entry to the CONTRACTS dict below + the matching
Pydantic model.
"""
from __future__ import annotations

import argparse
import json
import sys

from builting_contracts import (
    ClaimsContract,
    CssRawContract,
    CanonicalContract,
    ValidatedCssContract,
    IfcContract,
)
from pydantic import ValidationError

CONTRACTS = {
    "claims": ClaimsContract,
    "css_raw": CssRawContract,
    "canonical": CanonicalContract,
    "validated_css": ValidatedCssContract,
    "ifc": IfcContract,
}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--contract", required=True, help="contract name (e.g. 'claims')")
    args = parser.parse_args()

    contract_cls = CONTRACTS.get(args.contract)
    if contract_cls is None:
        json.dump(
            {"ok": False, "errors": [{"path": [], "message": f"unknown contract: {args.contract}"}]},
            sys.stdout,
        )
        return 2

    try:
        payload_text = sys.stdin.read()
        payload = json.loads(payload_text)
    except json.JSONDecodeError as e:
        json.dump(
            {"ok": False, "errors": [{"path": [], "message": f"invalid JSON on stdin: {e}"}]},
            sys.stdout,
        )
        return 2

    try:
        contract_cls.model_validate(payload)
    except ValidationError as e:
        errors = [
            {
                "path": list(err.get("loc", [])),
                "message": err.get("msg", ""),
                "type": err.get("type", ""),
            }
            for err in e.errors()
        ]
        json.dump({"ok": False, "errors": errors}, sys.stdout)
        return 0  # validation failure is normal output, not a script error

    json.dump({"ok": True}, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
