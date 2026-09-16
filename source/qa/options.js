import './runtime-config.js';

const config = globalThis.AI_NOTE_CONFIG || {};
const labels = { deepgram: 'Deepgram', assemblyai: 'AssemblyAI', openai: 'OpenAI' };
const active = config.activeProvider || 'assemblyai';
const providers = [...new Set(config.fallbackProviders || [active])];

document.getElementById('activeProvider').textContent = labels[active] || active;

const list = document.getElementById('providerList');
for (const name of providers) {
  const configured = Boolean(config.keys?.[name]);
  const mode = name === 'openai' ? 'Near-live segments' : 'Live streaming';
  const row = document.createElement('div');
  row.className = 'provider-row';
  row.innerHTML = `
    <div>
      <strong>${labels[name] || name}</strong>
      <span>${mode}</span>
    </div>
    <span class="status ${configured ? 'ready' : 'missing'}">${configured ? 'Configured' : 'Not configured'}</span>
  `;
  list.appendChild(row);
}

const scriptMode = document.getElementById('scriptMode');
const scriptStatus = document.getElementById('scriptStatus');
chrome.storage.local.get({ transcriptScript: 'roman' }).then(({ transcriptScript }) => {
  scriptMode.value = transcriptScript;
  scriptStatus.textContent = transcriptScript === 'native' ? 'Native script' : 'Roman / Latin';
});
scriptMode.addEventListener('change', async () => {
  await chrome.storage.local.set({ transcriptScript: scriptMode.value });
  scriptStatus.textContent = scriptMode.value === 'native' ? 'Native script' : 'Roman / Latin';
});
