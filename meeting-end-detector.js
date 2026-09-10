// Detect user actions that end/leave a supported meeting. The extension does
// not inject controls or interfere with the meeting UI; it only observes the
// click and asks the background worker to finish the active transcription.
(() => {
  const SENT_KEY = '__aiNoteTakerMeetingEndSent';
  let sent = false;

  function normalize(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function controlLabels(element) {
    if (!element) return [];
    return [
      element.getAttribute?.('aria-label'),
      element.getAttribute?.('data-tooltip'),
      element.getAttribute?.('data-tooltip-text'),
      element.getAttribute?.('title'),
      element.innerText,
      element.textContent
    ].filter(Boolean).map(normalize).filter(Boolean);
  }

  function isEndControl(element) {
    if (!element || !(element instanceof Element)) return false;
    const node = element.closest('button,[role="button"],[role="menuitem"],a');
    if (!node) return false;

    const labels = controlLabels(node).filter(label => label.length <= 180);
    if (!labels.length) return false;

    // Google Meet: Leave call / End call / End meeting.
    // Zoom: Leave Meeting / End Meeting / End Call.
    // Teams: Leave / Leave meeting / End meeting.
    const exact = new Set([
      'leave',
      'leave call',
      'leave meeting',
      'leave the meeting',
      'leave the call',
      'end',
      'end call',
      'end meeting',
      'end the call',
      'end the meeting',
      'hang up',
      'hangup'
    ]);
    return labels.some(label => exact.has(label) || /^(?:leave|end|hang ?up)(?: (?:call|meeting|the call|the meeting))?(?: for everyone|for all)?$/.test(label));
  }


  // Only accept values that look like real display names. Google Meet exposes
  // many accessibility labels inside participant/video containers; reading
  // textContent from those containers turns UI strings into "participants".
  const PARTICIPANT_IGNORE = new Set([
    'you', 'me', 'host', 'co-host', 'presenter', 'participant', 'participants',
    'meeting', 'meeting controls', 'more options', 'more actions', 'options',
    'chat', 'mute', 'unmute', 'camera', 'microphone', 'leave', 'leave meeting',
    'end meeting', 'share screen', 'raise hand', 'captions', 'settings', 'close',
    'minimize', 'maximize', 'recording', 'transcribing', 'connected',
    'reconnecting', 'devices', 'more_vert'
  ]);

  const PARTICIPANT_UI_WORDS = /\b(?:mute|unmute|microphone|camera|speaker|device|devices|more actions|more options|options|settings|leave|end meeting|hang up|share screen|present|presenting|raise hand|captions|chat|you can't|can't unmute|turn on|turn off|remove|pin|spotlight|hide|show|stop|start)\b/i;

  function cleanParticipantName(value) {
    let name = String(value || '').replace(/\s+/g, ' ').trim();
    if (!name || name.length < 2 || name.length > 80) return '';

    // Meet often annotates the local user with "(You)". Keep the real name.
    name = name.replace(/\s*\((?:you|me)\)\s*$/i, '').trim();
    name = name.replace(/\s*[-–—|]\s*(?:you|me)\s*$/i, '').trim();
    name = name.replace(/^[•·]\s*/, '').trim();

    const normalized = name.toLowerCase();
    if (PARTICIPANT_IGNORE.has(normalized)) return '';
    if (/[a-z][A-Z]/.test(name)) return '';
    if (/\b(?:admit|allow|deny|join|waiting room|notification|notifications)\b/i.test(name)) return '';
    if (/^(?:button|menu|dialog|list|video|audio|tile|participant|tooltip)\b/i.test(name)) return '';
    if (PARTICIPANT_UI_WORDS.test(name)) return '';
    if (/https?:\/\//i.test(name)) return '';
    if (/\b(?:aria-label|data-participant|jsname|role)=/i.test(name)) return '';
    if (/[\n\r\t]/.test(name)) return '';

    // Display names can contain spaces, punctuation and Unicode, but not a
    // sentence full of punctuation. This also rejects accessibility messages.
    const words = name.split(' ').filter(Boolean);
    if (words.length > 6) return '';
    if ((name.match(/[.!?]/g) || []).length > 1) return '';
    if (/[{}<>]/.test(name)) return '';
    return name;
  }

  function addCandidate(set, value) {
    const name = cleanParticipantName(value);
    if (!name) return;
    set.add(name);
  }

  function collectParticipantNames() {
    const names = new Map();
    const add = value => {
      const name = cleanParticipantName(value);
      if (!name) return;
      const key = name.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
      if (!names.has(key)) names.set(key, name);
    };

    // Prefer explicit participant-name attributes. Do NOT use textContent from
    // broad video/list containers: those include Meet controls and messages.
    const explicitSelectors = [
      '[data-self-name]',
      '[data-participant-name]',
      '[data-participant-id][aria-label]',
      '[data-participant-id][data-self-name]',
      '[data-participant-id][data-participant-name]'
    ];

    for (const selector of explicitSelectors) {
      let nodes = [];
      try { nodes = document.querySelectorAll(selector); } catch (_) { continue; }
      for (const node of nodes) {
        add(node.getAttribute?.('data-self-name'));
        add(node.getAttribute?.('data-participant-name'));
      }
    }

    // Accessibility labels are useful only when they are attached directly to
    // participant tiles/list items. Never take arbitrary textContent here.
    const labelledSelectors = [
      '[role="listitem"][aria-label]',
      '[data-participant-id][aria-label]'
    ];
    for (const selector of labelledSelectors) {
      let nodes = [];
      try { nodes = document.querySelectorAll(selector); } catch (_) { continue; }
      for (const node of nodes) {
        const aria = node.getAttribute?.('aria-label') || '';
        // Common Meet format: "Name, video on, microphone off".
        const first = aria.split(/\s*[,|•·]\s*/)[0].trim();
        add(first);
      }
    }

    // Some Meet builds expose a participant name through a direct label node.
    // Read only small, non-control elements with explicit participant markers.
    try {
      document.querySelectorAll('[data-participant-id] [aria-label]').forEach(node => {
        const aria = node.getAttribute?.('aria-label') || '';
        if (/^(?:video|microphone|audio|camera|more|options|button|menu)/i.test(aria)) return;
        add(aria.split(/\s*[,|•·]\s*/)[0]);
      });
    } catch (_) {}

    return Array.from(names.values()).slice(0, 50);
  }

  let participantTimer = null;
  let lastParticipantKey = '';
  let participantScanBusy = false;

  async function publishParticipants() {
    if (participantScanBusy) return;
    participantScanBusy = true;
    try {
      const names = collectParticipantNames();
      const key = names.join('|');
      if (!names.length || key === lastParticipantKey) return;
      lastParticipantKey = key;
      await chrome.runtime.sendMessage({
        target: 'background',
        type: 'MEETING_PARTICIPANTS_UPDATE',
        participants: names.map(name => ({ name }))
      }).catch(() => {});
    } finally {
      participantScanBusy = false;
    }
  }

  function startParticipantTracking() {
    publishParticipants();
    if (participantTimer) clearInterval(participantTimer);
    participantTimer = setInterval(publishParticipants, 2500);
  }

  async function signal(reason) {
    if (sent) return;
    sent = true;
    try {
      await chrome.runtime.sendMessage({
        target: 'background',
        type: 'MEETING_ENDED_BY_USER',
        reason: reason || 'meeting-end-control'
      });
    } catch (_) {
      // The page may be unloading immediately after Leave/End is clicked.
    }
  }

  function handleClick(event) {
    if (sent) return;
    if (isEndControl(event.target)) {
      signal('meeting-end-control');
    }
  }

  // The delegated click listener works even when the meeting client renders
  // its controls dynamically. Background tab-close/navigation fallbacks cover
  // cases where the meeting page disappears without a click event.
  document.addEventListener('click', handleClick, true);
  window.addEventListener('beforeunload', () => {
    // Do not stop merely because the page is refreshing. The background worker
    // also handles tab removal/navigation and verifies the active meeting tab.
  });

  const observer = new MutationObserver(() => {
    clearTimeout(observerTimer);
    observerTimer = setTimeout(scanEndState, 350);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  // Participant names are read from the meeting UI when the platform exposes
  // them. This is metadata collection only; it does not record video.
  startParticipantTracking();

})();
