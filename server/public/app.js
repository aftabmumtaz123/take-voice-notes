
// Tabs
document.querySelectorAll("[data-tabs]").forEach((tabs) => {
  tabs.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const name = tab.dataset.tab;
      tabs.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
      document.querySelectorAll("[data-panel]").forEach((panel) => {
        panel.classList.toggle("active", panel.dataset.panel === name);
      });
    });
  });
});

// Copy API key
document.getElementById("copyKey")?.addEventListener("click", async () => {
  const el = document.getElementById("apiKey");
  if (!el) return;
  try {
    await navigator.clipboard.writeText(el.textContent.trim());
    const btn = document.getElementById("copyKey");
    const prev = btn.textContent;
    btn.textContent = "Copied";
    setTimeout(() => (btn.textContent = prev), 1200);
  } catch {}
});

// Transcript search
document.getElementById("transcriptSearch")?.addEventListener("input", (e) => {
  const q = e.target.value.toLowerCase();
  const body = document.getElementById("transcriptBody");
  if (!body) return;
  // simple highlight via opacity not needed; just filter isn't practical for pre
  body.style.background = q ? "#fffbeb" : "";
});

// AI Chat
const chatForm = document.getElementById("chatForm");
if (chatForm) {
  chatForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("chatInput");
    const history = document.getElementById("chatHistory");
    const q = (input.value || "").trim();
    if (!q) return;
    input.value = "";
    history.insertAdjacentHTML("beforeend", `<div class="bubble user"></div>`);
    history.lastElementChild.textContent = q;
    history.insertAdjacentHTML("beforeend", `<div class="bubble ai">Thinking…</div>`);
    const pending = history.lastElementChild;
    try {
      const res = await fetch(`/api/meetings/${encodeURIComponent(chatForm.dataset.meetingId)}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.error || "Chat failed");
      pending.textContent = data.answer || "No answer.";
    } catch (err) {
      pending.textContent = err.message || String(err);
    }
    history.scrollTop = history.scrollHeight;
  });
}
