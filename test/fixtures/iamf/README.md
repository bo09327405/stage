Conformance test vectors from the AOMedia libiamf repository (https://github.com/AOMediaCodec/libiamf, `tests/`), kept
small as a regression test for the IAMF decoder (`test/iamfDecoder.test.mjs`). Licence: BSD 3-Clause Clear +
AOM Patent License 1.0 (see `public/iamf/LICENSES.txt`).

* `test_000002` — stereo, LPCM, 16 kHz, 0.5 s sine; `_s.mp4` is the same stream in an MP4; the `.wav` is the AOM reference render (stereo loudspeakers).
* `test_000021` — stereo, Opus, 48 kHz.
* `test_000083` — first-order ambisonics, LPCM.
* `test_000850` — two audio elements; the mix presentation uses an element gain offset of the VALUE type (no adjustable range).
