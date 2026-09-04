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
    currentUserHandle: document.getElementById("currentUserHandle"),
    currentUserLangBadge: document.getElementById("currentUserLangBadge"),
    btnOpenDrawer: document.getElementById("btnOpenDrawer"),
    drawerBackdrop: document.getElementById("drawerBackdrop"),
    tgDrawer: document.getElementById("tgDrawer"),
    drawerUserAvatar: document.getElementById("drawerUserAvatar"),
    drawerUserName: document.getElementById("drawerUserName"),
    drawerUserHandle: document.getElementById("drawerUserHandle"),
    drawerBtnLang: document.getElementById("drawerBtnLang"),
    drawerLangText: document.getElementById("drawerLangText"),
    drawerBtnLogout: document.getElementById("drawerBtnLogout"),
    // Tabs & Feeds
    tabChats: document.getElementById("tabChats"),
    chatsUnreadCountBadge: document.getElementById("chatsUnreadCountBadge"),
    tabRequests: document.getElementById("tabRequests"),
    requestsCountBadge: document.getElementById("requestsCountBadge"),
    viewChatsFeed: document.getElementById("viewChatsFeed"),
    viewRequestsFeed: document.getElementById("viewRequestsFeed"),
    contactsContainer: document.getElementById("contactsContainer"),
    incomingRequestsList: document.getElementById("incomingRequestsList"),
    emptyIncomingText: document.getElementById("emptyIncomingText"),
    outgoingRequestsList: document.getElementById("outgoingRequestsList"),
    emptyOutgoingText: document.getElementById("emptyOutgoingText"),
    // FAB & Add Friend Modal
    btnOpenAddFriend: document.getElementById("btnOpenAddFriend"),
    addFriendBackdrop: document.getElementById("addFriendBackdrop"),
    addFriendSheet: document.getElementById("addFriendSheet"),
    btnCloseAddFriend: document.getElementById("btnCloseAddFriend"),
    addFriendInput: document.getElementById("addFriendInput"),
    btnAddFriend: document.getElementById("btnAddFriend"),
    // Chat Elements
    chatViewOverlay: document.getElementById("chatViewOverlay"),
    btnChatBack: document.getElementById("btnChatBack"),
    chatContactAvatar: document.getElementById("chatContactAvatar"),
    chatContactName: document.getElementById("chatContactName"),
    chatContactStatus: document.getElementById("chatContactStatus"),
    btnChatCall: document.getElementById("btnChatCall"),
    btnChatMenu: document.getElementById("btnChatMenu"),
    chatKebabDropdown: document.getElementById("chatKebabDropdown"),
    btnChatDelete: document.getElementById("btnChatDelete"),
    chatMessagesContainer: document.getElementById("chatMessagesContainer"),
    chatInputForm: document.getElementById("chatInputForm"),
    chatTextInput: document.getElementById("chatTextInput"),
    // Calling Elements
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

  function getAvatarColorClass(str) {
    if (!str) return "avatar-color-0";
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = (hash + str.charCodeAt(i)) % 5;
    return `avatar-color-${hash}`;
  }

  // Update clock
  function updateClock() {
    if (!dom.statusBarClock) return;
    const now = new Date();
    dom.statusBarClock.textContent = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  }
  setInterval(updateClock, 10000);
  updateClock();

  function authHeaders(headers = {}) {
    return { ...headers, Authorization: `Bearer ${userToken}`, "Content-Type": "application/json" };
  }

  // --- Auth Tabs & Handlers ---
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

  // --- Telegram Drawer Management ---
  function openDrawer() {
    dom.drawerBackdrop.classList.remove("hidden");
    dom.tgDrawer.classList.remove("hidden");
  }

  function closeDrawer() {
    dom.drawerBackdrop.classList.add("hidden");
    dom.tgDrawer.classList.add("hidden");
  }

  dom.btnOpenDrawer.addEventListener("click", openDrawer);
  dom.drawerBackdrop.addEventListener("click", closeDrawer);

  dom.drawerBtnLogout.addEventListener("click", async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST", headers: authHeaders() });
    } catch (_e) {}
    localStorage.removeItem("calltranslate_usr_token");
    location.reload();
  });

  dom.drawerBtnLang.addEventListener("click", async () => {
    if (!currentUser) return;
    const newLang = currentUser.language === "ar" ? "en" : "ar";
    try {
      await fetch("/api/user/language", {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({ language: newLang }),
      });
      currentUser.language = newLang;
      updateUserLangUI();
    } catch (_e) {}
  });

  function updateUserLangUI() {
    const isAr = currentUser.language === "ar";
    dom.currentUserLangBadge.textContent = isAr ? "AR" : "EN";
    dom.drawerLangText.textContent = isAr ? "العربية (AR)" : "English (EN)";
  }

  // --- Segment Tabs Navigation (Chats vs Requests) ---
  dom.tabChats.addEventListener("click", () => {
    dom.tabChats.classList.add("active");
    dom.tabRequests.classList.remove("active");
    dom.viewChatsFeed.classList.remove("hidden");
    dom.viewRequestsFeed.classList.add("hidden");
  });

  dom.tabRequests.addEventListener("click", () => {
    dom.tabRequests.classList.add("active");
    dom.tabChats.classList.remove("active");
    dom.viewRequestsFeed.classList.remove("hidden");
    dom.viewChatsFeed.classList.add("hidden");
    loadFriendRequests();
  });

  // --- Add Friend Bottom Sheet Modal ---
  function openAddFriendModal() {
    dom.addFriendBackdrop.classList.remove("hidden");
    dom.addFriendSheet.classList.remove("hidden");
    setTimeout(() => dom.addFriendInput.focus(), 150);
  }

  function closeAddFriendModal() {
    dom.addFriendBackdrop.classList.add("hidden");
    dom.addFriendSheet.classList.add("hidden");
  }

  dom.btnOpenAddFriend.addEventListener("click", openAddFriendModal);
  dom.btnCloseAddFriend.addEventListener("click", closeAddFriendModal);
  dom.addFriendBackdrop.addEventListener("click", closeAddFriendModal);

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

    // Header Tag
    dom.currentUserHandle.textContent = `@${currentUser.username}`;
    updateUserLangUI();

    // Drawer info
    dom.drawerUserName.textContent = currentUser.display_name || currentUser.username;
    dom.drawerUserHandle.textContent = `@${currentUser.username}`;
    dom.drawerUserAvatar.textContent = (currentUser.display_name || currentUser.username).charAt(0).toUpperCase();
    dom.drawerUserAvatar.className = `tg-avatar ${getAvatarColorClass(currentUser.username)}`;

    connectUserHub();
    await loadContacts();
    await loadFriendRequests();
  }

  // --- WebSocket Connection ---
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
        <div class="tg-empty-feed">
          <div class="tg-empty-icon">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
          </div>
          <h4 style="color:#fff; margin-bottom:6px;">لا توجد محادثات بعد</h4>
          <p style="font-size:0.88rem;">اضغط على زر الإضافة الدائري بالأسفل لإرسال طلب صداقة والبدء بالحديث والاتصال المترجم!</p>
        </div>
      `;
      if (dom.chatsUnreadCountBadge) dom.chatsUnreadCountBadge.classList.add("hidden");
      return;
    }

    const totalUnread = contacts.reduce((sum, c) => sum + (c.unread_count || 0), 0);
    if (dom.chatsUnreadCountBadge) {
      if (totalUnread > 0) {
        dom.chatsUnreadCountBadge.textContent = totalUnread;
        dom.chatsUnreadCountBadge.classList.remove("hidden");
      } else {
        dom.chatsUnreadCountBadge.classList.add("hidden");
      }
    }

    contacts.forEach((c) => {
      const row = document.createElement("div");
      row.className = "tg-chat-row";
      const colorCls = getAvatarColorClass(c.username);
      const initial = (c.display_name || c.username).charAt(0).toUpperCase();

      let timeText = "";
      if (c.last_message_time) {
        const msgDate = new Date(c.last_message_time * 1000);
        timeText = msgDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      } else if (c.is_online) {
        timeText = "متصل";
      }

      const snippet = c.last_message ? escapeHtml(c.last_message) : `@${c.username}`;
      const unreadBadgeHtml = c.unread_count > 0 ? `<span class="tg-unread-badge">${c.unread_count}</span>` : "";

      row.innerHTML = `
        <div class="tg-avatar-wrap">
          <div class="tg-avatar ${colorCls}">${initial}</div>
          <span class="tg-online-badge ${c.is_online ? "online" : ""}"></span>
        </div>
        <div class="tg-chat-content">
          <div class="tg-chat-header-row">
            <span class="tg-chat-name">${c.display_name}</span>
            <div class="tg-chat-meta-side">
              <span class="tg-chat-time" style="color:${c.is_online ? 'var(--tg-blue)' : 'var(--tg-text-secondary)'}; font-weight:${c.is_online ? '600' : 'normal'};">
                ${timeText}
              </span>
              ${unreadBadgeHtml}
            </div>
          </div>
          <div class="tg-chat-preview-row">
            <span class="tg-chat-snippet">${snippet}</span>
            <span class="tg-lang-chip">${c.language.toUpperCase()}</span>
          </div>
        </div>
        <div class="tg-divider"></div>
      `;

      row.addEventListener("click", () => openChat(c));
      dom.contactsContainer.appendChild(row);
    });
  }

  // --- Add Friend API ---
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
      alert(data.message || "تم إرسال طلب الصداقة بنجاح!");
      dom.addFriendInput.value = "";
      closeAddFriendModal();
      await loadContacts();
      await loadFriendRequests();
    } catch (err) {
      alert(err.message);
    }
  });

  // --- Friend Requests API & Rendering ---
  async function loadFriendRequests() {
    try {
      const res = await fetch("/api/friend-requests", { headers: authHeaders() });
      if (!res.ok) return;
      const data = await res.json();
      const incoming = data.incoming || [];
      const outgoing = data.outgoing || [];

      // Update badge
      if (incoming.length > 0) {
        dom.requestsCountBadge.textContent = incoming.length;
        dom.requestsCountBadge.classList.remove("hidden");
      } else {
        dom.requestsCountBadge.classList.add("hidden");
      }

      // Render Incoming
      dom.incomingRequestsList.innerHTML = "";
      if (incoming.length === 0) {
        dom.emptyIncomingText.classList.remove("hidden");
      } else {
        dom.emptyIncomingText.classList.add("hidden");
        incoming.forEach((req) => {
          const card = document.createElement("div");
          card.className = "tg-request-card";
          const colorCls = getAvatarColorClass(req.username);
          const initial = (req.display_name || req.username).charAt(0).toUpperCase();

          card.innerHTML = `
            <div class="tg-request-user">
              <div class="tg-avatar ${colorCls}" style="width:42px;height:42px;font-size:1.1rem;">${initial}</div>
              <div>
                <strong style="color:#fff; font-size:0.92rem; display:block;">${req.display_name}</strong>
                <span style="color:var(--tg-text-secondary); font-size:0.78rem;" dir="ltr">@${req.username}</span>
              </div>
            </div>
            <div class="tg-request-actions">
              <button class="btn-tg-action btn-accept-req btn-acc" data-id="${req.request_id}">قبول</button>
              <button class="btn-tg-action btn-reject-req btn-rej" data-id="${req.request_id}">رفض</button>
            </div>
          `;

          card.querySelector(".btn-acc").addEventListener("click", async () => {
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

          card.querySelector(".btn-rej").addEventListener("click", async () => {
            try {
              const r = await fetch(`/api/friend-requests/${req.request_id}/reject`, {
                method: "POST",
                headers: authHeaders(),
              });
              if (r.ok) await loadFriendRequests();
            } catch (_e) {}
          });

          dom.incomingRequestsList.appendChild(card);
        });
      }

      // Render Outgoing (Pending)
      dom.outgoingRequestsList.innerHTML = "";
      if (outgoing.length === 0) {
        dom.emptyOutgoingText.classList.remove("hidden");
      } else {
        dom.emptyOutgoingText.classList.add("hidden");
        outgoing.forEach((req) => {
          const card = document.createElement("div");
          card.className = "tg-request-card";
          const colorCls = getAvatarColorClass(req.username);
          const initial = (req.display_name || req.username).charAt(0).toUpperCase();

          card.innerHTML = `
            <div class="tg-request-user">
              <div class="tg-avatar ${colorCls}" style="width:42px;height:42px;font-size:1.1rem;">${initial}</div>
              <div>
                <strong style="color:#fff; font-size:0.92rem; display:block;">${req.display_name}</strong>
                <span style="color:var(--tg-orange); font-size:0.78rem;">بانتظار الموافقة • <span dir="ltr">@${req.username}</span></span>
              </div>
            </div>
            <div class="tg-request-actions">
              <button class="btn-tg-action btn-cancel-req btn-can" data-id="${req.request_id}">إلغاء الطلب</button>
            </div>
          `;

          card.querySelector(".btn-can").addEventListener("click", async () => {
            try {
              const r = await fetch(`/api/friend-requests/${req.request_id}/cancel`, {
                method: "POST",
                headers: authHeaders(),
              });
              if (r.ok) await loadFriendRequests();
            } catch (_e) {}
          });

          dom.outgoingRequestsList.appendChild(card);
        });
      }
    } catch (_e) {}
  }

  // --- Telegram Chat Screen ---
  async function openChat(contact) {
    activeChatContact = contact;
    dom.chatContactName.textContent = contact.display_name;
    const colorCls = getAvatarColorClass(contact.username);
    dom.chatContactAvatar.className = `tg-avatar ${colorCls}`;
    dom.chatContactAvatar.textContent = (contact.display_name || contact.username).charAt(0).toUpperCase();

    dom.chatContactStatus.textContent = contact.is_online ? "متصل الآن" : "آخر ظهور مؤخراً";
    dom.chatContactStatus.className = contact.is_online ? "" : "offline";

    dom.chatKebabDropdown.classList.add("hidden");
    dom.chatViewOverlay.classList.remove("hidden");

    if (contact.unread_count > 0) {
      contact.unread_count = 0;
      void fetch(`/api/messages/${contact.username}/read`, {
        method: "POST",
        headers: authHeaders(),
      }).catch(() => {});
      loadContacts();
    }

    await loadChatMessages(contact.username);
  }

  function closeChat() {
    activeChatContact = null;
    dom.chatKebabDropdown.classList.add("hidden");
    dom.chatViewOverlay.classList.add("hidden");
  }

  dom.btnChatBack.addEventListener("click", closeChat);

  // Kebab menu dropdown toggle
  dom.btnChatMenu.addEventListener("click", (e) => {
    e.stopPropagation();
    dom.chatKebabDropdown.classList.toggle("hidden");
  });

  document.addEventListener("click", () => {
    if (!dom.chatKebabDropdown.classList.contains("hidden")) {
      dom.chatKebabDropdown.classList.add("hidden");
    }
  });

  // Delete contact inside chat
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

  // Green Call button in chat appbar
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
    bubble.className = `tg-bubble ${isOut ? "out" : "in"}`;

    const timeStr = msg.created_at
      ? new Date(msg.created_at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "";

    // Show translated text directly for incoming message, or original for sender
    const displayText = (!isOut && msg.translated_text) ? msg.translated_text : msg.original_text;
    const isTranslated = !isOut && msg.translated_text && msg.translated_text.trim().toLowerCase() !== msg.original_text.trim().toLowerCase();
    const tooltipAttr = isTranslated ? `title="النص الأصلي: ${escapeHtml(msg.original_text)}"` : "";

    bubble.innerHTML = `
      <div class="tg-bubble-text" ${tooltipAttr}>${escapeHtml(displayText)}</div>
      <div class="tg-bubble-footer">
        <span>${timeStr}</span>
        ${isOut ? '<span style="color:#79b8ff;">✓✓</span>' : ''}
      </div>
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
      void fetch(`/api/messages/${activeChatContact.username}/read`, {
        method: "POST",
        headers: authHeaders(),
      }).catch(() => {});
    } else {
      loadContacts();
      playNotificationSound();
    }
  }

  function playNotificationSound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      gain.gain.setValueAtTime(0.12, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.15);
    } catch (_e) {}
  }

  // --- Calling Flow & WebRTC Engine ---
  function initiateCall(target) {
    if (!hubSocket || hubSocket.readyState !== WebSocket.OPEN) {
      alert("غير متصل بالسيرفر");
      return;
    }
    unlockAudioGraph();

    dom.callTargetName.textContent = target.display_name;
    const colorCls = getAvatarColorClass(target.username);
    dom.callOverlayAvatar.className = `tg-call-big-avatar ${colorCls}`;
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
    const colorCls = getAvatarColorClass(msg.caller);
    dom.incomingAvatar.className = `tg-call-big-avatar ${colorCls}`;
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
    const colorCls = getAvatarColorClass(callData.caller);
    dom.callOverlayAvatar.className = `tg-call-big-avatar ${colorCls}`;
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

      // Ensure "ice-candidate" type expected by server
      rtcPeer.onicecandidate = (e) => {
        if (e.candidate && rtcSocket && rtcSocket.readyState === WebSocket.OPEN) {
          rtcSocket.send(JSON.stringify({
            type: "ice-candidate",
            candidate: e.candidate.toJSON(),
          }));
        }
      };

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

      rtcSocket.onopen = async () => {};

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
    dom.btnCallMute.classList.toggle("active-mute", !currentlyEnabled);
  });

  checkSession();
})();
