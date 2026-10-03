/*! GrowthxAI web chat — panel v1 (web-chat-PRD.md §5, §6, §13). Loaded by loader.js on first open (or on idle for
 * returning visitors). No dependencies. Everything renders inside a closed Shadow DOM; the only globals are
 * window.growthxai (+ alias window.kaptured) and window.__growthxaiWebchatPanel (the factory the loader calls).
 *
 * Message engine: one conversation open at a time; messages arrive over Supabase Realtime (public capability topic
 * webchat:<conversation>:<stream_key>, a tiny Phoenix-protocol client below) with long-polling every 5 s as fallback;
 * sends are optimistic with an echo_id and queue locally while offline; other tabs sync through BroadcastChannel.
 *
 * Voice (web-chat-voice-elevenlabs-PRD.md): the entry points are here (the "Talk to us" card, the mic in the message
 * box, growthxai.call(), the consent sheet, "Continue by voice"); the call view and the voice SDK are voice.js, fetched
 * when a visitor starts a call. A call is part of the conversation that is open: its turns arrive as messages.
 */
(function () {
  "use strict";
  if (window.__growthxaiWebchatPanel) return;

  // ---------------------------------------------------------------- i18n --------------------------------------------
  var STR = {
    en: { chat: "Chat with us", close: "Close", send: "Send", placeholder: "Ask a question…", start: "Start a conversation", cont: "Continue conversation", newconv: "New conversation", prev: "Previous conversations", online: "We're online", offline: "We're away at the moment", minutes: "Replies in a few minutes", hours: "Replies in a few hours", day: "Replies within a day", back_at: "We're away — back {when}", tomorrow: "tomorrow", soon: "We'll reply as soon as we can", ai: "AI", you: "You", talk: "Talk to a person", sources: "Sources", helpful: "Helpful", nothelpful: "Not helpful", thanks: "Thanks for your feedback", retry: "Retry", failed: "Not sent", sent: "Sent", read: "Read", typing: "{name} is typing…", closed: "This conversation is closed — start a new one", end: "End conversation", ended: "Conversation ended", rate: "How was this conversation?", comment: "Tell us more (optional)", submit: "Submit", rated: "Thanks for your rating", email_ph: "you@example.com", name_ph: "Your name", phone_ph: "+1 555 0100", required: "Required", invalid_email: "Enter a valid email", invalid_phone: "Enter a valid phone number", transcript: "Email me this conversation", transcript_sent: "Transcript sent", transcript_email: "Where should we send it?", sound_on: "Sound on", sound_off: "Sound off", popout: "Open in a new window", attach: "Attach a file", emoji: "Add an emoji", too_large: "File too large (max {mb} MB)", bad_type: "This file type is not allowed", limit: "Messages can be up to 5,000 characters", rate_limited: "You're sending too fast — try again in a moment", verify_failed: "We couldn't confirm you're not a robot. Please try again.", error: "Something went wrong. Please try again.", offline_q: "You're offline — we'll send this when you're back", today: "Today", yesterday: "Yesterday", powered: "Powered by", brand: "GrowthxAI", privacy: "By chatting with us, you agree to our {link}", privacy_link: "Privacy Policy", back: "Back", menu: "Menu", ai_note: "Answers by AI assistant. Ask for a person any time.", handoff: "Connecting you with a person…", copy: "Copy", copied: "Copied", download: "Download", consent_err: "Please accept to continue", campaign_reply: "Reply", closepanel: "Close chat", team: "Team", download_transcript: "Download transcript", just_now: "Just now", ai_agent: "AI Agent", video: "Watch video", cancel: "Cancel", view: "View", ask_about: "Ask", add_cart: "Add to cart", added: "Added ✓", view_cart: "View cart", oos: "Out of stock", tell_more: "Tell me more about {title}", prev_cards: "Previous products", next_cards: "More products",
          msgs: "Messages", new_chat: "Start a new chat", see_all: "See all", talk: "Talk to us", talk_hint: "Speak with our AI assistant", call: "Start a voice call", voice_consent: "You'll be speaking with an AI assistant.", voice_rec: "The call may be recorded and transcribed to help us reply.", voice_norec: "The call is transcribed to help us reply.", start_call: "Start call", not_now: "Not now", voice_mic: "Microphone is blocked. Allow it in your browser's site settings, or keep typing.", voice_unavailable: "Voice isn't available right now. You can keep chatting here.", call_live: "Voice call in progress", call_ended: "Call ended", continue_voice: "Continue by voice", connecting: "Connecting…" },
    hi: { chat: "हमसे चैट करें", send: "भेजें", placeholder: "सवाल पूछें…", privacy: "हमसे चैट करके आप हमारी {link} से सहमत होते हैं", privacy_link: "गोपनीयता नीति", start: "बातचीत शुरू करें", cont: "बातचीत जारी रखें", newconv: "नई बातचीत", prev: "पिछली बातचीत", online: "हम ऑनलाइन हैं", offline: "हम अभी उपलब्ध नहीं हैं", minutes: "आमतौर पर कुछ मिनटों में जवाब", hours: "आमतौर पर कुछ घंटों में जवाब", day: "आमतौर पर एक दिन में जवाब", back_at: "हम बाहर हैं — {when} वापस", tomorrow: "कल", soon: "हम जल्द ही जवाब देंगे", you: "आप", talk: "किसी व्यक्ति से बात करें", sources: "स्रोत", helpful: "उपयोगी", nothelpful: "उपयोगी नहीं", thanks: "आपकी प्रतिक्रिया के लिए धन्यवाद", retry: "फिर कोशिश करें", failed: "नहीं भेजा गया", closed: "यह बातचीत बंद है — नई शुरू करें", end: "बातचीत समाप्त करें", rate: "यह बातचीत कैसी रही?", comment: "और बताएं (वैकल्पिक)", submit: "भेजें", rated: "रेटिंग के लिए धन्यवाद", required: "आवश्यक", invalid_email: "सही ईमेल दर्ज करें", transcript: "यह बातचीत ईमेल करें", error: "कुछ गलत हो गया। फिर कोशिश करें।", today: "आज", yesterday: "कल", handoff: "आपको एक व्यक्ति से जोड़ रहे हैं…", back: "वापस", download_transcript: "ट्रांसक्रिप्ट डाउनलोड करें", just_now: "अभी", ai_agent: "AI एजेंट", video: "वीडियो देखें", cancel: "रद्द करें", view: "देखें", ask_about: "पूछें", add_cart: "कार्ट में जोड़ें", added: "जोड़ा गया ✓", view_cart: "कार्ट देखें", oos: "स्टॉक में नहीं", tell_more: "{title} के बारे में और बताएं", talk: "हमसे बात करें", talk_hint: "हमारे AI असिस्टेंट से बात करें", call: "वॉइस कॉल शुरू करें", voice_consent: "आप एक AI असिस्टेंट से बात करेंगे।", voice_rec: "जवाब देने में मदद के लिए कॉल रिकॉर्ड और ट्रांसक्राइब की जा सकती है।", voice_norec: "जवाब देने में मदद के लिए कॉल ट्रांसक्राइब की जाती है।", start_call: "कॉल शुरू करें", not_now: "अभी नहीं", voice_mic: "माइक्रोफ़ोन ब्लॉक है। ब्राउज़र की साइट सेटिंग में अनुमति दें, या टाइप करते रहें।", voice_unavailable: "वॉइस अभी उपलब्ध नहीं है। आप यहाँ चैट जारी रख सकते हैं।", call_live: "वॉइस कॉल चल रही है", call_ended: "कॉल समाप्त", continue_voice: "आवाज़ से जारी रखें", connecting: "जोड़ रहे हैं…" },
    es: { chat: "Chatea con nosotros", send: "Enviar", placeholder: "Haz una pregunta…", privacy: "Al chatear con nosotros, aceptas nuestra {link}", privacy_link: "Política de privacidad", start: "Iniciar conversación", cont: "Continuar conversación", newconv: "Nueva conversación", prev: "Conversaciones anteriores", online: "Estamos en línea", offline: "No estamos disponibles ahora", minutes: "Suele responder en unos minutos", hours: "Suele responder en unas horas", day: "Suele responder en un día", back_at: "Volvemos {when}", tomorrow: "mañana", soon: "Responderemos lo antes posible", you: "Tú", talk: "Hablar con una persona", sources: "Fuentes", helpful: "Útil", nothelpful: "No útil", thanks: "Gracias por tu opinión", retry: "Reintentar", failed: "No enviado", closed: "Esta conversación está cerrada — inicia una nueva", end: "Terminar conversación", rate: "¿Cómo fue esta conversación?", comment: "Cuéntanos más (opcional)", submit: "Enviar", rated: "Gracias por tu valoración", required: "Obligatorio", invalid_email: "Introduce un email válido", transcript: "Enviarme esta conversación", error: "Algo salió mal. Inténtalo de nuevo.", today: "Hoy", yesterday: "Ayer", handoff: "Conectándote con una persona…", back: "Atrás", download_transcript: "Descargar transcripción", just_now: "Ahora mismo", ai_agent: "Agente de IA", video: "Ver el video", cancel: "Cancelar", view: "Ver", ask_about: "Preguntar", add_cart: "Añadir al carrito", added: "Añadido ✓", view_cart: "Ver carrito", oos: "Agotado", tell_more: "Cuéntame más sobre {title}", talk: "Habla con nosotros", talk_hint: "Habla con nuestro asistente de IA", call: "Iniciar una llamada de voz", voice_consent: "Vas a hablar con un asistente de IA.", voice_rec: "La llamada puede grabarse y transcribirse para ayudarnos a responder.", voice_norec: "La llamada se transcribe para ayudarnos a responder.", start_call: "Iniciar llamada", not_now: "Ahora no", voice_mic: "El micrófono está bloqueado. Permítelo en los ajustes del sitio de tu navegador, o sigue escribiendo.", voice_unavailable: "La voz no está disponible ahora. Puedes seguir por chat.", call_live: "Llamada de voz en curso", call_ended: "Llamada terminada", continue_voice: "Continuar por voz", connecting: "Conectando…" },
    fr: { chat: "Discutez avec nous", send: "Envoyer", placeholder: "Posez une question…", privacy: "En discutant avec nous, vous acceptez notre {link}", privacy_link: "Politique de confidentialité", start: "Démarrer une conversation", cont: "Continuer la conversation", newconv: "Nouvelle conversation", prev: "Conversations précédentes", online: "Nous sommes en ligne", offline: "Nous sommes absents", minutes: "Répond généralement en quelques minutes", hours: "Répond généralement en quelques heures", day: "Répond généralement en un jour", back_at: "De retour {when}", tomorrow: "demain", soon: "Nous répondrons dès que possible", you: "Vous", talk: "Parler à une personne", sources: "Sources", helpful: "Utile", nothelpful: "Pas utile", thanks: "Merci pour votre retour", retry: "Réessayer", failed: "Non envoyé", closed: "Cette conversation est fermée — commencez-en une nouvelle", end: "Terminer la conversation", rate: "Comment s'est passée cette conversation ?", comment: "Dites-nous en plus (facultatif)", submit: "Envoyer", rated: "Merci pour votre note", required: "Obligatoire", invalid_email: "Entrez un e-mail valide", transcript: "M'envoyer cette conversation", error: "Une erreur est survenue. Réessayez.", today: "Aujourd'hui", yesterday: "Hier", handoff: "Mise en relation avec une personne…", back: "Retour", download_transcript: "Télécharger la transcription", just_now: "À l'instant", ai_agent: "Agent IA", video: "Voir la vidéo", cancel: "Annuler", view: "Voir", ask_about: "Demander", add_cart: "Ajouter au panier", added: "Ajouté ✓", view_cart: "Voir le panier", oos: "En rupture", tell_more: "Dites-m'en plus sur {title}", talk: "Parlez-nous", talk_hint: "Parlez à notre assistant IA", call: "Démarrer un appel vocal", voice_consent: "Vous allez parler à un assistant IA.", voice_rec: "L'appel peut être enregistré et transcrit pour nous aider à répondre.", voice_norec: "L'appel est transcrit pour nous aider à répondre.", start_call: "Démarrer l'appel", not_now: "Pas maintenant", voice_mic: "Le micro est bloqué. Autorisez-le dans les réglages du site de votre navigateur, ou continuez à écrire.", voice_unavailable: "La voix n'est pas disponible pour le moment. Vous pouvez continuer par chat.", call_live: "Appel vocal en cours", call_ended: "Appel terminé", continue_voice: "Continuer à la voix", connecting: "Connexion…" },
    de: { chat: "Chatte mit uns", send: "Senden", placeholder: "Stell eine Frage…", privacy: "Mit dem Chat stimmst du unserer {link} zu", privacy_link: "Datenschutzerklärung", start: "Unterhaltung starten", cont: "Unterhaltung fortsetzen", newconv: "Neue Unterhaltung", prev: "Frühere Unterhaltungen", online: "Wir sind online", offline: "Wir sind gerade nicht da", minutes: "Antwortet meist in wenigen Minuten", hours: "Antwortet meist in einigen Stunden", day: "Antwortet meist innerhalb eines Tages", back_at: "Wieder da {when}", tomorrow: "morgen", soon: "Wir antworten so schnell wie möglich", you: "Du", talk: "Mit einer Person sprechen", sources: "Quellen", helpful: "Hilfreich", nothelpful: "Nicht hilfreich", thanks: "Danke für dein Feedback", retry: "Erneut senden", failed: "Nicht gesendet", closed: "Diese Unterhaltung ist beendet — starte eine neue", end: "Unterhaltung beenden", rate: "Wie war diese Unterhaltung?", comment: "Erzähl uns mehr (optional)", submit: "Absenden", rated: "Danke für deine Bewertung", required: "Pflichtfeld", invalid_email: "Gib eine gültige E-Mail ein", transcript: "Unterhaltung per E-Mail senden", error: "Etwas ist schiefgelaufen. Bitte erneut versuchen.", today: "Heute", yesterday: "Gestern", handoff: "Wir verbinden dich mit einer Person…", back: "Zurück", download_transcript: "Transkript herunterladen", just_now: "Gerade eben", ai_agent: "KI-Agent", video: "Video ansehen", cancel: "Abbrechen", view: "Ansehen", ask_about: "Fragen", add_cart: "In den Warenkorb", added: "Hinzugefügt ✓", view_cart: "Warenkorb ansehen", oos: "Nicht vorrätig", tell_more: "Erzähl mir mehr über {title}", talk: "Sprich mit uns", talk_hint: "Sprich mit unserem KI-Assistenten", call: "Sprachanruf starten", voice_consent: "Du sprichst mit einem KI-Assistenten.", voice_rec: "Der Anruf kann aufgezeichnet und transkribiert werden, damit wir antworten können.", voice_norec: "Der Anruf wird transkribiert, damit wir antworten können.", start_call: "Anruf starten", not_now: "Jetzt nicht", voice_mic: "Das Mikrofon ist blockiert. Erlaube es in den Website-Einstellungen deines Browsers oder tippe weiter.", voice_unavailable: "Sprache ist gerade nicht verfügbar. Du kannst hier weiterchatten.", call_live: "Sprachanruf läuft", call_ended: "Anruf beendet", continue_voice: "Per Sprache fortfahren", connecting: "Verbinden…" },
    pt: { chat: "Fale conosco", send: "Enviar", placeholder: "Faça uma pergunta…", privacy: "Ao conversar conosco, você concorda com a nossa {link}", privacy_link: "Política de Privacidade", start: "Iniciar conversa", cont: "Continuar conversa", newconv: "Nova conversa", prev: "Conversas anteriores", online: "Estamos online", offline: "Estamos ausentes no momento", minutes: "Normalmente responde em minutos", hours: "Normalmente responde em algumas horas", day: "Normalmente responde em um dia", back_at: "Voltamos {when}", tomorrow: "amanhã", soon: "Responderemos o mais rápido possível", you: "Você", talk: "Falar com uma pessoa", sources: "Fontes", helpful: "Útil", nothelpful: "Não útil", thanks: "Obrigado pelo feedback", retry: "Tentar de novo", failed: "Não enviado", closed: "Esta conversa foi encerrada — inicie uma nova", end: "Encerrar conversa", rate: "Como foi esta conversa?", comment: "Conte mais (opcional)", submit: "Enviar", rated: "Obrigado pela avaliação", required: "Obrigatório", invalid_email: "Digite um e-mail válido", transcript: "Enviar esta conversa por e-mail", error: "Algo deu errado. Tente novamente.", today: "Hoje", yesterday: "Ontem", handoff: "Conectando você a uma pessoa…", back: "Voltar", download_transcript: "Baixar transcrição", just_now: "Agora mesmo", ai_agent: "Agente de IA", video: "Ver o vídeo", cancel: "Cancelar", view: "Ver", ask_about: "Perguntar", add_cart: "Adicionar ao carrinho", added: "Adicionado ✓", view_cart: "Ver carrinho", oos: "Esgotado", tell_more: "Conte-me mais sobre {title}", talk: "Fale conosco por voz", talk_hint: "Fale com nosso assistente de IA", call: "Iniciar chamada de voz", voice_consent: "Você vai falar com um assistente de IA.", voice_rec: "A chamada pode ser gravada e transcrita para nos ajudar a responder.", voice_norec: "A chamada é transcrita para nos ajudar a responder.", start_call: "Iniciar chamada", not_now: "Agora não", voice_mic: "O microfone está bloqueado. Permita nas configurações do site no navegador, ou continue digitando.", voice_unavailable: "A voz não está disponível agora. Você pode continuar pelo chat.", call_live: "Chamada de voz em andamento", call_ended: "Chamada encerrada", continue_voice: "Continuar por voz", connecting: "Conectando…" },
    ar: { chat: "تحدث معنا", send: "إرسال", placeholder: "اطرح سؤالاً…", privacy: "بمحادثتك معنا، فإنك توافق على {link}", privacy_link: "سياسة الخصوصية", start: "ابدأ محادثة", cont: "متابعة المحادثة", newconv: "محادثة جديدة", prev: "المحادثات السابقة", online: "نحن متصلون", offline: "نحن غير متاحين الآن", minutes: "عادةً نرد خلال دقائق", hours: "عادةً نرد خلال ساعات", day: "عادةً نرد خلال يوم", back_at: "سنعود {when}", tomorrow: "غدًا", soon: "سنرد في أقرب وقت", you: "أنت", talk: "التحدث مع شخص", sources: "المصادر", helpful: "مفيد", nothelpful: "غير مفيد", thanks: "شكرًا لملاحظاتك", retry: "إعادة المحاولة", failed: "لم يُرسل", closed: "هذه المحادثة مغلقة — ابدأ محادثة جديدة", end: "إنهاء المحادثة", rate: "كيف كانت هذه المحادثة؟", comment: "أخبرنا المزيد (اختياري)", submit: "إرسال", rated: "شكرًا لتقييمك", required: "مطلوب", invalid_email: "أدخل بريدًا إلكترونيًا صالحًا", transcript: "أرسل لي هذه المحادثة", error: "حدث خطأ ما. حاول مرة أخرى.", today: "اليوم", yesterday: "أمس", handoff: "جارٍ توصيلك بشخص…", back: "رجوع", download_transcript: "تنزيل المحادثة", just_now: "الآن", ai_agent: "وكيل ذكاء اصطناعي", video: "مشاهدة الفيديو", cancel: "إلغاء", view: "عرض", ask_about: "اسأل", add_cart: "أضف إلى السلة", added: "تمت الإضافة ✓", view_cart: "عرض السلة", oos: "غير متوفر", tell_more: "أخبرني المزيد عن {title}", talk: "تحدث إلينا", talk_hint: "تحدث مع مساعدنا الذكي", call: "بدء مكالمة صوتية", voice_consent: "ستتحدث مع مساعد يعمل بالذكاء الاصطناعي.", voice_rec: "قد تُسجَّل المكالمة وتُحوَّل إلى نص لمساعدتنا في الرد.", voice_norec: "تُحوَّل المكالمة إلى نص لمساعدتنا في الرد.", start_call: "بدء المكالمة", not_now: "ليس الآن", voice_mic: "الميكروفون محظور. اسمح به من إعدادات الموقع في متصفحك، أو تابع الكتابة.", voice_unavailable: "الصوت غير متاح الآن. يمكنك المتابعة هنا كتابةً.", call_live: "مكالمة صوتية جارية", call_ended: "انتهت المكالمة", continue_voice: "المتابعة بالصوت", connecting: "جارٍ الاتصال…" }
  };
  var RTL = { ar: 1, he: 1, fa: 1, ur: 1 };
  var EMOJIS = "😀 😃 😄 😁 😆 😅 😂 🙂 😉 😊 😍 😘 😎 🤔 😐 😕 🙁 😢 😭 😤 😡 👍 👎 👏 🙏 💪 🙌 👋 ❤️ 💔 🔥 ✨ 🎉 ✅ ❌ ⭐ 💡 📎 📅 📞 ✉️ 🚀 🤝 👀 💬 🙈 🤷 🤩".split(" ");

  // ---------------------------------------------------------------- utils -------------------------------------------
  var doc = document, win = window;
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function safeUrl(u) { u = String(u || "").trim(); return /^(https?:|mailto:|tel:)/i.test(u) ? u : (/^\//.test(u) ? u : "#"); }
  function safeColor(c, d) { return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(c || "")) ? c : d; }
  function uid() { return (win.crypto && crypto.randomUUID) ? crypto.randomUUID() : "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); }
  function el(tag, cls, html) { var n = doc.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; }
  function debounce(f, ms) { var t; return function () { var a = arguments, s = this; clearTimeout(t); t = setTimeout(function () { f.apply(s, a); }, ms); }; }
  function hexToRgb(h) { h = h.replace("#", ""); if (h.length === 3) h = h.split("").map(function (c) { return c + c; }).join(""); var n = parseInt(h, 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
  function luminance(h) { var c = hexToRgb(h).map(function (v) { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }); return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]; }
  function contrastText(h) { return luminance(h) > .5 ? "#111827" : "#ffffff"; }
  function shade(h, amt) { var c = hexToRgb(h).map(function (v) { return Math.max(0, Math.min(255, Math.round(v + amt))); }); return "#" + c.map(function (v) { return ("0" + v.toString(16)).slice(-2); }).join(""); }
  function md(src, allow) {
    if (!allow) return "<p>" + esc(src).replace(/\n/g, "<br>") + "</p>";
    var lines = String(src || "").replace(/\s*\[\d+\]/g, "").split("\n"), html = "", i = 0;
    function inline(t) {
      t = esc(t).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*\w])\*([^*]+)\*/g, "$1<em>$2</em>").replace(/(^|[^_\w])_([^_]+)_/g, "$1<em>$2</em>");
      t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_, a, u) { return '<a href="' + esc(safeUrl(u)) + '" target="_blank" rel="noopener noreferrer">' + a + "</a>"; });
      t = t.replace(/(^|[\s(])((?:https?:\/\/)[^\s<)]+)/g, function (_, p, u) { return p + '<a href="' + esc(safeUrl(u)) + '" target="_blank" rel="noopener noreferrer">' + u + "</a>"; });
      return t;
    }
    while (i < lines.length) {
      var ln = lines[i];
      if (/^```/.test(ln)) { var buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i++; html += "<pre><code>" + esc(buf.join("\n")) + "</code></pre>"; continue; }
      if (/^\s*[-*•]\s+/.test(ln)) { html += "<ul>"; while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) { html += "<li>" + inline(lines[i].replace(/^\s*[-*•]\s+/, "")) + "</li>"; i++; } html += "</ul>"; continue; }
      if (/^\s*\d+[.)]\s+/.test(ln)) { html += "<ol>"; while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { html += "<li>" + inline(lines[i].replace(/^\s*\d+[.)]\s+/, "")) + "</li>"; i++; } html += "</ol>"; continue; }
      if (ln.trim() === "") { i++; continue; }
      var para = []; while (i < lines.length && lines[i].trim() !== "" && !/^(```|\s*[-*•]\s|\s*\d+[.)]\s)/.test(lines[i])) para.push(lines[i++]);
      html += "<p>" + inline(para.join("\n")).replace(/\n/g, "<br>") + "</p>";
    }
    return html;
  }
  function fmtTime(d) { try { return new Date(d).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); } catch (e) { return ""; } }
  function dayLabel(d, T) { var x = new Date(d), n = new Date(); var same = function (a, b) { return a.toDateString() === b.toDateString(); }; if (same(x, n)) return T("today"); n.setDate(n.getDate() - 1); if (same(x, n)) return T("yesterday"); return x.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }); }
  function initials(n) { return String(n || "?").split(/\s+/).slice(0, 2).map(function (p) { return p.charAt(0).toUpperCase(); }).join(""); }
  function sanitizeCss(css) { return String(css || "").replace(/@import[^;]*;?/gi, "").replace(/expression\s*\(/gi, "").replace(/url\((?!\s*['"]?(?:https:|data:image\/))[^)]*\)/gi, "url()").replace(/<\/style/gi, "").slice(0, 20000); }

  // ---------------------------------------------------------------- minimal Phoenix realtime client -------------------
  function Realtime(url, key) {
    var ws = null, ref = 1, hb = null, topics = {}, backoff = 1000, closed = false, self = this, connected = false;
    this.connected = function () { return connected; };
    function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
    function connect() {
      if (closed) return;
      try { ws = new WebSocket(url + "?apikey=" + encodeURIComponent(key) + "&vsn=1.0.0"); } catch (e) { retry(); return; }
      ws.onopen = function () { connected = true; backoff = 1000; hb = setInterval(function () { send({ topic: "phoenix", event: "heartbeat", payload: {}, ref: String(ref++) }); }, 25000); Object.keys(topics).forEach(join); self.onstate && self.onstate(true); };
      ws.onmessage = function (ev) {
        var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        var t = topics[m.topic]; if (!t) return;
        if (m.event === "broadcast" && m.payload) t.cb(m.payload.event, m.payload.payload);
      };
      ws.onclose = function () { connected = false; clearInterval(hb); self.onstate && self.onstate(false); retry(); };
      ws.onerror = function () { try { ws.close(); } catch (e) {} };
    }
    function retry() { if (closed) return; setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 30000); }
    function join(topic) { send({ topic: topic, event: "phx_join", payload: { config: { broadcast: { self: false, ack: false }, presence: { key: "" }, postgres_changes: [], private: false } }, ref: String(ref++) }); }
    this.subscribe = function (topic, cb) { topic = "realtime:" + topic; if (topics[topic]) { topics[topic].cb = cb; return; } topics[topic] = { cb: cb }; if (connected) join(topic); };
    this.unsubscribe = function (topic) { topic = "realtime:" + topic; if (!topics[topic]) return; send({ topic: topic, event: "phx_leave", payload: {}, ref: String(ref++) }); delete topics[topic]; };
    this.close = function () { closed = true; clearInterval(hb); try { ws && ws.close(); } catch (e) {} };
    if ("WebSocket" in win) connect();
  }

  // ================================================================ panel factory ====================================
  win.__growthxaiWebchatPanel = function (sdk, cfg, eff) {
    var L = sdk._loader, API = L.api, TOKEN = L.token, store = L.store, settings = sdk.settings || {};
    var S = { cfg: cfg, eff: eff, open: false, view: "home", vt: store.get("vt"), visitor: null, convs: [], conv: null, msgs: [], byId: {}, pending: {}, agentTyping: null, aiStream: null,
              rt: null, poll: null, hbTimer: null, mode: null, locale: "en", muted: !!store.get("muted"), unreadPrev: [], mounted: false, sending: false, campaignTimers: [], lastConfigVersion: cfg.config_version, files: [],
              nextContext: null,   // what a button said about the next question (data-growthxai-context, a selection, "product:<ref>"); sent with that message, never shown
              cart: {}, badImg: {}, shownP: {} };   // product cards: add-to-cart state per card, pictures that failed, messages already counted as shown
    var host, shadow, sheet, root, ui = {}, bc = null, focusBefore = null, listeners = [];
    var T = function (k, vars) { var s = (STR[S.locale] && STR[S.locale][k]) || STR.en[k] || k; return vars ? s.replace(/\{(\w+)\}/g, function (_, v) { return vars[v] != null ? vars[v] : ""; }) : s; };
    function t2(k) { var o = S.eff.locale && S.eff.locale.strings && S.eff.locale.strings[S.locale]; return (o && o[k]) || null; }

    // ---------------------------------------------------------------- api -------------------------------------------
    function api(method, path, body, opts) {
      opts = opts || {};
      var h = { "content-type": "application/json", "x-website-token": TOKEN };
      if (S.vt && !opts.noAuth) h.authorization = "Bearer " + S.vt;
      return fetch(API + path + (path.indexOf("?") >= 0 ? "&" : "?") + "token=" + encodeURIComponent(TOKEN), { method: method, headers: h, body: body != null ? JSON.stringify(body) : undefined, keepalive: !!opts.keepalive })
        .then(function (r) {
          if (r.status === 401 && !opts.noAuth && !opts.retried) { S.vt = null; store.del("vt"); return ensureVisitor().then(function () { return api(method, path, body, Object.assign({}, opts, { retried: true })); }); }
          if (opts.raw) return r;
          return r.text().then(function (t) { var j = {}; try { j = t ? JSON.parse(t) : {}; } catch (e) {} if (!r.ok) { var e2 = new Error(j.error || ("http " + r.status)); e2.code = j.code || (r.status === 429 ? "E_RATE_LIMITED" : "E_HTTP"); e2.status = r.status; throw e2; } return j; });
        });
    }
    var visitorP = null;
    function ensureVisitor() {
      if (S.visitor && S.vt) return Promise.resolve(S.visitor);
      if (visitorP) return visitorP;
      var utm = {}; try { new URL(location.href).searchParams.forEach(function (v, k) { if (/^utm_/i.test(k) || k === "ref") utm[k] = v.slice(0, 200); }); } catch (e) {}
      var body = { visitor_token: S.vt || store.get("vt") || null, locale: S.locale, timezone: (Intl.DateTimeFormat().resolvedOptions() || {}).timeZone, referrer: doc.referrer || null, landing_url: location.href, utm: Object.keys(utm).length ? utm : null, page: { url: location.href, title: doc.title } };
      visitorP = api("POST", "/visitor", body, { noAuth: true }).then(function (r) {
        S.vt = r.visitor_token; store.set("vt", S.vt); S.visitor = r.visitor; S.convs = r.conversations || []; noteLive(); S.blocked = !!r.blocked; if (S.mounted) syncPrivacy();
        if (S.visitor && S.visitor.identifier) L.identified(true);
        visitorP = null; return S.visitor;
      }, function (e) { visitorP = null; throw e; });
      return visitorP;
    }

    // ---------------------------------------------------------------- styles ----------------------------------------
    function styles() {
      var e = S.eff, ap = e.appearance || {}, accent = safeColor(ap.accent, "#4f46e5"), onAccent = contrastText(accent), dark = isDark();
      var bg = dark ? "#111827" : safeColor(ap.widget_bg, "#ffffff"), chatBg = dark ? "#0b1220" : safeColor(ap.chat_bg, "#f8f8fa"), ink = dark ? "#f3f4f6" : "#111827", ink2 = dark ? "#9ca3af" : "#6b7280", line = dark ? "#1f2937" : "#e5e7eb", card = dark ? "#1f2937" : "#ffffff";
      var font = (ap.font && ap.font !== "Inter" ? ap.font.replace(/[^\w\s,-]/g, "") + "," : "") + "Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif";
      var w = Math.min(720, Math.max(320, parseInt(ap.panel_width, 10) || 384)), z = parseInt(ap.z_index, 10) || 2147483000, side = ap.drawer_side === "left" ? "left" : "right";
      var lpos = (isMobile() ? Object.assign({}, e.launcher.desktop, e.launcher.mobile) : e.launcher.desktop) || {}, lside = lpos.position === "left" ? "left" : "right", lsize = { sm: 48, md: 56, lg: 64 }[lpos.size] || 56;
      var sb = luminance(chatBg) < .4 ? "rgba(255,255,255,.16)" : "rgba(17,24,39,.2)";   // scrollbar thumb: a quiet tint of the chat background, no track
      return ":host{all:initial}*,*::before,*::after{box-sizing:border-box}" +
        ".root{--accent:" + accent + ";--on-accent:" + onAccent + ";--accent-2:" + shade(accent, dark ? 40 : -20) + ";--bg:" + bg + ";--chat:" + chatBg + ";--ink:" + ink + ";--ink2:" + ink2 + ";--line:" + line + ";--card:" + card + ";--sb:" + sb + ";font:14px/1.45 " + font + ";color:var(--ink);z-index:" + z + ";direction:" + (RTL[S.locale] ? "rtl" : "ltr") + "}" +
        // Chromium / Safari take the ::-webkit-scrollbar rules (no arrows, no track); the standard properties are for Firefox only, because setting them makes Chromium drop the ::-webkit rules
        ".panel ::-webkit-scrollbar{width:10px;height:10px}.panel ::-webkit-scrollbar-track,.panel ::-webkit-scrollbar-corner{background:transparent}.panel ::-webkit-scrollbar-thumb{background:var(--sb);border-radius:8px;border:2px solid transparent;background-clip:padding-box}.panel ::-webkit-scrollbar-button{display:none}" +
        "@supports not selector(::-webkit-scrollbar){.panel,.panel *{scrollbar-width:thin;scrollbar-color:var(--sb) transparent}}" +
        ".panel{position:fixed;display:flex;flex-direction:column;background:var(--bg);color:var(--ink);overflow:hidden;box-shadow:0 18px 60px rgba(0,0,0,.24);opacity:0;pointer-events:none;transition:transform .22s cubic-bezier(.34,1.3,.64,1),opacity .2s;z-index:" + z + "}" +
        ".panel.open{opacity:1;pointer-events:auto}" +
        ".mode-bubble .panel{width:" + w + "px;max-width:calc(100vw - 32px);height:640px;max-height:calc(100dvh - " + (lsize + (lpos.margin_bottom || 24) + 24) + "px);bottom:" + (lsize + (lpos.margin_bottom || 24) + 12) + "px;" + lside + ":" + (lpos.margin_side || 24) + "px;border-radius:18px;transform:scale(.94) translateY(8px);transform-origin:bottom " + lside + "}.mode-bubble .panel.open{transform:none}" +
        ".mode-drawer .panel,.mode-inline .panel{top:0;bottom:0;" + side + ":0;width:" + w + "px;max-width:100vw;height:100dvh;transform:translateX(" + (side === "left" ? "-" : "") + "105%)}.mode-drawer .panel.open,.mode-inline .panel.open{transform:none}" +
        ".mode-sidebar .panel{top:0;bottom:0;" + side + ":0;width:var(--sbw," + w + "px);max-width:100vw;height:100dvh;transform:translateX(" + (side === "left" ? "-" : "") + "105%);box-shadow:none;border-" + (side === "left" ? "right" : "left") + ":1px solid var(--line)}.mode-sidebar .panel.open{transform:none}" +
        ".resizer{position:absolute;top:0;bottom:0;" + (side === "left" ? "right" : "left") + ":-4px;width:8px;cursor:col-resize;display:none}.mode-sidebar .resizer{display:block}" +
        ".mode-modal .panel{top:50%;left:50%;width:min(680px,calc(100vw - 32px));height:min(640px,calc(100dvh - 48px));border-radius:18px;transform:translate(-50%,-50%) scale(.96)}.mode-modal .panel.open{transform:translate(-50%,-50%)}" +
        ".backdrop{position:fixed;inset:0;background:rgba(0,0,0,.35);opacity:0;pointer-events:none;transition:opacity .2s;z-index:" + (z - 1) + "}.mode-drawer .backdrop.open,.mode-modal .backdrop.open,.mode-inline .backdrop.open{opacity:1;pointer-events:auto}" +
        ".mode-embedded .panel{position:relative;width:100%;height:100%;min-height:480px;box-shadow:none;opacity:1;pointer-events:auto;transform:none;border-radius:0}" +
        "@media(max-width:640px){.mode-bubble .panel,.mode-drawer .panel,.mode-inline .panel,.mode-sidebar .panel,.mode-modal .panel{inset:0;width:100vw;max-width:100vw;height:100dvh;max-height:100dvh;border-radius:0;transform:translateY(100%)}.mode-bubble .panel.open,.mode-drawer .panel.open,.mode-inline .panel.open,.mode-sidebar .panel.open,.mode-modal .panel.open{transform:none}.panel .cp textarea,.panel .cp .ask input,.panel .form input,.panel .form select,.panel .form textarea{font-size:16px}}" +
        ".panel{touch-action:manipulation;-webkit-text-size-adjust:100%;text-size-adjust:100%}" +
        ".hd{background:var(--accent);color:var(--on-accent);padding:14px 16px;display:flex;align-items:center;gap:10px;flex:0 0 auto}.hd .logo{width:40px;height:40px;border-radius:50%;background:rgba(255,255,255,.22);display:flex;align-items:center;justify-content:center;overflow:hidden;flex:0 0 auto;font-weight:700}.hd .logo img{display:block;width:100%;height:100%;object-fit:contain}" +
        ".hd .ttl{font-weight:700;font-size:15px;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.hd .sub{font-size:12px;opacity:.9;display:flex;align-items:center;gap:6px;min-width:0}.hd .sub>span:last-child{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}.hd .sub .dot{width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 0 2px rgba(255,255,255,.35);flex:0 0 auto}.hd .sub .dot.off{background:#9ca3af}" +
        ".hd .grow{flex:1;min-width:0}.hd .ib{width:34px;height:34px;border:0;border-radius:10px;background:transparent;color:inherit;cursor:pointer;display:flex;align-items:center;justify-content:center;opacity:.9}.hd .ib:hover{background:rgba(255,255,255,.18);opacity:1}.hd .ib svg{width:20px;height:20px}" +
        ".menu{position:absolute;top:56px;" + (RTL[S.locale] ? "left" : "right") + ":10px;background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.18);padding:6px;min-width:220px;z-index:5}.menu button{display:flex;width:100%;text-align:start;gap:10px;align-items:center;padding:9px 10px;border:0;background:transparent;color:inherit;border-radius:8px;cursor:pointer;font:inherit}.menu button:hover,.menu button:focus-visible{background:var(--chat)}.menu svg{width:16px;height:16px;color:var(--ink2)}" +
        ".body{flex:1;min-height:0;overflow-y:auto;background:var(--chat);padding:14px 14px 6px;overscroll-behavior:contain;scroll-behavior:smooth}" +
        ".home{padding:22px 18px}.home h2{margin:0 0 4px;font-size:22px;line-height:1.2}.home p{margin:0 0 16px;color:var(--ink2)}" +
        ".hl{display:flex;align-items:center;justify-content:space-between;margin:2px 0;font-size:12px;font-weight:600;color:var(--ink2)}.hl button{border:0;background:none;padding:2px 0;color:var(--accent);font:inherit;cursor:pointer}" +
        ".rows{display:flex;flex-direction:column;margin:0 -18px 14px}.row{display:flex;align-items:center;gap:11px;width:100%;box-sizing:border-box;padding:10px 18px;border:0;border-bottom:1px solid var(--line);background:transparent;color:var(--ink);font:inherit;text-align:start;cursor:pointer}.row:hover{background:var(--card)}.row:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}" +
        ".row .av{width:38px;height:38px;border-radius:50%;flex:0 0 auto;background:var(--card);border:1px solid var(--line);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;overflow:hidden}.row .av img{width:100%;height:100%;object-fit:cover}" +
        ".rm{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}.r1,.r2{display:flex;align-items:center;gap:8px;min-width:0}.r1 b{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px}.r1 time{flex:0 0 auto;font-size:11.5px;color:var(--ink2)}" +
        ".pv{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;color:var(--ink2)}.row.un .pv{color:var(--ink);font-weight:600}.ud{flex:0 0 auto;min-width:18px;height:18px;padding:0 5px;box-sizing:border-box;border-radius:9px;background:var(--accent);color:var(--on-accent);font-size:11px;font-style:normal;font-weight:700;display:flex;align-items:center;justify-content:center}" +
        ".hacts{display:flex;gap:8px;flex-wrap:wrap}.act{flex:1 1 130px;display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:9px 14px;border-radius:999px;border:1px solid var(--line);background:var(--card);color:var(--ink);font:inherit;font-weight:600;font-size:13.5px;cursor:pointer}.act:hover{border-color:var(--accent)}.act.pri{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}.act svg{width:16px;height:16px;flex:0 0 auto}.home .avl{margin:8px 0 0;font-size:12px;text-align:center}" +
        ".qp{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0 12px}.qp button{background:var(--card);border:1px solid var(--line);border-radius:999px;padding:7px 12px;cursor:pointer;font:inherit;color:var(--ink);text-align:start}.qp button:hover{border-color:var(--accent);color:var(--accent)}" +
        ".day{display:flex;align-items:center;gap:10px;color:var(--ink2);font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin:10px 0}.day::before,.day::after{content:'';flex:1;height:1px;background:var(--line)}" +
        ".msg{display:flex;gap:8px;margin:2px 0;align-items:flex-start}.msg.me{flex-direction:row-reverse}.msg .av{width:28px;height:28px;border-radius:50%;background:var(--card);border:1px solid var(--line);font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex:0 0 auto;overflow:hidden;visibility:hidden}.msg.first{margin-top:10px}.msg.first .av{visibility:visible}.msg .av img{width:100%;height:100%;object-fit:cover}.msg.me .av{display:none}" +
        ".msg .col{max-width:80%;min-width:0;display:flex;flex-direction:column;gap:2px}.msg.me .col{align-items:flex-end}" +
        ".bub{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:9px 13px;word-wrap:break-word;overflow-wrap:anywhere;position:relative}.msg.me .bub{background:var(--accent);color:var(--on-accent);border-color:var(--accent)}.msg.me .bub a{color:inherit}.bub p{margin:0 0 6px}.bub p:last-child{margin:0}.bub ul,.bub ol{margin:4px 0;padding-inline-start:20px}.bub a{color:var(--accent);text-decoration:underline}.bub code{background:rgba(0,0,0,.08);padding:1px 5px;border-radius:5px;font-size:.92em}.bub pre{background:#111827;color:#e5e7eb;padding:10px;border-radius:8px;overflow:auto}.bub pre code{background:none;color:inherit}" +
        ".bub img.pic{max-width:240px;max-height:240px;border-radius:10px;display:block;cursor:zoom-in}.file{display:flex;align-items:center;gap:8px;text-decoration:none;color:inherit;font-weight:500;cursor:pointer}.file svg{width:18px;height:18px;flex:0 0 auto}" +
        ".meta{font-size:11px;line-height:16px;color:var(--ink2);display:flex;gap:5px;align-items:center;margin:2px 4px 0;white-space:nowrap;max-width:100%}.meta .nm{overflow:hidden;text-overflow:ellipsis;min-width:0}" +
        ".meta .tick{font-size:11px}.meta .tick.read{color:var(--accent)}.meta .fail{color:#ef4444;cursor:pointer;text-decoration:underline}" +
        ".sys{text-align:center;color:var(--ink2);font-size:12px;margin:8px 0}" +
        ".typing{display:inline-flex;gap:4px;padding:10px 13px}.typing i{width:6px;height:6px;border-radius:50%;background:var(--ink2);animation:gxb 1.2s infinite}.typing i:nth-child(2){animation-delay:.2s}.typing i:nth-child(3){animation-delay:.4s}@keyframes gxb{0%,60%,100%{opacity:.3}30%{opacity:1}}" +
        ".cur{display:inline-block;width:7px;height:14px;background:var(--accent);margin-inline-start:1px;animation:gxbl 1s steps(2) infinite;vertical-align:-2px}@keyframes gxbl{50%{opacity:0}}" +
        ".src{margin-top:8px;font-size:12px}.src summary{cursor:pointer;color:var(--ink2)}.src a{display:block;color:var(--accent);margin:3px 0;text-decoration:none}" +
        ".fb{margin-top:8px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}.fb button{background:none;border:1px solid var(--line);border-radius:8px;cursor:pointer;padding:3px 9px;font:inherit;font-size:12px;color:var(--ink)}.fb button:hover{border-color:var(--accent)}.fb .ok{font-size:12px;color:#16a34a}" +
        ".acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.acts button,.acts a{background:var(--card);color:var(--accent);border:1px solid var(--accent);border-radius:999px;padding:6px 12px;cursor:pointer;font:inherit;font-size:13px;text-decoration:none}.acts button:disabled{opacity:.5;cursor:default}" +
        ".cards{display:flex;gap:10px;overflow-x:auto;scroll-snap-type:x mandatory;padding:6px 0 4px}.cardi{min-width:200px;max-width:220px;flex:0 0 auto;scroll-snap-align:start;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--card)}.cardi img{width:100%;height:120px;object-fit:cover;display:block}.cardi .ct{padding:8px 10px}.cardi b{display:block;font-size:13px}.cardi small{color:var(--ink2);display:block;margin:2px 0 6px}" +
        // product cards: the same row, a square picture, two lines of name, price, View / Ask (/ Add to cart); arrows on desktop when there is more than one
        ".pc{position:relative;margin-top:8px}.pc:first-child{margin-top:0}.pc .cards{scrollbar-width:none;scroll-behavior:smooth}.pc .cards::-webkit-scrollbar{display:none}" +
        ".pcard{width:168px;min-width:168px;max-width:168px;display:flex;flex-direction:column}.pcard .pi,.pcard .ph{display:block;width:100%;height:auto;aspect-ratio:1/1;object-fit:cover;background:var(--chat)}" +
        ".pcard .ph{display:flex;align-items:center;justify-content:center;font-size:40px;font-weight:700;color:#fff;background:linear-gradient(135deg," + shade(accent, 70) + "," + shade(accent, 10) + ")}" +
        ".pcard .ct{display:flex;flex-direction:column;flex:1;padding:8px 10px 10px}.pcard b{font-size:13px;line-height:1.3;min-height:34px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}" +
        ".pcard .pr{font-size:13px;font-weight:600;margin-top:4px;display:flex;flex-wrap:wrap;gap:6px;align-items:baseline}.pcard .pr s{font-weight:400;color:var(--ink2)}.pcard .oos{font-size:11px;color:#b45309;margin-top:2px}" +
        ".pcard .acts{margin-top:auto;padding-top:8px}.pcard .acts button,.pcard .acts a{flex:1 1 0;text-align:center;padding:6px 8px;font-size:12px;white-space:nowrap}" +
        ".pcard .acts .atc{flex:1 0 100%;background:var(--accent);color:var(--on-accent)}.pcard .acts .atc:disabled{opacity:.6}.pcard .acts .done{flex:1 0 100%;font-size:12px;color:#16a34a;text-align:center}.pcard .acts .done a{border:0;padding:0;color:inherit;text-decoration:underline;background:none}" +
        ".pc .nav{position:absolute;top:70px;width:28px;height:28px;padding:0;border-radius:50%;border:1px solid var(--line);background:var(--card);color:var(--ink);cursor:pointer;display:none;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,.14);z-index:1}.pc .nav svg{width:14px;height:14px}.pc .nav.l{left:-8px}.pc .nav.r{right:-8px}.pc .nav.l svg{transform:rotate(180deg)}" +
        "@media(hover:hover) and (min-width:641px){.pc.multi .nav{display:flex}}" +
        ".form{display:flex;flex-direction:column;gap:8px;margin-top:6px}.form label{font-size:12px;color:var(--ink2);display:block;margin-bottom:2px}.form input,.form select,.form textarea{width:100%;border:1px solid var(--line);border-radius:10px;padding:9px 11px;font:inherit;background:var(--card);color:var(--ink);outline:none}.form input:focus,.form select:focus,.form textarea:focus{border-color:var(--accent)}.form .err{color:#ef4444;font-size:12px}.form .cb{display:flex;gap:8px;align-items:flex-start;font-size:13px}.form .cb input{width:auto}.form .hp{position:absolute;left:-9999px;opacity:0;height:0}" +
        ".pbtn{background:var(--accent);color:var(--on-accent);border:0;border-radius:10px;padding:10px 14px;font:inherit;font-weight:600;cursor:pointer}.pbtn:disabled{opacity:.5;cursor:default}.sbtn{background:transparent;color:var(--accent);border:1px solid var(--accent);border-radius:10px;padding:9px 14px;font:inherit;font-weight:600;cursor:pointer}" +
        ".csat{display:flex;gap:8px;justify-content:center;margin:8px 0}.csat button{background:var(--card);border:1px solid var(--line);border-radius:12px;font-size:22px;width:44px;height:44px;cursor:pointer}.csat button:hover,.csat button.on{border-color:var(--accent);transform:scale(1.08)}" +
        ".cp{border-top:1px solid var(--line);background:var(--bg);padding:10px;flex:0 0 auto;position:relative}.cp:empty{display:none}" +
        ".cp .box{position:relative;border:1px solid var(--line);border-radius:16px;background:var(--card);padding:10px 8px 6px 12px;cursor:text;transition:border-color .15s}.cp .box:focus-within{border-color:var(--accent)}" +
        ".cp textarea{display:block;width:100%;border:0;margin:0;padding:0 4px 0 0;font:inherit;resize:none;max-height:120px;min-height:22px;outline:none;background:transparent;color:var(--ink)}.cp textarea::placeholder{color:var(--ink2);opacity:1}" +
        ".cp .tools{display:flex;align-items:center;gap:2px;margin:6px 0 0 -6px}.cp .tools .sp{flex:1}" +
        ".cp .ib{width:32px;height:32px;flex:0 0 auto;border:0;border-radius:8px;background:transparent;color:var(--ink2);cursor:pointer;display:flex;align-items:center;justify-content:center}.cp .ib:hover{background:var(--chat);color:var(--ink)}.cp .ib svg{width:19px;height:19px}" +
        ".cp .askw{display:block;margin:0 0 8px;cursor:default}.cp .askw::after{content:'';display:block;height:1px;margin-top:6px;background:var(--ink2);opacity:.3}.cp .askw.solo{margin:0}.cp .askw.solo::after{display:none}.cp .box.solo{margin-bottom:8px}.cp .askl{font-size:11px;color:var(--ink2);margin:0 0 2px}" +
        ".cp .ask{display:flex;align-items:center;gap:2px}.cp .ask input{flex:1;min-width:0;border:0;margin:0;padding:4px 4px 4px 0;font:inherit;outline:none;background:transparent;color:var(--ink)}.cp .ask input::placeholder{color:var(--ink2);opacity:1}" +
        ".cp .ask .go,.cp .ask .go:hover{width:26px;height:26px;margin-inline-start:4px;border-radius:50%;background:var(--accent);color:var(--on-accent)}.cp .ask .go:hover{background:var(--accent-2)}.cp .ask .go svg{width:14px;height:14px}.cp .aske{font-size:12px;color:#ef4444}.cp .aske:empty{display:none}" +
        ".cp .send{border-radius:50%;background:var(--accent);color:var(--on-accent)}.cp .send:hover{background:var(--accent-2);color:var(--on-accent)}.cp .send:disabled{background:var(--line);color:var(--ink2);cursor:default}" +
        ".cp .dis{color:var(--ink2);font-size:13px;text-align:center;padding:8px}.cp .files{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}.cp .files:empty{display:none}.cp .files span{background:var(--chat);border:1px solid var(--line);border-radius:8px;padding:3px 8px;font-size:12px;display:inline-flex;gap:6px;align-items:center}.cp .files button{border:0;background:none;cursor:pointer;color:var(--ink2);font-size:14px;line-height:1}" +
        ".emo{position:absolute;bottom:calc(100% + 8px);" + (RTL[S.locale] ? "right" : "left") + ":0;cursor:default;background:var(--card);border:1px solid var(--line);border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.18);padding:8px;display:grid;grid-template-columns:repeat(8,32px);gap:2px;z-index:5}.emo button{width:32px;height:32px;border:0;background:none;font-size:20px;cursor:pointer;border-radius:6px}.emo button:hover{background:var(--chat)}" +
        ".ft{flex:0 0 auto}" +
        ".note{font-size:11px;color:var(--ink2);text-align:center;padding:6px 10px 0}.toast{position:absolute;left:50%;transform:translateX(-50%);bottom:160px;background:#111827;color:#fff;padding:8px 14px;border-radius:18px;font-size:13px;z-index:6;animation:gxin .2s ease;max-width:calc(100% - 32px);width:max-content;text-align:center}@keyframes gxin{from{opacity:0;transform:translate(-50%,6px)}to{opacity:1;transform:translateX(-50%)}}" +
        ".light{position:fixed;inset:0;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;z-index:" + (z + 1) + ";cursor:zoom-out}.light img{max-width:92vw;max-height:92vh;border-radius:8px}" +
        ".drag{outline:2px dashed var(--accent);outline-offset:-6px}.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}" +
        // voice: the consent sheet and "Connecting…", the call's line in the thread, "Continue by voice"; the call view's own rules come from voice.js
        ".vcs{display:flex;flex-direction:column;align-items:center;gap:12px;text-align:center;padding:36px 22px}.vcs p{margin:0;font-size:14px;line-height:1.5}.vcs a{color:var(--ink2);font-size:12px}.vcs .vci{width:56px;height:56px;border-radius:50%;background:var(--accent);color:var(--on-accent);display:flex;align-items:center;justify-content:center}.vcs .vci svg{width:26px;height:26px}.vcs .pbtn,.vcs .sbtn{min-width:180px}.vcs .sbtn{border-color:transparent;color:var(--ink2);font-weight:500}" +
        ".sys.vcl{display:flex;align-items:center;justify-content:center;gap:6px}.sys.vcl svg{width:13px;height:13px;flex:0 0 auto}" +
        ".cvb{display:flex;justify-content:center;margin:0 0 8px}.cvb button{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--accent);background:var(--card);color:var(--accent);border-radius:999px;padding:6px 12px;font:inherit;font-size:13px;font-weight:600;cursor:pointer}.cvb svg{width:14px;height:14px}" +
        (S.voiceCss || "") +
        "@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}" +
        sanitizeCss(ap.custom_css);
    }
    function isDark() { var t = S.eff.appearance && S.eff.appearance.theme; if (settings.darkMode) t = settings.darkMode; if (t === "dark") return true; if (t === "light") return false; return win.matchMedia && win.matchMedia("(prefers-color-scheme: dark)").matches; }
    function isMobile() { return win.matchMedia && win.matchMedia("(max-width: 640px)").matches; }
    function applyStyles() { renderFooter(); var t = styles(); try { if (!sheet && "replaceSync" in CSSStyleSheet.prototype) { sheet = new CSSStyleSheet(); shadow.adoptedStyleSheets = [sheet]; } if (sheet) { sheet.replaceSync(t); return; } } catch (e) {} var st = shadow.querySelector("style") || el("style"); st.textContent = t; if (!st.parentNode) shadow.insertBefore(st, shadow.firstChild); }

    // ---------------------------------------------------------------- mount -----------------------------------------
    var I = {
      x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
      dots: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
      back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
      send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
      clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M21.4 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>',
      smile: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01"/></svg>',
      file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
      chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
      plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
      list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
      mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>',
      bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
      ext: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/></svg>',
      end: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/></svg>',
      down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 11l5 5 5-5M5 20h14"/></svg>',
      play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M10 8.5v7l6-3.5z"/></svg>',
      check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
      msg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
      mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>'
    };
    function mount() {
      if (S.mounted) return;
      var mode = currentMode();
      var container = null;
      if (mode === "embedded") { var sel = S.eff.appearance.mount_selector || settings.mountSelector; try { container = sel && doc.querySelector(sel); } catch (e) {} if (!container) { mode = "bubble"; } }
      host = el("div"); host.id = "growthxai-webchat-panel"; host.setAttribute("data-growthxai", "panel");
      if (container) { host.style.cssText = "display:block;width:100%;height:100%;min-height:480px"; container.appendChild(host); }
      else { host.style.cssText = "position:fixed;inset:auto;width:0;height:0;overflow:visible;z-index:2147483000"; (doc.body || doc.documentElement).appendChild(host); }
      shadow = host.attachShadow({ mode: "closed" });
      root = el("div", "root mode-" + mode); shadow.appendChild(root);
      root.innerHTML = '<div class="backdrop"></div><section class="panel" role="' + (mode === "embedded" ? "region" : "dialog") + '" aria-modal="' + (mode === "drawer" || mode === "modal" || mode === "inline" ? "true" : "false") + '" aria-label="' + esc(S.eff.appearance.brand_name || "Chat") + '" tabindex="-1"><div class="resizer" aria-hidden="true"></div><div class="hd"></div><div class="body" aria-live="polite" aria-relevant="additions"></div><div class="cp"></div><div class="ft"></div></section>';
      ui.panel = root.querySelector(".panel"); ui.hd = root.querySelector(".hd"); ui.body = root.querySelector(".body"); ui.cp = root.querySelector(".cp"); ui.ft = root.querySelector(".ft"); ui.backdrop = root.querySelector(".backdrop");
      applyStyles();
      ui.backdrop.addEventListener("click", function () { api_.close(); });
      ui.panel.addEventListener("keydown", function (e) { if (e.key === "Escape" && mode !== "embedded") { e.stopPropagation(); api_.close(); } if (e.key === "Tab") trapFocus(e); });
      ui.body.addEventListener("scroll", debounce(function () { if (ui.body.scrollTop < 40 && S.conv && S.msgs.length && !S.loadingMore && S.hasMore !== false) loadOlder(); }, 120));
      setupResizer(mode);
      if (win.matchMedia) { try { win.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyStyles); } catch (e) {} }
      win.addEventListener("resize", debounce(applyStyles, 200));
      S.mounted = true; S.mode = mode;
      if (mode === "embedded") { S.open = true; ui.panel.classList.add("open"); }
      renderHeader(); renderView();
    }
    function currentMode() { var m = (S.eff.appearance && S.eff.appearance.mode) || "bubble"; if (settings.mode) m = settings.mode; if (S.forcedMode) m = S.forcedMode; return ["bubble", "drawer", "sidebar", "modal", "inline", "embedded"].indexOf(m) >= 0 ? m : "bubble"; }
    function setupResizer(mode) {
      var r = root.querySelector(".resizer"), saved = store.get("sbw"); if (saved) root.style.setProperty("--sbw", saved + "px");
      var side = S.eff.appearance.drawer_side === "left" ? "left" : "right";
      r.addEventListener("mousedown", function (e) { e.preventDefault(); var sx = e.clientX, sw = ui.panel.getBoundingClientRect().width; function mv(ev) { var w = Math.max(320, Math.min(720, sw + (side === "left" ? ev.clientX - sx : sx - ev.clientX))); root.style.setProperty("--sbw", w + "px"); pushBody(); } function up() { doc.removeEventListener("mousemove", mv); doc.removeEventListener("mouseup", up); store.set("sbw", parseInt(getComputedStyle(root).getPropertyValue("--sbw"), 10) || null); } doc.addEventListener("mousemove", mv); doc.addEventListener("mouseup", up); });
      if (mode !== "sidebar") r.style.display = "none";
    }
    // Phones: while the full-screen panel is open the page does not pinch-zoom, and a focused field does not zoom the
    // page in (iOS zooms into fields under 16px and stays there). The page's own viewport tag comes back on close.
    var vpSaved = null, taSaved = null;
    // iOS Safari ignores user-scalable=no for pinches: the gesture itself is cancelled while the panel is open
    function noGesture(e) { e.preventDefault(); }
    function noPinch(e) { if (e.touches && e.touches.length > 1) e.preventDefault(); }
    function lockZoom(on) {
      try {
        var m = doc.querySelector('meta[name="viewport"]');
        if (on && isMobile() && S.mode !== "embedded") {
          if (vpSaved === null) {
            vpSaved = m ? (m.getAttribute("content") || "") : false;
            taSaved = doc.documentElement.style.touchAction;
            doc.documentElement.style.touchAction = "manipulation";   // no double-tap zoom anywhere while it is open
            doc.addEventListener("gesturestart", noGesture, { passive: false });
            doc.addEventListener("gesturechange", noGesture, { passive: false });
            doc.addEventListener("touchmove", noPinch, { passive: false });
          }
          if (!m) { m = doc.createElement("meta"); m.setAttribute("name", "viewport"); m.setAttribute("data-growthxai", "vp"); doc.head.appendChild(m); }
          m.setAttribute("content", "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no");
        } else if (!on && vpSaved !== null) {
          if (vpSaved === false) { if (m && m.getAttribute("data-growthxai") === "vp") m.remove(); } else if (m) m.setAttribute("content", vpSaved);
          vpSaved = null;
          doc.documentElement.style.touchAction = taSaved || "";
          doc.removeEventListener("gesturestart", noGesture);
          doc.removeEventListener("gesturechange", noGesture);
          doc.removeEventListener("touchmove", noPinch);
        }
      } catch (e) {}
    }
    function pushBody() {
      var side = S.eff.appearance.drawer_side === "left" ? "Left" : "Right", h = doc.documentElement;
      if (S.mode === "sidebar" && S.open && !isMobile()) { var w = ui.panel.getBoundingClientRect().width; h.style["margin" + side] = w + "px"; h.style.transition = "margin .22s"; }
      else { h.style.marginLeft = ""; h.style.marginRight = ""; }
    }
    function trapFocus(e) {
      if (S.mode === "embedded" || S.mode === "bubble" || S.mode === "sidebar") return;
      var f = ui.panel.querySelectorAll("button:not([disabled]),[href],input,select,textarea,[tabindex]:not([tabindex='-1'])"); if (!f.length) return;
      var first = f[0], last = f[f.length - 1], a = shadow.activeElement;
      if (e.shiftKey && a === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
    }

    // ---------------------------------------------------------------- header ----------------------------------------
    function availabilityText() {
      var av = S.cfg.availability || {}, rt = (S.eff.messages || {}).reply_time || "minutes";
      if (av.online) return rt === "none" ? "" : T(rt);
      if (av.in_hours) return t2("unavailable_message") || (S.eff.messages && S.eff.messages.unavailable_message) || T("soon");
      if (av.next_open_at) { var d = new Date(av.next_open_at), n = new Date(), diffH = (d - n) / 36e5; var when = diffH < 20 && d.toDateString() === n.toDateString() ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : (diffH < 36 ? T("tomorrow") : d.toLocaleDateString(undefined, { weekday: "long" })); return T("back_at", { when: when }); }
      return T("soon");
    }
    function renderHeader() {
      var ap = S.eff.appearance, av = S.cfg.availability || {}, feats = S.eff.features || {};
      var showStatus = feats.show_offline_status !== false || av.online;
      ui.hd.innerHTML = (S.view !== "home" && S.view !== "embedded-home" ? '<button class="ib" data-a="back" aria-label="' + esc(T("back")) + '">' + I.back + "</button>" : "") +
        '<div class="logo" aria-hidden="true">' + (ap.logo_url ? '<img src="' + esc(safeUrl(ap.logo_url)) + '" alt="">' : esc(initials(ap.brand_name))) + "</div>" +
        '<div class="grow"><div class="ttl">' + esc(t2("brand_name") || ap.brand_name || "Chat") + '</div><div class="sub">' + (showStatus ? '<span class="dot' + (av.online ? "" : " off") + '"></span>' : "") + "<span>" + esc(availabilityText() || (av.online ? T("online") : "")) + "</span></div></div>" +
        '<button class="ib" data-a="menu" aria-label="' + esc(T("menu")) + '" aria-haspopup="menu">' + I.dots + "</button>" +
        (S.mode !== "embedded" ? '<button class="ib" data-a="close" aria-label="' + esc(T("closepanel")) + '">' + I.x + "</button>" : "");
      ui.hd.querySelectorAll("[data-a]").forEach(function (b) { b.addEventListener("click", function () { var a = b.getAttribute("data-a"); if (a === "close") api_.close(); else if (a === "back") showHome(); else if (a === "menu") toggleMenu(b); }); });
    }
    function toggleMenu(anchor) {
      var m = root.querySelector(".menu"); if (m) { m.remove(); return; }
      var feats = S.eff.features || {}, items = [];
      if (!feats.single_conversation && S.view === "messages") items.push(["new", I.plus, T("newconv")]);
      if (!feats.single_conversation && S.convs.length) items.push(["list", I.list, T("prev")]);
      var inConv = S.view === "messages" && !!S.conv;   // "this conversation" items only while one is on screen, never on the home / list views
      if (feats.transcript !== false && inConv && S.msgs.some(function (x) { return x.content_type !== "event"; })) { items.push(["transcript", I.mail, T("transcript")]); items.push(["download", I.down, T("download_transcript")]); }
      if (feats.end_conversation !== false && inConv && S.conv.status !== "resolved") items.push(["end", I.end, T("end")]);
      if (feats.sounds !== false) items.push(["sound", I.bell, S.muted ? T("sound_on") : T("sound_off")]);
      if (L.video && L.video.available()) items.push(["video", I.play, T("video")]);   // brings back a GIF / video bubble the visitor closed
      if (S.mode !== "embedded" && settings.showPopoutButton !== false) items.push(["popout", I.ext, T("popout")]);
      m = el("div", "menu"); m.setAttribute("role", "menu");
      m.innerHTML = items.map(function (it) { return '<button role="menuitem" data-m="' + it[0] + '">' + it[1] + "<span>" + esc(it[2]) + "</span></button>"; }).join("");
      m.querySelectorAll("[data-m]").forEach(function (b) { b.addEventListener("click", function () { m.remove(); menuAction(b.getAttribute("data-m")); }); });
      ui.panel.appendChild(m); var first = m.querySelector("button"); first && first.focus();
      setTimeout(function () { doc.addEventListener("click", function h(ev) { if (!m.contains(ev.target) && ev.target !== anchor) { m.remove(); } doc.removeEventListener("click", h); }, { once: true }); }, 0);
    }
    function menuAction(a) {
      if (a === "new") startNew(); else if (a === "list") { S.view = "list"; renderHeader(); renderView(); }
      else if (a === "transcript") transcript(); else if (a === "download") downloadTranscript(); else if (a === "end") endConversation();
      else if (a === "video") L.video.show();
      else if (a === "sound") { S.muted = !S.muted; store.set("muted", S.muted ? 1 : 0); }
      else if (a === "popout") api_.popoutChatWindow();
    }

    // ---------------------------------------------------------------- views -----------------------------------------
    function renderView() {
      if (S.view !== "messages") S.ask = null;
      if (S.view === "home") renderHome(); else if (S.view === "list") renderList(); else if (S.view === "prechat") renderPrechat(); else if (S.view === "voice-consent") renderVoiceConsent(); else if (S.view === "call") renderCall(); else renderMessages();
      renderComposer(); syncPrivacy();
    }
    // the back arrow: out of a call it means "switch to chat" (the call ends, the conversation stays on screen)
    function showHome() { if (V && V.active()) { V.leave("switch"); return; } S.view = S.view === "voice-consent" && S.conv ? "messages" : "home"; renderHeader(); renderView(); }
    // "live": an open conversation, so the loader fetches chat.js early on later pages
    function noteLive() { store.set("live", activeConv() ? 1 : 0); }
    function activeConv() { return S.convs.filter(function (c) { return c.status !== "resolved"; }).sort(function (a, b) { return new Date(b.last_message_at || b.created_at) - new Date(a.last_message_at || a.created_at); })[0] || null; }
    // Home and the conversation list: earlier conversations as compact chat rows (avatar, name, latest message, time),
    // then "Start a new chat" and "Talk to us" as two small buttons under them.
    function convWhen(d) {
      var x = new Date(d), n = new Date(); if (isNaN(x)) return "";
      if (x.toDateString() === n.toDateString()) return Date.now() - x < 60000 ? T("just_now") : fmtTime(x);
      var y = new Date(n); y.setDate(n.getDate() - 1); if (x.toDateString() === y.toDateString()) return T("yesterday");
      return n - x < 6 * 864e5 ? x.toLocaleDateString(undefined, { weekday: "short" }) : x.toLocaleDateString(undefined, { day: "numeric", month: "short" });
    }
    function convRow(c) {
      var ap = S.eff.appearance, brand = t2("brand_name") || ap.brand_name || "Chat", who = (c.assignee && c.assignee.name) || brand;
      var img = !(c.assignee && c.assignee.name) && (ap.bot_avatar_url || ap.logo_url);
      var pv = c.last_message_preview || (c.status === "resolved" ? T("ended") : T("start"));
      if (c.last_message_preview && c.last_direction === "in") pv = T("you") + ": " + pv;
      return '<button type="button" class="row' + (c.unread ? " un" : "") + '" data-open="' + esc(c.id) + '"><span class="av" aria-hidden="true">' + (img ? '<img src="' + esc(safeUrl(img)) + '" alt="">' : esc(initials(who))) + "</span>" +
        '<span class="rm"><span class="r1"><b>' + esc(who) + "</b><time>" + esc(convWhen(c.last_message_at || c.created_at)) + "</time></span>" +
        '<span class="r2"><span class="pv">' + esc(pv.slice(0, 140)) + "</span>" + (c.unread ? '<i class="ud">' + (c.unread > 9 ? "9+" : c.unread) + "</i>" : "") + "</span></span></button>";
    }
    function byRecent(a, b) { return new Date(b.last_message_at || b.created_at) - new Date(a.last_message_at || a.created_at); }
    function homeActions() {
      var feats = S.eff.features || {}, h = "";
      if (!feats.single_conversation || !S.convs.length) h += '<button type="button" class="act pri" data-new="1">' + I.msg + "<span>" + esc(T("new_chat")) + "</span></button>";
      if (voiceShow("home")) h += '<button type="button" class="act" data-call="1">' + I.mic + "<span>" + esc(voiceText("start_text", "Talk to us", "talk")) + "</span></button>";
      return h ? '<div class="hacts">' + h + "</div>" + (availabilityText() ? '<p class="avl">' + esc(availabilityText()) + "</p>" : "") : "";
    }
    function wireHome() {
      ui.body.querySelectorAll("[data-open]").forEach(function (n) { n.addEventListener("click", function () { openConv(n.getAttribute("data-open")); }); });
      ui.body.querySelectorAll("[data-new]").forEach(function (n) { n.addEventListener("click", function () { startNew(); }); });
      ui.body.querySelectorAll("[data-call]").forEach(function (n) { n.addEventListener("click", function () { startCall({ source: "voice" }); }); n.addEventListener("mouseenter", function () { loadVoice().catch(function () {}); }); });
      ui.body.querySelectorAll("[data-list]").forEach(function (n) { n.addEventListener("click", function () { S.view = "list"; renderHeader(); renderView(); }); });
      ui.body.querySelectorAll("[data-q]").forEach(function (n) { n.addEventListener("click", function () { startNew(n.getAttribute("data-q")); }); });
      ui.cp.innerHTML = "";
    }
    function renderHome() {
      var ap = S.eff.appearance, ms = S.eff.messages || {}, feats = S.eff.features || {}, list = S.convs.slice().sort(byRecent), max = feats.single_conversation ? 1 : 3;
      var h = '<div class="home"><h2>' + esc(t2("welcome_title") || ap.welcome_title || "") + "</h2><p>" + esc(t2("welcome_tagline") || ap.welcome_tagline || "") + "</p>";
      if (list.length) {
        h += '<div class="hl"><span>' + esc(T("msgs")) + "</span>" + (list.length > max ? '<button type="button" data-list="1">' + esc(T("see_all")) + " (" + list.length + ")</button>" : "") + "</div>";
        h += '<div class="rows">' + list.slice(0, max).map(convRow).join("") + "</div>";
      }
      var qp = (ms.quick_replies || []).slice(0, 6); if (qp.length) h += '<div class="qp" role="group">' + qp.map(function (q) { return '<button type="button" data-q="' + esc(q) + '">' + esc(q) + "</button>"; }).join("") + "</div>";
      h += homeActions() + "</div>";
      ui.body.innerHTML = h;
      wireHome();
    }
    function renderList() {
      ui.body.innerHTML = '<div class="home"><div class="rows">' + S.convs.slice().sort(byRecent).map(convRow).join("") + "</div>" + homeActions() + "</div>";
      wireHome();
    }
    // Footer (every view): a "Powered by" strip and the privacy line. It renders in its own closed shadow root with literal
    // colours, so the inbox's accent / backgrounds and custom CSS cannot restyle it; only light / dark follows the panel.
    // The privacy line is consent for the first message: it shows until this visitor has sent one, or has any earlier
    // conversation (a returning visitor, also one identified on another device), and stays gone after that.
    function privacyOn() {
      if (store.get("sent")) return false;
      var cur = S.conv && S.conv.id;
      if (S.convs.some(function (c) { return c.id !== cur; })) return false;
      return !S.msgs.some(function (m) { return m.sender_type === "visitor" && !m.hidden; });
    }
    function syncPrivacy() { if (S.privacy !== privacyOn()) renderFooter(); }
    var LOGO = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><defs><linearGradient id="gxa" x1="4" y1="5" x2="14" y2="22" gradientUnits="userSpaceOnUse"><stop stop-color="#8a5cff"/><stop offset="1" stop-color="#45a9ff"/></linearGradient><linearGradient id="gxb" x1="8" y1="3" x2="19" y2="20" gradientUnits="userSpaceOnUse"><stop stop-color="#ffb84d"/><stop offset=".55" stop-color="#ff6f9f"/><stop offset="1" stop-color="#f04fd8"/></linearGradient></defs><circle cx="12" cy="12" r="8.9" stroke="url(#gxa) #6b8cff" stroke-width="6.1"/><path d="M8.68 3.7A8.94 8.94 0 0 1 16.25 19.87" stroke="url(#gxb) #ff6f9f" stroke-width="6.1" stroke-linecap="round"/></svg>';
    function renderFooter() {
      if (!ui.ft) return;
      var feats = S.eff.features || {}, ms = S.eff.messages || {}, dark = isDark();
      var privacy = /^https:\/\//i.test(ms.privacy_url || "") ? ms.privacy_url : "https://growthxai.com/legal/privacy/";
      var css = ":host{all:initial;display:block;direction:" + (RTL[S.locale] ? "rtl" : "ltr") + "}" +
        ".s{display:flex;align-items:center;justify-content:center;gap:5px;padding:7px 10px;font:500 11px/1.2 Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:" + (dark ? "#0b1220" : "#f3f4f6") + ";color:" + (dark ? "#9ca3af" : "#6b7280") + ";border-top:1px solid " + (dark ? "#1f2937" : "#e5e7eb") + "}" +
        ".s a{display:inline-flex;align-items:center;gap:4px;color:" + (dark ? "#f3f4f6" : "#111827") + ";font-weight:700;text-decoration:none}.s a:hover{text-decoration:underline}.s svg{width:14px;height:14px;flex:0 0 auto}" +
        ".p{padding:6px 12px 8px;text-align:center;font:400 11px/1.3 Roboto,Inter,system-ui,-apple-system,Segoe UI,sans-serif;background:" + (dark ? "#111827" : "#ffffff") + ";color:" + (dark ? "#9ca3af" : "#6c6f74") + "}.p a{color:inherit;text-decoration:underline}";
      var h = el("div"), sr = h; S.privacy = privacyOn();
      try { sr = h.attachShadow({ mode: "closed" }); } catch (e) {}
      sr.innerHTML = (feats.powered_by !== false ? '<div class="s"><span>' + esc(T("powered")) + '</span><a href="https://growthxai.com/?utm_source=webchat" target="_blank" rel="noopener">' + LOGO + "<span>" + esc(T("brand")) + "</span></a></div>" : "") +
        (S.privacy ? '<div class="p">' + esc(T("privacy")).replace("{link}", '<a href="' + esc(privacy) + '" target="_blank" rel="noopener noreferrer">' + esc(T("privacy_link")) + "</a>") + "</div>" : "");
      try { var fs = new CSSStyleSheet(); fs.replaceSync(css); sr.adoptedStyleSheets = [fs]; } catch (e) { var st = el("style"); st.textContent = css; sr.insertBefore(st, sr.firstChild); }
      ui.ft.textContent = ""; ui.ft.appendChild(h);
      [["display", "block"], ["visibility", "visible"], ["opacity", "1"]].forEach(function (kv) { ui.ft.style.setProperty(kv[0], kv[1], "important"); });
    }

    // ---------------------------------------------------------------- pre-chat form (PRD §5.5) ----------------------
    var pendingFirst = null;
    function needsPrechat() {
      var pc = S.eff.pre_chat || {}; if (!pc.enabled) return false;
      if (S.visitor && S.visitor.identity_verified) return false;
      if (pc.when === "offline_only" && S.cfg.availability && S.cfg.availability.online) return false;
      var missing = prechatMissing();
      if (!missing.length) return false;
      // asked once per visitor: after they sent the form (in this browser) or chatted before, only a required field
      // that is still missing brings it back
      if ((store.get("pc") || {}).at || S.convs.length) return missing.some(function (f) { return f.required; });
      return true;
    }
    // the form's fields this visitor has not answered: their details on the server, else what this browser sent before
    // (a visitor whose token was lost comes back as a new one; createConversation sends those details for them)
    function prechatMissing() {
      var pc = S.eff.pre_chat || {}, v = S.visitor || {}, saved = store.get("pc") || {}, ca = v.custom_attributes || {};
      return (pc.fields || []).filter(function (f) {
        if (f.visible === false || f.enabled === false) return false;
        if (f.key === "name" || f.key === "email" || f.key === "phone") return !(v[f.key] || saved[f.key]);
        return ca[f.key] == null || ca[f.key] === "";
      });
    }
    function savedPrechat() {
      var saved = store.get("pc") || {}, v = S.visitor || {}, out = null;
      ["name", "email", "phone"].forEach(function (k) { if (saved[k] && !v[k]) { out = out || { custom: {} }; out[k] = saved[k]; } });
      return out;
    }
    function renderPrechat() {
      var pc = S.eff.pre_chat || {};
      var fields = prechatMissing();
      var h = '<div class="home"><p>' + esc(pc.message || "") + '</p><form class="form" novalidate>';
      fields.forEach(function (f, i) {
        var id = "f" + i, ph = esc(f.placeholder || (f.key === "email" ? T("email_ph") : f.key === "name" ? T("name_ph") : f.key === "phone" ? T("phone_ph") : ""));
        h += '<div><label for="' + id + '">' + esc(f.label || f.key) + (f.required ? " *" : "") + "</label>";
        if (f.type === "list" || f.type === "select") h += '<select id="' + id + '" name="' + esc(f.key) + '"' + (f.required ? " required" : "") + '><option value="">' + ph + "</option>" + (f.options || f.values || []).map(function (o) { var val = typeof o === "string" ? o : (o.value || o.label); return '<option value="' + esc(val) + '">' + esc(typeof o === "string" ? o : (o.label || o.value)) + "</option>"; }).join("") + "</select>";
        else if (f.type === "checkbox") h += '<label class="cb"><input type="checkbox" id="' + id + '" name="' + esc(f.key) + '"> ' + esc(f.placeholder || "") + "</label>";
        else if (f.type === "textarea") h += '<textarea id="' + id + '" name="' + esc(f.key) + '" rows="3" placeholder="' + ph + '"' + (f.required ? " required" : "") + "></textarea>";
        else h += '<input id="' + id + '" name="' + esc(f.key) + '" type="' + (f.type === "phone" ? "tel" : f.type === "url" ? "url" : f.type === "number" ? "number" : f.type === "date" ? "date" : f.type === "email" ? "email" : "text") + '" placeholder="' + ph + '"' + (f.required ? " required" : "") + (f.pattern ? ' data-pattern="' + esc(f.pattern) + '"' : "") + (f.key === "email" ? ' autocomplete="email"' : f.key === "name" ? ' autocomplete="name"' : f.key === "phone" ? ' autocomplete="tel"' : "") + ">";
        h += '<div class="err" data-err="' + esc(f.key) + '"></div></div>';
      });
      if (pc.consent && pc.consent.enabled) h += '<label class="cb"><input type="checkbox" name="_consent"> <span>' + esc(pc.consent.label || "") + (pc.consent.link ? ' <a href="' + esc(safeUrl(pc.consent.link)) + '" target="_blank" rel="noopener">↗</a>' : "") + '</span></label><div class="err" data-err="_consent"></div>';
      h += '<input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true"><button class="pbtn" type="submit">' + esc(T("start")) + "</button></form></div>";
      ui.body.innerHTML = h;
      var form = ui.body.querySelector("form");
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        if (form.website && form.website.value) return;   // honeypot
        var data = { custom: {} }, ok = true;
        ui.body.querySelectorAll(".err").forEach(function (x) { x.textContent = ""; });
        fields.forEach(function (f) {
          var inp = form.elements[f.key]; if (!inp) return;
          var val = f.type === "checkbox" ? !!inp.checked : String(inp.value || "").trim(), err = null;
          if (f.required && (val === "" || val === false)) err = T("required");
          else if (val && (f.type === "email" || f.key === "email") && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(val)) err = T("invalid_email");
          else if (val && (f.type === "phone" || f.key === "phone") && !/^\+?[\d\s().-]{6,20}$/.test(val)) err = T("invalid_phone");
          else if (val && f.pattern) { try { if (!new RegExp(f.pattern).test(val)) err = f.pattern_error || T("required"); } catch (x) {} }
          if (err) { ok = false; var en = ui.body.querySelector('[data-err="' + f.key + '"]'); if (en) en.textContent = err; }
          if (["name", "email", "phone"].indexOf(f.key) >= 0) data[f.key] = val; else data.custom[f.key] = val;
        });
        if (pc.consent && pc.consent.enabled) { var cb = form.elements._consent; if (!cb.checked && pc.consent.required !== false) { ok = false; ui.body.querySelector('[data-err="_consent"]').textContent = T("consent_err"); } data.consent = { accepted: !!cb.checked, text_version: pc.consent.text_version }; }
        if (!ok) return;
        var saved = store.get("pc") || {}, keep = { at: Date.now() };
        ["name", "email", "phone"].forEach(function (k) { if (!data[k] && saved[k]) data[k] = saved[k]; if (data[k]) keep[k] = String(data[k]).slice(0, 120); });
        store.set("pc", keep);
        var first = pendingFirst; pendingFirst = null;
        var call = S.afterPrechat === "call"; S.afterPrechat = null;
        if (call) S.view = "call";   // the conversation opens under the call view
        createConversation(data, call ? "voice" : S.pendingSource || "launcher").then(function () { if (call) beginCall(); else if (first) sendText(first); }).catch(function (e) { if (call) { S.view = "home"; renderHeader(); renderView(); } showErr(e); });
      });
      ui.cp.innerHTML = "";
      var f0 = form.querySelector("input,select,textarea"); f0 && f0.focus();
    }

    // ---------------------------------------------------------------- conversations ---------------------------------
    function startNew(firstText, source) {
      S.pendingSource = source || S.pendingSource || "launcher";
      ensureVisitor().then(function () {
        var feats = S.eff.features || {};
        var open = activeConv();
        if ((feats.single_conversation && S.convs.length) || (open && !firstText && feats.single_conversation)) return openConv((open || S.convs[0]).id).then(function () { if (firstText && !composerDisabled()) sendText(firstText); });   // a closed single conversation takes no message (and must not start this again)
        if (needsPrechat()) { pendingFirst = firstText || null; S.view = "prechat"; renderHeader(); renderView(); return; }
        return createConversation(null, S.pendingSource).then(function () { if (firstText) sendText(firstText); });
      }).catch(showErr);
    }
    function postConversation(form, source, retried) {
      var body = { form: form, source: source || "launcher", page: { url: location.href, title: doc.title, campaign_message: S.campaignMsg || null, campaign_id: S.campaignId || null } };
      return turnstileToken().then(function (tt) { if (tt) body.turnstile_token = tt; return api("POST", "/conversations", body); })
        .catch(function (e) { if (e && e.code === "E_TURNSTILE" && !retried) return postConversation(form, source, true); throw e; });   // a token is single-use and expires: one fresh try
    }
    function createConversation(form, source) {
      return postConversation(form || savedPrechat(), source).then(function (r) {
        S.campaignMsg = null; S.campaignId = null;
        if (r.visitor) S.visitor = r.visitor;
        var c = r.conversation; S.convs = [c].concat(S.convs.filter(function (x) { return x.id !== c.id; })); noteLive();
        sdk.emit("conversation:started", { id: c.id }); L.store.set("chatted", 1);
        // labels and attributes set before there was a conversation (setLabel from a button's data-growthxai-label) go on this one
        var labels = S.pendingLabels, attrs = S.pendingConvAttrs; S.pendingLabels = null; S.pendingConvAttrs = null;
        if ((labels && labels.length) || attrs) api("PATCH", "/visitor/attributes", { conversation_id: c.id, add_labels: labels && labels.length ? labels : undefined, conversation_custom_attributes: attrs || undefined }).catch(function () {});
        return openConv(c.id);
      });
    }
    function openConv(id) {
      var c = S.convs.filter(function (x) { return x.id === id; })[0];
      if (!c) return Promise.resolve();
      if (S.conv && S.conv.id !== id) leaveRealtime();
      S.conv = c; S.msgs = []; S.byId = {}; S.hasMore = true; S.ask = null; if (S.view !== "call") S.view = "messages"; renderHeader(); renderView();
      joinRealtime(); startHeartbeat();
      return api("GET", "/conversations/" + id + "/messages?limit=50").then(function (r) { (r.messages || []).forEach(function (m) { addMsg(m); noteShown(m, true); }); S.hasMore = (r.messages || []).length >= 50; renderMessages(true); markRead(); flushQueue(); }).catch(showErr);
    }
    function loadOlder() {
      if (!S.msgs.length) return; S.loadingMore = true; var first = S.msgs[0], h0 = ui.body.scrollHeight;
      api("GET", "/conversations/" + S.conv.id + "/messages?limit=50&before=" + encodeURIComponent(first.sent_at)).then(function (r) { var got = r.messages || []; S.hasMore = got.length >= 50; got.forEach(function (m) { addMsg(m); noteShown(m, true); }); renderMessages(false); ui.body.scrollTop = ui.body.scrollHeight - h0; }).catch(function () {}).then(function () { S.loadingMore = false; });
    }
    function addMsg(m) {
      if (m.echo_id && S.pending[m.echo_id]) { var p = S.pending[m.echo_id]; delete S.pending[m.echo_id]; S.msgs = S.msgs.filter(function (x) { return x !== p; }); }
      if (S.byId[m.id]) { Object.assign(S.byId[m.id], m); return false; }
      S.byId[m.id] = m; S.msgs.push(m); S.msgs.sort(function (a, b) { return new Date(a.sent_at) - new Date(b.sent_at); }); return true;
    }

    // ---------------------------------------------------------------- messages render -------------------------------
    function renderMessages(scroll) {
      // during a call the thread is not on screen: new cards and forms show in the call view, the rest waits for the switch
      if (S.view === "call") { if (V && V.active()) V.refresh(); return; }
      // only the thread view draws the thread: a late fetch or a live message while the home / list / form is up must not
      // paint the thread under a header with no back arrow and an empty composer
      if (S.view !== "messages") return;
      var body = ui.body, ap = S.eff.appearance, feats = S.eff.features || {}, ms = S.eff.messages || {}, html = "", lastDay = null, prev = null, av = S.cfg.availability || {};
      var ai = S.conv && (av.ai_mode !== "off") && !(S.conv.handed_off_at);
      // one line under the newest bubble only (who · AI Agent · when); a bubble still being written takes it over
      var lastId = null; if (!S.aiStream && !S.agentTyping) for (var li = S.msgs.length - 1; li >= 0; li--) { var lm = S.msgs[li]; if (lm.content_type !== "event" && !lm.deleted) { lastId = lm.id; break; } }
      if (!S.msgs.length && !ai) html += '<div class="note">' + esc(availabilityText()) + "</div>";
      if (ai && S.msgs.length) html += '<div class="note">' + esc(T("ai_note")) + "</div>";
      S.msgs.forEach(function (m) {
        var day = dayLabel(m.sent_at, T); if (day !== lastDay) { html += '<div class="day">' + esc(day) + "</div>"; lastDay = day; prev = null; }
        if (m.content_type === "event") { html += sysLine(m); prev = null; return; }
        if (m.deleted) return;
        var me = m.sender_type === "visitor", first = !prev || prev.sender_type !== m.sender_type || prev.sender_name !== m.sender_name || (new Date(m.sent_at) - new Date(prev.sent_at)) > 60000;
        html += bubble(m, me, first, m.id === lastId);
        prev = m;
      });
      if (S.aiStream) html += S.aiStream.html;
      if (S.agentTyping) html += liveBubble(esc(initials(S.agentTyping)), '<div class="bub typing" aria-label="' + esc(T("typing", { name: S.agentTyping })) + '"><i></i><i></i><i></i></div>', [S.agentTyping]);
      // a row of product cards keeps the place the visitor scrolled it to
      var rows = {}; body.querySelectorAll(".pc").forEach(function (n) { var r = n.querySelector(".cards"); if (r && r.scrollLeft) rows[n.getAttribute("data-pc")] = r.scrollLeft; });
      body.innerHTML = html;
      body.querySelectorAll(".pc").forEach(function (n) { var x = rows[n.getAttribute("data-pc")], r = n.querySelector(".cards"); if (x && r) { r.style.scrollBehavior = "auto"; r.scrollLeft = x; r.style.scrollBehavior = ""; } });
      wireBubbles(); syncPrivacy(); syncVoiceChip();
      clearTimeout(S.metaT); var tm = body.querySelector(".tm[data-at]");   // "Just now" becomes the clock time after a minute
      if (tm) { var age = Date.now() - new Date(tm.getAttribute("data-at")); if (age < 60000) S.metaT = setTimeout(function () { tm.textContent = fmtTime(tm.getAttribute("data-at")); }, 60500 - Math.max(0, age)); }
      if (scroll !== false) body.scrollTop = body.scrollHeight;
    }
    function sysLine(m) {
      var a = m.content_attributes || {}, k = a.kind, t = "";
      if (k === "voice_call") {
        // a call this panel ended is over, whatever the copy of its line we hold says (the update may not have arrived yet)
        var mine = (S.endedCalls || {})[a.call_id], secs = a.duration_s > 0 ? a.duration_s : mine > 0 ? mine : 0, d = secs ? " · " + Math.floor(secs / 60) + ":" + ("0" + (secs % 60)).slice(-2) : "";
        return '<div class="sys vcl">' + I.mic + "<span>" + esc(a.status === "live" && mine == null ? T("call_live") : T("call_ended") + d) + "</span></div>";
      }
      if (k === "assigned") t = (a.agent || T("team")) + " joined"; else if (k === "resolved") t = T("ended"); else if (k === "reopened") t = T("cont"); else if (k === "email_sent") t = "Sent to " + (a.to || "your email"); else if (k === "ai_stopped" || k === "unassigned" || k === "ai_resumed") return ""; else t = k || "";
      return t ? '<div class="sys">' + esc(t) + "</div>" : "";
    }
    function bubble(m, me, first, last) {
      var a = m.content_attributes || {}, feats = S.eff.features || {}, ap = S.eff.appearance;
      var inner = "";
      if (m.text) inner += md(m.text, feats.markdown !== false && !me);
      (m.attachments || []).forEach(function (f) { var img = /^image\//.test(f.type || ""); inner += img ? '<img class="pic" data-att="' + esc(f.id) + '" alt="' + esc(f.name || "") + '" src="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27200%27 height=%27120%27%3E%3C/svg%3E">' : '<a class="file" data-att="' + esc(f.id) + '" role="button">' + I.file + "<span>" + esc(f.name || "file") + (f.size ? " · " + Math.round(f.size / 1024) + " KB" : "") + "</span></a>"; });
      // product cards come only from the assistant or an agent (catalogue snapshots saved on the message), never from a visitor's message
      if (!me && Array.isArray(a.products) && a.products.length) inner += productCards(a.products, m.id);
      else if (m.content_type === "cards" && a.items) inner += cards(a.items);
      if (m.content_type === "quick_replies" && a.items) inner += '<div class="acts">' + a.items.map(function (it) { var t = typeof it === "string" ? it : it.title; return '<button type="button" data-qr="' + esc(typeof it === "string" ? it : (it.value || it.title)) + '"' + (a.response ? " disabled" : "") + ">" + esc(t) + "</button>"; }).join("") + "</div>";
      if (m.content_type === "form") inner += formBlock(m);
      if (m.content_type === "csat") inner += csatBlock(m);
      if (a.ai && m.sender_type === "bot") inner += aiExtras(m);
      var meta = "";
      if (last || m.failed || m.pending) {   // no line under the older messages, and nothing on hover
        var when = '<span class="tm" data-at="' + esc(m.sent_at) + '">' + esc(Date.now() - new Date(m.sent_at) < 60000 ? T("just_now") : fmtTime(m.sent_at)) + "</span>", parts;
        if (me) parts = [when + (m.failed ? ' <span class="fail" data-retry="' + esc(m.echo_id) + '">' + esc(T("failed")) + " · " + esc(T("retry")) + "</span>" : m.pending ? " <span>…</span>" : (feats.read_receipts !== false ? ' <span class="tick' + (m.read_by_agent_at ? " read" : "") + '" title="' + esc(m.read_by_agent_at ? T("read") : T("sent")) + '">' + (m.read_by_agent_at ? "✓✓" : "✓") + "</span>" : ""))];
        else parts = ['<span class="nm">' + esc(m.sender_type === "bot" ? (ap.brand_name || "") : (feats.show_agent_names !== false ? (m.sender_name || T("team")) : T("team"))) + "</span>", m.sender_type === "bot" ? "<span>" + esc(T("ai_agent")) + "</span>" : "", when];
        meta = '<div class="meta">' + parts.filter(function (x) { return x && x !== '<span class="nm"></span>'; }).join("<span>•</span>") + "</div>";
      }
      var avatar = m.sender_type === "bot" ? (ap.bot_avatar_url ? '<img src="' + esc(safeUrl(ap.bot_avatar_url)) + '" alt="">' : esc(initials(ap.brand_name))) : esc(initials(m.sender_name || T("team")));
      return '<div class="msg' + (me ? " me" : "") + (first ? " first" : "") + '" data-id="' + esc(m.id) + '">' + (me ? "" : '<div class="av" aria-hidden="true">' + avatar + "</div>") + '<div class="col"><div class="bub">' + inner + "</div>" + meta + "</div></div>";
    }
    // a bubble that is still being written (AI answer streaming, agent typing): same shape, the line under it has no time yet
    function liveBubble(avatar, bub, who) { who = who.filter(Boolean); return '<div class="msg first"><div class="av" aria-hidden="true">' + avatar + '</div><div class="col">' + bub + (who.length ? '<div class="meta">' + who.map(function (x) { return '<span class="nm">' + esc(x) + "</span>"; }).join("<span>•</span>") + "</div>" : "") + "</div></div>"; }
    function aiBubble(bub) { var ap = S.eff.appearance; return liveBubble(ap.bot_avatar_url ? '<img src="' + esc(safeUrl(ap.bot_avatar_url)) + '" alt="">' : esc(initials(ap.brand_name)), bub, [ap.brand_name, T("ai_agent")]); }
    function cards(items) {
      return '<div class="cards" role="region">' + items.slice(0, 10).map(function (c) { return '<div class="cardi">' + (c.media_url ? '<img src="' + esc(safeUrl(c.media_url)) + '" alt="" loading="lazy">' : "") + '<div class="ct"><b>' + esc(c.title || "") + "</b>" + (c.description ? "<small>" + esc(c.description) + "</small>" : "") + '<div class="acts">' + (c.actions || []).map(function (ac) { return ac.type === "postback" ? '<button type="button" data-pb="' + esc(ac.payload || ac.text) + '">' + esc(ac.text) + "</button>" : '<a href="' + esc(safeUrl(ac.uri || ac.url)) + '" target="_blank" rel="noopener">' + esc(ac.text || "Open") + "</a>"; }).join("") + "</div></div></div>"; }).join("") + "</div>";
    }
    // ---- product cards (web-chat-buttons-products-changes.md §8) -----------------------------------------------------
    // Built from the catalogue snapshot saved on the message ({ id, title, price, compare_at, currency, url, image,
    // available, variant_id }), so an old conversation shows what was offered then, whatever the store sells now.
    function pcfg() { return (S.eff.ai || {}).products || {}; }
    function money(n, cur) {
      var d = n % 1 ? 2 : 0;
      try { if (cur) return new Intl.NumberFormat(S.locale, { style: "currency", currency: cur, minimumFractionDigits: d, maximumFractionDigits: d }).format(n); } catch (e) {}
      try { return (cur ? cur + " " : "") + n.toLocaleString(S.locale, { minimumFractionDigits: d, maximumFractionDigits: d }); } catch (e2) { return String(n); }
    }
    function sameSite(u) { try { return new URL(u, location.href).host.replace(/^www\./, "") === location.host.replace(/^www\./, ""); } catch (e) { return false; } }
    // the product's page, with tracking tags when the website has them on
    function viewUrl(p) {
      var u = safeUrl(p.url); if (pcfg().utm === false) return u;
      try { var x = new URL(u, location.href); if (!/^https?:$/.test(x.protocol)) return u; x.searchParams.set("utm_source", "growthxai"); x.searchParams.set("utm_medium", "chat"); x.searchParams.set("utm_campaign", String(S.cfg.name || "chat").slice(0, 80)); return x.toString(); } catch (e) { return u; }
    }
    function productCards(items, mid) {
      var pc = pcfg(), list = items.slice(0, 6);
      return '<div class="pc' + (list.length > 1 ? " multi" : "") + '" data-pc="' + esc(mid) + '"><button type="button" class="nav l" data-nav="-1" aria-label="' + esc(T("prev_cards")) + '">' + I.chev + '</button><div class="cards" role="list">' + list.map(function (p, i) {
        var title = String(p.title || ""), img = p.image && /^https?:\/\//i.test(p.image) && !S.badImg[p.image] ? p.image : null, cart = S.cart[mid + ":" + p.id], site = sameSite(p.url);
        var price = pc.show_prices !== false && typeof p.price === "number" ? '<div class="pr"><span>' + esc(money(p.price, p.currency)) + "</span>" + (typeof p.compare_at === "number" && p.compare_at > p.price ? "<s>" + esc(money(p.compare_at, p.currency)) + "</s>" : "") + "</div>" : "";
        // Add to cart: Shopify only, on the store's own domain, for a product that can be bought
        var atc = pc.add_to_cart && p.variant_id && p.available !== false && site
          ? (cart === "ok" ? '<span class="done">' + esc(T("added")) + ' · <a href="/cart">' + esc(T("view_cart")) + "</a></span>" : '<button type="button" class="atc" data-atc="' + i + '"' + (cart === "busy" ? " disabled" : "") + ">" + esc(T("add_cart")) + "</button>") : "";
        return '<div class="cardi pcard" role="listitem">' +
          (img ? '<img class="pi" src="' + esc(img) + '" alt="" loading="lazy" referrerpolicy="no-referrer" data-pi="' + i + '">' : '<div class="ph" aria-hidden="true">' + esc(title.trim().charAt(0).toUpperCase() || "•") + "</div>") +
          '<div class="ct"><b title="' + esc(title) + '">' + esc(title) + "</b>" + price + (p.available === false ? '<div class="oos">' + esc(T("oos")) + "</div>" : "") +
          '<div class="acts"><a href="' + esc(viewUrl(p)) + '" data-pv="' + i + '"' + (site ? "" : ' target="_blank"') + ' rel="noopener">' + esc(T("view")) + '</a><button type="button" data-pa="' + i + '">' + esc(T("ask_about")) + "</button>" + atc + "</div></div></div>";
      }).join("") + '</div><button type="button" class="nav r" data-nav="1" aria-label="' + esc(T("next_cards")) + '">' + I.chev + "</button></div>";
    }
    // product events: the SDK, window CustomEvents (growthxai:product:…) and the website's report
    function track(name, props) { sdk.emit(name, props); if (S.conv && S.vt) api("POST", "/events", { name: name, props: props, conversation_id: S.conv.id }, { keepalive: true }).catch(function () {}); }
    function productsOf(mid) { if (mid === "live") return (S.aiStream && S.aiStream.products) || []; var m = S.byId[mid]; return (m && (m.content_attributes || {}).products) || []; }
    function addToCart(mid, p, b) {
      var key = mid + ":" + p.id; if (S.cart[key]) return;
      S.cart[key] = "busy"; b.disabled = true;
      var id = /^\d{1,15}$/.test(String(p.variant_id)) ? Number(p.variant_id) : p.variant_id;
      fetch("/cart/add.js", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ items: [{ id: id, quantity: 1 }] }) })
        .then(function (r) { if (!r.ok) throw new Error("cart " + r.status); S.cart[key] = "ok"; track("product:added_to_cart", { id: p.id, variant_id: String(p.variant_id) }); renderMessages(false); })
        .catch(function () { delete S.cart[key]; location.assign(viewUrl(p)); });   // the shop would not take it: the product page can
    }
    function wireProducts(b) {
      b.querySelectorAll(".pc").forEach(function (box) {
        var mid = box.getAttribute("data-pc"), list = productsOf(mid), row = box.querySelector(".cards");
        var at = function (n, k) { return list[+n.getAttribute(k)]; };
        box.querySelectorAll("[data-nav]").forEach(function (n) { n.addEventListener("click", function () { row.scrollBy({ left: +n.getAttribute("data-nav") * 178, behavior: "smooth" }); }); });
        box.querySelectorAll("[data-pi]").forEach(function (n) { n.addEventListener("error", function () { var p = at(n, "data-pi"); if (p && p.image) S.badImg[p.image] = 1; var d = el("div", "ph", esc(String((p && p.title) || "").trim().charAt(0).toUpperCase() || "•")); d.setAttribute("aria-hidden", "true"); n.replaceWith(d); }); });
        box.querySelectorAll("[data-pv]").forEach(function (n) { n.addEventListener("click", function () { var p = at(n, "data-pv"); if (p) track("product:clicked", { id: p.id, action: "view" }); }); });
        box.querySelectorAll("[data-pa]").forEach(function (n) { n.addEventListener("click", function () { var p = at(n, "data-pa"); if (!p) return; track("product:clicked", { id: p.id, action: "ask" }); S.nextContext = "product:" + p.id; sendText(T("tell_more", { title: p.title })); }); });
        box.querySelectorAll("[data-atc]").forEach(function (n) { n.addEventListener("click", function () { var p = at(n, "data-atc"); if (p) addToCart(mid, p, n); }); });
      });
    }
    // a message with cards that arrived now (not one read from history) counts as shown, once
    function noteShown(m, silent) {
      var ps = m && m.sender_type !== "visitor" && (m.content_attributes || {}).products;
      if (!ps || !ps.length || S.shownP[m.id]) return;
      S.shownP[m.id] = 1;
      if (!silent) track("product:shown", { ids: ps.map(function (p) { return p.id; }) });
    }
    function formBlock(m) {
      var a = m.content_attributes || {};
      if (a.response || a.submitted) return '<div class="fb"><span class="ok">✓ ' + esc(a.form === "email" ? (a.response && a.response.email) || "" : T("sent")) + "</span></div>";
      if (a.form === "email") return '<form class="form" data-form="email"><input type="email" name="email" placeholder="' + esc(T("email_ph")) + '" required autocomplete="email"><button class="pbtn" type="submit">' + esc(T("send")) + '</button><div class="err"></div></form>';
      var items = a.items || [];
      return '<form class="form" data-form="generic">' + items.map(function (f, i) { var n = esc(f.name || "f" + i); return '<div><label>' + esc(f.label || f.name) + "</label>" + (f.type === "select" ? '<select name="' + n + '">' + (f.options || []).map(function (o) { return '<option value="' + esc(o.value) + '">' + esc(o.label) + "</option>"; }).join("") + "</select>" : f.type === "text_area" ? '<textarea name="' + n + '" rows="3" placeholder="' + esc(f.placeholder || "") + '"' + (f.required ? " required" : "") + "></textarea>" : '<input name="' + n + '" type="' + (f.type === "email" ? "email" : "text") + '" placeholder="' + esc(f.placeholder || "") + '"' + (f.required ? " required" : "") + ">") + "</div>"; }).join("") + '<button class="pbtn" type="submit">' + esc(a.button_label || T("submit")) + "</button></form>";
    }
    function csatBlock(m) {
      var a = m.content_attributes || {}, r = a.response || (S.conv && S.conv.csat);
      if (r) return '<div class="fb"><span class="ok">✓ ' + esc(T("rated")) + "</span></div>";
      var scale = a.scale === "thumbs" ? [[1, "👎"], [5, "👍"]] : [[1, "😞"], [2, "😕"], [3, "😐"], [4, "🙂"], [5, "😍"]];
      return '<div><p>' + esc(T("rate")) + '</p><div class="csat" role="radiogroup">' + scale.map(function (s) { return '<button type="button" role="radio" aria-checked="false" data-rate="' + s[0] + '" aria-label="' + s[0] + '">' + s[1] + "</button>"; }).join("") + "</div>" + (a.ask_comment !== false ? '<form class="form" data-form="csat"><textarea name="comment" rows="2" placeholder="' + esc(T("comment")) + '"></textarea><button class="pbtn" type="submit" disabled>' + esc(T("submit")) + "</button></form>" : "") + "</div>";
    }
    function aiExtras(m) {
      var a = m.content_attributes || {}, h = "";
      if ((S.eff.ai || {}).show_sources !== false && a.sources && a.sources.length) h += '<details class="src"><summary>' + esc(T("sources")) + "</summary>" + a.sources.map(function (s) { return s.url ? '<a href="' + esc(safeUrl(s.url)) + '" target="_blank" rel="noopener noreferrer">' + esc(s.title || s.url) + "</a>" : ""; }).join("") + "</details>";
      h += '<div class="fb">' + (a.feedback ? '<span class="ok">✓ ' + esc(T("thanks")) + "</span>" : '<button type="button" data-fb="1" data-turn="' + esc(a.turn_id || "") + '" aria-label="' + esc(T("helpful")) + '">👍</button><button type="button" data-fb="-1" data-turn="' + esc(a.turn_id || "") + '" aria-label="' + esc(T("nothelpful")) + '">👎</button>') + "</div>";
      return h;
    }
    function wireBubbles() {
      var b = ui.body;
      wireProducts(b);
      b.querySelectorAll("[data-att]").forEach(function (n) {
        var id = n.getAttribute("data-att"), isImg = n.tagName === "IMG";
        var load = function () { return api("GET", "/attachments/" + S.conv.id + "/" + encodeURIComponent(id)).then(function (r) { return r.url; }); };
        if (isImg) { load().then(function (u) { n.src = u; n.addEventListener("click", function () { lightbox(u); }); }).catch(function () {}); }
        else n.addEventListener("click", function () { load().then(function (u) { win.open(u, "_blank", "noopener"); }).catch(showErr); });
      });
      b.querySelectorAll("[data-qr]").forEach(function (n) { n.addEventListener("click", function () { sendText(n.getAttribute("data-qr")); }); });
      b.querySelectorAll("[data-pb]").forEach(function (n) { n.addEventListener("click", function () { sdk.emit("postback", { payload: n.getAttribute("data-pb") }); api("POST", "/events", { name: "postback", props: { payload: n.getAttribute("data-pb") }, conversation_id: S.conv.id }).catch(function () {}); }); });
      b.querySelectorAll("[data-fb]").forEach(function (n) { n.addEventListener("click", function () { var turn = n.getAttribute("data-turn"), v = +n.getAttribute("data-fb"); var msgEl = n.closest(".msg"), m = S.byId[msgEl.getAttribute("data-id")]; if (m) { m.content_attributes = Object.assign({}, m.content_attributes, { feedback: v }); } renderMessages(false); api("POST", "/feedback", { turn_id: turn, value: v }).catch(function () {}); }); });
      b.querySelectorAll("[data-retry]").forEach(function (n) { n.addEventListener("click", function () { var p = S.pending[n.getAttribute("data-retry")]; if (p) { p.failed = false; p.pending = true; renderMessages(false); deliver(p); } }); });
      b.querySelectorAll("[data-rate]").forEach(function (n) { n.addEventListener("click", function () { var wrap = n.closest(".bub"); wrap.querySelectorAll("[data-rate]").forEach(function (x) { x.classList.remove("on"); x.setAttribute("aria-checked", "false"); }); n.classList.add("on"); n.setAttribute("aria-checked", "true"); wrap.setAttribute("data-rating", n.getAttribute("data-rate")); var f = wrap.querySelector("form[data-form=csat]"); if (f) f.querySelector("button").disabled = false; else submitCsat(+n.getAttribute("data-rate"), null); }); });
      b.querySelectorAll("form[data-form]").forEach(function (f) {
        f.addEventListener("submit", function (e) {
          e.preventDefault(); var kind = f.getAttribute("data-form");
          if (kind === "email") { var em = f.email.value.trim(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) { f.querySelector(".err").textContent = T("invalid_email"); return; } var msgEl = f.closest(".msg"), m = S.byId[msgEl.getAttribute("data-id")]; m.content_attributes = Object.assign({}, m.content_attributes, { response: { email: em } }); if (S.visitor) S.visitor.email = em; renderMessages(false); sendRaw({ content_type: "form_response", content_attributes: { form: "email", values: { email: em } } }); }
          else if (kind === "csat") { var wrap = f.closest(".bub"); submitCsat(+wrap.getAttribute("data-rating"), f.comment.value.trim() || null); }
          else { var vals = []; Array.prototype.forEach.call(f.elements, function (x) { if (x.name) vals.push({ name: x.name, value: x.value }); }); var mm = S.byId[f.closest(".msg").getAttribute("data-id")]; mm.content_attributes = Object.assign({}, mm.content_attributes, { submitted: true }); renderMessages(false); sendRaw({ content_type: "form_response", content_attributes: { form: "generic", message_id: mm.id, values: vals } }); }
        });
      });
    }
    function submitCsat(rating, comment) { api("POST", "/conversations/" + S.conv.id + "/csat", { rating: rating, comment: comment }).then(function (r) { S.conv = Object.assign(S.conv, r.conversation); sdk.emit("csat:submitted", { rating: rating }); renderMessages(false); }).catch(showErr); }
    function lightbox(u) { var d = el("div", "light", '<img src="' + esc(u) + '" alt="">'); d.addEventListener("click", function () { d.remove(); }); root.appendChild(d); }
    function toast(t, ms) { var d = el("div", "toast", esc(t)); d.setAttribute("role", "status"); ui.panel.appendChild(d); setTimeout(function () { d.remove(); }, ms || Math.max(1800, Math.min(6000, String(t).length * 60))); }
    function showErr(e) { var code = e && e.code; toast(code === "E_RATE_LIMITED" ? T("rate_limited") : code === "E_TURNSTILE" ? T("verify_failed") : code === "E_TOO_LARGE" ? T("too_large", { mb: 10 }) : code === "E_TYPE_BLOCKED" ? T("bad_type") : T("error")); sdk.emit("error", { code: code, message: e && e.message }); }

    // ---------------------------------------------------------------- composer --------------------------------------
    function composerDisabled() {
      if (!S.conv) return null; var feats = S.eff.features || {};
      if (S.conv.status === "resolved" && feats.allow_after_resolved === false) return T("closed");
      return null;
    }
    function renderComposer() {
      if (S.view !== "messages") return;
      var feats = S.eff.features || {}, ms = S.eff.messages || {}, dis = composerDisabled();
      if (dis) { ui.cp.innerHTML = '<div class="dis">' + esc(dis) + '</div><div class="acts" style="justify-content:center;margin:0 0 6px"><button type="button" class="sbtn" data-new="1">' + esc(T("newconv")) + "</button></div>"; ui.cp.querySelector("[data-new]").addEventListener("click", function () { startNew(); }); mountAsk(); return; }
      var ph = t2("placeholder") || (ms.placeholder && !/^(Type a message|Ask a question)(…|\.\.\.)$/.test(ms.placeholder) ? ms.placeholder : T("placeholder"));   // an untouched default follows the visitor's language
      ui.cp.innerHTML = '<div class="box"><div class="files"></div>' +
        '<textarea rows="1" maxlength="5000" placeholder="' + esc(ph) + '" aria-label="' + esc(ph) + '"></textarea>' +
        '<div class="tools">' + (feats.file_picker !== false ? '<button class="ib" type="button" data-c="file" aria-label="' + esc(T("attach")) + '" title="' + esc(T("attach")) + '">' + I.clip + '</button><input type="file" multiple hidden>' : "") +
        (feats.emoji_picker !== false ? '<button class="ib" type="button" data-c="emoji" aria-label="' + esc(T("emoji")) + '" title="' + esc(T("emoji")) + '">' + I.smile + "</button>" : "") +
        '<span class="sp"></span><button class="ib send" type="button" data-c="send" aria-label="' + esc(T("send")) + '" disabled>' + I.send + "</button></div></div>";
      var ta = ui.cp.querySelector("textarea"), sendB = ui.cp.querySelector("[data-c=send]"), fileI = ui.cp.querySelector("input[type=file]"), box = ui.cp.querySelector(".box");
      ui.ta = ta;
      box.addEventListener("click", function (e) { if (!e.target.closest("button,textarea,input,.emo")) ta.focus(); });
      var typingT = 0, lastTyping = 0;
      // while the box is empty the send button is the mic (a voice call), WhatsApp-style; typing turns it back into send
      var syncSend = ui.syncSend = function () {
        var empty = !ta.value.trim() && !S.files.length, mic = empty && voiceShow("composer"), was = sendB.classList.contains("mic");
        sendB.disabled = empty && !mic;
        if (mic !== was || !sendB.firstChild) { sendB.classList.toggle("mic", mic); sendB.innerHTML = mic ? I.mic : I.send; var lb = mic ? T("call") : T("send"); sendB.setAttribute("aria-label", lb); sendB.title = lb; }
      };
      ta.addEventListener("input", function () { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 120) + "px"; syncSend(); if (!S.conv) return;   // a question not sent yet: the conversation starts with the first message
        var now = Date.now(); if (now - lastTyping > 2000) { lastTyping = now; api("POST", "/conversations/" + S.conv.id + "/typing", { on: true, preview: ta.value.slice(0, 300) }).catch(function () {}); } clearTimeout(typingT); typingT = setTimeout(function () { if (S.conv) api("POST", "/conversations/" + S.conv.id + "/typing", { on: false }).catch(function () {}); }, 4000); });
      ta.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submit(); } });
      ta.addEventListener("paste", function (e) { var items = (e.clipboardData || {}).items || []; for (var i = 0; i < items.length; i++) if (items[i].kind === "file") { var f = items[i].getAsFile(); if (f) addFile(f); } });
      sendB.addEventListener("click", function () { if (sendB.classList.contains("mic")) startCall({ source: "voice" }); else submit(); });
      sendB.addEventListener("mouseenter", function () { if (sendB.classList.contains("mic")) loadVoice().catch(function () {}); });
      ui.cp.querySelectorAll("[data-c=file]").forEach(function (b) { b.addEventListener("click", function () { fileI.click(); }); });
      if (fileI) fileI.addEventListener("change", function () { Array.prototype.forEach.call(fileI.files, addFile); fileI.value = ""; });
      ui.cp.querySelectorAll("[data-c=emoji]").forEach(function (b) { b.addEventListener("click", function () { var p = ui.cp.querySelector(".emo"); if (p) { p.remove(); return; } p = el("div", "emo", EMOJIS.map(function (x) { return '<button type="button">' + x + "</button>"; }).join("")); p.querySelectorAll("button").forEach(function (x) { x.addEventListener("click", function () { var s = ta.selectionStart || ta.value.length; ta.value = ta.value.slice(0, s) + x.textContent + ta.value.slice(ta.selectionEnd || s); ta.dispatchEvent(new Event("input")); ta.focus(); p.remove(); }); }); box.appendChild(p); }); });
      ["dragenter", "dragover"].forEach(function (ev) { ui.panel.addEventListener(ev, function (e) { e.preventDefault(); ui.panel.classList.add("drag"); }); });
      ["dragleave", "drop"].forEach(function (ev) { ui.panel.addEventListener(ev, function (e) { e.preventDefault(); ui.panel.classList.remove("drag"); if (ev === "drop" && e.dataTransfer && feats.file_picker !== false) Array.prototype.forEach.call(e.dataTransfer.files, addFile); }); });
      renderFiles(); mountAsk(); syncSend(); syncVoiceChip();
      function submit() { var t = ta.value.trim(); if (!t && !S.files.length) return; ta.value = ""; ta.style.height = "auto"; clearTimeout(typingT); sendText(t); syncSend(); }
    }
    // A question the widget has to ask (the email for a transcript) is a field on top of the message box, never a browser
    // dialog: label, input, cancel and confirm, with the validation error under it. Enter confirms, Escape cancels.
    // S.ask survives a composer re-render and is dropped when the visitor leaves the conversation.
    function askInline(o) { S.ask = o; mountAsk(true); }
    function mountAsk(focus) {
      var o = S.ask, old = ui.cp.querySelector(".askw"); if (old) { var ob = old.parentNode; old.remove(); if (ob.classList.contains("solo")) ob.remove(); }
      if (!o || S.view !== "messages") return;
      var box = ui.cp.querySelector(".box"), f = el("form", "askw");
      f.noValidate = true;
      f.innerHTML = '<div class="askl">' + esc(o.label) + '</div><div class="ask"><input type="' + esc(o.type || "text") + '" placeholder="' + esc(o.placeholder || "") + '" aria-label="' + esc(o.label) + '"' + (o.type === "email" ? ' autocomplete="email" inputmode="email"' : "") + ">" +
        '<button class="ib" type="button" data-k="x" aria-label="' + esc(T("cancel")) + '" title="' + esc(T("cancel")) + '">' + I.x + '</button><button class="ib go" type="submit" aria-label="' + esc(T("send")) + '" title="' + esc(T("send")) + '">' + I.check + '</button></div><div class="aske" role="alert"></div>';
      if (box) box.insertBefore(f, box.firstChild); else { box = el("div", "box solo"); f.classList.add("solo"); box.appendChild(f); ui.cp.insertBefore(box, ui.cp.firstChild); }
      var inp = f.querySelector("input"), err = f.querySelector(".aske");
      inp.value = o.value || "";
      function close() { S.ask = null; mountAsk(); if (ui.ta && ui.ta.isConnected) ui.ta.focus(); }
      inp.addEventListener("input", function () { o.value = inp.value; err.textContent = ""; });
      inp.addEventListener("keydown", function (e) { if (e.key === "Escape") { e.stopPropagation(); close(); } });
      f.querySelector("[data-k=x]").addEventListener("click", close);
      f.addEventListener("submit", function (e) { e.preventDefault(); var v = inp.value.trim(), bad = o.validate ? o.validate(v) : null; if (bad) { err.textContent = bad; inp.focus(); return; } close(); o.done(v); });
      if (focus) inp.focus();
    }
    function addFile(f) {
      var sec = (S.eff.security || {}).attachments || {}, max = Math.min(sec.max_mb || 10, 10) * 1048576;
      if (f.size > max) { toast(T("too_large", { mb: Math.round(max / 1048576) })); return; }
      if (/\.(exe|msi|bat|cmd|com|scr|ps1|sh|js|jar|vbs|dll|apk|dmg|pkg|html?|svg)$/i.test(f.name)) { toast(T("bad_type")); return; }
      if (S.files.length >= 5) return;
      S.files.push(f); renderFiles(); if (ui.syncSend && ui.ta && ui.ta.isConnected) ui.syncSend();
    }
    function renderFiles() { var w = ui.cp.querySelector(".files"); if (!w) return; w.innerHTML = S.files.map(function (f, i) { return "<span>" + esc(f.name) + '<button type="button" data-rm="' + i + '" aria-label="' + esc(T("close")) + '">×</button></span>'; }).join(""); w.querySelectorAll("[data-rm]").forEach(function (b) { b.addEventListener("click", function () { S.files.splice(+b.getAttribute("data-rm"), 1); renderFiles(); if (ui.syncSend && ui.ta && ui.ta.isConnected) ui.syncSend(); }); }); }

    // ---------------------------------------------------------------- Turnstile (PRD §7: bot check before the first message)
    // Cloudflare's script is loaded only when the inbox has it on, and the box renders into a light-DOM host (Turnstile
    // does not render inside a closed shadow root) with appearance "interaction-only": nothing shows unless Cloudflare
    // needs a click, then the box appears over the composer. Tokens are single-use and expire after 5 minutes, so one
    // is fetched right before each conversation start and sent as `turnstile_token`; the server verifies it.
    var ts = { load: null, wait: null, id: null, host: null };
    function turnstileOn() { var sec = S.eff.security || {}; return !!(sec.turnstile_enabled && sec.turnstile_site_key); }
    function turnstileScript() {
      if (win.turnstile) return Promise.resolve(win.turnstile);
      if (ts.load) return ts.load;
      ts.load = new Promise(function (res, rej) {
        var s = doc.querySelector('script[src^="https://challenges.cloudflare.com/turnstile/"]');
        if (!s) { s = doc.createElement("script"); s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"; s.async = true; s.defer = true; (doc.head || doc.documentElement).appendChild(s); }
        s.addEventListener("load", function () { if (win.turnstile) res(win.turnstile); else rej(new Error("turnstile")); });
        s.addEventListener("error", function () { ts.load = null; rej(new Error("turnstile")); });
      });
      return ts.load;
    }
    function turnstileHost(show) {
      if (!ts.host) { ts.host = el("div"); ts.host.setAttribute("data-growthxai", "turnstile"); ts.host.style.cssText = "position:fixed;z-index:2147483001;opacity:0;pointer-events:none;transition:opacity .15s"; (doc.body || doc.documentElement).appendChild(ts.host); }
      if (show && ui.panel) { var r = ui.panel.getBoundingClientRect(); ts.host.style.left = Math.max(8, r.left + 16) + "px"; ts.host.style.top = Math.max(8, r.bottom - 150) + "px"; }
      ts.host.style.opacity = show ? "1" : "0"; ts.host.style.pointerEvents = show ? "auto" : "none";
      return ts.host;
    }
    function codeErr(code) { var e = new Error(code); e.code = code; return e; }
    function turnstileToken() {
      if (!turnstileOn()) return Promise.resolve(null);
      if (ts.wait) return ts.wait;
      ts.wait = turnstileScript().then(function (tsl) {
        return new Promise(function (res, rej) {
          var host = turnstileHost(false), timer = setTimeout(function () { finish(); rej(codeErr("E_TURNSTILE")); }, 120000);
          function finish() { clearTimeout(timer); ts.wait = null; turnstileHost(false); }
          try { if (ts.id != null) tsl.remove(ts.id); } catch (e) {}
          ts.id = null; host.innerHTML = "";
          ts.id = tsl.render(host, { sitekey: S.eff.security.turnstile_site_key, action: "webchat_start", appearance: "interaction-only", theme: isDark() ? "dark" : "light", size: "normal",
            callback: function (token) { finish(); res(token); },
            "error-callback": function () { finish(); rej(codeErr("E_TURNSTILE")); return true; },
            "timeout-callback": function () { finish(); rej(codeErr("E_TURNSTILE")); },
            "before-interactive-callback": function () { turnstileHost(true); },
            "after-interactive-callback": function () { turnstileHost(false); } });
        });
      }).catch(function () { ts.wait = null; turnstileHost(false); throw codeErr("E_TURNSTILE"); });
      return ts.wait;
    }

    // ---------------------------------------------------------------- sending ---------------------------------------
    function sendText(text) {
      if (V && V.active()) { if (text) V.say(text); return; }
      if (!S.conv) { pendingFirst = null; return startNew(text); }
      if (composerDisabled()) return startNew(text);
      var files = S.files.splice(0); renderFiles();
      // background for the assistant on this question: what the button said (once), and the product this page is about
      var ctx = S.nextContext, ld = ldProduct(); S.nextContext = null;
      var m = { id: "tmp-" + uid(), echo_id: uid(), conversation_id: S.conv.id, sender_type: "visitor", content_type: files.length ? "attachment" : "text", text: text || null, attachments: files.map(function (f) { return { name: f.name, type: f.type, size: f.size, id: "local" }; }), sent_at: new Date().toISOString(), pending: true, _files: files,
                context: ctx ? String(ctx).slice(0, 700) : undefined, product: ld ? String(ld.url || ld.sku || ld.name).slice(0, 300) : undefined };
      S.pending[m.echo_id] = m; S.msgs.push(m); L.store.set("chatted", 1); L.store.set("sent", 1); renderMessages(true);
      deliver(m);
    }
    function sendRaw(o) { var m = Object.assign({ id: "tmp-" + uid(), echo_id: uid(), sender_type: "visitor", sent_at: new Date().toISOString(), pending: true, hidden: true }, o); S.pending[m.echo_id] = m; deliver(m); }
    function deliver(m) {
      if (!navigator.onLine) { queueOffline(m); return; }
      var up = Promise.resolve([]);
      if (m._files && m._files.length) up = Promise.all(m._files.map(uploadFile));
      up.then(function (ids) {
        return api("POST", "/conversations/" + S.conv.id + "/messages", { echo_id: m.echo_id, text: m.text, attachments: ids.filter(Boolean), content_type: m.content_type, content_attributes: m.content_attributes || {}, context: m.context, product: m.product });
      }).then(function (r) {
        delete S.pending[m.echo_id]; S.msgs = S.msgs.filter(function (x) { return x !== m; });
        if (r.dropped) { r.message.pending = false; }
        if (r.new_conversation && r.conversation) { S.convs = [r.conversation].concat(S.convs.filter(function (x) { return x.id !== r.conversation.id; })); noteLive(); openConv(r.conversation.id).then(function () { addMsg(r.message); renderMessages(true); }); return; }
        if (r.conversation) { Object.assign(S.conv, r.conversation); syncConvList(); }
        if (!m.hidden) { addMsg(r.message); }
        renderMessages(true); broadcastTabs({ t: "sync", conv: S.conv.id });
        sdk.emit("message:sent", { id: r.message && r.message.id, text: m.text });
        if (r.ai) streamAi(r.message.id);
        if (r.handoff) sdk.emit("handoff", { id: S.conv.id });
        if (S.mode === "modal" && !S.handedToSidebar) { S.handedToSidebar = true; api_.setMode("sidebar"); }
      }).catch(function (e) {
        if (e && e.code === "E_RATE_LIMITED") { toast(T("rate_limited")); }
        m.pending = false; m.failed = true; renderMessages(false); if (!(e && e.code === "E_RATE_LIMITED")) showErr(e);
      });
    }
    function uploadFile(f) {
      return api("POST", "/uploads", { conversation_id: S.conv.id, name: f.name, type: f.type || "application/octet-stream", size: f.size }).then(function (r) {
        return fetch(r.url, { method: "PUT", headers: { "content-type": f.type || "application/octet-stream", "x-upsert": "false" }, body: f }).then(function (res) { if (!res.ok) throw new Error("upload failed"); return r.upload_id; });
      });
    }
    function queueOffline(m) { var q = store.get("q") || []; q.push({ conv: S.conv.id, echo_id: m.echo_id, text: m.text, content_type: m.content_type, content_attributes: m.content_attributes || {}, context: m.context, product: m.product }); store.set("q", q.slice(-20)); toast(T("offline_q")); }
    function flushQueue() {
      var q = store.get("q") || []; if (!q.length || !navigator.onLine || !S.conv) return;
      var mine = q.filter(function (x) { return x.conv === S.conv.id; }); store.set("q", q.filter(function (x) { return x.conv !== S.conv.id; }));
      mine.reduce(function (p, x) { return p.then(function () { return api("POST", "/conversations/" + x.conv + "/messages", { echo_id: x.echo_id, text: x.text, content_type: x.content_type, content_attributes: x.content_attributes, context: x.context, product: x.product }).then(function (r) { var pm = S.pending[x.echo_id]; if (pm) { delete S.pending[x.echo_id]; S.msgs = S.msgs.filter(function (y) { return y !== pm; }); } addMsg(r.message); renderMessages(true); if (r.ai) streamAi(r.message.id); }).catch(function () {}); }); }, Promise.resolve());
    }
    win.addEventListener("online", flushQueue);

    // ---------------------------------------------------------------- AI streaming (PRD §5.4) -----------------------
    function streamAi(messageId) {
      var page = pageContext();
      S.aiStream = { html: aiBubble('<div class="bub typing"><i></i><i></i><i></i></div>'), text: "" };
      renderMessages(true);
      var ctl = ("AbortController" in win) ? new AbortController() : null;
      S.aiAbort = ctl;
      fetch(API + "/chat?token=" + encodeURIComponent(TOKEN), { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + S.vt, "x-website-token": TOKEN }, body: JSON.stringify({ conversation_id: S.conv.id, message_id: messageId, page: page }), signal: ctl ? ctl.signal : undefined })
        .then(function (res) {
          if (!res.ok || !res.body) throw new Error("http " + res.status);
          var reader = res.body.getReader(), dec = new TextDecoder(), buf = "", done = false;
          function pump() { return reader.read().then(function (r) { if (r.done) { finish(); return; } buf += dec.decode(r.value, { stream: true }); var frames = buf.split("\n\n"); buf = frames.pop(); frames.forEach(handle); return pump(); }); }
          function handle(f) {
            var ev = (f.match(/^event:\s*(.*)$/m) || [])[1] || "", data = (f.match(/^data:\s*([\s\S]*)$/m) || [])[1] || ""; var j; try { j = JSON.parse(data); } catch (e) { j = data; }
            if (ev === "token" && !done) { S.aiStream.text += j; S.aiStream.html = aiBubble('<div class="bub">' + md(S.aiStream.text, true) + '<span class="cur"></span></div>'); renderMessages(true); }
            // the cards the answer recommends arrive after its text and before `done`
            else if (ev === "products" && !done && j && Array.isArray(j.items) && j.items.length) { S.aiStream.products = j.items; S.aiStream.html = aiBubble('<div class="bub">' + md(S.aiStream.text, true) + productCards(j.items, "live") + "</div>"); renderMessages(true); track("product:shown", { ids: j.items.map(function (p) { return p.id; }) }); }
            else if (ev === "done") { done = true; var shown = S.aiStream && S.aiStream.products; S.aiStream = null; if (j && j.message) { if (shown) S.shownP[j.message.id] = 1; else noteShown(j.message); Object.keys(S.cart).forEach(function (k) { if (k.indexOf("live:") === 0) { S.cart[j.message.id + k.slice(4)] = S.cart[k]; delete S.cart[k]; } }); addMsg(j.message); } renderMessages(true); if (j && j.handoff) sdk.emit("handoff", { id: S.conv.id }); }
            else if (ev === "skip" || ev === "cancelled") { done = true; S.aiStream = null; renderMessages(true); }
            else if (ev === "error") { done = true; S.aiStream = null; renderMessages(true); }
          }
          function finish() { if (!done) { S.aiStream = null; renderMessages(true); } }
          return pump();
        }).catch(function () { S.aiStream = null; renderMessages(true); });
    }
    function pageContext() {
      try {
        var skip = { SCRIPT: 1, STYLE: 1, NAV: 1, FOOTER: 1, HEADER: 1, NOSCRIPT: 1, SVG: 1 }, w = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, { acceptNode: function (n) { return skip[n.parentElement && n.parentElement.tagName] || (n.parentElement && n.parentElement.closest && n.parentElement.closest("[data-growthxai]")) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; } }), text = "", node;
        while ((node = w.nextNode()) && text.length < 2500) { var t = node.textContent.trim(); if (t) text += t + " "; }
        return { url: location.href, title: doc.title, text: text.trim().slice(0, 2500), product: ldProduct() || undefined };
      } catch (e) { return { url: location.href, title: doc.title }; }
    }
    // The product this page is about, from its JSON-LD ({ name, sku, url }): the assistant then knows what "this" is.
    // A page that describes several products (a collection) names none.
    function ldProduct() {
      try {
        var found = [], nodes = doc.querySelectorAll('script[type="application/ld+json"]');
        var walk = function (n, d) {
          if (!n || d > 5 || found.length > 1) return;
          if (Array.isArray(n)) { n.forEach(function (x) { walk(x, d + 1); }); return; }
          if (typeof n !== "object") return;
          var t = n["@type"];
          if (t === "Product" || (Array.isArray(t) && t.indexOf("Product") >= 0)) { found.push(n); return; }
          walk(n["@graph"], d + 1); walk(n.mainEntity, d + 1);
        };
        for (var i = 0; i < nodes.length && i < 20; i++) { try { walk(JSON.parse(nodes[i].textContent), 0); } catch (e) {} }
        var p = found.length === 1 ? found[0] : null; if (!p || !p.name) return null;
        var o = Array.isArray(p.offers) ? p.offers[0] : p.offers, u = p.url || (o && o.url) || location.href;
        return { name: String(p.name).slice(0, 200), sku: p.sku ? String(p.sku).slice(0, 120) : undefined, url: String(new URL(u, location.href)).slice(0, 300) };
      } catch (e) { return null; }
    }

    // ---------------------------------------------------------------- realtime + polling + heartbeat -----------------
    function joinRealtime() {
      if (!S.conv || !S.conv.stream_key) return;
      var rtc = S.cfg.realtime || {};
      if (!S.rt && rtc.url && rtc.anon_key && "WebSocket" in win) { S.rt = new Realtime(rtc.url, rtc.anon_key); S.rt.onstate = function (up) { if (up) { stopPoll(); catchUp(); } else startPoll(); }; }
      var topic = "webchat:" + S.conv.id + ":" + S.conv.stream_key;
      if (S.rt) S.rt.subscribe(topic, function (ev, payload) { onRealtime(ev, payload); });
      if (!S.rt || !S.rt.connected()) startPoll();
    }
    function leaveRealtime() { if (S.rt && S.conv) S.rt.unsubscribe("webchat:" + S.conv.id + ":" + S.conv.stream_key); stopPoll(); stopHeartbeat(); }
    function onRealtime(ev, p) {
      if (!S.conv || !p) return;
      if (ev === "message.created" && p.message) { if (p.message.conversation_id !== S.conv.id) return; dropLive(p.message); var isNew = addMsg(p.message);
        if (isNew && V && V.active()) { V.onMessage(p.message); return; }
        if (isNew && p.message.sender_type !== "visitor") { S.agentTyping = null; if (S.aiStream && p.message.sender_type === "agent") { if (S.aiAbort) S.aiAbort.abort(); S.aiStream = null; }
          if (S.aiStream && S.aiStream.products && p.message.sender_type === "bot") S.shownP[p.message.id] = 1; else noteShown(p.message);   // the answer being streamed already counted its cards
          notify(p.message); sdk.emit("message", strip(p.message)); if (S.open && !doc.hidden) markRead(); else bumpUnread(); } renderMessages(true); }
      else if (ev === "message.updated" && p.message) { if (S.byId[p.message.id]) { Object.assign(S.byId[p.message.id], p.message); renderMessages(false); } }
      else if (ev === "typing") { S.agentTyping = p.typing ? (p.agent || T("team")) : null; renderMessages(true); clearTimeout(S.typingT); if (p.typing) S.typingT = setTimeout(function () { S.agentTyping = null; renderMessages(false); }, 12000); }
      else if (ev === "conversation.status" && p.conversation) { Object.assign(S.conv, { status: p.conversation.status, handed_off_at: p.conversation.handed_off_at, resolved_at: p.conversation.resolved_at, ai_handled: p.conversation.ai_handled }); syncConvList(); if (p.conversation.status === "resolved") sdk.emit("conversation:resolved", { id: S.conv.id }); renderView(); }
    }
    // after a call the provider's confirmed transcript arrives: the turns the widget mirrored live make way for it
    function dropLive(m) {
      var v = (m.content_attributes || {}).voice; if (!v || v.live !== false) return;
      S.msgs = S.msgs.filter(function (x) { var xv = (x.content_attributes || {}).voice, drop = !!(xv && xv.live && xv.call_id === v.call_id && x.content_type === "text"); if (drop) delete S.byId[x.id]; return !drop; });
    }
    function strip(m) { return { id: m.id, conversation_id: m.conversation_id, sender_type: m.sender_type, sender_name: m.sender_name, text: m.text, content_type: m.content_type, sent_at: m.sent_at }; }
    // what arrived since the newest message we hold; with an empty thread (a conversation that began with a call), the latest page
    function catchUp() { if (!S.conv) return; var last = S.msgs.filter(function (m) { return !m.pending; }).slice(-1)[0]; api("GET", "/conversations/" + S.conv.id + "/messages?" + (last ? "after=" + encodeURIComponent(last.delivered_at || last.sent_at) : "limit=50")).then(function (r) { var n = 0; (r.messages || []).forEach(function (m) { dropLive(m); if (addMsg(m)) { n++; if (V && V.active()) { V.onMessage(m); return; } if (m.sender_type !== "visitor") { noteShown(m); notify(m); if (S.open && !doc.hidden) markRead(); else bumpUnread(); } } }); if (n) renderMessages(true); }).catch(function () {}); }
    function startPoll() { stopPoll(); S.poll = setInterval(function () { if (S.conv && (S.open || S.mode === "embedded")) catchUp(); }, 5000); }
    function stopPoll() { clearInterval(S.poll); S.poll = null; }
    function startHeartbeat() { stopHeartbeat(); S.hbTimer = setInterval(function () { if (S.conv && S.open && !doc.hidden) api("POST", "/conversations/" + S.conv.id + "/heartbeat").then(function (r) { if (r && r.agent_typing && !S.agentTyping) { S.agentTyping = T("team"); renderMessages(false); } }).catch(function () {}); }, 30000); }
    function stopHeartbeat() { clearInterval(S.hbTimer); S.hbTimer = null; }
    function markRead() { if (!S.conv) return; var unread = S.msgs.some(function (m) { return m.sender_type !== "visitor" && !m.read_by_visitor_at; }); S.msgs.forEach(function (m) { if (m.sender_type !== "visitor" && !m.read_by_visitor_at) m.read_by_visitor_at = new Date().toISOString(); }); if (S.conv.unread) { S.conv.unread = 0; syncConvList(); } setUnreadTotal(); if (unread) api("POST", "/conversations/" + S.conv.id + "/read").catch(function () {}); }
    function bumpUnread() { S.conv.unread = (S.conv.unread || 0) + 1; syncConvList(); setUnreadTotal(); }
    function setUnreadTotal() { var n = 0, prev = []; S.convs.forEach(function (c) { n += c.unread || 0; }); if (S.conv && S.conv.unread) { S.msgs.filter(function (m) { return m.sender_type !== "visitor" && !m.read_by_visitor_at && m.text; }).slice(-2).forEach(function (m) { prev.push({ from: m.sender_name || S.eff.appearance.brand_name, text: m.text }); }); } L.setUnread(n, prev); }
    function syncConvList() { S.convs = S.convs.map(function (c) { return c.id === S.conv.id ? S.conv : c; }); noteLive(); }
    function notify(m) { if ((S.eff.features || {}).sounds === false || S.muted || !doc.hidden && S.open) return; try { var ac = new (win.AudioContext || win.webkitAudioContext)(), o = ac.createOscillator(), g = ac.createGain(); o.type = "sine"; o.frequency.value = 880; g.gain.value = .08; o.connect(g); g.connect(ac.destination); o.start(); g.gain.exponentialRampToValueAtTime(.0001, ac.currentTime + .25); o.stop(ac.currentTime + .26); } catch (e) {} }
    function broadcastTabs(o) { try { bc && bc.postMessage(o); } catch (e) {} }
    try { bc = new BroadcastChannel("gxwc:" + TOKEN); bc.onmessage = function (ev) { var d = ev.data || {}; if (d.t === "sync" && S.conv && d.conv === S.conv.id) catchUp(); if (d.t === "reset") { S.vt = null; S.visitor = null; S.convs = []; S.conv = null; S.msgs = []; if (S.mounted) { S.view = "home"; renderHeader(); renderView(); } } }; } catch (e) {}
    doc.addEventListener("visibilitychange", function () { if (!doc.hidden && S.open && S.conv) { catchUp(); markRead(); } });

    // ---------------------------------------------------------------- actions ---------------------------------------
    function endConversation() { if (!S.conv) return; api("POST", "/conversations/" + S.conv.id + "/resolve").then(function (r) { Object.assign(S.conv, r.conversation); syncConvList(); sdk.emit("conversation:resolved", { id: S.conv.id }); catchUp(); renderView(); }).catch(showErr); }
    function transcript() {
      if (!S.conv) return;
      var conv = S.conv, send = function (em) { api("POST", "/conversations/" + conv.id + "/transcript", em ? { email: em } : {}).then(function (r) { if (em && S.visitor && !S.visitor.email) S.visitor.email = em; toast(r.ok ? T("transcript_sent") : T("error")); }).catch(showErr); };
      if (S.visitor && S.visitor.email) return send();
      askInline({ label: T("transcript_email"), type: "email", placeholder: T("email_ph"), validate: function (v) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? null : T("invalid_email"); }, done: send });
    }
    // The whole conversation as a text file (the server returns every message, not just the loaded page).
    function downloadTranscript() {
      if (!S.conv) return;
      var feats = S.eff.features || {}, brand = t2("brand_name") || S.eff.appearance.brand_name || "Chat";
      api("GET", "/conversations/" + S.conv.id + "/transcript").then(function (r) {
        var out = [brand + " · " + location.hostname, new Date().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })], day = null;
        (r.messages || []).forEach(function (m) {
          if (m.deleted) return;
          var line;
          if (m.content_type === "event") { line = sysLine(m).replace(/<[^>]+>/g, ""); if (!line) return; var ta = doc.createElement("textarea"); ta.innerHTML = line; line = "— " + ta.value + " —"; }
          else {
            var files = (m.attachments || []).map(function (f) { return "[" + (f.name || "file") + "]"; }).join(" "), text = String(m.text || "");
            if (m.sender_type !== "visitor") text = text.replace(/\s*\[\d+\]/g, "").replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1 ($2)").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1");   // plain text: no source markers, no markdown marks
            text = text.replace(/\r?\n/g, "\r\n");
            if (m.content_type === "csat") { var cr = (m.content_attributes || {}).response; text = (text ? text + " " : "") + T("rate") + (cr && cr.rating ? " " + cr.rating + "/5" + (cr.comment ? " — " + cr.comment : "") : ""); }
            // product cards: one line each, as they were offered
            var prods = m.sender_type === "visitor" ? "" : ((m.content_attributes || {}).products || []).map(function (p) { return "\r\n  - " + p.title + (typeof p.price === "number" && pcfg().show_prices !== false ? " · " + money(p.price, p.currency) : "") + " · " + p.url; }).join("");
            text = [text, files].filter(Boolean).join(" ") + prods; if (!text) return;
            var who = m.sender_type === "visitor" ? T("you") : m.sender_type === "bot" ? brand + " (" + T("ai_agent") + ")" : (feats.show_agent_names !== false ? (m.sender_name || T("team")) : T("team"));
            line = "[" + fmtTime(m.sent_at) + "] " + who + ": " + text;
          }
          var d = new Date(m.sent_at).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
          if (d !== day) { out.push("", d, ""); day = d; }
          out.push(line);
        });
        var a = doc.createElement("a"), url = URL.createObjectURL(new Blob(["\ufeff" + out.join("\r\n") + "\r\n"], { type: "text/plain;charset=utf-8" }));
        a.href = url; a.download = "transcript-" + (brand.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "chat") + "-" + new Date().toISOString().slice(0, 10) + ".txt"; a.style.display = "none";
        root.appendChild(a); a.click();   // inside the shadow root: the host page's link handlers never see it
        setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 2000);
      }).catch(showErr);
    }

    // ---------------------------------------------------------------- voice (web-chat-voice-elevenlabs-PRD.md §2) ------
    // The website's public voice settings: { enabled, ui, languages, consent_text, record, max_minutes }. `enabled` is
    // already false when voice is off, the assistant is not on Auto, or the month's minutes are used up.
    var V = null, vLoad = null;
    function vcfg() { return S.eff.voice || {}; }
    function voiceOk() { return !!(vcfg().enabled && L.voiceUrl && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && win.RTCPeerConnection && win.isSecureContext !== false && micAllowed()); }
    // A page whose Permissions-Policy turns the microphone off (microphone=()) fails every call before the browser can
    // ask: voice hides there, and the site owner gets one console line saying what to change.
    var micPolicyWarned = false;
    function micAllowed() {
      var p = doc.permissionsPolicy || doc.featurePolicy, ok = true;
      try { ok = !p || !p.allowsFeature || p.allowsFeature("microphone"); } catch (e) { ok = true; }
      if (!ok && !micPolicyWarned && vcfg().enabled) { micPolicyWarned = true; try { console.warn("[GrowthxAI] Voice is off on this page: its Permissions-Policy blocks the microphone. Send microphone=(self) instead of microphone=()."); } catch (e) {} }
      return ok;
    }
    // where the website shows the way into a call ("home", "composer"); never while a teammate holds the conversation.
    // A conversation the assistant does not answer (ai_live false) has no mic; from home the call starts a new one.
    function voiceShow(where) { var c = S.conv; return voiceOk() && !S.blocked && ((vcfg().ui || {}).show_on || {})[where] !== false && !(c && (c.handed_off_at || c.status === "resolved" || (where !== "home" && c.ai_live === false))) && !(V && V.active()); }
    // an untouched default follows the visitor's language
    function voiceText(k, dflt, key) { var v = (vcfg().ui || {})[k]; return t2("voice_" + k) || (v && v !== dflt ? v : T(key)); }
    function loadVoice() {
      if (V) return Promise.resolve(V);
      if (!vLoad) vLoad = new Promise(function (res, rej) {
        var done = function () {
          var f = win.__growthxaiWebchatVoice; if (!f || !f.panel) { vLoad = null; return rej(new Error("voice")); }
          V = f.panel({ S: S, ui: ui, api: api, esc: esc, el: el, sdk: sdk, store: store, safeColor: safeColor, toast: toast, bubble: bubble, wire: wireBubbles, sync: syncConvList,
            adopt: function (css) { if (S.voiceCss !== css) { S.voiceCss = css; applyStyles(); } },
            // the call is over: the same conversation, as text
            toChat: function (msg, focus) { S.view = S.conv ? "messages" : "home"; renderHeader(); renderView(); if (S.conv) { catchUp(); markRead(); } if (msg) toast(msg); if (focus) setTimeout(function () { if (ui.ta && ui.ta.isConnected) ui.ta.focus(); }, 60); },
            failed: voiceFailed });
          res(V);
        };
        if (win.__growthxaiWebchatVoice) return done();
        var sc = doc.createElement("script"); sc.src = L.voiceUrl; sc.async = true; sc.onload = done; sc.onerror = function () { vLoad = null; rej(new Error("voice")); };
        doc.head.appendChild(sc);
      });
      return vLoad;
    }
    // Every failure leaves the visitor in the chat: voice never blocks it.
    function voiceFailed(code, msg) {
      if (code === "consent") { store.del("voice_ok"); S.view = "voice-consent"; renderHeader(); renderView(); return; }
      S.view = S.conv ? "messages" : "home"; renderHeader(); renderView();
      toast(code === "mic" ? T("voice_mic") : msg || T("voice_unavailable"));
      if (code === "mic") sdk.emit("voice:error", { code: "mic" });
    }
    // growthxai.call(), data-growthxai="call", the home card, the mic, "Continue by voice"
    function startCall(o) {
      o = o || {};
      api_.open({ source: o.source || "voice", mode: o.mode });
      if (V && V.active()) return;
      if (!voiceOk() || S.blocked) { voiceFailed("unavailable"); return; }
      loadVoice().catch(function () {});   // the download starts with the click
      if (!store.get("voice_ok")) { S.view = "voice-consent"; renderHeader(); renderView(); return; }
      beginCall();
    }
    // Once per visitor (gxwc:<token>:voice_ok; the server keeps the time on the visitor too).
    function renderVoiceConsent() {
      var v = vcfg(), ms = S.eff.messages || {}, privacy = /^https:\/\//i.test(ms.privacy_url || "") ? ms.privacy_url : "https://growthxai.com/legal/privacy/";
      var text = t2("voice_consent") || v.consent_text || T("voice_consent") + " " + T(v.record === false ? "voice_norec" : "voice_rec");   // "may be recorded" is dropped when recording is off
      ui.body.innerHTML = '<div class="vcs" role="group" aria-label="' + esc(voiceText("start_text", "Talk to us", "talk")) + '"><div class="vci" aria-hidden="true">' + I.mic + "</div><p>" + esc(text) + '</p><a href="' + esc(privacy) + '" target="_blank" rel="noopener noreferrer">' + esc(T("privacy_link")) +
        '</a><button class="pbtn" type="button" data-vc="ok">' + esc(T("start_call")) + '</button><button class="sbtn" type="button" data-vc="no">' + esc(T("not_now")) + "</button></div>";
      ui.cp.innerHTML = "";
      ui.body.querySelector("[data-vc=ok]").addEventListener("click", function () { store.set("voice_ok", 1); beginCall(); });
      ui.body.querySelector("[data-vc=no]").addEventListener("click", function () { S.view = S.conv ? "messages" : "home"; renderHeader(); renderView(); });
      setTimeout(function () { var b = ui.body.querySelector("[data-vc=ok]"); b && b.focus(); }, 60);
    }
    function renderCall() {
      ui.cp.innerHTML = "";
      if (V && V.active()) { V.render(); return; }
      ui.body.innerHTML = '<div class="vcs"><div class="typing" aria-hidden="true"><i></i><i></i><i></i></div><p role="status">' + esc(T("connecting")) + "</p></div>";
    }
    function beginCall() {
      // asked inside the click, so the browser (and iOS) take the microphone prompt as the visitor's own action
      var mic; try { mic = navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e) { mic = Promise.reject(e); }
      var release = function () { mic.then(function (st) { st.getTracks().forEach(function (t) { t.stop(); }); }, function () {}); };
      S.view = "call"; renderHeader(); renderView();
      // the call belongs to a conversation: the one on screen, the visitor's open one, or a new one. One the assistant
      // does not answer (started while it was off: ai_live false) cannot take a call, so the call gets a new one.
      var conv = ensureVisitor().then(function () {
        if (S.conv && S.conv.id && S.conv.status !== "resolved" && S.conv.ai_live !== false && !composerDisabled()) return;
        var ac = activeConv(); if (ac && ac.ai_live !== false) return openConv(ac.id);
        if (needsPrechat()) { var e = new Error("prechat"); e.code = "PRECHAT"; throw e; }
        return createConversation(null, "voice");
      });
      Promise.all([mic, conv, loadVoice()]).then(function () {
        release();   // the session opens the microphone itself; the permission stays for this page
        if (S.view !== "call" || !S.conv) return;
        return V.start();
      }).catch(function (e) {
        release();
        if (e && e.code === "PRECHAT") { S.afterPrechat = "call"; pendingFirst = null; S.view = "prechat"; renderHeader(); renderView(); return; }
        var name = (e && e.name) || "";
        voiceFailed(name === "NotAllowedError" || name === "NotFoundError" || name === "SecurityError" || name === "NotReadableError" ? "mic" : "unavailable");
      });
    }
    // After a call, a chip above the message box starts the next one with the recent chat passed in. Hidden while a
    // teammate holds the conversation.
    function syncVoiceChip() {
      var old = ui.cp.querySelector(".cvb"); if (old) old.remove();
      if (S.view !== "messages" || !S.conv || !ui.cp.querySelector(".box") || composerDisabled() || !voiceShow("composer")) return;
      if (!S.msgs.some(function (m) { return m.content_type === "event" && (m.content_attributes || {}).kind === "voice_call"; })) return;
      var w = el("div", "cvb", '<button type="button">' + I.mic + "<span>" + esc(T("continue_voice")) + "</span></button>");
      w.querySelector("button").addEventListener("click", function () { startCall({ source: "voice" }); });
      ui.cp.insertBefore(w, ui.cp.firstChild);
    }

    // ---------------------------------------------------------------- campaigns (PRD §5.11) --------------------------
    function evalCampaigns() {
      S.campaignTimers.forEach(clearTimeout); S.campaignTimers = [];
      var list = S.cfg.campaigns || []; if (!list.length || S.conv) return;
      // "My own buttons" (launcher.hide): there is no launcher for a preview to sit on, and a campaign opens the chat only
      // when the website allows it ("Let campaigns open the chat")
      var own = !!(S.eff.launcher || {}).hide;
      if (own && !(S.eff.launcher || {}).campaigns_open) return;
      var av = S.cfg.availability || {}, seen = store.get("camp") || {}, url = location.href;
      list.forEach(function (c) {
        var r = c.rules || {};
        if (r.business_hours_only && !av.in_hours) return;
        var rules = r.url_rules || (r.url ? [{ op: "contains", value: r.url }] : []); if (rules.length && !rules.some(function (x) { return x.op === "regex" ? (function () { try { return new RegExp(x.value).test(url); } catch (e) { return false; } })() : x.op === "equals" ? url === x.value : x.op === "starts_with" ? url.indexOf(x.value) === 0 : url.indexOf(x.value) >= 0; })) return;
        var vis = r.visitor || "all"; if (vis === "identified" && !(S.visitor && S.visitor.identifier)) return; if (vis === "new" && S.convs.length) return; if (vis === "returning" && !S.convs.length) return;
        if (c.frequency === "once" && seen[c.id]) return; if (c.frequency === "session" && sessionStorage.getItem("gxc:" + c.id)) return;
        S.campaignTimers.push(setTimeout(function () {
          if (S.open || S.conv) return;
          seen[c.id] = Date.now(); store.set("camp", seen); try { sessionStorage.setItem("gxc:" + c.id, "1"); } catch (e) {}
          api("POST", "/campaigns/" + c.id + "/hit", { kind: "shown" }).catch(function () {});
          S.campaignMsg = c.message; S.campaignId = c.id;
          if (c.display === "open" || own) { api_.open({ source: "campaign" }); showCampaign(c); }
          else L.setUnread(L.cfg() && 0, [{ from: c.sender_name || S.eff.appearance.brand_name, text: c.message }]);
          sdk.on("opened", function once() { sdk.off("opened", once); if (S.campaignId === c.id) { api("POST", "/campaigns/" + c.id + "/hit", { kind: "clicked" }).catch(function () {}); showCampaign(c); } });
        }, Math.max(0, (parseFloat(r.time_on_page_s) || 0) * 1000)));
      });
    }
    function showCampaign(c) {
      S.view = "messages"; S.conv = null; S.msgs = [{ id: "camp-" + c.id, sender_type: c.sender_kind === "agent" ? "agent" : "bot", sender_name: c.sender_name, text: c.message, content_type: c.quick_replies && c.quick_replies.length ? "quick_replies" : "text", content_attributes: { items: c.quick_replies || [] }, sent_at: new Date().toISOString() }];
      S.pendingSource = "campaign"; renderHeader(); renderMessages(true); renderComposer();
    }

    // ---------------------------------------------------------------- own buttons: shell, prefill -----------------------
    // Open in another shell (a button's data-growthxai-mode, an Ask AI button's "Opens in"). On a phone every shell is
    // full screen, so nothing changes there.
    function useMode(m) {
      if (["bubble", "drawer", "sidebar", "modal", "inline"].indexOf(m) < 0 || S.mode === "embedded" || currentMode() === m || isMobile()) return;
      S.forcedMode = m;
      if (!S.mounted) return;
      var was = S.open;
      if (was) { S.open = false; pushBody(); }
      host.remove(); S.mounted = false; sheet = null;
      mount();
      if (was) { S.open = true; ui.panel.classList.add("open"); ui.backdrop.classList.add("open"); pushBody(); }
    }
    // A question that is typed for the visitor but not sent: the message box of a conversation that does not exist yet
    // (it is created with the first message, so an unsent question leaves nothing behind in the inbox).
    function draftView() { if (S.conv) leaveRealtime(); S.conv = null; S.msgs = []; S.byId = {}; S.hasMore = false; S.view = "messages"; renderHeader(); renderView(); }
    function fillBox(text) {
      var ta = ui.ta; if (!ta || !ta.isConnected) return;
      ta.value = String(text).slice(0, 5000); ta.dispatchEvent(new Event("input")); ta.focus();
      try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) {}
    }

    // ---------------------------------------------------------------- public API (SDK, PRD §6) -----------------------
    var api_ = {
      get mode() { return S.mode; },
      // open({ mode, source, context }): mode = open in this shell (it lasts until the page reloads); context = background
      // for the assistant on the next question the visitor sends
      open: function (o) {
        o = o || {};
        if (o.mode) useMode(o.mode);
        if (o.context) S.nextContext = String(o.context).slice(0, 700);
        mount(); if (S.open && S.mode !== "embedded") { if (o.source && !S.conv) S.pendingSource = o.source; return; }
        S.open = true; S.pendingSource = o.source || "launcher"; focusBefore = doc.activeElement;
        ui.panel.classList.add("open"); ui.backdrop.classList.add("open"); L.setOpen(true); pushBody(); lockZoom(true);
        if (!S.visitor) ensureVisitor().then(function () { if (S.view === "home") renderHome(); if (S.blocked) {} var ac = activeConv(); if (ac && (S.eff.features || {}).single_conversation) openConv(ac.id); else if (ac && ac.unread) openConv(ac.id); }).catch(function () {});
        else if (S.conv) { catchUp(); markRead(); }
        setTimeout(function () { var f = ui.ta || ui.panel.querySelector("button,input,textarea"); f && f.focus(); }, 250);
        sdk.emit("opened", {});
      },
      // call({ source, mode }): start a voice call with the assistant (the consent sheet first, once per visitor)
      call: function (o) { startCall(o || {}); },
      close: function () { if (!S.mounted || !S.open || S.mode === "embedded") return;
        if (V && V.active()) { V.askEnd(function () { api_.close(); }); return; }   // closing the panel would hide a live call: ask first
        S.open = false; S.nextContext = null; ui.panel.classList.remove("open"); ui.backdrop.classList.remove("open"); L.setOpen(false); pushBody(); lockZoom(false); var m = root.querySelector(".menu"); m && m.remove(); try { focusBefore && focusBefore.focus(); } catch (e) {} sdk.emit("closed", {}); },
      toggle: function (st) { if (st === "open" || (st == null && !S.open)) api_.open(); else api_.close(); },
      setMode: function (m) { if (["bubble", "drawer", "sidebar", "modal", "inline", "embedded"].indexOf(m) < 0) return; var wasOpen = S.open; S.forcedMode = m; if (S.mounted) { api_.close(); pushBody(); host.remove(); S.mounted = false; sheet = null; } mount(); if (wasOpen) api_.open(); },
      send: function (text, o) { return api_.ask(text, { prefill: !!(o && o.prefill), source: "sdk" }); },
      // ask(text, { context, mode, prefill, label }): open the chat and send the question as the visitor (the same as a
      // data-growthxai-ask button). prefill: true puts it in the message box instead; the visitor sends it.
      ask: function (text, o) {
        o = o || {}; text = String(text == null ? "" : text).slice(0, 5000);
        if (!text.trim()) return api_.open(o);
        if (o.label) api_.setLabel(String(o.label).slice(0, 60));
        api_.open({ mode: o.mode, source: o.source || "sdk" });
        S.nextContext = o.context ? String(o.context).slice(0, 700) : null;
        return ensureVisitor().then(function () {
          // into the conversation the visitor already has open; else a new one, created when the first message is sent
          var ac = activeConv(), here = S.view === "messages" && S.conv && !composerDisabled();
          var ready = here ? Promise.resolve() : ac ? openConv(ac.id) : null;
          if (o.prefill) return (ready || Promise.resolve(draftView())).then(function () { fillBox(text); });
          return ready ? ready.then(function () { sendText(text.trim()); }) : startNew(text.trim(), S.pendingSource);
        }).catch(showErr);
      },
      setUser: function (identifier, user) {
        user = user || {}; L.identified(true);
        return ensureVisitor().then(function () {
          if (S.visitor && S.visitor.identifier && String(S.visitor.identifier) !== String(identifier) && user.identifier_hash) { return api("POST", "/visitor/reset").then(function () { S.vt = null; store.del("vt"); S.visitor = null; S.convs = []; S.conv = null; S.msgs = []; broadcastTabs({ t: "reset" }); return ensureVisitor(); }); }
        }).then(function () {
          return api("POST", "/visitor/identify", { identifier: identifier, identifier_hash: user.identifier_hash || user.identifierHash, name: user.name, email: user.email, phone: user.phone || user.phone_number, avatar_url: user.avatar_url || user.avatarUrl, company: user.company || user.company_name, custom_attributes: user.custom_attributes || user.customAttributes || {} });
        }).then(function (r) { if (r.visitor_token) { S.vt = r.visitor_token; store.set("vt", S.vt); } S.visitor = r.visitor; S.convs = r.conversations || S.convs; noteLive(); if (S.mounted && S.view === "home") renderHome(); if (S.mounted) syncPrivacy(); setUnreadTotal(); sdk.emit("identified", { verified: r.verified }); return r; })
          .catch(function (e) { sdk.emit("error", { code: e.code || "E_IDENTITY_INVALID", message: e.message }); throw e; });
      },
      setCustomAttributes: function (o) { return ensureVisitor().then(function () { return api("PATCH", "/visitor/attributes", { custom_attributes: o || {} }); }); },
      deleteCustomAttribute: function (k) { return ensureVisitor().then(function () { return api("PATCH", "/visitor/attributes", { delete: [k] }); }); },
      setConversationCustomAttributes: function (o) { if (!S.conv) { S.pendingConvAttrs = Object.assign({}, S.pendingConvAttrs, o); return Promise.resolve(); } return api("PATCH", "/visitor/attributes", { conversation_id: S.conv.id, conversation_custom_attributes: o }); },
      deleteConversationCustomAttribute: function (k) { if (!S.conv) return Promise.resolve(); return api("PATCH", "/visitor/attributes", { conversation_id: S.conv.id, conversation_delete: [k] }); },
      setLabel: function (l) { if (!S.conv) { (S.pendingLabels = S.pendingLabels || []).push(l); return Promise.resolve(); } return api("PATCH", "/visitor/attributes", { conversation_id: S.conv.id, add_labels: [l] }); },
      removeLabel: function (l) { if (!S.conv) return Promise.resolve(); return api("PATCH", "/visitor/attributes", { conversation_id: S.conv.id, remove_labels: [l] }); },
      setLocale: function (l) { S.locale = STR[l] ? l : (STR[String(l).slice(0, 2)] ? String(l).slice(0, 2) : "en"); if (S.mounted) { applyStyles(); renderHeader(); renderView(); } },
      setColorScheme: function (s) { settings.darkMode = s; if (S.mounted) applyStyles(); },
      trackEvent: function (name, props) { return ensureVisitor().then(function () { return api("POST", "/events", { name: name, props: props || {}, conversation_id: S.conv ? S.conv.id : null }); }); },
      reset: function () { var p = S.vt ? api("POST", "/visitor/reset").catch(function () {}) : Promise.resolve(); return p.then(function () { S.vt = null; store.del("vt"); store.del("q"); store.del("chatted"); store.del("sent"); store.del("pc"); store.del("live"); S.visitor = null; S.convs = []; leaveRealtime(); S.conv = null; S.msgs = []; S.byId = {}; L.identified(false); L.setUnread(0, []); broadcastTabs({ t: "reset" }); if (S.mounted) { S.view = "home"; renderHeader(); renderView(); } }); },
      destroy: function () { if (V && V.active()) V.leave("end"); api_.close(); lockZoom(false); leaveRealtime(); if (S.rt) S.rt.close(); S.campaignTimers.forEach(clearTimeout); if (host) host.remove(); S.mounted = false; var lh = doc.getElementById("growthxai-webchat"); lh && lh.remove(); },
      popoutChatWindow: function () { var origin = (function () { try { return new URL(doc.currentScript ? doc.currentScript.src : (doc.querySelector("script[data-website-token]") || {}).src || location.href).origin; } catch (e) { return location.origin; } })(); win.open(origin + "/chat/" + TOKEN, "growthxai_chat_" + TOKEN, "width=420,height=640,noopener"); },
      consent: function (ok) { if (ok) ensureVisitor(); },
      onRouteChange: function (url) { if (S.vt) api("POST", "/page-view", { views: [{ url: url, title: doc.title, referrer: doc.referrer, at: new Date().toISOString() }] }, { keepalive: true }).catch(function () {}); evalCampaigns(); },
      configUpdated: function (c, e) { S.cfg = c; S.eff = e; if (S.mounted) { applyStyles(); renderHeader(); renderView(); } evalCampaigns(); }
    };

    // ---------------------------------------------------------------- init ------------------------------------------
    (function init() {
      var l = settings.locale || (sdk.overrides || {}).locale;
      if (!l && S.eff.locale && S.eff.locale.use_browser !== false) l = (navigator.language || "en").slice(0, 2);
      if (!l && S.eff.locale) l = S.eff.locale.default;
      S.locale = STR[l] ? l : "en";
      var mode = currentMode();
      if (mode === "embedded") { mount(); ensureVisitor().then(function () { if (settings.resume) { api("GET", "/resume?t=" + encodeURIComponent(settings.resume)).then(function (r) { S.vt = r.visitor_token; store.set("vt", S.vt); S.visitor = null; return ensureVisitor().then(function () { if (S.convs.some(function (c) { return c.id === r.conversation_id; })) openConv(r.conversation_id); else renderHome(); }); }).catch(function () { renderHome(); }); } else { var ac = activeConv(); if (ac) openConv(ac.id); else renderHome(); } setUnreadTotal(); evalCampaigns(); }).catch(function () {}); }
      else if (S.vt) { ensureVisitor().then(function () { setUnreadTotal(); var ac = activeConv(); if (ac && ac.status !== "resolved") { S.conv = ac; joinRealtime(); } evalCampaigns(); }).catch(function () {}); }
      else { evalCampaigns(); }
      // ⌘K / Ctrl+K: the loader binds it (in every shell, when the website has it on); only a loader from before that needs this
      if (mode === "modal" && !L.keys) doc.addEventListener("keydown", function (e) { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); api_.toggle(); } });
      win.addEventListener("pagehide", function () { if (V && V.active()) V.leave("end"); if (S.conv && S.vt) { try { navigator.sendBeacon && navigator.sendBeacon(API + "/conversations/" + S.conv.id + "/typing?token=" + TOKEN, new Blob([JSON.stringify({ on: false })], { type: "text/plain" })); } catch (e) {} } });
    })();
    return api_;
  };
})();
