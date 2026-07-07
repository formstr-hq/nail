import nodemailer from "nodemailer";

export function createPostfixTransport(host: string, port: number) {
  return nodemailer.createTransport({
    host,
    port,
    secure: false,
    tls: { rejectUnauthorized: false },
  });
}

export async function injectIntoPostfix(
  transport: ReturnType<typeof createPostfixTransport>,
  mailOptions: Parameters<typeof transport.sendMail>[0],
): Promise<void> {
  await transport.sendMail(mailOptions);
}
