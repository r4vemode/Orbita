// Manual trades are private account data, independent of the author's scenario.
export function validatePosition(input) {
  const fail = () => { throw Object.assign(new Error('Проверьте цену, объём и даты личной сделки.'), { status: 400 }); };
  const timestamp=value=>{
    if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value))fail();
    const date=value.slice(0,10),clock=value.slice(11,19),time=Date.parse(value);
    if(!Number.isFinite(time)||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date||clock>'23:59:59'||Number(clock.slice(3,5))>59||Number(clock.slice(6,8))>59)fail();
    return time;
  };
  if (!input || typeof input.ideaId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.ideaId)) fail();
  for (const field of ['entry', 'quantity', 'pointValue']) {
    if (!Number.isFinite(input[field]) || input[field] <= 0 || input[field] > 1e12) fail();
  }
  if (!Number.isFinite(input.entry * input.quantity * input.pointValue) || input.entry * input.quantity * input.pointValue > 1e18) fail();
  const entered = timestamp(input.enteredAt);
  if (input.exit !== null && (!Number.isFinite(input.exit) || input.exit <= 0 || input.exit > 1e12)) fail();
  const closed = input.closedAt === null ? null : timestamp(input.closedAt);
  if ((input.exit === null) !== (closed === null) || (closed !== null && (!Number.isFinite(closed) || closed < entered))) fail();
  return {ideaId:input.ideaId, entry:input.entry, quantity:input.quantity, pointValue:input.pointValue, enteredAt:new Date(entered).toISOString(), exit:input.exit, closedAt:closed === null ? null : new Date(closed).toISOString()};
}
