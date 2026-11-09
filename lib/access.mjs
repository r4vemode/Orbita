export const LEGAL_VERSION='ORBITA-2026-10-20';
export const PLANS=Object.freeze({pro:{name:'Orbita Pro',price:2999,days:30},exclusive:{name:'Orbita Exclusive',price:4999,days:30}});
export const isAdmin=user=>user?.role==='admin';
export function activePlans(user,now=Date.now()) { return [...new Set((user?.subscriptions||[]).filter(s=>Object.hasOwn(PLANS,s.plan)&&Number.isFinite(Date.parse(s.expiresAt))&&Date.parse(s.expiresAt)>now).map(s=>s.plan))]; }
export const hasSubscription=(user,now=Date.now())=>isAdmin(user)||activePlans(user,now).length>0;
// Access tiers are ordered: EXCLUSIVE includes every PRO capability.
export const TIERS=Object.freeze(['pro','exclusive']);
export const EXCLUSIVE_STRATEGIES=Object.freeze(new Set(['Orbita Exclusive']));
// The strategy is the single source of truth for an idea's access tier. Unknown
// or legacy strategies are never public: they fall back to the paid PRO tier.
export const tierOf=strategy=>EXCLUSIVE_STRATEGIES.has(strategy)?'exclusive':'pro';
export const tierLevel=tier=>TIERS.indexOf(tier)+1;
export function effectiveTier(user,now=Date.now()){if(isAdmin(user))return 'exclusive';const plans=activePlans(user,now);return plans.includes('exclusive')?'exclusive':plans.includes('pro')?'pro':null;}
export const canReadTier=(user,tier,now=Date.now())=>TIERS.includes(tier)&&(isAdmin(user)||tierLevel(effectiveTier(user,now))>=tierLevel(tier));
export const canReadStrategy=(user,strategy,now=Date.now())=>canReadTier(user,tierOf(strategy),now);
export const accessFor=user=>({isAdmin:isAdmin(user),activePlans:activePlans(user),hasSubscription:hasSubscription(user),tier:effectiveTier(user),tiers:TIERS.filter(tier=>canReadTier(user,tier))});
export function requireMember(user) {if(!user)throw Object.assign(Error('Войдите в аккаунт.'),{status:401});if(!hasSubscription(user))throw Object.assign(Error('Для доступа нужна действующая подписка.'),{status:403,code:'SUBSCRIPTION_REQUIRED'});}
export function requireAdmin(user) {if(!user)throw Object.assign(Error('Войдите в аккаунт.'),{status:401});if(!isAdmin(user))throw Object.assign(Error('Доступ только для администратора.'),{status:403});}
export function publicUser(user) {return user?{id:user.id,email:user.email,role:isAdmin(user)?'admin':'member',subscriptions:(user.subscriptions||[]).map(s=>({plan:s.plan,expiresAt:s.expiresAt})),access:accessFor(user)}:null;}
