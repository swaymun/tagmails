// The email a newly paired computer sends its owner. It doubles as the help
// sheet: what to try, the settings an email can change, and the local commands.
import { renderResult } from '../apps/mock-inbox/mail.mjs';
import { emailPriceMillicents } from './email-charges.mjs';

export function welcomeEmail({ env, ownerEmail, deviceName: rawName, siteOrigin }) {
  // The paired computer chose this name; it must not become Markdown (a link) in TagMails' own email.
  const deviceName = String(rawName).replace(/[\\`*_[\]()<>#!|~]/g, '').trim() || 'Your computer';
  const cents = emailPriceMillicents(env) / 1000;
  const price = `$${(cents / 100).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
  // $10 is 1,000 cents.
  const replies = Math.floor(1000 / cents);
  const answer = [
    'Hi there,',
    '',
    `Thanks for choosing TagMails! **${deviceName}** is connected. From now on, email this address from ${ownerEmail} and your agent on that computer will do the work and reply right here, in the same thread.`,
    '',
    siteOrigin
      ? `**First, add a balance.** Emails wait until your balance covers them. Each email you send to TagMails costs ${price}, so $10 covers about ${replies.toLocaleString('en-US')} emails. [Top up your balance](${siteOrigin}/#billing)`
      : `**First, add a balance.** Emails wait until your balance covers them. Each email you send to TagMails costs ${price}.`,
    '',
    '**Try it now:** reply to this email with something you\'d like done, for example "What changed in my projects this week?"',
    '',
    '**Things you can ask for**',
    '- Work in a project by naming it: "In tagmails, why does the footer wrap?"',
    '- Pick a model or effort in plain words: "Use Opus with high effort."',
    '- Steer a run while it works by replying: "Also update the tests."',
    '- Ask for a file. Small ones (up to 3.5 MB in total) come attached.',
    '',
    '**Change settings by email**',
    '- "Make Sol my default" sets your default model.',
    '- "From now on, put big files in my Google Drive" saves a standing instruction. Replies mention it whenever your instructions change.',
    '- "Turn on reactions" adds 👀 and ✅ to your emails. They\'re off by default.',
    '',
    '**On your computer**',
    '- `tagmails doctor` checks your setup and suggests fixes.',
    '- `tagmails status` and `tagmails logs` show what\'s running.',
    '- Permissions and folders change only with `tagmails start`.',
    '',
    'Happy emailing,',
    'TagMails',
  ].join('\n');
  const { html, text } = renderResult({ state: 'completed', answer, brandUrl: siteOrigin });
  return { subject: `Welcome to TagMails: ${deviceName} is ready`, html, text };
}

// Best effort: pairing never fails because this email couldn't be sent.
export async function sendWelcomeEmail(env, accountId, deviceName, send) {
  try {
    const account = await env.DB.prepare('SELECT owner_email, agent_email FROM accounts WHERE id = ? AND active = 1')
      .bind(accountId).first();
    if (!account?.agent_email || !send) return false;
    const siteOrigin = env.SITE_ORIGIN?.split(',')[0]?.trim() || null;
    const mail = welcomeEmail({ env, ownerEmail: account.owner_email, deviceName, siteOrigin });
    await send({ from: account.agent_email, to: [account.owner_email], ...mail,
      tags: [{ name: 'tagmails_welcome', value: 'paired' }] });
    return true;
  } catch (error) {
    console.error('Welcome email is delayed', error?.message);
    return false;
  }
}
