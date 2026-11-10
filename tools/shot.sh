#!/bin/sh
# Save the Kindle's screen as a PNG. Usage: tools/shot.sh out.png
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$ROOT/private/config/tools.env" ] && . "$ROOT/private/config/tools.env"
KINDLE="${KINDLE:?Set KINDLE to the Kindle IP address, or put KINDLE=... in private/config/tools.env}"
OUT="${1:-shot.png}"
ssh -o BatchMode=yes -p 2223 root@$KINDLE 'dd if=/dev/fb0 bs=1088 count=1448 2>/dev/null' > ${TMPDIR:-/tmp}/nightstand-fb.raw
uv run -q --with pillow python -I -c "
import sys
from PIL import Image
raw=open('${TMPDIR:-/tmp}/nightstand-fb.raw','rb').read()
Image.frombytes('L',(1088,1448),raw).crop((0,0,1072,1448)).save(sys.argv[1])" "$OUT"
echo "saved $OUT"
