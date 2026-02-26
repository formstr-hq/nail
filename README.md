# Nostr Mail Bridge

This repository aims to bridge traditional mail with nostr identities. A user should be able to typically converse with people/entities
using nostr identities and traditional mail at the same time. 

1. The mail server will receive all incoming mails and forward them to the nostr identity of the user. So the user should be able to use their nostr identity for services that rely on traditional auth.
2. Users can also send mails/DMs using their nostr identities to traditional mail.

Right now, the code contains a POC of point 1. Populate the `.env` using `.env.example` as a reference. Run the following commands to start the project
1. `pnpm install`
2. `pnpm dev`
