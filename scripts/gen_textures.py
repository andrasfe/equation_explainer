#!/usr/bin/env python3
"""Generate the blackboard textures (pure stdlib, deterministic).

grain.png  - alpha mask that gives chalk strokes a dusty, broken look
slate.png  - faint speckle that sits on top of the board colour
"""
import random, struct, zlib, os, math

def write_png(path, w, h, rows, channels):
    color_type = {1: 0, 2: 4, 4: 6}[channels]
    raw = b"".join(b"\x00" + bytes(r) for r in rows)
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, color_type, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)

out = os.path.join(os.path.dirname(__file__), "..", "shared", "web", "img")
rnd = random.Random(7)

# Chalk grain: mostly opaque, with speckled gaps (grey+alpha).
W = H = 160
rows = []
for y in range(H):
    row = []
    for x in range(W):
        r = rnd.random()
        a = 255 if r > 0.22 else (200 if r > 0.08 else (120 if r > 0.02 else 40))
        row += [255, a]
    rows.append(row)
write_png(os.path.join(out, "grain.png"), W, H, rows, 2)

# Slate speckle: white dots at very low alpha + faint horizontal eraser streaks.
W = H = 256
rows = []
streaks = [(rnd.randrange(H), rnd.uniform(0.3, 1.0)) for _ in range(9)]
for y in range(H):
    row = []
    s = sum(max(0.0, 1 - abs(y - sy) / 6) * k for sy, k in streaks)
    for x in range(W):
        a = int(rnd.random() ** 6 * 26 + s * 5 * (0.6 + 0.4 * math.sin(x / 9.0 + y)))
        row += [255, 255, 255, max(0, min(255, a))]
    rows.append(row)
write_png(os.path.join(out, "slate.png"), W, H, rows, 4)
print("textures written to", os.path.abspath(out))
