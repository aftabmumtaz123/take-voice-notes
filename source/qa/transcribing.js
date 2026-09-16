const params = new URLSearchParams(location.search);
const state = params.get('state') || 'started';
const platform = params.get('platform') || 'meeting';
const title = document.getElementById('title');
const detail = document.getElementById('detail');
const icon = document.getElementById('icon');

if (state === 'permission') {
  title.textContent = 'Microphone permission required';
  detail.textContent = `${platform} was detected, but Chrome has not granted AI Note Taker microphone access yet.`;
  icon.textContent = '⌁';
} else if (state === 'error') {
  title.textContent = 'Transcription could not start';
  detail.textContent = params.get('error') || 'Please check microphone permission and your developer transcription configuration.';
  icon.textContent = '!';
} else {
  title.textContent = 'Your meeting is being transcribed';
  detail.textContent = `${platform} detected · live transcription is running. You can continue working in any tab.`;
  icon.textContent = '●';
}
setTimeout(() => window.close(), 5000);
