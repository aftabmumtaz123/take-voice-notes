const allowBtn = document.getElementById('allowBtn');
const closeBtn = document.getElementById('closeBtn');
const status = document.getElementById('status');

async function requestMic() {
  allowBtn.disabled = true;
  allowBtn.textContent = 'Waiting for permission…';
  status.textContent = '';
  status.className = 'status';

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    });
    stream.getTracks().forEach((t) => t.stop());

    status.textContent = '✓ Microphone allowed. You can close this window.';
    status.className = 'status ok';
    allowBtn.textContent = 'Permission granted';

    try {
      chrome.runtime.sendMessage({ target: 'background', type: 'MIC_PERMISSION_GRANTED' });
    } catch (_) {}

    setTimeout(() => window.close(), 1200);
  } catch (err) {
    allowBtn.disabled = false;
    allowBtn.textContent = 'Try again';
    status.className = 'status err';

    if (err.name === 'NotAllowedError') {
      status.textContent =
        'Permission was denied. Click the lock/site icon in the address bar or go to chrome://settings/content/microphone and allow this extension, then try again.';
    } else {
      status.textContent = 'Error: ' + (err.message || err.name);
    }
  }
}

allowBtn.addEventListener('click', requestMic);
closeBtn.addEventListener('click', () => window.close());

// Auto-trigger once so the dialog appears immediately
requestMic();
