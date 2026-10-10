"""Executes one board cell in a fresh process.

usage: python runner.py <cell.py> <out_dir>

* stdout/stderr stream straight through (captured by the app)
* tracebacks are trimmed to frames from the cell itself
* any open matplotlib figures are saved as PNGs into out_dir afterwards
"""
import os
import sys
import traceback

cell_path, out_dir = sys.argv[1], sys.argv[2]
os.environ.setdefault("MPLBACKEND", "Agg")

with open(cell_path, encoding="utf-8") as fh:
    source = fh.read()

namespace = {"__name__": "__main__", "__file__": "<cell>"}
status = 0
try:
    exec(compile(source, "<cell>", "exec"), namespace)
except SystemExit as exc:  # allow sys.exit() in cells
    status = exc.code if isinstance(exc.code, int) else 0
except BaseException as exc:  # noqa: BLE001 - we report everything to the board
    tb = exc.__traceback__
    # drop the runner's own frame so the trace starts at the cell
    while tb is not None and tb.tb_frame.f_code.co_filename != "<cell>":
        tb = tb.tb_next
    lines = traceback.format_exception(type(exc), exc, tb)
    src_lines = source.splitlines()
    out = []
    for line in lines:
        out.append(line)
        # traceback can't show <cell> source lines; add them ourselves
        if line.strip().startswith('File "<cell>", line '):
            try:
                n = int(line.split("line ")[1].split(",")[0])
                out.append("    " + src_lines[n - 1].strip() + "\n")
            except (ValueError, IndexError):
                pass
    sys.stderr.write("".join(out))
    status = 1
finally:
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is not None:
        for i, num in enumerate(plt.get_fignums()):
            try:
                plt.figure(num).savefig(
                    os.path.join(out_dir, f"fig{i:02d}.png"), dpi=120, bbox_inches="tight"
                )
            except Exception as exc:  # noqa: BLE001
                sys.stderr.write(f"[could not save figure {num}: {exc}]\n")
    sys.stdout.flush()
    sys.stderr.flush()

sys.exit(status)
