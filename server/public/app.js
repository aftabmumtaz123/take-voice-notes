// Global theme preference fallback — light by default; account page controls can override it.
(() => {
  try {
    const key = "ai-note-appearance-v2";
    const saved = localStorage.getItem(key) || "light";
    const apply = value => {
      const resolved = value === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : value;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.dataset.appearance = value;
    };
    apply(saved);
    const media = matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener?.("change", () => { if ((localStorage.getItem(key) || "light") === "system") apply("system"); });
  } catch (_) {
    document.documentElement.dataset.theme = "light";
    document.documentElement.dataset.appearance = "light";
  }
})();


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

// Processing flow can deep-link directly into Ask AI after a meeting finishes.
(() => {
  const tabName = new URLSearchParams(window.location.search).get("tab");
  if (!tabName) return;
  const target = document.querySelector(`[data-tabs] .tab[data-tab="${CSS.escape(tabName)}"]`);
  if (target) target.click();
})();

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



// Live meeting search: update Meetings / Favourites / Archive results as the
// user types instead of waiting for Enter or a full-page form submission.
(() => {
  const form = document.querySelector('[data-live-meeting-search-form]');
  const input = document.querySelector('[data-live-meeting-search]');
  const results = document.querySelector('[data-live-meeting-results]');
  if (!form || !input || !results) return;

  const viewInput = form.querySelector('input[name="view"]');
  const getView = () => (viewInput?.value || 'all').toLowerCase();
  let timer = null;
  let requestId = 0;

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[char]);

  const formatDate = (value) => {
    if (!value) return 'Earlier';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Earlier';
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const that = new Date(date);
    that.setHours(0, 0, 0, 0);
    const diff = (today - that) / 86400000;
    if (diff < 1) return 'Today';
    if (diff < 2) return 'Yesterday';
    return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  };

  const formatTime = (value) => {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  };

  const renderEmpty = (view, query) => {
    const states = {
      favorites: {
        icon: 'star',
        title: 'No favourite meetings yet',
        text: 'Star the meetings you want to keep close and they will appear here.',
        primary: 'View meetings', primaryHref: '/app/meetings',
        secondary: 'Start a meeting', secondaryHref: '/app/overview'
      },
      archived: {
        icon: 'archive',
        title: 'Your archive is empty',
        text: 'Meetings you archive will be kept here so your main timeline stays focused.',
        primary: 'View meetings', primaryHref: '/app/meetings',
        secondary: 'Start a meeting', secondaryHref: '/app/overview'
      },
      all: query ? {
        icon: 'search_off',
        title: 'No meetings found',
        text: 'Try a different keyword or clear the search to see your meeting history.',
        primary: 'Clear search', primaryHref: '/app/meetings',
        secondary: 'View favourites', secondaryHref: '/app/meetings?view=favorites'
      } : {
        icon: 'video_camera_front',
        title: 'Your meeting workspace is ready',
        text: 'Connect the Chrome extension, record a meeting, then search and summarize your notes.',
        primary: 'Install extension', primaryHref: '/install',
        secondary: 'Get API key', secondaryHref: '/account'
      }
    };
    const state = states[view] || states.all;
    return `<div class="empty-hero card empty-state-illustrated empty-state-${escapeHtml(view)}">
      <div class="empty-icon"><span class="material-symbols-outlined">${escapeHtml(state.icon)}</span></div>
      <h3>${escapeHtml(state.title)}</h3>
      <p>${escapeHtml(state.text)}</p>
      <div class="empty-actions">
        <a class="btn-primary" href="${escapeHtml(state.primaryHref)}">${escapeHtml(state.primary)}</a>
        <a class="btn-ghost" href="${escapeHtml(state.secondaryHref)}">${escapeHtml(state.secondary)}</a>
      </div>
    </div>`;
  };

  const renderMeetings = (meetings, view, query) => {
    if (!meetings.length) {
      results.innerHTML = renderEmpty(view, query);
      return;
    }

    let lastLabel = '';
    const rows = meetings.map((meeting) => {
      const mins = Math.max(1, Math.round((Number(meeting.duration) || 0) / 60));
      const label = formatDate(meeting.startedAt);
      const title = meeting.title || 'Untitled meeting';
      const platform = meeting.platform || 'Manual';
      const externalId = encodeURIComponent(meeting.externalId || '');
      const avatar = escapeHtml((title || platform || 'M').charAt(0).toUpperCase());
      const favoriteMark = meeting.isFavorite ? '<span class="fav-mark">★</span> ' : '';
      const archivedBadge = meeting.isArchived ? '<span class="badge-archived">Archived</span>' : '';
      const aiReady = meeting.ai && meeting.ai.summary ? ' · <span class="ai-ready">✦ AI Summary ready</span>' : '';
      const day = label !== lastLabel ? `<div class="day-label">${escapeHtml(label)}</div>` : '';
      lastLabel = label;
      const redirect = `/app/meetings?view=${encodeURIComponent(view)}${query ? `&q=${encodeURIComponent(query)}` : ''}`;
      return `${day}
        <div class="meeting-row-wrap">
          <a class="meeting-row" href="/meetings/${externalId}">
            <div class="meeting-dur">
              <strong>${mins}m</strong>
              <span>${escapeHtml(formatTime(meeting.startedAt))}</span>
            </div>
            <div class="meeting-avatar">${avatar}</div>
            <div class="meeting-body">
              <strong>${favoriteMark}${escapeHtml(title)} ${archivedBadge}</strong>
              <span class="participants">${escapeHtml(platform)} · ${mins} min${aiReady}</span>
            </div>
          </a>
          <div class="meeting-actions">
            <form method="POST" action="/meetings/${externalId}/favorite">
              <input type="hidden" name="redirect" value="${escapeHtml(redirect)}" />
              <button type="submit" class="icon-btn ${meeting.isFavorite ? 'is-on' : ''}" title="Favourite">${meeting.isFavorite ? '★' : '☆'}</button>
            </form>
            <form method="POST" action="/meetings/${externalId}/archive">
              <input type="hidden" name="redirect" value="${escapeHtml(redirect)}" />
              <button type="submit" class="icon-btn" title="Archive">Archive</button>
            </form>
            <form method="POST" action="/meetings/${externalId}/delete" onsubmit="return confirm('Delete this meeting permanently?');">
              <button type="submit" class="icon-btn danger" title="Delete">🗑</button>
            </form>
          </div>
        </div>`;
    }).join('');

    results.innerHTML = `<div class="meeting-groups">${rows}</div>`;
  };

  const updateUrl = (query, view) => {
    const url = new URL(window.location.href);
    url.searchParams.set('view', view);
    if (query) url.searchParams.set('q', query);
    else url.searchParams.delete('q');
    window.history.replaceState({}, '', url);
  };

  const search = async () => {
    const query = input.value.trim();
    const view = getView();
    const id = ++requestId;
    updateUrl(query, view);
    results.classList.add('is-searching');
    try {
      const params = new URLSearchParams({ view, limit: '100' });
      if (query) params.set('q', query);
      const response = await fetch(`/api/meetings?${params.toString()}`, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      });
      const data = await response.json();
      if (id !== requestId) return;
      if (!response.ok || !data.ok) throw new Error(data.error || 'Search failed.');
      renderMeetings(Array.isArray(data.meetings) ? data.meetings : [], view, query);
    } catch (error) {
      if (id !== requestId) return;
      results.innerHTML = `<div class="flash error">${escapeHtml(error.message || 'Unable to search meetings.')}</div>`;
    } finally {
      if (id === requestId) results.classList.remove('is-searching');
    }
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(search, 120);
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    clearTimeout(timer);
    search();
  });

  // Keep the live search behavior when switching between Timeline,
  // Favourites, and Archive. The link navigation is intentionally replaced
  // with an AJAX request so the current page does not reload.
  document.querySelectorAll('[data-meeting-view-tabs] .view-tab').forEach((tab) => {
    tab.addEventListener('click', (event) => {
      const url = new URL(tab.href, window.location.origin);
      const nextView = url.searchParams.get('view') || 'all';
      const query = input.value.trim();
      event.preventDefault();
      viewInput.value = nextView;
      document.querySelectorAll('[data-meeting-view-tabs] .view-tab').forEach((item) => item.classList.remove('active'));
      tab.classList.add('active');
      updateUrl(query, nextView);
      clearTimeout(timer);
      search();
    });
  });
})();

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
function buildAiCard(markdown, { question = "", promptId = null, isError = false } = {}) {
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
          <button type="button" class="ai-action-btn ai-regen" title="Regenerate" data-q="${escapeHtml(question)}" data-prompt-id="${escapeHtml(promptId || "")}">Regenerate</button>
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

// ─── AI Chat + prompt gallery ────────────────────────────────────────────────
const chatForm = document.getElementById("chatForm");
if (chatForm) {
  const history = document.getElementById("chatHistory");
  const input = document.getElementById("chatInput");
  let lastQuestion = "";
  let lastPromptId = null;

  async function ask({ question = "", promptId = null, label = "" } = {}) {
    const q = (question || label || "").trim();
    if (!promptId && !q) return;
    lastQuestion = q;
    lastPromptId = promptId;
    if (input) input.value = "";

    const displayLabel = label || q;
    history.insertAdjacentHTML("beforeend", buildUserBubble(displayLabel));
    history.insertAdjacentHTML("beforeend", buildThinkingCard());
    const pending = history.lastElementChild;

    // The chat history is part of the normal meeting page flow. Scroll the
    // page itself to the latest item instead of scrolling a nested chat box.
    // This keeps the newly generated answer visible after every Ask AI request.
    const scrollToChatItem = (element, behavior = "smooth") => {
      if (!element) return;

      // Scroll the actual document, not the chat-history element. We do this
      // after layout has settled because AI cards can change height after
      // rendering. Multiple passes make the behavior reliable even when the
      // browser is still painting the newly inserted card.
      const run = () => {
        const rect = element.getBoundingClientRect();
        const target = Math.max(0, rect.top + window.scrollY - 88);
        window.scrollTo({ top: target, behavior });
      };

      requestAnimationFrame(() => {
        run();
        requestAnimationFrame(run);
      });
    };
    scrollToChatItem(pending);

    try {
      const body = promptId ? { promptId, question: q || undefined } : { question: q };
      const res = await fetch(`/api/meetings/${encodeURIComponent(chatForm.dataset.meetingId)}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.error || "Chat failed");
      pending.outerHTML = buildAiCard(data.answer || "No answer.", {
        question: displayLabel,
        promptId: data.promptId || promptId
      });
    } catch (err) {
      pending.outerHTML = buildAiCard(err.message || String(err), {
        question: displayLabel,
        promptId,
        isError: true
      });
    }
    // Scroll the document to the freshly rendered answer, not the nested
    // history container. Run again after the browser has painted the full
    // response so long answers cannot leave the newest card below the fold.
    const latestAnswer = history.lastElementChild;
    scrollToChatItem(latestAnswer);
    setTimeout(() => scrollToChatItem(latestAnswer, "auto"), 180);
    setTimeout(() => scrollToChatItem(latestAnswer, "auto"), 500);
  }

  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    ask({ question: input?.value });
  });



  // Prompt gallery cards — click runs the template immediately
  document.querySelectorAll(".prompt-card").forEach((btn) => {
    btn.addEventListener("click", () => {
      const promptId = btn.getAttribute("data-prompt-id");
      const label = btn.querySelector(".prompt-card-label")?.textContent?.trim() || promptId;
      ask({ promptId, label });
    });
  });

  // Legacy suggestion chips (if any remain)
  document.querySelectorAll(".ask-sugg").forEach((btn) => {
    btn.addEventListener("click", () => {
      const q = btn.getAttribute("data-q") || btn.textContent;
      ask({ question: q });
    });
  });

  // Copy + Regenerate
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
      const pid = regenBtn.getAttribute("data-prompt-id") || lastPromptId;
      if (pid) ask({ promptId: pid, label: q });
      else if (q) ask({ question: q });
    }
  });
}

// Sidebar expand/compact state — initialized on every app page, not only meeting pages.
const sidebar = document.querySelector("[data-sidebar]");
const sidebarToggle = document.querySelector("[data-sidebar-toggle]");
if (sidebar && sidebarToggle) {
  const storageKey = "ai-note-taker-sidebar-collapsed";
  const setSidebarState = (collapsed, persist = true) => {
    document.body.classList.toggle("sidebar-collapsed", collapsed);
    sidebar.classList.toggle("is-collapsed", collapsed);
    sidebarToggle.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
    sidebarToggle.setAttribute("title", collapsed ? "Expand sidebar" : "Collapse sidebar");
    const icon = sidebarToggle.querySelector(".material-symbols-outlined");
    if (icon) icon.textContent = collapsed ? "left_panel_open" : "left_panel_close";
    if (persist) localStorage.setItem(storageKey, collapsed ? "1" : "0");
  };

  const storedState = localStorage.getItem(storageKey);
  const initialCollapsed = storedState === "1" || (storedState === null && window.innerWidth <= 900);
  setSidebarState(initialCollapsed, false);

  sidebarToggle.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setSidebarState(!sidebar.classList.contains("is-collapsed"));
  });

  // Clicking the logo expands a compact sidebar.
  const brand = sidebar.querySelector(".sidebar-brand");
  brand?.addEventListener("click", (event) => {
    if (event.target.closest("[data-sidebar-toggle]")) return;
    if (sidebar.classList.contains("is-collapsed")) setSidebarState(false);
  });
}



// Favourite / archive actions: submit in-place and show a toast instead of
// navigating away from the current meeting list/detail page.
(() => {
  const ensureToast = () => {
    let root = document.getElementById('toast-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'toast-root';
      root.className = 'toast-root';
      root.setAttribute('aria-live', 'polite');
      root.setAttribute('aria-atomic', 'true');
      document.body.appendChild(root);
    }
    return root;
  };

  const showToast = (message, type = 'success') => {
    const root = ensureToast();
    const toast = document.createElement('div');
    toast.className = `app-toast ${type === 'error' ? 'error' : 'success'}`;
    toast.innerHTML = `<span class="material-symbols-outlined">${type === 'error' ? 'error' : 'check_circle'}</span><span>${escapeHtml(message)}</span>`;
    root.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 220);
    }, 2600);
  };

  document.addEventListener('submit', async (event) => {
    const form = event.target.closest('form[action*="/favorite"], form[action*="/archive"]');
    if (!form || form.dataset.toastSubmitting === '1') return;
    event.preventDefault();
    form.dataset.toastSubmitting = '1';

    const button = form.querySelector('button[type="submit"]');
    const original = button?.innerHTML;
    if (button) {
      button.disabled = true;
      button.classList.add('is-loading');
    }

    try {
      const response = await fetch(form.action, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: new FormData(form)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || 'Unable to update the meeting.');

      showToast(data.message || (data.isFavorite ? 'Added to favourites' : data.isArchived ? 'Added to archive' : 'Updated successfully'));

      // On the meetings list, refresh the current view so a meeting moves out
      // of Favourites/Archive immediately when appropriate.
      const liveSearch = document.querySelector('[data-live-meeting-search]');
      const liveForm = document.querySelector('[data-live-meeting-search-form]');
      if (liveSearch && liveForm) {
        liveSearch.dispatchEvent(new Event('input', { bubbles: true }));
      } else if (button) {
        const action = form.action;
        if (action.includes('/favorite')) {
          button.classList.toggle('is-on', Boolean(data.isFavorite));
          button.textContent = data.isFavorite ? '★' : '☆';
          button.title = data.isFavorite ? 'Unfavourite' : 'Favourite';
        } else if (action.includes('/archive')) {
          button.textContent = data.isArchived ? '↩ Unarchive' : 'Archive';
          button.title = data.isArchived ? 'Unarchive' : 'Archive';
        }
      }
    } catch (error) {
      showToast(error.message || 'Unable to update the meeting.', 'error');
      if (button) button.innerHTML = original;
    } finally {
      delete form.dataset.toastSubmitting;
      if (button) {
        button.disabled = false;
        button.classList.remove('is-loading');
      }
    }
  });
})();
