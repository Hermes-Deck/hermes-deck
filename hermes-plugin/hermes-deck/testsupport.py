"""Shared bits for this folder's tests (not part of the installed plugin)."""
import subprocess
import sys
from pathlib import Path


def run_others(argv) -> int:
    """`python hermes-plugin/hermes-deck/test_*.py` hands the other test files to the first one as arguments:
    run each of them too, so the shell glob checks every file. Returns 0 when all of them passed."""
    rc = 0
    for arg in argv[1:]:
        p = Path(arg)
        if p.name.startswith("test_") and p.suffix == ".py" and p.is_file():
            print(f"\n== {p.name}", flush=True)
            rc |= subprocess.run([sys.executable, str(p)]).returncode
    return rc


def unittest_main() -> None:
    """unittest.main for this file's tests (extra arguments are other test files, not test names)."""
    import unittest
    result = unittest.main(module="__main__", argv=sys.argv[:1], exit=False).result
    sys.exit(0 if result.wasSuccessful() and run_others(sys.argv) == 0 else 1)
