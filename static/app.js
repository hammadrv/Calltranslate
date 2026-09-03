(() => {
  let currentUser = null;
  let userToken = "";
  let hubSocket = null;
  let activeChatContact = null;
  let currentIncomingCall = null;
  let activeCallSession = null;

  // WebRTC & Audio State
  let rtcPeer = null;
  let rtcSocket = null;
  let localMediaStream = null;
  let queuedCandidates = [];
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
    btnLogout: document.getElementById("btnLogout"),
    addFriendInput: document.getElementById("addFriendInput"),
    btnAddFriend: document.getElementById("btnAddFriend"),
    friendRequestsSection: document.getElementById("friendRequestsSection"),
    friendRequestsList: document.getElementById("friendRequestsList"),
    outgoingRequestsSection: document.getElementById("outgoingRequestsSection"),
    outgoingRequestsList: document.getElementById("outgoingRequestsList"),
    contactsContainer: document.getElementById("contactsContainer"),
    // Chat elements
    chatViewOverlay: document.getElementById("chatViewOverlay"),
    btnChatBack: document.getElementById("btnChatBack"),
    chatContactAvatar: document.getElementById("chatContactAvatar"),
    chatContactName: document.getElementById("chatContactName"),
    chatContactStatus: document.getElementById("chatContactStatus"),
    chatContactLangBadge: document.getElementById("chatContactLangBadge"),
    btnChatCall: document.getElementById("btnChatCall"),
    btnChatDelete: document.getElementById("btnChatDelete"),
    chatMessagesContainer: document.getElementById("chatMessagesContainer"),
    chatInputForm: document.getElementById("chatInputForm"),
    chatTextInput: document.getElementById("chatTextInput"),
    // Call elements
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

    // Display username clearly with @ and name
    dom.currentUserName.textContent = currentUser.display_name || currentUser.username;
    dom.currentUserHandle.textContent = `@${currentUser.username}`;
    dom.currentUserAvatar.textContent = (currentUser.display_name || currentUser.username).charAt(0).toUpperCase();
    dom.currentUserLangBadge.textContent = currentUser.language.toUpperCase();

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
      } else if (msg.type === "friend_request_received" || msg.type === "friend_request_accepted" || msg.type === "friend_request_cancelled") {
        loadContacts();
        loadFriendRequests();
      } else if (msg.type === "contact_removed") {
        loadContacts();
        if (activeChatContact && activeChatContact.username === msg.by_username) {
          closeChat();
        }
      } else if (msg.type === "new_chat_message") {
        handleIncomingChatMessage(msg);
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
          <p>لا يوجد أصدقاء بعد.<br>أضف صديق بالـ @username أعلاه لبدء المحادثات والمكالمات المترجمة!</p>
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
            <span dir="ltr">@${c.username}</span> • <span style="color:${c.is_online ? 'var(--tg-green)' : 'var(--tg-text-secondary)'}">${c.is_online ? 'متصل' : 'غير متصل'}</span>
          </div>
        </div>
      `;

      // Click on contact opens Telegram chat / profile
      row.addEventListener("click", () => {
        openChat(c);
      });

      dom.contactsContainer.appendChild(row);
    });
  }

  // --- Friend Requests (Incoming & Outgoing Pending) ---
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
      const incoming = data.incoming || [];
      const outgoing = data.outgoing || [];

      // Render Incoming
      if (incoming.length === 0) {
        dom.friendRequestsSection.classList.add("hidden");
      } else {
        dom.friendRequestsSection.classList.remove("hidden");
        dom.friendRequestsList.innerHTML = "";
        incoming.forEach((req) => {
          const item = document.createElement("div");
          item.className = "request-item";
          item.innerHTML = `
            <div class="request-info">
              <div class="user-avatar-sm" style="width:30px;height:30px;font-size:0.8rem;">
                ${(req.display_name || req.username).charAt(0).toUpperCase()}
              </div>
              <div>
                <span style="font-weight:600;font-size:0.85rem;">${req.display_name}</span>
                <span style="color:var(--tg-text-secondary);font-size:0.75rem;" dir="ltr">(@${req.username})</span>
              </div>
            </div>
            <div class="request-actions">
              <button class="btn-req-accept" data-req-id="${req.request_id}">قبول</button>
              <button class="btn-req-reject" data-req-id="${req.request_id}">رفض</button>
            </div>
          `;

          item.querySelector(".btn-req-accept").addEventListener("click", async () => {
            try {
              const r = await fetch(`/api/friend-requests/${req.request_id}/accept`, {
                method: "POST",
                headers: authHeaders(),
              });
              if (r.ok) {
                await loadContacts();
                await loadFriendRequests();
              }
            } catch (_e) {}
          });

          item.querySelector(".btn-req-reject").addEventListener("click", async () => {
            try {
              const r = await fetch(`/api/friend-requests/${req.request_id}/reject`, {
                method: "POST",
                headers: authHeaders(),
              });
              if (r.ok) await loadFriendRequests();
            } catch (_e) {}
          });

          dom.friendRequestsList.appendChild(item);
        });
      }

      // Render Outgoing (Pending Approval)
      if (outgoing.length === 0) {
        dom.outgoingRequestsSection.classList.add("hidden");
      } else {
        dom.outgoingRequestsSection.classList.remove("hidden");
        dom.outgoingRequestsList.innerHTML = "";
        outgoing.forEach((req) => {
          const item = document.createElement("div");
          item.className = "request-item";
          item.innerHTML = `
            <div class="request-info">
              <div class="user-avatar-sm" style="width:30px;height:30px;font-size:0.8rem;background:#d97706;">
                ${(req.display_name || req.username).charAt(0).toUpperCase()}
              </div>
              <div>
                <span style="font-weight:600;font-size:0.85rem;">${req.display_name}</span>
                <span style="color:var(--tg-text-secondary);font-size:0.75rem;" dir="ltr">(@${req.username})</span>
              </div>
            </div>
            <div class="request-actions">
              <button class="btn-req-cancel" data-req-id="${req.request_id}">إلغاء الطلب</button>
            </div>
          `;

          item.querySelector(".btn-req-cancel").addEventListener("click", async () => {
            try {
              const r = await fetch(`/api/friend-requests/${req.request_id}/cancel`, {
                method: "POST",
                headers: authHeaders(),
              });
              if (r.ok) await loadFriendRequests();
            } catch (_e) {}
          });

          dom.outgoingRequestsList.appendChild(item);
        });
      }
    } catch (_e) {}
  }

  // --- Telegram Chat View ---
  async function openChat(contact) {
    activeChatContact = contact;
    dom.chatContactName.textContent = contact.display_name;
    dom.chatContactAvatar.textContent = (contact.display_name || contact.username).charAt(0).toUpperCase();
    dom.chatContactStatus.textContent = contact.is_online ? "متصل الآن (Online)" : "غير متصل";
    dom.chatContactStatus.style.color = contact.is_online ? "var(--tg-green)" : "var(--tg-text-secondary)";
    dom.chatContactLangBadge.textContent = contact.language.toUpperCase();

    dom.chatViewOverlay.classList.remove("hidden");
    await loadChatMessages(contact.username);
  }

  function closeChat() {
    activeChatContact = null;
    dom.chatViewOverlay.classList.add("hidden");
  }

  dom.btnChatBack.addEventListener("click", closeChat);

  // Delete button INSIDE contact profile / chat
  dom.btnChatDelete.addEventListener("click", async () => {
    if (!activeChatContact) return;
    const c = activeChatContact;
    if (!confirm(`هل أنت متأكد من حذف ${c.display_name} (@${c.username}) من قائمة الأصدقاء؟`)) return;
    try {
      const res = await fetch(`/api/contacts/${c.username}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (res.ok) {
        closeChat();
        await loadContacts();
      }
    } catch (_e) {}
  });

  // Call button in chat header
  dom.btnChatCall.addEventListener("click", () => {
    if (activeChatContact) initiateCall(activeChatContact);
  });

  async function loadChatMessages(username) {
    dom.chatMessagesContainer.innerHTML = "";
    try {
      const res = await fetch(`/api/messages/${username}`, { headers: authHeaders() });
      if (!res.ok) return;
      const data = await res.json();
      (data.messages || []).forEach(appendMessageBubble);
      scrollChatToBottom();
    } catch (_e) {}
  }

  function appendMessageBubble(msg) {
    const isOut = msg.from_user_id === currentUser.id;
    const bubble = document.createElement("div");
    bubble.className = `msg-bubble ${isOut ? "outgoing" : "incoming"}`;

    const timeStr = msg.created_at
      ? new Date(msg.created_at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "";

    let translationHtml = "";
    if (msg.translated_text && msg.translated_text !== msg.original_text) {
      translationHtml = `<div class="msg-translation-pill">🌐 ${msg.translated_text}</div>`;
    }

    bubble.innerHTML = `
      <div class="msg-text-original">${escapeHtml(msg.original_text)}</div>
      ${translationHtml}
      <div class="msg-time">${timeStr}</div>
    `;

    dom.chatMessagesContainer.appendChild(bubble);
  }

  function scrollChatToBottom() {
    dom.chatMessagesContainer.scrollTop = dom.chatMessagesContainer.scrollHeight;
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  dom.chatInputForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = dom.chatTextInput.value.trim();
    if (!text || !activeChatContact) return;
    dom.chatTextInput.value = "";

    try {
      const res = await fetch(`/api/messages/${activeChatContact.username}`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ text }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.message) {
          appendMessageBubble(data.message);
          scrollChatToBottom();
        }
      }
    } catch (_e) {}
  });

  function handleIncomingChatMessage(msgEvent) {
    const msg = msgEvent.message;
    if (activeChatContact && (msg.from_user_id === activeChatContact.id || msgEvent.sender_username === activeChatContact.username)) {
      appendMessageBubble(msg);
      scrollChatToBottom();
    }
  }

  // --- Calling Flow & WebRTC Engine ---
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

  // --- Proven WebRTC Peer & Signaling ---
  async function startCallWebRTC() {
    if (!activeCallSession) return;
    dom.callStatusLine.textContent = "جاري تفعيل الصوت والاتصال...";
    queuedCandidates = [];

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

      rtcPeer.onconnectionstatechange = () => {
        if (rtcPeer.connectionState === "connected") {
          dom.callStatusLine.textContent = "المكالمة متصلة (ترجمة حية)";
          startTimer();
        } else if (["disconnected", "failed"].includes(rtcPeer.connectionState)) {
          dom.callStatusLine.textContent = "انقطع الاتصال";
        }
      };

      // CRUCIAL FIX: send "ice-candidate" with candidate object (expected by app.py)
      rtcPeer.onicecandidate = (e) => {
        if (e.candidate && rtcSocket && rtcSocket.readyState === WebSocket.OPEN) {
          rtcSocket.send(JSON.stringify({
            type: "ice-candidate",
            candidate: e.candidate.toJSON(),
          }));
        }
      };

      // Connect signaling websocket
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${proto}//${location.host}/ws/${encodeURIComponent(activeCallSession.roomId)}/${encodeURIComponent(activeCallSession.role)}`;
      rtcSocket = new WebSocket(wsUrl, ["calltranslate", activeCallSession.accessToken]);

      async function createAndSendOffer() {
        if (!rtcPeer) return;
        try {
          const offer = await rtcPeer.createOffer({ offerToReceiveAudio: true });
          await rtcPeer.setLocalDescription(offer);
          if (rtcSocket && rtcSocket.readyState === WebSocket.OPEN) {
            rtcSocket.send(JSON.stringify({ type: "offer", sdp: offer.sdp }));
          }
        } catch (_err) {}
      }

      rtcSocket.onopen = async () => {
        // Ready to signal
      };

      rtcSocket.onmessage = async (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch (_err) { return; }

        if (msg.type === "welcome") {
          if (msg.peer_connected && activeCallSession.isCaller) {
            await createAndSendOffer();
          }
        } else if (msg.type === "peer-joined") {
          if (activeCallSession.isCaller) {
            await createAndSendOffer();
          }
        } else if (msg.type === "offer") {
          await rtcPeer.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp: msg.sdp }));
          for (const cand of queuedCandidates.splice(0)) {
            try { await rtcPeer.addIceCandidate(new RTCIceCandidate(cand)); } catch (_e) {}
          }
          const answer = await rtcPeer.createAnswer();
          await rtcPeer.setLocalDescription(answer);
          rtcSocket.send(JSON.stringify({ type: "answer", sdp: answer.sdp }));
        } else if (msg.type === "answer") {
          await rtcPeer.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: msg.sdp }));
          for (const cand of queuedCandidates.splice(0)) {
            try { await rtcPeer.addIceCandidate(new RTCIceCandidate(cand)); } catch (_e) {}
          }
        } else if (msg.type === "ice-candidate" && msg.candidate) {
          if (rtcPeer.remoteDescription) {
            try { await rtcPeer.addIceCandidate(new RTCIceCandidate(msg.candidate)); } catch (_e) {}
          } else {
            queuedCandidates.push(msg.candidate);
          }
        } else if (msg.type === "peer-left") {
          dom.callStatusLine.textContent = "أنهى الطرف الآخر المكالمة.";
          setTimeout(closeCallOverlay, 1500);
        }
      };

    } catch (err) {
      alert("تعذر الوصول إلى الميكروفون: " + err.message);
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
      if (geminiPlaybackContext.state === "suspended") void geminiPlaybackContext.resume().catch(() => {});
      if (!geminiAudioContext || geminiAudioContext.state === "closed") {
        geminiAudioContext = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (geminiAudioContext.state === "suspended") void geminiAudioContext.resume().catch(() => {});
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
