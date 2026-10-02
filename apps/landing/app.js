const prompts = {
  codex: `Help me set up TagMails for Codex when the beta installer is available.

1. Explain the local permissions you need and ask me to choose one workspace.
2. Have me sign in with Google in my browser and verify the Gmail address I will send from.
3. Pair this Mac through the official TagMails setup flow. Keep my Codex sign-in and project files local.
4. Run a synthetic status check and show me the result before trying live email.

Do not send email, spend credits, or change project files until I approve the specific action.`,
  claude: `Help me set up TagMails for Claude Code when the beta installer is available.

1. Explain the local permissions you need and ask me to choose one workspace.
2. Have me sign in with Google in my browser and verify the Gmail address I will send from.
3. Pair this Mac through the official TagMails setup flow. Keep my Claude sign-in and project files local.
4. Run a synthetic status check and show me the result before trying live email.

Do not send email, spend credits, or change project files until I approve the specific action.`,
};

const tabs = [...document.querySelectorAll('.runtime-tab')];
const prompt = document.querySelector('#setupPrompt');
const copyButton = document.querySelector('#copyPrompt');
let selected = 'codex';

function selectRuntime(runtime) {
  selected = runtime;
  prompt.textContent = prompts[runtime];
  tabs.forEach((tab) => {
    const active = tab.dataset.runtime === runtime;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  copyButton.firstChild.textContent = 'Copy prompt ';
}

tabs.forEach((tab) => tab.addEventListener('click', () => selectRuntime(tab.dataset.runtime)));
document.querySelector('.runtime-tabs').addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const index = tabs.indexOf(document.activeElement);
  if (index < 0) return;
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].click();
  tabs[next].focus();
});
copyButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(prompts[selected]);
    copyButton.firstChild.textContent = 'Copied ';
  } catch {
    copyButton.firstChild.textContent = 'Copy failed ';
  }
});
selectRuntime(selected);
