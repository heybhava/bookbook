// Extensible language registry (BCP-47 codes). Shared by server and client. Adding a language = adding one row.
export interface Lang {
  code: string; en: string; native: string; script: string; rtl?: boolean;
  nllb?: string;        // FLORES-200 code used by NLLB-200 / MADLAD-style servers
  it2?: boolean;        // covered by AI4Bharat IndicTrans2 (22 scheduled Indian languages)
  speech?: string;      // preferred BCP-47 locale for speech synthesis / recognition
}

// code | English | native | script | flags
const R = (code: string, en: string, native: string, script: string, o: Partial<Lang> = {}): Lang => ({ code, en, native, script, ...o });

export const LANGUAGES: Lang[] = [
  // Indian languages
  R('te', 'Telugu', 'తెలుగు', 'Telu', { nllb: 'tel_Telu', it2: true, speech: 'te-IN' }), R('ta', 'Tamil', 'தமிழ்', 'Taml', { nllb: 'tam_Taml', it2: true, speech: 'ta-IN' }),
  R('hi', 'Hindi', 'हिन्दी', 'Deva', { nllb: 'hin_Deva', it2: true, speech: 'hi-IN' }), R('kn', 'Kannada', 'ಕನ್ನಡ', 'Knda', { nllb: 'kan_Knda', it2: true, speech: 'kn-IN' }),
  R('ml', 'Malayalam', 'മലയാളം', 'Mlym', { nllb: 'mal_Mlym', it2: true, speech: 'ml-IN' }), R('bn', 'Bengali', 'বাংলা', 'Beng', { nllb: 'ben_Beng', it2: true, speech: 'bn-IN' }),
  R('mr', 'Marathi', 'मराठी', 'Deva', { nllb: 'mar_Deva', it2: true, speech: 'mr-IN' }), R('gu', 'Gujarati', 'ગુજરાતી', 'Gujr', { nllb: 'guj_Gujr', it2: true, speech: 'gu-IN' }),
  R('pa', 'Punjabi', 'ਪੰਜਾਬੀ', 'Guru', { nllb: 'pan_Guru', it2: true, speech: 'pa-IN' }), R('or', 'Odia', 'ଓଡ଼ିଆ', 'Orya', { nllb: 'ory_Orya', it2: true, speech: 'or-IN' }),
  R('as', 'Assamese', 'অসমীয়া', 'Beng', { nllb: 'asm_Beng', it2: true }), R('ur', 'Urdu', 'اردو', 'Arab', { rtl: true, nllb: 'urd_Arab', it2: true, speech: 'ur-PK' }),
  R('sa', 'Sanskrit', 'संस्कृतम्', 'Deva', { nllb: 'san_Deva', it2: true }), R('kok', 'Konkani', 'कोंकणी', 'Deva', { nllb: 'gom_Deva', it2: true }),
  R('ks', 'Kashmiri', 'کٲشُر', 'Arab', { rtl: true, nllb: 'kas_Arab', it2: true }), R('ne', 'Nepali', 'नेपाली', 'Deva', { nllb: 'npi_Deva', it2: true, speech: 'ne-NP' }),
  R('sd', 'Sindhi', 'سنڌي', 'Arab', { rtl: true, nllb: 'snd_Arab', it2: true }), R('doi', 'Dogri', 'डोगरी', 'Deva', { it2: true }),
  R('mai', 'Maithili', 'मैथिली', 'Deva', { nllb: 'mai_Deva', it2: true }), R('sat', 'Santali', 'ᱥᱟᱱᱛᱟᱲᱤ', 'Olck', { nllb: 'sat_Olck', it2: true }),
  R('mni', 'Manipuri (Meitei)', 'ꯃꯩꯇꯩꯂꯣꯟ', 'Mtei', { nllb: 'mni_Beng', it2: true }), R('brx', 'Bodo', 'बर’', 'Deva', { it2: true }),
  R('si', 'Sinhala', 'සිංහල', 'Sinh', { nllb: 'sin_Sinh', speech: 'si-LK' }),
  R('en', 'English', 'English', 'Latn', { nllb: 'eng_Latn', it2: true, speech: 'en-US' }),
  // European
  R('es', 'Spanish', 'Español', 'Latn', { nllb: 'spa_Latn', speech: 'es-ES' }), R('fr', 'French', 'Français', 'Latn', { nllb: 'fra_Latn', speech: 'fr-FR' }),
  R('de', 'German', 'Deutsch', 'Latn', { nllb: 'deu_Latn', speech: 'de-DE' }), R('it', 'Italian', 'Italiano', 'Latn', { nllb: 'ita_Latn', speech: 'it-IT' }),
  R('pt', 'Portuguese', 'Português', 'Latn', { nllb: 'por_Latn', speech: 'pt-PT' }), R('nl', 'Dutch', 'Nederlands', 'Latn', { nllb: 'nld_Latn', speech: 'nl-NL' }),
  R('sv', 'Swedish', 'Svenska', 'Latn', { nllb: 'swe_Latn', speech: 'sv-SE' }), R('no', 'Norwegian', 'Norsk', 'Latn', { nllb: 'nob_Latn', speech: 'nb-NO' }),
  R('da', 'Danish', 'Dansk', 'Latn', { nllb: 'dan_Latn', speech: 'da-DK' }), R('fi', 'Finnish', 'Suomi', 'Latn', { nllb: 'fin_Latn', speech: 'fi-FI' }),
  R('is', 'Icelandic', 'Íslenska', 'Latn', { nllb: 'isl_Latn' }), R('el', 'Greek', 'Ελληνικά', 'Grek', { nllb: 'ell_Grek', speech: 'el-GR' }),
  R('pl', 'Polish', 'Polski', 'Latn', { nllb: 'pol_Latn', speech: 'pl-PL' }), R('cs', 'Czech', 'Čeština', 'Latn', { nllb: 'ces_Latn', speech: 'cs-CZ' }),
  R('sk', 'Slovak', 'Slovenčina', 'Latn', { nllb: 'slk_Latn' }), R('uk', 'Ukrainian', 'Українська', 'Cyrl', { nllb: 'ukr_Cyrl', speech: 'uk-UA' }),
  R('ru', 'Russian', 'Русский', 'Cyrl', { nllb: 'rus_Cyrl', speech: 'ru-RU' }), R('ro', 'Romanian', 'Română', 'Latn', { nllb: 'ron_Latn', speech: 'ro-RO' }),
  R('hu', 'Hungarian', 'Magyar', 'Latn', { nllb: 'hun_Latn', speech: 'hu-HU' }), R('bg', 'Bulgarian', 'Български', 'Cyrl', { nllb: 'bul_Cyrl' }),
  R('hr', 'Croatian', 'Hrvatski', 'Latn', { nllb: 'hrv_Latn' }), R('sr', 'Serbian', 'Српски', 'Cyrl', { nllb: 'srp_Cyrl' }),
  R('sl', 'Slovenian', 'Slovenščina', 'Latn', { nllb: 'slv_Latn' }), R('et', 'Estonian', 'Eesti', 'Latn', { nllb: 'est_Latn' }),
  R('lv', 'Latvian', 'Latviešu', 'Latn', { nllb: 'lvs_Latn' }), R('lt', 'Lithuanian', 'Lietuvių', 'Latn', { nllb: 'lit_Latn' }),
  R('ga', 'Irish', 'Gaeilge', 'Latn', { nllb: 'gle_Latn' }), R('cy', 'Welsh', 'Cymraeg', 'Latn', { nllb: 'cym_Latn' }),
  R('eu', 'Basque', 'Euskara', 'Latn', { nllb: 'eus_Latn' }), R('ca', 'Catalan', 'Català', 'Latn', { nllb: 'cat_Latn', speech: 'ca-ES' }),
  R('sq', 'Albanian', 'Shqip', 'Latn', { nllb: 'als_Latn' }), R('tr', 'Turkish', 'Türkçe', 'Latn', { nllb: 'tur_Latn', speech: 'tr-TR' }),
  R('la', 'Latin', 'Latina', 'Latn'), R('eo', 'Esperanto', 'Esperanto', 'Latn', { nllb: 'epo_Latn' }),
  // East & Southeast Asian
  R('zh-Hans', 'Chinese (Simplified)', '简体中文', 'Hans', { nllb: 'zho_Hans', speech: 'zh-CN' }), R('zh-Hant', 'Chinese (Traditional)', '繁體中文', 'Hant', { nllb: 'zho_Hant', speech: 'zh-TW' }),
  R('ja', 'Japanese', '日本語', 'Jpan', { nllb: 'jpn_Jpan', speech: 'ja-JP' }), R('ko', 'Korean', '한국어', 'Kore', { nllb: 'kor_Hang', speech: 'ko-KR' }),
  R('th', 'Thai', 'ไทย', 'Thai', { nllb: 'tha_Thai', speech: 'th-TH' }), R('vi', 'Vietnamese', 'Tiếng Việt', 'Latn', { nllb: 'vie_Latn', speech: 'vi-VN' }),
  R('id', 'Indonesian', 'Bahasa Indonesia', 'Latn', { nllb: 'ind_Latn', speech: 'id-ID' }), R('ms', 'Malay', 'Bahasa Melayu', 'Latn', { nllb: 'zsm_Latn', speech: 'ms-MY' }),
  R('fil', 'Filipino', 'Filipino', 'Latn', { nllb: 'tgl_Latn' }), R('my', 'Burmese', 'မြန်မာ', 'Mymr', { nllb: 'mya_Mymr' }),
  R('km', 'Khmer', 'ខ្មែរ', 'Khmr', { nllb: 'khm_Khmr' }), R('lo', 'Lao', 'ລາວ', 'Laoo', { nllb: 'lao_Laoo' }), R('mn', 'Mongolian', 'Монгол', 'Cyrl', { nllb: 'khk_Cyrl' }),
  // Middle Eastern & African
  R('ar', 'Arabic', 'العربية', 'Arab', { rtl: true, nllb: 'arb_Arab', speech: 'ar-SA' }), R('he', 'Hebrew', 'עברית', 'Hebr', { rtl: true, nllb: 'heb_Hebr', speech: 'he-IL' }),
  R('fa', 'Persian', 'فارسی', 'Arab', { rtl: true, nllb: 'pes_Arab', speech: 'fa-IR' }), R('ps', 'Pashto', 'پښتو', 'Arab', { rtl: true, nllb: 'pbt_Arab' }),
  R('sw', 'Swahili', 'Kiswahili', 'Latn', { nllb: 'swh_Latn', speech: 'sw-KE' }), R('am', 'Amharic', 'አማርኛ', 'Ethi', { nllb: 'amh_Ethi' }),
  R('so', 'Somali', 'Soomaali', 'Latn', { nllb: 'som_Latn' }), R('ha', 'Hausa', 'Hausa', 'Latn', { nllb: 'hau_Latn' }), R('yo', 'Yoruba', 'Yorùbá', 'Latn', { nllb: 'yor_Latn' }),
  R('ig', 'Igbo', 'Igbo', 'Latn', { nllb: 'ibo_Latn' }), R('zu', 'Zulu', 'isiZulu', 'Latn', { nllb: 'zul_Latn' }), R('xh', 'Xhosa', 'isiXhosa', 'Latn', { nllb: 'xho_Latn' }),
  R('af', 'Afrikaans', 'Afrikaans', 'Latn', { nllb: 'afr_Latn', speech: 'af-ZA' }), R('st', 'Sesotho', 'Sesotho', 'Latn', { nllb: 'sot_Latn' }), R('mg', 'Malagasy', 'Malagasy', 'Latn', { nllb: 'plt_Latn' }),
  // more (NLLB-200 coverage)
  R('be', 'Belarusian', 'Беларуская', 'Cyrl', { nllb: 'bel_Cyrl' }), R('mk', 'Macedonian', 'Македонски', 'Cyrl', { nllb: 'mkd_Cyrl' }), R('bs', 'Bosnian', 'Bosanski', 'Latn', { nllb: 'bos_Latn' }),
  R('gl', 'Galician', 'Galego', 'Latn', { nllb: 'glg_Latn' }), R('mt', 'Maltese', 'Malti', 'Latn', { nllb: 'mlt_Latn' }), R('lb', 'Luxembourgish', 'Lëtzebuergesch', 'Latn', { nllb: 'ltz_Latn' }),
  R('az', 'Azerbaijani', 'Azərbaycanca', 'Latn', { nllb: 'azj_Latn' }), R('kk', 'Kazakh', 'Қазақша', 'Cyrl', { nllb: 'kaz_Cyrl' }), R('uz', 'Uzbek', 'Oʻzbekcha', 'Latn', { nllb: 'uzn_Latn' }),
  R('ky', 'Kyrgyz', 'Кыргызча', 'Cyrl', { nllb: 'kir_Cyrl' }), R('tg', 'Tajik', 'Тоҷикӣ', 'Cyrl', { nllb: 'tgk_Cyrl' }), R('hy', 'Armenian', 'Հայերեն', 'Armn', { nllb: 'hye_Armn' }),
  R('ka', 'Georgian', 'ქართული', 'Geor', { nllb: 'kat_Geor' }), R('ku', 'Kurdish (Kurmanji)', 'Kurdî', 'Latn', { nllb: 'kmr_Latn' }), R('yi', 'Yiddish', 'ייִדיש', 'Hebr', { rtl: true, nllb: 'ydd_Hebr' }),
  R('jv', 'Javanese', 'Basa Jawa', 'Latn', { nllb: 'jav_Latn' }), R('su', 'Sundanese', 'Basa Sunda', 'Latn', { nllb: 'sun_Latn' }), R('ceb', 'Cebuano', 'Cebuano', 'Latn', { nllb: 'ceb_Latn' }),
  R('ht', 'Haitian Creole', 'Kreyòl ayisyen', 'Latn', { nllb: 'hat_Latn' }), R('mi', 'Maori', 'Te Reo Māori', 'Latn', { nllb: 'mri_Latn' }), R('sm', 'Samoan', 'Gagana Samoa', 'Latn', { nllb: 'smo_Latn' }),
  R('rw', 'Kinyarwanda', 'Ikinyarwanda', 'Latn', { nllb: 'kin_Latn' }), R('sn', 'Shona', 'chiShona', 'Latn', { nllb: 'sna_Latn' }), R('wo', 'Wolof', 'Wolof', 'Latn', { nllb: 'wol_Latn' }),
  R('ln', 'Lingala', 'Lingála', 'Latn', { nllb: 'lin_Latn' }), R('lg', 'Luganda', 'Luganda', 'Latn', { nllb: 'lug_Latn' }), R('ti', 'Tigrinya', 'ትግርኛ', 'Ethi', { nllb: 'tir_Ethi' }),
  R('tk', 'Turkmen', 'Türkmençe', 'Latn', { nllb: 'tuk_Latn' }), R('tt', 'Tatar', 'Татарча', 'Cyrl', { nllb: 'tat_Cyrl' }), R('ug', 'Uyghur', 'ئۇيغۇرچە', 'Arab', { rtl: true, nllb: 'uig_Arab' }),
  R('bo', 'Tibetan', 'བོད་སྐད་', 'Tibt', { nllb: 'bod_Tibt' }), R('dz', 'Dzongkha', 'རྫོང་ཁ', 'Tibt', { nllb: 'dzo_Tibt' }),
];

const byCode = new Map(LANGUAGES.map((l) => [l.code.toLowerCase(), l]));
export const getLang = (code?: string | null): Lang | undefined => {
  if (!code) return undefined; const c = code.toLowerCase();
  return byCode.get(c) ?? byCode.get(c.split('-')[0]) ?? (c.startsWith('zh') ? byCode.get(c.includes('tw') || c.includes('hant') || c.includes('hk') ? 'zh-hant' : 'zh-hans') : undefined);
};
export const langName = (code: string) => { const l = getLang(code); return l ? `${l.en} (${l.native})` : code; };
export const isRtl = (code?: string | null) => !!getLang(code)?.rtl;
export const label = (l: Lang) => `${l.native} — ${l.en} — ${l.code}`;

/** CSS font stack per script. Noto Sans/Serif webfonts are bundled (OFL); CJK falls back to system fonts. */
const FONT: Record<string, string> = {
  Telu: "'Noto Sans Telugu'", Taml: "'Noto Sans Tamil'", Deva: "'Noto Sans Devanagari'", Knda: "'Noto Sans Kannada'", Mlym: "'Noto Sans Malayalam'", Beng: "'Noto Sans Bengali'",
  Gujr: "'Noto Sans Gujarati'", Guru: "'Noto Sans Gurmukhi'", Orya: "'Noto Sans Oriya'", Sinh: "'Noto Sans Sinhala'", Arab: "'Noto Sans Arabic'", Hebr: "'Noto Sans Hebrew'",
  Thai: "'Noto Sans Thai'", Khmr: "'Noto Sans Khmer'", Laoo: "'Noto Sans Lao'", Mymr: "'Noto Sans Myanmar'", Ethi: "'Noto Sans Ethiopic'",
  Hans: "'Microsoft YaHei','PingFang SC','Noto Sans CJK SC'", Hant: "'Microsoft JhengHei','PingFang TC','Noto Sans CJK TC'", Jpan: "'Yu Gothic','Hiragino Sans','Noto Sans CJK JP'", Kore: "'Malgun Gothic','Noto Sans CJK KR'",
};
export const fontFor = (code?: string | null) => { const s = getLang(code)?.script; return s && FONT[s] ? `${FONT[s]}, system-ui, sans-serif` : undefined; };
/** Scripts for which a bundled web font exists (used by the support matrix). */
export const bundledFont = (code: string) => { const s = getLang(code)?.script; return !!s && !!FONT[s] && !['Hans', 'Hant', 'Jpan', 'Kore'].includes(s); };

/** Script detection by Unicode block: reliable for non-Latin scripts. */
const BLOCKS: [string, RegExp][] = [
  ['Telu', /[ఀ-౿]/g], ['Taml', /[஀-௿]/g], ['Knda', /[ಀ-೿]/g], ['Mlym', /[ഀ-ൿ]/g], ['Beng', /[ঀ-৿]/g], ['Gujr', /[઀-૿]/g],
  ['Guru', /[਀-੿]/g], ['Orya', /[଀-୿]/g], ['Sinh', /[඀-෿]/g], ['Deva', /[ऀ-ॿ]/g], ['Arab', /[؀-ۿݐ-ݿ]/g], ['Hebr', /[֐-׿]/g],
  ['Thai', /[฀-๿]/g], ['Laoo', /[຀-໿]/g], ['Khmr', /[ក-៿]/g], ['Mymr', /[က-႟]/g], ['Ethi', /[ሀ-፿]/g], ['Grek', /[Ͱ-Ͽ]/g],
  ['Cyrl', /[Ѐ-ӿ]/g], ['Kore', /[가-힯ᄀ-ᇿ]/g], ['Jpan', /[぀-ヿ]/g], ['Hans', /[一-鿿]/g], ['Latn', /[A-Za-zÀ-ɏ]/g],
];
const SCRIPT_DEFAULT: Record<string, string> = { Telu: 'te', Taml: 'ta', Knda: 'kn', Mlym: 'ml', Beng: 'bn', Gujr: 'gu', Guru: 'pa', Orya: 'or', Sinh: 'si', Deva: 'hi', Arab: 'ar', Hebr: 'he', Thai: 'th', Laoo: 'lo', Khmr: 'km', Mymr: 'my', Ethi: 'am', Grek: 'el', Cyrl: 'ru', Kore: 'ko', Jpan: 'ja', Hans: 'zh-Hans' };
const STOP: Record<string, string> = {
  en: 'the and of to is in that it for with as was on are this by be or from at an which have not but',
  es: 'el la de que y en los se del las por un para con una su al lo como más pero sus', fr: 'le la les de des et en un une que est pour dans qui sur au avec pas plus ce',
  de: 'der die das und ist nicht ein eine zu den mit von sich auch auf für dem im es als',  it: 'il la di che e un per una in con non sono del le dei della più come',
  pt: 'o a de que e do da em um para com não uma os no se na por mais como', nl: 'de het een en van ik te dat die in is niet met op voor zijn als maar',
  sv: 'och att det som en är på av för med inte till den har de', tr: 'bir ve bu için ile de da çok daha gibi olarak ne ama', id: 'yang dan di itu dengan untuk tidak ini dari dalam akan pada adalah',
  vi: 'và của là có không được một cho những trong này với các', pl: 'nie się na to jest że w z do jak tak od po', sw: 'na ya wa kwa ni za katika la kuwa cha hii',
};
/** Best-effort language detection. Script-based (high confidence) for non-Latin text; stop-word scoring for Latin-script languages. */
export function detectLanguage(text: string): { code: string; confidence: number } {
  const t = text.slice(0, 2000);
  let best = '', bestN = 0, total = 0, bestNon = '', bestNonN = 0;
  for (const [s, re] of BLOCKS) { const n = (t.match(re) ?? []).length; total += n; if (n > bestN) { best = s; bestN = n; } if (s !== 'Latn' && n > bestNonN) { bestNon = s; bestNonN = n; } }
  if (!total) return { code: 'en', confidence: 0 };
  // code-switching: Telugu/Tamil/etc. text sprinkled with English technical terms is still that language
  if (best === 'Latn' && bestNonN / total >= 0.15) { best = bestNon; bestN = bestNonN; }
  if (best === 'Deva') { return { code: /[ळऱ]|ंखं/.test(t) && false ? 'mr' : 'hi', confidence: 0.6 }; } // hi/mr/ne share Devanagari; default to Hindi
  if (best === 'Jpan' || (best === 'Hans' && /[぀-ヿ]/.test(t))) return { code: 'ja', confidence: 0.9 };
  if (best === 'Latn') {
    const words = t.toLowerCase().match(/[a-zà-ÿ']+/g) ?? []; let top = 'en', topS = -1, second = 0;
    for (const [c, list] of Object.entries(STOP)) { const set = new Set(list.split(' ')); const s = words.filter((w) => set.has(w)).length; if (s > topS) { second = Math.max(second, topS); topS = s; top = c; } else second = Math.max(second, s); }
    return { code: top, confidence: topS <= 0 ? 0.2 : Math.min(0.95, 0.4 + (topS - second) / Math.max(5, words.length / 4)) };
  }
  return { code: SCRIPT_DEFAULT[best] ?? 'en', confidence: Math.min(0.98, bestN / Math.max(20, total)) };
}
