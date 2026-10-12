// The email a newly paired computer sends its owner. It doubles as the help
// sheet: what to try, the settings an email can change, and the local commands.
import { renderResult } from '../apps/mock-inbox/mail.mjs';
import { emailPriceMillicents } from './email-charges.mjs';

export function welcomeEmail({ env, ownerEmail, deviceName, siteOrigin }) {
  const cents = emailPriceMillicents(env) / 1000;
  const price = `$${(cents / 100).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
  const answer = [
    `**${deviceName} is set up.** Email this address from ${ownerEmail} and your agent on that computer does the work; the answer comes back in the same thread. Reply to this email to try it.`,
    '',
    '**Things to try**',
    '- Ask about a project by name: "In tagmails, why does the footer wrap?" TagMails picks the folder.',
    '- Choose a model or effort in plain words: "use Opus, high effort".',
    '- Reply while it works to steer it: "also update the tests".',
    '- Ask for a file: small ones (up to 3.5 MB in total) come attached.',
    '',
    '**Settings you can change by email**',
    '- "Make Sol my default" changes your default model.',
    '- "From now on, put big files in my Google Drive" saves standing instructions. Replies say whenever they change.',
    '- "Turn on reactions" adds 👀 and ✅ to your emails (off by default).',
    '',
    `**On the computer:** \`tagmails status\`, \`tagmails doctor\` (checks the setup and prints fixes), \`tagmails logs\`. Permissions and folders change only with \`tagmails start\` there.`,
    '',
    `Each reply costs ${price}${siteOrigin ? `; your balance is at ${siteOrigin}` : ''}. This email is free.`,
  ].join('\n');
  const { html, text } = renderResult({ state: 'completed', answer, brandUrl: siteOrigin });
  return { subject: `TagMails is set up on ${deviceName}`, html, text };
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
