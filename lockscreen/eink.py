import sys
from PIL import Image, ImageFilter, ImageOps
src, out = sys.argv[1], sys.argv[2]
W, H = 1072, 1448
im = Image.open(src).convert("RGB")
w, h = im.size
ch = round(w * H / W)          # crop height for the PW4 ratio
top = round((h - ch) * 0.65)   # trim more sky than water
im = im.crop((0, top, w, top + ch)).resize((W, H), Image.LANCZOS)
# red-filter mix: lit orange peaks go bright, blue sky goes mid-gray
r, g, b = im.split()
gray = Image.merge("RGB", (r, g, b)).convert("L", (0.88, 0.12, 0.0, 0))
gray = ImageOps.autocontrast(gray, cutoff=0.2)
# lift midtones a little: e-ink prints darker than an LCD
lut = [round(255 * (i / 255) ** 1.35) for i in range(256)]
gray = gray.point(lut).filter(ImageFilter.UnsharpMask(radius=1.2, percent=60, threshold=2))
# 16 gray levels, Floyd-Steinberg dither (PW4 panel depth)
pal = Image.new("P", (1, 1)); levels = [round(i * 255 / 15) for i in range(16)]
pal.putpalette(sum(([v, v, v] for v in levels), []) + [0] * (768 - 48))
q = gray.convert("RGB").quantize(palette=pal, dither=Image.Dither.FLOYDSTEINBERG).convert("L")
q.save(out, optimize=True)
print(q.size, len(set(q.get_flattened_data())), "levels")
