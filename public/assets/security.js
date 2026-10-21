(async () => {
  const A = OrbitaAccess, $ = id => document.getElementById(id), page = document.body.dataset.securityPage;
  const post = (path, data = {}) => A.request('/api/security/' + path, { method: 'POST', body: JSON.stringify(data) });
  function message(element, text, type = '') { if (!element) return; element.textContent = text; element.className = (element.id === 'securityStatus' ? 'security-status' : 'status') + (type ? ' ' + type : ''); }
  function takeToken() { const value = new URLSearchParams(location.hash.slice(1)).get('token') || ''; if (location.hash) history.replaceState(null, '', location.pathname + location.search); return value.length <= 512 ? value : ''; }
  async function copy(value, target) {
    try { if (!navigator.clipboard?.writeText) throw Error(); await navigator.clipboard.writeText(value); message(target, 'Скопировано.', 'success'); }
    catch { message(target, 'Не удалось скопировать автоматически. Выделите и скопируйте вручную.'); }
  }
  if (page === 'verify') {
    let token = takeToken(); const form = $('verifyEmailForm'), output = $('verifyMessage'), button = form.querySelector('button');
    if (!token) { form.hidden = true; message(output, 'В ссылке нет токена подтверждения. Запросите новую ссылку в настройках email.', 'error'); }
    form.onsubmit = async event => {
      event.preventDefault(); if (!token) return; button.disabled = true; message(output, 'Проверяем ссылку…');
      try { await post('verify-email', { token }); token = ''; form.hidden = true; message(output, 'Email подтверждён. Теперь можно перейти к подпискам.', 'success'); $('verifiedContinue').hidden = false; }
      catch (error) { message(output, error.message, 'error'); button.disabled = false; }
    };
    window.addEventListener('pagehide', () => { token = ''; });
    return;
  }
  if (page === 'reset') {
    let token = takeToken(); const requestForm = $('requestResetForm'), resetForm = $('resetPasswordForm'), output = $('resetMessage');
    function renderReset() {
      requestForm.hidden = !!token; resetForm.hidden = !token;
      $('resetTitle').textContent = token ? 'Новый пароль.' : 'Не помните пароль?';
      $('resetExplanation').textContent = token ? 'Задайте пароль от 10 до 128 символов. После смены пароля потребуется войти заново.' : 'Укажите email аккаунта. Если он зарегистрирован, на него придёт ссылка для смены пароля.';
      $('requestAnotherReset').hidden = !token;
    }
    renderReset();
    requestForm.onsubmit = async event => {
      event.preventDefault(); const button = requestForm.querySelector('button'); button.disabled = true; message(output, 'Отправляем запрос…');
      try {
        const result = await post('request-password-reset', { email: requestForm.elements.email.value.trim() });
        if (result.mailConfigured === false) message(output, 'Отправка писем пока не настроена. Восстановление через email временно недоступно.', 'error');
        else message(output, result.message || 'Если аккаунт с этим email существует, на него придёт ссылка для смены пароля.', 'success');
      } catch (error) { message(output, error.message, 'error'); }
      finally { button.disabled = false; }
    };
    resetForm.onsubmit = async event => {
      event.preventDefault(); const button = resetForm.querySelector('button');
      if (resetForm.elements.password.value !== resetForm.elements.passwordRepeat.value) { message(output, 'Пароли не совпадают.', 'error'); return; }
      if (!token) { message(output, 'Запросите новую ссылку для смены пароля.', 'error'); return; }
      button.disabled = true; message(output, 'Сохраняем пароль…');
      try {
        await post('reset-password', { token, password: resetForm.elements.password.value }); token = ''; resetForm.reset(); resetForm.hidden = true; requestForm.hidden = true; $('requestAnotherReset').hidden = true;
        message(output, 'Пароль изменён. Войдите в аккаунт с новым паролем. Настроенная двухфакторная защита остаётся включённой.', 'success'); $('resetLogin').classList.remove('secondary'); $('resetLogin').focus();
      } catch (error) { message(output, error.message, 'error'); button.disabled = false; }
    };
    $('requestAnotherReset').onclick = () => { token = ''; resetForm.reset(); renderReset(); message(output, ''); requestForm.elements.email.focus(); };
    window.addEventListener('pagehide', () => { token = ''; resetForm.reset(); });
    return;
  }
  if (page !== 'settings') return;
  let user = null, settings = null, setup = null, recoveryCodes = [], busy = false;
  function clearSetup() { setup = null; $('setupSecret').value = ''; $('setupUri').textContent = ''; $('mfaConfirmForm').reset(); $('mfaSetupPanel').hidden = true; if (user && !user.security?.mfaEnabled) $('mfaSetupForm').hidden = false; }
  function clearRecovery() { recoveryCodes = []; $('recoveryCodes').replaceChildren(); $('recoveryPanel').hidden = true; $('recoverySaved').checked = false; $('closeRecovery').disabled = true; message($('recoveryMessage'), ''); }
  function showRecovery(codes) {
    if (!Array.isArray(codes) || !codes.length || !codes.every(value => typeof value === 'string')) throw Error('Сервер не вернул резервные коды. Создайте новый набор в настройках защиты.');
    recoveryCodes = [...codes]; $('recoveryCodes').replaceChildren();
    for (const value of codes) { const item = document.createElement('li'), code = document.createElement('code'); code.textContent = value; item.append(code); $('recoveryCodes').append(item); }
    $('recoverySaved').checked = false; $('closeRecovery').disabled = true; $('recoveryPanel').hidden = false; message($('recoveryMessage'), ''); $('recoveryPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function renderSettings() {
    const security = user.security || {}, mailReady = settings.mailConfigured && settings.publicOriginConfigured;
    $('securitySettings').hidden = false; $('accountEmail').textContent = user.email;
    $('emailBadge').textContent = user.emailVerified ? 'Email подтверждён' : 'Email не подтверждён'; $('emailBadge').classList.toggle('verified', !!user.emailVerified);
    $('emailExplanation').textContent = user.emailVerified ? 'Адрес подтверждён. Его можно использовать для оплаты подписки и восстановления доступа.' : 'Перед оплатой подписки подтвердите адрес по ссылке из письма.';
    $('mailConfiguration').textContent = mailReady ? '' : 'Отправка писем или публичный адрес сайта пока не настроены. Письмо подтверждения сейчас отправить нельзя.';
    $('resendVerification').hidden = !!user.emailVerified; $('resendVerification').disabled = !mailReady;
    $('mfaBadge').textContent = security.mfaEnabled ? 'Защита включена' : 'Защита не подключена'; $('mfaBadge').classList.toggle('verified', !!security.mfaEnabled);
    $('mfaSetupForm').hidden = !!security.mfaEnabled || !!setup; $('mfaSetupPanel').hidden = !!security.mfaEnabled || !setup;
    $('mfaEnabledSettings').hidden = !security.mfaEnabled; $('mfaDisableDetails').hidden = !!security.mfaRequiredForAdmin; $('mfaRequiredNotice').hidden = !security.mfaRequiredForAdmin;
    $('enrollmentNotice').hidden = !security.adminEnrollmentRequired;
    const continueLink = $('continueAccount');
    if (user.access?.isAdmin && !security.adminEnrollmentRequired) { continueLink.href = 'admin.html'; continueLink.textContent = 'К панели администратора →'; }
    else { const plan = new URLSearchParams(location.search).get('plan'); continueLink.href = 'subscriptions.html' + (['pro', 'exclusive'].includes(plan) ? '?plan=' + plan : ''); continueLink.textContent = 'К подпискам →'; }
  }
  async function refreshSettings() {
    settings = await A.request('/api/security/status'); user = settings.user;
    if (!user) { location.replace('/account.html?next=' + encodeURIComponent('/security.html')); return false; }
    renderSettings(); message($('securityStatus'), ''); return true;
  }
  async function operation(form, action) {
    if (busy) return; busy = true; const button = form.querySelector('button[type=submit]'), output = form.querySelector('[role=status]'); button.disabled = true; message(output, 'Проверяем…');
    try { await action(output); }
    catch (error) { if (error.status === 401) { location.replace('/account.html?next=' + encodeURIComponent('/security.html')); return; } message(output, error.message, 'error'); }
    finally { busy = false; button.disabled = false; if (form.elements.password) form.elements.password.value = ''; if (form.elements.code) form.elements.code.value = ''; }
  }
  $('resendVerification').onclick = async () => {
    const button = $('resendVerification'); button.disabled = true; message($('verificationMessage'), 'Отправляем запрос…');
    try {
      const response = await post('resend-verification');
      if (response.sent) message($('verificationMessage'), 'Ссылка подтверждения отправлена на ваш email. Проверьте также папку «Спам».', 'success');
      else if (response.reason === 'not_configured') message($('verificationMessage'), 'Отправка писем пока не настроена. Письмо не отправлено.', 'error');
      else message($('verificationMessage'), 'Письмо не удалось отправить. Попробуйте позже.', 'error');
    } catch (error) { message($('verificationMessage'), error.message, 'error'); }
    finally { button.disabled = !(settings?.mailConfigured && settings?.publicOriginConfigured); }
  };
  $('mfaSetupForm').onsubmit = event => { event.preventDefault(); const form = event.currentTarget; operation(form, async output => {
    const result = await post('mfa/setup', { password: form.elements.password.value });
    if (typeof result.secret !== 'string' || typeof result.otpauthUri !== 'string' || !result.otpauthUri.startsWith('otpauth://totp/')) throw Error('Не удалось получить настройки приложения. Повторите запрос.');
    setup = { secret: result.secret, otpauthUri: result.otpauthUri }; $('setupSecret').value = setup.secret; $('setupUri').textContent = setup.otpauthUri; message(output, ''); renderSettings(); $('mfaConfirmForm').elements.code.focus();
  }); };
  $('mfaConfirmForm').onsubmit = event => { event.preventDefault(); const form = event.currentTarget; operation(form, async output => {
    const result = await post('mfa/confirm', { code: form.elements.code.value.trim() }); clearSetup(); await refreshSettings(); message(output, ''); showRecovery(result.recoveryCodes);
  }); };
  $('mfaRecoveryForm').onsubmit = event => { event.preventDefault(); const form = event.currentTarget; operation(form, async output => {
    const result = await post('mfa/recovery', { password: form.elements.password.value, code: form.elements.code.value.trim() }); message(output, ''); showRecovery(result.recoveryCodes);
  }); };
  $('mfaDisableForm').onsubmit = event => { event.preventDefault(); const form = event.currentTarget; operation(form, async output => {
    await post('mfa/disable', { password: form.elements.password.value, code: form.elements.code.value.trim() }); clearSetup(); clearRecovery(); await refreshSettings(); message($('securityStatus'), 'Двухфакторная защита отключена.', 'success'); message(output, '');
  }); };
  $('copySetupSecret').onclick = () => setup && copy(setup.secret, $('mfaConfirmForm').querySelector('[role=status]'));
  $('cancelMfaSetup').onclick = clearSetup;
  $('copyRecovery').onclick = () => recoveryCodes.length && copy(recoveryCodes.join('\n'), $('recoveryMessage'));
  $('downloadRecovery').onclick = () => {
    if (!recoveryCodes.length) return;
    const blob = new Blob(['ORBITA — резервные коды\nКаждый код используется один раз.\n\n' + recoveryCodes.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' }), url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = 'orbita-recovery-codes.txt'; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); message($('recoveryMessage'), 'Файл с кодами подготовлен для сохранения.', 'success');
  };
  $('recoverySaved').onchange = event => { $('closeRecovery').disabled = !event.target.checked; };
  $('closeRecovery').onclick = () => { if (!$('recoverySaved').checked) return; clearRecovery(); message($('securityStatus'), 'Двухфакторная защита настроена.', 'success'); };
  window.addEventListener('pagehide', () => { clearSetup(); clearRecovery(); for (const form of document.forms) form.reset(); });
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
  try { await refreshSettings(); }
  catch (error) { if (error.status === 401) location.replace('/account.html?next=' + encodeURIComponent('/security.html')); else message($('securityStatus'), error.message, 'error'); }
})();
