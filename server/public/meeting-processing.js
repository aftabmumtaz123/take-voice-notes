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

  const el = (name) => document.querySelector(`[data-step="${name}"]`);
  function setStep(name, state, done = false) {
    const node = el(name); if (!node) return;
    node.classList.toggle('active', !done);
    node.classList.toggle('done', done);
    const stateEl = node.querySelector('.step-state');
    if (stateEl) stateEl.textContent = done ? '✓' : state;
  }
  function resetSteps() {
    setStep('recording', 'Done', true);
    ['transcript','analysis','ready'].forEach(name => {
      const node = el(name); node?.classList.remove('active','done');
      const state = node?.querySelector('.step-state'); if (state) state.textContent = 'Waiting';
    });
  }
  function showError(text) {
    errorEl.hidden = false; errorEl.textContent = text;
    retryBtn.hidden = false; loader.style.display = 'none';
  }
  function stageUpdate(stage, status, msg) {
    if (msg) message.textContent = msg;
    if (stage === 'transcript') {
      setStep('transcript', 'Received', true);
      setStep('analysis', 'Processing…', false);
    } else if (stage === 'analysis') {
      setStep('transcript', 'Received', true);
      setStep('analysis', 'In progress', false);
    } else if (stage === 'ready' || status === 'completed') {
      setStep('transcript', 'Received', true);
      setStep('analysis', 'Processed', true);
      setStep('ready', 'Ready', true);
    }
  }

  async function check() {
    if (!id || finished) return;
    attempts += 1;
    try {
      const res = await fetch(`/api/meetings/${encodeURIComponent(id)}/status`, { credentials:'same-origin', cache:'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.error || 'Unable to check meeting status.');

      stageUpdate(data.stage, data.status, data.message);
      if (data.status === 'completed' && data.meeting) {
        finished = true; clearInterval(timer);
        titleEl.textContent = data.meeting.ai?.generatedTitle || data.meeting.title || 'Your meeting';
        message.textContent = 'Meeting processed successfully. Opening your meeting with Ask AI…';
        setStep('transcript', 'Received', true);
        setStep('analysis', 'Processed', true);
        setStep('ready', 'Ready', true);
        setTimeout(() => {
          window.location.replace(`/meetings/${encodeURIComponent(id)}?tab=chat`);
        }, 800);
        return;
      }
      if (attempts > 120) showError('The meeting is taking longer than expected. You can check again.');
    } catch (err) {
      if (attempts > 8) showError(err.message || 'Could not check meeting status.');
    }
  }

  retryBtn.addEventListener('click', () => {
    errorEl.hidden = true; retryBtn.hidden = true; loader.style.display = 'flex'; attempts = 0; resetSteps(); check();
  });
  check();
  timer = setInterval(check, 1000);
})();
