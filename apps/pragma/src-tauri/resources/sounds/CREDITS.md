# Bundled agent alert clips

These clips are copied into `~/.pragma/assets/sounds` the first time Pragma starts
without that directory, so a fresh install has alert sounds to choose from. Deleting a
clip there is permanent — seeding only runs when the directory is missing.

Source: [akx/Notifications](https://github.com/akx/Notifications), dual-licensed
CC BY 3.0 / CC0 1.0. Pragma takes them under **CC0 1.0** (public domain), so no
attribution is required; this file records the provenance anyway.

Each clip was trimmed of leading/trailing silence and loudness-normalised to
`I=-18 LUFS, TP=-1.5 dBTP`, then encoded as 16-bit 44.1 kHz mono PCM WAV. WAV rather
than Ogg because `AudioContext.decodeAudioData` — the playback path in
`src/lib/agent-alert.ts` — has no Ogg Vorbis support in WKWebView.
