import Stripe from "stripe";
import type pg from "pg";

export type Plan = "starter" | "team" | "business";
export const PLANS: Record<Plan, { name: string; price: number; lookup: string }> = {
  starter: { name: "Starter", price: 39, lookup: "rework_ledger_starter" },
  team: { name: "Team", price: 149, lookup: "rework_ledger_team" },
  business: { name: "Business", price: 499, lookup: "rework_ledger_business" },
};
export const TRIAL_DAYS = 14;

const RANK: Record<Plan, number> = { starter: 1, team: 2, business: 3 };
export type Feature = "distill" | "agents_pr" | "checks" | "eval_export";
const MIN_PLAN: Record<Feature, Plan> = { distill: "team", agents_pr: "team", checks: "team", eval_export: "team" };
const ACTIVE = new Set(["trialing", "active", "past_due"]);

export function hasFeature(plan: string | null, status: string | null, feature: Feature): boolean {
  return !!plan && !!status && ACTIVE.has(status) && RANK[plan as Plan] >= RANK[MIN_PLAN[feature]];
}
export const isActive = (status: string | null) => !!status && ACTIVE.has(status);

export async function entitled(db: pg.Pool, installationId: number, feature: Feature): Promise<boolean> {
  const r = (await db.query("SELECT plan, subscription_status FROM installations WHERE id=$1", [installationId])).rows[0];
  return !!r && hasFeature(r.plan, r.subscription_status, feature);
}

export interface Billing {
  createCheckout(p: { installationId: number; plan: Plan; customerId: string | null; successUrl: string; cancelUrl: string }): Promise<string>;
  createPortal(p: { customerId: string; returnUrl: string }): Promise<string>;
}

export function stripeBilling(key: string): Billing {
  const stripe = new Stripe(key);
  return {
    async createCheckout(p) {
      const prices = await stripe.prices.list({ lookup_keys: [PLANS[p.plan].lookup], active: true });
      if (!prices.data.length) throw new Error(`No Stripe price for ${p.plan}. Run npm run stripe:setup.`);
      const meta = { installation_id: String(p.installationId), plan: p.plan };
      const session = await stripe.checkout.sessions.create({
        mode: "subscription", line_items: [{ price: prices.data[0].id, quantity: 1 }],
        subscription_data: { trial_period_days: TRIAL_DAYS, metadata: meta }, metadata: meta,
        client_reference_id: String(p.installationId), ...(p.customerId ? { customer: p.customerId } : {}),
        success_url: p.successUrl, cancel_url: p.cancelUrl,
      });
      return session.url!;
    },
    async createPortal(p) {
      return (await stripe.billingPortal.sessions.create({ customer: p.customerId, return_url: p.returnUrl })).url;
    },
  };
}

export function verifyStripeEvent(raw: string, signature: string | undefined, secret: string): Stripe.Event {
  if (!signature) throw new Error("missing signature");
  return Stripe.webhooks.constructEvent(raw, signature, secret);
}

const planFromLookup = (key: string | null | undefined): Plan | null =>
  (Object.entries(PLANS).find(([, v]) => v.lookup === key)?.[0] as Plan | undefined) ?? null;

/** Applies Stripe state to the installation. Older events never overwrite newer ones. */
export async function handleStripeEvent(db: pg.Pool, event: Stripe.Event): Promise<string> {
  const at = new Date(event.created * 1000);
  const obj: any = event.data.object;
  if (event.type === "checkout.session.completed") {
    const id = Number(obj.client_reference_id ?? obj.metadata?.installation_id);
    if (!id) return "ignored";
    await db.query(
      `UPDATE installations SET stripe_customer_id=$2, stripe_subscription_id=$3,
         plan = coalesce(plan, $4), subscription_status = coalesce(subscription_status, 'trialing')
       WHERE id=$1`, [id, obj.customer, obj.subscription, obj.metadata?.plan ?? null]);
    return "checkout recorded";
  }
  if (event.type.startsWith("customer.subscription.")) {
    const plan = planFromLookup(obj.items?.data?.[0]?.price?.lookup_key) ?? obj.metadata?.plan ?? null;
    const status = event.type === "customer.subscription.deleted" ? "canceled" : obj.status;
    const res = await db.query(
      `UPDATE installations SET plan=coalesce($3, plan), subscription_status=$4, trial_ends_at=$5,
         stripe_subscription_id=$2, stripe_customer_id=coalesce(stripe_customer_id, $6), stripe_event_at=$7
       WHERE (id=$1 OR stripe_subscription_id=$2) AND (stripe_event_at IS NULL OR stripe_event_at <= $7)`,
      [Number(obj.metadata?.installation_id) || null, obj.id, plan, status,
       obj.trial_end ? new Date(obj.trial_end * 1000) : null, obj.customer, at]);
    return res.rowCount ? `subscription ${status}` : "ignored";
  }
  return "ignored";
}
