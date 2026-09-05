# Video Production SOP

Standing procedure for Mint Concrete Polishing social videos. Follow this order
every time unless told otherwise.

## Pipeline

Six steps, in this order. Do not run ahead.

1. **Script.** Draft the script and agree it before anything else happens.
   Nothing gets generated until the script is signed off.
2. **Motion graphic plan.** Map graphics to the approved script — **one every
   3–5 seconds**. Present the list with exact on-screen copy and get it approved.
3. **B-roll.** Client uploads the clips for that video.
4. **Voiceover.** ElevenLabs, Danny Carpenter.
5. **Motion graphics.** Malloy — each graphic paired with its own sound effect.
6. **Assembly.** Composite B-roll + graphics + VO + SFX locally with ffmpeg.

## Hard rules

- **No captions.** No burned-in subtitles, ever. The graphics carry the text.
- **Every motion graphic gets a sound effect**, timed to its animation hit.
- **A graphic every 3–5 seconds** — that is the density target, not a maximum.
- Source footage audio is always stripped. The only audio is VO, SFX and music.

## Standing settings

| | |
|---|---|
| Graphics | 1:1, 1080×1080, Malloy `rubber_duck` |
| Delivery | 1080×1920 (9:16), 30fps, H.264 + AAC |
| Voice | Danny Carpenter — `5ji3QK3BxDdMAWeyMuXm` (professional) |
| Voice fallback | Danny Carpenter Fast — `Roc6FmOMR9dOXb5WPjCP` |
| Loudness | −14 LUFS integrated, peak ≤ −1 dBTP |
| Brand accents | mint `#82CDA6`, gold `#C6963B`, red `#A8191D` |

A ~30s video at 3–5s density means **6–10 graphics**, so budget 6–10 Malloy
prompt credits plus the same number of exports per video.

## Technical playbook

Hard-won details. Don't rediscover these.

**Environment**
- ffmpeg is not installed. `pip3 install imageio-ffmpeg`, then copy the binary
  to `/usr/local/bin/ffmpeg`.
- That build has **no libass and no drawtext** — ffmpeg cannot render text.
  (Irrelevant while captions are off; render PNGs with Pillow if ever needed.)
- Don't hand ffmpeg many looped image inputs — it gets OOM-killed. Use
  single-frame inputs with `eof_action=repeat`.

**Malloy**
- The "transparent" WebM export has **no alpha channel** — it renders the
  background solid black. To get real alpha: `colorlevels` black-point lift →
  `colorkey=0x000000` → `libvpx-vp9 -pix_fmt yuva420p`.
- Verify alpha by compositing over a solid color with `-c:v libvpx-vp9` on the
  input; the native vp9 decoder ignores the alpha track and will mislead you.
- Logo/outro templates render a sheen over the removed background — lift the
  black point to `0.28`–`0.30`. Other templates need only `0.06`.
- Templates persist on the account and re-export without spending prompt credits.
  Text edits inside the Malloy preview are free; only re-export costs.

**Compositing**
- `blend=all_mode=screen` **must** run in RGB (`format=gbrp`). In YUV it
  corrupts the chroma planes and the whole frame goes magenta.
- Grade footage luma × `0.62` before overlaying light type, or the text washes
  out over bright concrete.
- Place 1:1 graphics centred in the 9:16 frame (`pad=1080:1920:0:420`).
- Cut between B-roll shots in the *gaps* between graphics, never under a reveal.
- Give each beat its own shot; don't let one clip run under two consecutive beats.

**Sync**
- Get VO phrase boundaries with `silencedetect=noise=-32dB:d=0.18`, then map the
  script lines onto them. ElevenLabs Scribe returns plain text with **no word
  timings**, so don't rely on it for timing.
- Find each graphic's animation hit by frame-difference peak detection, and place
  its sound effect there.
- Lead each graphic ~0.2s before its line and hold ~0.2s after.

**Audio**
- Sidechain-compress the music against the VO so it ducks under speech.
- ElevenLabs VO comes out quiet (−28 to −36 LUFS). Use `dynaudnorm` + `alimiter`;
  plain gain hits the true-peak ceiling before reaching target loudness.
- SFX sitting under the VO need to be loud enough to feel. Broadband RMS is a
  poor check — verify the SFX bus in isolation instead.
- Never end on dead air; fill the logo hold with a resolve swell.

**ElevenLabs**
- `estimate_only` does **not** validate whether a voice is fine-tuned. A voice
  can pass the estimate and still fail at generation.

## Per-video checklist

- [ ] Script approved
- [ ] Graphic plan approved (one every 3–5s, copy confirmed)
- [ ] B-roll received
- [ ] VO generated and levels checked
- [ ] Graphics generated, one SFX each
- [ ] Assembled: no captions, footage audio stripped, distinct shot per beat
- [ ] −14 LUFS, peak ≤ −1 dBTP, no dead air at the end
