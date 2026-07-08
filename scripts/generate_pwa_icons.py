"""Generate PWA install icons from the existing favicon.png source artwork."""
from PIL import Image
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'favicon.png')
OUT = os.path.join(ROOT, 'icons')
os.makedirs(OUT, exist_ok=True)

BG = (12, 13, 15, 255)  # #0c0d0f - index.html (start_url) dashboard background

src = Image.open(SRC).convert('RGBA')
print('source size:', src.size)

def resized(size):
    return src.resize((size, size), Image.LANCZOS)

# Plain icons (purpose "any") - straight resize of the source artwork
resized(192).save(os.path.join(OUT, 'icon-192.png'))
resized(512).save(os.path.join(OUT, 'icon-512.png'))

# Maskable 512x512: artwork centered at ~72% scale on a solid bg canvas
# (~14% padding on each side so Android's circle/squircle mask doesn't clip it)
canvas_size = 512
art_size = round(canvas_size * 0.72)
canvas = Image.new('RGBA', (canvas_size, canvas_size), BG)
art = src.resize((art_size, art_size), Image.LANCZOS)
offset = ((canvas_size - art_size) // 2, (canvas_size - art_size) // 2)
canvas.alpha_composite(art, offset)
canvas.convert('RGB').save(os.path.join(OUT, 'icon-512-maskable.png'))

# apple-touch-icon 180x180: iOS renders transparency as black, so flatten
# onto the background color.
apple_size = 180
apple_canvas = Image.new('RGBA', (apple_size, apple_size), BG)
apple_art = src.resize((apple_size, apple_size), Image.LANCZOS)
apple_canvas.alpha_composite(apple_art)
apple_canvas.convert('RGB').save(os.path.join(OUT, 'apple-touch-icon.png'))

print('done')
for f in ['icon-192.png', 'icon-512.png', 'icon-512-maskable.png', 'apple-touch-icon.png']:
    p = os.path.join(OUT, f)
    im = Image.open(p)
    print(f, im.size, im.mode, os.path.getsize(p), 'bytes')
