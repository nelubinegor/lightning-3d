# Lightning clips in space

A WebGL2 particle field. Every particle is one of the 91 lightning clips in
`assets/`, drawn as a camera-facing billboard at its own native pixel
dimensions and aspect ratio — nothing is cropped, stretched or squared off.
The particles ride tilted elliptical orbits around the centre of the field.

## Running it

It has to be served over http. Video frames read from a `file://` page taint
the WebGL texture and the manifest fetch is blocked, so opening `index.html`
directly will only show you a message telling you this.

Double-click `serve.command`, or:

```bash
cd "lightning clips in space" && python3 -m http.server 8123
```

then open <http://localhost:8123>.

## Controls

| | |
|---|---|
| hover | reveal that clip's centre mark |
| click | centre that clip (click it again, or empty space, to release) |
| drag | orbit the camera |
| scroll | dolly in/out (in True px mode: open the field out) |
| `esc` | release the focused clip |
| `h` | show/hide the panel |
| `space` | freeze the orbits |
| `d` | light/dark theme |

**Clips** how many of the 91 are in the field ·
**Live decode** how many may play at once ·
**Playback** video speed: `.25× / .5× / .75× / 1×` ·
**Scale** clip size multiplier, `1.00` = native pixels ·
**Spread** radius of the cloud ·
**Orbit speed**, **Flatten** (spherical ↔ flat disc), **Depth haze**.

Playback speed and **Orbit speed** are independent: the first slows the
lightning inside each clip, the second slows the clips' travel through the
field. `playbackRate` lives on the video element and survives the decoder
budget pausing and resuming a clip, so it is set once per change rather than
re-applied on every play.

**All marks** puts an ambient crosshair on every clip at once · **Drift** slow
auto-rotation · **Reseed** re-rolls the orbit layout · **True px** see below ·
**Dark** see below.

## Hover and focus

Centre marks are off by default; hovering a clip reveals its own, larger and
brighter than the ambient ones. **All marks** brings back a crosshair on every
clip, and the hovered one still stands out against them.

Clicking a clip swings the camera onto the ray running through it. The camera
always looks at the origin, so aiming the eye along that ray puts the clip dead
centre and directly in front — and because the clip keeps orbiting, the aim is
recomputed every frame, so the rest of the field wheels around the one you
picked. Click it again, click empty space, `esc`, or start dragging to release.

Two details worth knowing:

- **Hit testing is analytic, not a picking buffer.** Billboards face the
  camera, so a clip's on-screen footprint is exactly its world size times
  `FOCAL/depth` (times 1 under orthographic). Undo the roll around the centre
  and the test is a plain rectangle check; nearest depth wins. Clips already
  faded out by the near dissolve are excluded, so you cannot pick something you
  cannot see.
- **A press only becomes a drag after 4 px.** Below that it stays a click, so
  picking a clip and swinging the camera share the same mouse button without
  fighting each other.

If the focused clip's orbit would carry it inside the near dissolve, the camera
backs off to `1.5 × radius` — otherwise centring a clip could fade out the very
thing you just asked to look at.

## Theme

Starts on the OS setting and keeps following it until you press the button or
`d`; after that your choice is remembered in `localStorage`. An inline script
in `<head>` resolves the theme before first paint so dark-mode visitors never
get a flash of the light field.

The theme is not only page chrome — the canvas clear colour and the depth-haze
colour move with it, so distant clips wash toward whichever background is
active. The two are worth seeing as different pieces rather than one piece
with a skin:

- **Light** — the clips read as discrete black rectangles against grey, which
  is what makes the field legible as a collage of frames.
- **Dark** — night footage on near-black loses its edges, so the rectangles
  dissolve and what you mostly see is the lightning itself firing in the void.
  The crosshairs carry the structure instead, and they are dialled back
  (alpha 0.5 vs 0.85) because white marks on black are much louder.

`--bg` in the stylesheet and `THEMES[…].bg` in `main.js` are the same colour
written twice — change one and change the other, or the page and the canvas
show a seam.

## Two ways of being "original size"

**Perspective** (default) — clips keep their exact native aspect ratio and
their native size *relative to each other*, then perspective scales them by
depth. A clip sitting at the focal plane (1800 px) measures exactly its own
width and height; nearer ones are larger, further ones smaller. This is the
mode that gives the field depth.

**True px** — orthographic. Every clip measures exactly its native pixel
dimensions no matter how far away it is. Depth stops reading as scale and
reads as overlap and parallax instead. 91 clips at true size need a lot of
room, so this mode opens the field out; scroll to spread it further.

## How it holds up

- One draw call per clip, depth-tested opaque quads, so no sorting is needed.
- Textures upload only when the decoder presents a new frame
  (`requestVideoFrameCallback`), not once per animation frame.
- Off-screen clips are culled and skip their texture upload entirely.
- **Decoder budget** — 91 simultaneous video decoders is more than most
  machines will hand out, so only the largest clips currently on screen keep
  playing (48 by default). The rest hold their last frame, which just reads as
  a still in the field. Clips that have never shown anything get nudged into
  decoding a single frame by a seek, which does not hold a decoder open.
- Mipmaps are regenerated only while a clip is minified.
- Clips sweeping close past the lens dissolve into the background and stop
  writing depth, rather than slamming the whole screen.

## Files

- `index.html` — page, panel, styles
- `main.js` — renderer, orbits, decoder scheduler
- `clips.json` — manifest: path, native width/height, duration per clip
- `assets/` — the 91 clips

`clips.json` is generated from the assets, so regenerate it if clips are added
or removed. On macOS, from this folder:

```bash
python3 -c "
import subprocess, os, json
out=[]
for f in sorted(x for x in os.listdir('assets') if x.lower().endswith('.mp4')):
    r=subprocess.run(['mdls','-name','kMDItemPixelWidth','-name','kMDItemPixelHeight','-name','kMDItemDurationSeconds','assets/'+f],capture_output=True,text=True).stdout
    d=dict(l.split('=',1) for l in r.splitlines() if '=' in l)
    d={k.strip():v.strip() for k,v in d.items()}
    try: out.append({'src':'assets/'+f,'w':int(d['kMDItemPixelWidth']),'h':int(d['kMDItemPixelHeight']),'dur':round(float(d['kMDItemDurationSeconds']),3)})
    except Exception: print('skipped',f)
json.dump(out,open('clips.json','w'),indent=0); print(len(out),'clips')
"
```
