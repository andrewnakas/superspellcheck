import { api, getSettings, saveSettings } from './storage';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function main() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  let hostname = '';
  try {
    hostname = new URL(tab?.url ?? '').hostname;
  } catch {}
  const s = await getSettings();
  $('host').textContent = hostname || 'this page';
  const site = $<HTMLInputElement>('site');
  site.checked = !s.disabledSites.includes(hostname);
  site.disabled = !hostname;
  site.addEventListener('change', async () => {
    const cur = await getSettings();
    const set = new Set(cur.disabledSites);
    if (site.checked) set.delete(hostname);
    else set.add(hostname);
    await saveSettings({ disabledSites: [...set] });
  });
  const enabled = $<HTMLInputElement>('enabled');
  enabled.checked = s.enabled;
  enabled.addEventListener('change', () => saveSettings({ enabled: enabled.checked }));
  $('opts').addEventListener('click', (e) => {
    e.preventDefault();
    api.runtime.openOptionsPage();
  });
}

main();
