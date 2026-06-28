"""Generate PNG icons for the Chrome extension."""
import struct
import zlib
import os

def make_png(size, bg=(30, 40, 70), fg=(79, 142, 247)):
    """Create a minimal PNG icon with a document shape."""
    w = h = size
    scale = size / 16

    def px(x, y):
        """Return True if pixel (x,y) should be foreground (icon) color."""
        # Normalize to 16x16 grid
        nx, ny = x / scale, y / scale
        # Document outline: 3,1 to 13,15 with folded corner at 10,1-13,4
        in_doc = (3 <= nx < 13 and 1 <= ny < 15)
        fold = (10 <= nx < 13 and 1 <= ny < 4)
        if fold:
            # folded corner triangle
            return (nx - 10) + (ny - 1) < 3
        if in_doc and not fold:
            # Text lines inside doc
            lines = [(5, 6, 11), (5, 8, 11), (5, 10, 9)]
            for lx1, ly, lx2 in lines:
                if lx1 <= nx < lx2 and ly <= ny < ly + 1.2:
                    return True
            return True
        return False

    rows = []
    for y in range(h):
        row = [0]  # filter byte
        for x in range(w):
            if px(x, y):
                row.extend([fg[0], fg[1], fg[2], 255])
            else:
                row.extend([bg[0], bg[1], bg[2], 255])
        rows.append(bytes(row))

    raw = b"".join(rows)
    compressed = zlib.compress(raw, 9)

    def chunk(name, data):
        c = name + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    ihdr_data = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", ihdr_data)
    png += chunk(b"IDAT", compressed)
    png += chunk(b"IEND", b"")
    return png


icons_dir = os.path.join(os.path.dirname(__file__), "icons")
os.makedirs(icons_dir, exist_ok=True)

for size in (16, 48, 128):
    path = os.path.join(icons_dir, f"icon{size}.png")
    with open(path, "wb") as f:
        f.write(make_png(size))
    print(f"Created {path}")
