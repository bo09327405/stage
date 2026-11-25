/*
 * A small C layer over libiamf (AOMedia IAMF reference decoder) for the browser: binaural output only, one decoder
 * per handle, plain integers and pointers so it can be called from JavaScript without Emscripten's runtime
 * (the module is built STANDALONE_WASM and loaded by src/studio/iamf/iamfWasm.ts).
 *
 * Call order: iw_open → (iw_set_mix) → iw_configure(descriptor OBUs) → (iw_set_gain…) → iw_decode per temporal unit
 * (then once more with no data to flush) → iw_close. Samples come back interleaved L,R in iw_pcm().
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "IAMF_decoder.h"

typedef struct {
  IAMF_DecoderHandle dec;
  uint32_t bit_depth;
  uint32_t rate;
  uint32_t channels;
  uint32_t max_frame;
  void *pcm;
} iw_t;

#define EXPORT __attribute__((used, visibility("default")))

/* sound_system < 0: binaural (what the app uses). Otherwise a loudspeaker layout (0 = A, stereo): only for conformance tests.
   rate 0 = the stream's own rate. */
EXPORT iw_t *iw_open(uint32_t rate, uint32_t bit_depth, int32_t sound_system) {
  iw_t *w = (iw_t *)calloc(1, sizeof(iw_t));
  if (!w) return NULL;
  w->dec = IAMF_decoder_open();
  if (!w->dec) {
    free(w);
    return NULL;
  }
  w->rate = rate;
  w->bit_depth = bit_depth ? bit_depth : 32;
  int ok = IAMF_decoder_set_bit_depth(w->dec, w->bit_depth) == IAMF_OK;
  if (rate) ok = ok && IAMF_decoder_set_sampling_rate(w->dec, rate) == IAMF_OK;
  ok = ok && (sound_system < 0 ? IAMF_decoder_output_layout_set_binaural(w->dec) : IAMF_decoder_output_layout_set_sound_system(w->dec, (IAMF_SoundSystem)sound_system)) == IAMF_OK;
  if (!ok) {
    IAMF_decoder_close(w->dec);
    free(w);
    return NULL;
  }
  w->channels = (uint32_t)(sound_system < 0 ? IAMF_layout_binaural_channels_count() : IAMF_layout_sound_system_channels_count((IAMF_SoundSystem)sound_system));
  return w;
}

EXPORT void iw_close(iw_t *w) {
  if (!w) return;
  if (w->dec) IAMF_decoder_close(w->dec);
  free(w->pcm);
  free(w);
}

/* Choose the mix presentation before configuring (the first one is used when this is not called). */
EXPORT int iw_set_mix(iw_t *w, uint32_t id) { return IAMF_decoder_set_mix_presentation_id(w->dec, id); }

/* Feed the descriptor OBUs (sequence header … mix presentations). *rsize gets the bytes consumed. */
EXPORT int iw_configure(iw_t *w, const uint8_t *data, uint32_t size, uint32_t *rsize) {
  int ret = IAMF_decoder_configure(w->dec, data, size, rsize);
  if (ret == IAMF_OK) {
    IAMF_StreamInfo *info = IAMF_decoder_get_stream_info(w->dec);
    if (!info) return IAMF_ERR_INTERNAL;
    w->max_frame = info->max_frame_size;
    IAMF_decoder_free_stream_info(info);
    free(w->pcm);
    w->pcm = malloc((size_t)(w->bit_depth / 8) * w->max_frame * w->channels);
    if (!w->pcm) return IAMF_ERR_ALLOC_FAIL;
  }
  return ret;
}

/* Extra gain for one audio element of the chosen mix, dB. */
EXPORT int iw_set_gain(iw_t *w, uint32_t element_id, float db) { return IAMF_decoder_set_audio_element_gain_offset(w->dec, element_id, db); }

EXPORT int iw_head_tracking(iw_t *w, int enable) { return IAMF_decoder_enable_head_tracking(w->dec, enable ? 1 : 0); }
EXPORT int iw_head_rotation(iw_t *w, float qw, float qx, float qy, float qz) { return IAMF_decoder_set_head_rotation(w->dec, qw, qx, qy, qz); }

/* Decode one chunk (a temporal unit or any run of audio OBUs). Returns samples per channel produced (0 = need more),
   or a negative libiamf error. data == NULL flushes. *rsize gets the bytes consumed. */
EXPORT int iw_decode(iw_t *w, const uint8_t *data, int32_t size, uint32_t *rsize) {
  if (!w->pcm) return IAMF_ERR_INVALID_STATE;
  return IAMF_decoder_decode(w->dec, data, size, rsize, w->pcm);
}

EXPORT void *iw_pcm(iw_t *w) { return w->pcm; }
EXPORT uint32_t iw_max_frame(iw_t *w) { return w->max_frame; }
EXPORT uint32_t iw_channels(iw_t *w) { return w->channels; }
EXPORT uint32_t iw_bit_depth(iw_t *w) { return w->bit_depth; }

EXPORT void *iw_alloc(uint32_t n) { return malloc(n); }
EXPORT void iw_free(void *p) { free(p); }

/* ---- stream info as JSON (a malloc'd string: free it with iw_free) ---- */

typedef struct {
  char *p;
  size_t n, cap;
} sb_t;

static void sb_put(sb_t *s, const char *fmt, ...) __attribute__((format(printf, 2, 3)));
#include <stdarg.h>
static void sb_put(sb_t *s, const char *fmt, ...) {
  va_list ap;
  for (;;) {
    va_start(ap, fmt);
    int k = vsnprintf(s->p + s->n, s->cap - s->n, fmt, ap);
    va_end(ap);
    if (k >= 0 && (size_t)k < s->cap - s->n) {
      s->n += (size_t)k;
      return;
    }
    s->cap = s->cap ? s->cap * 2 : 1024;
    s->p = (char *)realloc(s->p, s->cap);
  }
}

EXPORT char *iw_info(iw_t *w) {
  IAMF_StreamInfo *info = IAMF_decoder_get_stream_info(w->dec);
  if (!info) return NULL;
  iamf_stream_info_t *si = info;
  sb_t s = {0};
  sb_put(&s, "{\"maxFrame\":%u,\"primary\":%d,\"additional\":%d,\"rate\":%d,\"samplesPerFrame\":%u,\"mixId\":%lld,\"elements\":[", info->max_frame_size,
         (int)si->iamf_stream_info.primary_profile, (int)si->iamf_stream_info.additional_profile, (int)si->iamf_stream_info.sampling_rate,
         si->iamf_stream_info.samples_per_channel_in_frame, (long long)IAMF_decoder_get_mix_presentation_id(w->dec));
  for (uint32_t i = 0; i < si->iamf_stream_info.audio_element_count; i++) {
    iamf_audio_element_info_t *e = &si->iamf_stream_info.audio_elements[i];
    sb_put(&s, "%s{\"id\":%u,\"codec\":%d,\"type\":%d,\"layout\":%d,\"channels\":%u}", i ? "," : "", e->element_id, (int)e->codec_id, (int)e->element_type,
           (int)e->channel_layout, e->num_channels);
  }
  sb_put(&s, "],\"mixes\":[");
  for (uint32_t i = 0; i < si->iamf_stream_info.mix_presentation_count; i++) {
    iamf_mix_presentation_info_t *m = &si->iamf_stream_info.mix_presentations[i];
    sb_put(&s, "%s{\"id\":%u,\"elements\":[", i ? "," : "", m->id);
    for (uint32_t j = 0; j < m->num_audio_elements; j++) {
      iamf_element_presentation_info_t *e = &m->elements[j];
      sb_put(&s, "%s{\"id\":%u,\"mode\":%d,\"profile\":%d", j ? "," : "", e->eid, (int)e->mode, (int)e->profile);
      if (e->gain_offset_range) sb_put(&s, ",\"gainMin\":%.3f,\"gainMax\":%.3f", e->gain_offset_range->min, e->gain_offset_range->max);
      sb_put(&s, "}");
    }
    sb_put(&s, "]}");
  }
  sb_put(&s, "]}");
  IAMF_decoder_free_stream_info(info);
  return s.p;
}

EXPORT char *iw_codecs(void) { return IAMF_decoder_get_codec_capability(); }
