// Support information is published by the operator; never invent an address.
(async () => {
  try {
    const response = await fetch('/api/public-config', {cache:'no-store'});
    if (!response.ok) return;
    const {supportEmail,authorName,editorialNote} = await response.json();
    if (typeof supportEmail === 'string' && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(supportEmail)) {
      const link = document.createElement('a'); link.href = 'mailto:' + supportEmail; link.textContent = supportEmail;
      document.getElementById('supportContact').replaceChildren('Поддержка: ', link);
    }
    if (authorName || editorialNote) {
      const section=document.createElement('section'),heading=document.createElement('h2');heading.textContent='Автор и публикации';section.append(heading);
      for (const value of [authorName,editorialNote]) if (value) {const paragraph=document.createElement('p');paragraph.textContent=value;section.append(paragraph);}
      document.getElementById('support').before(section);
    }
  } catch { /* The offline guide remains usable when the service is unavailable. */ }
})();
