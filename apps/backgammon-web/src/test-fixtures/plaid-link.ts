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

const sandboxPlaid: PlaidLinkFactory = {
  create({ onSuccess }) {
    let destroyed = false;
    return {
      open() {
        queueMicrotask(() => {
          if (!destroyed) onSuccess("sandbox-plaid-public-token");
        });
      },
      destroy() {
        destroyed = true;
      },
    };
  },
};

export function loadPlaidLink(): Promise<PlaidLinkFactory> {
  return Promise.resolve(sandboxPlaid);
}

