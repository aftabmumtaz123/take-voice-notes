// Offline script normalization for multilingual transcripts.
// Roman / Latin mode preserves existing Latin text and transliterates
// Devanagari (Hindi) and Arabic-derived scripts (including Urdu) into Latin.

const DEV_CONSONANTS = {
  'क':'k','ख':'kh','ग':'g','घ':'gh','ङ':'ng','च':'ch','छ':'chh','ज':'j','झ':'jh','ञ':'ny',
  'ट':'t','ठ':'th','ड':'d','ढ':'dh','ण':'n','त':'t','थ':'th','द':'d','ध':'dh','न':'n',
  'प':'p','फ':'ph','ब':'b','भ':'bh','म':'m','य':'y','र':'r','ल':'l','व':'v',
  'श':'sh','ष':'sh','स':'s','ह':'h','ळ':'l'
};
const DEV_VOWELS = {
  'अ':'a','आ':'aa','इ':'i','ई':'ee','उ':'u','ऊ':'oo','ऋ':'ri','ए':'e','ऐ':'ai','ओ':'o','औ':'au'
};
const DEV_MATRAS = {'ा':'aa','ि':'i','ी':'ee','ु':'u','ू':'oo','ृ':'ri','ॄ':'ree','े':'e','ै':'ai','ो':'o','ौ':'au'};
const DEV_SPECIAL = {
  'ं':'n','ँ':'n','ः':'h','ऽ':'\'', '।':'.','॥':'..','॰':'.'
};
const DEV_NUKTA = {
  'क़':'q','ख़':'kh','ग़':'gh','ज़':'z','ड़':'r','ढ़':'rh','फ़':'f','य़':'y'
};

const URDU = {
  'ا':'a','آ':'aa','أ':'a','إ':'i','ٱ':'a','ب':'b','پ':'p','ت':'t','ٹ':'t','ث':'s','ج':'j','چ':'ch','ح':'h','خ':'kh',
  'د':'d','ڈ':'d','ذ':'z','ر':'r','ڑ':'r','ز':'z','ژ':'zh','س':'s','ش':'sh','ص':'s','ض':'z','ط':'t','ظ':'z',
  'ع':'a','غ':'gh','ف':'f','ڤ':'v','ق':'q','ک':'k','گ':'g','ل':'l','م':'m','ن':'n','ں':'n','و':'w','ہ':'h','ھ':'h',
  'ء':'','ی':'y','ے':'e','ئ':'y','ؤ':'o','ۃ':'h','ۂ':'h','ـ':'','ً':'an','ٌ':'un','ٍ':'in','َ':'a','ُ':'u','ِ':'i','ّ':'',
  'ٓ':'','ٔ':'','ٕ':'','ٰ':'a'
};

function hasTargetScript(text) {
  return /[\u0900-\u097F\u0600-\u06FF\u0750-\u077F]/.test(text || '');
}

function normalizeDevanagari(text) {
  return text
    .replace(/क़/g, 'क़').replace(/ख़/g, 'ख़').replace(/ग़/g, 'ग़').replace(/ज़/g, 'ज़')
    .replace(/ड़/g, 'ड़').replace(/ढ़/g, 'ढ़').replace(/फ़/g, 'फ़').replace(/य़/g, 'य़');
}

function transliterateDevanagariWord(word) {
  const chars = [...normalizeDevanagari(word)];
  let out = '';

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const next = chars[i + 1];
    const pair = ch + (next || '');

    // Common nukta spellings such as क़, ख़, ग़, ज़, फ़.
    const nuktaMap = {
      'क़':'q','ख़':'kh','ग़':'gh','ज़':'z','ड़':'r','ढ़':'rh','फ़':'f','य़':'y'
    };
    if (nuktaMap[pair]) {
      out += nuktaMap[pair];
      i++;
      // Nukta consonants still take the normal inherent/matra handling.
      const after = chars[i + 1];
      if (DEV_MATRAS[after]) { out += DEV_MATRAS[after]; i++; }
      else if (after !== '्' && after && !DEV_CONSONANTS[after] && !DEV_VOWELS[after]) out += '';
      else if (after !== '्') out += 'a';
      continue;
    }

    if (DEV_VOWELS[ch]) {
      out += DEV_VOWELS[ch];
      continue;
    }

    if (DEV_SPECIAL[ch]) {
      out += DEV_SPECIAL[ch];
      continue;
    }

    if (ch === '्') continue;
    if (ch === '़') continue;
    if (DEV_MATRAS[ch]) {
      out += DEV_MATRAS[ch];
      continue;
    }

    if (DEV_CONSONANTS[ch]) {
      out += DEV_CONSONANTS[ch];
      if (next === '्') {
        // Virama explicitly suppresses the inherent vowel.
        continue;
      }
      if (!DEV_MATRAS[next]) {
        out += 'a';
      }
      continue;
    }

    out += ch;
  }

  // Hindi normally drops the inherent schwa at the end of many words.
  // This turns "phira" -> "phir", "hama" -> "ham", "aapa" -> "aap".
  out = out.replace(/a$/i, '');
  return out;
}

function transliterateDevanagari(text) {
  // Process whitespace-delimited words so final schwa deletion does not
  // accidentally affect the next word.
  return text.replace(/[^\s]+/g, transliterateDevanagariWord);
}

function transliterateUrdu(text) {
  // Urdu orthography often omits short vowels, so this remains intentionally
  // conservative; Latin text and punctuation are preserved.
  return [...text].map(ch => URDU[ch] ?? ch).join('');
}

export function toRoman(text, mode = 'roman') {
  if (!text || mode !== 'roman' || !hasTargetScript(text)) return text || '';
  let output = transliterateDevanagari(text);
  output = transliterateUrdu(output);
  return output.replace(/[ \t]+/g, ' ').trim();
}
