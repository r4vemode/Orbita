// Manual trades are private account data, independent of the author's scenario.
export function validatePosition(input) {
  const fail = () => { throw Object.assign(new Error('Проверьте цену, объём и даты личной сделки.'), { status: 400 }); };
  if (!input || typeof input.ideaId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.ideaId)) fail();
  for (const field of ['entry', 'quantity', 'pointValue']) {
    if (!Number.isFinite(input[field]) || input[field] <= 0 || input[field] > 1e12) fail();
  }
  if (!Number.isFinite(input.entry * input.quantity * input.pointValue) || input.entry * input.quantity * input.pointValue > 1e18) fail();
  const entered = Date.parse(input.enteredAt);
  if (typeof input.enteredAt !== 'string' || !Number.isFinite(entered)) fail();
  if (input.exit !== null && (!Number.isFinite(input.exit) || input.exit <= 0 || input.exit > 1e12)) fail();
  const closed = input.closedAt === null ? null : Date.parse(input.closedAt);
  if ((input.exit === null) !== (closed === null) || (closed !== null && (!Number.isFinite(closed) || closed < entered))) fail();
  return {ideaId:input.ideaId, entry:input.entry, quantity:input.quantity, pointValue:input.pointValue, enteredAt:new Date(entered).toISOString(), exit:input.exit, closedAt:closed === null ? null : new Date(closed).toISOString()};
}
