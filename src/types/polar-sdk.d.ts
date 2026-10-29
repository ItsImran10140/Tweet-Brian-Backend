/** Ambient types for Polar SDK subpath imports (moduleResolution: node). */
declare module '@polar-sh/sdk/2026-10' {
  export function createPolar(options: {
    accessToken: string;
    environment?: 'sandbox' | 'production';
  }): {
    checkouts: {
      create: (body: Record<string, unknown>) => Promise<{ id: string; url?: string | null }>;
      get: (id: string) => Promise<{
        id: string;
        status: string;
        external_customer_id?: string | null;
        customer_email?: string | null;
        product_id?: string | null;
        product?: { id?: string | null } | null;
        metadata?: Record<string, unknown> | null;
        total_amount?: number | null;
        currency?: string | null;
        subscription_id?: string | null;
        url?: string | null;
      }>;
    };
    customerSessions: {
      create: (body: Record<string, unknown>) => Promise<{ customer_portal_url?: string | null }>;
    };
    products: {
      list: (query?: {
        page?: number;
        limit?: number;
        id?: string | string[];
        organization_id?: string | string[];
      }) => Promise<{
        items: Array<{ id: string; name?: string | null }>;
        pagination: { max_page: number };
      }>;
    };
  };

  export namespace webhooks {
    export class PolarWebhookVerificationError extends Error {}
    export class PolarWebhookUnknownTypeError extends Error {}
    export function validateEvent(
      body: Buffer | string | unknown,
      headers: Record<string, string>,
      secret: string,
    ): Promise<{ type: string; data: unknown }>;
  }
}
