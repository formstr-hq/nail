/**
 * Build the sandboxed `srcDoc` an HTML message renders inside.
 *
 * Remote content in HTML mail is how senders find out a message was opened.
 * The default policy allows only images already embedded in the message, so
 * opening mail never reports back; `img-src` widens to the network only when
 * the reader asks for it. This is a `<meta>` policy inside the frame rather
 * than a sandbox flag because sandboxing cannot express "no network, but do
 * render the markup".
 */
export function buildEmailFrame(html: string, allowRemote: boolean, dark: boolean): string {
  const imgSrc = allowRemote ? "img-src data: https: http:" : "img-src data:"
  const policy = `default-src 'none'; ${imgSrc}; style-src 'unsafe-inline'; font-src data:`
  // Follow the app's theme. Background stays transparent so it inherits the
  // reading pane. Most HTML mail is authored for a white page, so its own
  // colours (dark ink, dark links) are baked in with inline styles — on our
  // dark surface those render dark-on-dark and vanish. We can't recolour every
  // element without wrecking mail that *does* set a background, so `dark` mode
  // renders the message on its intended light surface instead: a white sheet
  // with dark defaults, matching what the author saw. Light mode already is
  // that surface, so it just inherits the pane.
  // In dark mode the sheet is white — the surface the mail was authored for —
  // so its baked-in colours land where they belong. Light mode already is that
  // surface, so the frame stays transparent and inherits the reading pane. The
  // defaults below only apply where the message sets nothing of its own.
  const fg = dark ? '#111111' : '#0b0b0c'
  const surface = dark ? '#ffffff' : 'transparent'
  const padding = dark ? '14px 16px' : '0'
  const radius = dark ? 'border-radius:8px;' : ''
  // A standard hyperlink blue reads on the sheet and is unambiguous as a link;
  // the underline carries the affordance regardless. `color-scheme:light` keeps
  // native controls and the (white) canvas light even under the app's dark
  // theme, matching the sheet.
  // `<base target="_blank">` sends every link to a new tab instead of replacing
  // the frame's own document; the sandbox flags on the iframe are what let that
  // popup actually open and land as a normal (un-sandboxed) page.
  const link = '#1a56db'
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"><base target="_blank"><style>
    html{color-scheme:light}
    body{margin:0;padding:${padding};font:13.5px/1.65 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:${fg};background:${surface};word-break:break-word;${radius}}
    img{max-width:100%;height:auto}
    a{color:${link}}
  </style></head><body>${html}</body></html>`
}

/** True when the markup asks for anything the CSP would currently block. */
export function hasRemoteContent(html: string): boolean {
  return /<img[^>]+src=["']?https?:/i.test(html)
}
