(() => {
  const id = window.__PROCESSING_MEETING_ID__;
  const errorEl = document.getElementById('processingError');
  const retryBtn = document.getElementById('retryBtn');
  const loader = document.getElementById('processingLoader');
  const message = document.getElementById('processingMessage');
  const titleEl = document.getElementById('meetingTitle');
  let timer = null;
  let attempts = 0;
  let finished = false;

  const step = (name) => document.querySelector(`[data-step="${name}"]`);
  function setStep(name, state, done = false) {
    const el = step(name); if (!el) return;
    el.classList.toggle('active', !done);
    el.classList.toggle('done', done);
    const stateEl = el.querySelector('.step-state');
    if (stateEl) stateEl.textContent = done ? '✓' : state;
  }

  function showError(text) {
    errorEl.hidden = false;
    errorEl.textContent = text;
    retryBtn.hidden = false;
    loader.style.display = 'none';
  }

  async function check() {
    if (!id || finished) return;
    attempts += 1;
    try {
      const res = await fetch(`/api/meetings/${encodeURIComponent(id)}`, { credentials: 'same-origin', cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        const meeting = data.meeting || data;
        if (meeting) {
          finished = true;
          clearInterval(timer);
          titleEl.textContent = meeting.ai?.generatedTitle || meeting.title || 'Your meeting';
          setStep('recording', 'Done', true);
          setStep('transcript', 'Done', true);
          setStep('analysis', 'Done', true);
          setStep('ready', 'Done', true);
          message.textContent = meeting.ai?.summary ? 'Your transcript and AI meeting summary are ready.' : 'Your meeting was saved. Opening the meeting details now.';
          setTimeout(() => { window.location.replace(`/meetings/${encodeURIComponent(id)}`); }, 700);
          return;
        }
      }
      if (attempts === 2) {
        setStep('transcript', 'Saving…');
        message.textContent = 'Saving the final transcript…';
      }
      if (attempts === 5) {
        setStep('analysis', 'Generating…');
        message.textContent = 'Generating your AI meeting summary…';
      }
      if (attempts > 80) showError('The meeting is taking longer than expected. You can retry this check.');
    } catch (err) {
      if (attempts > 8) showError('Could not check meeting status. Make sure the server is running, then retry.');
    }
  }

  retryBtn.addEventListener('click', () => {
    errorEl.hidden = true; retryBtn.hidden = true; loader.style.display = 'flex'; attempts = 0; check();
  });
  check();
  timer = setInterval(check, 1500);
})();
