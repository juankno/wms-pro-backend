import { MailMessage } from '../mail/mailer';

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);

export function invitationEmail(params: {
  to: string;
  tenantName: string;
  inviterName: string;
  acceptUrl: string;
  expiresAt: Date;
}): MailMessage {
  const expires = params.expiresAt.toISOString().slice(0, 10);
  const intro = `${params.inviterName} te invitó a unirte a ${params.tenantName} en WMS Pro.`;
  return {
    to: params.to,
    subject: `Invitación a ${params.tenantName} en WMS Pro`,
    text: `${intro}\n\nCrea tu usuario en: ${params.acceptUrl}\n\nEl enlace vence el ${expires}.`,
    html: [
      `<p>${escapeHtml(intro)}</p>`,
      `<p><a href="${escapeHtml(params.acceptUrl)}">Crear mi usuario</a></p>`,
      `<p>El enlace vence el ${expires}. Si no esperabas esta invitación, ignora este correo.</p>`,
    ].join('\n'),
  };
}
