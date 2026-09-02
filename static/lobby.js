"use strict";

const createRoomForm = document.getElementById("createRoomForm");
const createButton = document.getElementById("createRoomButton");
const newRoomButton = document.getElementById("newRoomButton");
const adminTokenInput = document.getElementById("adminToken");
const linksPanel = document.getElementById("linksPanel");
const lobbyMessage = document.getElementById("lobbyMessage");
const arabicLink = document.getElementById("arabicLink");
const englishLink = document.getElementById("englishLink");
const expiryBadge = document.getElementById("expiryBadge");

async function createRoom() {
  const adminToken = adminTokenInput.value.trim();
  if (!adminToken) {
    adminTokenInput.setAttribute("aria-invalid", "true");
    adminTokenInput.focus();
    lobbyMessage.classList.add("error");
    lobbyMessage.textContent = "أدخل رمز إدارة الغرف أولاً.";
    return;
  }

  adminTokenInput.removeAttribute("aria-invalid");
  createButton.disabled = true;
  newRoomButton.disabled = true;
  adminTokenInput.disabled = true;
  lobbyMessage.classList.remove("error");
  lobbyMessage.textContent = "جارٍ تجهيز رابطَي الغرفة…";

  try {
    const response = await fetch("/api/rooms", {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: "Bearer " + adminToken,
      },
      cache: "no-store",
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        adminTokenInput.setAttribute("aria-invalid", "true");
        throw new Error("رمز إدارة الغرف غير صحيح.");
      }
      throw new Error("تعذّر إنشاء الغرفة");
    }

    const room = await response.json();
    if (
      !room.links ||
      typeof room.links.ar !== "string" ||
      typeof room.links.en !== "string" ||
      typeof room.expires_at !== "number"
    ) {
      throw new Error("وصل رد غير صالح من السيرفر.");
    }

    arabicLink.value = room.links.ar;
    englishLink.value = room.links.en;

    const expiresAt = new Date(room.expires_at * 1000);
    expiryBadge.textContent =
      "صالحة حتى " +
      new Intl.DateTimeFormat("ar-JO", {
        hour: "numeric",
        minute: "2-digit",
      }).format(expiresAt);

    linksPanel.classList.remove("hidden");
    lobbyMessage.textContent = "تم إنشاء الغرفة بنجاح.";
    linksPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    linksPanel.focus({ preventScroll: true });
  } catch (error) {
    lobbyMessage.classList.add("error");
    lobbyMessage.textContent =
      error instanceof Error ? error.message : "حدث خطأ غير متوقع";
    if (adminTokenInput.hasAttribute("aria-invalid")) {
      adminTokenInput.focus();
    }
  } finally {
    createButton.disabled = false;
    newRoomButton.disabled = false;
    adminTokenInput.disabled = false;
  }
}

async function copyLink(button) {
  const targetId = button.dataset.copyTarget;
  const input = document.getElementById(targetId);
  if (!input || !input.value) {
    return;
  }

  let copied = false;
  try {
    await navigator.clipboard.writeText(input.value);
    copied = true;
  } catch (_error) {
    input.focus();
    input.select();
    copied = document.execCommand("copy");
  }

  if (!copied) {
    lobbyMessage.classList.add("error");
    lobbyMessage.textContent = "تعذّر نسخ الرابط. حدّده وانسخه يدوياً.";
    return;
  }

  lobbyMessage.classList.remove("error");
  lobbyMessage.textContent =
    targetId === "arabicLink"
      ? "تم نسخ رابط الطرف العربي."
      : "تم نسخ رابط الطرف الإنجليزي.";
  const originalText = button.textContent;
  button.textContent = targetId === "arabicLink" ? "تم النسخ" : "Copied";
  window.setTimeout(() => {
    button.textContent = originalText;
  }, 1500);
}

createRoomForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void createRoom();
});
newRoomButton.addEventListener("click", createRoom);
document.querySelectorAll("[data-copy-target]").forEach((button) => {
  button.addEventListener("click", () => copyLink(button));
});
