# Privacy Policy

**Last updated: July 5, 2026**

## Summary

Mailstr is a bridge between email and the Nostr protocol. We store the minimum required to run your mailbox: your pseudonymous Nostr public key, the address you claimed, and a payment record. Mail passing through the bridge is encrypted to your key and handed to Nostr relays — the bridge does not keep a plaintext archive of your messages, does not scan them for advertising or profiling, and runs no analytics or trackers on this site.

---

## How Mailstr Works

Your identity on Mailstr is a pair of cryptographic keys that you own. Mailstr never sees or stores your private key — signing in means signing a challenge on your device.

When someone sends an email to your `@mailstr.app` address, it arrives at our bridge over SMTP, the same way email arrives anywhere. The bridge encrypts the message to your public key and publishes it to Nostr relays. From that point on, only your key can decrypt it. When you reply, the bridge delivers a standard email to the recipient.

---

## Data We Store

To operate your mailbox, we keep:

- **Your Nostr public key** — a pseudonymous cryptographic identifier. It is not linked to your name, phone number, or any other identity.
- **Your claimed address** (e.g. `you@mailstr.app`) and its NIP-05 record, which is public by design — that is what makes it a verifiable name on Nostr.
- **A payment record** tied to your public key, used to verify your claim and its expiration.
- **Mailbox infrastructure records** required by the mail server to route your messages.

We do **not** store your private key, your passphrase, or a plaintext archive of your mail.

---

## Mail in Transit — an Honest Note

Email between the sender and our bridge travels as ordinary email. Like every mail provider on the internet, the bridge can technically read a message at the moment it arrives — that is how SMTP works, for everyone. Unlike most providers, the bridge's job ends there: it encrypts the message to your key, hands it to relays, and retains no readable copy. The bridge is open source, so this behavior is checkable, not just claimed.

---

## Data We Do Not Collect

- We do not collect personal information (name, phone number, physical address)
- We do not scan or mine your mail for advertising, profiling, or AI training
- We do not collect usage analytics, crash reports, or device identifiers
- We do not use cookies, pixels, or any tracking technology on this site
- We do not sell or share data with third parties

---

## Payments

Signup is paid via a Bitcoin Lightning invoice settled as a Nostr zap. Zap receipts are public events on Nostr relays and contain your public key and the amount — this is inherent to how zaps work and serves as pseudonymous, verifiable proof of your claim. We do not receive or store card numbers, bank details, or billing addresses; we never learn your legal identity through payment.

---

## Data Stored on Your Device

To keep you signed in and remember your preferences, the Mailstr apps save a small amount of information locally on your device — your public key, encrypted key material if you created a key with us (NIP-49), and app settings. You can remove this at any time by clearing the site's data.

---

## Third-Party Services

Your encrypted messages are published to Nostr relays — independent, community-run servers governed by their own policies. They store ciphertext they cannot read. Lightning payments are processed over the Lightning Network; the nodes involved are operated by third parties.

---

## Data Retention & Deletion

Mailbox and NIP-05 records are kept while your claim is active. You can request deletion of your mailbox, NIP-05 record, and payment records at any time — see Contact Us below. Note that events already published to third-party Nostr relays (including zap receipts) are outside our control and may persist there.

---

## Children's Privacy

Mailstr is not directed at children under 13. We do not knowingly collect any information from children, and since accounts carry no legal identity, we have no means to identify one.

---

## Changes to This Policy

We may update this policy as the product evolves. The "Last updated" date at the top reflects the most recent revision. Continued use of Mailstr after an update means you accept the revised policy.

---

## Contact Us

Questions or concerns? Reach us at:

- **Email:** [hello@formstr.app](mailto:hello@formstr.app)
- **Nostr:** [formstr@formstr.app](https://njump.me/npub1qu7dsd44275lms4x9snnwvnnmgx926nsppmr7lcw9dlj36n4fltqgs7p98) (npub1qu7dsd44275lms4x9snnwvnnmgx926nsppmr7lcw9dlj36n4fltqgs7p98)
