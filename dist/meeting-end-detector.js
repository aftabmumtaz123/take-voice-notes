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


  const PARTICIPANT_IGNORE = new Set([
    'you', 'me', 'host', 'co-host', 'presenter', 'participant', 'participants',
    'meeting', 'meeting controls', 'more options', 'options', 'chat', 'mute',
    'unmute', 'camera', 'microphone', 'leave', 'leave meeting', 'end meeting',
    'share screen', 'raise hand', 'captions', 'settings', 'close', 'minimize',
    'maximize', 'recording', 'transcribing', 'connected', 'reconnecting'
  ]);

  function cleanParticipantName(value) {
    let name = String(value || '').replace(/\s+/g, ' ').trim();
    if (!name || name.length < 2 || name.length > 100) return '';
    const normalized = name.toLowerCase().replace(/[•·]/g, '').trim();
    if (PARTICIPANT_IGNORE.has(normalized)) return '';
    if (/^(button|menu|dialog|list|video|audio|tile|participant)\b/i.test(name)) return '';
    if (/^(mute|unmute|remove|pin|spotlight|hide|show|turn|share|stop|start|leave|end|open|close)\b/i.test(name)) return '';
    if (/https?:\/\//i.test(name) || /\b(call|meeting)\s*(controls|options)\b/i.test(name)) return '';
    return name;
  }

  function addCandidate(set, value) {
    const name = cleanParticipantName(value);
    if (!name) return;
    // Avoid collecting long UI sentences as participant names.
    if (name.split(' ').length > 8) return;
    set.add(name);
  }

  function collectParticipantNames() {
    const names = new Set();
    const selectors = [
      // Google Meet participant/video tiles and labels.
      '[data-participant-id]',
      '[data-self-name]',
      '[data-participant-name]',
      '[jsname="participant"]',
      '[jsname="camera"]',
      // Common accessible participant/list labels across Meet/Zoom/Teams.
      '[role="listitem"][aria-label]',
      '[role="listitem"] [aria-label]',
      '[data-tooltip*="participant" i]',
      '[aria-label*="participant" i]'
    ];

    for (const selector of selectors) {
      let nodes = [];
      try { nodes = document.querySelectorAll(selector); } catch (_) { continue; }
      for (const node of nodes) {
        addCandidate(names, node.getAttribute?.('data-self-name'));
        addCandidate(names, node.getAttribute?.('data-participant-name'));
        const aria = node.getAttribute?.('aria-label');
        if (aria) {
          // Prefer the part before common UI suffixes.
          const cleaned = aria
            .replace(/\s*[-–—|].*$/g, '')
            .replace(/\s+(is|has)\s+(muted|unmuted|speaking|presenting).*$/i, '')
            .trim();
          addCandidate(names, cleaned);
        }
        const text = node.textContent;
        if (text && text.length <= 100) addCandidate(names, text);
      }
    }

    // Inspect visible video elements' nearest labelled container.
    try {
      document.querySelectorAll('video').forEach(video => {
        let el = video;
        for (let i = 0; i < 6 && el; i++, el = el.parentElement) {
          addCandidate(names, el.getAttribute?.('aria-label'));
          addCandidate(names, el.getAttribute?.('data-participant-name'));
          addCandidate(names, el.getAttribute?.('data-self-name'));
          if (names.size >= 100) break;
        }
      });
    } catch (_) {}

    return Array.from(names).slice(0, 50);
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
