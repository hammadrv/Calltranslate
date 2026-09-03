(() => {
  let currentUser = null;
  let userToken = "";
  let hubSocket = null;
  let currentIncomingCall = null;
  let activeCallSession = null;

  // WebRTC & Audio State
  let rtcPeer = null;
  let rtcSocket = null;
  let localMediaStream = null;
  let geminiSocket = null;
  let geminiAudioContext = null;
  let geminiPlaybackContext = null;
  let geminiSourceNode = null;
  let geminiProcessorNode = null;
  let geminiNextPlayTime = 0;
  let callTimerInterval = null;
  let callStartTime = 0;
  let ringOscillator = null;

  // DOM Elements
  const dom = {
    statusBarClock: document.getElementById("statusBarClock"),
    authBox: document.getElementById("authBox"),
    tabLogin: document.getElementById("tabLogin"),
    tabRegister: document.getElementById("tabRegister"),
    loginForm: document.getElementById("loginForm"),
    registerForm: document.getElementById("registerForm"),
    loginUsername: document.getElementById("loginUsername"),
    loginPassword: document.getElementById("loginPassword"),
    loginError: document.getElementById("loginError"),
    regUsername: document.getElementById("regUsername"),
    regDisplayName: document.getElementById("regDisplayName"),
    regPassword: document.getElementById("regPassword"),
    regLanguage: document.getElementById("regLanguage"),
    regError: document.getElementById("regError"),
    currentUserAvatar: document.getElementById("currentUserAvatar"),
    currentUserName: document.getElementById("currentUserName"),
    currentUserHandle: document.getElementById("currentUserHandle"),
    currentUserLangBadge: document.getElementById("currentUserLangBadge"),
    btnToggleLang: document.getElementById("btnToggleLang"),
    btnAdminPanel: document.getElementById("btnAdminPanel"),
    btnLogout: document.getElementById("btnLogout"),
    addFriendInput: document.getElementById("addFriendInput"),
    btnAddFriend: document.getElementById("btnAddFriend"),
    friendRequestsSection: document.getElementById("friendRequestsSection"),
    friendRequestsList: document.getElementById("friendRequestsList"),
    contactsContainer: document.getElementById("contactsContainer"),
    callOverlay: document.getElementById("callOverlay"),
    callTargetName: document.getElementById("callTargetName"),
    callStatusLine: document.getElementById("callStatusLine"),
    callTimer: document.getElementById("callTimer"),
    callOverlayAvatar: document.getElementById("callOverlayAvatar"),
    callCaptionText: document.getElementById("callCaptionText"),
    btnCallMute: document.getElementById("btnCallMute"),
    btnCallEnd: document.getElementById("btnCallEnd"),
    incomingModal: document.getElementById("incomingModal"),
    incomingAvatar: document.getElementById("incomingAvatar"),
    incomingCallerName: document.getElementById("incomingCallerName"),
    incomingCallerSub: document.getElementById("incomingCallerSub"),
    btnAcceptCall: document.getElementById("btnAcceptCall"),
    btnDeclineCall: document.getElementById("btnDeclineCall"),
    appTranslatedAudio: document.getElementById("appTranslatedAudio"),
    appAudioPuller: document.getElementById("appAudioPuller"),
  };

  // Clock in status bar
  function updateClock() {
    if (!dom.statusBarClock) return;
    const now = new Date();
    const h = String(now.getHours()).padStart(2, "0");
    const m = String(now.getMinutes()).padStart(2, "0");
    dom.statusBarClock.textContent = `${h}:${m}`;
  }
  setInterval(updateClock, 10000);
  updateClock();

  function authHeaders(headers = {}) {
    return { ...headers, Authorization: `Bearer ${userToken}`, "Content-Type": "application/json" };
  }

  // --- Auth Tabs & Forms ---
  dom.tabLogin.addEventListener("click", () => {
    dom.tabLogin.classList.add("active");
    dom.tabRegister.classList.remove("active");
    dom.loginForm.classList.remove("hidden");
    dom.registerForm.classList.add("hidden");
    dom.loginError.classList.add("hidden");
  });

  dom.tabRegister.addEventListener("click", () => {
    dom.tabRegister.classList.add("active");
    dom.tabLogin.classList.remove("active");
    dom.registerForm.classList.remove("hidden");
    dom.loginForm.classList.add("hidden");
    dom.regError.classList.add("hidden");
  });

  dom.loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    dom.loginError.classList.add("hidden");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: dom.loginUsername.value.trim(),
          password: dom.loginPassword.value,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Login failed");
      userToken = data.token;
      localStorage.setItem("calltranslate_usr_token", userToken);
      await initUserApp();
    } catch (err) {
      dom.loginError.textContent = err.message;
      dom.loginError.classList.remove("hidden");
    }
  });

  dom.registerForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    dom.regError.classList.add("hidden");
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: dom.regUsername.value.trim(),
          display_name: dom.regDisplayName.value.trim(),
          password: dom.regPassword.value,
          language: dom.regLanguage.value,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Registration failed");
      userToken = data.token;
      localStorage.setItem("calltranslate_usr_token", userToken);
      await initUserApp();
    } catch (err) {
      dom.regError.textContent = err.message;
      dom.regError.classList.remove("hidden");
    }
  });

  dom.btnLogout.addEventListener("click", async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST", headers: authHeaders() });
    } catch (_e) {}
    localStorage.removeItem("calltranslate_usr_token");
    location.reload();
  });

  dom.btnToggleLang.addEventListener("click", async () => {
    if (!currentUser) return;
    const newLang = currentUser.language === "ar" ? "en" : "ar";
    try {
      await fetch("/api/user/language", {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({ language: newLang }),
      });
      currentUser.language = newLang;
      dom.currentUserLangBadge.textContent = newLang.toUpperCase();
    } catch (_e) {}
  });

  // --- Session & App Initialization ---
  async function checkSession() {
    userToken = localStorage.getItem("calltranslate_usr_token") || "";
    if (!userToken) {
      dom.authBox.classList.remove("hidden");
      return;
    }
    try {
      const res = await fetch("/api/auth/me", { headers: authHeaders() });
      if (!res.ok) throw new Error("Invalid session");
      const data = await res.json();
      currentUser = data.user;
      await initUserApp();
    } catch (_err) {
      localStorage.removeItem("calltranslate_usr_token");
      dom.authBox.classList.remove("hidden");
    }
  }

  async function initUserApp() {
    dom.authBox.classList.add("hidden");

    dom.currentUserName.textContent = currentUser.display_name || currentUser.username;
    dom.currentUserHandle.textContent = `@${currentUser.username}`;
    dom.currentUserAvatar.textContent = (currentUser.display_name || currentUser.username).charAt(0).toUpperCase();
    dom.currentUserLangBadge.textContent = currentUser.language.toUpperCase();

    if (currentUser.is_admin) {
      dom.btnAdminPanel.classList.remove("hidden");
    } else {
      dom.btnAdminPanel.classList.add("hidden");
    }

    connectUserHub();
    await loadContacts();
    await loadFriendRequests();
  }

  // --- Real-time Signaling & Presence WebSocket ---
  function connectUserHub() {
    if (hubSocket) try { hubSocket.close(); } catch (_e) {}
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws/user-hub?token=${encodeURIComponent(userToken)}`;
    hubSocket = new WebSocket(url);

    hubSocket.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch (_e) { return; }

      if (msg.type === "incoming_call") {
        handleIncomingCall(msg);
      } else if (msg.type === "call_initiating") {
        handleCallInitiating(msg);
      } else if (msg.type === "call_accepted") {
        handleCallAccepted(msg);
      } else if (msg.type === "call_rejected") {
        handleCallRejected(msg);
      } else if (msg.type === "call_cancelled") {
        handleCallCancelled(msg);
      } else if (msg.type === "call_error") {
        alert(msg.message || "خطأ أثناء الاتصال");
        closeCallOverlay();
      } else if (msg.type === "friend_request_received") {
        loadFriendRequests();
      } else if (msg.type === "friend_request_accepted") {
        loadContacts();
        loadFriendRequests();
      } else if (msg.type === "contact_removed") {
        loadContacts();
      }
    };

    hubSocket.onclose = () => {
      setTimeout(() => {
        if (userToken) connectUserHub();
      }, 3000);
    };
  }

  // --- Contacts Management ---
  async function loadContacts() {
    try {
      const res = await fetch("/api/contacts", { headers: authHeaders() });
      if (!res.ok) return;
      const data = await res.json();
      renderContacts(data.contacts || []);
    } catch (_e) {}
  }

  function renderContacts(contacts) {
    dom.contactsContainer.innerHTML = "";
    if (contacts.length === 0) {
      dom.contactsContainer.innerHTML = `
        <div class="empty-contacts-view">
          <p>لا يوجد أصدقاء بعد.<br>أضف مستخدم بالـ username أعلاه لتبدأ المكالمات المترجمة!</p>
        </div>
      `;
      return;
    }

    contacts.forEach((c) => {
      const row = document.createElement("div");
      row.className = "contact-row";
      row.innerHTML = `
        <div class="avatar-container">
          <div class="user-avatar-sm">${(c.display_name || c.username).charAt(0).toUpperCase()}</div>
          <span class="dot-online ${c.is_online ? "online" : ""}"></span>
        </div>
        <div class="contact-details">
          <div class="contact-top-line">
            <span class="contact-name">${c.display_name}</span>
            <span class="lang-pill">${c.language.toUpperCase()}</span>
          </div>
          <div class="contact-sub-line">
            @${c.username} • <span style="color:${c.is_online ? 'var(--tg-green)' : 'var(--tg-text-secondary)'}">${c.is_online ? 'متصل' : 'غير متصل'}</span>
          </div>
        </div>
        <div class="contact-actions">
          <button class="btn-contact-del" title="حذف الصديق">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              <line x1="10" y1="11" x2="10" y2="17"/>
              <line x1="14" y1="11" x2="14" y2="17"/>
            </svg>
          </button>
          <button class="btn-contact-call" title="بدء مكالمة مترجمة">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
            </svg>
          </button>
        </div>
      `;

      // Call button click
      row.querySelector(".btn-contact-call").addEventListener("click", (e) => {
        e.stopPropagation();
        initiateCall(c);
      });

      // Delete button click
      row.querySelector(".btn-contact-del").addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm(`هل أنت متأكد من حذف ${c.display_name} (@${c.username}) من قائمة الأصدقاء؟`)) return;
        try {
          const res = await fetch(`/api/contacts/${c.username}`, {
            method: "DELETE",
            headers: authHeaders(),
          });
          if (res.ok) {
            await loadContacts();
          }
        } catch (_e) {}
      });

      dom.contactsContainer.appendChild(row);
    });
  }

  // --- Friend Requests ---
  dom.btnAddFriend.addEventListener("click", async () => {
    let username = dom.addFriendInput.value.trim();
    if (username.startsWith("@")) username = username.substring(1);
    if (!username) return;

    try {
      const res = await fetch("/api/friend-requests", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ username }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "تعذر إرسال طلب الصداقة");
      alert(data.message || "تم إرسال طلب الصداقة!");
      dom.addFriendInput.value = "";
      await loadContacts();
      await loadFriendRequests();
    } catch (err) {
      alert(err.message);
    }
  });

  async function loadFriendRequests() {
    try {
      const res = await fetch("/api/friend-requests", { headers: authHeaders() });
      if (!res.ok) return;
      const data = await res.json();
      const requests = data.requests || [];
      if (requests.length === 0) {
        dom.friendRequestsSection.classList.add("hidden");
        return;
      }

      dom.friendRequestsSection.classList.remove("hidden");
      dom.friendRequestsList.innerHTML = "";

      requests.forEach((req) => {
        const item = document.createElement("div");
        item.className = "request-item";
        item.innerHTML = `
          <div class="request-info">
            <div class="user-avatar-sm" style="width:30px;height:30px;font-size:0.8rem;">
              ${(req.display_name || req.username).charAt(0).toUpperCase()}
            </div>
            <div>
              <span style="font-weight:600;font-size:0.85rem;">${req.display_name}</span>
              <span style="color:var(--tg-text-secondary);font-size:0.75rem;">(@${req.username})</span>
            </div>
          </div>
          <div class="request-actions">
            <button class="btn-req-accept" data-req-id="${req.request_id}">قبول</button>
            <button class="btn-req-reject" data-req-id="${req.request_id}">رفض</button>
          </div>
        `;

        item.querySelector(".btn-req-accept").addEventListener("click", async () => {
          try {
            const acceptRes = await fetch(`/api/friend-requests/${req.request_id}/accept`, {
              method: "POST",
              headers: authHeaders(),
            });
            if (acceptRes.ok) {
              await loadContacts();
              await loadFriendRequests();
            }
          } catch (_e) {}
        });

        item.querySelector(".btn-req-reject").addEventListener("click", async () => {
          try {
            const rejectRes = await fetch(`/api/friend-requests/${req.request_id}/reject`, {
              method: "POST",
              headers: authHeaders(),
            });
            if (rejectRes.ok) {
              await loadFriendRequests();
            }
          } catch (_e) {}
        });

        dom.friendRequestsList.appendChild(item);
      });
    } catch (_e) {}
  }

  // --- Calling Flow ---
  function initiateCall(target) {
    if (!hubSocket || hubSocket.readyState !== WebSocket.OPEN) {
      alert("غير متصل بالسيرفر");
      return;
    }
    unlockAudioGraph();

    dom.callTargetName.textContent = target.display_name;
    dom.callOverlayAvatar.textContent = (target.display_name || target.username).charAt(0).toUpperCase();
    dom.callStatusLine.textContent = "جاري الاتصال والرنين...";
    dom.callCaptionText.textContent = "بانتظار قبول الطرف الآخر للمكالمة...";
    dom.callTimer.textContent = "00:00";
    dom.callOverlay.classList.remove("hidden");

    hubSocket.send(JSON.stringify({
      type: "call_user",
      target: target.username,
    }));
  }

  function handleCallInitiating(msg) {
    activeCallSession = {
      roomId: msg.room_id,
      role: msg.role,
      accessToken: msg.access_token,
      targetUsername: msg.target,
      model: msg.model,
      isCaller: true,
    };
  }

  function handleIncomingCall(msg) {
    currentIncomingCall = msg;
    dom.incomingAvatar.textContent = (msg.caller_name || msg.caller).charAt(0).toUpperCase();
    dom.incomingCallerName.textContent = msg.caller_name;
    dom.incomingCallerSub.textContent = `مكالمة مترجمة واردة (${msg.caller_language.toUpperCase()})`;
    dom.incomingModal.classList.remove("hidden");
    startRingingSound();
  }

  dom.btnAcceptCall.addEventListener("click", async () => {
    if (!currentIncomingCall) return;
    stopRingingSound();
    dom.incomingModal.classList.add("hidden");
    unlockAudioGraph();

    const callData = currentIncomingCall;
    activeCallSession = {
      roomId: callData.room_id,
      role: callData.role,
      accessToken: callData.access_token,
      targetUsername: callData.caller,
      model: callData.model,
      isCaller: false,
    };

    hubSocket.send(JSON.stringify({
      type: "accept_call",
      room_id: callData.room_id,
      caller: callData.caller,
    }));

    dom.callTargetName.textContent = callData.caller_name;
    dom.callOverlayAvatar.textContent = (callData.caller_name || callData.caller).charAt(0).toUpperCase();
    dom.callStatusLine.textContent = "جاري تفعيل المكالمة المترجمة...";
    dom.callCaptionText.textContent = "جاري تشغيل محرك الترجمة...";
    dom.callTimer.textContent = "00:00";
    dom.callOverlay.classList.remove("hidden");

    await startCallWebRTC();
  });

  dom.btnDeclineCall.addEventListener("click", () => {
    if (!currentIncomingCall) return;
    stopRingingSound();
    dom.incomingModal.classList.add("hidden");
    hubSocket.send(JSON.stringify({
      type: "reject_call",
      room_id: currentIncomingCall.room_id,
      caller: currentIncomingCall.caller,
    }));
    currentIncomingCall = null;
  });

  async function handleCallAccepted(_msg) {
    dom.callStatusLine.textContent = "تم قبول المكالمة! جاري الاتصال...";
    await startCallWebRTC();
  }

  function handleCallRejected(_msg) {
    dom.callStatusLine.textContent = "تم رفض المكالمة من الطرف الآخر.";
    setTimeout(closeCallOverlay, 2000);
  }

  function handleCallCancelled(_msg) {
    stopRingingSound();
    dom.incomingModal.classList.add("hidden");
    currentIncomingCall = null;
  }

  dom.btnCallEnd.addEventListener("click", () => {
    if (activeCallSession) {
      if (activeCallSession.isCaller) {
        hubSocket.send(JSON.stringify({
          type: "cancel_call",
          room_id: activeCallSession.roomId,
          target: activeCallSession.targetUsername,
        }));
      } else {
        hubSocket.send(JSON.stringify({
          type: "reject_call",
          room_id: activeCallSession.roomId,
          caller: activeCallSession.targetUsername,
        }));
      }
    }
    closeCallOverlay();
  });

  function closeCallOverlay() {
    dom.callOverlay.classList.add("hidden");
    if (callTimerInterval) clearInterval(callTimerInterval);
    callTimerInterval = null;
    stopMedia();
    teardownPeer();
    closeTranslation();
    activeCallSession = null;
  }

  // --- WebRTC Peer & Gemini Translation Engine ---
  async function startCallWebRTC() {
    if (!activeCallSession) return;
    dom.callStatusLine.textContent = "جاري طلب إذن الميكروفون...";

    try {
      localMediaStream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });

      const cfgRes = await fetch("/api/client-config", {
        headers: { Authorization: `Bearer ${activeCallSession.accessToken}` },
      });
      const config = await cfgRes.json();

      rtcPeer = new RTCPeerConnection({
        iceServers: config.ice_servers || [{ urls: ["stun:stun.l.google.com:19302"] }],
      });

      localMediaStream.getAudioTracks().forEach((track) => {
        rtcPeer.addTrack(track, localMediaStream);
      });

      rtcPeer.ontrack = (event) => {
        if (event.track.kind !== "audio") return;
        dom.callStatusLine.textContent = "المكالمة متصلة (ترجمة حية)";
        startTimer();
        startTranslation(event.track, config);
      };

      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${proto}//${location.host}/ws/${encodeURIComponent(activeCallSession.roomId)}/${encodeURIComponent(activeCallSession.role)}`;
      rtcSocket = new WebSocket(wsUrl, ["calltranslate", activeCallSession.accessToken]);

      rtcPeer.onicecandidate = (e) => {
        if (e.candidate && rtcSocket && rtcSocket.readyState === WebSocket.OPEN) {
          rtcSocket.send(JSON.stringify({ type: "candidate", candidate: e.candidate.toJSON() }));
        }
      };

      rtcSocket.onmessage = async (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch (_err) { return; }

        if (msg.type === "offer") {
          await rtcPeer.setRemoteDescription(new RTCSessionDescription(msg.sdp));
          const answer = await rtcPeer.createAnswer();
          await rtcPeer.setLocalDescription(answer);
          rtcSocket.send(JSON.stringify({ type: "answer", sdp: answer }));
        } else if (msg.type === "answer") {
          await rtcPeer.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        } else if (msg.type === "candidate" && msg.candidate) {
          try { await rtcPeer.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch (_e) {}
        } else if (msg.type === "peer-left") {
          dom.callStatusLine.textContent = "أنهى الطرف الآخر المكالمة.";
          setTimeout(closeCallOverlay, 1500);
        }
      };

      rtcSocket.onopen = async () => {
        if (activeCallSession.isCaller) {
          const offer = await rtcPeer.createOffer({ offerToReceiveAudio: true });
          await rtcPeer.setLocalDescription(offer);
          rtcSocket.send(JSON.stringify({ type: "offer", sdp: offer }));
        }
      };
    } catch (err) {
      alert("تعذر الاتصال بالميكروفون: " + err.message);
      closeCallOverlay();
    }
  }

  function startTimer() {
    if (callTimerInterval) return;
    callStartTime = Date.now();
    callTimerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
      const mins = String(Math.floor(elapsed / 60)).padStart(2, "0");
      const secs = String(elapsed % 60).padStart(2, "0");
      dom.callTimer.textContent = `${mins}:${secs}`;
    }, 1000);
  }

  function startTranslation(remoteTrack, config) {
    if (dom.appAudioPuller) {
      dom.appAudioPuller.srcObject = new MediaStream([remoteTrack]);
      dom.appAudioPuller.muted = true;
      void dom.appAudioPuller.play().catch(() => {});
    }

    const assignedModel = activeCallSession.model || "gemini-3.5-live-translate-preview";
    const role = activeCallSession.role;
    const isDirect = Boolean(config.gemini_key);

    const wsUrl = isDirect
      ? `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(config.gemini_key)}`
      : `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws/gemini-live/${encodeURIComponent(activeCallSession.roomId)}/${encodeURIComponent(role)}?token=${encodeURIComponent(activeCallSession.accessToken)}&model=${encodeURIComponent(assignedModel)}`;

    const ws = isDirect ? new WebSocket(wsUrl) : new WebSocket(wsUrl, ["calltranslate", activeCallSession.accessToken]);
    geminiSocket = ws;

    ws.onopen = () => {
      if (isDirect) {
        const instruction = role === "ar"
          ? "You are a real-time speech-to-speech interpreter for a live phone call. Translate whatever the speaker says into natural, clear spoken Arabic immediately. Output only the spoken Arabic translation as audio. Do not reply or converse."
          : "You are a real-time speech-to-speech interpreter for a live phone call. Translate whatever the speaker says into natural, clear spoken English immediately. Output only the spoken English translation as audio. Do not reply or converse.";
        const setup = {
          setup: {
            model: `models/${assignedModel}`,
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: role === "ar" ? "Aoede" : "Puck" },
                },
              },
            },
            systemInstruction: { parts: [{ text: instruction }] },
          },
        };
        ws.send(JSON.stringify(setup));
      }
    };

    ws.onmessage = async (event) => {
      let raw = event.data;
      if (raw instanceof Blob) raw = await raw.text();
      else if (raw instanceof ArrayBuffer) raw = new TextDecoder().decode(raw);

      let msg;
      try { msg = JSON.parse(raw); } catch (_e) { return; }

      if (isDirect) {
        if (msg.setupComplete) {
          dom.callCaptionText.textContent = "الترجمة الحية جاهزة، تحدث الآن...";
          setupGeminiAudioCapture(remoteTrack, ws, true);
        } else if (msg.serverContent?.modelTurn?.parts) {
          for (const part of msg.serverContent.modelTurn.parts) {
            if (part.inlineData?.data) {
              const float32 = base64ToFloat32(part.inlineData.data);
              playPcmChunk(float32, 24000);
            }
            if (part.text) {
              dom.callCaptionText.textContent = part.text;
            }
          }
        }
      } else {
        if (msg.type === "ready") {
          dom.callCaptionText.textContent = "الترجمة الحية جاهزة، تحدث الآن...";
          setupGeminiAudioCapture(remoteTrack, ws, false);
        } else if (msg.type === "audio" && msg.data) {
          playPcmChunk(base64ToFloat32(msg.data), 24000);
        } else if (msg.type === "transcript") {
          dom.callCaptionText.textContent = msg.text;
        }
      }
    };
  }

  function setupGeminiAudioCapture(remoteTrack, ws, isDirect) {
    try {
      if (!geminiAudioContext || geminiAudioContext.state === "closed") {
        geminiAudioContext = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (geminiAudioContext.state === "suspended") void geminiAudioContext.resume().catch(() => {});

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
            realtimeInput: { mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: base64 }] },
          }));
        } else {
          ws.send(JSON.stringify({ type: "audio", data: base64, rate: 16000 }));
        }
      };

      geminiSourceNode.connect(geminiProcessorNode);
      const silent = geminiAudioContext.createGain();
      silent.gain.value = 0;
      geminiProcessorNode.connect(silent);
      silent.connect(geminiAudioContext.destination);
    } catch (_e) {}
  }

  function playPcmChunk(float32Data, sampleRate = 24000) {
    if (!geminiPlaybackContext || geminiPlaybackContext.state === "closed") {
      geminiPlaybackContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (geminiPlaybackContext.state === "suspended") void geminiPlaybackContext.resume().catch(() => {});

    const buf = geminiPlaybackContext.createBuffer(1, float32Data.length, sampleRate);
    buf.copyToChannel(float32Data, 0);

    const src = geminiPlaybackContext.createBufferSource();
    src.buffer = buf;
    src.connect(geminiPlaybackContext.destination);

    const now = geminiPlaybackContext.currentTime;
    if (geminiNextPlayTime < now) geminiNextPlayTime = now + 0.05;
    src.start(geminiNextPlayTime);
    geminiNextPlayTime += buf.duration;
  }

  function downsampleTo16k(inputBuffer, inputSampleRate) {
    if (inputSampleRate === 16000) {
      const pcm = new Int16Array(inputBuffer.length);
      for (let i = 0; i < inputBuffer.length; i++) {
        const s = Math.max(-1, Math.min(1, inputBuffer[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      return pcm.buffer;
    }
    const ratio = inputSampleRate / 16000;
    const newLen = Math.round(inputBuffer.length / ratio);
    const pcm = new Int16Array(newLen);
    for (let i = 0; i < newLen; i++) {
      const srcIdx = i * ratio;
      const i0 = Math.floor(srcIdx);
      const i1 = Math.min(i0 + 1, inputBuffer.length - 1);
      const s = inputBuffer[i0] + (inputBuffer[i1] - inputBuffer[i0]) * (srcIdx - i0);
      const clamped = Math.max(-1, Math.min(1, s));
      pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    }
    return pcm.buffer;
  }

  function arrayBufferToBase64(buffer) {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function base64ToFloat32(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const int16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7fff);
    }
    return float32;
  }

  function stopMedia() {
    if (localMediaStream) {
      localMediaStream.getTracks().forEach((t) => t.stop());
      localMediaStream = null;
    }
  }

  function teardownPeer() {
    if (rtcSocket) {
      try { rtcSocket.close(); } catch (_e) {}
      rtcSocket = null;
    }
    if (rtcPeer) {
      rtcPeer.ontrack = rtcPeer.onicecandidate = null;
      try { rtcPeer.close(); } catch (_e) {}
      rtcPeer = null;
    }
  }

  function closeTranslation() {
    if (geminiSocket) {
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
  }

  function unlockAudioGraph() {
    try {
      if (!geminiPlaybackContext || geminiPlaybackContext.state === "closed") {
        geminiPlaybackContext = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (geminiPlaybackContext.state === "suspended") void geminiPlaybackContext.resume();
      if (!geminiAudioContext || geminiAudioContext.state === "closed") {
        geminiAudioContext = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (geminiAudioContext.state === "suspended") void geminiAudioContext.resume();
    } catch (_e) {}
  }

  function startRingingSound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(440, ctx.currentTime);
      gain.gain.setValueAtTime(0.1, ctx.currentTime);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      ringOscillator = { ctx, osc };
    } catch (_e) {}
  }

  function stopRingingSound() {
    if (ringOscillator) {
      try {
        ringOscillator.osc.stop();
        ringOscillator.ctx.close();
      } catch (_e) {}
      ringOscillator = null;
    }
  }

  dom.btnCallMute.addEventListener("click", () => {
    if (!localMediaStream) return;
    const tracks = localMediaStream.getAudioTracks();
    const currentlyEnabled = tracks.some((t) => t.enabled);
    tracks.forEach((t) => (t.enabled = !currentlyEnabled));
    dom.btnCallMute.classList.toggle("muted", currentlyEnabled);
  });

  checkSession();
})();
