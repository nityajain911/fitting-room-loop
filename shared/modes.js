// What a device is for. A tablet in a fitting room should only ever show the customer screen, a runner's phone only
// the associate screen. A link sets the mode once (`...&mode=customer`) and the device remembers it. This is a
// convenience, not security: there are no logins, so anyone with the link to another mode can switch it.
export const MODE_PARAM = 'mode';
export const VIEWS_BY_MODE = {
  demo: ['customer', 'associate', 'manager', 'admin'], // an unlocked browser, for trying everything out
  customer: ['customer'],
  staff: ['associate'],
  manager: ['manager', 'admin'],
};
export const isMode = (m) => typeof m === 'string' && Object.hasOwn(VIEWS_BY_MODE, m);
export const allowedView = (mode, view) => (VIEWS_BY_MODE[isMode(mode) ? mode : 'demo']).includes(view);
export const homeOf = (mode) => VIEWS_BY_MODE[isMode(mode) ? mode : 'demo'][0];
export const showNav = (mode) => !isMode(mode) || mode === 'demo';
export const showAdminLink = (mode) => !isMode(mode) || mode === 'demo' || mode === 'manager';
