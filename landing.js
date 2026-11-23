const members = document.querySelector('#discord-members');

if (members) {
  fetch('https://discord.com/api/v10/invites/osprey?with_counts=true', {
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    signal: AbortSignal.timeout(4500)
  })
    .then(response => {
      if (!response.ok) throw new Error('Discord member count unavailable');
      return response.json();
    })
    .then(data => {
      const n = data.approximate_member_count;
      if (!Number.isSafeInteger(n) || n < 0) return;
      members.textContent = `${new Intl.NumberFormat('en').format(n)} ${n === 1 ? 'member' : 'members'}`;
    })
    .catch(() => { /* Keep the known member-count snapshot in this preview. */ });
}

const copy = document.querySelector('.address');
const ip = copy?.querySelector('[data-ip]');
const status = document.querySelector('.copy-status');
let clearStatus;

copy?.addEventListener('click', async () => {
  clearTimeout(clearStatus);
  copy.removeAttribute('data-copied');
  let copied = false;
  try {
    await navigator.clipboard.writeText(ip.textContent);
    copied = true;
  } catch {
    const range = document.createRange();
    range.selectNodeContents(ip);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    try {
      copied = document.execCommand('copy');
    } catch { /* Leave the address selected for manual copying. */ }
    if (copied) selection.removeAllRanges();
  }
  if (copied) copy.setAttribute('data-copied', '');
  status.textContent = copied ? 'Address copied' : 'Address selected. Copy it with your keyboard or menu.';
  clearStatus = setTimeout(() => {
    status.textContent = '';
    copy.removeAttribute('data-copied');
  }, 2800);
});
