"use strict";

const messages = {
  ar: {
    pageTitle: "مكالمة مترجمة للعربية — Calltranslate",
    home: "العودة إلى الصفحة الرئيسية",
    controls: "أدوات التحكم بالمكالمة",
    badge: "الطرف العربي",
    avatar: "EN",
    direction: "ENGLISH → العربية",
    title: "ستسمع الطرف الآخر بالعربية",
    loading: "جارٍ التحقق من رابط الدعوة…",
    ready: "جاهز للانضمام",
    mic: "يرجى السماح باستخدام الميكروفون",
    waiting: "بانتظار دخول الطرف الإنجليزي…",
    joining: "دخل الطرف الآخر، جارٍ إنشاء الاتصال…",
    translating: "تم الاتصال، جارٍ تشغيل الترجمة…",
    live: "المكالمة المترجمة متصلة",
    retrying: "الاتصال غير مستقر؛ جارٍ محاولة استعادته…",
    ended: "انتهت المكالمة",
    join: "ابدأ المكالمة",
    rejoin: "اتصل مجدداً",
    mute: "كتم",
    unmute: "إلغاء الكتم",
    leave: "إنهاء",
    captions: "النص المباشر",
    liveLabel: "مباشر",
    offlineLabel: "غير متصل",
    sourceLabel: "الطرف الآخر — English",
    translatedLabel: "الترجمة العربية",
    sourcePlaceholder: "سيظهر كلام الطرف الآخر هنا…",
    translatedPlaceholder: "ستظهر الترجمة العربية هنا…",
    headset: "استخدم سماعات رأس للحصول على صوت أوضح ومنع رجوع الترجمة إلى الميكروفون.",
    badLink: "رابط الدعوة غير صحيح أو لا يحتوي على رمز الدخول.",
    expired: "انتهت صلاحية رابط الدعوة أو الجلسة. اطلب رابطاً جديداً.",
    keyMissing: "الترجمة غير مفعّلة على السيرفر بعد.",
    unsupported: "هذا المتصفح لا يدعم مكالمات WebRTC.",
    insecure: "افتح رابط HTTPS الآمن حتى يتمكن المتصفح من تشغيل الميكروفون.",
    micDenied: "لم يُسمح باستخدام الميكروفون. فعّل الإذن ثم حاول مجدداً.",
    micMissing: "لم يعثر الجهاز على ميكروفون متاح.",
    micBusy: "الميكروفون مشغول أو تعذّر تشغيله. أغلق التطبيق الذي يستخدمه ثم حاول مجدداً.",
    busy: "رابط الطرف العربي مستخدم حالياً على جهاز آخر.",
    connectionFailed: "انقطع الاتصال. اضغط «اتصل مجدداً» للمحاولة.",
    translationFailed: "انقطعت الترجمة. اضغط «اتصل مجدداً» لبدء جلسة جديدة.",
    soundBlocked: "المكالمة متصلة، لكن المتصفح منع تشغيل الصوت. المس الشاشة مرة واحدة.",
    playAudio: "تشغيل الصوت",
    generic: "حدث خطأ في الاتصال. حاول مجدداً.",
    openaiEngine: "OpenAI",
    geminiEngine: "Google Gemini",
    model25Sub: "سريع وطبيعي",
    model35Sub: "مخصص للترجمة الحية",
  },
  en: {
    pageTitle: "English translated call — Calltranslate",
    home: "Back to the home page",
    controls: "Call controls",
    badge: "English side",
    avatar: "ع",
    direction: "العربية → ENGLISH",
    title: "You will hear the other person in English",
    loading: "Checking the invitation link…",
    ready: "Ready to join",
    mic: "Please allow microphone access",
    waiting: "Waiting for the Arabic speaker to join…",
    joining: "The other person joined. Connecting…",
    translating: "Connected. Starting live translation…",
    live: "Translated call connected",
    retrying: "The connection is unstable; trying to restore it…",
    ended: "Call ended",
    join: "Start call",
    rejoin: "Call again",
    mute: "Mute",
    unmute: "Unmute",
    leave: "End",
    captions: "Live captions",
    liveLabel: "Live",
    offlineLabel: "Offline",
    sourceLabel: "Other person — العربية",
    translatedLabel: "English translation",
    sourcePlaceholder: "The other person's speech will appear here…",
    translatedPlaceholder: "The English translation will appear here…",
    headset: "Use headphones for clearer audio and to keep translated speech out of your microphone.",
    badLink: "This invitation link is invalid or has no access token.",
    expired: "This invitation or session has expired. Ask for a new link.",
    keyMissing: "Translation is not configured on the server yet.",
    unsupported: "This browser does not support WebRTC calls.",
    insecure: "Open the secure HTTPS link so the browser can use the microphone.",
    micDenied: "Microphone access was not allowed. Enable it, then try again.",
    micMissing: "No available microphone was found on this device.",
    micBusy: "The microphone is busy or could not start. Close the app using it, then try again.",
    busy: "The English link is already open on another device.",
    connectionFailed: "The connection was lost. Tap “Call again” to retry.",
    translationFailed: "Translation stopped. Tap “Call again” to start a new session.",
    soundBlocked: "The browser blocked audio. Tap the screen once.",
    playAudio: "Play audio",
    generic: "A connection error occurred. Please try again.",
    openaiEngine: "OpenAI",
    geminiEngine: "Google Gemini",
    model25Sub: "Fast & natural",
    model35Sub: "Live translation specialist",
  },
};

const parts = location.pathname.split("/").filter(Boolean);
const fixedRoute = parts.length === 3 && parts[0] === "join" && ["ar", "en"].includes(parts[1]);
const fixedLinkToken = fixedRoute ? parts[2] : "";
let roomId = parts.length === 3 && parts[0] === "room" ? parts[1] : "";
const role = fixedRoute ? parts[1] : (parts.length === 3 ? parts[2] : "");
const pathIsValid = (
  (fixedRoute && /^[A-Za-z0-9_-]{32,128}$/.test(fixedLinkToken)) ||
  (/^[A-Za-z0-9_-]{12,80}$/.test(roomId) && ["ar", "en"].includes(role))
);
const storageKey = pathIsValid
  ? (fixedRoute ? `calltranslate.access.fixed.${role}` : `calltranslate.access.${roomId}.${role}`)
  : "";

function consumeInviteToken() {
  const fragment = location.hash.startsWith("#") ? location.hash.slice(1) : "";
  let value = "";
  try {
    const params = new URLSearchParams(fragment);
    value = params.get("token") || (!fragment.includes("=") ? decodeURIComponent(fragment) : "");
  } catch (_error) {
    value = "";
  }
  if (location.hash || location.search) history.replaceState(null, "", location.pathname);
  return value.trim();
}

let inviteToken = consumeInviteToken();
let accessToken = "";
let config = null;
let localStream = null;
let socket = null;
let peer = null;
let translationPeer = null;
let translationTrack = null;
let remoteTrackId = "";
let queuedCandidates = [];
let makingOffer = false;
let closing = false;
let translationGeneration = 0;
let translationRetryCount = 0;
let reconnectTimer = null;
let translationTimer = null;
let timerInterval = null;
let startedAt = 0;
let wakeLock = null;
let activityContext = null;
let activitySource = null;
let activityAnalyser = null;
let activityFrame = null;
let sourceText = "";
let translatedText = "";
let sourceElapsed = null;
let translatedElapsed = null;
let visibleError = "";

let currentEngine = "openai";
try { currentEngine = localStorage.getItem("calltranslate_engine") || "openai"; } catch (_e) {}
let geminiModel = "gemini-2.5-flash-native-audio-latest";
try { geminiModel = localStorage.getItem("calltranslate_gemini_model") || "gemini-2.5-flash-native-audio-latest"; } catch (_e) {}
let geminiSocket = null;
let geminiAudioContext = null;
let geminiSourceNode = null;
let geminiProcessorNode = null;
let geminiPlaybackContext = null;
let geminiNextPlayTime = 0;

const el = {
  home: document.getElementById("homeLink"),
  badge: document.getElementById("roleBadge"),
  avatar: document.getElementById("participantAvatar"),
  direction: document.getElementById("directionLabel"),
  title: document.getElementById("callTitle"),
  status: document.getElementById("statusLine"),
  timer: document.getElementById("callTimer"),
  orbit: document.getElementById("connectionOrbit"),
  engineSelection: document.getElementById("engineSelection"),
  engineOpenAI: document.getElementById("engineOpenAI"),
  engineOpenAILabel: document.getElementById("engineOpenAILabel"),
  engineGemini: document.getElementById("engineGemini"),
  engineGeminiLabel: document.getElementById("engineGeminiLabel"),
  geminiModelSelector: document.getElementById("geminiModelSelector"),
  modelPill25: document.getElementById("modelPill25"),
  model25Desc: document.getElementById("model25Desc"),
  modelPill35: document.getElementById("modelPill35"),
  model35Desc: document.getElementById("model35Desc"),
  join: document.getElementById("joinButton"),
  joinLabel: document.getElementById("joinButtonLabel"),
  controls: document.getElementById("callControls"),
  mute: document.getElementById("muteButton"),
  muteLabel: document.getElementById("muteButtonLabel"),
  leave: document.getElementById("leaveButton"),
  leaveLabel: document.getElementById("leaveButtonLabel"),
  captions: document.getElementById("captionsTitle"),
  liveLabel: document.getElementById("liveLabel"),
  sourceLabel: document.getElementById("sourceCaptionLabel"),
  translatedLabel: document.getElementById("translatedCaptionLabel"),
  source: document.getElementById("sourceTranscript"),
  translated: document.getElementById("translatedTranscript"),
  headset: document.getElementById("headsetNote"),
  error: document.getElementById("errorBanner"),
  errorText: document.getElementById("errorText"),
  audioUnlock: document.getElementById("audioUnlockButton"),
  audioUnlockLabel: document.getElementById("audioUnlockLabel"),
  audio: document.getElementById("translatedAudio"),
  geminiAudioPuller: document.getElementById("geminiAudioPuller"),
  liveIndicator: document.querySelector(".live-indicator"),
};

const t = (key) => messages[role === "en" ? "en" : "ar"][key];

const statusStates = {
  loading: "loading",
  ready: "ready",
  mic: "permission",
  waiting: "waiting",
  joining: "connecting",
  translating: "connecting",
  live: "live",
  retrying: "reconnecting",
  ended: "ended",
};

function localize() {
  const language = role === "en" ? "en" : "ar";
  const sourceLanguage = language === "ar" ? "en" : "ar";
  document.documentElement.lang = language;
  document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
  document.title = t("pageTitle");
  el.home.setAttribute("aria-label", t("home"));
  el.controls.setAttribute("aria-label", t("controls"));
  el.badge.textContent = t("badge");
  el.avatar.textContent = t("avatar");
  el.direction.textContent = t("direction");
  el.title.textContent = t("title");
  el.joinLabel.textContent = t("join");
  el.muteLabel.textContent = t("mute");
  el.leaveLabel.textContent = t("leave");
  el.captions.textContent = t("captions");
  el.sourceLabel.textContent = t("sourceLabel");
  el.translatedLabel.textContent = t("translatedLabel");
  el.headset.textContent = t("headset");
  el.audioUnlockLabel.textContent = t("playAudio");
  if (el.engineOpenAILabel) el.engineOpenAILabel.textContent = t("openaiEngine");
  if (el.engineGeminiLabel) el.engineGeminiLabel.textContent = t("geminiEngine");
  if (el.model25Desc) el.model25Desc.textContent = t("model25Sub");
  if (el.model35Desc) el.model35Desc.textContent = t("model35Sub");
  el.source.lang = sourceLanguage;
  el.source.dir = sourceLanguage === "ar" ? "rtl" : "ltr";
  el.translated.lang = language;
  el.translated.dir = language === "ar" ? "rtl" : "ltr";
  setLive(false);
  resetTranscripts();
}

function setEngine(engine) {
  currentEngine = engine;
  try { localStorage.setItem("calltranslate_engine", engine); } catch (_e) {}
  if (el.engineOpenAI) {
    el.engineOpenAI.classList.toggle("active", engine === "openai");
    el.engineOpenAI.setAttribute("aria-selected", String(engine === "openai"));
  }
  if (el.engineGemini) {
    el.engineGemini.classList.toggle("active", engine === "gemini");
    el.engineGemini.setAttribute("aria-selected", String(engine === "gemini"));
  }
  if (el.geminiModelSelector) {
    el.geminiModelSelector.classList.toggle("hidden", engine !== "gemini");
  }
}

function setGeminiModel(model) {
  geminiModel = model;
  try { localStorage.setItem("calltranslate_gemini_model", model); } catch (_e) {}
  if (el.modelPill25) {
    el.modelPill25.classList.toggle("active", model === "gemini-2.5-flash-native-audio-latest");
  }
  if (el.modelPill35) {
    el.modelPill35.classList.toggle("active", model === "gemini-3.5-live-translate-preview");
  }
}

function setStatus(key, orbit = "") {
  el.status.textContent = t(key);
  el.orbit.classList.remove("connecting", "live");
  if (orbit) el.orbit.classList.add(orbit);
  document.body.dataset.callState = statusStates[key] || "ready";
}

function setLive(active) {
  el.liveIndicator.classList.toggle("active", active);
  el.liveLabel.textContent = t(active ? "liveLabel" : "offlineLabel");
}

function showError(key, category = "general") {
  visibleError = category;
  el.errorText.textContent = t(key);
  el.audioUnlock.classList.toggle("hidden", category !== "sound");
  el.error.classList.remove("hidden");
  if (category !== "sound") document.body.dataset.callState = "error";
}

function clearError(category = "") {
  if (category && visibleError !== category) return;
  visibleError = "";
  el.errorText.textContent = "";
  el.audioUnlock.classList.add("hidden");
  el.error.classList.add("hidden");
}

async function unlockAudio() {
  if (geminiPlaybackContext && geminiPlaybackContext.state === "suspended") {
    try {
      await geminiPlaybackContext.resume();
      clearError("sound");
      return;
    } catch (_error) {
      showError("soundBlocked", "sound");
      return;
    }
  }
  if (!el.audio.srcObject) return;
  try {
    await el.audio.play();
    clearError("sound");
  } catch (_error) {
    showError("soundBlocked", "sound");
  }
}

function resetTranscripts() {
  sourceText = translatedText = "";
  sourceElapsed = translatedElapsed = null;
  el.source.textContent = t("sourcePlaceholder");
  el.translated.textContent = t("translatedPlaceholder");
}

function appendTranscript(kind, delta, elapsed) {
  if (typeof delta !== "string" || !delta) return;
  const source = kind === "source";
  let value = source ? sourceText : translatedText;
  const previous = source ? sourceElapsed : translatedElapsed;
  if (value && Number.isFinite(elapsed) && Number.isFinite(previous) && elapsed - previous > 1600) value += "\n";
  value += delta;
  if (value.length > 1200) value = "…" + value.slice(-1199);
  if (source) {
    sourceText = value;
    sourceElapsed = Number.isFinite(elapsed) ? elapsed : sourceElapsed;
    el.source.textContent = value;
  } else {
    translatedText = value;
    translatedElapsed = Number.isFinite(elapsed) ? elapsed : translatedElapsed;
    el.translated.textContent = value;
  }
}

function setJoined(joined, focus = false) {
  el.join.classList.toggle("hidden", joined);
  el.controls.classList.toggle("hidden", !joined);
  el.home.setAttribute("aria-disabled", String(joined));
  if (joined) el.home.setAttribute("tabindex", "-1");
  else el.home.removeAttribute("tabindex");
  if (focus) requestAnimationFrame(() => (joined ? el.mute : el.join).focus({ preventScroll: true }));
}

function updateTimer() {
  const seconds = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;
  el.timer.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  el.timer.dateTime = `PT${seconds}S`;
}

function startTimer() {
  if (startedAt) return;
  startedAt = Date.now();
  el.timer.classList.add("active");
  updateTimer();
  timerInterval = setInterval(updateTimer, 1000);
}

function stopTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
  startedAt = 0;
  el.timer.classList.remove("active");
  updateTimer();
}

function stopRemoteActivity() {
  if (activityFrame) cancelAnimationFrame(activityFrame);
  activityFrame = null;
  document.body.classList.remove("remote-speaking");
  try { activitySource?.disconnect(); } catch (_error) {}
  activitySource = null;
  activityAnalyser = null;
  if (activityContext) void activityContext.close().catch(() => {});
  activityContext = null;
}

function startRemoteActivity(track) {
  stopRemoteActivity();
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  try {
    const context = new AudioContextClass();
    const analyser = context.createAnalyser();
    const source = context.createMediaStreamSource(new MediaStream([track]));
    const samples = new Uint8Array(128);
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.78;
    source.connect(analyser);
    activityContext = context;
    activitySource = source;
    activityAnalyser = analyser;
    void context.resume().catch(() => {});

    const measure = () => {
      if (activityAnalyser !== analyser || track.readyState !== "live") return;
      analyser.getByteTimeDomainData(samples);
      let energy = 0;
      for (const sample of samples) {
        const level = (sample - 128) / 128;
        energy += level * level;
      }
      document.body.classList.toggle("remote-speaking", Math.sqrt(energy / samples.length) > 0.028);
      activityFrame = requestAnimationFrame(measure);
    };
    measure();
  } catch (_error) {
    stopRemoteActivity();
  }
}

function authHeaders(headers = {}) {
  return { ...headers, Authorization: `Bearer ${accessToken}` };
}

function clearStoredAccess() {
  accessToken = "";
  config = null;
  try { if (storageKey) sessionStorage.removeItem(storageKey); } catch (_error) {}
}

async function exchangeInvite(value) {
  const response = await fetch("/api/room-access", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ room_id: roomId, role, token: value }),
  });
  if (!response.ok) throw new Error([401, 403, 404, 409, 410].includes(response.status) ? "expired" : "generic");
  const body = await response.json();
  if (typeof body.access_token !== "string" || body.access_token.length < 20) throw new Error("badLink");
  return body.access_token;
}

async function issueFixedAccess() {
  const response = await fetch(`/api/fixed-access/${role}`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ token: fixedLinkToken }),
  });
  if (!response.ok) throw new Error([401, 403, 404].includes(response.status) ? "badLink" : "generic");
  const body = await response.json();
  if (
    typeof body.access_token !== "string" ||
    body.access_token.length < 20 ||
    typeof body.room_id !== "string" ||
    !/^[A-Za-z0-9_-]{12,80}$/.test(body.room_id) ||
    body.role !== role
  ) throw new Error("generic");
  roomId = body.room_id;
  return body.access_token;
}

async function loadConfig() {
  const response = await fetch("/api/client-config", {
    cache: "no-store",
    headers: authHeaders({ Accept: "application/json" }),
  });
  if (!response.ok) {
    if ([401, 403].includes(response.status)) throw new Error("expired");
    if (response.status === 503) throw new Error("keyMissing");
    throw new Error("generic");
  }
  const body = await response.json();
  if (
    typeof body.room_id !== "string" ||
    !/^[A-Za-z0-9_-]{12,80}$/.test(body.room_id) ||
    body.role !== role ||
    (!fixedRoute && body.room_id !== roomId)
  ) throw new Error("badLink");
  roomId = body.room_id;
  if (!body.translation_configured) throw new Error("keyMissing");
  if (!body.openai_configured && body.gemini_configured) {
    setEngine("gemini");
  }
  if (!Array.isArray(body.ice_servers)) body.ice_servers = [];
  return body;
}

function signalingUrl() {
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws/${encodeURIComponent(roomId)}/${role}`;
}

function sendSignal(message) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function closeSocket() {
  const current = socket;
  socket = null;
  if (!current) return;
  current.onopen = current.onmessage = current.onerror = current.onclose = null;
  try { current.close(1000, "Call ended"); } catch (_error) {}
}

async function ensurePeer() {
  if (peer && peer.signalingState !== "closed") return peer;
  if (!localStream) throw new Error("micDenied");
  const connection = new RTCPeerConnection({ iceServers: config.ice_servers });
  peer = connection;
  queuedCandidates = [];
  remoteTrackId = "";
  localStream.getAudioTracks().forEach((track) => connection.addTrack(track, localStream));
  connection.onicecandidate = (event) => {
    if (peer === connection && event.candidate) sendSignal({ type: "ice-candidate", candidate: event.candidate.toJSON() });
  };
  connection.ontrack = (event) => {
    if (peer !== connection || event.track.kind !== "audio" || event.track.id === remoteTrackId) return;
    remoteTrackId = event.track.id;
    startRemoteActivity(event.track);
    void beginTranslation(event.track);
  };
  connection.onconnectionstatechange = () => {
    if (peer !== connection) return;
    if (connection.connectionState === "connected") {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      clearError("connection");
      const isTranslating = currentEngine === "gemini" ? Boolean(geminiSocket && geminiSocket.readyState === WebSocket.OPEN) : (translationPeer?.connectionState === "connected");
      setStatus(isTranslating ? "live" : "translating", isTranslating ? "live" : "connecting");
    } else if (["disconnected", "failed"].includes(connection.connectionState)) {
      setStatus("retrying", "connecting");
      if (role === "ar" && !reconnectTimer) void makeOffer(true).catch(() => failCall("connectionFailed"));
      if (!reconnectTimer) reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (peer === connection && connection.connectionState !== "connected") failCall("connectionFailed");
      }, 9000);
    }
  };
  return connection;
}

async function makeOffer(iceRestart = false) {
  if (role !== "ar" || makingOffer) return;
  makingOffer = true;
  try {
    const connection = await ensurePeer();
    if (connection.signalingState !== "stable" || (!iceRestart && connection.localDescription)) return;
    const offer = await connection.createOffer(iceRestart ? { iceRestart: true } : undefined);
    if (peer !== connection) return;
    await connection.setLocalDescription(offer);
    if (peer === connection) sendSignal({ type: "offer", sdp: connection.localDescription.sdp });
  } finally { makingOffer = false; }
}

async function handleSignal(message) {
  if (message.type === "welcome") {
    setStatus(message.peer_connected ? "joining" : "waiting", "connecting");
    if (message.peer_connected) await makeOffer();
  } else if (message.type === "peer-joined") {
    clearError();
    setStatus("joining", "connecting");
    await makeOffer();
  } else if (message.type === "offer") {
    const connection = await ensurePeer();
    await connection.setRemoteDescription({ type: "offer", sdp: message.sdp });
    for (const candidate of queuedCandidates.splice(0)) await connection.addIceCandidate(candidate);
    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);
    if (peer === connection) sendSignal({ type: "answer", sdp: connection.localDescription.sdp });
  } else if (message.type === "answer" && peer) {
    await peer.setRemoteDescription({ type: "answer", sdp: message.sdp });
    for (const candidate of queuedCandidates.splice(0)) await peer.addIceCandidate(candidate);
  } else if (message.type === "ice-candidate") {
    const connection = await ensurePeer();
    if (connection.remoteDescription) await connection.addIceCandidate(message.candidate);
    else queuedCandidates.push(message.candidate);
  } else if (["hangup", "peer-left"].includes(message.type)) {
    teardownPeer();
    clearError();
    setStatus("waiting", "connecting");
  } else if (message.type === "peer-unavailable") setStatus("waiting", "connecting");
}

function connectSocket() {
  const current = new WebSocket(signalingUrl(), ["calltranslate", accessToken]);
  let queue = Promise.resolve();
  socket = current;
  current.onopen = () => { if (socket === current) setStatus("waiting", "connecting"); };
  current.onmessage = (event) => {
    if (socket !== current) return;
    let message;
    try { message = JSON.parse(event.data); } catch (_error) { failCall("generic"); return; }
    queue = queue.then(() => socket === current ? handleSignal(message) : undefined).catch(() => {
      if (socket === current) failCall("connectionFailed");
    });
  };
  current.onerror = () => { if (socket === current) setStatus("joining", "connecting"); };
  current.onclose = (event) => {
    if (socket !== current) return;
    socket = null;
    if (event.code === 4409) failCall("busy");
    else if ([4401, 4403, 4408].includes(event.code)) failCall("expired", true);
    else if (event.code !== 1000) failCall("connectionFailed");
  };
}

function handleTranslationEvent(data) {
  let event;
  try { event = JSON.parse(data); } catch (_error) { return; }
  if (event.type === "session.input_transcript.delta") appendTranscript("source", event.delta, event.elapsed_ms);
  else if (event.type === "session.output_transcript.delta") appendTranscript("translated", event.delta, event.elapsed_ms);
  else if (event.type === "error") failCall("translationFailed");
}

async function startTranslation(remoteTrack, isRetry = false) {
  if (!isRetry) translationRetryCount = 0;
  const generation = ++translationGeneration;
  closeTranslation(true);
  clearError();
  resetTranscripts();
  setStatus("translating", "connecting");
  const connection = new RTCPeerConnection();
  translationPeer = connection;
  translationTrack = remoteTrack.clone();
  connection.addTrack(translationTrack, new MediaStream([translationTrack]));
  connection.ontrack = (event) => {
    if (translationPeer !== connection || event.track.kind !== "audio") return;
    el.audio.srcObject = event.streams[0] || new MediaStream([event.track]);
    void el.audio.play().catch(() => showError("soundBlocked", "sound"));
  };
  connection.createDataChannel("oai-events").onmessage = (event) => handleTranslationEvent(event.data);
  let connectedOnce = false;
  const scheduleRecovery = () => {
    if (translationTimer || translationPeer !== connection) return;
    if (
      !connectedOnce ||
      translationRetryCount >= 1 ||
      remoteTrack.readyState === "ended" ||
      !peer ||
      peer.connectionState !== "connected"
    ) {
      failCall("translationFailed");
      return;
    }
    setLive(false);
    setStatus("retrying", "connecting");
    translationTimer = setTimeout(() => {
      translationTimer = null;
      if (remoteTrack.readyState === "live" && peer?.connectionState === "connected") {
        translationRetryCount += 1;
        void beginTranslation(remoteTrack, true);
      } else {
        failCall("translationFailed");
      }
    }, 5500);
  };
  connection.onconnectionstatechange = () => {
    if (translationPeer !== connection) return;
    if (connection.connectionState === "connected") {
      connectedOnce = true;
      if (translationTimer) clearTimeout(translationTimer);
      translationTimer = null;
      setLive(true);
      setStatus("live", "live");
      startTimer();
    } else if (connection.connectionState === "disconnected") {
      scheduleRecovery();
    } else if (connection.connectionState === "failed") {
      scheduleRecovery();
    }
  };
  try {
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    let response;
    try {
      response = await fetch("/api/realtime/call", {
        method: "POST",
        headers: authHeaders({ Accept: "application/sdp", "Content-Type": "application/sdp" }),
        cache: "no-store",
        body: offer.sdp,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw new Error([401, 403].includes(response.status) ? "expired" : "translationFailed");
    const answer = await response.text();
    if (!answer) throw new Error("translationFailed");
    if (generation !== translationGeneration || translationPeer !== connection) return connection.close();
    await connection.setRemoteDescription({ type: "answer", sdp: answer });
  } catch (error) {
    if (generation === translationGeneration) failCall(error instanceof Error ? error.message : "translationFailed", error instanceof Error && error.message === "expired");
  }
}

function beginTranslation(remoteTrack, isRetry = false) {
  if (currentEngine === "gemini") {
    void startGeminiTranslation(remoteTrack, isRetry);
  } else {
    void startTranslation(remoteTrack, isRetry);
  }
}

function downsampleTo16k(inputBuffer, inputSampleRate) {
  if (inputSampleRate === 16000) {
    const pcm = new Int16Array(inputBuffer.length);
    for (let i = 0; i < inputBuffer.length; i++) {
      const s = Math.max(-1, Math.min(1, inputBuffer[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return pcm.buffer;
  }
  const ratio = inputSampleRate / 16000;
  const newLength = Math.round(inputBuffer.length / ratio);
  const pcm = new Int16Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const srcIndex = i * ratio;
    const i0 = Math.floor(srcIndex);
    const i1 = Math.min(i0 + 1, inputBuffer.length - 1);
    const fraction = srcIndex - i0;
    const s = inputBuffer[i0] + (inputBuffer[i1] - inputBuffer[i0]) * fraction;
    const clamped = Math.max(-1, Math.min(1, s));
    pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
  }
  return pcm.buffer;
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToFloat32(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const int16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7FFF);
  }
  return float32;
}

function playGeminiPcmChunk(float32Data, sampleRate = 24000) {
  if (!geminiPlaybackContext || geminiPlaybackContext.state === "closed") {
    geminiPlaybackContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (geminiPlaybackContext.state === "suspended") {
    void geminiPlaybackContext.resume().catch(() => showError("soundBlocked", "sound"));
  }
  const audioBuffer = geminiPlaybackContext.createBuffer(1, float32Data.length, sampleRate);
  audioBuffer.copyToChannel(float32Data, 0);

  const source = geminiPlaybackContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(geminiPlaybackContext.destination);

  const now = geminiPlaybackContext.currentTime;
  if (geminiNextPlayTime < now) {
    geminiNextPlayTime = now + 0.05;
  }
  source.start(geminiNextPlayTime);
  geminiNextPlayTime += audioBuffer.duration;
}

function setupGeminiAudioCapture(remoteTrack, ws, isDirect = false) {
  try {
    if (el.geminiAudioPuller) {
      el.geminiAudioPuller.srcObject = new MediaStream([remoteTrack]);
      el.geminiAudioPuller.muted = true;
      void el.geminiAudioPuller.play().catch(() => {});
    }

    if (!geminiAudioContext || geminiAudioContext.state === "closed") {
      geminiAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (geminiAudioContext.state === "suspended") {
      void geminiAudioContext.resume().catch(() => {});
    }

    const stream = new MediaStream([remoteTrack]);
    geminiSourceNode = geminiAudioContext.createMediaStreamSource(stream);
    geminiProcessorNode = geminiAudioContext.createScriptProcessor(4096, 1, 1);

    geminiProcessorNode.onaudioprocess = (e) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const inputData = e.inputBuffer.getChannelData(0);
      const pcmBuffer = downsampleTo16k(inputData, geminiAudioContext.sampleRate);
      const base64 = arrayBufferToBase64(pcmBuffer);
      if (isDirect) {
        ws.send(JSON.stringify({
          realtimeInput: {
            mediaChunks: [
              {
                mimeType: "audio/pcm;rate=16000",
                data: base64,
              },
            ],
          },
        }));
      } else {
        ws.send(JSON.stringify({
          type: "audio",
          data: base64,
          rate: 16000,
        }));
      }
    };

    geminiSourceNode.connect(geminiProcessorNode);
    const silentGain = geminiAudioContext.createGain();
    silentGain.gain.value = 0;
    geminiProcessorNode.connect(silentGain);
    silentGain.connect(geminiAudioContext.destination);
  } catch (_err) {
    failCall("translationFailed");
  }
}

async function startGeminiTranslation(remoteTrack, isRetry = false) {
  if (!isRetry) translationRetryCount = 0;
  const generation = ++translationGeneration;
  closeTranslation(true);
  clearError();
  resetTranscripts();
  setStatus("translating", "connecting");

  const isDirect = Boolean(config?.gemini_key);
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = isDirect
    ? `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(config.gemini_key)}`
    : `${protocol}//${location.host}/ws/gemini-live/${encodeURIComponent(roomId)}/${encodeURIComponent(role)}?token=${encodeURIComponent(accessToken)}&model=${encodeURIComponent(geminiModel)}`;

  const ws = isDirect ? new WebSocket(wsUrl) : new WebSocket(wsUrl, ["calltranslate", accessToken]);
  geminiSocket = ws;

  ws.onopen = () => {
    if (geminiSocket !== ws) return;
    if (isDirect) {
      const instruction = role === "ar"
        ? "You are a real-time speech-to-speech interpreter for a live phone call. Translate whatever the speaker says into natural, clear spoken Arabic immediately. Output only the spoken Arabic translation as audio. Do not reply or converse."
        : "You are a real-time speech-to-speech interpreter for a live phone call. Translate whatever the speaker says into natural, clear spoken English immediately. Output only the spoken English translation as audio. Do not reply or converse.";
      const setupMsg = {
        setup: {
          model: `models/${geminiModel}`,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: role === "ar" ? "Aoede" : "Puck",
                },
              },
            },
          },
          systemInstruction: {
            parts: [{ text: instruction }],
          },
        },
      };
      ws.send(JSON.stringify(setupMsg));
    }
  };

  ws.onmessage = async (event) => {
    if (geminiSocket !== ws) return;
    let msg;
    try {
      let rawText = event.data;
      if (rawText instanceof Blob) {
        rawText = await rawText.text();
      } else if (rawText instanceof ArrayBuffer) {
        rawText = new TextDecoder().decode(rawText);
      }
      msg = JSON.parse(rawText);
    } catch (_e) {
      return;
    }

    if (isDirect) {
      if (msg.setupComplete) {
        setLive(true);
        setStatus("live", "live");
        startTimer();
        setupGeminiAudioCapture(remoteTrack, ws, true);
      } else if (msg.serverContent) {
        if (msg.serverContent.modelTurn?.parts) {
          for (const part of msg.serverContent.modelTurn.parts) {
            if (part.inlineData?.data) {
              try {
                const float32 = base64ToFloat32(part.inlineData.data);
                playGeminiPcmChunk(float32, 24000);
              } catch (_e) {}
            }
            if (part.text) {
              appendTranscript("translated", part.text);
            }
          }
        }
        if (msg.serverContent.interrupted) {
          if (geminiPlaybackContext) {
            geminiNextPlayTime = geminiPlaybackContext.currentTime;
          }
        }
      } else if (msg.error) {
        failCall("translationFailed");
      }
    } else {
      if (msg.type === "ready") {
        setLive(true);
        setStatus("live", "live");
        startTimer();
        setupGeminiAudioCapture(remoteTrack, ws, false);
      } else if (msg.type === "audio" && msg.data) {
        try {
          const float32 = base64ToFloat32(msg.data);
          playGeminiPcmChunk(float32, 24000);
        } catch (_e) {}
      } else if (msg.type === "transcript") {
        appendTranscript("translated", msg.text);
      } else if (msg.type === "interrupted") {
        if (geminiPlaybackContext) {
          geminiNextPlayTime = geminiPlaybackContext.currentTime;
        }
      } else if (msg.type === "error") {
        failCall("translationFailed");
      }
    }
  };

  ws.onerror = () => {
    if (geminiSocket === ws) failCall("translationFailed");
  };

  ws.onclose = (event) => {
    if (geminiSocket !== ws) return;
    geminiSocket = null;
    if (event.code === 4409) failCall("busy");
    else if ([4401, 4403, 4408].includes(event.code)) failCall("expired", true);
    else if (event.code !== 1000) failCall("translationFailed");
  };
}

function closeTranslation(preserveTimer = false) {
  if (translationTimer) clearTimeout(translationTimer);
  translationTimer = null;
  if (translationTrack && translationTrack !== remoteTrack) {
    try { translationTrack.stop(); } catch (_e) {}
  }
  translationTrack = null;
  if (translationPeer) {
    translationPeer.ontrack = translationPeer.onconnectionstatechange = null;
    translationPeer.close();
  }
  translationPeer = null;

  if (geminiSocket) {
    geminiSocket.onopen = geminiSocket.onmessage = geminiSocket.onerror = geminiSocket.onclose = null;
    try { geminiSocket.close(); } catch (_e) {}
    geminiSocket = null;
  }
  if (geminiProcessorNode) {
    geminiProcessorNode.onaudioprocess = null;
    try { geminiProcessorNode.disconnect(); } catch (_e) {}
    geminiProcessorNode = null;
  }
  if (geminiSourceNode) {
    try { geminiSourceNode.disconnect(); } catch (_e) {}
    geminiSourceNode = null;
  }
  if (geminiAudioContext) {
    void geminiAudioContext.close().catch(() => {});
    geminiAudioContext = null;
  }
  if (geminiPlaybackContext) {
    void geminiPlaybackContext.close().catch(() => {});
    geminiPlaybackContext = null;
  }
  geminiNextPlayTime = 0;

  el.audio.pause();
  el.audio.srcObject = null;
  setLive(false);
  if (!preserveTimer) stopTimer();
}

function teardownPeer() {
  translationGeneration += 1;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  closeTranslation();
  stopRemoteActivity();
  if (peer) {
    peer.ontrack = peer.onicecandidate = peer.onconnectionstatechange = null;
    peer.close();
  }
  peer = null;
  remoteTrackId = "";
  queuedCandidates = [];
  makingOffer = false;
  translationRetryCount = 0;
  resetTranscripts();
}

function stopMedia() {
  if (localStream) localStream.getTracks().forEach((track) => track.stop());
  localStream = null;
  el.mute.setAttribute("aria-pressed", "false");
  el.muteLabel.textContent = t("mute");
}

function failCall(key, invalidate = false) {
  if (closing) return;
  closing = true;
  sendSignal({ type: "hangup" });
  closeSocket();
  teardownPeer();
  stopMedia();
  void releaseWakeLock();
  if (invalidate) clearStoredAccess();
  setJoined(false, true);
  el.joinLabel.textContent = t("rejoin");
  el.join.disabled = invalidate && !fixedRoute;
  setStatus("ended");
  showError(messages.ar[key] ? key : "generic", key === "connectionFailed" ? "connection" : "general");
  closing = false;
}

function microphoneMessage(error) {
  if (!isSecureContext) return "insecure";
  if (["NotAllowedError", "SecurityError"].includes(error?.name)) return "micDenied";
  if (["NotFoundError", "DevicesNotFoundError"].includes(error?.name)) return "micMissing";
  if (["NotReadableError", "TrackStartError", "AbortError"].includes(error?.name)) return "micBusy";
  return "micDenied";
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator) || document.visibilityState !== "visible" || (wakeLock && !wakeLock.released)) return;
  try { wakeLock = await navigator.wakeLock.request("screen"); } catch (_error) { wakeLock = null; }
}

async function releaseWakeLock() {
  if (!wakeLock) return;
  try { await wakeLock.release(); } catch (_error) {}
  wakeLock = null;
}

async function join() {
  if (el.join.disabled || closing) return;
  clearError();
  el.join.disabled = true;
  setStatus("mic", "connecting");
  try {
    if (typeof RTCPeerConnection === "undefined" || !navigator.mediaDevices?.getUserMedia) throw new Error(isSecureContext ? "unsupported" : "insecure");
    if (!accessToken && fixedRoute) {
      accessToken = await issueFixedAccess();
      try { sessionStorage.setItem(storageKey, accessToken); } catch (_error) {}
    }
    if (!accessToken) throw new Error("expired");
    if (!config) config = await loadConfig();
    if (currentEngine === "openai" && !config.openai_configured) {
      if (config.gemini_configured) {
        setEngine("gemini");
      } else {
        throw new Error("keyMissing");
      }
    } else if (currentEngine === "gemini" && !config.gemini_configured) {
      if (config.openai_configured) {
        setEngine("openai");
      } else {
        throw new Error("keyMissing");
      }
    }
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch (error) { throw new Error(microphoneMessage(error)); }

    if (!geminiPlaybackContext || geminiPlaybackContext.state === "closed") {
      geminiPlaybackContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (geminiPlaybackContext.state === "suspended") {
      void geminiPlaybackContext.resume().catch(() => {});
    }
    if (!geminiAudioContext || geminiAudioContext.state === "closed") {
      geminiAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (geminiAudioContext.state === "suspended") {
      void geminiAudioContext.resume().catch(() => {});
    }
    setJoined(true, true);
    setStatus("waiting", "connecting");
    connectSocket();
    void requestWakeLock();
  } catch (error) {
    closeSocket();
    teardownPeer();
    stopMedia();
    const key = error instanceof Error && messages.ar[error.message] ? error.message : "generic";
    if (key === "expired") clearStoredAccess();
    setJoined(false, true);
    setStatus("ready");
    showError(key);
  } finally {
    el.join.disabled = !accessToken && !fixedRoute;
  }
}

function toggleMute() {
  if (!localStream) return;
  const mute = localStream.getAudioTracks().some((track) => track.enabled);
  localStream.getAudioTracks().forEach((track) => { track.enabled = !mute; });
  el.mute.setAttribute("aria-pressed", String(mute));
  el.muteLabel.textContent = t(mute ? "unmute" : "mute");
}

function leave() {
  if (closing) return;
  closing = true;
  sendSignal({ type: "hangup" });
  closeSocket();
  teardownPeer();
  stopMedia();
  void releaseWakeLock();
  clearError();
  setJoined(false, true);
  el.joinLabel.textContent = t("rejoin");
  el.join.disabled = false;
  setStatus("ended");
  closing = false;
}

async function initialize() {
  localize();
  setEngine(currentEngine);
  setGeminiModel(geminiModel);
  setStatus("loading");
  el.join.disabled = true;
  if (!pathIsValid) {
    setStatus("ended");
    showError("badLink");
    return;
  }
  try {
    try { accessToken = sessionStorage.getItem(storageKey) || ""; } catch (_error) {}
    if (accessToken) {
      try {
        config = await loadConfig();
        inviteToken = "";
        el.join.disabled = false;
        setStatus("ready");
        return;
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "expired") throw error;
        clearStoredAccess();
      }
    }
    if (fixedRoute) {
      el.join.disabled = false;
      setStatus("ready");
      return;
    }
    if (!inviteToken) throw new Error("badLink");
    const value = inviteToken;
    inviteToken = "";
    accessToken = await exchangeInvite(value);
    try { sessionStorage.setItem(storageKey, accessToken); } catch (_error) {}
    config = await loadConfig();
    el.join.disabled = false;
    setStatus("ready");
  } catch (error) {
    const key = error instanceof Error && messages.ar[error.message] ? error.message : "generic";
    if (["expired", "badLink"].includes(key)) clearStoredAccess();
    setStatus("ended");
    showError(key);
  }
}

el.join.addEventListener("click", join);
el.mute.addEventListener("click", toggleMute);
el.leave.addEventListener("click", leave);
el.audioUnlock.addEventListener("click", unlockAudio);
if (el.engineOpenAI) el.engineOpenAI.addEventListener("click", () => setEngine("openai"));
if (el.engineGemini) el.engineGemini.addEventListener("click", () => setEngine("gemini"));
if (el.modelPill25) el.modelPill25.addEventListener("click", () => setGeminiModel("gemini-2.5-flash-native-audio-latest"));
if (el.modelPill35) el.modelPill35.addEventListener("click", () => setGeminiModel("gemini-3.5-live-translate-preview"));
document.addEventListener("click", () => {
  if (geminiPlaybackContext && geminiPlaybackContext.state === "suspended") {
    void geminiPlaybackContext.resume().then(() => clearError("sound")).catch(() => {});
  }
  if (el.audio.srcObject && el.audio.paused) void el.audio.play().then(() => clearError("sound")).catch(() => {});
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && localStream) void requestWakeLock();
});
addEventListener("pagehide", () => {
  closing = true;
  sendSignal({ type: "hangup" });
  closeSocket();
  teardownPeer();
  stopMedia();
  void releaseWakeLock();
});

void initialize();
