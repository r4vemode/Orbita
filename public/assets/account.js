(async () => {
  const parameters = new URLSearchParams(location.search), A = OrbitaAccess;
  const $ = id => document.getElementById(id), form = $('accountForm'), message = $('message'), submit = $('submit'), switcher = $('switch');
  let register = parameters.get('mode') === 'register', legalVersion = null, challenge = null, submitting = false, configurationError = null, configurationPromise;
  const normalizePlan = value => ['orbita-exclusive', 'exclusive'].includes(value) ? 'exclusive' : value === 'pro' ? 'pro' : null;
  let inheritedPlan = null;
  if (parameters.get('next')) {
    const nextUrl = new URL(A.safeNext(parameters.get('next'), '/subscriptions.html'), location.origin);
    if (nextUrl.pathname === '/subscriptions.html') inheritedPlan = normalizePlan(nextUrl.searchParams.get('plan'));
  }
  const plan = normalizePlan(parameters.get('plan')) || inheritedPlan;
  function resetConsents(){form.elements.acceptTerms.checked=false;form.elements.acceptPrivacy.checked=false;}
  function render() {
    $('title').textContent = challenge ? 'Подтвердите вход.' : register ? 'Ваша новая орбита.' : 'С возвращением.';
    $('subtitle').textContent = challenge ? 'Введите код приложения-аутентификатора или один из сохранённых резервных кодов.' : register ? plan ? `Вы выбрали ${plan === 'exclusive' ? 'Orbita Exclusive — 4 999' : 'Orbita Pro — 2 999'} ₽ за 30 дней. Сначала создайте аккаунт и подтвердите email.` : 'Создайте аккаунт и подтвердите email. Доступ к сервисам открывается по подписке.' : 'Войдите в аккаунт, чтобы проверить подписку и открыть кабинет.';
    submit.textContent = challenge ? 'Подтвердить вход ↗' : register ? 'Создать аккаунт ↗' : 'Войти ↗';
    switcher.textContent = register ? 'Уже есть аккаунт? Войти' : 'Нет аккаунта? Зарегистрироваться';
    $('credentials').hidden = !!challenge; $('mfaChallenge').hidden = !challenge; $('cancelMfa').hidden = !challenge; switcher.hidden = !!challenge;
    for (const input of $('credentials').querySelectorAll('input')) input.disabled = !!challenge;
    form.elements.code.disabled = !challenge; form.elements.code.required = !!challenge;
    form.elements.password.autocomplete = register ? 'new-password' : 'current-password';
    $('consents').hidden = !register || !!challenge;
    for (const input of $('consents').querySelectorAll('input')) { input.required = register && !challenge; input.disabled = !!challenge; }
    message.textContent = '';
    if (!challenge) { const url = new URL(location.href); url.searchParams.set('mode', register ? 'register' : 'login'); history.replaceState(null, '', url.pathname + url.search); }
  }
  function go(user) {
    if (!user) throw Error('Сервер не подтвердил вход. Попробуйте ещё раз.');
    if (plan) A.rememberPlan(user.id, plan);
    const chosenPlan = plan || A.preferredPlan(user.id);
    if (user.security?.adminEnrollmentRequired) { location.assign('/security.html?enroll=1'); return; }
    if (!user.emailVerified) { location.assign('/security.html?verify=1' + (chosenPlan ? '&plan=' + chosenPlan : '')); return; }
    const next = parameters.get('next');
    if (next && (user.access?.hasSubscription || /^\/(?:security|subscriptions)\.html(?:\?|$)/.test(next))) { location.assign(A.safeNext(next, '/subscriptions.html')); return; }
    if (user.access?.isAdmin) location.assign('/admin.html');
    else if (user.access?.hasSubscription) location.assign('/app.html');
    else location.assign('/subscriptions.html' + (chosenPlan ? '?plan=' + chosenPlan : ''));
  }
  async function loadConfiguration() {
    configurationError = null;
    try {
      const configuration = await A.request('/api/public-config');
      if (typeof configuration?.legalVersion !== 'string' || !configuration.legalVersion.trim()) throw Error('Не удалось загрузить условия регистрации. Повторите попытку.');
      if(legalVersion&&legalVersion!==configuration.legalVersion)resetConsents();
      legalVersion = configuration.legalVersion;
      for(const [id,page]of [['termsLink','offer.html'],['privacyLink','privacy.html']]){const link=$(id);if(link)link.href=page+'?version='+encodeURIComponent(legalVersion);}
    } catch (error) { configurationError = error; if (!submitting) message.textContent = error.message; }
  }
  switcher.onclick = () => { register = !register; form.elements.password.value = ''; render(); };
  $('cancelMfa').onclick = () => { challenge = null; form.elements.password.value = ''; form.elements.code.value = ''; render(); form.elements.email.focus(); };
  render();
  form.onsubmit = async event => {
    event.preventDefault(); if (submitting) return; submitting = true; submit.disabled = switcher.disabled = $('cancelMfa').disabled = true; message.textContent = '';
    try {
      if (location.protocol === 'file:') throw Error('Регистрация работает через сервер. Запустите npm start и откройте адрес из терминала.');
      if (challenge) { const data = await A.request('/api/security/mfa/login', { method: 'POST', body: JSON.stringify({ challenge, code: form.elements.code.value.trim() }) }); form.elements.code.value = ''; go(data.user); return; }
      if (register) { message.textContent = 'Загружаем условия регистрации…'; if (configurationError) configurationPromise = loadConfiguration(); await configurationPromise; if (configurationError) throw configurationError; message.textContent = ''; }
      if(register&&(!form.elements.acceptTerms.checked||!form.elements.acceptPrivacy.checked))throw Error('Ознакомьтесь с документами и подтвердите оба согласия.');
      const body = { email: form.elements.email.value.trim(), password: form.elements.password.value };
      if (register) Object.assign(body, { acceptTerms: form.elements.acceptTerms.checked, acceptPrivacy: form.elements.acceptPrivacy.checked, legalVersion, ...(plan ? {plan} : {}) });
      const data = await A.request(register ? '/api/register' : '/api/login', { method: 'POST', body: JSON.stringify(body) });
      form.elements.password.value = '';
      if (data.mfaRequired) {
        if (typeof data.challenge !== 'string' || !data.challenge) throw Error('Не удалось начать проверку входа. Введите пароль ещё раз.');
        challenge = data.challenge; render(); form.elements.code.focus(); return;
      }
      go(data.user);
    } catch (error) {
      if(register&&error.code==='LEGAL_VERSION_CHANGED'){
        resetConsents();configurationPromise=loadConfiguration();await configurationPromise;
        message.textContent=configurationError?'Документы обновились, но новую редакцию пока не удалось загрузить. Повторите попытку позже.':'Документы обновились. Ознакомьтесь с новой редакцией по ссылкам и подтвердите оба согласия ещё раз.';
      }else message.textContent = error.message || 'Не удалось подключиться к серверу.';
    }
    finally { submitting = false; submit.disabled = switcher.disabled = $('cancelMfa').disabled = false; }
  };
  // Bind submit before the first asynchronous operation. The form must never
  // fall back to browser GET submission while configuration is slow or missing.
  configurationPromise = loadConfiguration();
  submit.disabled = false;
  await configurationPromise;
})();
