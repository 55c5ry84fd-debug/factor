// ─────────────────────────────────────────────────────────────
// Factor — content filter dictionaries.
// Edit this file to tune moderation. Logic lives in
// src/services/moderation-text.js (normalization + matching).
//
// Matching strategy (in moderation-text.js):
//   1. Normalize: lowercase, NFKD, strip diacritics, homoglyph map
//      (cyrillic↔latin, digit↔letter), collapse repeated letters.
//   2. Remove all non-alphanumeric characters.
//   3. Search substring against PROFANITY_ROOTS and ETHNIC_SLURS.
//   4. Separately: find ETHNIC_MARKERS and ETHNIC_SLURS within
//      NORMALIZE_WINDOW chars of each other (order-independent).
//   5. Skip if the match intersects any WHITELIST entry exactly.
// ─────────────────────────────────────────────────────────────

export const PROFANITY_ROOTS = [
  'хуй',
  'хуя',
  'хуе',
  'хуи',
  'хуйн',
  'хуесос',
  'хуеплет',
  'хуеплёт',

  'пизд',
  'пизж',

  'бля',
  'блят',

  'ебал',
  'ебат',
  'ебан',
  'ебуч',
  'ебет',
  'ебёт',
  'ебля',
  'ебло',
  'ебну',
  'ебуч',
  'заеб',
  'уеб',
  'въеб',
  'наеб',
  'отъеб',
  'подъеб',
  'разъеб',
  'съеб',
  'выеб',

  'сук',
  'сучк',
  'сучон',

  'муд',
  'мудак',
  'мудил',
  'мудач',

  'пидар',
  'пидор',
  'педик',
  'педер',
  'пидр',
  'пидрил',

  'залуп',
  'шлюх',
  'бляд',

  'дроч',
  'дрочер',

  'жоп',
  'жопу',
  'жопой',
  'жопе',

  'говн',
  'говнюк',
  'говноед',

  'манда',
  'мандав',
  'манде',

  'срать',
  'срак',
  'срач',
  'срут',
  'ссан',
  'ссык',
  'ссыкун',

  'уебан',
  'уёбок',
  'уёбищ',
  'уебищ',

  'чмо',
  'чмошн',

  'тварь',
  'твари',
  'тварюг',

  'мразь',
  'мрази',
  'мразот',

  'гандон',
  'гондон',

  'хер',
  'херн',
  'херня',
  'херов',
  'херо',

  'долбоеб',
  'долбоёб',
  'долбaеб',

  'петух',
  'петуш',
  'петушат',

  'fuck',
  'fuk',
  'fck',
  'bitch',
  'cunt',
  'asshole',
  'nigger',
  'nigga',
  'faggot',
  'fagot',
  'whore',
  'slut',
];

export const ETHNIC_SLURS = [
  'хохол',
  'хохл',
  'хахол',
  'укроп',
  'укропитек',

  'москаль',
  'москал',
  'рашист',
  'рашк',

  'чурк',
  'чурбан',
  'хач',
  'хачик',
  'чурка',
  'чуркестан',

  'жид',
  'жидя',
  'жидов',
  'жидоб',

  'пиндос',
  'пиндос',
  'америкос',
  'америкоз',

  'даун',
  'даунен',
  'аутист',
  'дебил',
  'дебильн',
  'имбецил',
  'кретин',
  'идиот',

  'ниггер',
  'нигга',
  'нигер',
  'чёрномаз',
  'черномаз',

  'кацап',
  'кацап',
  'бульбаш',
  'бульбаш',

  'нацик',
  'нацист',
  'фашист',
  'фашн',

  'гей',
  'гомосек',
  'педик',
  'пидор',
  'пидар',
  'пидр',
];

export const ETHNIC_MARKERS = [
  'хохол',
  'хохл',
  'украин',
  'укроп',
  'русск',
  'россиян',
  'москал',
  'кацап',
  'бульбаш',
  'беларус',
  'чечен',
  'чечн',
  'дагестан',
  'татар',
  'кавказ',
  'армян',
  'грузин',
  'азербайдж',
  'еврей',
  'жид',
  'азиат',
  'китаец',
  'китайц',
  'якут',
  'чукча',
  'таджик',
  'узбек',
  'киргиз',
  'цыган',
  'негр',
  'афроамерик',
  'американец',
  'америкос',
  'пиндос',
  'поляк',
  'пшек',
  'литов',
  'латыш',
  'эстон',
  'молдаван',
];

// Words that would otherwise be matched as false positives.
// Compared AFTER normalization (lowercase, no non-alnum).
export const WHITELIST = [
  'скипидар',
  'скипидарная',
  'скипидарный',
  'скипидарит',
  'пидарка',
  'пиздит',
  'пиздит',
  'пиджа',
  'пиджак',
  'педжет',
  'пух',
  'пуховый',
  'мудрый',
  'мудрость',
  'мудрец',
  'мудрец',
  'мудрование',
  'дрочить',
  'дрочит',
  'дрочил',
  'залупаться',
  'жопой',
  'жопа',
  'ебанутый',
  'муд',
  'херсон',
  'херсонес',
  'хер',
  'сучка',
  'сучко',
  'сучек',
  'суккуб',
  'сукно',
  'суковат',
  'петух',
  'петухи',
  'петухов',
  'петушиный',
  'петушок',
];

// Order-independent pair check:
// if any ETHNIC_MARKER and any ETHNIC_SLUR appear within
// ETHNIC_PAIR_WINDOW normalized characters of each other
// (in either order), the text is flagged.
export const ETHNIC_PAIR_WINDOW = 60;

// Minimum normalized length before running profanity check.
// Prevents flagging very short messages (e.g. "да", "ок").
export const MIN_CHECK_LEN = 2;

// Custom admin-managed additions (populated from DB `moderation_words`
// in a future migration). Left empty now — placeholder kept so the
// shape is stable for downstream code.
export const CUSTOM_ROOTS = [];
export const CUSTOM_SLURS = [];
export const CUSTOM_WHITELIST = [];