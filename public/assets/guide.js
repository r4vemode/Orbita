// Support information is published by the operator; never invent an address.
(async () => {
  try {
    const response = await fetch('/api/public-config', {cache:'no-store'});
    if (!response.ok) return;
    const {supportEmail} = await response.json();
    if (typeof supportEmail !== 'string' || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(supportEmail)) return;
    const link = document.createElement('a'); link.href = 'mailto:' + supportEmail; link.textContent = supportEmail;
    document.getElementById('supportContact').replaceChildren('Поддержка: ', link);
  } catch { /* The offline guide remains usable when the service is unavailable. */ }
})();
