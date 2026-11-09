// Measuring speech-recognition accuracy per language, from the person's own reading of a known sentence. Pure functions (no I/O).
// bookbook never claims a language "works" from vendor tables alone: each language starts as "not tested on this machine" until a check has been run.
export const nfc = (s: string) => s.normalize('NFC');
/** Lower-case, strip punctuation and collapse spaces. Combining marks are kept: in Indic scripts they carry meaning. */
export const normText = (s: string) => nfc(s).toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const lev = <T,>(a: T[], b: T[]): number => { const m = a.length, n = b.length; if (!m) return n; if (!n) return m; let prev = Array.from({ length: n + 1 }, (_, j) => j); for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; } return prev[n]; };
const graphemes = (s: string): string[] => { try { return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].map((x) => x.segment); } catch { return [...s]; } };
/** Character error rate on grapheme clusters (so a conjunct or vowel sign counts as one unit). 0 = perfect; can exceed 1. */
export const cer = (expected: string, got: string): number => { const e = graphemes(normText(expected).replace(/\s/g, '')), g = graphemes(normText(got).replace(/\s/g, '')); return e.length ? lev(e, g) / e.length : g.length ? 1 : 0; };
export const wer = (expected: string, got: string): number => { const e = normText(expected).split(' ').filter(Boolean), g = normText(got).split(' ').filter(Boolean); return e.length ? lev(e, g) / e.length : g.length ? 1 : 0; };
/** Indicative bands for ONE sentence read once; deliberately coarse. */
export const band = (c: number): 'good' | 'fair' | 'poor' => (c <= 0.15 ? 'good' : c <= 0.35 ? 'fair' : 'poor');

export const LANGS = ['en', 'te', 'ta', 'hi', 'kn', 'ml'] as const;
// Reference sentences written for convenience (same meaning in each language). Have a native speaker confirm them, or type your own sentence instead.
export const REFERENCE: Record<string, string> = {
  en: 'Today I took a long walk and thought about my plans for the week.',
  te: 'ఈ రోజు నేను చాలా సేపు నడిచాను మరియు ఈ వారం నా ప్రణాళికల గురించి ఆలోచించాను.',
  ta: 'இன்று நான் நீண்ட நேரம் நடந்தேன், இந்த வாரத்திற்கான என் திட்டங்களைப் பற்றி யோசித்தேன்.',
  hi: 'आज मैं बहुत देर तक टहला और इस हफ्ते की अपनी योजनाओं के बारे में सोचा।',
  kn: 'ಇಂದು ನಾನು ತುಂಬಾ ಹೊತ್ತು ನಡೆದೆ ಮತ್ತು ಈ ವಾರದ ನನ್ನ ಯೋಜನೆಗಳ ಬಗ್ಗೆ ಯೋಚಿಸಿದೆ.',
  ml: 'ഇന്ന് ഞാൻ ഒരുപാട് നേരം നടന്നു, ഈ ആഴ്ചത്തെ എന്റെ പദ്ധതികളെക്കുറിച്ച് ചിന്തിച്ചു.',
};
