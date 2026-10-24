// E-mail com a resposta da administração para quem escreveu no Fale conosco.
// Mesmo visual dos e-mails de cadastro/senha (supabase/emails/), responsivo.
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
const paragraphs = (s) => esc(s).replace(/\r?\n/g, "<br>");

export function contactReplyEmail({ name, protocol, reason, message, reply }) {
  const firstName = String(name).trim().split(/\s+/)[0];
  const subject = `Resposta à sua mensagem (${protocol}) · SunFood`;
  const text =
    `Olá, ${firstName}!\n\n${reply}\n\n` +
    `Equipe SunFood\n\n---\nSua mensagem (${protocol} · ${reason}):\n${message}\n\n` +
    `Precisa de mais alguma coisa? Escreva de novo pelo Fale conosco em https://sunfood.app.br`;
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(subject)}</title>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;700;800&display=swap" rel="stylesheet">
<style>
  body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
  table,td{mso-table-lspace:0;mso-table-rspace:0}
  img{border:0;outline:none;text-decoration:none}
  a{color:#1F5A63}
  @media only screen and (max-width:560px){
    .sf-outer{padding:16px 16px 24px !important}
    .sf-pad{padding-left:16px !important;padding-right:16px !important}
    .sf-h1{font-size:24px !important;line-height:30px !important}
  }
</style>
</head>
<body style="margin:0;padding:0;width:100%;background:#F7F5F0;color:#14232A;font-family:'Manrope',Arial,Helvetica,sans-serif">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#F7F5F0">${esc(reply.slice(0, 120))}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F7F5F0">
    <tr><td align="center" class="sf-outer" style="padding:32px 16px 40px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px">
        <tr><td style="padding:0 4px 16px">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
            <td valign="middle" style="padding-right:10px"><img src="https://sunfood.app.br/icons/icon-192.png" width="36" height="36" alt="" style="display:block;width:36px;height:36px;border-radius:10px"></td>
            <td valign="middle" style="font-family:'Manrope',Arial,Helvetica,sans-serif;font-size:20px;line-height:24px;font-weight:800;color:#1F5A63;letter-spacing:-0.3px">SunFood</td>
          </tr></table>
        </td></tr>
        <tr><td style="background:#FFFFFF;border:1px solid #E5E0D5;border-radius:16px;overflow:hidden">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td width="34%" height="6" bgcolor="#F07B4F" style="background:#F07B4F;height:6px;font-size:0;line-height:0;border-top-left-radius:15px">&nbsp;</td>
              <td width="33%" height="6" bgcolor="#1F5A63" style="background:#1F5A63;height:6px;font-size:0;line-height:0">&nbsp;</td>
              <td width="33%" height="6" bgcolor="#F5B83D" style="background:#F5B83D;height:6px;font-size:0;line-height:0;border-top-right-radius:15px">&nbsp;</td>
            </tr>
          </table>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td class="sf-pad" style="padding:28px 32px 4px">
              <p style="margin:0 0 8px;font-size:13px;line-height:18px;font-weight:700;color:#1F5A63;text-transform:uppercase;letter-spacing:0.8px">Resposta ao seu Fale conosco</p>
              <h1 class="sf-h1" style="margin:0 0 12px;font-family:'Manrope',Arial,Helvetica,sans-serif;font-size:28px;line-height:34px;font-weight:800;color:#14232A;letter-spacing:-0.6px">Olá, ${esc(firstName)}!</h1>
              <p style="margin:0 0 16px;font-size:16px;line-height:24px;color:#14232A">${paragraphs(reply)}</p>
              <p style="margin:0;font-size:16px;line-height:24px;color:#55626A">Equipe SunFood</p>
            </td></tr>
            <tr><td class="sf-pad" style="padding:24px 32px 28px">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F1EEE7;border-radius:12px">
                <tr><td style="padding:16px;font-size:14px;line-height:20px;color:#55626A">
                  <div style="font-size:13px;line-height:18px;font-weight:700;color:#14232A;margin-bottom:4px">Sua mensagem · ${esc(protocol)} · ${esc(reason)}</div>
                  <div style="word-break:break-word">${paragraphs(message)}</div>
                </td></tr>
              </table>
            </td></tr>
          </table>
        </td></tr>
        <tr><td align="center" class="sf-pad" style="padding:20px 24px 0;font-size:12px;line-height:18px;color:#55626A">
          Você recebeu este e-mail porque escreveu para o SunFood pelo Fale conosco.<br>Precisa de mais alguma coisa? Escreva de novo pelo site.<br>
          <a href="https://sunfood.app.br" style="color:#1F5A63;text-decoration:none;font-weight:700">sunfood.app.br</a>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  return { subject, html, text };
}
