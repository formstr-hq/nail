export interface NostrAccount {
  pubkey: string           // hex
  npub: string
  method: 'nip07' | 'nsec'
}

export interface RelayConfig {
  url: string
  read: boolean
  write: boolean
}
