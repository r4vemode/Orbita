(async () => {
  const A = OrbitaAccess, $ = id => document.getElementById(id);
  const plans = new Set(['pro', 'exclusive']), pendingStatuses = new Set(['creating', 'pending', 'crediting', 'refund_pending', 'refund_review']);
  const terminalStatuses = new Set(['failed', 'refunded']);
  const query = new URLSearchParams(location.search);
  let selected = plans.has(query.get('plan')) ? query.get('plan') : null, user, config = {}, paymentConfig = {}, request = null, order = null;
  let busy = false, checking = false, ready = false, pollTimer = null, storageKey, ownerId = null, invalidated = false;
  const states = new Map([...plans].map(plan => [plan, { request: null, order: null }]));
  const planName = plan => A.plans[plan]?.name || 'Подписка ORBITA';
  const money = (amount, currency = 'RUB') => typeof amount === 'number' && Number.isFinite(amount) ? amount.toLocaleString('ru-RU', { style: 'currency', currency, maximumFractionDigits: 2 }) : 'Уточняется';
  const date = iso => Number.isFinite(Date.parse(iso)) ? new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)) + ' МСК' : 'дата уточняется';
  const enabled = () => config.paymentsAvailable === true && paymentConfig.configured === true && paymentConfig.checkoutEnabled === true && paymentConfig.provider === 'cloudpayments';
  const validVersion=value=>typeof value==='string'&&/^ORBITA-[A-Za-z0-9.-]{1,100}$/.test(value);
  function renderTerms(){const version=order?.legalVersion||request?.legalVersion||config.legalVersion;const link=$('checkoutOfferLink');if(link)link.href='offer.html'+(validVersion(version)?'?version='+encodeURIComponent(version):'');}
  const subscribed = plan => (user?.subscriptions || []).find(item => item.plan === plan && Date.parse(item.expiresAt) > Date.now());
  const planConfig = plan => (paymentConfig.plans || []).find(item => item.id === plan) || { amount: A.plans[plan].price, currency: 'RUB', days: 30 };
  function safeCheckoutUrl(value) {
    if (typeof value !== 'string') return null;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && url.hostname === 'orders.cloudpayments.ru' && !url.username && !url.password && (!url.port || url.port === '443') ? url.href : null;
    } catch { return null; }
  }
  const orderId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value) ? value : null;
  function readRequests() {
    try {
      const stored = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
      const saved = stored?.version === 2 ? Object.values(stored.requests || {}) : [stored];
      for (const item of saved) {
        if (!item || !plans.has(item.plan) || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(item.requestId)) continue;
        const pending = { plan: item.plan, requestId: item.requestId, orderId: orderId(item.orderId),...(validVersion(item.legalVersion)?{legalVersion:item.legalVersion}:{}) };
        states.set(item.plan, { request: pending, order: pending.orderId ? { id: pending.orderId, plan: item.plan, status: 'creating' } : null });
      }
      return plans.has(stored?.selected) ? stored.selected : plans.has(stored?.plan) ? stored.plan : null;
    } catch {}
    return null;
  }
  function saveRequest() {
    if(invalidated||!storageKey)return;
    if (selected) states.set(selected, { request, order });
    const requests = Object.fromEntries([...states].filter(([, state]) => state.request).map(([plan, state]) => [plan, state.request]));
    try { sessionStorage.setItem(storageKey, JSON.stringify({ version: 2, selected, requests })); } catch {}
  }
  async function api(url, options = {}) {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 25000);
    try { return await A.request(url, { ...options, signal: controller.signal }); }
    catch (error) {
      if (controller.signal.aborted) throw Error('Ответ сервера задерживается. Повторите попытку: будет использован тот же запрос оплаты.');
      throw error;
    } finally { clearTimeout(timeout); }
  }
  function invalidateAccount(guest=false){
    if(invalidated)return;invalidated=true;ready=false;clearTimeout(pollTimer);
    user=null;order=null;request=null;states.clear();storageKey=null;
    for(const id of ['subscriptionIdentity','subscriptionStatus','paymentOrderReference','paymentOrderMessage','paymentOrderTitle','checkoutMessage','checkoutAmount','checkoutDescription'])$(id).textContent='';
    for(const card of document.querySelectorAll('[data-plan]')){card.querySelector('.plan-state').textContent='';card.classList.toggle('selected',false);}
    $('continuePayment').removeAttribute('href');$('paymentOrder').hidden=$('subscriptionDetails').hidden=$('openWorkspace').hidden=true;updateCheckoutButton();
    location.replace(guest?'/account.html?next=/subscriptions.html':'/subscriptions.html');
  }
  async function refreshAccount(){
    if(invalidated)return false;const current=await A.current();
    if(!current){invalidateAccount(true);return false;}
    if(ownerId&&current.id!==ownerId){invalidateAccount();return false;}
    user=current;return true;
  }
  function identity() {
    renderTerms();
    $('subscriptionIdentity').textContent = user.email;
    $('subscriptionStatus').textContent = user.access?.isAdmin ? 'Аккаунт администратора. Ваш доступ к редакции не зависит от подписки.' : user.access?.hasSubscription ? 'Доступ активен. Вы видите материалы подключённых тарифов.' : 'Подписка не активна. Выберите тариф, чтобы открыть его материалы и инструменты.';
    if (query.get('error') === 'admin' && !user.access?.isAdmin) $('subscriptionStatus').textContent = 'Редакция доступна только администратору. В вашем аккаунте этой роли нет.';
    document.querySelectorAll('[data-plan]').forEach(card => {
      const plan = card.dataset.plan, record = (user.subscriptions || []).find(item => item.plan === plan), current = subscribed(plan), details = planConfig(plan);
      card.querySelector('.plan-state').textContent = record ? (current ? 'Активна до ' : 'Истекла ') + date(record.expiresAt) : 'Не подключена';
      card.querySelector('[data-select]').textContent = current ? 'Продлить ' + (plan === 'pro' ? 'Pro' : 'Exclusive') : 'Выбрать ' + (plan === 'pro' ? 'Pro' : 'Exclusive');
      card.querySelector('[data-price]').textContent = money(details.amount, details.currency);
      card.querySelector('small').textContent = '/ ' + details.days + ' дней';
    });
    $('openWorkspace').hidden = !user.access?.hasSubscription;
    $('openWorkspace').href=user.access?.isAdmin?'admin.html':'app.html';$('openWorkspace').textContent=user.access?.isAdmin?'Открыть редакцию →':'Открыть кабинет →';
    $('emailVerification').hidden = user.emailVerified === true;
    $('verificationDescription').textContent = config.mailEnabled === true ? 'Для оплаты нужен подтверждённый адрес. Откройте настройки безопасности, чтобы отправить письмо или повторить отправку.' : 'Отправка писем пока не подключена. Подтверждение email и оплата станут доступны после настройки почтовой службы.';
    $('paymentAvailability').hidden = enabled();
    if (!enabled()) $('paymentAvailability').textContent = 'Онлайн-оплата пока недоступна. Продажи откроются после подготовки сервиса; нажатие кнопки не активирует подписку.';
    else if (paymentConfig.testMode === true) { $('paymentAvailability').hidden = false; $('paymentAvailability').textContent = 'Включён тестовый режим CloudPayments. Проверяйте режим оплаты перед вводом реквизитов.'; }
  }
  function choose(plan, scroll = true) {
    if (!plans.has(plan) || !ready || busy || checking) return;
    if (selected) states.set(selected, { request, order });
    selected = plan;
    ({ request, order } = states.get(plan));
    A.rememberPlan(user.id, plan);
    saveRequest();
    renderSelection();
    renderOrder();
    scheduleCheck();
    if (scroll) $('subscriptionDetails').scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (order?.id && order.status === 'creating') checkOrder();
  }
  function renderSelection() {
    if (!selected) return;
    const plan = selected;
    document.querySelectorAll('[data-plan]').forEach(card => card.classList.toggle('selected', card.dataset.plan === plan));
    $('verifyEmailLink').href = 'security.html?verify=1&plan=' + encodeURIComponent(plan);
    $('subscriptionDetails').hidden = false;
    $('checkoutTitle').textContent = planName(plan);
    const current = subscribed(plan), details = planConfig(plan);
    $('checkoutDescription').textContent = current ? `Продление на ${details.days} дней добавится к действующему сроку подписки — после ${date(current.expiresAt)}. Доступ обновится после подтверждения оплаты сервером.` : `Подписка на ${details.days} дней. Срок начнётся после подтверждения оплаты сервером.`;
    $('checkoutAmount').textContent = money(details.amount, details.currency);
    updateCheckoutButton();
  }
  function updateCheckoutButton() {
    document.querySelectorAll('[data-select]').forEach(button => { button.disabled = !ready || busy || checking; });
    const pending = order && pendingStatuses.has(order.status) && order.status !== 'creating';
    const missingCreatingRequest = order?.status === 'creating' && (!request || request.orderId !== order.id);
    const alreadyPaid = order?.status === 'paid' && order.plan === selected;
    $('createCheckout').disabled = !ready || !selected || busy || checking || !enabled() || user?.emailVerified !== true || !!user?.security?.adminEnrollmentRequired || !!pending || missingCreatingRequest || alreadyPaid;
    $('createCheckout').textContent = busy ? 'Подготавливаем оплату…' : request && !order ? 'Повторить подготовку оплаты' : order?.status === 'creating' ? 'Повторить подготовку оплаты' : 'Перейти к оплате CloudPayments';
    if (alreadyPaid) $('checkoutMessage').textContent = 'Этот заказ уже оплачен. Для отдельного продления нажмите «Создать платёж для продления» ниже.';
    else if (pending) $('checkoutMessage').textContent = 'У этого тарифа есть незавершённая операция. Продолжите оплату или проверьте её статус ниже. Другой тариф можно выбрать отдельно.';
    else if (missingCreatingRequest) $('checkoutMessage').textContent = 'Заказ ещё подготавливается, но исходный запрос не сохранился в этом браузере. Проверяйте статус заказа: новый платёж этого тарифа пока недоступен, чтобы не создать дубликат.';
    else if (user?.security?.adminEnrollmentRequired) $('checkoutMessage').textContent = 'Сначала завершите настройку защиты аккаунта в разделе «Безопасность».';
    else if (user?.emailVerified !== true) $('checkoutMessage').textContent = 'Сначала подтвердите email в разделе «Безопасность».';
    else if (!enabled()) $('checkoutMessage').textContent = 'Приём платежей пока не подключён.';
    else if (!busy) $('checkoutMessage').textContent = '';
  }
  function renderOrder() {
    renderTerms();
    $('paymentOrder').hidden = !order;
    if (!order) { updateCheckoutButton(); return; }
    $('paymentOrderReference').textContent = `Заказ ${order.id} · ${planName(order.plan)} · ${money(order.amount, order.currency || 'RUB')}`;
    const current = subscribed(order.plan), confirmed = order.status === 'paid' && !!current;
    const captions = {
      creating: ['Оплата подготавливается', request?.orderId === order.id ? 'Платёжный провайдер ещё формирует страницу оплаты. Если подготовка прервалась, повторите её для этого же заказа.' : 'Платёжный провайдер ещё формирует страницу оплаты. Исходный запрос в этом браузере недоступен; дождитесь обновления или проверьте статус заказа.'],
      pending: ['Ожидаем оплату', 'Оплатите заказ на странице CloudPayments. После оплаты дождитесь подтверждения сервера или нажмите «Проверить статус».'],
      crediting: ['Платёж подтверждается', 'Сервер обрабатывает подтверждение платежа. Доступ откроется после завершения проверки.'],
      paid: confirmed ? ['Оплата подтверждена', `Подписка ${planName(order.plan)} активна до ${date(current.expiresAt)}.`] : ['Оплата получена, обновляем доступ', 'Дождитесь обновления подписки сервером и повторно проверьте статус.'],
      failed: ['Платёж не завершён', 'Этот заказ не оплачен. Можно создать новый платёж; доступ по этому заказу не активирован.'],
      refund_pending: ['Возврат обрабатывается', 'Сервер ожидает подтверждение возврата от платёжного провайдера.'],
      refunded: ['Платёж возвращён', 'Возврат подтверждён. Действующий доступ показан в карточках тарифов выше.'],
      refund_review: ['Возврат требует проверки', 'Обратитесь в поддержку по вопросам этого платежа. Действующий срок подписки показан в карточке тарифа.']
    };
    const caption = captions[order.status] || ['Проверяем статус платежа', 'Статус пока не определён. Запросите актуальные данные сервера.'];
    $('paymentOrderTitle').textContent = caption[0]; $('paymentOrderMessage').textContent = caption[1];
    const checkout = safeCheckoutUrl(order.checkoutUrl), canContinue = !!checkout && order.status === 'pending' && enabled() && user?.emailVerified === true;
    $('continuePayment').hidden = !canContinue;
    if (canContinue) $('continuePayment').href = checkout; else $('continuePayment').removeAttribute('href');
    $('newPayment').hidden = !(terminalStatuses.has(order.status) || order.status === 'paid');
    $('newPayment').disabled = checking || busy;
    $('newPayment').textContent = order.status === 'paid' ? 'Создать платёж для продления' : 'Создать новый платёж';
    $('recheckPayment').disabled = checking || busy;
    $('recheckPayment').textContent = checking ? 'Проверяем…' : 'Проверить статус';
    updateCheckoutButton();
  }
  function scheduleCheck() {
    clearTimeout(pollTimer);
    if (order && (['creating', 'pending', 'crediting', 'refund_pending'].includes(order.status) || (order.status === 'paid' && !subscribed(order.plan)))) pollTimer = setTimeout(() => { if (!document.hidden) checkOrder(); else scheduleCheck(); }, 10000);
  }
  async function checkOrder() {
    if (checking || busy || !order?.id) return;
    checking = true; renderOrder();
    try {
      if(!await refreshAccount())return;
      const response = await api('/api/payments/orders/' + encodeURIComponent(order.id));
      if (!response.order || response.order.id !== order.id || !orderId(response.order.id) || response.order.plan !== selected) throw Error('Сервер вернул некорректные данные заказа.');
      if(!await refreshAccount())return;
      order = response.order;
      if(request&&validVersion(order.legalVersion))request.legalVersion=order.legalVersion;
      identity();
      renderSelection();
      $('subscriptionError').textContent = '';
      if (order.status === 'paid' || terminalStatuses.has(order.status)) request = null;
      saveRequest();
    } catch (error) {
      if(error.status===401){invalidateAccount(true);return;}
      if(error.status===404){try{if(!await refreshAccount())return;}catch{}}
      $('subscriptionError').textContent = error.message;
      if (error.status === 404) { order = null; request = null; saveRequest(); }
    } finally { checking = false; renderOrder(); scheduleCheck(); }
  }
  async function startCheckout() {
    if (!ready || busy || checking || !selected || !enabled() || user.emailVerified !== true || user.security?.adminEnrollmentRequired) return;
    if (order && (order.status === 'paid' || pendingStatuses.has(order.status) && order.status !== 'creating')) return;
    if (order?.status === 'creating' && (!request || request.orderId !== order.id)) return;
    busy = true; $('subscriptionError').textContent = ''; renderOrder();
    try {
      if(!await refreshAccount())return;
      if (!request) request = { plan: selected, requestId: crypto.randomUUID(), orderId: null };
      if(!request.legalVersion&&validVersion(config.legalVersion))request.legalVersion=config.legalVersion;
      saveRequest();
      const response = await api('/api/payments/checkout', { method: 'POST', body: JSON.stringify({ plan: request.plan, requestId: request.requestId,...(validVersion(request.legalVersion)?{legalVersion:request.legalVersion}:{}) }) });
      if(!await refreshAccount())return;
      if (!response.order || !orderId(response.order.id) || response.order.plan !== selected) throw Error('Сервер вернул некорректный заказ. Повторите тот же запрос.');
      order = response.order; request.orderId = order.id;if(validVersion(order.legalVersion))request.legalVersion=order.legalVersion;saveRequest();
      if (order.status === 'paid' || terminalStatuses.has(order.status)) { request = null; saveRequest(); }
      identity(); renderOrder();
      const checkout = safeCheckoutUrl(order.checkoutUrl);
      if (order.checkoutUrl && !checkout) throw Error('Ссылка оплаты не прошла проверку. Не переходите по ней; проверьте статус заказа или обратитесь в поддержку.');
      if (checkout && order.status === 'pending') location.assign(checkout);
      else $('paymentOrder').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      if(error.status===401){invalidateAccount(true);return;}
      $('subscriptionError').textContent = error.message;
      if (error.code === 'EMAIL_NOT_VERIFIED') { try { if(await refreshAccount())identity(); } catch {} }
      if(error.code==='LEGAL_VERSION_CHANGED'&&!order){
        try{config=await api('/api/public-config');if(!await refreshAccount())return;if(request&&validVersion(config.legalVersion)){request.legalVersion=config.legalVersion;saveRequest();}identity();renderSelection();}catch{}
        $('subscriptionError').textContent='Условия подписки обновились. Ознакомьтесь с новой редакцией по ссылке выше и снова нажмите кнопку оплаты.';
      }
    } finally { busy = false; renderOrder(); scheduleCheck(); }
  }
  document.querySelectorAll('[data-select]').forEach(button => button.onclick = () => choose(button.dataset.select));
  $('createCheckout').onclick = startCheckout;
  $('recheckPayment').onclick = checkOrder;
  $('newPayment').onclick = () => { if (busy || checking || !order || !(terminalStatuses.has(order.status) || order.status === 'paid')) return; order = null; request = null; saveRequest(); renderOrder(); };
  $('subscriptionLogout').onclick = async () => { try { await A.request('/api/logout', { method: 'POST', body: '{}' }); location.assign('/account.html'); } catch (error) { $('subscriptionError').textContent = error.message; } };
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden) return;
    try {
      if(!await refreshAccount())return;
      if (order) { checkOrder(); return; }
      identity(); renderSelection();
    } catch (error) { $('subscriptionError').textContent = error.message; }
  });
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
  updateCheckoutButton();
  try {
    user = await A.current();
    if (!user) { location.replace('/account.html?next=/subscriptions.html'); return; }
    ownerId=user.id;
    storageKey = 'orbita.checkout.v1.' + user.id;
    config = await A.request('/api/public-config');
    try { paymentConfig = await A.request('/api/payments/config'); }
    catch (error) { paymentConfig = { configured: false, provider: 'cloudpayments', plans: [] }; $('subscriptionError').textContent = error.message; }
    const savedSelection = readRequests();
    const returningOrder = orderId(query.get('paymentOrder'));
    let returnedPlan = null;
    if (returningOrder) {
      try {
        const response = await api('/api/payments/orders/' + encodeURIComponent(returningOrder));
        if(!await refreshAccount())return;
        if (!response.order || response.order.id !== returningOrder || !plans.has(response.order.plan)) throw Error('Сервер вернул некорректные данные заказа.');
        returnedPlan = response.order.plan;
        const state = states.get(returnedPlan);
        if (!state.request || state.request.orderId === returningOrder) {
          state.order = response.order;
          if (response.order.status === 'paid' || terminalStatuses.has(response.order.status)) state.request = null;
        } else $('subscriptionError').textContent = 'В этом тарифе уже сохранён другой запрос оплаты. Показываем его, чтобы не потерять незавершённый платёж. Подписка обновляется по подтверждениям сервера.';
      } catch (error) { $('subscriptionError').textContent = error.message; }
    }
    const initialPlan = selected || returnedPlan || savedSelection || A.preferredPlan(user.id);
    selected = null; ready = true; identity();
    if (plans.has(initialPlan)) choose(initialPlan, false);
    else updateCheckoutButton();
  } catch (error) { $('subscriptionError').textContent = error.message; }
})();
