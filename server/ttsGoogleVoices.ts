/** The Google Cloud voices of the Studio's TTS menu (no Node dependencies: shared with the Cloudflare Worker). */

export interface GoogleVoice {
  id: string
  label: string
  en: string
  gender: 'female' | 'male'
  /** Google voice name, e.g. cmn-TW-Wavenet-A. */
  voiceName: string
  /** Menu language (zh-TW groups first). */
  lang: string
  /** Google language code, e.g. cmn-TW. */
  languageCode: string
  /** Chirp 3 HD voices take no pitch. */
  pitch?: false
}

const v = (voiceName: string, label: string, gender: GoogleVoice['gender'], lang: string, extra: Partial<GoogleVoice> = {}): GoogleVoice => ({
  id: `google-${voiceName}`,
  label,
  en: voiceName,
  gender,
  voiceName,
  lang,
  languageCode: voiceName.split('-').slice(0, 2).join('-'),
  ...extra,
})

export const GOOGLE_VOICES: GoogleVoice[] = [
  v('cmn-TW-Wavenet-A', '台灣女聲 A（WaveNet）', 'female', 'zh-TW'),
  v('cmn-TW-Wavenet-B', '台灣男聲 B（WaveNet）', 'male', 'zh-TW'),
  v('cmn-TW-Wavenet-C', '台灣男聲 C（WaveNet）', 'male', 'zh-TW'),
  v('cmn-TW-Standard-A', '台灣女聲 A（標準）', 'female', 'zh-TW'),
  v('cmn-TW-Standard-B', '台灣男聲 B（標準）', 'male', 'zh-TW'),
  v('cmn-TW-Standard-C', '台灣男聲 C（標準）', 'male', 'zh-TW'),
  v('en-US-Neural2-F', 'US Female F（Neural2）', 'female', 'en-US'),
  v('en-US-Neural2-H', 'US Female H（Neural2）', 'female', 'en-US'),
  v('en-US-Neural2-D', 'US Male D（Neural2）', 'male', 'en-US'),
  v('en-US-Neural2-J', 'US Male J（Neural2）', 'male', 'en-US'),
  v('en-GB-Neural2-A', 'UK Female A（Neural2）', 'female', 'en-GB'),
  v('en-GB-Neural2-B', 'UK Male B（Neural2）', 'male', 'en-GB'),
  v('ja-JP-Neural2-B', '日語女聲 B（Neural2）', 'female', 'ja-JP'),
  v('ja-JP-Neural2-C', '日語男聲 C（Neural2）', 'male', 'ja-JP'),
  v('ko-KR-Neural2-A', '韓語女聲 A（Neural2）', 'female', 'ko-KR'),
  v('ko-KR-Neural2-C', '韓語男聲 C（Neural2）', 'male', 'ko-KR'),
  // Chirp 3 HD Mandarin; descriptions are Google's own for each voice.
  v('cmn-CN-Chirp3-HD-Aoede', '女聲 Aoede・輕快（Chirp 3 HD）', 'female', 'zh-CN', { pitch: false }),
  v('cmn-CN-Chirp3-HD-Kore', '女聲 Kore・沉穩（Chirp 3 HD）', 'female', 'zh-CN', { pitch: false }),
  v('cmn-CN-Chirp3-HD-Leda', '女聲 Leda・年輕（Chirp 3 HD）', 'female', 'zh-CN', { pitch: false }),
  v('cmn-CN-Chirp3-HD-Zephyr', '女聲 Zephyr・明亮（Chirp 3 HD）', 'female', 'zh-CN', { pitch: false }),
  v('cmn-CN-Chirp3-HD-Charon', '男聲 Charon・知性（Chirp 3 HD）', 'male', 'zh-CN', { pitch: false }),
  v('cmn-CN-Chirp3-HD-Puck', '男聲 Puck・活潑（Chirp 3 HD）', 'male', 'zh-CN', { pitch: false }),
  v('cmn-CN-Chirp3-HD-Orus', '男聲 Orus・堅定（Chirp 3 HD）', 'male', 'zh-CN', { pitch: false }),
  v('cmn-CN-Chirp3-HD-Fenrir', '男聲 Fenrir・熱情（Chirp 3 HD）', 'male', 'zh-CN', { pitch: false }),
]
export const GOOGLE_DEFAULT_VOICE = 'google-cmn-TW-Wavenet-A'
