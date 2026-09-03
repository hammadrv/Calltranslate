(() => {
  const token = localStorage.getItem("calltranslate_usr_token");
  if (!token) {
    location.href = "/app";
    return;
  }

  const dom = {
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
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
  }

  async function loadUsers() {
    try {
      const res = await fetch("/api/admin/users", { headers: authHeaders() });
      if (res.status === 401 || res.status === 403) {
        alert("يجب تسجيل الدخول كمسؤول (Admin)");
        location.href = "/app";
        return;
      }
      const data = await res.json();
      availableModels = data.available_models || [];
      dom.statTotalUsers.textContent = data.users.length;
      dom.statOnlineUsers.textContent = data.users.filter((u) => u.is_online).length;
      dom.statDefaultModel.textContent = data.default_model;

      renderTable(data.users);
    } catch (err) {
      alert("خطأ أثناء جلب البيانات: " + err.message);
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
          <strong>${u.display_name}</strong> ${u.is_admin ? '<span class="lang-badge" style="background:#5288c1;color:#fff;">ADMIN</span>' : ''}<br>
          <small style="color:var(--text-secondary);">@${u.username}</small>
        </td>
        <td><span class="lang-badge">${u.language.toUpperCase()}</span></td>
        <td>
          <span style="display:inline-flex;align-items:center;gap:6px;">
            <span class="online-dot ${u.is_online ? "online" : ""}" style="position:static;display:inline-block;"></span>
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

    // Event listeners
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
    localStorage.removeItem("calltranslate_usr_token");
    location.href = "/app";
  });

  loadUsers();
})();
