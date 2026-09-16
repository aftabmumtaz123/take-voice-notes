// Offline script normalization for multilingual transcripts.
// Roman / Latin mode keeps English/Latin text intact and converts
// Devanagari (Hindi) and Urdu/Arabic-derived script to readable Roman text.

const DEV_CONSONANTS = {
  'क':'k','ख':'kh','ग':'g','घ':'gh','ङ':'ng','च':'ch','छ':'chh','ज':'j','झ':'jh','ञ':'ny',
  'ट':'t','ठ':'th','ड':'d','ढ':'dh','ण':'n','त':'t','थ':'th','द':'d','ध':'dh','न':'n',
  'प':'p','फ':'ph','ब':'b','भ':'bh','म':'m','य':'y','र':'r','ल':'l','व':'v',
  'श':'sh','ष':'sh','स':'s','ह':'h','ळ':'l','क़':'q','ख़':'kh','ग़':'gh','ज़':'z','ड़':'r','ढ़':'rh','फ़':'f','य़':'y'
};
const DEV_VOWELS = {'अ':'a','आ':'aa','इ':'i','ई':'ee','उ':'u','ऊ':'oo','ऋ':'ri','ए':'e','ऐ':'ai','ओ':'o','औ':'au'};
const DEV_MATRAS = {'ा':'aa','ि':'i','ी':'ee','ु':'u','ू':'oo','ृ':'ri','ॄ':'ree','े':'e','ै':'ai','ो':'o','ौ':'au'};
const DEV_SPECIAL = {'ं':'n','ँ':'n','ः':'h','ऽ':"'",'।':'.','॥':'..','॰':'.'};

const URDU_CHAR = {
  'ا':'a','آ':'aa','أ':'a','إ':'i','ٱ':'a','ب':'b','پ':'p','ت':'t','ٹ':'t','ث':'s','ج':'j','چ':'ch','ح':'h','خ':'kh',
  'د':'d','ڈ':'d','ذ':'z','ر':'r','ڑ':'r','ز':'z','ژ':'zh','س':'s','ش':'sh','ص':'s','ض':'z','ط':'t','ظ':'z',
  'ع':'a','غ':'gh','ف':'f','ڤ':'v','ق':'q','ک':'k','گ':'g','ل':'l','م':'m','ن':'n','ں':'n','و':'w','ہ':'h','ھ':'h',
  'ء':'','ی':'y','ے':'e','ئ':'y','ؤ':'o','ۃ':'h','ۂ':'h','ـ':'','ً':'an','ٌ':'un','ٍ':'in','َ':'a','ُ':'u','ِ':'i','ّ':'',
  'ٓ':'','ٔ':'','ٕ':'','ٰ':'a','ْ':''
};

// Common words/phrases are normalized after character transliteration so the
// result reads naturally in Roman Urdu/Hinglish instead of mechanical Latin.
const ROMAN_URDU = new Map(Object.entries({
  'ہے':'hai','ہیں':'hain','ہوں':'hoon','ہو':'ho','ہی':'hi','یہ':'ye','وہ':'wo','اس':'us','اسے':'ise','اس نے':'usne','اسکا':'iska','اسکی':'iski','اسکے':'iske',
  'میں':'main','مجھ':'mujh','مجھے':'mujhe','ہم':'hum','ہمیں':'humein','آپ':'aap','اپ':'aap','آپکا':'aapka','آپکی':'aapki','آپکے':'aapke',
  'تم':'tum','تمہیں':'tumhein','تو':'to','نے':'ne','کو':'ko','کی':'ki','کے':'ke','کا':'ka','سے':'se','پر':'par','میں':'mein','اور':'aur',
  'لیکن':'lekin','اگر':'agar','پھر':'phir','پہلے':'pehle','پیچھے':'peechhe','آگے':'aage','اب':'ab','بھی':'bhi','بہت':'bohat','بس':'bas',
  'کر':'kar','کرو':'karo','کرتا':'karta','کرتی':'karti','کرتے':'karte','کیا':'kya','کیوں':'kyun','کرنا':'karna','کرنے':'karne','کریں':'karein',
  'ہوگا':'hoga','ہوگی':'hogi','ہوںگا':'hoonga','ہوئے':'hue','رہا':'raha','رہی':'rahi','رہے':'rahe','رہا ہے':'raha hai','رہی ہے':'rahi hai',
  'دکھا':'dikha','دیکھا':'dekha','دیکھے':'dekhe','دیکھیں':'dekhein','مطلب':'matlab','چیز':'cheez','چیزیں':'cheezein','لوگوں':'logon','لوگ':'log',
  'دوسرا':'doosra','دوسرے':'doosre','دوسری':'doosri','صرف':'sirf','تاکہ':'taake','کیونکہ':'kyunke','میرے':'mere','میرے لیے':'mere liye','میرے لئے':'mere liye',
  'میرے':'mere','لئے':'liye','لیے':'liye','بغیر':'baghair','ساتھ':'saath','جب':'jab','جبکہ':'jabke','نہیں':'nahin','نہ':'na','ہاں':'haan','جی':'ji',
  'شروع':'shuru','شروع کرنا':'shuru karna','رک':'ruk','رکو':'ruko','بس کرو':'bas karo','کنیکٹ':'connect','کنیکٹس':'connects','چینج':'change','چینجز':'changes','پیج':'page','پیجنگ':'paging',
  'ریفرش':'refresh','کرے':'kare','کرے گا':'karega','کرے گی':'karegi','کرنے گا':'karega','سوچا':'socha','سوچ':'soch','کیوں نہیں':'kyun nahi',
  'انگلش':'English','اردو':'Urdu','ہندی':'Hindi','میٹنگ':'meeting','ٹیم':'team','ڈیولپمنٹ':'development','ڈیولپر':'developer'
}));

const ROMAN_HINDI = new Map(Object.entries({
  'ये':'ye','यह':'ye','वो':'wo','वह':'wo','उसने':'usne','उस':'us','इस':'is','इसे':'ise',
  'मैं':'main','में':'mein','मुझे':'mujhe','हम':'hum','हमें':'humein','आप':'aap','आपको':'aapko',
  'और':'aur','लेकिन':'lekin','अगर':'agar','फिर':'phir','पहले':'pehle','पीछे':'peechhe','आगे':'aage','अब':'ab','भी':'bhi','बहुत':'bahut','बस':'bas',
  'कर':'kar','करो':'karo','करता':'karta','करती':'karti','करते':'karte','करना':'karna','करने':'karne','करेंगे':'karenge','करूँगा':'karunga',
  'क्या':'kya','क्यों':'kyun','है':'hai','हैं':'hain','हूँ':'hoon','हो':'ho','होगा':'hoga','होगी':'hogi','रहा':'raha','रही':'rahi','रहे':'rahe',
  'दिखा':'dikha','दिखा रहा':'dikha raha','देखा':'dekha','देखे':'dekhe','देखें':'dekhein','लोग':'log','लोगों':'logon',
  'दूसरा':'doosra','दूसरे':'doosre','दूसरी':'doosri','ताकि':'taaki','क्योंकि':'kyunki','मेरे':'mere','लिए':'liye','बिना':'bina','साथ':'saath',
  'नहीं':'nahin','नहिं':'nahin','हाँ':'haan','शुरू':'shuru','कनेक्ट':'connect','रिफ्रेश':'refresh','पेज':'page','पेजिंग':'paging','इंग्लिश':'English',
  'चेंज':'change','चेंजेस':'changes','चेंज किया':'change kiya','दिया':'diya','सोचा':'socha','किया':'kiya','करेगा':'karega','करेंगे':'karenge'
}));

function hasTargetScript(text) {
  return /[\u0900-\u097F\u0600-\u06FF\u0750-\u077F]/.test(text || '');
}

function transliterateDevanagariWord(word) {
  if (ROMAN_HINDI.has(word)) return ROMAN_HINDI.get(word);
  const chars = [...word];
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i], next = chars[i + 1];
    const pair = ch + (next || '');
    const nukta = {'क़':'q','ख़':'kh','ग़':'gh','ज़':'z','ड़':'r','ढ़':'rh','फ़':'f','य़':'y'};
    if (nukta[pair]) { out += nukta[pair]; i++; continue; }
    if (DEV_VOWELS[ch]) { out += DEV_VOWELS[ch]; continue; }
    if (DEV_SPECIAL[ch]) { out += DEV_SPECIAL[ch]; continue; }
    if (ch === '्' || ch === '़') continue;
    if (DEV_MATRAS[ch]) { out += DEV_MATRAS[ch]; continue; }
    if (DEV_CONSONANTS[ch]) {
      out += DEV_CONSONANTS[ch];
      if (next === '्') continue;
      if (!DEV_MATRAS[next]) out += 'a';
      continue;
    }
    out += ch;
  }
  // Natural Hindi/Roman-Hindi convention: final inherent schwa is usually silent.
  return out.replace(/a$/i, '');
}

function transliterateDevanagari(text) {
  return text.replace(/[\u0900-\u097F]+/g, transliterateDevanagariWord);
}

function transliterateUrduWord(word) {
  if (ROMAN_URDU.has(word)) return ROMAN_URDU.get(word);
  let out = [...word].map(ch => URDU_CHAR[ch] ?? ch).join('');

  // Helpful Urdu vowel heuristics. Urdu omits short vowels in writing, so these
  // are intentionally conservative and only adjust common grammatical endings.
  out = out
    .replace(/^w([aeiou])/i, 'w$1')
    .replace(/hai$/i, 'hai')
    .replace(/e$/i, 'e');
  return out;
}

function transliterateUrdu(text) {
  return text.replace(/[\u0600-\u06FF\u0750-\u077F]+/g, transliterateUrduWord);
}

function normalizeRomanSpacing(text) {
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/[،٬]/g, ',')
    .replace(/[۔]/g, '.')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/([([{])\s+/g, '$1')
    .replace(/\s+([)\]}])/g, '$1')
    .trim();
}

export function toRoman(text, mode = 'roman') {
  if (!text || mode !== 'roman') return text || '';
  if (!hasTargetScript(text)) return normalizeRomanSpacing(text);

  let output = transliterateDevanagari(text);
  output = transliterateUrdu(output);

  // Second pass normalizes common Roman-Hindi/Urdu conversational forms.
  // This is deliberately a presentation layer: it does not translate English
  // and does not alter the provider's multilingual recognition settings.
  const phraseFixes = [
    [/\bis ne\b/gi, 'usne'],
    [/\bus ne\b/gi, 'usne'],
    [/\bاس نے\b/g, 'usne'],
    [/\bkee\b/gi, 'ki'],
    [/\bbhee\b/gi, 'bhi'],
    [/\bchenj\b/gi, 'change'],
    [/\bchynj\b/gi, 'change'],
    [/\busane\b/gi, 'usne'],
    [/\bhe\b/gi, 'hai']
  ];
  for (const [pattern, replacement] of phraseFixes) output = output.replace(pattern, replacement);
  return normalizeRomanSpacing(output);
}
