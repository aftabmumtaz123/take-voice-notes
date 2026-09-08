
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
  body.style.background = q ? "#fffbeb" : "";
});

// ─── Lightweight Markdown → HTML (safe, no external deps) ───────────────────
function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderMarkdown(md) {
  if (!md) return "";
  let text = String(md).replace(/\r\n/g, "\n");

  // Extract fenced code blocks first
  const codeBlocks = [];
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const i = codeBlocks.length;
    codeBlocks.push(`<pre class="md-code"><code>${escapeHtml(code.trimEnd())}</code></pre>`);
    return `\n%%CODEBLOCK${i}%%\n`;
  });

  // Inline code
  text = text.replace(/`([^`\n]+)`/g, (_, c) => `<code class="md-inline">${escapeHtml(c)}</code>`);

  // Bold + italic
  text = text.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>");
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  text = text.replace(/__([^_]+)__/g, "<strong>$1</strong>");

  const lines = text.split("\n");
  const out = [];
  let i = 0;

  function flushParagraph(buf) {
    const t = buf.join(" ").trim();
    if (t) out.push(`<p>${t}</p>`);
    buf.length = 0;
  }

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Code block placeholder
    const cbMatch = trimmed.match(/^%%CODEBLOCK(\d+)%%$/);
    if (cbMatch) {
      out.push(codeBlocks[Number(cbMatch[1])]);
      i++;
      continue;
    }

    // Headings
    const h = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level} class="md-h${level}">${h[2]}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      out.push("<hr class='md-hr'>");
      i++;
      continue;
    }

    // Task list / checkbox list
    if (/^[-*]\s+\[[ xX]\]\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length && /^[-*]\s+\[[ xX]\]\s+/.test(lines[i].trim())) {
        const m = lines[i].trim().match(/^[-*]\s+\[([ xX])\]\s+(.+)$/);
        if (m) {
          const checked = m[1].toLowerCase() === "x";
          items.push(
            `<li class="md-task ${checked ? "done" : ""}"><span class="md-check">${checked ? "☑" : "☐"}</span><span class="md-task-text">${m[2]}</span></li>`
          );
        }
        i++;
      }
      out.push(`<ul class="md-task-list">${items.join("")}</ul>`);
      continue;
    }

    // Unordered list
    if (/^[-*•]\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length && /^[-*•]\s+/.test(lines[i].trim())) {
        items.push(`<li>${lines[i].trim().replace(/^[-*•]\s+/, "")}</li>`);
        i++;
      }
      out.push(`<ul class="md-ul">${items.join("")}</ul>`);
      continue;
    }

    // Ordered list
    if (/^\d+[.)]\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) {
        items.push(`<li>${lines[i].trim().replace(/^\d+[.)]\s+/, "")}</li>`);
        i++;
      }
      out.push(`<ol class="md-ol">${items.join("")}</ol>`);
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(trimmed)) {
      const parts = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        parts.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      out.push(`<blockquote class="md-quote">${parts.join(" ")}</blockquote>`);
      continue;
    }

    // Decision-style lines starting with emoji circles (optional visual)
    if (/^[🔵🟢🔴🟡]\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length && /^[🔵🟢🔴🟡]\s+/.test(lines[i].trim())) {
        const m = lines[i].trim().match(/^([🔵🟢🔴🟡])\s+(.+)$/);
        if (m) items.push(`<div class="md-decision"><span class="md-dec-icon">${m[1]}</span><div class="md-dec-body">${m[2]}</div></div>`);
        i++;
      }
      out.push(`<div class="md-decisions">${items.join("")}</div>`);
      continue;
    }

    // Empty line
    if (!trimmed) {
      i++;
      continue;
    }

    // Paragraph (collect consecutive non-empty, non-special lines)
    const buf = [];
    while (i < lines.length) {
      const t = lines[i].trim();
      if (!t) break;
      if (/^(#{1,3})\s+/.test(t)) break;
      if (/^[-*•]\s+/.test(t)) break;
      if (/^\d+[.)]\s+/.test(t)) break;
      if (/^>\s?/.test(t)) break;
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) break;
      if (/^%%CODEBLOCK/.test(t)) break;
      if (/^[🔵🟢🔴🟡]\s+/.test(t)) break;
      buf.push(t);
      i++;
    }
    flushParagraph(buf);
  }

  return out.join("\n");
}

// ─── AI Answer card ──────────────────────────────────────────────────────────
function buildAiCard(markdown, { question = "", isError = false } = {}) {
  const id = "ai-" + Math.random().toString(36).slice(2, 9);
  const bodyHtml = isError
    ? `<p class="ai-error-text">${escapeHtml(markdown)}</p>`
    : renderMarkdown(markdown);

  return `
    <article class="ai-card ${isError ? "ai-card-error" : ""}" data-ai-id="${id}" data-raw="${escapeHtml(markdown)}">
      <header class="ai-card-header">
        <div class="ai-card-title">
          <span class="ai-card-icon">✦</span>
          <span>AI Answer</span>
          <span class="ai-context-badge" title="Answers use only this meeting's transcript and summary">Transcript · AI Summary</span>
        </div>
        <div class="ai-card-actions">
          <button type="button" class="ai-action-btn ai-copy" title="Copy answer">Copy</button>
          <button type="button" class="ai-action-btn ai-regen" title="Regenerate" data-q="${escapeHtml(question)}">Regenerate</button>
        </div>
      </header>
      <div class="ai-card-body md-content">
        ${bodyHtml}
      </div>
    </article>`;
}

function buildUserBubble(text) {
  return `<div class="bubble user">${escapeHtml(text)}</div>`;
}

function buildThinkingCard() {
  return `
    <article class="ai-card ai-thinking">
      <header class="ai-card-header">
        <div class="ai-card-title">
          <span class="ai-card-icon">✦</span>
          <span>AI Answer</span>
        </div>
      </header>
      <div class="ai-card-body">
        <div class="ai-thinking-row">
          <span class="ai-dots"><i></i><i></i><i></i></span>
          <span>Thinking…</span>
        </div>
      </div>
    </article>`;
}

// ─── AI Chat ─────────────────────────────────────────────────────────────────
const chatForm = document.getElementById("chatForm");
if (chatForm) {
  const history = document.getElementById("chatHistory");
  const input = document.getElementById("chatInput");
  let lastQuestion = "";

  async function ask(question) {
    const q = (question || "").trim();
    if (!q) return;
    lastQuestion = q;
    if (input) input.value = "";

    history.insertAdjacentHTML("beforeend", buildUserBubble(q));
    history.insertAdjacentHTML("beforeend", buildThinkingCard());
    const pending = history.lastElementChild;
    history.scrollTop = history.scrollHeight;

    try {
      const res = await fetch(`/api/meetings/${encodeURIComponent(chatForm.dataset.meetingId)}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.error || "Chat failed");
      pending.outerHTML = buildAiCard(data.answer || "No answer.", { question: q });
    } catch (err) {
      pending.outerHTML = buildAiCard(err.message || String(err), { question: q, isError: true });
    }
    history.scrollTop = history.scrollHeight;
  }

  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    ask(input?.value);
  });

  // Suggestion chips
  document.querySelectorAll(".ask-sugg").forEach((btn) => {
    btn.addEventListener("click", () => {
      const q = btn.getAttribute("data-q") || btn.textContent;
      if (input) {
        input.value = q;
        input.focus();
      }
      // Optionally auto-send:
      // ask(q);
    });
  });

  // Copy + Regenerate (event delegation)
  history.addEventListener("click", async (e) => {
    const copyBtn = e.target.closest(".ai-copy");
    if (copyBtn) {
      const card = copyBtn.closest(".ai-card");
      const raw = card?.getAttribute("data-raw") || card?.querySelector(".ai-card-body")?.innerText || "";
      try {
        await navigator.clipboard.writeText(raw);
        copyBtn.textContent = "Copied";
        setTimeout(() => (copyBtn.textContent = "Copy"), 1200);
      } catch {}
      return;
    }
    const regenBtn = e.target.closest(".ai-regen");
    if (regenBtn) {
      const q = regenBtn.getAttribute("data-q") || lastQuestion;
      if (q) ask(q);
    }
  });
}
