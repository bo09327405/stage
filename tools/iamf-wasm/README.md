# IAMF (Eclipsa Audio) decoder for the browser

`public/iamf/iamf.wasm` is the AOMedia IAMF reference decoder (libiamf) with its binaural renderer, compiled to
WebAssembly. `iamf_web.c` is the thin C layer the app calls; `build.sh` rebuilds the module from the official sources.
The TypeScript side lives in `src/studio/iamf/`.

* Output is binaural stereo (the app always renders for headphones).
* **Codecs: Opus and PCM (`ipcm`).** AAC and FLAC streams are not supported (they were left out on purpose; they would
  add fdk-aac and FLAC to the build).
* Tested against the AOM conformance vectors (libiamf `tests/`): every Opus / PCM stream decodes, PCM output matches the
  reference renders bit for bit (≥ 77 dB PSNR where the mix changes the level), Opus output is within ±0.2 dB of the
  reference level with the same dominant tone. `test/iamfDecoder.test.mjs` keeps a few of those vectors as a regression test.
* Element gain trims work only for elements whose mix presentation gives a gain range (IAMF `element_gain_offset_config` type
  RANGE); libiamf rejects them otherwise.

Licences: see `public/iamf/LICENSES.txt` (BSD-3-Clear + AOM patent grant, BSD-3 Opus, Apache-2.0 Abseil).
