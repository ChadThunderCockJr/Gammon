export interface PlaidLinkHandler {
  open(): void;
  destroy(): void;
}

export interface PlaidLinkFactory {
  create(config: {
    token: string;
    onSuccess: (publicToken: string) => void;
    onExit: (error: unknown) => void;
  }): PlaidLinkHandler;
}

declare global {
  interface Window {
    Plaid?: PlaidLinkFactory;
  }
}

let loadingPlaid: Promise<PlaidLinkFactory> | null = null;

export function loadPlaidLink(): Promise<PlaidLinkFactory> {
  if (window.Plaid) return Promise.resolve(window.Plaid);
  if (loadingPlaid) return loadingPlaid;

  const { promise, resolve, reject } = Promise.withResolvers<PlaidLinkFactory>();
  const script = document.createElement("script");
  script.src = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
  script.async = true;
  script.onload = () => window.Plaid ? resolve(window.Plaid) : reject(new Error("Plaid did not initialize"));
  script.onerror = () => reject(new Error("Plaid could not load"));
  document.head.appendChild(script);
  loadingPlaid = promise;
  return loadingPlaid;
}
