const dev = import.meta.env.DEV

export const config = {
  apiBaseUrl:
    import.meta.env.VITE_API_BASE_URL ??
    (dev ? 'http://localhost:5000' : 'https://api.formstr.app'),
}

export const apiUrl = (path: string) => `${config.apiBaseUrl}${path}`
