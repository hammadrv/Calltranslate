(() => {
  let adminToken = localStorage.getItem("calltranslate_admin_token") || "";

  const dom = {
    adminLoginOverlay: document.getElementById("adminLoginOverlay"),
    adminDashboardView: document.getElementById("adminDashboardView"),
    adminLoginForm: document.getElementById("adminLoginForm"),
    adminUsername: document.getElementById("adminUsername"),
    adminPassword: document.getElementById("adminPassword"),
    adminLoginError: document.getElementById("adminLoginError"),
    usersTableBody: document.getElementById("usersTableBody"),
    statTotalUsers: document.getElementById("statTotalUsers"),
    statOnlineUsers: document.getElementById("statOnlineUsers"),
    statDefaultModel: document.getElementById("statDefaultModel"),
    adminLogout: document.getElementById("adminLogout"),
    toast: document.getElementById("toast"),
  };

  let availableModels = [];

  function showToast(msg) {
    dom.toast.textContent = msg;
    dom.toast.classList.remove("hidden");
    setTimeout(() => dom.toast.classList.add("hidden"), 3000);
  }

  function authHeaders() {
    return {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
    };
  }

  dom.adminLoginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    dom.adminLoginError.classList.add("hidden");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: dom.adminUsername.value.trim(),
          password: dom.adminPassword.value,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Login failed");
      if (!data.user?.is_admin) throw new Error("هذا الحساب ليس له صلاحيات مسؤول");
      adminToken = data.token;
      localStorage.setItem("calltranslate_admin_token", adminToken);
      dom.adminLoginOverlay.classList.add("hidden");
      dom.adminDashboardView.classList.remove("hidden");
      await loadUsers();
    } catch (err) {
      dom.adminLoginError.textContent = err.message;
      dom.adminLoginError.classList.remove("hidden");
    }
  });

  async function checkAdminSession() {
    if (!adminToken) {
      dom.adminLoginOverlay.classList.remove("hidden");
      dom.adminDashboardView.classList.add("hidden");
      return;
    }
    try {
      const res = await fetch("/api/auth/me", { headers: authHeaders() });
      if (!res.ok) throw new Error("Invalid session");
      const data = await res.json();
      if (!data.user?.is_admin) throw new Error("Not an admin");
      dom.adminLoginOverlay.classList.add("hidden");
      dom.adminDashboardView.classList.remove("hidden");
      await loadUsers();
    } catch (_e) {
      localStorage.removeItem("calltranslate_admin_token");
      dom.adminLoginOverlay.classList.remove("hidden");
      dom.adminDashboardView.classList.add("hidden");
    }
  }

  async function loadUsers() {
    try {
      const res = await fetch("/api/admin/users", { headers: authHeaders() });
      if (res.status === 401 || res.status === 403) {
        dom.adminLoginOverlay.classList.remove("hidden");
        dom.adminDashboardView.classList.add("hidden");
        return;
      }
      const data = await res.json();
      availableModels = data.available_models || [];
      dom.statTotalUsers.textContent = data.users.length;
      dom.statOnlineUsers.textContent = data.users.filter((u) => u.is_online).length;
      dom.statDefaultModel.textContent = data.default_model;

      renderTable(data.users);
    } catch (err) {
      showToast("خطأ أثناء جلب البيانات: " + err.message);
    }
  }

  function renderTable(users) {
    dom.usersTableBody.innerHTML = "";
    users.forEach((u) => {
      const tr = document.createElement("tr");

      const optionsHtml = availableModels
        .map(
          (m) =>
            `<option value="${m.id}" ${u.assigned_model === m.id ? "selected" : ""}>${m.name}</option>`
        )
        .join("");

      tr.innerHTML = `
        <td>
          <strong style="color:#fff;">${u.display_name}</strong> ${u.is_admin ? '<span class="lang-pill" style="background:#5288c1;color:#fff;margin-right:6px;">ADMIN</span>' : ''}<br>
          <small style="color:var(--tg-text-secondary);direction:ltr;display:inline-block;">@${u.username}</small>
        </td>
        <td><span class="lang-pill">${u.language.toUpperCase()}</span></td>
        <td>
          <span style="display:inline-flex;align-items:center;gap:6px;">
            <span class="dot-online ${u.is_online ? "online" : ""}" style="position:static;display:inline-block;"></span>
            ${u.is_online ? "متصل" : "غير متصل"}
          </span>
        </td>
        <td>
          <select class="model-select" data-user-id="${u.id}">
            ${optionsHtml}
          </select>
        </td>
        <td>
          <div class="action-btns">
            <button class="btn-sm btn-secondary btn-pwd" data-user-id="${u.id}" data-username="${u.username}">تغيير كلمة المرور</button>
            ${u.is_admin ? "" : `<button class="btn-sm btn-danger btn-del" data-user-id="${u.id}" data-username="${u.username}">حذف</button>`}
          </div>
        </td>
      `;

      dom.usersTableBody.appendChild(tr);
    });

    document.querySelectorAll(".model-select").forEach((sel) => {
      sel.addEventListener("change", async (e) => {
        const userId = e.target.dataset.userId;
        const newModel = e.target.value;
        try {
          const res = await fetch(`/api/admin/users/${userId}/model`, {
            method: "PUT",
            headers: authHeaders(),
            body: JSON.stringify({ model: newModel }),
          });
          if (!res.ok) throw new Error("فشل التحديث");
          showToast("تم تحديث النموذج بنجاح!");
        } catch (err) {
          alert(err.message);
          loadUsers();
        }
      });
    });

    document.querySelectorAll(".btn-pwd").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        const userId = e.target.dataset.userId;
        const username = e.target.dataset.username;
        const newPass = prompt(`أدخل كلمة المرور الجديدة للمستخدم @${username}:`);
        if (!newPass) return;
        if (newPass.length < 6) {
          alert("كلمة المرور يجب أن تكون 6 أحرف على الأقل");
          return;
        }
        try {
          const res = await fetch(`/api/admin/users/${userId}/password`, {
            method: "PUT",
            headers: authHeaders(),
            body: JSON.stringify({ password: newPass }),
          });
          if (!res.ok) throw new Error("فشل تغيير كلمة المرور");
          showToast("تم تغيير كلمة المرور بنجاح!");
        } catch (err) {
          alert(err.message);
        }
      });
    });

    document.querySelectorAll(".btn-del").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        const userId = e.target.dataset.userId;
        const username = e.target.dataset.username;
        if (!confirm(`هل أنت متأكد من حذف المستخدم @${username} نهائياً؟`)) return;
        try {
          const res = await fetch(`/api/admin/users/${userId}`, {
            method: "DELETE",
            headers: authHeaders(),
          });
          if (!res.ok) throw new Error("فشل الحذف");
          showToast("تم حذف المستخدم.");
          loadUsers();
        } catch (err) {
          alert(err.message);
        }
      });
    });
  }

  dom.adminLogout.addEventListener("click", () => {
    localStorage.removeItem("calltranslate_admin_token");
    checkAdminSession();
  });

  checkAdminSession();
})();
