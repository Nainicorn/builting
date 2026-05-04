#!/usr/bin/env python3
"""
tests/golden/runner.py — Golden test runner for Pset_BuiltingProvenance assertions.

Usage:
  python3 runner.py <fixture-name> <ifc-path>

Loads tests/golden/<fixture-name>/expect.json, analyzes the IFC file, runs every
assertion, and exits 0 on pass / 1 on failure with a full diff.
"""
import sys
import json
import argparse
from pathlib import Path
from collections import Counter

try:
    import ifcopenshell
except ImportError:
    print("ERROR: ifcopenshell not installed. Run: pip3.11 install ifcopenshell", file=sys.stderr)
    sys.exit(2)

SPATIAL_TYPES = {'IfcSite', 'IfcBuilding', 'IfcBuildingStorey', 'IfcProject'}
PSET_NAME = 'Pset_BuiltingProvenance'


def get_pset(product):
    for rel in getattr(product, 'IsDefinedBy', []):
        if rel.is_a('IfcRelDefinesByProperties'):
            pd = rel.RelatingPropertyDefinition
            if hasattr(pd, 'Name') and pd.Name == PSET_NAME:
                return {prop.Name: prop.NominalValue.wrappedValue
                        for prop in (pd.HasProperties or [])}
    return None


def analyze_ifc(ifc_path):
    model = ifcopenshell.open(str(ifc_path))
    products = [p for p in model.by_type('IfcProduct')
                if p.is_a() not in SPATIAL_TYPES]

    items = []
    for p in products:
        pset = get_pset(p)
        items.append({
            'type': p.is_a(),
            'name': p.Name or '',
            'object_type': p.ObjectType or '',
            'pset': pset,
        })

    stamped = [i for i in items if i['pset']]
    total = len(items)
    stamp_count = len(stamped)

    status_counts = Counter(i['pset'].get('SourceFileStatus', '?') for i in stamped)
    type_counts = Counter(i['type'] for i in items)

    # Unique non-sentinel source files observed across stamped elements.
    source_files = sorted({
        i['pset'].get('SourceFile', '')
        for i in stamped
        if i['pset'].get('SourceFile', '') not in ('<unknown>', '<inferred>', '', None)
    })

    return {
        'total_products': total,
        'stamped': stamp_count,
        'unstamped': total - stamp_count,
        'coverage_pct': round(100 * stamp_count / max(total, 1)),
        'status_counts': dict(status_counts),
        'type_counts': dict(type_counts),
        'source_files': source_files,
        'items': items,
    }


def _check(name, actual, op, expected, failures):
    if op == 'gte':
        ok = actual >= expected
    elif op == 'lte':
        ok = actual <= expected
    elif op == 'gt':
        ok = actual > expected
    elif op == 'lt':
        ok = actual < expected
    elif op == 'eq':
        ok = actual == expected
    elif op == 'ne':
        ok = actual != expected
    else:
        failures.append(f'  ✗ {name}: unknown operator "{op}"')
        return
    if not ok:
        failures.append(f'  ✗ {name}: expected {op}({expected!r}), got {actual!r}')


def run_assertions(analysis, expect):
    failures = []

    for a in expect.get('assertions', []):
        name = a['name']
        metric = a['metric']
        op = a.get('op', 'gte')
        value = a.get('value')

        if metric == 'coverage_pct':
            _check(name, analysis['coverage_pct'], op, value, failures)

        elif metric == 'stamped_count':
            _check(name, analysis['stamped'], op, value, failures)

        elif metric == 'total_products':
            _check(name, analysis['total_products'], op, value, failures)

        elif metric == 'status_count':
            count = analysis['status_counts'].get(a['status'], 0)
            _check(name, count, op, value, failures)

        elif metric == 'type_count':
            count = analysis['type_counts'].get(a['ifc_type'], 0)
            _check(name, count, op, value, failures)

        elif metric == 'type_status_count':
            # Count elements of a given IFC type that have a given SourceFileStatus.
            count = sum(
                1 for i in analysis['items']
                if i['type'] == a['ifc_type']
                and (i['pset'] or {}).get('SourceFileStatus') == a['status']
            )
            _check(name, count, op, value, failures)

        elif metric == 'source_file_contains':
            # Count stamped elements whose SourceFileStatus == a['status']
            # AND whose SourceFile contains a['pattern'].
            pattern = a['pattern']
            status = a['status']
            count = sum(
                1 for i in analysis['items']
                if (i['pset'] or {}).get('SourceFileStatus') == status
                and pattern in (i['pset'] or {}).get('SourceFile', '')
            )
            _check(name, count, op, value, failures)

        elif metric == 'no_fabricated_sources':
            # Assert no stamped element has a SourceFile that isn't in the
            # allowed_source_patterns list.  Used to catch fabricated baselines.
            allowed_patterns = a.get('allowed_source_patterns', [])
            sentinel_values = {'<unknown>', '<inferred>', '', None}
            violators = []
            for i in analysis['items']:
                pset = i.get('pset')
                if not pset:
                    continue
                sf = pset.get('SourceFile')
                if sf in sentinel_values:
                    continue
                if any(p in sf for p in allowed_patterns):
                    continue
                violators.append(f'{i["type"]}:{i["name"][:40]} → {sf}')
            if violators:
                failures.append(
                    f'  ✗ {name}: {len(violators)} element(s) reference unexpected source files:'
                )
                for v in violators[:8]:
                    failures.append(f'      {v}')
                if len(violators) > 8:
                    failures.append(f'      ... ({len(violators) - 8} more)')

        elif metric == 'direct_count_eq':
            # Exact count of direct elements (strict regression gate).
            count = analysis['status_counts'].get('direct', 0)
            _check(name, count, op, value, failures)

        else:
            failures.append(f'  ✗ {name}: unknown metric "{metric}"')

    return failures


def main():
    parser = argparse.ArgumentParser(description='Run golden provenance assertions against an IFC file.')
    parser.add_argument('fixture', help='Fixture name (tunnel | building | no-spatial)')
    parser.add_argument('ifc_path', help='Path to the IFC file to analyze')
    args = parser.parse_args()

    fixture_dir = Path(__file__).parent / args.fixture
    expect_path = fixture_dir / 'expect.json'

    if not expect_path.exists():
        print(f'ERROR: {expect_path} not found', file=sys.stderr)
        sys.exit(2)

    ifc_path = Path(args.ifc_path)
    if not ifc_path.exists():
        print(f'ERROR: IFC file not found at {ifc_path}', file=sys.stderr)
        sys.exit(2)

    expect = json.loads(expect_path.read_text())
    print(f'[golden:{args.fixture}] analyzing {ifc_path.name}')

    analysis = analyze_ifc(ifc_path)

    # Print summary.
    print(f'[golden:{args.fixture}] {analysis["stamped"]}/{analysis["total_products"]} stamped '
          f'({analysis["coverage_pct"]}%)')
    print(f'[golden:{args.fixture}] status breakdown: {analysis["status_counts"]}')
    if analysis['source_files']:
        print(f'[golden:{args.fixture}] direct source files: {analysis["source_files"]}')

    failures = run_assertions(analysis, expect)

    assertion_count = len(expect.get('assertions', []))
    if failures:
        print(f'\n[golden:{args.fixture}] FAIL — {len(failures)}/{assertion_count} assertion(s) failed:')
        for f in failures:
            print(f)
        print()
        sys.exit(1)
    else:
        print(f'\n[golden:{args.fixture}] PASS — {assertion_count}/{assertion_count} assertion(s)')
        sys.exit(0)


if __name__ == '__main__':
    main()
