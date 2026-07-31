#!/usr/bin/env python3
# writeb64.py <dest_path>  — reads base64 from stdin, writes decoded bytes to dest.
import sys, base64, os
dest = sys.argv[1]
os.makedirs(os.path.dirname(dest), exist_ok=True)
data = sys.stdin.buffer.read()
# strip whitespace/newlines that may have slipped in
data = b"".join(data.split())
raw = base64.b64decode(data)
with open(dest, "wb") as f:
    f.write(raw)
print(f"wrote {len(raw)} bytes -> {dest}")
